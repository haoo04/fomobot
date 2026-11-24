import { startOfCalendarDay } from '@market-sentinel/contracts';
import { diagnosticsResponseSchema } from '@market-sentinel/contracts/markets';
import {
  signalResponseSchema,
  signalsResponseSchema,
  signalSummaryResponseSchema,
} from '@market-sentinel/contracts/strategies';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { request, requestResponse } from './api';
import { deliveryLabels } from './NotificationSettings';
import {
  directions,
  outcomes,
  SignalAudit,
  theoryLabels,
} from './StrategyPanel';

const path = '/api/v1/signals';
const queryKey = ['signal-history'];
const exchanges = { BITGET: 'Bitget', HYPERLIQUID: 'Hyperliquid' };
const finalStates = { PASSED: '通过', REJECTED: '拒绝', SUPPRESSED: '抑制' };
const preStates = {
  PASSED: outcomes.PASSED,
  REJECTED: outcomes.REJECTED,
  SUPPRESSED: outcomes.SUPPRESSED,
  WATCH_ONLY: outcomes.WATCH_ONLY,
};
const strategies = {
  'trend-pullback': '永续趋势回调',
  'spot-trend-pullback': '现货趋势回调',
};

function options(values: Record<string, string>) {
  return Object.entries(values).map(([value, label]) => (
    <option key={value} value={value}>
      {label}
    </option>
  ));
}

export function SignalHistory({
  initialCandidateId,
}: {
  initialCandidateId: string | null;
}) {
  const client = useQueryClient();
  const [filter, setFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(initialCandidateId);
  const zone = useQuery({
    queryKey: [...queryKey, 'timezone'],
    queryFn: () =>
      request('/api/v1/diagnostics', diagnosticsResponseSchema.parse),
    staleTime: 60_000,
  });
  const timeZone = zone.data?.data.timeZone;
  const dates = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timeZone ?? 'Asia/Kuala_Lumpur',
    dateStyle: 'short',
    timeStyle: 'medium',
  });
  const formatTime = (time: number | null) =>
    time === null ? '—' : dates.format(time);
  const history = useQuery({
    queryKey: [...queryKey, 'list', filter, offset],
    queryFn: () =>
      request(
        path + '?offset=' + offset + (filter ? '&' + filter : ''),
        signalsResponseSchema.parse,
      ),
    refetchInterval: 5_000,
  });
  const summary = useQuery({
    queryKey: [...queryKey, 'summary', filter],
    queryFn: () =>
      request(path + '/summary?' + filter, signalSummaryResponseSchema.parse),
    refetchInterval: 10_000,
  });
  const detail = useQuery({
    queryKey: [...queryKey, 'detail', selected],
    queryFn: () => request(path + '/' + selected, signalResponseSchema.parse),
    enabled: selected !== null,
    refetchInterval: selected ? 3_000 : false,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      request(path + '/' + id, () => undefined, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: async () => {
      setSelected(null);
      setOffset(0);
      await client.invalidateQueries({ queryKey });
    },
  });
  const download = useMutation({
    mutationFn: async (format: 'csv' | 'json') => {
      const response = await requestResponse(
        path + '/export?format=' + format + (filter ? '&' + filter : ''),
      );
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'market-sentinel-signals.' + format;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    for (const name of [
      'q',
      'exchange',
      'strategyId',
      'state',
      'finalState',
      'deliveryState',
      'theoryState',
    ]) {
      const value = String(values.get(name) ?? '').trim();
      if (value) params.set(name, value);
    }
    const from = String(values.get('from') ?? '');
    const to = String(values.get('to') ?? '');
    if (timeZone && from)
      params.set('fromMs', String(startOfCalendarDay(from, timeZone)));
    if (timeZone && to) {
      const nextDay = new Date(Date.parse(to + 'T00:00:00Z') + 86_400_000)
        .toISOString()
        .slice(0, 10);
      params.set('toMs', String(startOfCalendarDay(nextDay, timeZone)));
    }
    setFilter(params.toString());
    setOffset(0);
    setSelected(null);
  }

  const page = history.data?.data;
  const signal = detail.data?.data;
  return (
    <>
      <section className="panel market-editor" aria-label="筛选信号历史">
        <form onSubmit={submit}>
          <div className="market-form-grid">
            <label>
              市场或 ID
              <input
                name="q"
                maxLength={128}
                placeholder="市场符号、候选 ID 或信号 ID"
              />
            </label>
            <label>
              交易所
              <select name="exchange">
                <option value="">全部</option>
                {options(exchanges)}
              </select>
            </label>
            <label>
              策略
              <select name="strategyId">
                <option value="">全部</option>
                {options(strategies)}
              </select>
            </label>
            <label>
              预风控
              <select name="state">
                <option value="">全部</option>
                {options(preStates)}
              </select>
            </label>
            <label>
              最终风控
              <select name="finalState">
                <option value="">全部</option>
                {options(finalStates)}
              </select>
            </label>
            <label>
              Telegram 送达
              <select name="deliveryState">
                <option value="">全部</option>
                {options(deliveryLabels)}
              </select>
            </label>
            <label>
              理论状态
              <select name="theoryState">
                <option value="">全部</option>
                {options(theoryLabels)}
              </select>
            </label>
            <label>
              起始日期
              <input
                name="from"
                type="date"
                min="1970-01-01"
                max="9999-12-30"
                disabled={!timeZone}
              />
            </label>
            <label>
              结束日期
              <input
                name="to"
                type="date"
                min="1970-01-01"
                max="9999-12-30"
                disabled={!timeZone}
              />
            </label>
          </div>
          <div className="market-actions">
            <button type="submit" className="primary">
              筛选
            </button>
            <button
              type="reset"
              onClick={() => {
                setFilter('');
                setOffset(0);
                setSelected(null);
              }}
            >
              重置
            </button>
            <button
              type="button"
              disabled={download.isPending}
              onClick={() => download.mutate('csv')}
            >
              导出 CSV
            </button>
            <button
              type="button"
              disabled={download.isPending}
              onClick={() => download.mutate('json')}
            >
              导出 JSON
            </button>
            {timeZone && <span className="market-meta">{timeZone}</span>}
          </div>
        </form>
        {(download.error || zone.error) && (
          <p role="alert" className="error">
            {(download.error ?? zone.error)?.message}
          </p>
        )}
      </section>

      <section className="panel market-editor" aria-label="信号查询结果">
        {history.isPending && <p role="status">正在读取历史…</p>}
        {history.isError && (
          <p role="alert" className="error">
            {history.error.message}
          </p>
        )}
        {page?.items.length === 0 && <p>当前筛选范围内没有候选记录。</p>}
        {!!page?.items.length && (
          <div className="market-table-wrap">
            <table className="market-table">
              <thead>
                <tr>
                  <th>市场</th>
                  <th>触发收盘</th>
                  <th>策略</th>
                  <th>方向</th>
                  <th>风控</th>
                  <th>送达</th>
                  <th>理论表现</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <button
                        type="button"
                        aria-pressed={selected === item.id}
                        onClick={() => {
                          setSelected(selected === item.id ? null : item.id);
                          remove.reset();
                        }}
                      >
                        {item.market.nativeSymbol}
                      </button>
                      <small className="history-meta">
                        {exchanges[item.exchange]} · {item.market.productType}
                        {item.market.venue !== 'main' &&
                          ' · ' + item.market.venue}
                      </small>
                    </td>
                    <td>
                      {formatTime(item.triggerCloseMs)}
                      <small className="history-meta">
                        {item.triggerTimeframe}
                      </small>
                    </td>
                    <td>
                      {item.strategyId}
                      <small className="history-meta">
                        v{item.strategyVersion}
                      </small>
                    </td>
                    <td>{directions[item.direction]}</td>
                    <td>
                      {item.finalRisk
                        ? (finalStates[
                            item.finalRisk.outcome as keyof typeof finalStates
                          ] ?? outcomes[item.finalRisk.outcome])
                        : outcomes[item.outcome]}
                    </td>
                    <td>
                      {item.delivery
                        ? deliveryLabels[item.delivery.status]
                        : '—'}
                    </td>
                    <td>
                      {item.theory ? theoryLabels[item.theory.state] : '—'}
                      {item.theory?.waitingForData && (
                        <small className="history-meta">行情待回补</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page && (offset > 0 || page.nextOffset !== null) && (
          <div className="market-actions">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => {
                setOffset(Math.max(0, offset - 20));
                setSelected(null);
              }}
            >
              上一页
            </button>
            <button
              type="button"
              disabled={page.nextOffset === null}
              onClick={() => {
                setOffset(page.nextOffset ?? offset);
                setSelected(null);
              }}
            >
              下一页
            </button>
          </div>
        )}
        {selected && detail.isPending && <p role="status">正在读取候选详情…</p>}
        {selected && detail.isError && (
          <p role="alert" className="error">
            {detail.error.message}
          </p>
        )}
        {signal && (
          <>
            <SignalAudit
              signal={signal}
              formatTime={formatTime}
              queryKey={queryKey}
            />
            {signal.canDelete && (
              <button
                type="button"
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm('永久删除此候选及其关联记录？'))
                    remove.mutate(signal.id);
                }}
              >
                删除历史记录
              </button>
            )}
          </>
        )}
        {remove.error && (
          <p role="alert" className="error">
            {remove.error.message}
          </p>
        )}
      </section>

      <section className="panel market-editor" aria-label="分组统计">
        <h2>策略与交易所汇总</h2>
        {summary.isPending && <p role="status">正在读取汇总…</p>}
        {summary.isError && (
          <p role="alert" className="error">
            {summary.error.message}
          </p>
        )}
        {summary.data?.data.length === 0 && <p>暂无可汇总数据。</p>}
        {!!summary.data?.data.length && (
          <div className="market-table-wrap">
            <table className="market-table">
              <thead>
                <tr>
                  <th>交易所与策略</th>
                  <th>候选 / 批准 / 拒绝</th>
                  <th>已送达</th>
                  <th>做多 / 做空</th>
                  <th>AI 接受 / 修改 / 拒绝</th>
                  <th>TP1–TP4 / SL</th>
                  <th>覆盖不足</th>
                  <th>平均理论 R</th>
                </tr>
              </thead>
              <tbody>
                {summary.data.data.map((group) => (
                  <tr key={group.exchange + '/' + group.strategyId}>
                    <td>
                      {exchanges[group.exchange]} · {group.strategyId}
                    </td>
                    <td>
                      {group.candidates} / {group.approved} / {group.rejected}
                    </td>
                    <td>{group.sent}</td>
                    <td>
                      {group.longs} / {group.shorts}
                    </td>
                    <td>
                      {group.aiAccepted} / {group.aiModified} /{' '}
                      {group.aiRejected}
                    </td>
                    <td>
                      {group.targetHits.join(' / ')} / {group.stopHits}
                    </td>
                    <td>{group.insufficientData}</td>
                    <td>
                      {group.averageGrossR === null
                        ? '—'
                        : group.averageGrossR.toFixed(2)}
                      <small className="history-meta">
                        {group.completed} 条完整结算
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
