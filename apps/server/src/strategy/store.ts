import { createHash, randomUUID } from 'node:crypto';
import type { AiReviewResult } from '@market-sentinel/contracts/notifications';
import type {
  CandidateDirection,
  SignalFilters,
  SignalQuery,
  StrategyParameters,
  StrategyTimeframes,
} from '@market-sentinel/contracts/strategies';
import type { Candle, MarketType } from '@market-sentinel/domain';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias, type SelectedFields } from 'drizzle-orm/sqlite-core';
import { ApiError } from '../api-error.js';
import type { AppDatabase } from '../database.js';
import {
  aiReviews,
  auditLogs,
  markets,
  riskEvaluations,
  outboxMessages,
  signalCandidates,
  signalEvents,
  signalOutcomes,
  signals,
  strategyConfigVersions,
} from '../schema.js';
import type { MonitorRow } from '../market-data/store.js';
import { deliveryFields } from '../notification/telegram.js';
import { aiAudit } from '../notification/ai.js';
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

const finalRisk = alias(riskEvaluations, 'final_risk');
const finalFields = {
  outcome: finalRisk.outcome,
  reasonCode: finalRisk.reasonCode,
};
const tradeDelivery = alias(outboxMessages, 'trade_delivery');
const aiDecision = sql<
  AiReviewResult['decision'] | null
>`json_extract(${aiReviews.result}, '$.decision')`;
const fields = {
  id: signalCandidates.id,
  marketId: signalCandidates.marketId,
  market: {
    marketType: markets.marketType,
    productType: markets.productType,
    venue: markets.venue,
    nativeSymbol: markets.nativeSymbol,
  },
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
  deliveryPending: signalCandidates.deliveryPending,
  signalId: signals.id,
  signalMode: signals.mode,
  aiDecision: aiDecision.as('ai_decision'),
  aiStatus: aiReviews.status,
  theory: {
    state: signalOutcomes.state,
    startAtMs: signalOutcomes.startAtMs,
    deadlineAtMs: signalOutcomes.deadlineAtMs,
    finishedAtMs: signalOutcomes.finishedAtMs,
    observedBars: signalOutcomes.observedBars,
    waitingForData: signalOutcomes.waitingForData,
    grossR: signalOutcomes.grossR,
    reasonCode: signalOutcomes.reasonCode,
  },
  delivery: {
    status: tradeDelivery.status,
    attempts: tradeDelivery.attempts,
    manual: tradeDelivery.manual,
    sentAtMs: tradeDelivery.sentAtMs,
    telegramMessageId: tradeDelivery.telegramMessageId,
    lastError: tradeDelivery.lastError,
  },
};
const details = {
  ...fields,
  params: strategyConfigVersions.params,
  timeframes: strategyConfigVersions.timeframes,
  configHash: strategyConfigVersions.configHash,
  levels: riskEvaluations.levels,
  evidence: signalCandidates.evidence,
  approvedAtMs: signals.approvedAtMs,
  deliveryExpiresAtMs: signals.expiresAtMs,
  finalRisk: {
    ...finalFields,
    levels: finalRisk.levels,
    atMs: finalRisk.atMs,
    quote: finalRisk.quote,
  },
};

type HistoryStore = Pick<AppDatabase, 'select'>;
const historyOrder = [
  desc(signalCandidates.evaluatedAtMs),
  desc(signalCandidates.id),
] as const;

function historyQuery<T extends SelectedFields>(
  db: HistoryStore,
  projection: T,
  query: SignalFilters,
  condition?: SQL,
) {
  const latest = db
    .select({ id: outboxMessages.id })
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.signalId, signals.id),
        eq(outboxMessages.kind, 'TRADE_SIGNAL'),
      ),
    )
    .orderBy(
      desc(outboxMessages.manual),
      desc(outboxMessages.createdAtMs),
      desc(outboxMessages.id),
    )
    .limit(1);
  const search = query.q?.toLowerCase();
  return db
    .select({ ...projection, exchange: markets.exchange })
    .from(signalCandidates)
    .innerJoin(markets, eq(markets.id, signalCandidates.marketId))
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
    .leftJoin(
      finalRisk,
      and(
        eq(finalRisk.candidateId, signalCandidates.id),
        eq(finalRisk.stage, 'FINAL'),
      ),
    )
    .leftJoin(signals, eq(signals.candidateId, signalCandidates.id))
    .leftJoin(signalOutcomes, eq(signalOutcomes.signalId, signals.id))
    .leftJoin(aiReviews, eq(aiReviews.candidateId, signalCandidates.id))
    .leftJoin(tradeDelivery, eq(tradeDelivery.id, sql`(${latest})`))
    .where(
      and(
        condition,
        query.marketId
          ? eq(signalCandidates.marketId, query.marketId)
          : undefined,
        query.state ? eq(riskEvaluations.outcome, query.state) : undefined,
        query.finalState ? eq(finalRisk.outcome, query.finalState) : undefined,
        query.exchange ? eq(markets.exchange, query.exchange) : undefined,
        query.strategyId
          ? eq(strategyConfigVersions.strategyId, query.strategyId)
          : undefined,
        query.deliveryState
          ? eq(tradeDelivery.status, query.deliveryState)
          : undefined,
        query.theoryState
          ? eq(signalOutcomes.state, query.theoryState)
          : undefined,
        query.fromMs === undefined
          ? undefined
          : gte(signalCandidates.triggerCloseMs, query.fromMs),
        query.toMs === undefined
          ? undefined
          : lt(signalCandidates.triggerCloseMs, query.toMs),
        search
          ? or(
              ...[
                markets.nativeSymbol,
                markets.id,
                signalCandidates.id,
                signals.id,
              ].map((field) => sql`instr(lower(${field}), ${search}) > 0`),
            )
          : undefined,
      ),
    );
}

export function listSignals(db: HistoryStore, query: SignalQuery) {
  return historyQuery(db, { ...fields, finalRisk: finalFields }, query)
    .orderBy(...historyOrder)
    .limit(query.limit + 1)
    .offset(query.offset)
    .all();
}

function detailRows(
  db: HistoryStore,
  filters: SignalFilters,
  limit: number,
  condition?: SQL,
) {
  return historyQuery(db, details, filters, condition)
    .orderBy(...historyOrder)
    .limit(limit)
    .all();
}

function expandDetails(db: HistoryStore, rows: ReturnType<typeof detailRows>) {
  if (!rows.length) return [];
  const ids = rows.map(({ id }) => id);
  const signalIds = rows.flatMap(({ signalId }) => signalId ?? []);
  const deliveryRows = db
    .select({
      delivery: {
        ...deliveryFields,
        id: outboxMessages.id,
        body: outboxMessages.body,
        createdAtMs: outboxMessages.createdAtMs,
      },
      nextAttemptMs: outboxMessages.nextAttemptMs,
      signalId: outboxMessages.signalId,
      kind: outboxMessages.kind,
    })
    .from(outboxMessages)
    .where(inArray(outboxMessages.signalId, signalIds))
    .orderBy(
      desc(outboxMessages.manual),
      desc(outboxMessages.createdAtMs),
      desc(outboxMessages.id),
    )
    .all();
  const deliveries = new Map<string | null, typeof deliveryRows>();
  for (const item of deliveryRows) {
    if (!deliveries.has(item.signalId)) deliveries.set(item.signalId, []);
    deliveries.get(item.signalId)!.push(item);
  }
  const eventRows = db
    .select({
      signalId: signalEvents.signalId,
      event: {
        id: signalEvents.id,
        type: signalEvents.type,
        atMs: signalEvents.atMs,
        target: signalEvents.target,
        price: signalEvents.price,
        closePct: signalEvents.closePct,
        ambiguousIntrabar: signalEvents.ambiguousIntrabar,
        reasonCode: signalEvents.reasonCode,
        candle: signalEvents.candle,
      },
    })
    .from(signalEvents)
    .where(inArray(signalEvents.signalId, signalIds))
    .orderBy(asc(signalEvents.atMs), asc(signalEvents.id))
    .all();
  const events = new Map<string, typeof eventRows>();
  for (const item of eventRows) {
    if (!events.has(item.signalId)) events.set(item.signalId, []);
    events.get(item.signalId)!.push(item);
  }
  const reviews = new Map(
    db
      .select()
      .from(aiReviews)
      .where(inArray(aiReviews.candidateId, ids))
      .all()
      .map((review) => [review.candidateId, review]),
  );
  return rows.map((row) => {
    const audit = deliveries.get(row.signalId) ?? [];
    const review = reviews.get(row.id);
    const deliveryAudit = (kind: 'TRADE_SIGNAL' | 'SIGNAL_UPDATE') =>
      audit
        .filter((delivery) => delivery.kind === kind)
        .map(({ delivery }) => delivery);
    return {
      data: {
        ...row,
        deliveries: deliveryAudit('TRADE_SIGNAL'),
        updates: deliveryAudit('SIGNAL_UPDATE'),
        theoryEvents: (row.signalId
          ? (events.get(row.signalId) ?? [])
          : []
        ).map(({ event }) => event),
        aiReview: review
          ? { ...aiAudit(review), requestSummary: review.requestSummary }
          : null,
      },
      lastActivityMs: audit.reduce(
        (last, item) =>
          Math.max(
            last,
            item.delivery.createdAtMs,
            item.delivery.sentAtMs ?? 0,
            item.nextAttemptMs,
          ),
        Math.max(
          row.evaluatedAtMs,
          row.approvedAtMs ?? 0,
          row.finalRisk?.atMs ?? 0,
          row.theory?.finishedAtMs ?? 0,
          review?.createdAtMs ?? 0,
          review?.completedAtMs ?? 0,
        ),
      ),
    };
  });
}

export function signalDetail(db: HistoryStore, id: string) {
  const result = expandDetails(
    db,
    detailRows(db, {}, 1, eq(signalCandidates.id, id)),
  )[0];
  return result
    ? { ...result.data, lastActivityMs: result.lastActivityMs }
    : undefined;
}

export function canDeleteHistory(
  row: NonNullable<ReturnType<typeof signalDetail>>,
  atMs: number,
) {
  return (
    atMs - row.lastActivityMs >= 48 * 60 * 60_000 &&
    !row.deliveryPending &&
    row.aiStatus !== 'RUNNING' &&
    (!row.signalId || row.theory?.finishedAtMs != null) &&
    [...row.deliveries, ...row.updates].every(
      ({ status }) => status !== 'PENDING' && status !== 'SENDING',
    )
  );
}

export function deleteSignalHistory(
  db: AppDatabase,
  id: string,
  atMs: number,
  actor: string,
) {
  db.transaction((tx) => {
    const row = signalDetail(tx, id);
    if (!row)
      throw new ApiError(404, 'SIGNAL_NOT_FOUND', '找不到这条候选记录。');
    if (!canDeleteHistory(row, atMs))
      throw new ApiError(
        409,
        'SIGNAL_HISTORY_NOT_DELETABLE',
        '只能删除已完结且最近 48 小时无关联活动的候选记录。',
      );
    if (row.signalId) {
      tx.delete(outboxMessages)
        .where(eq(outboxMessages.signalId, row.signalId))
        .run();
      tx.delete(signals).where(eq(signals.id, row.signalId)).run();
    }
    tx.delete(aiReviews).where(eq(aiReviews.candidateId, id)).run();
    tx.delete(riskEvaluations).where(eq(riskEvaluations.candidateId, id)).run();
    tx.delete(signalCandidates).where(eq(signalCandidates.id, id)).run();
    tx.insert(auditLogs)
      .values({
        actor,
        action: 'SIGNAL_HISTORY_DELETED',
        targetType: 'candidate',
        targetId: id,
        createdAtMs: atMs,
      })
      .run();
  });
}

export function exportSignalHistory(
  db: AppDatabase,
  filters: SignalFilters,
  format: 'csv' | 'json',
) {
  const limit = 5_000;
  const bounded = <T>(rows: T[]) => {
    if (rows.length > limit)
      throw new ApiError(
        422,
        'SIGNAL_EXPORT_TOO_LARGE',
        '单次最多导出 5,000 条，请缩小筛选范围。',
      );
    return rows;
  };
  return db.transaction((tx) => {
    if (format === 'json')
      return expandDetails(tx, bounded(detailRows(tx, filters, limit + 1))).map(
        ({ data }) => data,
      );
    const rows = bounded(listSignals(tx, { ...filters, limit, offset: 0 }));
    const cell = (
      value: string | number | null | undefined,
      numeric = false,
    ) => {
      const text = String(value ?? '');
      const safe =
        !numeric && /^\s*[=+\-@\t\r\n]/u.test(text.replaceAll('\0', ''))
          ? "'" + text
          : text;
      return '"' + safe.replaceAll('"', '""') + '"';
    };
    const header =
      'candidate_id,signal_id,exchange,market,product,venue,strategy,version,direction,trigger_utc,pre_risk,final_risk,reason,ai_decision,telegram_status,telegram_message_id,theory_state,observed_bars,gross_r';
    const lines = rows.map((row) =>
      [
        row.id,
        row.signalId,
        row.exchange,
        row.market.nativeSymbol,
        row.market.productType,
        row.market.venue,
        row.strategyId,
        row.strategyVersion,
        row.direction,
        new Date(row.triggerCloseMs).toISOString(),
        row.outcome,
        row.finalRisk?.outcome,
        row.finalRisk?.reasonCode ?? row.reasonCode,
        row.aiDecision,
        row.delivery?.status,
        row.delivery?.telegramMessageId,
        row.theory?.state,
        row.theory?.observedBars,
        row.theory?.grossR,
      ]
        .map((value, index) => cell(value, index === 18))
        .join(','),
    );
    return '\uFEFF' + [header, ...lines].join('\r\n') + '\r\n';
  });
}

export function summarizeSignals(db: HistoryStore, filters: SignalFilters) {
  const countIf = (condition: SQL) =>
    sql`sum(case when ${condition} then 1 else 0 end)`.mapWith(Number);
  const target = (ordinal: number) =>
    countIf(
      sql`exists (select 1 from json_each(${signalOutcomes.progress}, '$.targetsHit') where value = ${ordinal})`,
    );
  const sent = db
    .select({ id: outboxMessages.id })
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.signalId, signals.id),
        eq(outboxMessages.kind, 'TRADE_SIGNAL'),
        eq(outboxMessages.status, 'SENT'),
      ),
    );
  return historyQuery(
    db,
    {
      strategyId: strategyConfigVersions.strategyId,
      candidates: sql`count(*)`.mapWith(Number),
      approved: countIf(sql`${signals.id} is not null`),
      rejected: countIf(
        sql`coalesce(${finalRisk.outcome}, ${riskEvaluations.outcome}) = 'REJECTED'`,
      ),
      sent: countIf(sql`exists ${sent}`),
      longs: countIf(eq(signalCandidates.direction, 'LONG')),
      shorts: countIf(eq(signalCandidates.direction, 'SHORT')),
      aiAccepted: countIf(sql`${aiDecision} = 'ACCEPT'`),
      aiModified: countIf(sql`${aiDecision} = 'MODIFY'`),
      aiRejected: countIf(sql`${aiDecision} = 'REJECT'`),
      tp1: target(1),
      tp2: target(2),
      tp3: target(3),
      tp4: target(4),
      stopHits: countIf(
        sql`json_extract(${signalOutcomes.progress}, '$.stopHit') = 1`,
      ),
      insufficientData: countIf(
        sql`${signalOutcomes.waitingForData} = 1 or ${signalOutcomes.reasonCode} = 'DATA_GAP'`,
      ),
      completed: sql`count(${signalOutcomes.grossR})`.mapWith(Number),
      averageGrossR: sql`avg(cast(${signalOutcomes.grossR} as real))`.mapWith(
        Number,
      ),
    },
    filters,
  )
    .groupBy(markets.exchange, strategyConfigVersions.strategyId)
    .orderBy(asc(markets.exchange), asc(strategyConfigVersions.strategyId))
    .all()
    .map(({ tp1, tp2, tp3, tp4, ...group }) => ({
      ...group,
      targetHits: [tp1, tp2, tp3, tp4],
    }));
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

      if (risk.outcome === 'PASSED' && conflict)
        risk = {
          ...risk,
          outcome: 'SUPPRESSED',
          reasonCode: 'SUPPRESS_CONFLICT',
        };

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
          deliveryPending:
            direction !== 'BEARISH_WATCH' &&
            risk.outcome === 'PASSED' &&
            risk.levels !== null,
        })
        .run();
      tx.insert(riskEvaluations)
        .values({ candidateId: id, stage: 'PRE', ...risk })
        .run();
      return { atMs, outcome: risk.outcome, reasonCode: risk.reasonCode };
    });
  });
}
