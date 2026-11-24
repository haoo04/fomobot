import { EXCHANGES, MARKET_TYPES } from '@market-sentinel/domain';
import { z } from 'zod';
import { timeframeSchema } from './index.js';
import {
  aiReviewAuditSchema,
  aiReviewStatusSchema,
  deliverySchema,
  deliveryStatusSchema,
  trailPolicySchema,
} from './notifications.js';

const percent = z.number().min(0).max(100);
const periods = z.number().int().min(1);
const positive = z.number().positive();
const priceText = z.string().regex(/^\d+(\.\d+)?$/);
const positivePriceText = priceText
  .max(100)
  .refine((value) => /[1-9]/.test(value));
const takeProfitSchema = z.strictObject({
  rMultiple: positive,
  closePct: percent.min(0.01).multipleOf(0.01),
});

export const strategyParametersSchema = z
  .strictObject({
    emaPeriods: z.tuple([periods.max(500), periods.max(500), periods.max(500)]),
    rsi: z.strictObject({
      period: periods.max(498),
      longMin: percent,
      longMax: percent,
      shortMin: percent,
      shortMax: percent,
    }),
    volume: z.strictObject({
      lookback: periods.max(499),
      relativeMin: positive,
    }),
    oi: z
      .strictObject({
        lookbackMinutes: periods.max(1440),
        minIncreasePct: z.number().nonnegative(),
        maxAgeSeconds: periods.max(3600),
      })
      .nullable(),
    atr: z.strictObject({ period: periods.max(499), stopMultiplier: positive }),
    breakPreviousCandle: z.boolean(),
    risk: z.strictObject({
      minWeightedRR: positive,
      maxEntryDriftAtr: positive,
      swingLookback: periods.max(500),
      takeProfits: z.array(takeProfitSchema).min(1).max(4),
      cooldownMinutes: z.number().int().nonnegative().max(1440),
      maxAgeSeconds: periods.max(3600),
      maxSpreadBps: positive.max(20_000).nullable(),
      minTurnover: positivePriceText.nullable(),
      minStopPct: positive.nullable(),
      maxStopPct: positive.nullable(),
      maxAtrPct: positive.nullable(),
    }),
  })
  .superRefine(({ emaPeriods: [fast, medium, slow], rsi, risk }, context) => {
    if (fast >= medium || medium >= slow)
      context.addIssue({
        code: 'custom',
        path: ['emaPeriods'],
        message: 'EMA 周期必须从短到长。',
      });
    if (rsi.longMin > rsi.longMax || rsi.shortMin > rsi.shortMax)
      context.addIssue({
        code: 'custom',
        path: ['rsi'],
        message: 'RSI 下限不能大于上限。',
      });
    const { takeProfits, minStopPct, maxStopPct } = risk;
    if (
      takeProfits.reduce(
        (sum, target) => sum + Math.round(target.closePct * 100),
        0,
      ) !== 10_000 ||
      takeProfits.some(
        (target, i) =>
          i > 0 && target.rMultiple <= takeProfits[i - 1]!.rMultiple,
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['risk', 'takeProfits'],
        message: '止盈倍数须递增，分仓比例合计须为 100%。',
      });
    if (minStopPct !== null && maxStopPct !== null && minStopPct > maxStopPct)
      context.addIssue({
        code: 'custom',
        path: ['risk', 'maxStopPct'],
        message: '止损距离下限不能大于上限。',
      });
  });

export const strategyPatchSchema = z.strictObject({
  enabled: z.boolean(),
  params: strategyParametersSchema,
});

const timeframesSchema = z.object({
  trigger: timeframeSchema,
  confirm: timeframeSchema,
  trend: timeframeSchema,
});
const timestamp = z.number().int().nonnegative();
const versionSchema = z.object({
  strategyId: z.string(),
  strategyVersion: z.string(),
  algorithmVersion: z.string(),
});
const outcomeSchema = z.enum([
  'PASSED',
  'REJECTED',
  'SUPPRESSED',
  'WATCH_ONLY',
]);
const evaluationSchema = z.object({
  atMs: timestamp,
  triggerCloseMs: timestamp,
  outcome: z.enum(['WAITING', 'NO_TRADE', ...outcomeSchema.options]),
  reasonCode: z.string().nullable(),
});

export const monitorStrategySchema = versionSchema.extend({
  enabled: z.boolean(),
  versionId: z.uuid().nullable(),
  params: strategyParametersSchema,
  latest: evaluationSchema.nullable(),
});

export const theoryStateSchema = z.enum([
  'ACTIVE',
  'TP1_HIT',
  'TP2_HIT',
  'TP3_HIT',
  'TP4_HIT',
  'SL_HIT',
  'EXPIRED',
  'INVALIDATED',
]);

const signalFiltersSchema = z.strictObject({
  marketId: z.uuid().optional(),
  state: outcomeSchema.optional(),
  q: z.string().trim().min(1).max(128).optional(),
  exchange: z.enum(EXCHANGES).optional(),
  strategyId: z.string().trim().min(1).max(100).optional(),
  finalState: outcomeSchema.optional(),
  deliveryState: deliveryStatusSchema.optional(),
  theoryState: theoryStateSchema.optional(),
  fromMs: z.coerce.number().int().nonnegative().optional(),
  toMs: z.coerce.number().int().nonnegative().optional(),
});
const validRange = ({ fromMs, toMs }: z.infer<typeof signalFiltersSchema>) =>
  fromMs === undefined || toMs === undefined || fromMs < toMs;
const rangeIssue = { path: ['toMs'], message: '结束时间须晚于开始时间。' };
export const signalSummaryQuerySchema = signalFiltersSchema.refine(
  validRange,
  rangeIssue,
);
export const signalExportQuerySchema = signalFiltersSchema
  .extend({ format: z.enum(['csv', 'json']) })
  .refine(validRange, rangeIssue);
export const signalQuerySchema = signalFiltersSchema
  .extend({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine(validRange, rangeIssue);

const reviewSchema = z.object({
  outcome: outcomeSchema,
  reasonCode: z.string().nullable(),
});
const theorySummarySchema = z.object({
  state: theoryStateSchema,
  startAtMs: timestamp,
  deadlineAtMs: timestamp,
  finishedAtMs: timestamp.nullable(),
  observedBars: z.number().int().min(0).max(20),
  waitingForData: z.boolean(),
  grossR: z.string().nullable(),
  reasonCode: z.string().nullable(),
});
const theoryCandleSchema = z.object({
  openTimeMs: timestamp,
  closeTimeMs: timestamp,
  open: priceText,
  high: priceText,
  low: priceText,
  close: priceText,
  source: z.enum(['WS', 'REST', 'AGGREGATED']),
});
const theoryEventSchema = z.object({
  id: z.number().int().positive(),
  type: z.enum(['CANDLE', 'TP', 'SL', 'STOP_MOVED', 'EXPIRED', 'INVALIDATED']),
  atMs: timestamp,
  target: z.number().int().min(1).max(4).nullable(),
  price: priceText.nullable(),
  closePct: percent.nullable(),
  ambiguousIntrabar: z.boolean(),
  reasonCode: z.string().nullable(),
  candle: theoryCandleSchema.nullable(),
});
const signalDeliverySchema = deliverySchema.extend({
  id: z.uuid(),
  body: z.string(),
  createdAtMs: timestamp,
});
const candidateSchema = versionSchema.extend({
  ...reviewSchema.shape,
  id: z.uuid(),
  marketId: z.uuid(),
  configVersionId: z.uuid(),
  exchange: z.enum(EXCHANGES),
  market: z.object({
    marketType: z.enum(MARKET_TYPES),
    productType: z.string(),
    venue: z.string(),
    nativeSymbol: z.string(),
  }),
  triggerTimeframe: timeframeSchema,
  triggerOpenMs: timestamp,
  triggerCloseMs: timestamp,
  evaluatedAtMs: timestamp,
  direction: z.enum(['LONG', 'SHORT', 'BEARISH_WATCH']),
  deliveryPending: z.boolean(),
  finalRisk: reviewSchema.nullable(),
  signalId: z.uuid().nullable(),
  signalMode: z.enum(['RULE_ONLY', 'AI_REVIEW']).nullable(),
  aiDecision: z.enum(['ACCEPT', 'REJECT', 'MODIFY']).nullable(),
  aiStatus: aiReviewStatusSchema.nullable(),
  delivery: deliverySchema.nullable(),
  theory: theorySummarySchema.nullable(),
});

const riskLevelsSchema = z.object({
  entry: priceText,
  stop: priceText,
  takeProfits: z.array(
    z.object({
      price: priceText,
      closePct: percent,
      trailPolicy: trailPolicySchema.optional(),
    }),
  ),
  weightedRR: priceText,
});

const response = <T extends z.ZodType>(data: T) =>
  z.object({ requestId: z.string(), data });

export const strategiesResponseSchema = response(
  z.object({
    templates: z.array(
      versionSchema.extend({
        marketType: z.enum(MARKET_TYPES),
        params: strategyParametersSchema,
      }),
    ),
    paramsSchema: z.record(z.string(), z.unknown()),
  }),
);
export const signalsResponseSchema = response(
  z.object({
    items: z.array(candidateSchema),
    nextOffset: z.number().int().nonnegative().nullable(),
  }),
);
export const signalSummaryResponseSchema = response(
  z.array(
    z.object({
      exchange: z.enum(EXCHANGES),
      strategyId: z.string(),
      candidates: timestamp,
      approved: timestamp,
      rejected: timestamp,
      sent: timestamp,
      longs: timestamp,
      shorts: timestamp,
      aiAccepted: timestamp,
      aiModified: timestamp,
      aiRejected: timestamp,
      targetHits: z.array(timestamp).length(4),
      stopHits: timestamp,
      insufficientData: timestamp,
      completed: timestamp,
      averageGrossR: z.number().nullable(),
    }),
  ),
);
export const signalResponseSchema = response(
  candidateSchema.extend({
    params: strategyParametersSchema,
    timeframes: timeframesSchema,
    configHash: z.string(),
    levels: riskLevelsSchema.nullable(),
    finalRisk: reviewSchema
      .extend({
        levels: riskLevelsSchema.nullable(),
        atMs: timestamp.nullable(),
        quote: z.record(z.string(), z.unknown()).nullable(),
      })
      .nullable(),
    deliveries: z.array(signalDeliverySchema),
    updates: z.array(signalDeliverySchema),
    canResend: z.boolean(),
    canDelete: z.boolean(),
    theoryEvents: z.array(theoryEventSchema),
    approvedAtMs: timestamp.nullable(),
    deliveryExpiresAtMs: timestamp.nullable(),
    aiReview: aiReviewAuditSchema
      .extend({
        requestSummary: z.record(z.string(), z.unknown()),
      })
      .nullable(),
    evidence: z.record(z.string(), z.unknown()),
  }),
);

export type StrategyParameters = z.infer<typeof strategyParametersSchema>;
export type StrategyPatch = z.infer<typeof strategyPatchSchema>;
export type StrategyTimeframes = z.infer<typeof timeframesSchema>;
export type MonitorStrategy = z.infer<typeof monitorStrategySchema>;
export type StrategyEvaluation = z.infer<typeof evaluationSchema>;
export type SignalQuery = z.infer<typeof signalQuerySchema>;
export type SignalFilters = z.infer<typeof signalSummaryQuerySchema>;
export type TheoryState = z.infer<typeof theoryStateSchema>;
export type TheoryEvent = z.infer<typeof theoryEventSchema>;
export type SignalDetail = z.infer<typeof signalResponseSchema>['data'];
export type CandidateDirection = z.infer<typeof candidateSchema>['direction'];
export type CandidateReview = z.infer<typeof reviewSchema>;
export type RiskLevels = z.infer<typeof riskLevelsSchema>;
