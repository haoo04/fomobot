import { EXCHANGES, MARKET_TYPES, TIMEFRAMES } from '@market-sentinel/domain';
import type {
  MarketCapabilities,
  MarketIdentity,
} from '@market-sentinel/domain';
import { z } from 'zod';

export const timeframeSchema = z.enum(TIMEFRAMES);

export const marketIdentitySchema = z.strictObject({
  exchange: z.enum(EXCHANGES),
  marketType: z.enum(MARKET_TYPES),
  productType: z.string().min(1),
  venue: z.string().min(1),
  nativeSymbol: z.string().min(1),
  baseAsset: z.string().min(1),
  quoteAsset: z.string().min(1).nullable(),
}) satisfies z.ZodType<MarketIdentity>;

export const marketCapabilitiesSchema = z.strictObject({
  intervals: z.array(timeframeSchema),
  hasOpenInterest: z.boolean(),
  hasOrderBook: z.boolean(),
  hasFundingRate: z.boolean(),
  supportsReadOnlyPositions: z.boolean(),
  hasReliableBaseVolume: z.boolean(),
  sessionType: z.enum(['CONTINUOUS', 'RWA_WITH_REFERENCE_SESSION', 'UNKNOWN']),
  restrictions: z.array(z.string()),
}) satisfies z.ZodType<MarketCapabilities>;

export const apiErrorResponseSchema = z.object({
  requestId: z.string(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z
      .array(z.object({ field: z.string(), code: z.string() }))
      .optional(),
  }),
});

export const loginRequestSchema = z.strictObject({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});

export const authSessionResponseSchema = z.object({
  requestId: z.string(),
  data: z.object({ username: z.string() }),
});

export const livenessResponseSchema = z.object({
  requestId: z.string(),
  status: z.literal('ok'),
});

export const readinessResponseSchema = livenessResponseSchema.extend({
  checks: z.object({ database: z.literal('ok') }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
