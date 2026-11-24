import {
  monitorResponseSchema,
  type Monitor,
} from '@market-sentinel/contracts/markets';
import {
  signalResponseSchema,
  signalsResponseSchema,
  strategyPatchSchema,
  type StrategyPatch,
} from '@market-sentinel/contracts/strategies';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { request } from './api';
import { deliveryLabels } from './NotificationSettings';

const outcomes = {
  WAITING: '等待收盘',
  NO_TRADE: '条件未满足',
  PASSED: '预风控通过',
  REJECTED: '已拒绝',
  SUPPRESSED: '已抑制',
  WATCH_ONLY: '现货观察',
};
const directions = { LONG: '做多', SHORT: '做空', BEARISH_WATCH: '偏空观察' };
const reasons: Record<string, string> = {
  AWAITING_CLOSE: '等待确认及趋势周期的收盘数据',
  WARMING: '有效 K 线不足，等待预热',
  REJECT_INCOMPLETE_CANDLE: '关键周期缺少完整收盘 K 线',
  REJECT_INDICATORS_UNAVAILABLE: '指标数据不可用',
  REJECT_MARKET_UNAVAILABLE: '市场或实时行情不可用',
  REJECT_STALE_DATA: '触发收盘已过期',
  REJECT_STALE_QUOTE: '盘口报价已过期',
  REJECT_OI_UNAVAILABLE: '缺少新鲜、同口径的连续 OI 样本',
  OI_BELOW_THRESHOLD: 'OI 增幅未达阈值',
  REJECT_RISK_CONFIG_REQUIRED: '市场风控阈值待填写',
  REJECT_LIQUIDITY: '盘口、点差或成交额不合格',
  REJECT_PRICE_PRECISION: '价格档位不可用',
  REJECT_VOLATILITY: '波动超限或 ATR 不可用',
  REJECT_PRICE_DRIFT: '入场参考价偏离触发收盘价',
  REJECT_INVALID_STOP: '止损距离不合格',
  REJECT_INVALID_TARGET: '止盈价位不合格',
  REJECT_INVALID_ALLOCATION: '止盈分仓比例不合格',
  REJECT_LOW_RR: '加权 R:R 低于阈值',
  SUPPRESS_CONFLICT: '同一触发 K 线出现相反方向',
  SUPPRESS_COOLDOWN: '同方向仍在冷却期',
  SUPPRESS_TELEGRAM_NOT_PAIRED: 'Telegram 待配对',
  SUPPRESS_MONITOR_CHANGED: '监控已暂停或配置已变更',
  DELIVERY_EXPIRED: '信号已过期',
  SUPPRESS_DAILY_LIMIT: '达到当日通知上限',
  TELEGRAM_PAIRING_CHANGED: 'Telegram 配对已变更',
  EVALUATION_FAILED: '策略评估失败',
};

function numberField(
  name: string,
  label: string,
  value: number | null,
  step: number | 'any' = 'any',
) {
  return (
    <label>
      {label}
      <input
        name={name}
        type="number"
        min="0"
        step={step}
        defaultValue={value ?? ''}
      />
    </label>
  );
}

function StrategyForm({
  monitor,
  pending,
  onSave,
}: {
  monitor: Monitor;
  pending: boolean;
  onSave(strategy: StrategyPatch): void;
}) {
  const { params, enabled } = monitor.strategy;
  const { risk } = params;
  const [targets, setTargets] = useState(risk.takeProfits.length);
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const number = (field: string) => {
      const value = form.get(field);
      return value === '' || value === null ? NaN : Number(value);
    };
    const optional = (field: string) =>
      form.get(field) === '' ? null : number(field);
    const patch = strategyPatchSchema.safeParse({
      enabled: form.has('enabled'),
      params: {
        emaPeriods: [number('fast'), number('medium'), number('slow')],
        rsi: {
          period: number('rsiPeriod'),
          longMin: number('longMin'),
          longMax: number('longMax'),
          shortMin: number('shortMin'),
          shortMax: number('shortMax'),
        },
        volume: {
          lookback: number('volumeLookback'),
          relativeMin: number('relativeMin'),
        },
        oi: params.oi
          ? {
              lookbackMinutes: number('oiLookback'),
              minIncreasePct: number('oiMin'),
              maxAgeSeconds: number('oiAge'),
            }
          : null,
        atr: {
          period: number('atrPeriod'),
          stopMultiplier: number('stopMultiplier'),
        },
        breakPreviousCandle: form.has('breakPreviousCandle'),
        risk: {
          minWeightedRR: number('minWeightedRR'),
          maxEntryDriftAtr: number('maxEntryDriftAtr'),
          swingLookback: number('swingLookback'),
          cooldownMinutes: number('cooldownMinutes'),
          maxAgeSeconds: number('maxAgeSeconds'),
          maxSpreadBps: optional('maxSpreadBps'),
          minTurnover: String(form.get('minTurnover') ?? '').trim() || null,
          minStopPct: optional('minStopPct'),
          maxStopPct: optional('maxStopPct'),
          maxAtrPct: optional('maxAtrPct'),
          takeProfits: Array.from({ length: targets }, (_, i) => ({
            rMultiple: number('r-' + i),
            closePct: number('pct-' + i),
          })),
        },
      },
    });
    if (!patch.success) {
      const issue = patch.error.issues[0]!;
      setError(
        issue.code === 'custom'
          ? issue.message
          : '请检查参数 ' + issue.path.slice(1).join(' / ') + '。',
      );
      return;
    }
    setError(null);
    onSave(patch.data);
  }

  return (
    <form className="strategy-form" onSubmit={submit}>
      <label className="market-check">
        <input type="checkbox" name="enabled" defaultChecked={enabled} />
        启用策略评估
      </label>
      <fieldset>
        <legend>市场风控阈值</legend>
        <div className="market-form-grid">
          {numberField('maxSpreadBps', '最大点差（基点）', risk.maxSpreadBps)}
          <label>
            {'最低成交额 / 触发周期（' +
              (monitor.market.quoteAsset ?? '原生计价单位') +
              '）'}
            <input
              name="minTurnover"
              inputMode="decimal"
              defaultValue={risk.minTurnover ?? ''}
            />
          </label>
          {numberField('minStopPct', '最小止损距离（%）', risk.minStopPct)}
          {numberField('maxStopPct', '最大止损距离（%）', risk.maxStopPct)}
          {numberField('maxAtrPct', 'ATR / 收盘价上限（%）', risk.maxAtrPct)}
        </div>
      </fieldset>
      <details>
        <summary>指标与策略参数</summary>
        <div className="market-form-grid">
          {numberField('fast', '快速 EMA', params.emaPeriods[0], 1)}
          {numberField('medium', '中速 EMA', params.emaPeriods[1], 1)}
          {numberField('slow', '慢速 EMA', params.emaPeriods[2], 1)}
          {numberField('rsiPeriod', 'RSI 周期', params.rsi.period, 1)}
          {numberField('longMin', '多头 RSI 下限', params.rsi.longMin)}
          {numberField('longMax', '多头 RSI 上限', params.rsi.longMax)}
          {numberField('shortMin', '空头 RSI 下限', params.rsi.shortMin)}
          {numberField('shortMax', '空头 RSI 上限', params.rsi.shortMax)}
          {numberField(
            'volumeLookback',
            'RVOL 回看根数',
            params.volume.lookback,
            1,
          )}
          {numberField('relativeMin', '最低 RVOL', params.volume.relativeMin)}
          {numberField('atrPeriod', 'ATR 周期', params.atr.period, 1)}
          {numberField(
            'stopMultiplier',
            '止损 ATR 倍数',
            params.atr.stopMultiplier,
          )}
          {params.oi && (
            <>
              {numberField(
                'oiLookback',
                'OI 回看（分钟）',
                params.oi.lookbackMinutes,
                1,
              )}
              {numberField(
                'oiMin',
                '最低 OI 增幅（%）',
                params.oi.minIncreasePct,
              )}
              {numberField(
                'oiAge',
                'OI 最大样本年龄（秒）',
                params.oi.maxAgeSeconds,
                1,
              )}
            </>
          )}
        </div>
        <label className="market-check">
          <input
            type="checkbox"
            name="breakPreviousCandle"
            defaultChecked={params.breakPreviousCandle}
          />
          要求突破上一根 K 线
        </label>
      </details>
      <details>
        <summary>止盈与时效参数</summary>
        <div className="market-form-grid">
          {numberField('minWeightedRR', '最低加权 R:R', risk.minWeightedRR)}
          {numberField(
            'maxEntryDriftAtr',
            '最大入场偏差（ATR 倍数）',
            risk.maxEntryDriftAtr,
          )}
          {numberField(
            'swingLookback',
            '结构止损回看根数',
            risk.swingLookback,
            1,
          )}
          {numberField(
            'cooldownMinutes',
            '冷却时间（分钟）',
            risk.cooldownMinutes,
            1,
          )}
          {numberField(
            'maxAgeSeconds',
            '行情时效（秒）',
            risk.maxAgeSeconds,
            1,
          )}
        </div>
        {Array.from({ length: targets }, (_, i) => (
          <div className="market-form-grid" key={i}>
            {numberField(
              'r-' + i,
              'TP' + (i + 1) + '（R 倍数）',
              risk.takeProfits[i]?.rMultiple ?? null,
            )}
            {numberField(
              'pct-' + i,
              '分仓比例（%）',
              risk.takeProfits[i]?.closePct ?? null,
              0.01,
            )}
          </div>
        ))}
        <div className="market-actions">
          <button
            type="button"
            onClick={() => setTargets(targets + 1)}
            disabled={targets === 4}
          >
            添加止盈档
          </button>
          <button
            type="button"
            onClick={() => setTargets(targets - 1)}
            disabled={targets === 1}
          >
            移除末档
          </button>
        </div>
      </details>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="market-actions">
        <button type="submit" disabled={pending}>
          {pending ? '保存中…' : '保存策略'}
        </button>
      </div>
    </form>
  );
}

export function StrategyPanel({
  monitor,
  formatTime,
  queryKey,
}: {
  monitor: Monitor;
  formatTime(value: number | null): string;
  queryKey: readonly string[];
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const signals = useQuery({
    queryKey: [...queryKey, 'signals', monitor.market.id],
    queryFn: () =>
      request(
        '/api/v1/signals?marketId=' + monitor.market.id + '&limit=6',
        signalsResponseSchema.parse,
      ),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });
  const detail = useQuery({
    queryKey: [...queryKey, 'signal', selected],
    queryFn: () =>
      request('/api/v1/signals/' + selected, signalResponseSchema.parse),
    enabled: open && selected !== null,
    refetchInterval: open && selected !== null ? 3000 : false,
  });
  const save = useMutation({
    mutationFn: (strategy: StrategyPatch) =>
      request('/api/v1/monitors/' + monitor.id, monitorResponseSchema.parse, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy }),
      }),
    onSuccess: async () => client.invalidateQueries({ queryKey }),
  });
  const resend = useMutation({
    mutationFn: (id: string) =>
      request('/api/v1/signals/' + id + '/resend', () => undefined, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: async () => client.invalidateQueries({ queryKey }),
  });
  const { strategy } = monitor;
  const { maxSpreadBps, minTurnover, minStopPct, maxStopPct, maxAtrPct } =
    strategy.params.risk;
  const incomplete = [
    maxSpreadBps,
    minTurnover,
    minStopPct,
    maxStopPct,
    maxAtrPct,
  ].includes(null);
  const latest = strategy.latest;
  let summary = '等待实时收盘';
  if (!monitor.enabled || !strategy.enabled) summary = '已暂停';
  else if (latest) summary = outcomes[latest.outcome];
  else if (incomplete) summary = '阈值待配置';
  const signal = detail.data?.data;
  const levels = signal?.finalRisk?.levels ?? signal?.levels;

  return (
    <details
      className="strategy-panel"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>策略与风控 · {summary}</summary>
      {open && (
        <>
          <p className="market-meta">
            {strategy.strategyId} · v{strategy.strategyVersion}
            {incomplete && ' · 阈值待配置'}
            {latest && ' · ' + formatTime(latest.atMs)}
            {latest?.reasonCode &&
              ' · ' + (reasons[latest.reasonCode] ?? latest.reasonCode)}
          </p>
          <StrategyForm
            key={strategy.versionId + '/' + strategy.enabled}
            monitor={monitor}
            pending={save.isPending}
            onSave={(patch) => save.mutate(patch)}
          />
          {save.isError && (
            <p className="error" role="alert">
              {save.error.message}
            </p>
          )}
          {save.isSuccess && <p role="status">策略已保存。</p>}
          <h3>近期候选</h3>
          {signals.isPending && <p role="status">正在读取候选…</p>}
          {signals.isError && (
            <p className="error" role="alert">
              {signals.error.message}
            </p>
          )}
          {signals.data?.data.items.length === 0 && (
            <p className="market-meta">尚无候选记录。</p>
          )}
          {signals.data?.data.items.map((item) => (
            <div className="catalog-row" key={item.id}>
              <div>
                <strong>
                  {directions[item.direction]} · {outcomes[item.outcome]}
                  {item.delivery &&
                    ' · ' + deliveryLabels[item.delivery.status]}
                  {item.deliveryPending && ' · 待终审'}
                </strong>
                <small>
                  {formatTime(item.triggerCloseMs)} · {item.triggerTimeframe}
                  {item.reasonCode &&
                    ' · ' + (reasons[item.reasonCode] ?? item.reasonCode)}
                </small>
              </div>
              <button
                type="button"
                aria-expanded={selected === item.id}
                onClick={() =>
                  setSelected(selected === item.id ? null : item.id)
                }
              >
                {selected === item.id ? '收起详情' : '查看详情'}
              </button>
            </div>
          ))}
          {selected && detail.isPending && <p role="status">正在读取详情…</p>}
          {selected && detail.isError && (
            <p className="error" role="alert">
              {detail.error.message}
            </p>
          )}
          {selected && signal && (
            <section className="strategy-result" aria-label="候选详情">
              <h3>
                {directions[signal.direction]} · {outcomes[signal.outcome]}
              </h3>
              <p className="market-meta">
                {formatTime(signal.triggerCloseMs)} ·{' '}
                {signal.timeframes.trigger} / {signal.timeframes.confirm} /{' '}
                {signal.timeframes.trend}
                {signal.reasonCode &&
                  ' · ' + (reasons[signal.reasonCode] ?? signal.reasonCode)}
              </p>
              <p className="market-meta">配置版本 {signal.configVersionId}</p>
              {signal.finalRisk && (
                <p className="market-meta">
                  最终风控 ·{' '}
                  {signal.finalRisk.outcome === 'PASSED'
                    ? '通过'
                    : outcomes[signal.finalRisk.outcome]}
                  {signal.finalRisk.reasonCode &&
                    ' · ' +
                      (reasons[signal.finalRisk.reasonCode] ??
                        signal.finalRisk.reasonCode)}
                  {signal.finalRisk.atMs !== null &&
                    ' · ' + formatTime(signal.finalRisk.atMs)}
                </p>
              )}
              {signal.signalId && (
                <p className="market-meta">正式信号 {signal.signalId}</p>
              )}
              {signal.deliveries.map((delivery) => (
                <p className="market-meta" key={String(delivery.manual)}>
                  {delivery.manual ? '补发' : 'Telegram'} ·{' '}
                  {deliveryLabels[delivery.status]}
                  {delivery.telegramMessageId &&
                    ' · 消息 ID ' + delivery.telegramMessageId}
                  {delivery.sentAtMs !== null &&
                    ' · ' + formatTime(delivery.sentAtMs)}
                  {delivery.lastError &&
                    ' · ' + (reasons[delivery.lastError] ?? delivery.lastError)}
                </p>
              ))}
              {signal.canResend && (
                <button
                  type="button"
                  disabled={resend.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        'Telegram 可能已送达此信号。确认补发可能重复的消息？',
                      )
                    )
                      resend.mutate(signal.id);
                  }}
                >
                  确认补发
                </button>
              )}
              {resend.isError && resend.variables === signal.id && (
                <p role="alert" className="error">
                  {resend.error.message}
                </p>
              )}
              {levels && (
                <dl className="market-facts">
                  <div>
                    <dt>参考入场</dt>
                    <dd>{levels.entry}</dd>
                  </div>
                  <div>
                    <dt>止损</dt>
                    <dd>{levels.stop}</dd>
                  </div>
                  {levels.takeProfits.map((target, i) => (
                    <div key={target.price}>
                      <dt>
                        TP{i + 1}（{target.closePct}%）
                      </dt>
                      <dd>{target.price}</dd>
                    </div>
                  ))}
                  <div>
                    <dt>加权 R:R</dt>
                    <dd>{levels.weightedRR}</dd>
                  </div>
                </dl>
              )}
              <details>
                <summary>计算证据与参数快照</summary>
                <pre>
                  {JSON.stringify(
                    { ...signal.evidence, params: signal.params },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </section>
          )}
        </>
      )}
    </details>
  );
}
