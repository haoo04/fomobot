import { sql } from 'drizzle-orm';
import { EXCHANGES, MARKET_TYPES, TIMEFRAMES } from '@market-sentinel/domain';
import type { MarketCapabilities, Timeframe } from '@market-sentinel/domain';
import type { MarketQuote } from '@market-sentinel/contracts/markets';
import {
  check,
  index,
  integer,
  primaryKey,
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
