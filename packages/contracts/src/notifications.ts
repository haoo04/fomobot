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
  });

export const notificationDiagnosticsSchema = z.object({
  pending: z.number().int().nonnegative(),
  deliveryUnknown: z.number().int().nonnegative(),
  lastQueueDelayMs: timestamp.nullable(),
});

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
