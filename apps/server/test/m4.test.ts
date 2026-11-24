import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  signalResponseSchema,
  signalsResponseSchema,
  signalSummaryResponseSchema,
  type RiskLevels,
} from '@market-sentinel/contracts/strategies';
import type { Candle } from '@market-sentinel/domain';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { initializeAdministrator } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import {
  migrateDatabase,
  openDatabase,
  type AppDatabase,
} from '../src/database.js';
import { createMarketData } from '../src/market-data/service.js';
import { storeCandles } from '../src/market-data/store.js';
import { createNotifications } from '../src/notification/service.js';
import {
  auditLogs,
  markets,
  monitorConfigs,
  outboxMessages,
  riskEvaluations,
  signalCandidates,
  signalOutcomes,
  signals,
  telegramSettings,
} from '../src/schema.js';
import {
  deleteSignalHistory,
  exportSignalHistory,
  signalDetail,
  summarizeSignals,
  saveCandidates,
  strategyTemplate,
} from '../src/strategy/store.js';
import {
  createSignalTracker,
  initializeOutcome,
} from '../src/strategy/tracker.js';

const minute = 60_000;
const base = Date.UTC(2026, 10, 24, 12);
const periods = { trigger: '1m', confirm: '3m', trend: '5m' } as const;
const token = '123456:fixture_token';
let db: AppDatabase;
let clock: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = base + 5_000;
});
afterEach(() => db.$client.close());

function config() {
  return readConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    TELEGRAM_BOT_TOKEN: token,
    APP_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
    SESSION_SECRET: randomBytes(32).toString('base64'),
  });
}

function fixture({
  direction = 'LONG',
  symbol = 'FIXUSDT',
  legacy = false,
  targets,
}: {
  direction?: 'LONG' | 'SHORT';
  symbol?: string;
  legacy?: boolean;
  targets?: RiskLevels['takeProfits'];
} = {}) {
  const marketId = randomUUID();
  const monitorId = randomUUID();
  const signalId = randomUUID();
  const pairingId = randomUUID();
  const chatId = '1234';
  const strategy = strategyTemplate('SPOT');
  const market = {
    exchange: 'BITGET',
    marketType: 'SPOT',
    tickSize: '0.01',
    pricePrecision: 2,
  } as const;
  db.insert(markets)
    .values({
      ...market,
      id: marketId,
      productType: 'SPOT',
      venue: 'main',
      nativeSymbol: symbol,
      baseAsset: 'FIX',
      quoteAsset: 'USDT',
      status: 'ACTIVE',
      exchangeStatus: 'online',
      stale: false,
      isReality: false,
      updatedAtMs: clock,
      capabilities: {
        intervals: Object.values(periods),
        hasOpenInterest: false,
        hasOrderBook: true,
        hasFundingRate: false,
        supportsReadOnlyPositions: false,
        hasReliableBaseVolume: true,
        sessionType: 'CONTINUOUS',
        restrictions: [],
      },
    })
    .run();
  db.insert(monitorConfigs)
    .values({ id: monitorId, marketId, ...periods, extra: [], enabled: true })
    .run();
  const candle = (
    openTimeMs: number,
    values: Partial<Candle> = {},
  ): Candle => ({
    marketId,
    timeframe: '1m',
    openTimeMs,
    closeTimeMs: openTimeMs + minute,
    open: '100',
    high: '101',
    low: '99',
    close: '100',
    baseVolume: null,
    quoteTurnover: null,
    isClosed: true,
    source: 'REST',
    qualityFlags: ['MISSING_BASE_VOLUME'],
    ...values,
  });
  const levels: RiskLevels = {
    entry: '100',
    stop: direction === 'LONG' ? '98' : '102',
    takeProfits:
      targets ??
      (direction === 'LONG'
        ? [
            { price: '103', closePct: 50 },
            { price: '106', closePct: 50 },
          ]
        : [
            { price: '97', closePct: 50 },
            { price: '94', closePct: 50 },
          ]),
    weightedRR: '2.25',
  };
  const trigger = candle(base - minute);
  const evidence = {
    market,
    indicators: { atr: 1 },
    candles: { trigger: { last: trigger } },
  };
  saveCandidates(
    db,
    trigger,
    periods,
    strategy,
    [{ direction, risk: { outcome: 'PASSED', reasonCode: null, levels } }],
    evidence,
    clock,
  );
  const candidate = db
    .select()
    .from(signalCandidates)
    .where(eq(signalCandidates.marketId, marketId))
    .get()!;
  db.update(signalCandidates)
    .set({ deliveryPending: false })
    .where(eq(signalCandidates.id, candidate.id))
    .run();
  db.insert(riskEvaluations)
    .values({
      candidateId: candidate.id,
      stage: 'FINAL',
      outcome: 'PASSED',
      levels,
      atMs: clock,
    })
    .run();
  db.insert(signals)
    .values({
      id: signalId,
      candidateId: candidate.id,
      levels,
      approvedAtMs: clock,
      expiresAtMs: clock + minute,
    })
    .run();
  if (!legacy) initializeOutcome(db, signalId, '1m', clock, levels, evidence);
  return {
    candle,
    signalId,
    candidateId: candidate.id,
    marketId,
    monitorId,
    pairingId,
    chatId,
    start: base + minute,
    originalSent() {
      db.insert(telegramSettings)
        .values({
          id: 1,
          pairingId,
          chatId,
          botFingerprint: createHash('sha256').update(token).digest('hex'),
          marketDailyLimit: 1,
          globalDailyLimit: 1,
        })
        .run();
      db.insert(outboxMessages)
        .values({
          id: randomUUID(),
          dedupeKey: 'signal:' + signalId,
          signalId,
          pairingId,
          chatId,
          body: '原交易提醒',
          createdAtMs: clock,
          nextAttemptMs: clock,
          expiresAtMs: clock + minute,
          sentAtMs: clock,
          telegramMessageId: '100',
          sendDay: '2026-11-24',
          status: 'SENT',
        })
        .run();
    },
  };
}

function tracker(enqueue = vi.fn()) {
  return createSignalTracker(
    db,
    () => clock,
    enqueue,
    () => {
      throw new Error('tracking failed');
    },
  );
}

test('tracks partial targets after approval, applies breakeven on the next bar and preserves the audit', () => {
  migrateDatabase(db);
  const f = fixture({
    targets: [
      { price: '103', closePct: 50 },
      { price: '106', closePct: 50, trailPolicy: 'BREAKEVEN_AFTER_TP1' },
    ],
  });
  const track = tracker();
  storeCandles(db, [
    f.candle(base, { high: '108', low: '96' }),
    f.candle(f.start, { high: '104', low: '99', close: '103' }),
  ]);
  track.tick();
  expect(signalDetail(db, f.candidateId)?.theory?.observedBars).toBe(0);
  clock = f.start + minute + 5_000;
  track.tick();
  expect(signalDetail(db, f.candidateId)?.theory).toMatchObject({
    state: 'TP1_HIT',
    observedBars: 1,
    finishedAtMs: null,
  });
  storeCandles(db, [f.candle(f.start + minute, { high: '107', low: '99' })]);
  clock += minute;
  tracker().tick();
  track.tick();
  const detail = signalDetail(db, f.candidateId)!;
  expect(detail.theory).toMatchObject({
    state: 'SL_HIT',
    observedBars: 2,
    grossR: '0.75',
  });
  expect(detail.theoryEvents.map(({ type }) => type)).toEqual([
    'CANDLE',
    'TP',
    'STOP_MOVED',
    'CANDLE',
    'SL',
  ]);
  expect(detail.theoryEvents.at(-1)).toMatchObject({
    target: 2,
    price: '100',
    closePct: 50,
    ambiguousIntrabar: true,
  });
});

test('short stops take precedence over touching targets and use the adverse open', () => {
  migrateDatabase(db);
  const f = fixture({ direction: 'SHORT' });
  storeCandles(db, [
    f.candle(f.start, { open: '104', high: '105', low: '93' }),
  ]);
  clock = f.start + minute + 5_000;
  tracker().tick();
  const detail = signalDetail(db, f.candidateId)!;
  expect(detail.theory).toMatchObject({ state: 'SL_HIT', grossR: '-2' });
  expect(detail.theoryEvents.slice(1)).toMatchObject([
    { type: 'SL', price: '104', ambiguousIntrabar: true },
    { type: 'SL', price: '104', ambiguousIntrabar: true },
  ]);
});

test('holds later bars behind a gap, then expires exactly at the twentieth recovered close', () => {
  migrateDatabase(db);
  const f = fixture();
  const bars = Array.from({ length: 20 }, (_, index) =>
    f.candle(f.start + index * minute, { close: '101' }),
  );
  storeCandles(
    db,
    bars.filter((_, index) => index !== 1),
  );
  clock = f.start + 21 * minute;
  tracker().tick();
  expect(signalDetail(db, f.candidateId)?.theory).toMatchObject({
    state: 'ACTIVE',
    observedBars: 1,
    waitingForData: true,
  });
  storeCandles(db, [bars[1]!, ...bars]);
  const resumed = tracker();
  resumed.tick();
  resumed.tick();
  const detail = signalDetail(db, f.candidateId)!;
  expect(detail.theory).toMatchObject({
    state: 'EXPIRED',
    observedBars: 20,
    waitingForData: false,
    finishedAtMs: f.start + 20 * minute,
    grossR: '0.5',
  });
  expect(detail.theoryEvents).toHaveLength(21);
});

test('invalidates an unresolved gap after the recovery grace and keeps cost-free R unknown', () => {
  migrateDatabase(db);
  const f = fixture();
  const track = tracker();
  clock = f.start + 20 * minute + 24 * 60 * minute;
  track.tick();
  expect(signalDetail(db, f.candidateId)?.theory).toMatchObject({
    state: 'INVALIDATED',
    waitingForData: false,
    reasonCode: 'DATA_GAP',
    grossR: null,
  });
});

test('ATR stops use closed evidence and four ordered targets remain independently auditable', () => {
  migrateDatabase(db);
  const f = fixture({
    targets: [
      { price: '103', closePct: 25 },
      { price: '106', closePct: 25, trailPolicy: 'ATR_TRAIL_AFTER_TP1' },
      { price: '109', closePct: 25 },
      { price: '112', closePct: 25 },
    ],
  });
  const track = tracker();
  storeCandles(db, [
    f.candle(f.start, { high: '104', low: '100', close: '103' }),
    f.candle(f.start + minute, {
      open: '104',
      high: '113',
      low: '103',
      close: '110',
    }),
  ]);
  clock = f.start + 2 * minute + 5_000;
  track.tick();
  const detail = signalDetail(db, f.candidateId)!;
  expect(detail.theory?.state).toBe('TP4_HIT');
  expect(
    detail.theoryEvents
      .filter(({ type }) => type === 'TP')
      .map(({ target }) => target),
  ).toEqual([1, 2, 3, 4]);
  expect(
    detail.theoryEvents.find(({ type }) => type === 'STOP_MOVED'),
  ).toMatchObject({ target: 2, price: '101.18', atMs: f.start + minute });
});

test('coalesces live updates, uses an independent allowance and honors pairing changes', async () => {
  migrateDatabase(db);
  const f = fixture();
  f.originalSent();
  const settings = config();
  const transport = vi.fn(async () =>
    Response.json({ ok: true, result: { message_id: 101 } }),
  );
  const queue = createNotifications(
    db,
    settings,
    createMarketData(db, { now: () => clock }),
    () => undefined,
    { fetchTelegram: transport },
  );
  const track = createSignalTracker(
    db,
    () => clock,
    queue.enqueueUpdate,
    () => undefined,
  );
  storeCandles(db, [f.candle(f.start, { high: '107' })]);
  clock = f.start + minute + 5_000;
  track.tick();
  track.tick();
  const candidate = signalDetail(db, f.candidateId)!;
  expect(candidate.deliveries).toHaveLength(1);
  expect(candidate.updates).toHaveLength(1);
  expect(candidate.updates[0]?.body).toContain('触及 TP2');
  await queue.tickOutbox();
  expect(signalDetail(db, f.candidateId)?.updates[0]?.status).toBe('SENT');
  db.update(telegramSettings).set({ pairingId: randomUUID() }).run();
  db.transaction((tx) =>
    queue.enqueueUpdate(tx, {
      signalId: f.signalId,
      symbol: 'FIXUSDT',
      exchange: 'BITGET',
      atMs: clock,
      lines: ['update'],
    }),
  );
  expect(transport).toHaveBeenCalledTimes(1);
  expect(signalDetail(db, f.candidateId)?.updates).toHaveLength(1);
});

test('upgrades the M3 schema, classifies legacy test messages and silently replays stored bars', () => {
  const path = fileURLToPath(new URL('../drizzle/', import.meta.url));
  const temp = mkdtempSync(join(tmpdir(), 'market-sentinel-m4-'));
  const entries = readdirSync(path).filter((name) => /_m[0123]_/.test(name));
  try {
    for (const entry of entries) {
      mkdirSync(join(temp, entry));
      copyFileSync(
        join(path, entry, 'migration.sql'),
        join(temp, entry, 'migration.sql'),
      );
    }
    migrate(db, { migrationsFolder: temp });
    const f = fixture({ legacy: true });
    db.$client
      .prepare(
        "insert into outbox_messages (id, dedupe_key, pairing_id, chat_id, body, status, created_at_ms, next_attempt_ms, expires_at_ms) values (?, 'test:legacy', ?, '1234', 'test', 'SENT', ?, ?, ?)",
      )
      .run(randomUUID(), f.pairingId, clock, clock, clock + minute);
    storeCandles(db, [f.candle(f.start, { high: '108' })]);
    clock = f.start + minute + 5_000;
    migrateDatabase(db);
    migrateDatabase(db);
    const enqueue = vi.fn();
    tracker(enqueue).tick();
    expect(enqueue).not.toHaveBeenCalled();
    expect(db.select().from(outboxMessages).get()?.kind).toBe('TELEGRAM_TEST');
    expect(signalDetail(db, f.candidateId)?.theory?.state).toBe('TP2_HIT');
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    for (const entry of entries) {
      unlinkSync(join(temp, entry, 'migration.sql'));
      rmdirSync(join(temp, entry));
    }
    rmdirSync(temp);
  }
});

test('history endpoints share filters and pausing settles stored evidence before invalidation', async () => {
  migrateDatabase(db);
  const f = fixture({ symbol: '=FIX' });
  fixture({ symbol: 'OTHER' });
  storeCandles(db, [f.candle(f.start, { high: '104' })]);
  clock = f.start + minute + 5_000;
  const settings = config();
  const app = await buildApp(
    db,
    settings,
    createMarketData(db, { now: () => clock }),
  );
  const credentials = { username: 'admin', password: 'fixture-password' };
  await initializeAdministrator(db, credentials);
  try {
    expect(
      (await app.inject('/api/v1/signals/export?format=csv')).statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: settings.WEB_ORIGIN },
      payload: credentials,
    });
    const headers = {
      cookie: String(login.headers['set-cookie']).split(';')[0]!,
      origin: settings.WEB_ORIGIN,
    };
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/monitors/' + f.monitorId,
      headers,
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    const detail = signalResponseSchema.parse(
      (
        await app.inject({ url: '/api/v1/signals/' + f.candidateId, headers })
      ).json(),
    ).data;
    expect(detail.theory).toMatchObject({
      state: 'INVALIDATED',
      reasonCode: 'MONITOR_PAUSED',
      observedBars: 1,
    });
    expect(detail.theoryEvents.map(({ type }) => type)).toEqual([
      'CANDLE',
      'TP',
      'INVALIDATED',
    ]);
    const query =
      'q=fix&exchange=BITGET&theoryState=INVALIDATED&fromMs=' +
      base +
      '&toMs=' +
      (base + 1);
    const recent = signalsResponseSchema.parse(
      (await app.inject({ url: '/api/v1/signals?' + query, headers })).json(),
    ).data;
    expect(recent.items.map(({ id }) => id)).toEqual([f.candidateId]);
    const reported = await app.inject({
      url: '/api/v1/signals/summary?' + query,
      headers,
    });
    expect(reported.statusCode, reported.body).toBe(200);
    const summary = signalSummaryResponseSchema.parse(reported.json()).data;
    expect(summary).toMatchObject([
      {
        candidates: 1,
        approved: 1,
        targetHits: [1, 0, 0, 0],
        averageGrossR: null,
      },
    ]);
    const csv = await app.inject({
      url: '/api/v1/signals/export?format=csv&' + query,
      headers,
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain('"\'=FIX"');
    const json = await app.inject({
      url: '/api/v1/signals/export?format=json&' + query,
      headers,
    });
    expect(json.json().data).toMatchObject([
      {
        id: f.candidateId,
        evidence: { indicators: { atr: 1 } },
        theoryEvents: detail.theoryEvents,
      },
    ]);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/v1/signals/' + f.candidateId,
          headers,
          payload: { confirm: true },
        })
      ).statusCode,
    ).toBe(409);
  } finally {
    await app.close();
  }
});

test('a settled candidate can be deleted after 48 hours with related records and deletion audit', () => {
  migrateDatabase(db);
  const f = fixture();
  const track = tracker();
  storeCandles(db, [f.candle(f.start, { high: '107' })]);
  clock = f.start + minute + 5_000;
  track.tick();
  expect(summarizeSignals(db, { q: 'fix' })[0]?.averageGrossR).toBe(2.25);
  expect(exportSignalHistory(db, { q: 'unknown' }, 'json')).toEqual([]);
  clock += 48 * 60 * minute;
  deleteSignalHistory(db, f.candidateId, clock, 'admin');
  expect(signalDetail(db, f.candidateId)).toBeUndefined();
  expect(db.select().from(signalOutcomes).all()).toEqual([]);
  expect(db.select().from(auditLogs).all()).toMatchObject([
    { action: 'SIGNAL_HISTORY_DELETED', targetId: f.candidateId },
  ]);
});
