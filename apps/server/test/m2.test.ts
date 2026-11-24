import { randomBytes, randomUUID } from 'node:crypto';
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
import type { Market, MarketQuote } from '@market-sentinel/contracts/markets';
import { monitorResponseSchema } from '@market-sentinel/contracts/markets';
import {
  signalResponseSchema,
  signalsResponseSchema,
  strategiesResponseSchema,
  strategyParametersSchema,
} from '@market-sentinel/contracts/strategies';
import type {
  Candle,
  ExchangeId,
  MarketType,
  Timeframe,
} from '@market-sentinel/domain';
import { Decimal } from 'decimal.js';
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
import { duration, type OpenInterest } from '../src/market-data/model.js';
import { createMarketData } from '../src/market-data/service.js';
import { saveOi, storeCandles } from '../src/market-data/store.js';
import { createNotifications } from '../src/notification/service.js';
import {
  markets,
  monitorConfigs,
  riskEvaluations,
  signalCandidates,
  strategyConfigVersions,
} from '../src/schema.js';
import {
  atr,
  ema,
  evaluateRisk,
  oiChange,
  relativeVolume,
  roundPrice,
  rsi,
} from '../src/strategy/evaluate.js';
import { createStrategyService } from '../src/strategy/service.js';
import {
  listSignals,
  saveCandidates,
  saveStrategyVersion,
  signalDetail,
  strategyTemplate,
} from '../src/strategy/store.js';

const closeTime = Date.UTC(2026, 10, 24, 12);
const timeframes = { trigger: '3m', confirm: '5m', trend: '1h' } as const;
const calibratedRisk = {
  maxSpreadBps: 10,
  minTurnover: '100',
  minStopPct: 0.1,
  maxStopPct: 5,
  maxAtrPct: 4,
};

let db: AppDatabase;
let runtime: ReturnType<typeof createStrategyService> | undefined;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  runtime?.stop();
  runtime = undefined;
  db.$client.close();
});

function listing(exchange: ExchangeId, marketType: MarketType): Market {
  const id = randomUUID();
  return {
    id,
    exchange,
    marketType,
    productType: marketType,
    venue: 'main',
    nativeSymbol: 'FIX-' + id.slice(0, 8),
    baseAsset: 'FIX',
    quoteAsset: 'USDT',
    collateralAsset: null,
    instrumentType: null,
    isReality: false,
    isRwa: false,
    status: 'ACTIVE',
    exchangeStatus: 'online',
    stale: false,
    pricePrecision: 2,
    tickSize: exchange === 'BITGET' && marketType === 'PERP' ? '0.02' : null,
    capabilities: {
      intervals: Object.values(timeframes),
      hasOpenInterest: marketType === 'PERP',
      hasOrderBook: true,
      hasFundingRate: false,
      supportsReadOnlyPositions: false,
      hasReliableBaseVolume: true,
      sessionType: 'CONTINUOUS',
      restrictions: [],
    },
    intervalRestrictions: {},
  };
}

function seedMarket(
  exchange: ExchangeId,
  marketType: MarketType,
  configured = true,
) {
  const market = listing(exchange, marketType);
  db.insert(markets)
    .values({ ...market, updatedAtMs: closeTime - 1 })
    .run();
  const config = strategyTemplate(marketType);
  if (configured) Object.assign(config.params.risk, calibratedRisk);
  const version = configured
    ? saveStrategyVersion(db, config, timeframes, closeTime - 1000)
    : null;
  const monitor = {
    ...timeframes,
    id: randomUUID(),
    marketId: market.id,
    enabled: true,
    extra: [] as Timeframe[],
    strategyConfigVersionId: version?.id ?? null,
  };
  db.insert(monitorConfigs).values(monitor).run();
  return { market, monitor, config, version };
}

function candle(
  market: Market,
  timeframe: Timeframe,
  end: number,
  o: number,
  c: number,
  volume = '10',
): Candle {
  return {
    marketId: market.id,
    timeframe,
    openTimeMs: end - duration[timeframe],
    closeTimeMs: end,
    open: o.toFixed(2),
    close: c.toFixed(2),
    high: (Math.max(o, c) + 0.4).toFixed(2),
    low: (Math.min(o, c) - 0.4).toFixed(2),
    baseVolume: volume,
    quoteTurnover: market.exchange === 'BITGET' ? '1000' : null,
    source: 'REST',
    isClosed: true,
    qualityFlags:
      market.exchange === 'BITGET' ? [] : ['MISSING_QUOTE_TURNOVER'],
  };
}

function series(
  market: Market,
  timeframe: Timeframe,
  direction: 'LONG' | 'SHORT',
  end = closeTime,
) {
  const length = 320;
  const translate = (value: number) =>
    direction === 'LONG' ? value : 200 - value;
  return Array.from({ length }, (_, index) => {
    const last = index === length - 1;
    const close =
      timeframe === '3m'
        ? last
          ? 101.2
          : 100
        : timeframe === '5m'
          ? 99 + (index % 2)
          : 60 + index * 0.2;
    return candle(
      market,
      timeframe,
      end - (length - 1 - index) * duration[timeframe],
      translate(timeframe === '3m' ? 100 : close),
      translate(close),
      last && timeframe === '3m' ? '30' : '10',
    );
  });
}

function openInterest(marketId: string, end = closeTime): OpenInterest[] {
  return Array.from({ length: 16 }, (_, i) => ({
    marketId,
    timestampMs: end - (15 - i) * 60_000,
    value: i >= 14 ? '100.5' : '100',
    unit: 'BASE_ASSET',
    unitDetails: 'FIX',
    source: 'REST',
    series: 'FIX_OI',
    qualityFlags: [],
  }));
}

function book(center: number, at: number): MarketQuote {
  const quote = (value: number) => ({
    value: value.toFixed(2),
    source: 'WS' as const,
    timestampMs: at,
  });
  return {
    last: null,
    mark: null,
    bid: quote(center - 0.02),
    ask: quote(center + 0.02),
    spread: quote(0.04),
  };
}

function liveFixture(market: Market, quote: MarketQuote | null) {
  let clock = closeTime + 6000;
  let listener: ((bar: Candle) => void) | undefined;
  const fail = vi.fn();
  const data = {
    now: () => clock,
    onCandleClosed(callback: (bar: Candle) => void) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    view: () => market,
    strategyMarket: () => ({ available: true, quote }),
  };
  runtime = createStrategyService(db, data, fail);
  runtime.start();
  return {
    runtime,
    data,
    fail,
    clock: (ms: number) => {
      clock = ms;
    },
    emit: (bar: Candle) => listener?.(bar),
    quote: (value: MarketQuote | null) => {
      quote = value;
    },
  };
}

function loadHistory(market: Market, direction: 'LONG' | 'SHORT') {
  const trigger = series(market, '3m', direction);
  for (const tf of ['5m', '1h'] as const)
    storeCandles(db, series(market, tf, direction));
  storeCandles(db, trigger);
  return trigger.at(-1)!;
}

const history = () => listSignals(db, { offset: 0, limit: 20 });

test('uses fixed EMA, RSI-Wilder, ATR and RVOL vectors and handles zero denominators', () => {
  expect(ema([8, 9, 10, 12, 11], 3)).toBe(10.75);
  const momentum = rsi([1, 2, 3, 2, 4], 3);
  expect(momentum.current).toBeCloseTo(83.333333);
  expect(momentum.previous).toBeCloseTo(66.666667);
  expect(rsi([2, 2, 2, 2], 2).current).toBe(50);
  expect(rsi([1, 2, 3, 4], 2).current).toBe(100);
  expect(rsi([4, 3, 2, 1], 2).current).toBe(0);
  expect(relativeVolume([20, 1, 2, 4], 2)).toBeCloseTo(8 / 3);
  expect(relativeVolume([0, 0, 10], 2)).toBeNaN();
  const market = listing('BITGET', 'PERP');
  const base = candle(market, '3m', closeTime, 10, 10);
  const bars = [
    { ...base, close: '10', high: '11', low: '9' },
    { ...base, close: '11.5', high: '12', low: '11' },
    { ...base, close: '8.5', high: '9', low: '8' },
    { ...base, close: '9.5', high: '10', low: '9' },
  ];
  expect(atr(bars, 2)).toBe(2.125);
});

test('reads only contiguous comparable OI samples at the close time', () => {
  const rows = openInterest(randomUUID());
  const params = strategyTemplate('PERP').params.oi!;
  const change = (samples: OpenInterest[], at = closeTime + 6000) =>
    oiChange(samples, params, closeTime, at);
  const future = { ...rows[15]!, timestampMs: closeTime + 1, value: '10000' };
  expect(change([future, ...rows]).deltaPct).toBe(0.5);
  expect(change(rows, closeTime + 181_000).deltaPct).toBeNull();
  expect(change(rows.filter((_, i) => i < 5 || i > 9)).deltaPct).toBeNull();
  expect(
    change([...rows.slice(0, 15), { ...rows[15]!, series: 'FALLBACK' }])
      .deltaPct,
  ).toBeNull();
  expect(
    change([...rows.slice(0, 15), { ...rows[15]!, unit: 'CONTRACTS' }])
      .deltaPct,
  ).toBeNull();
  expect(change(rows.slice(3)).deltaPct).toBeNull();
});

test('requires venue-specific precision and checks R:R after rounding', () => {
  const bitget = listing('BITGET', 'PERP');
  expect(roundPrice(bitget, new Decimal('10.01'))?.toFixed()).toBe('10.02');
  expect(
    roundPrice({ ...bitget, tickSize: null }, new Decimal('10.01')),
  ).toBeNull();
  const hyperliquid = { ...listing('HYPERLIQUID', 'PERP'), pricePrecision: 6 };
  expect(roundPrice(hyperliquid, new Decimal('12345.6'))?.toFixed()).toBe(
    '12346',
  );
  expect(roundPrice(hyperliquid, new Decimal('0.00123456'))?.toFixed()).toBe(
    '0.001235',
  );
  expect(roundPrice(hyperliquid, new Decimal('122.1234'))?.toFixed()).toBe(
    '122.12',
  );
  const testMarket = { ...bitget, tickSize: '0.1' };
  const params = strategyTemplate('PERP').params;
  Object.assign(params.risk, calibratedRisk, {
    minWeightedRR: 2.1,
    takeProfits: [
      { rMultiple: 1.49, closePct: 50 },
      { rMultiple: 2.99, closePct: 50 },
    ],
  });
  const bar = {
    ...candle(testMarket, '3m', closeTime, 100, 100),
    low: '99.95',
  };
  expect(
    evaluateRisk(
      testMarket,
      book(100, closeTime),
      [bar],
      0.08,
      'LONG',
      params,
      closeTime + 6000,
    ),
  ).toMatchObject({
    outcome: 'REJECTED',
    reasonCode: 'REJECT_LOW_RR',
    levels: { entry: '100', stop: '99.9', weightedRR: '2' },
  });
});

test.each([
  ['BITGET', 'PERP', 'LONG', 'PASSED', 'LONG'],
  ['HYPERLIQUID', 'PERP', 'SHORT', 'PASSED', 'SHORT'],
  ['HYPERLIQUID', 'SPOT', 'LONG', 'PASSED', 'LONG'],
  ['BITGET', 'SPOT', 'SHORT', 'WATCH_ONLY', 'BEARISH_WATCH'],
] as const)(
  'evaluates %s %s %s from the market close',
  (exchange, marketType, side, outcome, direction) => {
    migrateDatabase(db);
    const { market } = seedMarket(exchange, marketType);
    const trigger = loadHistory(market, side);
    if (marketType === 'PERP') saveOi(db, openInterest(market.id));
    const fixture = liveFixture(market, book(Number(trigger.close), closeTime));
    fixture.emit({ ...trigger, isClosed: false });
    fixture.runtime.tick();
    expect(history()).toHaveLength(0);
    fixture.emit(trigger);
    fixture.runtime.tick();
    expect(fixture.fail).not.toHaveBeenCalled();
    const [summary] = history();
    expect(summary).toMatchObject({
      direction,
      outcome,
      triggerCloseMs: closeTime,
    });
    const detail = signalDetail(db, summary!.id)!;
    expect(detail.evidence.openInterest).toEqual(
      marketType === 'SPOT' ? null : expect.objectContaining({ deltaPct: 0.5 }),
    );
    if (outcome === 'WATCH_ONLY') expect(detail.levels).toBeNull();
    else {
      expect(detail.levels?.weightedRR).toBe(
        exchange === 'BITGET' ? '2.25308642' : '2.25',
      );
      expect(detail.levels?.entry).toBe(side === 'LONG' ? '101.22' : '98.78');
    }
    if (exchange === 'HYPERLIQUID')
      expect(detail.evidence.turnover).toMatchObject({
        source: 'LOW_TIMES_BASE_VOLUME',
      });
  },
);

test('delivers a live Bitget candidate from closed candle and OI evidence through final risk', async () => {
  migrateDatabase(db);
  const { market } = seedMarket('BITGET', 'PERP');
  const trigger = loadHistory(market, 'LONG');
  saveOi(db, openInterest(market.id));
  const fixture = liveFixture(market, book(Number(trigger.close), closeTime));
  const config = readConfig({
    TELEGRAM_BOT_TOKEN: '1234567:fixture_token',
    APP_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
    SESSION_SECRET: randomBytes(32).toString('base64'),
  });
  let code = '';
  const sent = vi.fn();
  const queue = createNotifications(db, config, fixture.data, fixture.fail, {
    fetchTelegram: async (url, request) => {
      const method = String(url).split('/').at(-1);
      if (method === 'getMe')
        return Response.json({ ok: true, result: { username: 'fixture_bot' } });
      if (method === 'getUpdates')
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 4,
              message: {
                text: '/start ' + code,
                chat: { type: 'private', id: 42 },
                from: { id: 42, is_bot: false },
              },
            },
          ],
        });
      sent(JSON.parse(String(request?.body)));
      return Response.json({ ok: true, result: { message_id: 101 } });
    },
  });
  code = (await queue.telegram.pair('fixture')).code;
  await queue.tickPair();
  fixture.emit(trigger);
  fixture.runtime.tick();
  await queue.tickSignals();
  await queue.tickOutbox();
  expect(sent).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      chat_id: '42',
      text: expect.stringContaining('OI 达到策略阈值'),
    }),
  );
  expect(history()[0]).toMatchObject({
    finalRisk: { outcome: 'PASSED' },
    delivery: { status: 'SENT', telegramMessageId: '101' },
  });
});

test('waits for simultaneous closes and ignores future candles, repeated events and restart backfill', () => {
  migrateDatabase(db);
  const { market, monitor } = seedMarket('BITGET', 'PERP');
  const trigger = series(market, '3m', 'LONG');
  const confirm = series(market, '5m', 'LONG');
  const trend = series(market, '1h', 'LONG');
  storeCandles(db, trigger);
  storeCandles(db, [
    ...confirm.slice(0, -1),
    candle(market, '5m', closeTime + duration['5m'], 109, 90),
  ]);
  storeCandles(db, [
    ...trend.slice(0, -1),
    candle(market, '1h', closeTime + duration['1h'], 90, 40),
  ]);
  saveOi(db, openInterest(market.id));
  const event = trigger.at(-1)!;
  const quote = book(Number(event.close), closeTime);
  const fixture = liveFixture(market, quote);
  fixture.emit(event);
  fixture.runtime.tick();
  expect(history()).toHaveLength(0);
  const current = db
    .select()
    .from(monitorConfigs)
    .where(eq(monitorConfigs.id, monitor.id))
    .get()!;
  expect(
    fixture.runtime.describe(current, market.marketType).latest,
  ).toMatchObject({ outcome: 'WAITING', reasonCode: 'AWAITING_CLOSE' });
  storeCandles(db, [trend.at(-1)!]);
  fixture.runtime.tick();
  expect(history()).toHaveLength(0);
  storeCandles(db, [confirm.at(-1)!]);
  fixture.runtime.tick();
  const [result] = history();
  expect(result?.outcome).toBe('PASSED');
  expect(signalDetail(db, result!.id)?.evidence.candles).toMatchObject({
    confirm: { last: { closeTimeMs: closeTime } },
    trend: { last: { closeTimeMs: closeTime } },
  });
  fixture.emit(event);
  fixture.runtime.tick();
  expect(history()).toEqual([result]);
  fixture.runtime.stop();
  const restarted = liveFixture(market, quote);
  restarted.runtime.tick();
  expect(history()).toEqual([result]);
  restarted.emit(event);
  restarted.runtime.tick();
  expect(history()).toEqual([result]);
});

test('holds stale inputs, missing OI and incomplete risk settings with explicit reasons', () => {
  migrateDatabase(db);
  for (const [marketType, configured, quoteAge, evalAge, expected] of [
    ['SPOT', false, 0, 6000, 'REJECT_RISK_CONFIG_REQUIRED'],
    ['SPOT', true, 61_000, 6000, 'REJECT_STALE_QUOTE'],
    ['SPOT', true, 0, 61_000, 'REJECT_STALE_DATA'],
    ['PERP', true, 0, 6000, 'REJECT_OI_UNAVAILABLE'],
  ] as const) {
    const { market } = seedMarket('BITGET', marketType, configured);
    const trigger = loadHistory(market, 'LONG');
    const quote = book(Number(trigger.close), closeTime - quoteAge);
    const fixture = liveFixture(market, quote);
    fixture.clock(closeTime + evalAge);
    fixture.emit(trigger);
    fixture.runtime.tick();
    expect(
      history().find((row) => row.marketId === market.id)?.reasonCode,
    ).toBe(expected);
    fixture.runtime.stop();
  }
});

test('invalidates a pending trigger when parameters change and protects a gap', () => {
  migrateDatabase(db);
  const { market, monitor, config } = seedMarket('BITGET', 'SPOT');
  const trigger = series(market, '3m', 'LONG');
  storeCandles(db, trigger);
  const fixture = liveFixture(market, book(101.2, closeTime));
  fixture.emit(trigger.at(-1)!);
  fixture.runtime.tick();
  config.params.volume.relativeMin = 1.8;
  const version = saveStrategyVersion(db, config, timeframes, closeTime + 6000);
  db.update(monitorConfigs)
    .set({
      strategyConfigVersionId: version.id,
      strategyAfterMs: closeTime + 6000,
    })
    .where(eq(monitorConfigs.id, monitor.id))
    .run();
  storeCandles(db, series(market, '1h', 'LONG'));
  storeCandles(
    db,
    series(market, '5m', 'LONG').filter((_, i) => i !== 305),
  );
  fixture.emit(trigger.at(-1)!);
  fixture.runtime.tick();
  expect(history()).toHaveLength(0);
  const nextTime = closeTime + duration['3m'];
  const next = candle(market, '3m', nextTime, 101.2, 102.4, '30');
  storeCandles(db, [next]);
  fixture.clock(nextTime + 6000);
  fixture.quote(book(102.4, nextTime));
  fixture.emit(next);
  fixture.runtime.tick();
  const current = db
    .select()
    .from(monitorConfigs)
    .where(eq(monitorConfigs.id, monitor.id))
    .get()!;
  expect(
    fixture.runtime.describe(current, market.marketType).latest?.reasonCode,
  ).toBe('REJECT_INCOMPLETE_CANDLE');
  expect(history()).toHaveLength(0);
});

test('suppresses conflicts and rolls candidate and pre-risk back atomically', () => {
  migrateDatabase(db);
  const { market, config } = seedMarket('BITGET', 'PERP');
  const at = closeTime + 6000;
  const trigger = candle(market, '3m', closeTime, 100, 101.2);
  const passed = { outcome: 'PASSED', reasonCode: null, levels: null } as const;
  db.$client.exec(
    "CREATE TRIGGER fail_risk BEFORE INSERT ON risk_evaluations BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END",
  );
  const proposals = [{ direction: 'LONG', risk: passed }] as const;
  expect(() =>
    saveCandidates(db, trigger, timeframes, config, [...proposals], {}, at),
  ).toThrow('insert into "risk_evaluations"');
  expect(db.select().from(signalCandidates).all()).toHaveLength(0);
  expect(db.select().from(riskEvaluations).all()).toHaveLength(0);
  db.$client.exec('DROP TRIGGER fail_risk');
  saveCandidates(db, trigger, timeframes, config, [...proposals], {}, at);
  const later = candle(market, '3m', closeTime + duration['3m'], 101.2, 102);
  const next = saveCandidates(
    db,
    later,
    timeframes,
    config,
    [...proposals],
    {},
    at + duration['3m'],
  );
  expect(next[0]).toMatchObject({
    outcome: 'PASSED',
    reasonCode: null,
  });
  const conflictBar = candle(
    market,
    '3m',
    closeTime + duration['3m'] * 2,
    101.2,
    102,
  );
  const conflict = saveCandidates(
    db,
    conflictBar,
    timeframes,
    config,
    [...proposals, { direction: 'SHORT', risk: passed }],
    {},
    at + duration['3m'] * 2,
  );
  expect(conflict.map(({ reasonCode }) => reasonCode)).toEqual([
    'SUPPRESS_CONFLICT',
    'SUPPRESS_CONFLICT',
  ]);
});

test('upgrades an M1 database without rewriting its market, monitor or candles', () => {
  const source = fileURLToPath(new URL('../drizzle/', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'market-sentinel-m2-'));
  const entries = readdirSync(source).filter((name) => /_m[01]_/.test(name));
  try {
    for (const entry of entries) {
      mkdirSync(join(directory, entry));
      copyFileSync(
        join(source, entry, 'migration.sql'),
        join(directory, entry, 'migration.sql'),
      );
    }
    migrate(db, { migrationsFolder: directory });
    const market = listing('BITGET', 'SPOT');
    db.insert(markets)
      .values({ ...market, updatedAtMs: closeTime })
      .run();
    const legacyId = randomUUID();
    db.$client
      .prepare(
        "INSERT INTO monitor_configs (id, market_id, trigger_tf, confirm_tf, trend_tf, extra_json, enabled) VALUES (?, ?, '3m', '5m', '1h', '[]', 0)",
      )
      .run(legacyId, market.id);
    storeCandles(db, [candle(market, '3m', closeTime, 100, 101)]);
    migrateDatabase(db);
    migrateDatabase(db);
    expect(db.select().from(monitorConfigs).get()).toMatchObject({
      id: legacyId,
      marketId: market.id,
      enabled: false,
      strategyEnabled: true,
      strategyConfigVersionId: null,
    });
    expect(db.$client.prepare('SELECT close FROM candles').get()).toMatchObject(
      { close: '101.00' },
    );
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    for (const entry of entries) {
      unlinkSync(join(directory, entry, 'migration.sql'));
      rmdirSync(join(directory, entry));
    }
    rmdirSync(directory);
  }
});

test('authorizes strategy updates and returns immutable, paginated candidate evidence', async () => {
  migrateDatabase(db);
  const { market, monitor, config } = seedMarket('BITGET', 'SPOT', false);
  const fixture = liveFixture(market, book(101.2, closeTime));
  const trigger = loadHistory(market, 'LONG');
  fixture.emit(trigger);
  fixture.runtime.tick();
  const first = history()[0]!;
  fixture.runtime.stop();

  const credentials = {
    username: 'm2-admin',
    password: 'fixture password 2026',
  };
  await initializeAdministrator(db, credentials);
  const settings = readConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    APP_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
    SESSION_SECRET: randomBytes(32).toString('base64'),
  });
  const origin = settings.WEB_ORIGIN;
  const source = createMarketData(db, { now: () => closeTime + 6000 });
  const app = await buildApp(db, settings, source);
  try {
    for (const url of [
      '/api/v1/strategies',
      '/api/v1/signals',
      '/api/v1/signals/' + first.id,
    ])
      expect((await app.inject(url)).statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin },
      payload: credentials,
    });
    const cookies = { market_sentinel_session: login.cookies[0]!.value };
    const api = (url: string) => app.inject({ url, cookies });
    const patch = (params: unknown, requestOrigin = origin) =>
      app.inject({
        method: 'PATCH',
        url: '/api/v1/monitors/' + monitor.id,
        cookies,
        headers: { origin: requestOrigin },
        payload: { strategy: { enabled: true, params } },
      });
    const templates = await api('/api/v1/strategies');
    expect(
      strategiesResponseSchema.parse(templates.json()).data.templates,
    ).toHaveLength(2);
    const params = strategyParametersSchema.parse(config.params);
    expect((await patch(params, 'https://bad.example')).statusCode).toBe(403);
    expect(
      (await patch({ ...params, emaPeriods: [55, 21, 144] })).statusCode,
    ).toBe(400);
    expect(
      (await patch({ ...params, oi: strategyTemplate('PERP').params.oi }))
        .statusCode,
    ).toBe(422);
    Object.assign(params.risk, calibratedRisk);
    const saved = monitorResponseSchema.parse((await patch(params)).json()).data
      .strategy;
    expect(saved.versionId).toBeTruthy();
    expect(db.select().from(strategyConfigVersions).all()).toHaveLength(2);
    expect(db.select().from(monitorConfigs).get()?.strategyAfterMs).toBe(
      closeTime + 6000,
    );
    expect((await patch(params)).statusCode).toBe(200);
    expect(db.select().from(strategyConfigVersions).all()).toHaveLength(2);
    const recent = signalsResponseSchema.parse(
      (
        await api(
          '/api/v1/signals?marketId=' + market.id + '&state=REJECTED&limit=1',
        )
      ).json(),
    ).data;
    expect(recent.items).toEqual([first]);
    const detail = signalResponseSchema.parse(
      (await api('/api/v1/signals/' + first.id)).json(),
    ).data;
    expect(detail.reasonCode).toBe('REJECT_RISK_CONFIG_REQUIRED');
    expect(detail.configVersionId).not.toBe(saved.versionId);
    expect(detail.params.risk.minTurnover).toBeNull();
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/v1/monitors/' + monitor.id,
      cookies,
      headers: { origin },
    });
    expect(deleted.statusCode).toBe(200);
    expect((await api('/api/v1/signals/' + first.id)).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});
