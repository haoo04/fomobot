import { sql } from 'drizzle-orm';
import { EXCHANGES, MARKET_TYPES, TIMEFRAMES } from '@market-sentinel/domain';
import type { MarketCapabilities, Timeframe } from '@market-sentinel/domain';
import type { MarketQuote } from '@market-sentinel/contracts/markets';
import type {
  AiModel,
  AiReviewResult,
} from '@market-sentinel/contracts/notifications';
import type {
  CandidateDirection,
  CandidateReview,
  RiskLevels,
  StrategyParameters,
  StrategyTimeframes,
  TheoryEvent,
  TheoryState,
} from '@market-sentinel/contracts/strategies';
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const administrators = sqliteTable(
  'administrators',
  {
    id: integer('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [check('administrators_singleton', sql`${table.id} = 1`)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').notNull(),
    administratorId: integer('administrator_id')
      .notNull()
      .references(() => administrators.id, { onDelete: 'cascade' }),
    expiresAtMs: integer('expires_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tokenHash] }),
    index('sessions_expiration').on(table.expiresAtMs),
  ],
);

export const secretStore = sqliteTable(
  'secret_store',
  {
    id: text('id').notNull(),
    cipherText: text('cipher_text').notNull(),
    nonce: text('nonce').notNull(),
    authTag: text('auth_tag').notNull(),
    algorithm: text('algorithm').notNull(),
    keyVersion: integer('key_version').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] })],
);

export const auditLogs = sqliteTable('audit_logs', {
  id: integer('id').primaryKey(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
});

export const markets = sqliteTable(
  'markets',
  {
    id: text('id').notNull(),
    exchange: text('exchange', { enum: EXCHANGES }).notNull(),
    marketType: text('market_type', { enum: MARKET_TYPES }).notNull(),
    productType: text('product_type').notNull(),
    venue: text('venue').notNull(),
    nativeSymbol: text('native_symbol').notNull(),
    baseAsset: text('base_asset').notNull(),
    quoteAsset: text('quote_asset'),
    collateralAsset: text('collateral_asset'),
    instrumentType: text('instrument_type'),
    status: text('status', {
      enum: ['ACTIVE', 'INACTIVE', 'UNLISTED'],
    }).notNull(),
    exchangeStatus: text('exchange_status').notNull(),
    stale: integer('stale', { mode: 'boolean' }).notNull(),
    isReality: integer('is_reality', { mode: 'boolean' }).notNull(),
    isRwa: integer('is_rwa', { mode: 'boolean' }),
    pricePrecision: integer('price_precision'),
    tickSize: text('tick_size'),
    capabilities: text('capabilities_json', { mode: 'json' })
      .$type<MarketCapabilities>()
      .notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('markets_identity').on(
      table.exchange,
      table.marketType,
      table.productType,
      table.venue,
      table.nativeSymbol,
    ),
  ],
);

export const strategyConfigVersions = sqliteTable(
  'strategy_config_versions',
  {
    id: text('id').primaryKey(),
    strategyId: text('strategy_id').notNull(),
    strategyVersion: text('strategy_version').notNull(),
    algorithmVersion: text('algorithm_version').notNull(),
    configHash: text('config_hash').notNull(),
    params: text('params_json', { mode: 'json' })
      .$type<StrategyParameters>()
      .notNull(),
    timeframes: text('timeframes_json', { mode: 'json' })
      .$type<StrategyTimeframes>()
      .notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [uniqueIndex('strategy_configs_hash').on(table.configHash)],
);

export const monitorConfigs = sqliteTable(
  'monitor_configs',
  {
    id: text('id').notNull(),
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id),
    trigger: text('trigger_tf', { enum: TIMEFRAMES }).notNull(),
    confirm: text('confirm_tf', { enum: TIMEFRAMES }).notNull(),
    trend: text('trend_tf', { enum: TIMEFRAMES }).notNull(),
    extra: text('extra_json', { mode: 'json' }).$type<Timeframe[]>().notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    strategyEnabled: integer('strategy_enabled', { mode: 'boolean' })
      .notNull()
      .default(true),
    strategyConfigVersionId: text('strategy_config_version_id').references(
      () => strategyConfigVersions.id,
    ),
    strategyAfterMs: integer('strategy_after_ms').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    uniqueIndex('monitors_market').on(table.marketId),
  ],
);

export const candles = sqliteTable(
  'candles',
  {
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id),
    timeframe: text('timeframe', { enum: TIMEFRAMES }).notNull(),
    openTimeMs: integer('open_time_ms').notNull(),
    closeTimeMs: integer('close_time_ms').notNull(),
    open: text('open').notNull(),
    high: text('high').notNull(),
    low: text('low').notNull(),
    close: text('close').notNull(),
    baseVolume: text('base_volume'),
    quoteTurnover: text('quote_turnover'),
    isClosed: integer('is_closed', { mode: 'boolean' }).notNull(),
    source: text('source', { enum: ['WS', 'REST', 'AGGREGATED'] }).notNull(),
    qualityFlags: text('quality_json', { mode: 'json' })
      .$type<string[]>()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.marketId, table.timeframe, table.openTimeMs],
    }),
    check('candles_closed', sql`${table.isClosed} = 1`),
  ],
);

export const oiSnapshots = sqliteTable(
  'oi_snapshots',
  {
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id),
    timestampMs: integer('time_ms').notNull(),
    series: text('series').notNull(),
    value: text('value').notNull(),
    unit: text('unit', {
      enum: ['BASE_ASSET', 'CONTRACTS', 'USD_NOTIONAL', 'OTHER'],
    }).notNull(),
    unitDetails: text('unit_details').notNull(),
    source: text('source', { enum: ['REST', 'WS'] }).notNull(),
    qualityFlags: text('quality_json', { mode: 'json' })
      .$type<string[]>()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.marketId, table.timestampMs, table.series] }),
  ],
);

export const quotes = sqliteTable(
  'quotes',
  {
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id),
    quote: text('quote_json', { mode: 'json' }).$type<MarketQuote>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.marketId] })],
);

export const signalCandidates = sqliteTable(
  'signal_candidates',
  {
    id: text('id').primaryKey(),
    idempotencyKey: text('idempotency_key').notNull(),
    marketId: text('market_id')
      .notNull()
      .references(() => markets.id),
    configVersionId: text('strategy_config_version_id')
      .notNull()
      .references(() => strategyConfigVersions.id),
    triggerTimeframe: text('trigger_tf', { enum: TIMEFRAMES }).notNull(),
    triggerOpenMs: integer('trigger_open_ms').notNull(),
    triggerCloseMs: integer('trigger_close_ms').notNull(),
    direction: text('direction').$type<CandidateDirection>().notNull(),
    evaluatedAtMs: integer('evaluated_at_ms').notNull(),
    evidence: text('evidence_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    deliveryPending: integer('delivery_pending', { mode: 'boolean' })
      .notNull()
      .default(false),
  },
  (table) => [
    uniqueIndex('candidates_idempotency').on(table.idempotencyKey),
    index('candidates_market_trigger').on(
      table.marketId,
      table.triggerTimeframe,
      table.triggerCloseMs,
    ),
    index('candidates_recent').on(table.evaluatedAtMs, table.id),
    index('candidates_delivery_pending')
      .on(table.triggerCloseMs)
      .where(sql`${table.deliveryPending} = 1`),
  ],
);

export const riskEvaluations = sqliteTable(
  'risk_evaluations',
  {
    candidateId: text('candidate_id')
      .notNull()
      .references(() => signalCandidates.id),
    stage: text('stage', { enum: ['PRE', 'FINAL'] }).notNull(),
    outcome: text('outcome').$type<CandidateReview['outcome']>().notNull(),
    reasonCode: text('reason_code'),
    levels: text('levels_json', { mode: 'json' }).$type<RiskLevels>(),
    atMs: integer('evaluated_at_ms'),
    quote: text('quote_json', { mode: 'json' }).$type<MarketQuote>(),
  },
  (table) => [primaryKey({ columns: [table.candidateId, table.stage] })],
);

export const telegramSettings = sqliteTable(
  'telegram_settings',
  {
    id: integer('id').primaryKey(),
    tokenRef: text('token_ref').references(() => secretStore.id),
    botFingerprint: text('bot_fingerprint'),
    botUsername: text('bot_username'),
    pairingId: text('pairing_id'),
    chatId: text('chat_id'),
    codeHash: text('code_hash'),
    codeExpiresAtMs: integer('code_expires_at_ms'),
    updateOffset: integer('update_offset'),
    pairingError: text('pairing_error'),
    marketDailyLimit: integer('market_daily_limit').notNull().default(8),
    globalDailyLimit: integer('global_daily_limit').notNull().default(30),
    signalUpdatesEnabled: integer('signal_updates_enabled', { mode: 'boolean' })
      .notNull()
      .default(true),
  },
  (table) => [check('telegram_singleton', sql`${table.id} = 1`)],
);

export const signals = sqliteTable('signals', {
  id: text('id').primaryKey(),
  candidateId: text('candidate_id')
    .notNull()
    .unique()
    .references(() => signalCandidates.id),
  levels: text('levels_json', { mode: 'json' }).$type<RiskLevels>().notNull(),
  approvedAtMs: integer('approved_at_ms').notNull(),
  expiresAtMs: integer('expires_at_ms').notNull(),
  mode: text('mode', { enum: ['RULE_ONLY', 'AI_REVIEW'] })
    .notNull()
    .default('RULE_ONLY'),
  aiRevision: text('ai_revision'),
});

export interface TheoryProgress {
  stops: (string | null)[];
  realizedR: string;
  atr: number | null;
  previousClose: string | null;
  targetsHit: number[];
  stopHit: boolean;
}

export const signalOutcomes = sqliteTable(
  'signal_outcomes',
  {
    signalId: text('signal_id')
      .primaryKey()
      .references(() => signals.id, { onDelete: 'cascade' }),
    state: text('state').$type<TheoryState>().notNull().default('ACTIVE'),
    startAtMs: integer('start_at_ms').notNull(),
    deadlineAtMs: integer('deadline_at_ms').notNull(),
    nextOpenMs: integer('next_open_ms').notNull(),
    finishedAtMs: integer('finished_at_ms'),
    observedBars: integer('observed_bars').notNull().default(0),
    waitingForData: integer('waiting_for_data', { mode: 'boolean' })
      .notNull()
      .default(false),
    grossR: text('gross_r'),
    reasonCode: text('reason_code'),
    silentBeforeMs: integer('silent_before_ms').notNull(),
    progress: text('progress_json', { mode: 'json' })
      .$type<TheoryProgress>()
      .notNull(),
  },
  (table) => [
    index('signal_outcomes_open')
      .on(table.nextOpenMs)
      .where(sql`${table.finishedAtMs} is null`),
    index('signal_outcomes_state').on(table.state),
  ],
);

export const signalEvents = sqliteTable(
  'signal_events',
  {
    id: integer('id').primaryKey(),
    signalId: text('signal_id')
      .notNull()
      .references(() => signals.id, { onDelete: 'cascade' }),
    type: text('event_type').$type<TheoryEvent['type']>().notNull(),
    atMs: integer('event_time_ms').notNull(),
    target: integer('target'),
    price: text('price'),
    closePct: real('close_pct'),
    ambiguousIntrabar: integer('ambiguous_intrabar', { mode: 'boolean' })
      .notNull()
      .default(false),
    reasonCode: text('reason_code'),
    candle: text('candle_json', { mode: 'json' }).$type<
      TheoryEvent['candle']
    >(),
  },
  (table) => [
    index('signal_events_signal_time').on(table.signalId, table.atMs),
  ],
);

export const outboxMessages = sqliteTable(
  'outbox_messages',
  {
    id: text('id').primaryKey(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    signalId: text('signal_id').references(() => signals.id),
    kind: text('kind', {
      enum: ['TRADE_SIGNAL', 'TELEGRAM_TEST', 'SIGNAL_UPDATE', 'SYSTEM_ALERT'],
    })
      .notNull()
      .default('TRADE_SIGNAL'),
    pairingId: text('pairing_id').notNull(),
    chatId: text('chat_id').notNull(),
    body: text('body').notNull(),
    manual: integer('manual', { mode: 'boolean' }).notNull().default(false),
    status: text('status', {
      enum: ['PENDING', 'SENDING', 'SENT', 'FAILED', 'DELIVERY_UNKNOWN'],
    })
      .notNull()
      .default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptMs: integer('next_attempt_ms').notNull(),
    expiresAtMs: integer('expires_at_ms').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    sendDay: text('send_day'),
    sentAtMs: integer('sent_at_ms'),
    telegramMessageId: text('telegram_message_id'),
    lastError: text('last_error'),
  },
  (table) => [
    index('outbox_due').on(table.status, table.nextAttemptMs),
    index('outbox_signal').on(table.signalId),
    index('outbox_send_day').on(table.sendDay),
  ],
);

export const aiSettings = sqliteTable(
  'ai_settings',
  {
    id: integer('id').primaryKey(),
    keyRef: text('key_ref').references(() => secretStore.id),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    model: text('model').$type<AiModel>().notNull(),
    confidenceThreshold: integer('confidence_threshold').notNull(),
    dailyBudgetMicros: integer('daily_budget_micros').notNull(),
    timeoutMs: integer('timeout_ms').notNull(),
    maxOutputTokens: integer('max_output_tokens').notNull(),
    revision: text('revision').notNull(),
  },
  (table) => [check('ai_singleton', sql`${table.id} = 1`)],
);

export const aiReviews = sqliteTable(
  'ai_reviews',
  {
    id: text('id').primaryKey(),
    candidateId: text('candidate_id')
      .unique()
      .references(() => signalCandidates.id),
    pairingId: text('pairing_id'),
    model: text('model').$type<AiModel>().notNull(),
    reportedModel: text('reported_model'),
    promptVersion: text('prompt_version').notNull(),
    settingsRevision: text('settings_revision').notNull(),
    confidenceThreshold: integer('confidence_threshold').notNull(),
    status: text('status', {
      enum: ['RUNNING', 'COMPLETED', 'FAILED'],
    }).notNull(),
    requestSummary: text('request_summary_json', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull(),
    result: text('result_json', { mode: 'json' }).$type<AiReviewResult>(),
    reasonCode: text('reason_code'),
    day: text('day').notNull(),
    reservedMicros: integer('reserved_micros').notNull(),
    costMicros: integer('cost_micros'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAtMs: integer('created_at_ms').notNull(),
    startedAtMs: integer('started_at_ms'),
    completedAtMs: integer('completed_at_ms'),
  },
  (table) => [index('ai_reviews_day').on(table.day)],
);
