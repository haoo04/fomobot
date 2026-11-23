import {
  diagnosticsResponseSchema,
  marketListResponseSchema,
  marketResponseSchema,
  monitorResponseSchema,
  monitorsResponseSchema,
  syncResponseSchema,
  timeframeSchema,
} from '@market-sentinel/contracts/markets';
import type {
  Market,
  Monitor,
  ProviderDiagnostics,
} from '@market-sentinel/contracts/markets';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { request } from './api';

const api = '/api/v1';
const marketsKey = ['market-data'];
const states: Record<Monitor['periods'][number]['state'], string> = {
  PAUSED: '已暂停',
  WARMING: '预热中',
  ACTIVE: '运行中',
  RECOVERING: '回补中',
  DEGRADED: '数据异常',
  UNAVAILABLE: '不可用',
};
const connections: Record<ProviderDiagnostics['connection'], string> = {
  IDLE: '待启用',
  CONNECTING: '连接中',
  CONNECTED: '已连接',
  RECONNECTING: '重连中',
};
const interests: Record<Monitor['openInterest']['state'], string> = {
  'N/A': '不适用',
  MISSING: '暂无样本',
  FRESH: '有效',
  STALE: '已过期',
};
const reasons: Record<string, string> = {
  MARKET_UNAVAILABLE: '市场当前无法交易。',
  MISSING_BASE_VOLUME: '最近收盘缺少成交量。',
  WS_UNAVAILABLE: '实时连接暂不可用。',
  MISSING_RECENT_CANDLES: '最近周期存在缺口。',
  NO_RECENT_CANDLE: '暂未收到最新收盘。',
  UPSTREAM_UNAVAILABLE: '交易所接口暂不可用。',
  RATE_LIMITED: '交易所接口限流。',
  INVALID_RESPONSE: '交易所响应格式不匹配。',
  ACCESS_DENIED: '公开行情访问受限。',
  SUBSCRIPTION_CAPACITY: '此交易所订阅容量已满。',
  DATA_HANDLER_FAILED: '实时行情处理失败。',
};
const exchangeName = (exchange: Market['exchange']) =>
  exchange === 'BITGET' ? 'Bitget' : 'Hyperliquid';
const productName = (market: Market) =>
  market.isReality
    ? 'Reality 股票代币'
    : market.productType === 'HIP3-PERP'
      ? 'HIP-3 合成永续'
      : market.marketType === 'SPOT'
        ? '现货'
        : market.productType === 'HYPERLIQUID-PERP'
          ? '原生永续'
          : market.productType;

function MarketEditor({
  market,
  monitor,
  pending,
  onCancel,
  onSave,
}: {
  market: Market;
  monitor: Monitor | undefined;
  pending: boolean;
  onCancel(): void;
  onSave(values: Record<string, unknown>): void;
}) {
  const { intervals } = market.capabilities;
  const roles = [
    { key: 'trigger', label: '触发周期', value: monitor?.trigger ?? '3m' },
    { key: 'confirm', label: '确认周期', value: monitor?.confirm ?? '5m' },
    { key: 'trend', label: '方向周期', value: monitor?.trend ?? '1h' },
  ] as const;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      trigger: form.get('trigger'),
      confirm: form.get('confirm'),
      trend: form.get('trend'),
      extra: form.getAll('extra'),
      enabled: form.has('enabled'),
      ...(monitor ? {} : { marketId: market.id }),
    });
  }

  return (
    <form className="market-editor" onSubmit={submit}>
      <div className="market-section-heading">
        <div>
          <h3>{market.nativeSymbol}</h3>
          <p className="market-meta">
            {exchangeName(market.exchange)} · {productName(market)} ·{' '}
            {market.venue}
          </p>
        </div>
        <button type="button" onClick={onCancel}>
          关闭
        </button>
      </div>
      <dl className="market-facts">
        <div>
          <dt>计价资产</dt>
          <dd>{market.quoteAsset ?? '未知'}</dd>
        </div>
        <div>
          <dt>抵押资产</dt>
          <dd>{market.collateralAsset ?? '未提供'}</dd>
        </div>
        <div>
          <dt>价格精度</dt>
          <dd>
            {market.pricePrecision === null
              ? '未知'
              : '最多 ' + market.pricePrecision + ' 位'}
          </dd>
        </div>
        <div>
          <dt>最小价格单位</dt>
          <dd>{market.tickSize ?? '未提供'}</dd>
        </div>
        <div>
          <dt>成交量单位</dt>
          <dd>{market.baseAsset}</dd>
        </div>
        <div>
          <dt>OI</dt>
          <dd>{market.capabilities.hasOpenInterest ? '支持' : '不适用'}</dd>
        </div>
        <div>
          <dt>资金费率</dt>
          <dd>{market.capabilities.hasFundingRate ? '支持' : '不适用'}</dd>
        </div>
      </dl>
      <div className="market-form-grid">
        {roles.map(({ key, label, value }) => (
          <label key={key}>
            {label}
            <select
              name={key}
              defaultValue={intervals.includes(value) ? value : ''}
              required
            >
              <option value="" disabled>
                选择可用周期
              </option>
              {timeframeSchema.options.map((timeframe) => (
                <option
                  key={timeframe}
                  value={timeframe}
                  disabled={!intervals.includes(timeframe)}
                >
                  {timeframe}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <fieldset className="market-extra">
        <legend>额外观察周期</legend>
        <div className="market-checks">
          {timeframeSchema.options.map((timeframe) => (
            <label
              key={timeframe}
              title={market.intervalRestrictions[timeframe]}
            >
              <input
                type="checkbox"
                name="extra"
                value={timeframe}
                disabled={!intervals.includes(timeframe)}
                defaultChecked={monitor?.extra.includes(timeframe) ?? false}
              />
              {timeframe}
            </label>
          ))}
        </div>
      </fieldset>
      {Object.entries(market.intervalRestrictions).length > 0 && (
        <ul className="market-restrictions">
          {Object.entries(market.intervalRestrictions).map(
            ([timeframe, text]) => (
              <li key={timeframe}>
                <strong>{timeframe}</strong> {text}
              </li>
            ),
          )}
        </ul>
      )}
      <div className="market-actions">
        <label className="market-check">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={
              market.status === 'ACTIVE' && (monitor?.enabled ?? true)
            }
            disabled={market.status !== 'ACTIVE'}
          />
          保存后启用
        </label>
        <button
          type="submit"
          className="primary"
          disabled={pending || !intervals.length}
        >
          {monitor ? '保存设置' : '添加监控'}
        </button>
      </div>
    </form>
  );
}

function MonitorDetails({
  monitor,
  formatTime,
}: {
  monitor: Monitor;
  formatTime(time: number | null | undefined): string;
}) {
  const { quote, openInterest } = monitor;
  return (
    <div className="monitor-details">
      <dl className="market-facts">
        <div>
          <dt>最近成交</dt>
          <dd>
            {quote?.last?.value ?? '—'}
            <small>{formatTime(quote?.last?.timestampMs)}</small>
          </dd>
        </div>
        <div>
          <dt>标记价</dt>
          <dd>
            {quote?.mark?.value ?? '—'}
            <small>{formatTime(quote?.mark?.timestampMs)}</small>
          </dd>
        </div>
        <div>
          <dt>买一 / 卖一</dt>
          <dd>
            {quote?.bid?.value ?? '—'} / {quote?.ask?.value ?? '—'}
          </dd>
        </div>
        <div>
          <dt>点差</dt>
          <dd>
            {quote?.spread?.value ?? '—'}
            <small>{formatTime(quote?.spread?.timestampMs)}</small>
          </dd>
        </div>
        <div>
          <dt>OI · {interests[openInterest.state]}</dt>
          <dd>
            {openInterest.latest?.value ?? '—'}
            <small>{openInterest.latest?.unitDetails}</small>
            <small>{formatTime(openInterest.latest?.timestampMs)}</small>
          </dd>
        </div>
      </dl>
      <div className="market-table-wrap">
        <table className="market-table">
          <thead>
            <tr>
              <th>周期</th>
              <th>状态 / 缺口</th>
              <th>最近收盘</th>
              <th>开 / 高 / 低 / 收</th>
              <th>基础资产量 / 成交额</th>
              <th>盘中价</th>
            </tr>
          </thead>
          <tbody>
            {monitor.periods.map((period) => {
              const bar = period.lastClosed;
              return (
                <tr key={period.timeframe}>
                  <th scope="row">{period.timeframe}</th>
                  <td>
                    <span
                      data-state={
                        period.state === 'ACTIVE'
                          ? 'success'
                          : period.state === 'UNAVAILABLE' ||
                              period.state === 'DEGRADED'
                            ? 'error'
                            : undefined
                      }
                    >
                      {states[period.state]}
                    </span>
                    <small>
                      {period.validCandles} 根 · 缺口 {period.missingRecent}
                    </small>
                    {period.reason && (
                      <small>{reasons[period.reason] ?? period.reason}</small>
                    )}
                  </td>
                  <td>{formatTime(bar?.closeTimeMs)}</td>
                  <td>
                    {bar
                      ? [bar.open, bar.high, bar.low, bar.close].join(' / ')
                      : '—'}
                  </td>
                  <td>
                    {bar
                      ? (bar.baseVolume ?? '—') +
                        ' / ' +
                        (bar.quoteTurnover ?? '—')
                      : '—'}
                  </td>
                  <td>{period.preview?.close ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function MarketWorkspace() {
  const client = useQueryClient();
  const [filters, setFilters] = useState({
    exchange: '',
    type: '',
    q: '',
    offset: 0,
  });
  const [editor, setEditor] = useState<{
    marketId: string;
    monitorId?: string;
  } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const query = new URLSearchParams({
    offset: String(filters.offset),
    limit: '10',
  });
  if (filters.exchange) query.set('exchange', filters.exchange);
  if (filters.type) query.set('type', filters.type);
  if (filters.q.trim()) query.set('q', filters.q.trim());
  const catalog = useQuery({
    queryKey: [...marketsKey, 'catalog', query.toString()],
    queryFn: () =>
      request(
        api + '/markets?' + query.toString(),
        marketListResponseSchema.parse,
      ),
    refetchInterval: 10_000,
  });
  const monitors = useQuery({
    queryKey: [...marketsKey, 'monitors'],
    queryFn: () => request(api + '/monitors', monitorsResponseSchema.parse),
    refetchInterval: 5_000,
  });
  const diagnostics = useQuery({
    queryKey: [...marketsKey, 'diagnostics'],
    queryFn: () =>
      request(api + '/diagnostics', diagnosticsResponseSchema.parse),
    refetchInterval: 5_000,
  });
  const detail = useQuery({
    queryKey: [...marketsKey, 'detail', editor?.marketId],
    queryFn: () =>
      request(api + '/markets/' + editor?.marketId, marketResponseSchema.parse),
    enabled: editor !== null,
  });
  const action = useMutation({
    mutationFn: ({
      path,
      method,
      body,
      parse,
    }: {
      path: string;
      method: string;
      body?: unknown;
      parse(value: unknown): unknown;
    }) =>
      request(api + path, parse, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: marketsKey });
    },
  });
  const list = monitors.data?.data ?? [];
  const chosen = list
    .filter((item) => selected.includes(item.id))
    .map(({ id }) => id);
  const timeFormat = new Intl.DateTimeFormat('zh-CN', {
    timeZone: diagnostics.data?.data.timeZone ?? 'Asia/Kuala_Lumpur',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const formatTime = (value: number | null | undefined) =>
    value == null ? '—' : timeFormat.format(value);
  const busy = action.isPending;

  function batch(enabled: boolean) {
    action.mutate(
      {
        path: '/monitors/batch',
        method: 'PATCH',
        body: { ids: chosen, enabled },
        parse: monitorsResponseSchema.parse,
      },
      { onSuccess: () => setSelected([]) },
    );
  }

  function editMarket(marketId: string, monitorId?: string) {
    action.reset();
    setEditor({ marketId, monitorId });
  }

  return (
    <>
      <section className="status-grid provider-grid" aria-label="行情来源">
        {diagnostics.data?.data.providers.map((provider) => (
          <div key={provider.exchange} className="panel status-card">
            <h2>{exchangeName(provider.exchange)}</h2>
            <p
              role="status"
              data-state={
                provider.connection === 'CONNECTED' ? 'success' : undefined
              }
            >
              {connections[provider.connection]}
            </p>
            <div className="provider-metrics">
              <span>订阅 {provider.subscriptions}</span>
              <span>重连 {provider.reconnects}</span>
              <span>最近推送 {formatTime(provider.lastMessageAtMs)}</span>
              {provider.lastRestLatencyMs !== null && (
                <span>REST {provider.lastRestLatencyMs} ms</span>
              )}
            </div>
            <small>
              目录同步 {formatTime(provider.catalog.lastSyncAtMs)}
              {provider.catalog.failedPartitions.length > 0 &&
                ' · 失败 ' + provider.catalog.failedPartitions.join('、')}
            </small>
            {(provider.lastSocketError || provider.lastRestError) && (
              <small className="error">
                {[provider.lastSocketError, provider.lastRestError]
                  .filter(Boolean)
                  .map((reason) => reasons[reason!] ?? reason)
                  .join(' · ')}
              </small>
            )}
          </div>
        ))}
        {diagnostics.isPending && <p role="status">正在读取行情来源…</p>}
        {diagnostics.isError && (
          <p className="error" role="alert">
            {diagnostics.error.message}
          </p>
        )}
      </section>
      {action.isError && (
        <p className="error market-message" role="alert">
          {action.error.message}
        </p>
      )}
      <div className="market-layout">
        <section
          className="panel market-panel"
          aria-labelledby="monitor-list-heading"
        >
          <div className="market-section-heading">
            <h2 id="monitor-list-heading">监控列表</h2>
            <div className="market-actions">
              <button
                type="button"
                disabled={busy || !chosen.length}
                onClick={() => batch(true)}
              >
                批量启用
              </button>
              <button
                type="button"
                disabled={busy || !chosen.length}
                onClick={() => batch(false)}
              >
                批量暂停
              </button>
            </div>
          </div>
          {monitors.isPending && <p role="status">正在读取监控配置…</p>}
          {monitors.isError && (
            <p className="error" role="alert">
              {monitors.error.message}
            </p>
          )}
          {monitors.isSuccess && !list.length && (
            <p className="market-meta">从市场目录选择交易对开始监控。</p>
          )}
          <div className="monitor-list">
            {list.map((item) => (
              <article className="monitor-card" key={item.id}>
                <div className="monitor-title">
                  <label className="market-check">
                    <input
                      type="checkbox"
                      checked={selected.includes(item.id)}
                      aria-label={'选择 ' + item.market.nativeSymbol}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, item.id]
                            : current.filter((id) => id !== item.id),
                        )
                      }
                    />
                    <span>
                      <strong>{item.market.nativeSymbol}</strong>
                      <small>
                        {exchangeName(item.market.exchange)} ·{' '}
                        {productName(item.market)} ·{' '}
                        {item.enabled ? '已启用' : '已暂停'}
                      </small>
                    </span>
                  </label>
                  <div className="market-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => editMarket(item.market.id, item.id)}
                    >
                      设置
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        action.mutate({
                          path: '/monitors/' + item.id,
                          method: 'PATCH',
                          body: { enabled: !item.enabled },
                          parse: monitorResponseSchema.parse,
                        })
                      }
                    >
                      {item.enabled ? '暂停' : '启用'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        action.mutate(
                          {
                            path: '/monitors/' + item.id,
                            method: 'DELETE',
                            parse: () => undefined,
                          },
                          {
                            onSuccess: () => {
                              if (editor?.monitorId === item.id)
                                setEditor(null);
                            },
                          },
                        )
                      }
                    >
                      删除
                    </button>
                  </div>
                </div>
                <MonitorDetails monitor={item} formatTime={formatTime} />
              </article>
            ))}
          </div>
        </section>
        <section
          className="panel market-panel"
          aria-labelledby="catalog-heading"
        >
          <div className="market-section-heading">
            <h2 id="catalog-heading">市场目录</h2>
            <button
              type="button"
              disabled={busy || diagnostics.data?.data.syncing}
              onClick={() =>
                action.mutate({
                  path: '/markets/sync',
                  method: 'POST',
                  parse: syncResponseSchema.parse,
                })
              }
            >
              {diagnostics.data?.data.syncing ? '同步中…' : '同步目录'}
            </button>
          </div>
          <div className="market-filters">
            <label>
              搜索
              <input
                type="search"
                value={filters.q}
                maxLength={100}
                placeholder="符号或基础资产"
                onChange={(event) =>
                  setFilters({ ...filters, offset: 0, q: event.target.value })
                }
              />
            </label>
            <label>
              交易所
              <select
                value={filters.exchange}
                onChange={(event) =>
                  setFilters({
                    ...filters,
                    offset: 0,
                    exchange: event.target.value,
                  })
                }
              >
                <option value="">全部</option>
                <option value="BITGET">Bitget</option>
                <option value="HYPERLIQUID">Hyperliquid</option>
              </select>
            </label>
            <label>
              类型
              <select
                value={filters.type}
                onChange={(event) =>
                  setFilters({
                    ...filters,
                    offset: 0,
                    type: event.target.value,
                  })
                }
              >
                <option value="">全部</option>
                <option value="SPOT">现货</option>
                <option value="PERP">永续</option>
              </select>
            </label>
          </div>
          {editor && detail.isPending && <p role="status">正在核验可用周期…</p>}
          {editor && detail.isError && (
            <p className="error" role="alert">
              {detail.error.message}
            </p>
          )}
          {editor && detail.isSuccess && (
            <MarketEditor
              key={editor.marketId + '/' + editor.monitorId}
              market={detail.data.data}
              monitor={list.find(({ id }) => id === editor.monitorId)}
              pending={busy}
              onCancel={() => setEditor(null)}
              onSave={(body) =>
                action.mutate(
                  {
                    path: editor.monitorId
                      ? '/monitors/' + editor.monitorId
                      : '/monitors',
                    method: editor.monitorId ? 'PATCH' : 'POST',
                    body,
                    parse: monitorResponseSchema.parse,
                  },
                  { onSuccess: () => setEditor(null) },
                )
              }
            />
          )}
          {catalog.isPending && <p role="status">正在读取市场目录…</p>}
          {catalog.isError && (
            <p className="error" role="alert">
              {catalog.error.message}
            </p>
          )}
          {catalog.isSuccess && catalog.data.data.items.length === 0 && (
            <p className="market-meta">没有匹配的市场。</p>
          )}
          <div className="catalog-list">
            {catalog.data?.data.items.map((market) => {
              const monitor = list.find((item) => item.market.id === market.id);
              return (
                <div className="catalog-row" key={market.id}>
                  <div>
                    <strong>{market.nativeSymbol}</strong>
                    <small>
                      {exchangeName(market.exchange)} · {productName(market)} ·{' '}
                      {market.quoteAsset ?? '计价未知'}
                      {market.stale ? ' · 目录陈旧' : ''}
                    </small>
                  </div>
                  <button
                    type="button"
                    disabled={!monitor && market.status !== 'ACTIVE'}
                    onClick={() => editMarket(market.id, monitor?.id)}
                  >
                    {monitor
                      ? '设置'
                      : market.status === 'ACTIVE'
                        ? '选择'
                        : '不可用'}
                  </button>
                </div>
              );
            })}
          </div>
          {(filters.offset > 0 || catalog.data?.data.nextOffset != null) && (
            <div className="market-actions">
              <button
                type="button"
                disabled={filters.offset === 0}
                onClick={() =>
                  setFilters({
                    ...filters,
                    offset: Math.max(0, filters.offset - 10),
                  })
                }
              >
                上一页
              </button>
              <button
                type="button"
                disabled={catalog.data?.data.nextOffset == null}
                onClick={() =>
                  setFilters({
                    ...filters,
                    offset: catalog.data?.data.nextOffset ?? filters.offset,
                  })
                }
              >
                下一页
              </button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
