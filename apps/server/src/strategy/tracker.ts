import {
  EXCHANGES,
  MARKET_TYPES,
  type Timeframe,
} from '@market-sentinel/domain';
import type { RiskLevels } from '@market-sentinel/contracts/strategies';
import { Decimal } from 'decimal.js';
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { AppDatabase } from '../database.js';
import {
  closeCutoff,
  duration,
  monitoredTimeframes,
  price,
} from '../market-data/model.js';
import {
  candles,
  markets,
  monitorConfigs,
  signalCandidates,
  signalEvents,
  signalOutcomes,
  signals,
  strategyConfigVersions,
} from '../schema.js';
import { roundPrice } from './evaluate.js';

type Store = Pick<AppDatabase, 'select' | 'insert' | 'update'>;
type Event = typeof signalEvents.$inferInsert;
type Outcome = typeof signalOutcomes.$inferSelect;
const Exact = Decimal.clone({ precision: 220 });
const windowBars = 20;
const gapGraceMs = 24 * 60 * 60_000;
const startupGraceMs = 10 * 60_000;
const targetStates = ['TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'TP4_HIT'] as const;

const atrSeed = z.object({
  indicators: z.object({ atr: z.number().positive() }),
  candles: z.object({
    trigger: z.object({ last: z.object({ close: price }) }),
  }),
});
const pricePrecision = z.object({
  exchange: z.enum(EXCHANGES),
  marketType: z.enum(MARKET_TYPES),
  pricePrecision: z.number().int().nonnegative().nullable(),
  tickSize: price.nullable(),
});

export function initializeOutcome(
  db: Pick<Store, 'insert'>,
  id: string,
  timeframe: Timeframe,
  approvedAtMs: number,
  levels: RiskLevels,
  evidence: Record<string, unknown>,
  silentBeforeMs = 0,
) {
  const size = duration[timeframe];
  const startAtMs = Math.ceil(approvedAtMs / size) * size;
  const seed = atrSeed.safeParse(evidence).data;
  db.insert(signalOutcomes)
    .values({
      signalId: id,
      startAtMs,
      nextOpenMs: startAtMs,
      deadlineAtMs: startAtMs + windowBars * size,
      silentBeforeMs,
      progress: {
        stops: levels.takeProfits.map(() => levels.stop),
        realizedR: '0',
        atr: seed?.indicators.atr ?? null,
        previousClose: seed?.candles.trigger.last.close ?? null,
        targetsHit: [],
        stopHit: false,
      },
    })
    .onConflictDoNothing()
    .run();
}

function openOutcomes(db: Store, marketId?: string) {
  return db
    .select({
      outcome: signalOutcomes,
      levels: signals.levels,
      direction: signalCandidates.direction,
      timeframe: signalCandidates.triggerTimeframe,
      evidence: signalCandidates.evidence,
      market: markets,
      monitor: monitorConfigs,
      params: strategyConfigVersions.params,
    })
    .from(signalOutcomes)
    .innerJoin(signals, eq(signals.id, signalOutcomes.signalId))
    .innerJoin(signalCandidates, eq(signalCandidates.id, signals.candidateId))
    .innerJoin(
      strategyConfigVersions,
      eq(strategyConfigVersions.id, signalCandidates.configVersionId),
    )
    .innerJoin(markets, eq(markets.id, signalCandidates.marketId))
    .leftJoin(monitorConfigs, eq(monitorConfigs.marketId, markets.id))
    .where(
      and(
        isNull(signalOutcomes.finishedAtMs),
        marketId ? eq(markets.id, marketId) : undefined,
      ),
    )
    .all();
}

type OpenOutcome = ReturnType<typeof openOutcomes>[number];
export type SignalUpdate = (
  store: Pick<Store, 'select' | 'insert'>,
  update: {
    signalId: string;
    symbol: string;
    exchange: string;
    atMs: number;
    lines: string[];
  },
) => void;

const invalidationLabels: Record<string, string> = {
  MARKET_UNLISTED: '市场已下架',
  MONITOR_PAUSED: '监控已暂停',
  MONITOR_DELETED: '监控已删除',
  TIMEFRAME_STOPPED: '原周期已停采',
  COLLECTION_UNAVAILABLE: '原周期当前未采集',
  DATA_GAP: '追踪窗口行情不完整',
};

function describe(event: Event) {
  switch (event.type) {
    case 'TP':
      return `触及 TP${event.target} ${event.price}（${event.closePct}%）`;
    case 'SL':
      return `触及止损 ${event.price}（${event.closePct}%）${event.ambiguousIntrabar ? ' · 同根优先止损' : ''}`;
    case 'STOP_MOVED':
      return `TP${event.target} 对应份额的理论止损调整为 ${event.price}`;
    case 'EXPIRED':
      return `追踪到期 · 剩余份额参考收盘 ${event.price}`;
    case 'INVALIDATED':
      return `追踪失效 · ${invalidationLabels[event.reasonCode!]}`;
    case 'CANDLE':
      return null;
  }
}

export function createSignalTracker(
  db: AppDatabase,
  now: () => number,
  enqueueUpdate: SignalUpdate,
  onError: () => void,
) {
  let bootAtMs = now();
  let timer: ReturnType<typeof setInterval> | undefined;

  function seedHistory(atMs: number) {
    const rows = db
      .select({
        signal: signals,
        timeframe: signalCandidates.triggerTimeframe,
        evidence: signalCandidates.evidence,
      })
      .from(signals)
      .innerJoin(signalCandidates, eq(signalCandidates.id, signals.candidateId))
      .leftJoin(signalOutcomes, eq(signalOutcomes.signalId, signals.id))
      .where(isNull(signalOutcomes.signalId))
      .all();
    if (rows.length)
      db.transaction((tx) => {
        for (const { signal, timeframe, evidence } of rows)
          initializeOutcome(
            tx,
            signal.id,
            timeframe,
            signal.approvedAtMs,
            signal.levels,
            evidence,
            atMs,
          );
      });
  }

  function advance(
    store: Store,
    row: OpenOutcome,
    atMs: number,
    invalidation?: { code: string; atMs: number },
  ) {
    const { outcome, levels, market, timeframe, params } = row;
    const through = Math.min(
      closeCutoff(atMs, timeframe),
      outcome.deadlineAtMs,
      invalidation?.atMs ?? Infinity,
    );
    const size = duration[timeframe];
    if (!invalidation && outcome.nextOpenMs + size > through) return;
    const bars = store
      .select()
      .from(candles)
      .where(
        and(
          eq(candles.marketId, market.id),
          eq(candles.timeframe, timeframe),
          gte(candles.openTimeMs, outcome.nextOpenMs),
          lte(candles.openTimeMs, through - size),
        ),
      )
      .orderBy(asc(candles.openTimeMs))
      .limit(windowBars)
      .all();
    const next: Outcome = { ...outcome, waitingForData: false };
    const { progress } = next;
    const { takeProfits } = levels;
    const long = row.direction === 'LONG';
    const originalRisk = new Exact(levels.entry).minus(levels.stop).abs();
    let realized = new Exact(progress.realizedR);
    const precision = pricePrecision.safeParse(row.evidence.market).data;
    const events: Event[] = [];
    const exitR = (at: string, pct: Decimal.Value) =>
      new Exact(at)
        .minus(levels.entry)
        .times(long ? 1 : -1)
        .div(originalRisk)
        .times(pct)
        .div(100);

    for (const {
      openTimeMs,
      closeTimeMs,
      open,
      high,
      low,
      close,
      source,
    } of bars) {
      if (openTimeMs !== next.nextOpenMs || closeTimeMs !== openTimeMs + size)
        break;
      next.nextOpenMs = closeTimeMs;
      next.observedBars++;
      const stamp = { signalId: outcome.signalId, atMs: closeTimeMs };
      events.push({
        ...stamp,
        type: 'CANDLE',
        candle: { openTimeMs, closeTimeMs, open, high, low, close, source },
      });
      const stopTouched = (stop: string) =>
        long ? new Exact(low).lte(stop) : new Exact(high).gte(stop);
      const targetTouched = (target: string) =>
        long ? new Exact(high).gte(target) : new Exact(low).lte(target);
      const both =
        progress.stops.some((stop) => stop !== null && stopTouched(stop)) &&
        takeProfits.some(
          (target, index) =>
            progress.stops[index] !== null && targetTouched(target.price),
        );
      let stopped = false;
      for (const [index, target] of takeProfits.entries()) {
        const stop = progress.stops[index];
        if (stop == null) continue;
        const hitStop = stopTouched(stop);
        if (!hitStop && !targetTouched(target.price)) continue;
        const exit = hitStop
          ? (long ? Exact.min(stop, open) : Exact.max(stop, open)).toFixed()
          : target.price;
        realized = realized.plus(exitR(exit, target.closePct));
        progress.stops[index] = null;
        if (hitStop) stopped = progress.stopHit = true;
        else {
          progress.targetsHit.push(index + 1);
          next.state = targetStates[Math.max(...progress.targetsHit) - 1]!;
        }
        events.push({
          ...stamp,
          type: hitStop ? 'SL' : 'TP',
          target: index + 1,
          price: exit,
          closePct: target.closePct,
          ambiguousIntrabar: both,
        });
      }

      if (progress.stops.every((stop) => stop === null)) {
        if (stopped) next.state = 'SL_HIT';
        next.finishedAtMs = closeTimeMs;
        break;
      }
      if (closeTimeMs === outcome.deadlineAtMs) {
        const remainingPct = takeProfits.reduce(
          (sum, target, index) =>
            progress.stops[index] === null ? sum : sum.plus(target.closePct),
          new Exact(0),
        );
        realized = realized.plus(exitR(close, remainingPct));
        next.state = 'EXPIRED';
        next.finishedAtMs = closeTimeMs;
        events.push({
          ...stamp,
          type: 'EXPIRED',
          price: close,
          closePct: remainingPct.toNumber(),
        });
        break;
      }

      if (progress.atr !== null && progress.previousClose !== null) {
        const previous = Number(progress.previousClose);
        const range = Math.max(
          Number(high) - Number(low),
          Math.abs(Number(high) - previous),
          Math.abs(Number(low) - previous),
        );
        progress.atr += (range - progress.atr) / params.atr.period;
        progress.previousClose = close;
      }
      if (!progress.targetsHit.includes(1)) continue;
      for (const [index, target] of takeProfits.entries()) {
        const stop = progress.stops[index];
        if (stop == null) continue;
        let moved: Decimal | null = null;
        if (target.trailPolicy === 'BREAKEVEN_AFTER_TP1')
          moved = new Exact(levels.entry);
        if (
          target.trailPolicy === 'ATR_TRAIL_AFTER_TP1' &&
          precision &&
          progress.atr &&
          Number.isFinite(progress.atr)
        ) {
          moved = roundPrice(
            precision,
            new Exact(close).plus(
              new Exact(progress.atr).times(long ? -1.5 : 1.5),
            ),
          );
          if (moved && (long ? moved.gte(close) : moved.lte(close)))
            moved = null;
        }
        if (moved && (long ? moved.gt(stop) : moved.lt(stop))) {
          const price = moved.toFixed();
          progress.stops[index] = price;
          events.push({
            ...stamp,
            type: 'STOP_MOVED',
            target: index + 1,
            price,
            reasonCode: target.trailPolicy,
          });
        }
      }
    }

    if (next.finishedAtMs === null) {
      next.waitingForData = next.nextOpenMs + size <= through;
      const stop =
        invalidation ??
        (next.waitingForData &&
        atMs >= outcome.deadlineAtMs + gapGraceMs &&
        atMs >= bootAtMs + startupGraceMs
          ? {
              code: 'DATA_GAP',
              atMs: Math.max(
                outcome.deadlineAtMs + gapGraceMs,
                bootAtMs + startupGraceMs,
              ),
            }
          : undefined);
      if (stop) {
        next.state = 'INVALIDATED';
        next.waitingForData = false;
        next.finishedAtMs = stop.atMs;
        next.reasonCode = stop.code;
        events.push({
          signalId: outcome.signalId,
          atMs: stop.atMs,
          type: 'INVALIDATED',
          reasonCode: stop.code,
        });
      }
    }
    if (!events.length && next.waitingForData === outcome.waitingForData)
      return;
    progress.realizedR = realized.toFixed();
    if (next.finishedAtMs !== null && next.state !== 'INVALIDATED')
      next.grossR = realized.toDecimalPlaces(8).toFixed();
    const changed = store
      .update(signalOutcomes)
      .set(next)
      .where(
        and(
          eq(signalOutcomes.signalId, next.signalId),
          eq(signalOutcomes.nextOpenMs, outcome.nextOpenMs),
          isNull(signalOutcomes.finishedAtMs),
        ),
      )
      .run();
    if (!changed.changes || !events.length) return;
    store.insert(signalEvents).values(events).run();
    if (outcome.silentBeforeMs >= outcome.deadlineAtMs) return;
    const updates = new Map<number, string[]>();
    for (const event of events) {
      if (event.atMs <= Math.max(bootAtMs, outcome.silentBeforeMs)) continue;
      const line = describe(event);
      if (!line) continue;
      const lines = updates.get(event.atMs) ?? [];
      lines.push(line);
      updates.set(event.atMs, lines);
    }
    for (const [atMs, lines] of updates)
      enqueueUpdate(store, {
        signalId: outcome.signalId,
        symbol: market.nativeSymbol,
        exchange: market.exchange,
        atMs,
        lines,
      });
  }

  function tick() {
    const atMs = now();
    seedHistory(atMs);
    for (const row of openOutcomes(db)) {
      const { market, monitor, timeframe, outcome } = row;
      let invalidation: { code: string; atMs: number } | undefined;
      if (market.status === 'UNLISTED')
        invalidation = {
          code: 'MARKET_UNLISTED',
          atMs: Math.max(
            outcome.startAtMs - duration[timeframe],
            market.updatedAtMs,
          ),
        };
      else if (
        !monitor?.enabled ||
        !monitoredTimeframes(monitor).includes(timeframe)
      )
        invalidation = { code: 'COLLECTION_UNAVAILABLE', atMs };
      if (
        invalidation ||
        outcome.nextOpenMs + duration[timeframe] <= closeCutoff(atMs, timeframe)
      )
        db.transaction((tx) => advance(tx, row, atMs, invalidation));
    }
  }

  return {
    tick,
    stopMarket(
      store: Store,
      marketId: string,
      retained: Timeframe[],
      atMs: number,
      code: string,
    ) {
      for (const row of openOutcomes(store, marketId))
        if (!retained.includes(row.timeframe))
          advance(store, row, atMs, { code, atMs });
    },
    start() {
      if (timer) return;
      bootAtMs = now();
      const run = () => {
        try {
          tick();
        } catch {
          onError();
        }
      };
      run();
      timer = setInterval(run, 1_000);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}

export type SignalTracker = ReturnType<typeof createSignalTracker>;
