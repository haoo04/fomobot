import { createHash, randomUUID } from 'node:crypto';
import type {
  CandidateDirection,
  SignalQuery,
  StrategyParameters,
  StrategyTimeframes,
} from '@market-sentinel/contracts/strategies';
import type { Candle, MarketType } from '@market-sentinel/domain';
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import type { AppDatabase } from '../database.js';
import {
  riskEvaluations,
  signalCandidates,
  strategyConfigVersions,
} from '../schema.js';
import type { MonitorRow } from '../market-data/store.js';
import type { RiskResult } from './evaluate.js';

type Store = Pick<AppDatabase, 'select' | 'insert'>;

export function strategyTemplate(marketType: MarketType) {
  const params: StrategyParameters = {
    emaPeriods: [21, 55, 144],
    rsi: { period: 14, longMin: 50, longMax: 70, shortMin: 30, shortMax: 50 },
    volume: { lookback: 20, relativeMin: 1.5 },
    oi:
      marketType === 'SPOT'
        ? null
        : { lookbackMinutes: 15, minIncreasePct: 0.5, maxAgeSeconds: 180 },
    atr: { period: 14, stopMultiplier: 1.2 },
    breakPreviousCandle: true,
    risk: {
      minWeightedRR: 2,
      maxEntryDriftAtr: 0.3,
      swingLookback: 10,
      takeProfits: [
        { rMultiple: 1.5, closePct: 50 },
        { rMultiple: 3, closePct: 50 },
      ],
      cooldownMinutes: 30,
      maxAgeSeconds: 60,
      maxSpreadBps: null,
      minTurnover: null,
      minStopPct: null,
      maxStopPct: null,
      maxAtrPct: null,
    },
  };
  return {
    marketType,
    strategyId:
      marketType === 'SPOT' ? 'spot-trend-pullback' : 'trend-pullback',
    strategyVersion: '1.0.0',
    algorithmVersion: '1.0.0',
    params,
  };
}

type Configuration = Pick<
  typeof strategyConfigVersions.$inferSelect,
  'strategyId' | 'strategyVersion' | 'algorithmVersion' | 'params'
>;

export function strategyConfiguration(
  db: Store,
  monitor: MonitorRow,
  marketType: MarketType,
): Configuration {
  return monitor.strategyConfigVersionId === null
    ? strategyTemplate(marketType)
    : db
        .select()
        .from(strategyConfigVersions)
        .where(eq(strategyConfigVersions.id, monitor.strategyConfigVersionId))
        .get()!;
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function saveStrategyVersion(
  db: Store,
  { strategyId, strategyVersion, algorithmVersion, params }: Configuration,
  { trigger, confirm, trend }: StrategyTimeframes,
  atMs: number,
) {
  const timeframes = { trigger, confirm, trend };
  const configHash = hash([
    strategyId,
    strategyVersion,
    algorithmVersion,
    params,
    timeframes,
  ]);
  db.insert(strategyConfigVersions)
    .values({
      id: randomUUID(),
      strategyId,
      strategyVersion,
      algorithmVersion,
      configHash,
      params,
      timeframes,
      createdAtMs: atMs,
    })
    .onConflictDoNothing()
    .run();
  return db
    .select()
    .from(strategyConfigVersions)
    .where(eq(strategyConfigVersions.configHash, configHash))
    .get()!;
}

const fields = {
  id: signalCandidates.id,
  marketId: signalCandidates.marketId,
  configVersionId: signalCandidates.configVersionId,
  strategyId: strategyConfigVersions.strategyId,
  strategyVersion: strategyConfigVersions.strategyVersion,
  algorithmVersion: strategyConfigVersions.algorithmVersion,
  triggerTimeframe: signalCandidates.triggerTimeframe,
  triggerOpenMs: signalCandidates.triggerOpenMs,
  triggerCloseMs: signalCandidates.triggerCloseMs,
  evaluatedAtMs: signalCandidates.evaluatedAtMs,
  direction: signalCandidates.direction,
  outcome: riskEvaluations.outcome,
  reasonCode: riskEvaluations.reasonCode,
};

export function listSignals(db: AppDatabase, query: SignalQuery) {
  return db
    .select(fields)
    .from(signalCandidates)
    .innerJoin(
      strategyConfigVersions,
      eq(strategyConfigVersions.id, signalCandidates.configVersionId),
    )
    .innerJoin(
      riskEvaluations,
      and(
        eq(riskEvaluations.candidateId, signalCandidates.id),
        eq(riskEvaluations.stage, 'PRE'),
      ),
    )
    .where(
      and(
        query.marketId
          ? eq(signalCandidates.marketId, query.marketId)
          : undefined,
        query.state ? eq(riskEvaluations.outcome, query.state) : undefined,
      ),
    )
    .orderBy(desc(signalCandidates.evaluatedAtMs), desc(signalCandidates.id))
    .limit(query.limit + 1)
    .offset(query.offset)
    .all();
}

export function signalDetail(db: AppDatabase, id: string) {
  return db
    .select({
      ...fields,
      params: strategyConfigVersions.params,
      timeframes: strategyConfigVersions.timeframes,
      configHash: strategyConfigVersions.configHash,
      levels: riskEvaluations.levels,
      evidence: signalCandidates.evidence,
    })
    .from(signalCandidates)
    .innerJoin(
      strategyConfigVersions,
      eq(strategyConfigVersions.id, signalCandidates.configVersionId),
    )
    .innerJoin(
      riskEvaluations,
      and(
        eq(riskEvaluations.candidateId, signalCandidates.id),
        eq(riskEvaluations.stage, 'PRE'),
      ),
    )
    .where(eq(signalCandidates.id, id))
    .get();
}

export function saveCandidates(
  db: AppDatabase,
  trigger: Candle,
  timeframes: StrategyTimeframes,
  config: Configuration,
  proposals: { direction: CandidateDirection; risk: RiskResult }[],
  evidence: Record<string, unknown>,
  atMs: number,
) {
  const passing = proposals.filter(({ risk }) => risk.outcome === 'PASSED');
  const conflict =
    passing.some(({ direction }) => direction === 'LONG') &&
    passing.some(({ direction }) => direction === 'SHORT');
  return db.transaction((tx) => {
    const version = saveStrategyVersion(tx, config, timeframes, atMs);
    return proposals.map(({ direction, risk }) => {
      const idempotencyKey = hash([
        trigger.marketId,
        version.configHash,
        trigger.timeframe,
        trigger.openTimeMs,
        direction,
      ]);
      const existing = tx
        .select({
          atMs: signalCandidates.evaluatedAtMs,
          outcome: riskEvaluations.outcome,
          reasonCode: riskEvaluations.reasonCode,
        })
        .from(signalCandidates)
        .innerJoin(
          riskEvaluations,
          and(
            eq(riskEvaluations.candidateId, signalCandidates.id),
            eq(riskEvaluations.stage, 'PRE'),
          ),
        )
        .where(eq(signalCandidates.idempotencyKey, idempotencyKey))
        .get();
      if (existing) return existing;

      if (risk.outcome === 'PASSED') {
        if (conflict) {
          risk = {
            ...risk,
            outcome: 'SUPPRESSED',
            reasonCode: 'SUPPRESS_CONFLICT',
          };
        } else if (config.params.risk.cooldownMinutes > 0) {
          const previous = tx
            .select({ id: signalCandidates.id })
            .from(signalCandidates)
            .innerJoin(
              strategyConfigVersions,
              eq(strategyConfigVersions.id, signalCandidates.configVersionId),
            )
            .innerJoin(
              riskEvaluations,
              and(
                eq(riskEvaluations.candidateId, signalCandidates.id),
                eq(riskEvaluations.stage, 'PRE'),
              ),
            )
            .where(
              and(
                eq(signalCandidates.marketId, trigger.marketId),
                eq(signalCandidates.direction, direction),
                eq(strategyConfigVersions.strategyId, config.strategyId),
                eq(riskEvaluations.outcome, 'PASSED'),
                lt(signalCandidates.triggerCloseMs, trigger.closeTimeMs),
                gt(
                  signalCandidates.triggerCloseMs,
                  trigger.closeTimeMs -
                    config.params.risk.cooldownMinutes * 60_000,
                ),
              ),
            )
            .limit(1)
            .get();
          if (previous)
            risk = {
              ...risk,
              outcome: 'SUPPRESSED',
              reasonCode: 'SUPPRESS_COOLDOWN',
            };
        }
      }

      const id = randomUUID();
      tx.insert(signalCandidates)
        .values({
          id,
          idempotencyKey,
          marketId: trigger.marketId,
          configVersionId: version.id,
          triggerTimeframe: trigger.timeframe,
          triggerOpenMs: trigger.openTimeMs,
          triggerCloseMs: trigger.closeTimeMs,
          direction,
          evaluatedAtMs: atMs,
          evidence,
        })
        .run();
      tx.insert(riskEvaluations)
        .values({ candidateId: id, stage: 'PRE', ...risk })
        .run();
      return { atMs, outcome: risk.outcome, reasonCode: risk.reasonCode };
    });
  });
}
