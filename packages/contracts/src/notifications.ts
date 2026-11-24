import { z } from 'zod';

const timestamp = z.number().int().nonnegative();
export const deliveryStatusSchema = z.enum([
  'PENDING',
  'SENDING',
  'SENT',
  'FAILED',
  'DELIVERY_UNKNOWN',
]);

export const deliverySchema = z.object({
  status: deliveryStatusSchema,
  manual: z.boolean(),
  attempts: z.number().int().nonnegative(),
  telegramMessageId: z.string().nullable(),
  sentAtMs: timestamp.nullable(),
  lastError: z.string().nullable(),
});

const dailyLimit = z.number().int().min(1).max(1000);
export const telegramSettingsPatchSchema = z.strictObject({
  botToken: z
    .string()
    .trim()
    .max(256)
    .regex(/^\d+:[\w-]+$/)
    .nullable()
    .optional(),
  marketDailyLimit: dailyLimit,
  globalDailyLimit: dailyLimit,
  signalUpdatesEnabled: z.boolean().optional(),
  systemAlertsEnabled: z.boolean().optional(),
});

const telegramSettingsSchema = telegramSettingsPatchSchema
  .omit({ botToken: true })
  .extend({
    tokenMask: z.string().nullable(),
    storedToken: z.boolean(),
    botUsername: z.string().nullable(),
    paired: z.boolean(),
    pairingExpiresAtMs: timestamp.nullable(),
    pairingError: z.string().nullable(),
    lastTest: deliverySchema.nullable(),
    signalUpdatesEnabled: z.boolean(),
    systemAlertsEnabled: z.boolean(),
  });

export const notificationDiagnosticsSchema = z.object({
  pending: z.number().int().nonnegative(),
  deliveryUnknown: z.number().int().nonnegative(),
  lastQueueDelayMs: timestamp.nullable(),
});

export const systemEventLabels: Record<string, string> = {
  WS_DISCONNECTED: '交易所 WebSocket 中断',
  REST_FAILED: '交易所接口异常',
  AI_CONFIGURATION: 'AI 配置异常',
  AI_AUTH_FAILED: 'OpenAI 凭证异常',
  AI_BUDGET_EXHAUSTED: 'AI 当日预算不足',
  TELEGRAM_CREDENTIALS: 'Telegram 凭证异常',
  DATABASE_UNAVAILABLE: 'SQLite 数据库不可用',
  BACKUP_FAILED: '数据库备份失败',
  BACKUP_VERIFIED: '数据库备份已验证',
  RETENTION_FAILED: '行情清理失败',
  RETENTION_COMPLETE: '行情清理完成',
  RESTORED_DELIVERY_UNCERTAIN: '从备份恢复，原送达状态待确认',
};

const systemEventSchema = z.object({
  id: z.number().int().positive(),
  source: z.string(),
  code: z.string(),
  severity: z.enum(['INFO', 'WARN', 'ERROR']),
  state: z.enum(['OPEN', 'RECOVERED', 'INFO']),
  createdAtMs: timestamp,
  detail: z.record(z.string(), z.union([z.string(), z.number()])),
  delivery: deliverySchema.nullable(),
});

export const systemDiagnosticsSchema = z.object({
  alerts: z.array(systemEventSchema),
  active: z.array(systemEventSchema),
  databaseBytes: timestamp.nullable(),
  latestBackupAtMs: timestamp.nullable(),
  latestCleanupAtMs: timestamp.nullable(),
});

export type SystemDiagnostics = z.infer<typeof systemDiagnosticsSchema>;

export const telegramSettingsResponseSchema = z.object({
  requestId: z.string(),
  data: telegramSettingsSchema,
});

export const telegramPairResponseSchema = z.object({
  requestId: z.string(),
  data: z.object({
    code: z.string(),
    botUsername: z.string(),
    expiresAtMs: timestamp,
  }),
});

export type TelegramSettingsPatch = z.infer<typeof telegramSettingsPatchSchema>;
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

export const aiModelSchema = z.enum(['gpt-6-luna', 'gpt-6.1-terra']);
export const trailPolicySchema = z.enum([
  'NONE',
  'BREAKEVEN_AFTER_TP1',
  'ATR_TRAIL_AFTER_TP1',
]);
const reviewPrice = z
  .string()
  .max(100)
  .regex(/^\d+(\.\d+)?$/);
const reviewText = z.string().min(1).max(240);

export const aiReviewResultSchema = z.strictObject({
  decision: z.enum(['ACCEPT', 'REJECT', 'MODIFY']),
  confidenceScore: z.number().int().min(0).max(100),
  rationale: z.array(reviewText).min(1).max(4),
  riskFlags: z.array(reviewText).max(4),
  rejectReason: reviewText.nullable(),
  levelAdjustment: z
    .strictObject({
      stopPrice: reviewPrice.nullable(),
      takeProfits: z
        .array(
          z.strictObject({
            targetPrice: reviewPrice,
            closePct: z.number().min(0.01).max(100),
            management: z.enum(['FIXED', 'TRAIL_AFTER_TRIGGER']),
            trailPolicy: trailPolicySchema,
          }),
        )
        .max(4),
    })
    .nullable(),
});

export const aiReviewStatusSchema = z.enum(['RUNNING', 'COMPLETED', 'FAILED']);
export const aiReviewAuditSchema = z.object({
  status: aiReviewStatusSchema,
  model: aiModelSchema,
  reportedModel: z.string().nullable(),
  promptVersion: z.string(),
  confidenceThreshold: z.number().int().min(0).max(100),
  result: aiReviewResultSchema.nullable(),
  reasonCode: z.string().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  reservedUsd: z.number().nonnegative(),
  startedAtMs: timestamp.nullable(),
  completedAtMs: timestamp.nullable(),
});

export const aiUsageSchema = z.object({
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  spentUsd: z.number().nonnegative(),
  reservedUsd: z.number().nonnegative(),
  dailyBudgetUsd: z.number().nonnegative(),
});

export const aiSettingsPatchSchema = z.strictObject({
  enabled: z.boolean(),
  model: aiModelSchema,
  confidenceThreshold: z.number().int().min(0).max(100),
  dailyBudgetUsd: z.number().min(0).max(1000).multipleOf(0.000001),
  timeoutMs: z.number().int().min(1000).max(30_000),
  maxOutputTokens: z.number().int().min(256).max(4096),
  apiKey: z.string().trim().max(1024).regex(/^\S+$/).nullable().optional(),
});

export const aiSettingsResponseSchema = z.object({
  requestId: z.string(),
  data: aiSettingsPatchSchema.omit({ apiKey: true }).extend({
    apiKeyMask: z.string().nullable(),
    storedKey: z.boolean(),
    usage: aiUsageSchema,
    lastTest: aiReviewAuditSchema.nullable(),
    configurationError: z.string().nullable(),
  }),
});

export type AiModel = z.infer<typeof aiModelSchema>;
export type AiReviewResult = z.infer<typeof aiReviewResultSchema>;
export type AiSettingsPatch = z.infer<typeof aiSettingsPatchSchema>;
