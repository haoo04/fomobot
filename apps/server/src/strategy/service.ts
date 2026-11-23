import type {
  MonitorStrategy,
  StrategyEvaluation,
} from '@market-sentinel/contracts/strategies';
import type { Candle, MarketType, Timeframe } from '@market-sentinel/domain';
import { and, eq, gte, lte } from 'drizzle-orm';
import type { AppDatabase } from '../database.js';
import { duration, warmupMinimum, warmupTarget } from '../market-data/model.js';
import type { MarketData } from '../market-data/service.js';
import {
  marketById,
  readCandles,
  type MonitorRow,
} from '../market-data/store.js';
import { monitorConfigs, oiSnapshots } from '../schema.js';
import {
  closedHistory,
  evaluateRisk,
  oiChange,
  oiToleranceMs,
  reject,
  trendSetup,
  triggerTurnover,
  type RiskResult,
} from './evaluate.js';
import { saveCandidates, strategyConfiguration } from './store.js';

type StrategyMarketData = Pick<
  MarketData,
  'now' | 'view' | 'onCandleClosed' | 'strategyMarket'
>;

export function createStrategyService(
  db: AppDatabase,
  marketData: StrategyMarketData,
  onError: () => void,
) {
  const pending = new Map<string, { monitor: MonitorRow; candle: Candle }>();
  const latest = new Map<
    string,
    { afterMs: number; evaluation: StrategyEvaluation }
  >();
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  function enqueue(candle: Candle) {
    try {
      if (
        !candle.isClosed ||
        candle.baseVolume === null ||
        candle.closeTimeMs > marketData.now()
      )
        return;
      const monitor = db
        .select()
        .from(monitorConfigs)
        .where(eq(monitorConfigs.marketId, candle.marketId))
        .get();
      if (
        !monitor?.enabled ||
        !monitor.strategyEnabled ||
        monitor.trigger !== candle.timeframe ||
        candle.closeTimeMs <= monitor.strategyAfterMs
      )
        return;
      pending.set(
        candle.marketId + '/' + candle.timeframe + '/' + candle.openTimeMs,
        { monitor, candle },
      );
    } catch {
      onError();
    }
  }

  function assess(monitor: MonitorRow, candle: Candle, atMs: number) {
    const closeMs = candle.closeTimeMs;
    function record(
      outcome: StrategyEvaluation['outcome'],
      reasonCode: string | null,
      time = atMs,
    ) {
      latest.set(monitor.id, {
        afterMs: monitor.strategyAfterMs,
        evaluation: {
          atMs: time,
          triggerCloseMs: closeMs,
          outcome,
          reasonCode,
        },
      });
      return outcome !== 'WAITING';
    }
    const row = marketById(db, candle.marketId);
    if (!row) return record('REJECTED', 'REJECT_MARKET_UNAVAILABLE');
    const config = strategyConfiguration(db, monitor, row.marketType);
    const { params } = config;
    const expired = atMs - closeMs > params.risk.maxAgeSeconds * 1000;

    let waiting = false;
    function history(timeframe: Timeframe, required: number) {
      const rows = readCandles(db, row!.id, timeframe, warmupTarget, closeMs);
      const size = duration[timeframe];
      const target = Math.floor(closeMs / size) * size;
      if (rows[0]?.closeTimeMs !== target) {
        waiting = true;
        return { bars: null, reason: 'REJECT_INCOMPLETE_CANDLE' };
      }
      return closedHistory(
        rows,
        row!.id,
        timeframe,
        closeMs,
        Math.max(required, warmupMinimum),
      );
    }

    const trigger = history(
      monitor.trigger,
      Math.max(
        params.emaPeriods[0],
        params.volume.lookback + 1,
        params.atr.period + 1,
        params.risk.swingLookback,
      ),
    );
    const confirm = history(monitor.confirm, params.rsi.period + 2);
    const trend = history(monitor.trend, params.emaPeriods[2]);
    if (waiting && !expired) return record('WAITING', 'AWAITING_CLOSE');
    if (!trigger.bars || !confirm.bars || !trend.bars)
      return record(
        'REJECTED',
        trigger.reason ?? confirm.reason ?? trend.reason,
      );

    const setup = trendSetup(
      row.marketType,
      params,
      trigger.bars,
      confirm.bars,
      trend.bars,
    );
    if (!setup) return record('REJECTED', 'REJECT_INDICATORS_UNAVAILABLE');
    if (!setup.directions.length) return record('NO_TRADE', null);

    const oi = params.oi
      ? oiChange(
          db
            .select()
            .from(oiSnapshots)
            .where(
              and(
                eq(oiSnapshots.marketId, row.id),
                gte(
                  oiSnapshots.timestampMs,
                  closeMs - params.oi.lookbackMinutes * 60_000 - oiToleranceMs,
                ),
                lte(oiSnapshots.timestampMs, closeMs),
              ),
            )
            .all(),
          params.oi,
          closeMs,
          atMs,
        )
      : null;
    if (
      oi?.deltaPct != null &&
      params.oi &&
      oi.deltaPct < params.oi.minIncreasePct
    )
      return record('NO_TRADE', 'OI_BELOW_THRESHOLD');

    const market = marketData.view(row);
    const { available, quote } = marketData.strategyMarket(row.id);
    const canEvaluate =
      available &&
      market.status === 'ACTIVE' &&
      !market.stale &&
      [monitor.trigger, monitor.confirm, monitor.trend].every((timeframe) =>
        market.capabilities.intervals.includes(timeframe),
      );
    const triggerBar = trigger.bars.at(-1)!;
    const proposals = setup.directions.map((direction) => {
      let risk: RiskResult;
      if (expired) risk = reject('REJECT_STALE_DATA');
      else if (!canEvaluate) risk = reject('REJECT_MARKET_UNAVAILABLE');
      else if (params.oi && oi?.deltaPct == null)
        risk = reject('REJECT_OI_UNAVAILABLE');
      else if (direction === 'BEARISH_WATCH')
        risk = { outcome: 'WATCH_ONLY', reasonCode: null, levels: null };
      else
        risk = evaluateRisk(
          market,
          quote,
          trigger.bars,
          setup.indicators.atr,
          direction,
          params,
          atMs,
        );
      return { direction, risk };
    });
    const [result] = saveCandidates(
      db,
      triggerBar,
      monitor,
      config,
      proposals,
      {
        market: {
          exchange: market.exchange,
          marketType: market.marketType,
          productType: market.productType,
          venue: market.venue,
          symbol: market.nativeSymbol,
          quoteAsset: market.quoteAsset,
          isReality: market.isReality,
          isRwa: market.isRwa,
          status: market.status,
          stale: market.stale,
          pricePrecision: market.pricePrecision,
          tickSize: market.tickSize,
          restrictions: market.capabilities.restrictions,
        },
        candles: {
          trigger: {
            firstOpenMs: trigger.bars[0]!.openTimeMs,
            count: trigger.bars.length,
            last: triggerBar,
            previous: trigger.bars.at(-2),
          },
          confirm: {
            firstOpenMs: confirm.bars[0]!.openTimeMs,
            count: confirm.bars.length,
            last: confirm.bars.at(-1),
          },
          trend: {
            firstOpenMs: trend.bars[0]!.openTimeMs,
            count: trend.bars.length,
            last: trend.bars.at(-1),
          },
        },
        indicators: setup.indicators,
        turnover: triggerTurnover(triggerBar),
        quote,
        openInterest: oi,
      },
      atMs,
    );
    return record(result!.outcome, result!.reasonCode, result!.atMs);
  }

  function tick() {
    const waiting = new Set<string>();
    for (const [key, { monitor, candle }] of [...pending].sort(
      (a, b) => a[1].candle.closeTimeMs - b[1].candle.closeTimeMs,
    )) {
      if (waiting.has(monitor.id)) continue;
      const atMs = marketData.now();
      try {
        const current = db
          .select()
          .from(monitorConfigs)
          .where(eq(monitorConfigs.id, monitor.id))
          .get();
        if (
          current?.enabled &&
          current.strategyEnabled &&
          monitor.strategyAfterMs === current.strategyAfterMs &&
          monitor.strategyConfigVersionId === current.strategyConfigVersionId &&
          monitor.trigger === current.trigger &&
          monitor.confirm === current.confirm &&
          monitor.trend === current.trend &&
          !assess(current, candle, atMs)
        ) {
          waiting.add(monitor.id);
          continue;
        }
      } catch {
        latest.set(monitor.id, {
          afterMs: monitor.strategyAfterMs,
          evaluation: {
            atMs,
            triggerCloseMs: candle.closeTimeMs,
            outcome: 'REJECTED',
            reasonCode: 'EVALUATION_FAILED',
          },
        });
        onError();
      }
      pending.delete(key);
    }
  }

  return {
    start() {
      if (unsubscribe) return;
      unsubscribe = marketData.onCandleClosed(enqueue);
      timer = setInterval(tick, 1000);
      timer.unref();
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      clearInterval(timer);
      pending.clear();
    },
    describe(monitor: MonitorRow, marketType: MarketType): MonitorStrategy {
      const { strategyId, strategyVersion, algorithmVersion, params } =
        strategyConfiguration(db, monitor, marketType);
      const last = latest.get(monitor.id);
      return {
        strategyId,
        strategyVersion,
        algorithmVersion,
        params,
        enabled: monitor.strategyEnabled,
        versionId: monitor.strategyConfigVersionId,
        latest:
          monitor.enabled &&
          monitor.strategyEnabled &&
          last?.afterMs === monitor.strategyAfterMs
            ? last.evaluation
            : null,
      };
    },
    forget(monitorId: string) {
      latest.delete(monitorId);
      for (const [key, { monitor }] of pending)
        if (monitor.id === monitorId) pending.delete(key);
    },
    tick,
  };
}

export type StrategyService = ReturnType<typeof createStrategyService>;
