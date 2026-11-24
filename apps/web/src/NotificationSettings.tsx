import {
  aiModelSchema,
  aiSettingsResponseSchema,
  telegramPairResponseSchema,
  telegramSettingsResponseSchema,
  type DeliveryStatus,
  type TelegramSettingsPatch,
  type AiSettingsPatch,
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

export const aiFailureLabels: Record<string, string> = {
  AI_KEY_REQUIRED: '请先配置 OpenAI API Key',
  AI_UNSUPPORTED_MODEL: '请选用面板支持的审核模型',
  AI_SDK_UNAVAILABLE: '需要安装 OpenAI SDK',
  AI_REJECTED: 'AI 拒绝该候选',
  AI_LOW_CONFIDENCE: 'AI 主观评分低于门槛',
  AI_TIMEOUT: 'AI 审核超时',
  AI_MODEL_REFUSAL: '模型拒绝生成审核结果',
  AI_INCOMPLETE: '模型响应未完成',
  AI_INVALID_OUTPUT: '模型输出未通过结构化校验',
  AI_INVALID_ADJUSTMENT: '模型调整不符合审核契约',
  AI_REVIEW_INTERRUPTED: 'AI 审核中断',
  AI_BUDGET_EXHAUSTED: '当日 AI 预算不足',
  AI_AUTH_FAILED: 'OpenAI 鉴权或访问权限验证失败',
  AI_RATE_LIMITED: 'OpenAI 请求受限',
  AI_PROVIDER_QUOTA_EXHAUSTED: 'OpenAI 项目额度不足',
  AI_UNAVAILABLE: 'OpenAI 暂不可用',
  SUPPRESS_AI_SETTINGS_CHANGED: 'AI 审核设置已变更',
};

type TelegramAction = 'test' | 'unpair' | TelegramSettingsPatch;

function TelegramSettings() {
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

const aiPath = '/api/v1/settings/ai';
const aiKey = ['notification-settings', 'ai'];

function AiSettings() {
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: aiKey,
    queryFn: () => request(aiPath, aiSettingsResponseSchema.parse),
    refetchInterval: 5000,
  });
  const action = useMutation({
    mutationFn: (change: AiSettingsPatch | 'test') =>
      change === 'test'
        ? request(aiPath + '/test', aiSettingsResponseSchema.parse, {
            method: 'POST',
          })
        : request(aiPath, aiSettingsResponseSchema.parse, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(change),
          }),
    onSuccess: async (result) => {
      await client.cancelQueries({ queryKey: aiKey });
      client.setQueryData(aiKey, result);
      await client.invalidateQueries({ queryKey: aiKey });
    },
  });
  const data = settings.data?.data;
  if (settings.isPending) return <p role="status">正在读取 AI 设置…</p>;
  if (settings.isError)
    return (
      <p className="error" role="alert">
        {settings.error.message}
      </p>
    );
  if (!data) return null;

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const key = String(values.get('apiKey') ?? '').trim();
    const input = form.elements.namedItem('apiKey');
    if (input instanceof HTMLInputElement) input.value = '';
    action.mutate({
      apiKey: values.has('useEnvironment') ? null : key || undefined,
      enabled: values.has('enabled'),
      model: aiModelSchema.parse(values.get('model')),
      confidenceThreshold: Number(values.get('confidenceThreshold')),
      dailyBudgetUsd: Number(values.get('dailyBudgetUsd')),
      timeoutMs: Math.round(Number(values.get('timeoutSeconds')) * 1000),
      maxOutputTokens: Number(values.get('maxOutputTokens')),
    });
  }

  const { usage, lastTest } = data;
  return (
    <section
      className="panel market-editor notification-panel"
      aria-label="OpenAI 审核"
    >
      <h2>OpenAI 审核</h2>
      <p className="market-meta">
        {data.enabled
          ? 'AI 审核已开启 · 审核异常时暂停该候选的通知'
          : '规则模式'}
      </p>
      <form
        onSubmit={save}
        key={[
          data.enabled,
          data.model,
          data.confidenceThreshold,
          data.dailyBudgetUsd,
          data.timeoutMs,
          data.maxOutputTokens,
          data.storedKey,
          data.apiKeyMask,
        ].join('/')}
      >
        <div className="market-form-grid">
          <label>
            OpenAI API Key
            <input
              name="apiKey"
              type="password"
              autoComplete="off"
              maxLength={1024}
              placeholder={data.apiKeyMask ?? 'OpenAI API Key'}
            />
          </label>
          <label>
            审核模型
            <select name="model" defaultValue={data.model}>
              {aiModelSchema.options.map((model) => (
                <option key={model}>{model}</option>
              ))}
            </select>
          </label>
          <label>
            每日预算（USD）
            <input
              name="dailyBudgetUsd"
              type="number"
              min={0}
              max={1000}
              step="0.000001"
              defaultValue={data.dailyBudgetUsd}
              required
            />
          </label>
          <label>
            置信度门槛（0–100）
            <input
              name="confidenceThreshold"
              type="number"
              min={0}
              max={100}
              defaultValue={data.confidenceThreshold}
              required
            />
          </label>
          <label>
            超时（秒）
            <input
              name="timeoutSeconds"
              type="number"
              min={1}
              max={30}
              step="0.001"
              defaultValue={data.timeoutMs / 1000}
              required
            />
          </label>
          <label>
            最大输出 tokens
            <input
              name="maxOutputTokens"
              type="number"
              min={256}
              max={4096}
              defaultValue={data.maxOutputTokens}
              required
            />
          </label>
          <label className="market-check">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={data.enabled}
            />
            启用 AI 审核
          </label>
          {data.storedKey && (
            <label className="market-check">
              <input name="useEnvironment" type="checkbox" />
              移除面板 Key，使用环境变量
            </label>
          )}
        </div>
        <div className="market-actions">
          <button type="submit" className="primary" disabled={action.isPending}>
            保存 AI 设置
          </button>
          <button
            type="button"
            disabled={action.isPending || !!data.configurationError}
            onClick={() => action.mutate('test')}
          >
            {action.isPending && action.variables === 'test'
              ? '正在测试…'
              : '测试结构化响应'}
          </button>
          <small>测试计入当日预算。</small>
        </div>
      </form>
      <p className="market-meta">
        今日 {usage.calls} 次调用 · 输入 {usage.inputTokens} / 输出{' '}
        {usage.outputTokens} tokens · 已估算 USD {usage.spentUsd.toFixed(6)} ·
        预留 USD {usage.reservedUsd.toFixed(6)}
      </p>
      {data.configurationError && data.enabled && (
        <p className="error" role="alert">
          {aiFailureLabels[data.configurationError] ?? data.configurationError}
        </p>
      )}
      {lastTest && (
        <p role="status">
          最新测试 ·{' '}
          {lastTest.status === 'COMPLETED'
            ? '结构化响应通过'
            : lastTest.reasonCode
              ? (aiFailureLabels[lastTest.reasonCode] ?? lastTest.reasonCode)
              : '审核中'}
        </p>
      )}
      {action.isSuccess && action.variables !== 'test' && (
        <p role="status">AI 设置已保存。</p>
      )}
      {action.isError && (
        <p className="error" role="alert">
          {action.error.message}
        </p>
      )}
    </section>
  );
}

export function NotificationSettings() {
  return (
    <>
      <TelegramSettings />
      <AiSettings />
    </>
  );
}
