import type {
  Market,
  MarketQuote,
  Monitor,
  MonitorConfig,
  ProviderDiagnostics,
} from '@market-sentinel/contracts/markets';
import {
  EXCHANGES,
  TIMEFRAMES,
  type Candle,
  type ExchangeId,
  type Timeframe,
} from '@market-sentinel/domain';
import { and, eq, ne } from 'drizzle-orm';
import type { AppDatabase } from '../database.js';
import { markets } from '../schema.js';
import { createBitgetProvider } from './bitget.js';
import { createHyperliquidProvider } from './hyperliquid.js';
import {
  aggregateRealityCandles,
  closeCutoff,
  duration,
  mergeQuote,
  monitoredTimeframes,
  normalizeCandle,
  warmupMinimum,
  warmupTarget,
} from './model.js';
import type {
  MarketEvent,
  MarketProvider,
  QuoteField,
  QuoteUpdate,
  RequestPriority,
} from './model.js';
import {
  configuredMarkets,
  latestOi,
  latestQuote,
  marketById,
  readCandles,
  saveCatalog,
  saveOi,
  saveQuote,
  storeCandles,
} from './store.js';
import type { MarketRow } from './store.js';
import {
  createMarketSocket,
  createRestQueue,
  providerError,
  type SocketFactory,
} from './transport.js';

const syncIntervalMs = 6 * 60 * 60_000;
const sampleIntervalMs = 60_000;
const missingWindow = 20;
const periodKey = (marketId: string, timeframe: Timeframe) =>
  marketId + '/' + timeframe;

interface History {
  lastClosed: Candle | null;
  validCandles: number;
  missingRecent: number;
  firstMissing: number | null;
}

interface Series extends History {
  market: Market;
  timeframe: Timeframe;
  preview: Candle | null;
  previewAt: number;
  needsBackfill: boolean;
  reconnecting: boolean;
  generation: number;
  pending: boolean;
  confirmedThrough: number;
  retryAt: number;
  repairAt: number;
  reason: string | null;
}

interface QuoteState {
  quote: MarketQuote;
  observed: Partial<Record<QuoteField, number>>;
  dirty: boolean;
  savedAt: number;
  nextFetch: number;
  pending: boolean;
}

const specialPeriod = (
  market: Pick<Market, 'exchange' | 'isReality'>,
  timeframe: Timeframe,
) =>
  market.exchange === 'BITGET' &&
  (timeframe === '1d' || (market.isReality && timeframe === '3m'));

const unverifiedReason = (timeframe: Timeframe) =>
  timeframe === '1d'
    ? 'Bitget 日线等待 REST 验证 UTC 边界。'
    : 'Reality 3m 等待验证连续且成交量完整的 REST 1m。';

const unavailableReason = (timeframe: Timeframe) =>
  timeframe === '1d'
    ? 'Bitget 日线缺少可验证的 UTC 对齐数据。'
    : 'Reality 3m 缺少三根连续且成交量完整的 REST 1m。';

interface Settings {
  fetcher?: typeof fetch;
  socketFactory?: SocketFactory;
  now?: () => number;
}

export function createMarketData(
  database: AppDatabase,
  settings: Settings = {},
) {
  const now = settings.now ?? Date.now;
  const series = new Map<string, Series>();
  const active = new Map<string, Market>();
  const wire = new Map<string, Market>();
  const quoteState = new Map<string, QuoteState>();
  const checks = new Map<string, { reason: string | null; until: number }>();
  const checking = new Map<string, Promise<void>>();
  const listeners = new Set<(candle: Candle) => void>();
  const tasks = new Set<Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let syncTask: Promise<void> | undefined;
  let nextSync = 0;
  let started = false;
  let stopped = false;

  const providers = Object.fromEntries(
    EXCHANGES.map((exchange) => {
      const rest = createRestQueue(exchange, settings.fetcher);
      const adapter =
        exchange === 'BITGET'
          ? createBitgetProvider(rest)
          : createHyperliquidProvider(rest);
      const socket = createMarketSocket(
        exchange,
        adapter.socket,
        (event) => onData(adapter, event),
        () => {
          for (const item of series.values()) {
            if (item.market.exchange !== exchange) continue;
            item.needsBackfill = true;
            item.reconnecting = true;
            item.generation++;
            item.retryAt = 0;
            item.preview = null;
            item.previewAt = 0;
          }
        },
        settings.socketFactory,
      );
      return [
        exchange,
        {
          adapter,
          rest,
          socket,
          nextSample: 0,
          sampling: false,
          catalog: {
            lastSyncAtMs: null,
            failedPartitions: [],
          } as ProviderDiagnostics['catalog'],
        },
      ] as const;
    }),
  ) as Record<
    ExchangeId,
    {
      adapter: MarketProvider;
      rest: ReturnType<typeof createRestQueue>;
      socket: ReturnType<typeof createMarketSocket>;
      nextSample: number;
      sampling: boolean;
      catalog: ProviderDiagnostics['catalog'];
    }
  >;

  function view(row: MarketRow): Market {
    const { updatedAtMs: _updated, ...market } = row;
    void _updated;
    const intervals: Timeframe[] = [];
    const intervalRestrictions: Market['intervalRestrictions'] = {};
    for (const timeframe of TIMEFRAMES) {
      if (specialPeriod(market, timeframe)) {
        const checked = checks.get(periodKey(market.id, timeframe));
        if (checked && checked.reason === null && checked.until > now())
          intervals.push(timeframe);
        else
          intervalRestrictions[timeframe] =
            checked?.reason ?? unverifiedReason(timeframe);
      } else if (market.capabilities.intervals.includes(timeframe)) {
        intervals.push(timeframe);
      } else {
        intervalRestrictions[timeframe] = '交易所不支持此周期。';
      }
    }
    return {
      ...market,
      capabilities: { ...market.capabilities, intervals },
      intervalRestrictions,
    };
  }

  async function periodCandles(
    market: Market,
    timeframe: Timeframe,
    from: number,
    to: number,
    priority: RequestPriority,
  ) {
    const adapter = providers[market.exchange].adapter;
    if (market.isReality && timeframe === '3m') {
      return aggregateRealityCandles(
        await adapter.candles(market, '1m', from, to, priority),
        from,
        to,
      );
    }
    return adapter.candles(market, timeframe, from, to, priority);
  }

  function rememberCheck(
    market: Market,
    timeframe: Timeframe,
    reason: string | null,
  ) {
    checks.set(periodKey(market.id, timeframe), {
      reason,
      until: now() + (reason ? sampleIntervalMs : syncIntervalMs),
    });
  }

  async function checkPeriods(
    row: MarketRow,
    timeframes: readonly Timeframe[] = TIMEFRAMES,
  ) {
    const market = view(row);
    if (market.status !== 'ACTIVE') return market;
    await Promise.all(
      timeframes
        .filter((timeframe) => specialPeriod(market, timeframe))
        .map((timeframe) => {
          const key = periodKey(market.id, timeframe);
          if ((checks.get(key)?.until ?? 0) > now()) return;
          const inProgress = checking.get(key);
          if (inProgress) return inProgress;
          const task = (async () => {
            const cutoff = closeCutoff(now(), timeframe);
            const size = duration[timeframe];
            const count = timeframe === '1d' ? 2 : 1;
            try {
              const result = await periodCandles(
                market,
                timeframe,
                cutoff - count * size,
                cutoff,
                'live',
              );
              const opens = new Set(result.map((bar) => bar.openTimeMs));
              rememberCheck(
                market,
                timeframe,
                opens.size === count ? null : unavailableReason(timeframe),
              );
            } catch (error) {
              const code = providerError(error);
              rememberCheck(
                market,
                timeframe,
                code === 'ACCESS_DENIED'
                  ? '交易所公开接口未返回此市场的权限。'
                  : unavailableReason(timeframe),
              );
            }
          })().finally(() => checking.delete(key));
          checking.set(key, task);
          return task;
        }),
    );
    return view(marketById(database, row.id) ?? row);
  }

  function loadHistory(
    market: Market,
    timeframe: Timeframe,
    cutoff: number,
  ): History {
    const bars = readCandles(database, market.id, timeframe, warmupTarget);
    const lastClosed = bars[0] ?? null;
    const size = duration[timeframe];
    const byOpen = new Set(bars.map(({ openTimeMs }) => openTimeMs));
    const oldest = bars.at(-1)?.openTimeMs ?? cutoff;
    let missingRecent = 0;
    let firstMissing: number | null = null;
    for (
      let open = Math.max(oldest, cutoff - missingWindow * size);
      open < cutoff;
      open += size
    ) {
      if (!byOpen.has(open)) {
        missingRecent++;
        firstMissing ??= open;
      }
    }
    return {
      lastClosed,
      missingRecent,
      firstMissing,
      validCandles: bars.filter((bar) => bar.baseVolume !== null).length,
    };
  }

  function canSchedule(market: Market, timeframe: Timeframe) {
    return (
      specialPeriod(market, timeframe) ||
      market.capabilities.intervals.includes(timeframe)
    );
  }

  function subscriptions(
    items: Array<{ market: Market; config: MonitorConfig }>,
    exchange: ExchangeId,
  ) {
    const adapter = providers[exchange].adapter;
    return items
      .filter(
        ({ market, config }) =>
          market.exchange === exchange &&
          market.status === 'ACTIVE' &&
          config.enabled,
      )
      .flatMap(({ market, config }) =>
        adapter.subscriptions(
          market,
          monitoredTimeframes(config).filter((timeframe) =>
            canSchedule(market, timeframe),
          ),
        ),
      );
  }

  function reconcile() {
    if (!started || stopped) return;
    const prior = new Set(active.keys());
    const candidates = configuredMarkets(database)
      .map(({ market, config }) => ({ market: view(market), config }))
      .filter(
        ({ market, config }) => market.status === 'ACTIVE' && config.enabled,
      )
      .sort(
        (a, b) =>
          Number(prior.has(b.market.id)) - Number(prior.has(a.market.id)),
      );
    const items: typeof candidates = [];
    const used: Record<ExchangeId, number> = { BITGET: 0, HYPERLIQUID: 0 };
    const next = new Set<string>();
    active.clear();
    wire.clear();
    for (const selected of candidates) {
      const { market, config } = selected;
      const provider = providers[market.exchange];
      const count = subscriptions([selected], market.exchange).length;
      if (used[market.exchange] + count > provider.adapter.socket.capacity)
        continue;
      used[market.exchange] += count;
      items.push(selected);
      active.set(market.id, market);
      wire.set(market.exchange + '/' + provider.adapter.key(market), market);
      if (!prior.has(market.id)) provider.nextSample = 0;
      for (const timeframe of monitoredTimeframes(config)) {
        if (!canSchedule(market, timeframe)) continue;
        const key = periodKey(market.id, timeframe);
        next.add(key);
        const existing = series.get(key);
        if (existing) {
          existing.market = market;
          continue;
        }
        series.set(key, {
          market,
          timeframe,
          ...loadHistory(market, timeframe, closeCutoff(now(), timeframe)),
          preview: null,
          previewAt: 0,
          needsBackfill: true,
          reconnecting: false,
          generation: 0,
          pending: false,
          confirmedThrough: 0,
          retryAt: 0,
          repairAt: 0,
          reason: null,
        });
      }
    }
    for (const key of series.keys()) if (!next.has(key)) series.delete(key);
    for (const [id, item] of quoteState) {
      if (!active.has(id)) {
        if (item.dirty) saveQuote(database, id, item.quote);
        quoteState.delete(id);
      }
    }
    for (const exchange of EXCHANGES) {
      providers[exchange].socket.setSubscriptions(
        subscriptions(items, exchange),
      );
    }
  }

  function getQuoteState(marketId: string): QuoteState {
    let entry = quoteState.get(marketId);
    if (!entry) {
      entry = {
        quote: latestQuote(database, marketId) ?? {
          last: null,
          mark: null,
          bid: null,
          ask: null,
          spread: null,
        },
        observed: {},
        dirty: false,
        savedAt: 0,
        nextFetch: 0,
        pending: false,
      };
      quoteState.set(marketId, entry);
    }
    return entry;
  }

  function quoteUpdate(market: Market, update: QuoteUpdate) {
    if (update.timestampMs > now() + sampleIntervalMs) return;
    const item = getQuoteState(market.id);
    mergeQuote(item.quote, item.observed, update);
    item.dirty = true;
  }

  function onData(adapter: MarketProvider, event: MarketEvent) {
    if (stopped) return;
    const market = wire.get(adapter.exchange + '/' + event.key);
    if (!market) return;
    if (event.kind === 'quote') {
      quoteUpdate(market, event.update);
      return;
    }
    const entry = series.get(periodKey(market.id, event.timeframe));
    if (!entry || entry.reconnecting) return;
    const stamp = event.timestampMs ?? now();
    const bar = normalizeCandle(market.id, event.timeframe, event.bar, 'WS');
    if (
      !bar ||
      bar.openTimeMs > now() ||
      bar.closeTimeMs <= closeCutoff(now(), event.timeframe) ||
      bar.openTimeMs <= (entry.lastClosed?.openTimeMs ?? -1) ||
      (entry.preview &&
        (bar.openTimeMs < entry.preview.openTimeMs ||
          (bar.openTimeMs === entry.preview.openTimeMs &&
            stamp < entry.previewAt)))
    )
      return;
    entry.preview = bar;
    entry.previewAt = stamp;
  }

  function runSync() {
    if (syncTask || stopped) return syncTask ?? Promise.resolve();
    nextSync = now() + syncIntervalMs;
    syncTask = Promise.all(
      EXCHANGES.map(async (exchange) => {
        const provider = providers[exchange];
        const failed: string[] = [];
        try {
          const knownVenues =
            exchange === 'HYPERLIQUID'
              ? database
                  .selectDistinct({ venue: markets.venue })
                  .from(markets)
                  .where(
                    and(
                      eq(markets.exchange, exchange),
                      ne(markets.venue, 'main'),
                    ),
                  )
                  .all()
                  .map(({ venue }) => venue)
              : [];
          const partitions = await provider.adapter.discover(knownVenues);
          if (stopped) return;
          for (const partition of partitions) {
            if (!saveCatalog(database, exchange, partition, now()))
              failed.push(partition.productType + '/' + partition.venue);
          }
          reconcile();
        } catch {
          if (stopped) return;
          database
            .update(markets)
            .set({ stale: true })
            .where(eq(markets.exchange, exchange))
            .run();
          failed.push('ALL');
          reconcile();
        } finally {
          provider.catalog = { lastSyncAtMs: now(), failedPartitions: failed };
        }
      }),
    )
      .then(() => undefined)
      .finally(() => {
        syncTask = undefined;
      });
    return syncTask;
  }

  function track(task: Promise<void>) {
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    );
    return task;
  }

  async function collect(key: string, item: Series, at: number) {
    const { market, timeframe, generation } = item;
    const socket = providers[market.exchange].socket;
    if (item.reconnecting && socket.diagnostics.connection !== 'CONNECTED')
      return;
    const cutoff = closeCutoff(at, timeframe);
    const size = duration[timeframe];
    const live = !item.needsBackfill && cutoff > item.confirmedThrough;
    const repair =
      !item.needsBackfill &&
      !live &&
      item.firstMissing !== null &&
      market.capabilities.sessionType === 'CONTINUOUS' &&
      at >= item.repairAt;
    if (!item.needsBackfill && !repair && !live) return;

    let from = cutoff - size;
    if (item.needsBackfill) {
      from = Math.min(
        cutoff - warmupTarget * size,
        item.lastClosed?.openTimeMs ?? cutoff,
      );
      if (market.exchange === 'HYPERLIQUID')
        from = Math.max(from, cutoff - 5_000 * size);
    } else if (repair) {
      from = item.firstMissing!;
    } else {
      from = Math.min(from, item.confirmedThrough);
    }
    item.pending = true;
    const current = () =>
      !stopped && series.get(key) === item && item.generation === generation;
    try {
      const bars = await periodCandles(
        market,
        timeframe,
        Math.max(0, from),
        cutoff,
        live ? 'live' : 'backfill',
      );
      if (!current()) return;
      const valid = bars.filter(
        (bar) => bar.isClosed && bar.closeTimeMs <= cutoff,
      );
      const inserted = storeCandles(database, valid);
      Object.assign(item, loadHistory(market, timeframe, cutoff));
      const latest =
        item.lastClosed?.closeTimeMs === cutoff ? item.lastClosed : null;
      if (specialPeriod(market, timeframe))
        rememberCheck(
          market,
          timeframe,
          latest ? null : unavailableReason(timeframe),
        );
      item.needsBackfill = false;
      item.reconnecting = false;
      item.confirmedThrough = latest ? cutoff : cutoff - size;
      item.repairAt = now() + sampleIntervalMs;
      item.retryAt = latest
        ? 0
        : now() +
          (specialPeriod(market, timeframe) ? sampleIntervalMs : 15_000);
      item.reason = !latest
        ? 'NO_RECENT_CANDLE'
        : latest.baseVolume === null
          ? 'MISSING_BASE_VOLUME'
          : null;
      if (item.preview && item.preview.closeTimeMs <= cutoff)
        item.preview = null;
      if (
        live &&
        socket.diagnostics.connection === 'CONNECTED' &&
        latest &&
        latest.closeTimeMs === closeCutoff(now(), timeframe) &&
        latest.baseVolume !== null &&
        inserted.has(latest.openTimeMs)
      ) {
        for (const listener of listeners) listener(latest);
      }
    } catch (error) {
      if (!current()) return;
      item.reason = providerError(error);
      item.retryAt = now() + (item.needsBackfill ? 30_000 : 15_000);
      if (specialPeriod(market, timeframe)) {
        rememberCheck(
          market,
          timeframe,
          item.reason === 'ACCESS_DENIED'
            ? '交易所公开接口未返回此市场的权限。'
            : unavailableReason(timeframe),
        );
      }
    } finally {
      item.pending = false;
    }
  }

  async function sample(exchange: ExchangeId, selected: Market[]) {
    const provider = providers[exchange];
    provider.sampling = true;
    provider.nextSample = now() + sampleIntervalMs;
    try {
      const values = await provider.adapter.openInterest(selected);
      if (!stopped)
        saveOi(
          database,
          values.filter(
            (value) =>
              active.has(value.marketId) &&
              value.timestampMs <= now() + sampleIntervalMs,
          ),
        );
    } finally {
      provider.sampling = false;
    }
  }

  async function fetchQuote(market: Market, entry: QuoteState) {
    entry.pending = true;
    entry.nextFetch = now() + 30_000;
    try {
      const update = await providers[market.exchange].adapter.quote(market);
      if (!stopped && quoteState.get(market.id) === entry && update)
        quoteUpdate(market, update);
    } catch {
      // REST and WS report connection state independently.
    } finally {
      entry.pending = false;
    }
  }

  async function tick() {
    if (!started || stopped) return;
    const at = now();
    const pending: Promise<void>[] = [];
    if (at >= nextSync && !syncTask) pending.push(runSync());
    for (const [key, item] of series) {
      if (!item.pending && at >= item.retryAt)
        pending.push(track(collect(key, item, at)));
    }
    for (const exchange of EXCHANGES) {
      const provider = providers[exchange];
      const selected = [...active.values()].filter(
        (market) =>
          market.exchange === exchange && market.marketType === 'PERP',
      );
      if (selected.length && !provider.sampling && at >= provider.nextSample)
        pending.push(track(sample(exchange, selected)));
    }
    for (const market of active.values()) {
      const entry = getQuoteState(market.id);
      if (entry.dirty && at - entry.savedAt >= 5_000) {
        saveQuote(database, market.id, entry.quote);
        entry.dirty = false;
        entry.savedAt = at;
      }
      if (
        !entry.pending &&
        at >= entry.nextFetch &&
        at - (entry.quote.spread?.timestampMs ?? 0) >= 30_000
      ) {
        pending.push(track(fetchQuote(market, entry)));
      }
    }
    await Promise.allSettled(pending);
  }

  function listMonitors(): Monitor[] {
    return configuredMarkets(database).map(({ market: row, config }) => {
      const market = view(row);
      const { marketId, ...settings } = config;
      const oi =
        market.marketType === 'PERP' ? latestOi(database, marketId) : null;
      return {
        ...settings,
        market,
        quote:
          quoteState.get(marketId)?.quote ?? latestQuote(database, marketId),
        openInterest: {
          state:
            market.marketType === 'SPOT'
              ? 'N/A'
              : !oi
                ? 'MISSING'
                : now() - oi.timestampMs > 180_000
                  ? 'STALE'
                  : 'FRESH',
          latest: oi,
        },
        periods: monitoredTimeframes(config).map((timeframe) => {
          const item = series.get(periodKey(marketId, timeframe));
          const history =
            item ??
            loadHistory(market, timeframe, closeCutoff(now(), timeframe));
          const rejected = market.intervalRestrictions[timeframe];
          const disconnected =
            providers[market.exchange].socket.diagnostics.connection !==
            'CONNECTED';
          const gap =
            history.missingRecent > 0 &&
            market.capabilities.sessionType === 'CONTINUOUS';
          let state: Monitor['periods'][number]['state'] = 'ACTIVE';
          let reason: string | null = item?.reason ?? null;
          if (!config.enabled) state = 'PAUSED';
          else if (market.status !== 'ACTIVE') {
            state = 'UNAVAILABLE';
            reason = 'MARKET_UNAVAILABLE';
          } else if (started && !active.has(market.id)) {
            state = 'DEGRADED';
            reason = 'SUBSCRIPTION_CAPACITY';
          } else if (
            rejected &&
            (!specialPeriod(market, timeframe) || item?.reason)
          ) {
            state = 'UNAVAILABLE';
            reason = rejected;
          } else if (item?.reconnecting) state = 'RECOVERING';
          else if (history.validCandles < warmupMinimum) state = 'WARMING';
          else if (disconnected || reason || gap) {
            state = 'DEGRADED';
            reason ??= disconnected
              ? 'WS_UNAVAILABLE'
              : 'MISSING_RECENT_CANDLES';
          }
          return {
            timeframe,
            state,
            reason,
            lastClosed: history.lastClosed,
            validCandles: history.validCandles,
            missingRecent: history.missingRecent,
            preview: item?.preview ?? null,
          };
        }),
      };
    });
  }

  return {
    view,
    checkPeriods,
    runSync,
    reconcile,
    tick,
    listMonitors,
    capacityExceeded(items: Array<{ market: Market; config: MonitorConfig }>) {
      return EXCHANGES.find(
        (exchange) =>
          subscriptions(items, exchange).length >
          providers[exchange].adapter.socket.capacity,
      );
    },
    diagnostics() {
      return {
        syncing: syncTask !== undefined,
        providers: EXCHANGES.map((exchange): ProviderDiagnostics => ({
          exchange,
          ...providers[exchange].rest.diagnostics,
          ...providers[exchange].socket.diagnostics,
          catalog: providers[exchange].catalog,
        })),
      };
    },
    onCandleClosed(listener: (candle: Candle) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (started || stopped) return;
      started = true;
      reconcile();
      void tick().catch(() => undefined);
      timer = setInterval(() => {
        void tick().catch(() => undefined);
      }, 1_000);
      timer.unref();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const provider of Object.values(providers)) {
        provider.socket.stop();
        provider.rest.stop();
      }
      await Promise.allSettled([...tasks, ...checking.values(), syncTask]);
      for (const [id, item] of quoteState)
        if (item.dirty) saveQuote(database, id, item.quote);
    },
  };
}

export type MarketData = ReturnType<typeof createMarketData>;
