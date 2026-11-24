import { EXCHANGES, MARKET_TYPES, TIMEFRAMES } from '@market-sentinel/domain';
import { z } from 'zod';
import {
  aiUsageSchema,
  notificationDiagnosticsSchema,
} from './notifications.js';
import {
  marketCapabilitiesSchema,
  marketIdentitySchema,
  timeframeSchema,
} from './index.js';
import { monitorStrategySchema, strategyPatchSchema } from './strategies.js';

export { timeframeSchema } from './index.js';

export const marketQuerySchema = z.strictObject({
  exchange: z.enum(EXCHANGES).optional(),
  type: z.enum(MARKET_TYPES).optional(),
  q: z.string().trim().max(100).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const marketStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'UNLISTED']);
export const marketSchema = marketIdentitySchema.extend({
  id: z.uuid(),
  status: marketStatusSchema,
  exchangeStatus: z.string(),
  stale: z.boolean(),
  isReality: z.boolean(),
  isRwa: z.boolean().nullable(),
  instrumentType: z.string().nullable(),
  collateralAsset: z.string().nullable(),
  pricePrecision: z.number().int().nonnegative().nullable(),
  tickSize: z.string().nullable(),
  capabilities: marketCapabilitiesSchema,
  intervalRestrictions: z.partialRecord(timeframeSchema, z.string()),
});

const marketPeriods = {
  trigger: timeframeSchema,
  confirm: timeframeSchema,
  trend: timeframeSchema,
  extra: z.array(timeframeSchema).max(TIMEFRAMES.length),
};

export const monitorCreateSchema = z.strictObject({
  marketId: z.uuid(),
  trigger: marketPeriods.trigger.default('3m'),
  confirm: marketPeriods.confirm.default('5m'),
  trend: marketPeriods.trend.default('1h'),
  extra: marketPeriods.extra.default([]),
  enabled: z.boolean().default(true),
});

export const monitorPatchSchema = z
  .strictObject({
    ...marketPeriods,
    enabled: z.boolean(),
    strategy: strategyPatchSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0);

export const monitorBatchSchema = z.strictObject({
  ids: z
    .array(z.uuid())
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length),
  enabled: z.boolean(),
});

const timestamp = z.number().int().nonnegative();
const candleSchema = z.object({
  marketId: z.uuid(),
  timeframe: timeframeSchema,
  openTimeMs: timestamp,
  closeTimeMs: timestamp,
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  baseVolume: z.string().nullable(),
  quoteTurnover: z.string().nullable(),
  isClosed: z.boolean(),
  source: z.enum(['WS', 'REST', 'AGGREGATED']),
  qualityFlags: z.array(z.string()),
});

const timedPriceSchema = z.object({
  value: z.string(),
  timestampMs: timestamp,
  source: z.enum(['REST', 'WS']),
});

export const marketQuoteSchema = z.object({
  last: timedPriceSchema.nullable(),
  mark: timedPriceSchema.nullable(),
  bid: timedPriceSchema.nullable(),
  ask: timedPriceSchema.nullable(),
  spread: timedPriceSchema.nullable(),
});

const oiSnapshotSchema = z.object({
  marketId: z.uuid(),
  timestampMs: timestamp,
  value: z.string(),
  unit: z.enum(['BASE_ASSET', 'CONTRACTS', 'USD_NOTIONAL', 'OTHER']),
  unitDetails: z.string(),
  source: z.enum(['REST', 'WS']),
  qualityFlags: z.array(z.string()),
  series: z.string(),
});

const monitoredPeriodSchema = z.object({
  timeframe: timeframeSchema,
  state: z.enum([
    'PAUSED',
    'WARMING',
    'ACTIVE',
    'RECOVERING',
    'DEGRADED',
    'UNAVAILABLE',
  ]),
  reason: z.string().nullable(),
  validCandles: z.number().int().nonnegative(),
  missingRecent: z.number().int().nonnegative(),
  lastClosed: candleSchema.nullable(),
  preview: candleSchema.nullable(),
});

export const monitorSchema = z.object({
  id: z.uuid(),
  market: marketSchema,
  enabled: z.boolean(),
  ...marketPeriods,
  strategy: monitorStrategySchema,
  periods: z.array(monitoredPeriodSchema),
  quote: marketQuoteSchema.nullable(),
  openInterest: z.object({
    state: z.enum(['N/A', 'MISSING', 'FRESH', 'STALE']),
    latest: oiSnapshotSchema.nullable(),
  }),
});

const providerDiagnosticsSchema = z.object({
  exchange: z.enum(EXCHANGES),
  connection: z.enum(['IDLE', 'CONNECTING', 'CONNECTED', 'RECONNECTING']),
  subscriptions: z.number().int().nonnegative(),
  reconnects: z.number().int().nonnegative(),
  lastMessageAtMs: timestamp.nullable(),
  lastRestAtMs: timestamp.nullable(),
  lastRestLatencyMs: z.number().nonnegative().nullable(),
  lastRestError: z.string().nullable(),
  lastSocketError: z.string().nullable(),
  catalog: z.object({
    lastSyncAtMs: timestamp.nullable(),
    failedPartitions: z.array(z.string()),
  }),
});

const response = <T extends z.ZodType>(data: T) =>
  z.object({ requestId: z.string(), data });

export const marketListResponseSchema = response(
  z.object({
    items: z.array(marketSchema),
    nextOffset: z.number().int().nonnegative().nullable(),
  }),
);
export const marketResponseSchema = response(marketSchema);
export const monitorsResponseSchema = response(z.array(monitorSchema));
export const monitorResponseSchema = response(monitorSchema);
export const diagnosticsResponseSchema = response(
  z.object({
    syncing: z.boolean(),
    timeZone: z.string(),
    providers: z.array(providerDiagnosticsSchema),
    notifications: notificationDiagnosticsSchema,
    ai: aiUsageSchema,
  }),
);
export const syncResponseSchema = response(z.object({ syncing: z.boolean() }));

export type Market = z.infer<typeof marketSchema>;
export type MarketQuote = z.infer<typeof marketQuoteSchema>;
export type Monitor = z.infer<typeof monitorSchema>;
export type MonitorConfig = z.infer<typeof monitorCreateSchema>;
export type ProviderDiagnostics = z.infer<typeof providerDiagnosticsSchema>;
