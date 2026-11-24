import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TelegramSettingsPatch } from '@market-sentinel/contracts/notifications';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../api-error.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../database.js';
import {
  auditLogs,
  outboxMessages,
  secretStore,
  telegramSettings,
} from '../schema.js';
import { maskSecret, readSecret, saveSecret } from '../secrets.js';

const botSchema = z.object({ username: z.string().regex(/^\w{1,64}$/) });
const telegramId = z.number().int().refine(Number.isSafeInteger);
const updateSchema = z.object({
  update_id: telegramId.nonnegative(),
  message: z
    .object({
      chat: z.object({ type: z.string(), id: telegramId }),
      from: z.object({ id: telegramId, is_bot: z.boolean() }).optional(),
      text: z.string().optional(),
    })
    .optional(),
});
const denialSchema = z.object({
  ok: z.literal(false),
  error_code: z.number().int(),
  parameters: z
    .object({ retry_after: z.number().int().positive().optional() })
    .optional(),
});

type TelegramFailure = { ok: false; code: string; retryAfterMs: number | null };
const unknownDelivery: TelegramFailure = {
  ok: false,
  code: 'TELEGRAM_RESPONSE_UNKNOWN',
  retryAfterMs: null,
};

export const deliveryFields = {
  status: outboxMessages.status,
  attempts: outboxMessages.attempts,
  manual: outboxMessages.manual,
  sentAtMs: outboxMessages.sentAtMs,
  telegramMessageId: outboxMessages.telegramMessageId,
  lastError: outboxMessages.lastError,
};

const emptyPairing = {
  pairingId: null,
  chatId: null,
  codeHash: null,
  codeExpiresAtMs: null,
  pairingError: null,
};
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export function createTelegram(
  db: AppDatabase,
  config: AppConfig,
  now: () => number,
  fetchTelegram: typeof fetch = fetch,
) {
  async function call<T>(
    token: string,
    method: 'getMe' | 'getUpdates' | 'sendMessage',
    input: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<{ ok: true; data: T } | TelegramFailure> {
    try {
      if (!/^\d+:[\w-]+$/.test(token)) {
        return {
          ok: false,
          code: 'TELEGRAM_INVALID_TOKEN',
          retryAfterMs: null,
        };
      }
      const response = await fetchTelegram(
        'https://api.telegram.org/bot' + token + '/' + method,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
          redirect: 'error',
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(method === 'getUpdates' ? 20_000 : 5000),
          ]),
        },
      );
      const raw: unknown = await response.json();
      const result = z
        .object({ ok: z.literal(true), result: schema })
        .safeParse(raw);
      if (response.ok && result.success)
        return { ok: true, data: result.data.result };
      const failure = denialSchema.safeParse(raw);
      if (failure.success) {
        const { error_code, parameters } = failure.data;
        return {
          ok: false,
          code: 'TELEGRAM_HTTP_' + error_code,
          retryAfterMs:
            error_code === 429
              ? (parameters?.retry_after ?? 1) * 1000
              : error_code >= 500 && error_code <= 599
                ? 1000
                : null,
        };
      }
      return unknownDelivery;
    } catch {
      return unknownDelivery;
    }
  }

  function current() {
    const row = db.select().from(telegramSettings).get();
    let token: string | null = config.TELEGRAM_BOT_TOKEN || null;
    if (row?.tokenRef) {
      try {
        token = readSecret(db, config.APP_ENCRYPTION_KEY_BASE64, row.tokenRef);
      } catch {
        token = null;
      }
    }
    const fingerprint = token ? hash(token) : null;
    const binding =
      fingerprint && row?.botFingerprint === fingerprint ? row : null;
    const pairing =
      token && binding?.pairingId && binding.chatId
        ? { id: binding.pairingId, chatId: binding.chatId, token }
        : null;
    return {
      row,
      token,
      fingerprint,
      binding,
      pairing,
      marketDailyLimit: row?.marketDailyLimit ?? 8,
      globalDailyLimit: row?.globalDailyLimit ?? 30,
      signalUpdatesEnabled: row?.signalUpdatesEnabled ?? true,
    };
  }

  function settings() {
    const {
      row,
      token,
      binding,
      pairing,
      marketDailyLimit,
      globalDailyLimit,
      signalUpdatesEnabled,
    } = current();
    const lastTest = pairing
      ? (db
          .select(deliveryFields)
          .from(outboxMessages)
          .where(
            and(
              eq(outboxMessages.kind, 'TELEGRAM_TEST'),
              eq(outboxMessages.pairingId, pairing.id),
            ),
          )
          .orderBy(desc(outboxMessages.createdAtMs), desc(outboxMessages.id))
          .get() ?? null)
      : null;
    return {
      tokenMask: maskSecret(token),
      storedToken: !!row?.tokenRef,
      botUsername: binding?.botUsername ?? null,
      paired: !!pairing,
      pairingExpiresAtMs:
        binding?.codeExpiresAtMs && binding.codeExpiresAtMs > now()
          ? binding.codeExpiresAtMs
          : null,
      pairingError: binding?.pairingError ?? null,
      marketDailyLimit,
      globalDailyLimit,
      signalUpdatesEnabled,
      lastTest,
    };
  }

  function save(patch: TelegramSettingsPatch, actor: string) {
    const { row, token, fingerprint } = current();
    const newToken =
      patch.botToken === undefined
        ? token
        : (patch.botToken ?? (config.TELEGRAM_BOT_TOKEN || null));
    const newFingerprint = newToken ? hash(newToken) : null;
    db.transaction((tx) => {
      const tokenRef =
        typeof patch.botToken === 'string'
          ? saveSecret(tx, config.APP_ENCRYPTION_KEY_BASE64, patch.botToken)
          : patch.botToken === null
            ? null
            : (row?.tokenRef ?? null);
      const changes = {
        tokenRef,
        marketDailyLimit: patch.marketDailyLimit,
        globalDailyLimit: patch.globalDailyLimit,
        signalUpdatesEnabled:
          patch.signalUpdatesEnabled ?? row?.signalUpdatesEnabled ?? true,
        ...(newFingerprint === fingerprint
          ? {}
          : {
              ...emptyPairing,
              botFingerprint: newFingerprint,
              botUsername: null,
              updateOffset: null,
            }),
      };
      tx.insert(telegramSettings)
        .values({ id: 1, ...changes })
        .onConflictDoUpdate({ target: telegramSettings.id, set: changes })
        .run();
      if (row?.tokenRef && row.tokenRef !== tokenRef)
        tx.delete(secretStore).where(eq(secretStore.id, row.tokenRef)).run();
      tx.insert(auditLogs)
        .values({
          actor,
          action: 'TELEGRAM_SETTINGS_SAVE',
          targetType: 'settings',
          targetId: 'telegram',
          createdAtMs: now(),
        })
        .run();
    });
    return settings();
  }

  async function pair(actor: string) {
    const { token, fingerprint } = current();
    if (!token || !fingerprint)
      throw new ApiError(
        409,
        'TELEGRAM_NOT_CONFIGURED',
        '请先配置 Bot Token。',
      );
    const bot = await call(
      token,
      'getMe',
      {},
      botSchema,
      AbortSignal.timeout(5000),
    );
    if (!bot.ok) throw new ApiError(422, bot.code, 'Telegram 机器人验证失败。');
    const latest = current();
    if (latest.fingerprint !== fingerprint)
      throw new ApiError(
        409,
        'TELEGRAM_SETTINGS_CHANGED',
        'Bot Token 已变更，请重试。',
      );
    const code = randomBytes(18).toString('base64url');
    const expiresAtMs = now() + 10 * 60_000;
    const changes = {
      botFingerprint: fingerprint,
      botUsername: bot.data.username,
      ...(!latest.binding ? { ...emptyPairing, updateOffset: null } : {}),
      codeHash: hash(code),
      codeExpiresAtMs: expiresAtMs,
      pairingError: null,
    };
    db.transaction((tx) => {
      tx.insert(telegramSettings)
        .values({ id: 1, ...changes })
        .onConflictDoUpdate({ target: telegramSettings.id, set: changes })
        .run();
      tx.insert(auditLogs)
        .values({
          actor,
          action: 'TELEGRAM_PAIR_REQUEST',
          targetType: 'settings',
          targetId: 'telegram',
          createdAtMs: now(),
        })
        .run();
    });
    return { code, botUsername: bot.data.username, expiresAtMs };
  }

  function unpair(actor: string) {
    db.transaction((tx) => {
      tx.update(telegramSettings)
        .set(emptyPairing)
        .where(eq(telegramSettings.id, 1))
        .run();
      tx.insert(auditLogs)
        .values({
          actor,
          action: 'TELEGRAM_UNPAIR',
          targetType: 'settings',
          targetId: 'telegram',
          createdAtMs: now(),
        })
        .run();
    });
    return settings();
  }

  let pollAfterMs = 0;
  async function poll(signal: AbortSignal) {
    const { binding, token } = current();
    if (
      !token ||
      !binding?.codeHash ||
      !binding.botFingerprint ||
      !binding.codeExpiresAtMs ||
      now() >= binding.codeExpiresAtMs ||
      now() < pollAfterMs
    )
      return;
    const updates = await call(
      token,
      'getUpdates',
      {
        offset: binding.updateOffset ?? 0,
        timeout: 15,
        allowed_updates: ['message'],
      },
      z.array(updateSchema),
      signal,
    );
    if (signal.aborted || now() >= binding.codeExpiresAtMs) return;
    const currentPair = and(
      eq(telegramSettings.id, 1),
      eq(telegramSettings.botFingerprint, binding.botFingerprint),
      eq(telegramSettings.codeHash, binding.codeHash),
    );
    if (!updates.ok) {
      pollAfterMs = now() + (updates.retryAfterMs ?? 5000);
      db.update(telegramSettings)
        .set({ pairingError: updates.code })
        .where(currentPair)
        .run();
      return;
    }

    let offset = binding.updateOffset ?? 0;
    let chatId: string | undefined;
    for (const { update_id, message } of updates.data) {
      offset = Math.max(offset, update_id + 1);
      if (
        chatId ||
        message?.chat.type !== 'private' ||
        message.from?.id !== message.chat.id ||
        message.from.is_bot
      )
        continue;
      const code = /^\/start ([\w-]{24})$/.exec(message.text ?? '')?.[1];
      if (code && hash(code) === binding.codeHash)
        chatId = String(message.chat.id);
    }
    if (chatId) {
      db.transaction((tx) => {
        const changed = tx
          .update(telegramSettings)
          .set({
            ...emptyPairing,
            chatId,
            pairingId: randomUUID(),
            updateOffset: offset,
          })
          .where(currentPair)
          .run();
        if (changed.changes)
          tx.insert(auditLogs)
            .values({
              actor: 'telegram',
              action: 'TELEGRAM_PAIRED',
              targetType: 'settings',
              targetId: 'telegram',
              createdAtMs: now(),
            })
            .run();
      });
    } else if (offset !== binding.updateOffset || binding.pairingError) {
      db.update(telegramSettings)
        .set({ updateOffset: offset, pairingError: null })
        .where(currentPair)
        .run();
    }
  }

  return {
    current,
    settings,
    save,
    pair,
    unpair,
    poll,
    send: (token: string, chatId: string, body: string, signal: AbortSignal) =>
      call(
        token,
        'sendMessage',
        {
          chat_id: chatId,
          text: body,
          link_preview_options: { is_disabled: true },
        },
        z.object({ message_id: telegramId.nonnegative() }),
        signal,
      ),
  };
}
