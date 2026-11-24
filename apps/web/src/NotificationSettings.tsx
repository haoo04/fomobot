import {
  telegramPairResponseSchema,
  telegramSettingsResponseSchema,
  type DeliveryStatus,
  type TelegramSettingsPatch,
} from '@market-sentinel/contracts/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { request } from './api';

const path = '/api/v1/settings/telegram';
const queryKey = ['notification-settings', 'telegram'];

export const deliveryLabels: Record<DeliveryStatus, string> = {
  PENDING: '待发送',
  SENDING: '发送中',
  SENT: '已送达 Telegram',
  FAILED: '发送失败',
  DELIVERY_UNKNOWN: '送达不确定',
};

type TelegramAction = 'test' | 'unpair' | TelegramSettingsPatch;

export function NotificationSettings() {
  const client = useQueryClient();
  const settings = useQuery({
    queryKey,
    queryFn: () => request(path, telegramSettingsResponseSchema.parse),
    refetchInterval: 2000,
  });
  const pair = useMutation({
    mutationFn: () =>
      request(path + '/pair', telegramPairResponseSchema.parse, {
        method: 'POST',
      }),
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });
  const action = useMutation({
    mutationFn: (change: TelegramAction) => {
      if (typeof change === 'string')
        return request(
          path + (change === 'test' ? '/test' : '/pair'),
          telegramSettingsResponseSchema.parse,
          { method: change === 'test' ? 'POST' : 'DELETE' },
        );
      return request(path, telegramSettingsResponseSchema.parse, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      });
    },
    onSuccess: async (result, change) => {
      if (change === 'unpair') pair.reset();
      await client.cancelQueries({ queryKey });
      client.setQueryData(queryKey, result);
      await client.invalidateQueries({ queryKey });
    },
  });

  const data = settings.data?.data;
  if (settings.isPending) return <p role="status">正在读取通知设置…</p>;
  if (settings.isError)
    return (
      <p role="alert" className="error">
        {settings.error.message}
      </p>
    );
  if (!data) return null;

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    pair.reset();
    const form = event.currentTarget;
    const values = new FormData(form);
    const token = String(values.get('botToken') ?? '').trim();
    const input = form.elements.namedItem('botToken');
    if (input instanceof HTMLInputElement) input.value = '';
    action.mutate({
      botToken: values.has('useEnvironment') ? null : token || undefined,
      marketDailyLimit: Number(values.get('marketDailyLimit')),
      globalDailyLimit: Number(values.get('globalDailyLimit')),
    });
  }

  const challenge = pair.data?.data;
  const pending = action.isPending || pair.isPending;
  const activeChallenge =
    challenge && challenge.expiresAtMs === data.pairingExpiresAtMs;
  const testing =
    data.lastTest?.status === 'PENDING' || data.lastTest?.status === 'SENDING';
  return (
    <section
      className="panel market-editor notification-panel"
      aria-label="Telegram"
    >
      <h2>Telegram</h2>
      <p className="market-meta">
        {data.paired ? '已绑定私聊' : '待配对'}
        {data.botUsername && ' · @' + data.botUsername}
      </p>
      <form
        onSubmit={save}
        key={data.marketDailyLimit + '/' + data.globalDailyLimit}
      >
        <div className="market-form-grid">
          <label>
            Bot Token
            <input
              name="botToken"
              type="password"
              autoComplete="off"
              maxLength={256}
              placeholder={data.tokenMask ?? 'BotFather 提供的令牌'}
            />
          </label>
          <label>
            单市场每日上限
            <input
              name="marketDailyLimit"
              type="number"
              min={1}
              max={1000}
              defaultValue={data.marketDailyLimit}
              required
            />
          </label>
          <label>
            全局每日上限
            <input
              name="globalDailyLimit"
              type="number"
              min={1}
              max={1000}
              defaultValue={data.globalDailyLimit}
              required
            />
          </label>
          {data.storedToken && (
            <label className="market-check">
              <input name="useEnvironment" type="checkbox" />
              移除面板 Token，使用环境变量
            </label>
          )}
        </div>
        <div className="market-actions">
          <button type="submit" className="primary" disabled={pending}>
            保存设置
          </button>
          <button
            type="button"
            disabled={pending || !data.tokenMask}
            onClick={() => pair.mutate()}
          >
            {data.paired ? '重新配对' : '生成配对码'}
          </button>
          {data.paired && (
            <>
              <button
                type="button"
                disabled={pending || testing}
                onClick={() => action.mutate('test')}
              >
                发送测试消息
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => action.mutate('unpair')}
              >
                解除配对
              </button>
            </>
          )}
        </div>
      </form>
      {activeChallenge && (
        <p role="status">
          在 Telegram 与 @{challenge.botUsername} 私聊发送{' '}
          <code>/start {challenge.code}</code>。配对码 10 分钟内有效。
        </p>
      )}
      {data.pairingError && (
        <p className="error" role="alert">
          配对暂不可用（{data.pairingError}）。
        </p>
      )}
      {data.lastTest && (
        <p role="status">
          最新测试 · {deliveryLabels[data.lastTest.status]}
          {data.lastTest.telegramMessageId &&
            ' · 消息 ID ' + data.lastTest.telegramMessageId}
          {data.lastTest.lastError && ' · ' + data.lastTest.lastError}
        </p>
      )}
      {action.isSuccess && typeof action.variables !== 'string' && (
        <p role="status">设置已保存。</p>
      )}
      {(action.error || pair.error) && (
        <p className="error" role="alert">
          {(action.error ?? pair.error)?.message}
        </p>
      )}
    </section>
  );
}
