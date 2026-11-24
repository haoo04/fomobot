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
import {
  aiSettingsResponseSchema,
  telegramPairResponseSchema,
  telegramSettingsResponseSchema,
  type AiReviewResult,
} from '@market-sentinel/contracts/notifications';
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
import type { ReviewProvider } from '../src/notification/ai.js';
import { createNotifications } from '../src/notification/service.js';
import {
  aiReviews,
  markets,
  monitorConfigs,
  outboxMessages,
  secretStore,
  signalCandidates,
  signals,
} from '../src/schema.js';
import {
  saveCandidates,
  saveStrategyVersion,
  signalDetail,
  strategyTemplate,
} from '../src/strategy/store.js';

const closeTime = Date.UTC(2026, 10, 24, 12);
const timeframes = { trigger: '3m', confirm: '5m', trend: '1h' } as const;
const token = '345678:fixture_bot_token';
const aiKey = 'sk-fixture-key-abc1';
const actor = 'fixture-admin';
const chatId = 23456789012;
let db: AppDatabase;
let clock: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = closeTime + 5000;
});

afterEach(() => db.$client.close());

function config(env: NodeJS.ProcessEnv = {}) {
  return readConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    APP_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
    SESSION_SECRET: randomBytes(32).toString('base64'),
    ...env,
  });
}

function marketFixture({
  cooldownMinutes = 0,
  marketType = 'SPOT',
}: {
  cooldownMinutes?: number;
  marketType?: Market['marketType'];
} = {}) {
  const market: Market = {
    id: randomUUID(),
    exchange: 'BITGET',
    marketType,
    productType: marketType,
    venue: 'main',
    nativeSymbol: 'FIXUSDT',
    baseAsset: 'FIX',
    quoteAsset: 'USDT',
    collateralAsset: null,
    instrumentType: null,
    status: 'ACTIVE',
    exchangeStatus: 'online',
    stale: false,
    isReality: false,
    isRwa: null,
    pricePrecision: 2,
    tickSize: '0.01',
    intervalRestrictions: {},
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
  };
  db.insert(markets)
    .values({ ...market, updatedAtMs: clock })
    .run();
  const strategy = strategyTemplate(marketType);
  Object.assign(strategy.params.risk, {
    maxSpreadBps: 10,
    minTurnover: '100',
    minStopPct: 0.1,
    maxStopPct: 5,
    maxAtrPct: 4,
    cooldownMinutes,
  });
  const version = saveStrategyVersion(
    db,
    strategy,
    timeframes,
    closeTime - 1000,
  );
  const monitorId = randomUUID();
  db.insert(monitorConfigs)
    .values({
      id: monitorId,
      marketId: market.id,
      enabled: true,
      extra: [],
      ...timeframes,
      strategyConfigVersionId: version.id,
    })
    .run();
  const point = (value: string) => ({
    source: 'WS' as const,
    value,
    timestampMs: clock,
  });
  let quoteOverride: MarketQuote | undefined;
  let available = true;
  const data = {
    now: () => clock,
    view: () => market,
    strategyMarket: () => ({
      available,
      quote: quoteOverride ?? {
        last: null,
        mark: null,
        spread: point('0.04'),
        bid: point('99.98'),
        ask: point('100.02'),
      },
    }),
  };
  function candidate(closeMs = closeTime, oiAgeMs = 2000) {
    const candle = {
      marketId: market.id,
      timeframe: '3m' as const,
      openTimeMs: closeMs - 180_000,
      closeTimeMs: closeMs,
      open: '99.7',
      high: '100.2',
      low: '99.6',
      close: '100',
      baseVolume: '30',
      quoteTurnover: '3000',
      isClosed: true,
      source: 'WS' as const,
      qualityFlags: [],
    };
    saveCandidates(
      db,
      candle,
      timeframes,
      strategy,
      [
        {
          direction: 'LONG',
          risk: {
            outcome: 'PASSED',
            reasonCode: null,
            levels: {
              entry: '100.02',
              stop: '98.02',
              takeProfits: [
                { price: '103.02', closePct: 50 },
                { price: '106.02', closePct: 50 },
              ],
              weightedRR: '2.25',
            },
          },
        },
      ],
      {
        candles: { trigger: { last: candle } },
        indicators: { atr: 1, rvol: 3, rsi: 55, trendEma: [97, 95, 93] },
        openInterest:
          marketType === 'PERP'
            ? { latest: { timestampMs: closeMs - oiAgeMs }, deltaPct: 1 }
            : null,
      },
      clock,
    );
    return db
      .select()
      .from(signalCandidates)
      .where(eq(signalCandidates.triggerCloseMs, closeMs))
      .get()!.id;
  }
  return {
    candidate,
    data,
    market,
    monitorId,
    overrideQuote(value: MarketQuote) {
      quoteOverride = value;
    },
    disconnect() {
      available = false;
    },
  };
}

function fakeTelegram() {
  let updates: unknown[] = [];
  const sent: Array<{ chat_id: string; text: string }> = [];
  const send = vi.fn(async () =>
    Response.json({ ok: true, result: { message_id: 17 } }),
  );
  const transport: typeof fetch = async (input, init) => {
    const method = String(input).split('/').at(-1);
    const body = JSON.parse(String(init?.body));
    if (method === 'getMe')
      return Response.json({ ok: true, result: { username: 'fixture_bot' } });
    if (method === 'getUpdates') {
      const result = updates;
      updates = [];
      return Response.json({ ok: true, result });
    }
    expect(method).toBe('sendMessage');
    sent.push(body);
    return send();
  };
  return {
    send,
    sent,
    transport,
    update(code: string, type = 'private', update_id = 1) {
      updates.push({
        update_id,
        message: {
          chat: { type, id: chatId },
          from: { id: chatId, is_bot: false },
          text: '/start ' + code,
        },
      });
    },
  };
}

async function paired(
  market = marketFixture(),
  settings = config({ TELEGRAM_BOT_TOKEN: token }),
  fake = fakeTelegram(),
  reviewOpenAI?: ReviewProvider,
) {
  const queue = createNotifications(
    db,
    settings,
    market.data,
    () => undefined,
    { fetchTelegram: fake.transport, reviewOpenAI },
  );
  const challenge = await queue.telegram.pair(actor);
  fake.update(challenge.code);
  await queue.tickPair();
  return { queue, fake, market, settings };
}

function reviewResponse(choices: Partial<AiReviewResult> = {}) {
  const review: AiReviewResult = {
    decision: 'ACCEPT',
    confidenceScore: 85,
    rationale: ['固定行情审核样本'],
    riskFlags: [],
    rejectReason: null,
    levelAdjustment: null,
    ...choices,
  };
  return {
    status: 'completed',
    model: 'gpt-6-luna-fixture',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify(review) }],
      },
    ],
    usage: { input_tokens: 320, output_tokens: 80 },
  };
}

function aiConfig(budget = '1') {
  return config({
    TELEGRAM_BOT_TOKEN: token,
    OPENAI_API_KEY: aiKey,
    AI_REVIEW_ENABLED: 'true',
    AI_DAILY_BUDGET_USD: budget,
  });
}

test('pairs only one private chat with a fresh code and stores and exposes only masked credentials', async () => {
  migrateDatabase(db);
  const market = marketFixture();
  const fake = fakeTelegram();
  const queue = createNotifications(
    db,
    config(),
    market.data,
    () => undefined,
    { fetchTelegram: fake.transport },
  );
  const saved = queue.telegram.save(
    { botToken: token, marketDailyLimit: 8, globalDailyLimit: 30 },
    actor,
  );
  expect(saved).toMatchObject({
    storedToken: true,
    paired: false,
    tokenMask: '••••oken',
  });
  expect(JSON.stringify(db.select().from(secretStore).all())).not.toContain(
    token,
  );
  const first = await queue.telegram.pair(actor);
  fake.update(first.code, 'group');
  fake.update('a'.repeat(24), 'private', 2);
  await queue.tickPair();
  expect(queue.telegram.settings().paired).toBe(false);
  clock = first.expiresAtMs;
  fake.update(first.code);
  await queue.tickPair();
  expect(queue.telegram.settings().paired).toBe(false);
  const second = await queue.telegram.pair(actor);
  fake.update(second.code, 'private', 3);
  await queue.tickPair();
  expect(queue.telegram.settings()).toMatchObject({
    paired: true,
    pairingExpiresAtMs: null,
  });
  queue.enqueueTest(actor);
  await queue.tickOutbox();
  expect(fake.sent[0]).toMatchObject({
    chat_id: String(chatId),
    text: expect.stringContaining('测试消息'),
  });
  expect(queue.telegram.settings().lastTest).toMatchObject({
    status: 'SENT',
    telegramMessageId: '17',
  });
  queue.telegram.save(
    { botToken: '555:replacement', marketDailyLimit: 8, globalDailyLimit: 30 },
    actor,
  );
  expect(queue.telegram.settings().paired).toBe(false);
  expect(db.select().from(secretStore).all()).toHaveLength(1);
});

test('finalizes rule signals atomically and suppresses a subsequent candidate only after approval', async () => {
  migrateDatabase(db);
  const { queue, fake, market } = await paired(
    marketFixture({ cooldownMinutes: 30 }),
  );
  const id = market.candidate();
  market.candidate();
  db.$client.exec(
    "CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox_messages BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END",
  );
  await expect(queue.tickSignals()).rejects.toThrow(
    'insert into "outbox_messages"',
  );
  expect(db.select().from(signals).all()).toHaveLength(0);
  expect(signalDetail(db, id)).toMatchObject({
    deliveryPending: true,
    finalRisk: null,
  });
  db.$client.exec('DROP TRIGGER fail_outbox');
  await queue.tickSignals();
  await queue.tickSignals();
  await queue.tickOutbox();
  expect(fake.sent).toHaveLength(1);
  expect(fake.sent[0]?.text).toMatch(/\[规则信号\].*LONG/s);
  expect(fake.sent[0]?.text).toContain('TP2 106.02 USDT（50%）');
  const first = signalDetail(db, id)!;
  expect(first).toMatchObject({
    deliveryPending: false,
    finalRisk: { outcome: 'PASSED' },
    signalId: expect.any(String),
    delivery: { status: 'SENT', telegramMessageId: '17' },
  });
  expect(fake.sent[0]?.text).toContain(first.signalId!);
  expect(queue.diagnostics().lastQueueDelayMs).toBe(5000);
  clock += 180_000;
  const second = market.candidate(closeTime + 180_000);
  await queue.tickSignals();
  expect(signalDetail(db, second)?.finalRisk).toMatchObject({
    outcome: 'SUPPRESSED',
    reasonCode: 'SUPPRESS_COOLDOWN',
  });
});

test('defers Telegram throttles, then stops automatic retries when delivery becomes uncertain', async () => {
  migrateDatabase(db);
  const { queue, fake, market } = await paired();
  const id = market.candidate();
  fake.send
    .mockResolvedValueOnce(
      Response.json(
        { ok: false, error_code: 429, parameters: { retry_after: 8 } },
        { status: 429 },
      ),
    )
    .mockRejectedValueOnce(new Error('fixture timeout'));
  await queue.tickSignals();
  await queue.tickOutbox();
  clock += 7999;
  await queue.tickOutbox();
  expect(fake.sent).toHaveLength(1);
  clock += 1;
  await queue.tickOutbox();
  await queue.tickOutbox();
  const detail = signalDetail(db, id)!;
  expect(detail.delivery).toMatchObject({
    attempts: 2,
    status: 'DELIVERY_UNKNOWN',
  });
  expect(fake.sent).toHaveLength(2);
  expect(queue.canResend(detail.signalId)).toBe(true);
  queue.resend(id, actor);
  expect(() => queue.resend(id, actor)).toThrow('此信号当前无法补发');
  await queue.tickOutbox();
  expect(fake.sent[2]?.text).toContain('补发 · 可能重复');
  expect(
    signalDetail(db, id)?.deliveries.map((delivery) => delivery.status),
  ).toEqual(['SENT', 'DELIVERY_UNKNOWN']);
  expect(db.select().from(signals).all()).toHaveLength(1);
});

test.each([
  'paused',
  'new pairing',
  'expired',
  'daily limit',
  'restart',
  'unavailable',
] as const)(
  'handles pending and interrupted delivery safely when %s',
  async (change) => {
    migrateDatabase(db);
    const { queue, fake, market, settings } = await paired();
    const id = market.candidate();
    await queue.tickSignals();
    const reason = {
      paused: 'SUPPRESS_MONITOR_CHANGED',
      'new pairing': 'TELEGRAM_PAIRING_CHANGED',
      expired: 'DELIVERY_EXPIRED',
      'daily limit': 'SUPPRESS_DAILY_LIMIT',
      restart: 'TELEGRAM_SEND_INTERRUPTED',
      unavailable: 'REJECT_MARKET_UNAVAILABLE',
    }[change];
    if (change === 'daily limit') {
      queue.telegram.save({ marketDailyLimit: 1, globalDailyLimit: 1 }, actor);
      await queue.tickOutbox();
      clock += 180_000;
      const second = market.candidate(closeTime + 180_000);
      await queue.tickSignals();
      await queue.tickOutbox();
      expect(signalDetail(db, second)?.delivery).toMatchObject({
        status: 'FAILED',
        lastError: reason,
      });
      expect(fake.sent).toHaveLength(1);
      return;
    }
    if (change === 'paused')
      db.update(monitorConfigs)
        .set({ enabled: false })
        .where(eq(monitorConfigs.id, market.monitorId))
        .run();
    if (change === 'new pairing') {
      const challenge = await queue.telegram.pair(actor);
      fake.update(challenge.code, 'private', 2);
      await queue.tickPair();
    }
    if (change === 'expired') clock = closeTime + 60_000;
    if (change === 'unavailable') market.disconnect();
    if (change === 'restart') {
      db.update(outboxMessages).set({ status: 'SENDING' }).run();
      const restarted = createNotifications(
        db,
        settings,
        market.data,
        () => undefined,
        { fetchTelegram: fake.transport },
      );
      await restarted.tickOutbox();
    } else await queue.tickOutbox();
    expect(signalDetail(db, id)?.delivery).toMatchObject({
      status: change === 'restart' ? 'DELIVERY_UNKNOWN' : 'FAILED',
      lastError: reason,
    });
    expect(fake.sent).toHaveLength(0);
  },
);

test('rechecks new book drift and the original OI sample before approval', async () => {
  migrateDatabase(db);
  const { queue, market } = await paired(marketFixture({ marketType: 'PERP' }));
  const id = market.candidate(closeTime, 178_000);
  await queue.tickSignals();
  expect(signalDetail(db, id)?.finalRisk?.reasonCode).toBe(
    'REJECT_OI_UNAVAILABLE',
  );
  clock += 180_000;
  const next = market.candidate(closeTime + 180_000);
  const quote = market.data.strategyMarket().quote;
  market.overrideQuote({
    ...quote,
    bid: { ...quote.bid, value: '103' },
    ask: { ...quote.ask, value: '103.02' },
  });
  await queue.tickSignals();
  expect(signalDetail(db, next)?.finalRisk?.reasonCode).toBe(
    'REJECT_PRICE_DRIFT',
  );
  expect(db.select().from(signals).all()).toHaveLength(0);
});

test('preserves M2 candidate history without enqueueing a notification after migration', async () => {
  const source = fileURLToPath(new URL('../drizzle/', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'market-sentinel-m3-'));
  const entries = readdirSync(source).filter((name) => /_m[012]_/.test(name));
  try {
    for (const entry of entries) {
      mkdirSync(join(directory, entry));
      copyFileSync(
        join(source, entry, 'migration.sql'),
        join(directory, entry, 'migration.sql'),
      );
    }
    migrate(db, { migrationsFolder: directory });
    const { market } = marketFixture();
    const legacyId = randomUUID();
    const version = db
      .select()
      .from(monitorConfigs)
      .get()?.strategyConfigVersionId;
    db.$client
      .prepare(
        "INSERT INTO signal_candidates VALUES (?, 'm2-key', ?, ?, '3m', ?, ?, 'LONG', ?, '{}')",
      )
      .run(
        legacyId,
        market.id,
        version!,
        closeTime - 180_000,
        closeTime,
        clock,
      );
    db.$client
      .prepare(
        "INSERT INTO risk_evaluations (candidate_id, stage, outcome) VALUES (?, 'PRE', 'PASSED')",
      )
      .run(legacyId);
    migrateDatabase(db);
    const queue = createNotifications(
      db,
      config(),
      {
        now: () => clock,
        view: () => market,
        strategyMarket: () => ({ available: false, quote: null }),
      },
      () => undefined,
    );
    await queue.tickSignals();
    expect(signalDetail(db, legacyId)).toMatchObject({
      deliveryPending: false,
      signalId: null,
      outcome: 'PASSED',
    });
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    for (const entry of entries) {
      unlinkSync(join(directory, entry, 'migration.sql'));
      rmdirSync(join(directory, entry));
    }
    rmdirSync(directory);
  }
});

test('authenticates settings and validates origin before Telegram and OpenAI provider actions', async () => {
  migrateDatabase(db);
  const settings = config();
  const fake = fakeTelegram();
  const reviewer = vi.fn<ReviewProvider>(async () => reviewResponse());
  const app = await buildApp(db, settings, createMarketData(db), {
    fetchTelegram: fake.transport,
    reviewOpenAI: reviewer,
  });
  const path = '/api/v1/settings/telegram';
  try {
    const credentials = {
      username: actor,
      password: 'fixture administrator password',
    };
    await initializeAdministrator(db, credentials);
    const head = { origin: settings.WEB_ORIGIN };
    expect((await app.inject(path)).statusCode).toBe(401);
    expect((await app.inject('/api/v1/settings/ai')).statusCode).toBe(401);
    const login = await app.inject({
      url: '/api/v1/auth/login',
      method: 'POST',
      headers: head,
      payload: credentials,
    });
    const cookies = { market_sentinel_session: login.cookies[0]!.value };
    const payload = {
      botToken: token,
      marketDailyLimit: 8,
      globalDailyLimit: 30,
    };
    expect(
      (await app.inject({ method: 'PUT', url: path, cookies, payload }))
        .statusCode,
    ).toBe(403);
    const saved = await app.inject({
      method: 'PUT',
      url: path,
      headers: head,
      cookies,
      payload,
    });
    expect(
      telegramSettingsResponseSchema.parse(saved.json()).data.tokenMask,
    ).toBe('••••oken');
    expect(saved.body).not.toContain(token);
    const pair = await app.inject({
      method: 'POST',
      url: path + '/pair',
      headers: head,
      cookies,
    });
    expect(
      telegramPairResponseSchema.parse(pair.json()).data.code,
    ).toHaveLength(24);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: path + '/test',
          headers: head,
          cookies,
        })
      ).statusCode,
    ).toBe(409);
    const aiPath = '/api/v1/settings/ai';
    const aiPatch = {
      apiKey: aiKey,
      enabled: false,
      model: 'gpt-6-luna',
      confidenceThreshold: 70,
      dailyBudgetUsd: 1,
      timeoutMs: 10_000,
      maxOutputTokens: 1024,
    };
    expect(
      (await app.inject({ method: 'POST', url: aiPath + '/test', cookies }))
        .statusCode,
    ).toBe(403);
    const saveAi = await app.inject({
      method: 'PUT',
      url: aiPath,
      headers: head,
      cookies,
      payload: aiPatch,
    });
    expect(saveAi.statusCode).toBe(200);
    expect(aiSettingsResponseSchema.parse(saveAi.json()).data.apiKeyMask).toBe(
      '••••abc1',
    );
    expect(saveAi.body).not.toContain(aiKey);
    const tested = await app.inject({
      method: 'POST',
      url: aiPath + '/test',
      headers: head,
      cookies,
    });
    expect(aiSettingsResponseSchema.parse(tested.json()).data).toMatchObject({
      enabled: false,
      lastTest: { status: 'COMPLETED', inputTokens: 320, outputTokens: 80 },
      usage: { calls: 1, spentUsd: 0.00008, reservedUsd: 0 },
    });
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(fake.sent).toHaveLength(0);
    expect(db.select().from(signals).all()).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test.each(['ACCEPT', 'MODIFY'] as const)(
  'audits one AI %s, finalizes the priced plan and sends it',
  async (decision) => {
    migrateDatabase(db);
    const levelAdjustment =
      decision === 'MODIFY'
        ? ({
            stopPrice: '99.02',
            takeProfits: [
              {
                targetPrice: '104.02',
                closePct: 60,
                management: 'FIXED',
                trailPolicy: 'NONE',
              },
              {
                targetPrice: '106.02',
                closePct: 40,
                management: 'TRAIL_AFTER_TRIGGER',
                trailPolicy: 'BREAKEVEN_AFTER_TP1',
              },
            ],
          } as const)
        : null;
    const reviewer = vi.fn<ReviewProvider>(async (request) => {
      expect(request).toMatchObject({
        model: 'gpt-6-luna',
        store: false,
        max_output_tokens: 1024,
        text: {
          format: {
            type: 'json_schema',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
            },
          },
        },
      });
      expect(request.input).not.toContain(token);
      expect(request.input).not.toContain(aiKey);
      return reviewResponse({
        decision,
        levelAdjustment: levelAdjustment
          ? {
              ...levelAdjustment,
              takeProfits: [...levelAdjustment.takeProfits],
            }
          : null,
      });
    });
    const { queue, fake, market } = await paired(
      marketFixture(),
      aiConfig(),
      fakeTelegram(),
      reviewer,
    );
    const id = market.candidate();
    await Promise.all([queue.tickSignals(), queue.tickSignals()]);
    market.candidate();
    await queue.tickSignals();
    await queue.tickOutbox();
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(signalDetail(db, id)).toMatchObject({
      signalMode: 'AI_REVIEW',
      aiDecision: decision,
      aiReview: {
        status: 'COMPLETED',
        result: { decision },
        inputTokens: 320,
        outputTokens: 80,
        costUsd: 0.00008,
        requestSummary: { direction: 'LONG', market: { symbol: 'FIXUSDT' } },
      },
      finalRisk: {
        outcome: 'PASSED',
        levels: {
          entry: '100.02',
          stop: decision === 'ACCEPT' ? '98.02' : '99.02',
          weightedRR: decision === 'ACCEPT' ? '2.25' : '2.4',
        },
      },
      delivery: { status: 'SENT', telegramMessageId: '17' },
    });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.text).toContain('[AI 审核通过]');
    expect(fake.sent[0]?.text).toContain(decision);
    if (decision === 'MODIFY')
      expect(fake.sent[0]?.text).toContain('TP1 后移至保本');
    expect(queue.ai.usage()).toMatchObject({ calls: 1, reservedUsd: 0 });
  },
);

test.each([
  ['reject', 'AI_REJECTED'],
  ['low confidence', 'AI_LOW_CONFIDENCE'],
  ['bad output', 'AI_INVALID_OUTPUT'],
  ['refusal', 'AI_MODEL_REFUSAL'],
  ['incomplete', 'AI_INCOMPLETE'],
  ['timeout', 'AI_TIMEOUT'],
  ['budget', 'AI_BUDGET_EXHAUSTED'],
  ['weak R:R', 'REJECT_LOW_RR'],
  ['invalid price', 'REJECT_INVALID_TARGET'],
  ['market drift', 'REJECT_PRICE_DRIFT'],
] as const)(
  'closes the notification path on %s',
  async (failure, reasonCode) => {
    migrateDatabase(db);
    const market = marketFixture();
    const reviewer = vi.fn<ReviewProvider>(async () => {
      switch (failure) {
        case 'reject':
          return reviewResponse({
            decision: 'REJECT',
            rejectReason: '样本风险过高',
          });
        case 'low confidence':
          return reviewResponse({ confidenceScore: 69 });
        case 'bad output':
          return { ...reviewResponse(), output_text: '{broken' };
        case 'refusal':
          return {
            ...reviewResponse(),
            output: [{ type: 'message', content: [{ type: 'refusal' }] }],
          };
        case 'incomplete':
          return { ...reviewResponse(), status: 'incomplete' };
        case 'timeout':
          throw Object.assign(new Error('fixture transport'), {
            name: 'APIConnectionTimeoutError',
          });
        case 'invalid price':
        case 'weak R:R':
          return reviewResponse({
            decision: 'MODIFY',
            levelAdjustment: {
              stopPrice: null,
              takeProfits: [
                {
                  targetPrice: failure === 'weak R:R' ? '100.42' : '105.025',
                  closePct: 100,
                  management: 'FIXED',
                  trailPolicy: 'NONE',
                },
              ],
            },
          });
        case 'market drift': {
          const quote = market.data.strategyMarket().quote;
          market.overrideQuote({
            ...quote,
            bid: { ...quote.bid, value: '103.04' },
            ask: { ...quote.ask, value: '103.06' },
          });
          return reviewResponse();
        }
        default:
          throw new Error('unexpected provider call');
      }
    });
    const { queue, fake } = await paired(
      market,
      aiConfig(failure === 'budget' ? '0' : '1'),
      fakeTelegram(),
      reviewer,
    );
    const id = market.candidate();
    await queue.tickSignals();
    await queue.tickOutbox();
    expect(signalDetail(db, id)).toMatchObject({
      deliveryPending: false,
      finalRisk: { outcome: 'REJECTED', reasonCode },
      signalId: null,
      aiReview: { model: 'gpt-6-luna' },
    });
    expect(fake.sent).toHaveLength(0);
    expect(reviewer).toHaveBeenCalledTimes(failure === 'budget' ? 0 : 1);
  },
);

test('keeps an interrupted AI reservation on restart and does not repeat the paid review', async () => {
  migrateDatabase(db);
  const reviewer = vi.fn<ReviewProvider>(async () => reviewResponse());
  const { queue, market, fake, settings } = await paired(
    marketFixture(),
    aiConfig(),
    fakeTelegram(),
    reviewer,
  );
  const id = market.candidate();
  const current = queue.ai.current();
  db.insert(aiReviews)
    .values({
      id: randomUUID(),
      candidateId: id,
      pairingId: queue.telegram.current().pairing!.id,
      model: current.model,
      promptVersion: 'market-sentinel-review-v1',
      settingsRevision: current.revision,
      confidenceThreshold: 70,
      status: 'RUNNING',
      requestSummary: {},
      day: '2026-11-24',
      reservedMicros: 500,
      createdAtMs: clock,
      startedAtMs: clock,
    })
    .run();
  const restarted = createNotifications(
    db,
    settings,
    market.data,
    () => undefined,
    {
      fetchTelegram: fake.transport,
      reviewOpenAI: reviewer,
    },
  );
  await restarted.tickSignals();
  await restarted.tickOutbox();
  expect(signalDetail(db, id)).toMatchObject({
    finalRisk: { reasonCode: 'AI_REVIEW_INTERRUPTED' },
    aiReview: { status: 'FAILED', reservedUsd: 0.0005, costUsd: null },
  });
  expect(reviewer).not.toHaveBeenCalled();
  expect(fake.sent).toHaveLength(0);
});

test('reuses a finished AI audit when final approval and enqueue must be retried', async () => {
  migrateDatabase(db);
  const reviewer = vi.fn<ReviewProvider>(async () => reviewResponse());
  const { queue, market, fake, settings } = await paired(
    marketFixture(),
    aiConfig(),
    fakeTelegram(),
    reviewer,
  );
  const id = market.candidate();
  db.$client.exec(
    "CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox_messages BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END",
  );
  await expect(queue.tickSignals()).rejects.toThrow(
    'insert into "outbox_messages"',
  );
  expect(signalDetail(db, id)).toMatchObject({
    deliveryPending: true,
    finalRisk: null,
    aiReview: { status: 'COMPLETED' },
  });
  db.$client.exec('DROP TRIGGER fail_outbox');
  const restarted = createNotifications(
    db,
    settings,
    market.data,
    () => undefined,
    {
      fetchTelegram: fake.transport,
      reviewOpenAI: reviewer,
    },
  );
  await restarted.tickSignals();
  await restarted.tickOutbox();
  expect(reviewer).toHaveBeenCalledTimes(1);
  expect(signalDetail(db, id)?.delivery?.status).toBe('SENT');
});

test('reserves an in-flight review before a concurrent test can use the same daily budget', async () => {
  migrateDatabase(db);
  const response = Promise.withResolvers<unknown>();
  const reviewer = vi
    .fn<ReviewProvider>(async () => reviewResponse())
    .mockImplementationOnce(() => response.promise);
  const { queue, market } = await paired(
    marketFixture(),
    aiConfig('0.0015'),
    fakeTelegram(),
    reviewer,
  );
  market.candidate();
  const pending = queue.tickSignals();
  try {
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(queue.ai.usage().reservedUsd).toBeGreaterThan(0);
    const result = await queue.testAi(actor);
    expect(result.lastTest?.reasonCode).toBe('AI_BUDGET_EXHAUSTED');
    expect(reviewer).toHaveBeenCalledTimes(1);
  } finally {
    response.resolve(reviewResponse());
    await pending;
  }
  expect(queue.ai.usage()).toMatchObject({
    calls: 1,
    reservedUsd: 0,
    spentUsd: 0.00008,
  });
});
