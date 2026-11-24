import { randomUUID } from 'node:crypto';
import { systemEventLabels } from '@market-sentinel/contracts/notifications';
import type { RiskLevels } from '@market-sentinel/contracts/strategies';
import { and, count, desc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../api-error.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../database.js';
import { decimal, price } from '../market-data/model.js';
import type { MarketData } from '../market-data/service.js';
import { marketById } from '../market-data/store.js';
import {
  auditLogs,
  monitorConfigs,
  outboxMessages,
  riskEvaluations,
  signalCandidates,
  signals,
  strategyConfigVersions,
  systemEvents,
} from '../schema.js';
import { evaluateRisk, reject, type RiskResult } from '../strategy/evaluate.js';
import { signalDetail } from '../strategy/store.js';
import { initializeOutcome, type SignalUpdate } from '../strategy/tracker.js';
import { createAiReview, type ReviewProvider } from './ai.js';
import { createTelegram } from './telegram.js';

type Candidate = NonNullable<ReturnType<typeof signalDetail>>;
type Outbox = typeof outboxMessages.$inferSelect;
type MarketSource = Pick<MarketData, 'now' | 'view' | 'strategyMarket'>;
const countedDeliveries = ['SENDING', 'SENT', 'DELIVERY_UNKNOWN'] as const;
const updateTtlMs = 5 * 60_000;
const closedBarSummary = z.object({
  open: price.optional(),
  close: price,
  high: price,
  low: price,
  baseVolume: decimal,
  quoteTurnover: decimal.nullable(),
  closeTimeMs: z.number().int().nonnegative().optional(),
});
const snapshotSchema = z.object({
  candles: z.object({
    trigger: z.object({
      last: closedBarSummary,
      previous: closedBarSummary.optional(),
    }),
    confirm: z.object({ last: closedBarSummary }).optional(),
    trend: z.object({ last: closedBarSummary }).optional(),
  }),
  indicators: z.object({
    atr: z.number().positive(),
    triggerEma: z.number().optional(),
    trendEma: z.array(z.number()).max(3).optional(),
    rsi: z.number().optional(),
    previousRsi: z.number().optional(),
    rvol: z.number().optional(),
  }),
  openInterest: z
    .object({
      latest: z.object({
        timestampMs: z.number().int().nonnegative(),
        value: decimal.optional(),
        unit: z
          .enum(['BASE_ASSET', 'CONTRACTS', 'USD_NOTIONAL', 'OTHER'])
          .optional(),
      }),
      reference: z
        .object({
          timestampMs: z.number().int().nonnegative(),
          value: decimal.optional(),
        })
        .optional(),
      deltaPct: z.number(),
    })
    .nullable(),
});

function suppressed(
  reasonCode: string,
  levels: RiskLevels | null = null,
): RiskResult {
  return { outcome: 'SUPPRESSED', reasonCode, levels };
}

function coolingDown(
  store: Pick<AppDatabase, 'select'>,
  candidate: Candidate,
  atMs: number,
) {
  const cooldown = candidate.params.risk.cooldownMinutes * 60_000;
  if (cooldown === 0) return false;
  const recent = store
    .select({ id: signals.id })
    .from(signals)
    .innerJoin(signalCandidates, eq(signalCandidates.id, signals.candidateId))
    .innerJoin(
      strategyConfigVersions,
      eq(strategyConfigVersions.id, signalCandidates.configVersionId),
    )
    .innerJoin(outboxMessages, eq(outboxMessages.signalId, signals.id))
    .where(
      and(
        eq(signalCandidates.marketId, candidate.marketId),
        eq(signalCandidates.direction, candidate.direction),
        eq(strategyConfigVersions.strategyId, candidate.strategyId),
        eq(outboxMessages.kind, 'TRADE_SIGNAL'),
        gt(
          signalCandidates.triggerCloseMs,
          candidate.triggerCloseMs - cooldown,
        ),
        or(
          inArray(outboxMessages.status, ['SENT', 'DELIVERY_UNKNOWN']),
          and(
            inArray(outboxMessages.status, ['PENDING', 'SENDING']),
            gt(outboxMessages.expiresAtMs, atMs),
          ),
        ),
      ),
    )
    .get();
  return !!recent;
}

export function createNotifications(
  db: AppDatabase,
  config: AppConfig,
  marketData: MarketSource,
  onError: () => void,
  options: { fetchTelegram?: typeof fetch; reviewOpenAI?: ReviewProvider } = {},
) {
  const { now } = marketData;
  const telegram = createTelegram(db, config, now, options.fetchTelegram);
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const displayTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: config.APP_TIMEZONE,
    dateStyle: 'short',
    timeStyle: 'medium',
  });
  const ai = createAiReview(db, config, now, day, options.reviewOpenAI);
  const lifecycle = new AbortController();
  const tasks = new Map<() => Promise<void> | void, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let recoverOutbox = true;

  function check(candidate: Candidate, levels: RiskLevels, atMs: number) {
    const { marketId, direction, params, triggerCloseMs, timeframes } =
      candidate;
    const { quote, available } = marketData.strategyMarket(marketId);
    const row = marketById(db, marketId);
    const market = row ? marketData.view(row) : null;
    let risk: RiskResult;
    const monitor = db
      .select()
      .from(monitorConfigs)
      .where(eq(monitorConfigs.marketId, marketId))
      .get();
    const snapshot = snapshotSchema.safeParse(candidate.evidence);
    if (
      atMs < triggerCloseMs ||
      atMs >= triggerCloseMs + params.risk.maxAgeSeconds * 1000
    ) {
      risk = reject('REJECT_STALE_DATA');
    } else if (
      !monitor?.enabled ||
      !monitor.strategyEnabled ||
      (monitor.strategyConfigVersionId !== null &&
        monitor.strategyConfigVersionId !== candidate.configVersionId) ||
      triggerCloseMs <= monitor.strategyAfterMs
    ) {
      risk = suppressed('SUPPRESS_MONITOR_CHANGED');
    } else if (
      !market ||
      market.status !== 'ACTIVE' ||
      market.stale ||
      !available ||
      !Object.values(timeframes).every((timeframe) =>
        market.capabilities.intervals.includes(timeframe),
      )
    ) {
      risk = reject('REJECT_MARKET_UNAVAILABLE');
    } else if (!snapshot.success || direction === 'BEARISH_WATCH') {
      risk = reject('REJECT_INCOMPLETE_CANDLE');
    } else {
      const { candles, indicators, openInterest } = snapshot.data;
      const oi = params.oi;
      risk =
        oi &&
        (!openInterest ||
          openInterest.latest.timestampMs > triggerCloseMs ||
          atMs - openInterest.latest.timestampMs > oi.maxAgeSeconds * 1000 ||
          openInterest.deltaPct < oi.minIncreasePct)
          ? reject('REJECT_OI_UNAVAILABLE')
          : evaluateRisk(
              market,
              quote,
              [candles.trigger.last],
              indicators.atr,
              direction,
              params,
              atMs,
              levels,
            );
    }
    return { risk, quote, market, snapshot: snapshot.data };
  }

  async function tickSignals() {
    if (lifecycle.signal.aborted) return;
    ai.recover();
    const next = db
      .select({ id: signalCandidates.id })
      .from(signalCandidates)
      .where(eq(signalCandidates.deliveryPending, true))
      .orderBy(signalCandidates.triggerCloseMs, signalCandidates.evaluatedAtMs)
      .get();
    if (!next) return;
    const candidate = signalDetail(db, next.id)!;
    const { pairing } = telegram.current();
    let result = check(candidate, candidate.levels!, now());
    let risk = result.risk;
    if (risk.outcome === 'PASSED' && !pairing)
      risk = suppressed('SUPPRESS_TELEGRAM_NOT_PAIRED', risk.levels);
    if (
      risk.outcome === 'PASSED' &&
      ai.current().enabled &&
      coolingDown(db, candidate, now())
    )
      risk = suppressed('SUPPRESS_COOLDOWN', risk.levels);
    const expiresAtMs =
      candidate.triggerCloseMs + candidate.params.risk.maxAgeSeconds * 1000;
    let review = ai.find(candidate.id);
    if (
      risk.outcome === 'PASSED' &&
      pairing &&
      (review || ai.current().enabled)
    ) {
      const { market, snapshot, quote } = result;
      review ??= await ai.review(
        {
          market: {
            exchange: market!.exchange,
            type: market!.marketType,
            product: market!.productType.slice(0, 128),
            venue: market!.venue.slice(0, 128),
            symbol: market!.nativeSymbol.slice(0, 128),
            isRwa: market!.isRwa,
            isReality: market!.isReality,
          },
          strategy: candidate.strategyId,
          strategyVersion: candidate.strategyVersion,
          direction: candidate.direction,
          timeframes: candidate.timeframes,
          clock: {
            triggerCloseMs: candidate.triggerCloseMs,
            evaluatedAtMs: candidate.evaluatedAtMs,
          },
          evidence: snapshot,
          quote,
          proposal: candidate.levels,
          riskLimits: candidate.params.risk,
        },
        lifecycle.signal,
        { id: candidate.id, pairingId: pairing.id, expiresAtMs },
      );
      if (review.status === 'RUNNING') return;
      if (review.reasonCode || !review.result)
        risk = reject(review.reasonCode ?? 'AI_INVALID_OUTPUT');
      else if (ai.current().revision !== review.settingsRevision)
        risk = suppressed('SUPPRESS_AI_SETTINGS_CHANGED');
      else if (
        review.pairingId !== pairing.id ||
        telegram.current().pairing?.id !== pairing.id
      )
        risk = suppressed('TELEGRAM_PAIRING_CHANGED');
      else {
        const proposal = candidate.levels!;
        const change = review.result.levelAdjustment;
        const levels = change
          ? {
              ...proposal,
              stop: change.stopPrice ?? proposal.stop,
              takeProfits: change.takeProfits.length
                ? change.takeProfits.map((target) => ({
                    price: target.targetPrice,
                    closePct: target.closePct,
                    ...(target.trailPolicy === 'NONE'
                      ? {}
                      : { trailPolicy: target.trailPolicy }),
                  }))
                : proposal.takeProfits,
            }
          : proposal;
        result = check(candidate, levels, now());
        risk = result.risk;
      }
    }
    const atMs = now();
    db.transaction((tx) => {
      const claimed = tx
        .update(signalCandidates)
        .set({ deliveryPending: false })
        .where(
          and(
            eq(signalCandidates.id, candidate.id),
            eq(signalCandidates.deliveryPending, true),
          ),
        )
        .run();
      if (!claimed.changes) return;
      if (risk.outcome === 'PASSED' && coolingDown(tx, candidate, atMs))
        risk = suppressed('SUPPRESS_COOLDOWN', risk.levels);
      tx.insert(riskEvaluations)
        .values({
          candidateId: candidate.id,
          stage: 'FINAL',
          ...risk,
          atMs,
          quote: result.quote,
        })
        .run();
      if (
        risk.outcome !== 'PASSED' ||
        !risk.levels ||
        !pairing ||
        !result.market
      )
        return;
      const id = randomUUID();
      const { entry, stop, takeProfits, weightedRR } = risk.levels;
      const {
        exchange,
        nativeSymbol,
        productType,
        quoteAsset,
        isRwa,
        isReality,
      } = result.market;
      const unit = quoteAsset ? ' ' + quoteAsset : '';
      const long = candidate.direction === 'LONG';
      const reasons =
        (long
          ? '趋势 EMA 多头排列，确认周期 RSI 回升，触发周期放量'
          : '趋势 EMA 空头排列，确认周期 RSI 回落，触发周期放量') +
        (candidate.params.breakPreviousCandle ? (long ? '突破' : '跌破') : '');
      const body = [
        (review ? '[AI 审核通过] ' : '[规则信号] ') +
          (long ? '做多 LONG' : '做空 SHORT'),
        '时间 ' +
          displayTime.format(candidate.triggerCloseMs) +
          ' (' +
          config.APP_TIMEZONE +
          ')',
        '市场 ' +
          (exchange === 'BITGET' ? 'Bitget' : 'Hyperliquid') +
          ' | ' +
          nativeSymbol +
          ' | ' +
          productType,
        '策略 ' +
          candidate.strategyId +
          ' v' +
          candidate.strategyVersion +
          ' · ' +
          candidate.timeframes.trend +
          '趋势 / ' +
          candidate.timeframes.confirm +
          '确认 / ' +
          candidate.timeframes.trigger +
          '触发',
        'K 线收盘 ' + result.snapshot?.candles.trigger.last.close + unit,
        '参考入场 ' + entry + unit,
        'SL ' + stop + unit,
        ...takeProfits.map(
          (target, index) =>
            'TP' +
            (index + 1) +
            ' ' +
            target.price +
            unit +
            '（' +
            target.closePct +
            '%）',
        ),
        '加权 R:R ' + weightedRR,
        '理由 ' + reasons + (candidate.params.oi ? '，OI 达到策略阈值' : ''),
        ...(review?.result
          ? [
              'AI 决策 ' +
                review.result.decision +
                ' · 主观评分 ' +
                review.result.confidenceScore +
                '/100',
              ...review.result.rationale.map((reason) => '审核理由 ' + reason),
              ...review.result.riskFlags.map((flag) => 'AI 风险 ' + flag),
            ]
          : []),
        ...takeProfits.flatMap((target, index) =>
          target.trailPolicy === 'BREAKEVEN_AFTER_TP1'
            ? ['TP' + (index + 1) + ' 管理建议 TP1 后移至保本']
            : target.trailPolicy === 'ATR_TRAIL_AFTER_TP1'
              ? [
                  'TP' +
                    (index + 1) +
                    ' 管理建议 TP1 后按触发周期 1.5×ATR 移动止损',
                ]
              : [],
        ),
        ...(isRwa || isReality
          ? ['风险 参考市场休市时可能出现流动性和基差变化。']
          : []),
        '策略提醒。请考虑手续费和滑点。',
      ].join('\n');
      const footer = '\n信号 ID ' + id;
      tx.insert(signals)
        .values({
          id,
          candidateId: candidate.id,
          levels: risk.levels,
          approvedAtMs: atMs,
          expiresAtMs,
          mode: review ? 'AI_REVIEW' : 'RULE_ONLY',
          aiRevision: review?.settingsRevision ?? null,
        })
        .run();
      initializeOutcome(
        tx,
        id,
        candidate.triggerTimeframe,
        atMs,
        risk.levels,
        candidate.evidence,
      );
      tx.insert(outboxMessages)
        .values({
          id: randomUUID(),
          dedupeKey: 'signal:' + id,
          signalId: id,
          pairingId: pairing.id,
          chatId: pairing.chatId,
          body: body.slice(0, 4096 - footer.length) + footer,
          nextAttemptMs: atMs,
          createdAtMs: atMs,
          expiresAtMs,
        })
        .run();
    });
  }

  function originalWasSent(
    store: Pick<AppDatabase, 'select'>,
    signalId: string,
    pairing: { id: string; chatId: string },
  ) {
    return !!store
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.signalId, signalId),
          eq(outboxMessages.kind, 'TRADE_SIGNAL'),
          eq(outboxMessages.status, 'SENT'),
          eq(outboxMessages.pairingId, pairing.id),
          eq(outboxMessages.chatId, pairing.chatId),
        ),
      )
      .get();
  }

  const enqueueUpdate: SignalUpdate = (store, update) => {
    const atMs = now();
    const expiresAtMs = update.atMs + updateTtlMs;
    if (atMs >= expiresAtMs || lifecycle.signal.aborted) return;
    const { pairing, signalUpdatesEnabled } = telegram.current();
    if (
      !pairing ||
      !signalUpdatesEnabled ||
      !originalWasSent(store, update.signalId, pairing)
    )
      return;
    store
      .insert(outboxMessages)
      .values({
        id: randomUUID(),
        dedupeKey: `update:${update.signalId}:${update.atMs}`,
        kind: 'SIGNAL_UPDATE',
        signalId: update.signalId,
        pairingId: pairing.id,
        chatId: pairing.chatId,
        body: [
          '[理论信号更新] ' + update.exchange + ' · ' + update.symbol,
          displayTime.format(update.atMs),
          ...update.lines,
          '信号 ID ' + update.signalId,
        ].join('\n'),
        createdAtMs: atMs,
        nextAttemptMs: atMs,
        expiresAtMs,
      })
      .onConflictDoNothing()
      .run();
  };

  function enqueueAlert(
    store: Pick<AppDatabase, 'select' | 'insert'>,
    event: Pick<
      typeof systemEvents.$inferSelect,
      'id' | 'code' | 'source' | 'state' | 'createdAtMs'
    >,
  ) {
    const { pairing, systemAlertsEnabled } = telegram.current();
    if (!pairing || !systemAlertsEnabled || lifecycle.signal.aborted) return;
    const prior = store
      .select({ id: outboxMessages.id })
      .from(outboxMessages)
      .innerJoin(
        systemEvents,
        eq(systemEvents.id, outboxMessages.systemEventId),
      )
      .where(
        and(
          eq(systemEvents.code, event.code),
          eq(systemEvents.source, event.source),
          eq(systemEvents.state, event.state),
          eq(outboxMessages.pairingId, pairing.id),
          gt(outboxMessages.createdAtMs, event.createdAtMs - 30 * 60_000),
        ),
      )
      .get();
    if (prior) return;
    store
      .insert(outboxMessages)
      .values({
        id: randomUUID(),
        dedupeKey: 'alert:' + event.id,
        kind: 'SYSTEM_ALERT',
        systemEventId: event.id,
        pairingId: pairing.id,
        chatId: pairing.chatId,
        body: [
          event.state === 'RECOVERED' ? '[系统恢复]' : '[系统告警]',
          event.source,
          systemEventLabels[event.code] ?? event.code,
          displayTime.format(event.createdAtMs),
        ].join(' · '),
        createdAtMs: event.createdAtMs,
        nextAttemptMs: event.createdAtMs,
        expiresAtMs: event.createdAtMs + 15 * 60_000,
      })
      .onConflictDoNothing()
      .run();
  }

  async function tickOutbox() {
    if (lifecycle.signal.aborted) return;
    if (recoverOutbox) {
      db.update(outboxMessages)
        .set({
          status: 'DELIVERY_UNKNOWN',
          lastError: 'TELEGRAM_SEND_INTERRUPTED',
        })
        .where(eq(outboxMessages.status, 'SENDING'))
        .run();
      recoverOutbox = false;
    }
    const atMs = now();
    const {
      pairing,
      marketDailyLimit,
      globalDailyLimit,
      signalUpdatesEnabled,
      systemAlertsEnabled,
    } = telegram.current();
    const item = db.transaction((tx) => {
      const pending = tx
        .select()
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.status, 'PENDING'),
            lte(outboxMessages.nextAttemptMs, atMs),
          ),
        )
        .orderBy(
          sql`case when ${outboxMessages.kind} = 'TRADE_SIGNAL' then 0 else 1 end`,
          outboxMessages.nextAttemptMs,
          outboxMessages.createdAtMs,
        )
        .get();
      if (!pending) return undefined;
      let reason: string | null = null;
      if (pending.expiresAtMs <= atMs) reason = 'DELIVERY_EXPIRED';
      else if (
        !pairing ||
        pending.pairingId !== pairing.id ||
        pending.chatId !== pairing.chatId
      )
        reason = 'TELEGRAM_PAIRING_CHANGED';
      else if (pending.kind === 'SYSTEM_ALERT' && !systemAlertsEnabled)
        reason = 'SYSTEM_ALERTS_DISABLED';
      if (
        !reason &&
        tx
          .select({ id: outboxMessages.id })
          .from(outboxMessages)
          .where(
            and(
              eq(outboxMessages.pairingId, pending.pairingId),
              eq(outboxMessages.lastError, 'TELEGRAM_HTTP_429'),
              gt(outboxMessages.nextAttemptMs, atMs),
            ),
          )
          .get()
      )
        return undefined;
      if (!reason && pending.signalId) {
        const signal = tx
          .select()
          .from(signals)
          .where(eq(signals.id, pending.signalId))
          .get()!;
        const candidate = signalDetail(db, signal.candidateId)!;
        if (pending.kind === 'SIGNAL_UPDATE') {
          if (!signalUpdatesEnabled) reason = 'SIGNAL_UPDATES_DISABLED';
          else if (!pairing || !originalWasSent(tx, pending.signalId, pairing))
            reason = 'ORIGINAL_DELIVERY_UNAVAILABLE';
        } else {
          const currentAi = ai.current();
          reason =
            currentAi.enabled !== (signal.mode === 'AI_REVIEW') ||
            (signal.aiRevision && currentAi.revision !== signal.aiRevision)
              ? 'SUPPRESS_AI_SETTINGS_CHANGED'
              : check(candidate, signal.levels, atMs).risk.reasonCode;
        }
        if (!reason) {
          const counts = tx
            .select({ marketId: signalCandidates.marketId, total: count() })
            .from(outboxMessages)
            .innerJoin(signals, eq(signals.id, outboxMessages.signalId))
            .innerJoin(
              signalCandidates,
              eq(signalCandidates.id, signals.candidateId),
            )
            .where(
              and(
                eq(outboxMessages.sendDay, day.format(atMs)),
                eq(outboxMessages.kind, pending.kind),
                inArray(outboxMessages.status, countedDeliveries),
              ),
            )
            .groupBy(signalCandidates.marketId)
            .all();
          if (
            (counts.find((row) => row.marketId === candidate.marketId)?.total ??
              0) >= marketDailyLimit ||
            counts.reduce((total, row) => total + row.total, 0) >=
              globalDailyLimit
          )
            reason = 'SUPPRESS_DAILY_LIMIT';
        }
      }
      const claim = eq(outboxMessages.id, pending.id);
      if (reason) {
        tx.update(outboxMessages)
          .set({ status: 'FAILED', lastError: reason })
          .where(claim)
          .run();
        return undefined;
      }
      tx.update(outboxMessages)
        .set({
          status: 'SENDING',
          attempts: pending.attempts + 1,
          sendDay: day.format(atMs),
          lastError: null,
        })
        .where(claim)
        .run();
      return pending;
    });
    if (!item || !pairing) return;
    const result = await telegram.send(
      pairing.token,
      pairing.chatId,
      item.body,
      lifecycle.signal,
    );
    const where = and(
      eq(outboxMessages.id, item.id),
      eq(outboxMessages.status, 'SENDING'),
    );
    if (result.ok) {
      db.update(outboxMessages)
        .set({
          status: 'SENT',
          telegramMessageId: String(result.data.message_id),
          sentAtMs: now(),
        })
        .where(where)
        .run();
      return;
    }
    const nextAttemptMs =
      now() + Math.max(result.retryAfterMs ?? 0, 1000 * 2 ** item.attempts);
    const canRetry =
      result.retryAfterMs !== null &&
      item.attempts + 1 < 3 &&
      nextAttemptMs < item.expiresAtMs &&
      !item.manual;
    db.update(outboxMessages)
      .set({
        status:
          result.code === 'TELEGRAM_RESPONSE_UNKNOWN'
            ? 'DELIVERY_UNKNOWN'
            : canRetry
              ? 'PENDING'
              : 'FAILED',
        lastError: result.code,
        nextAttemptMs,
      })
      .where(where)
      .run();
  }

  function enqueueTest(actor: string) {
    const { pairing } = telegram.current();
    if (!pairing)
      throw new ApiError(
        409,
        'TELEGRAM_NOT_PAIRED',
        '请先配对 Telegram 私聊。',
      );
    const id = randomUUID();
    const atMs = now();
    db.transaction((tx) => {
      tx.insert(outboxMessages)
        .values({
          id,
          dedupeKey: 'test:' + id,
          kind: 'TELEGRAM_TEST',
          pairingId: pairing.id,
          chatId: pairing.chatId,
          body: 'Market Sentinel Telegram 测试消息',
          createdAtMs: atMs,
          nextAttemptMs: atMs,
          expiresAtMs: atMs + 60_000,
        })
        .run();
      tx.insert(auditLogs)
        .values({
          actor,
          action: 'TELEGRAM_TEST',
          targetType: 'outbox',
          targetId: id,
          createdAtMs: atMs,
        })
        .run();
    });
    return telegram.settings();
  }

  function resendable(signalId: string | null): Outbox | undefined {
    const { pairing } = telegram.current();
    if (!signalId || !pairing) return;
    const rows = db
      .select()
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.signalId, signalId),
          eq(outboxMessages.kind, 'TRADE_SIGNAL'),
        ),
      )
      .all();
    if (rows.length !== 1) return;
    const [item] = rows;
    if (
      item &&
      item.status === 'DELIVERY_UNKNOWN' &&
      item.expiresAtMs > now() &&
      item.pairingId === pairing.id &&
      item.chatId === pairing.chatId
    )
      return item;
  }

  function resend(candidateId: string, actor: string) {
    const candidate = signalDetail(db, candidateId);
    if (!candidate)
      throw new ApiError(404, 'SIGNAL_NOT_FOUND', '找不到这条候选记录。');
    const atMs = now();
    db.transaction((tx) => {
      const item = resendable(candidate.signalId);
      if (
        !item ||
        !candidate.levels ||
        !candidate.finalRisk?.levels ||
        check(candidate, candidate.finalRisk.levels, atMs).risk.outcome !==
          'PASSED'
      )
        throw new ApiError(
          409,
          'DELIVERY_NOT_RESENDABLE',
          '此信号当前无法补发。',
        );
      const id = randomUUID();
      tx.insert(outboxMessages)
        .values({
          id,
          dedupeKey: 'resend:' + item.signalId,
          signalId: item.signalId,
          pairingId: item.pairingId,
          chatId: item.chatId,
          body: '补发 · 可能重复\n' + item.body.slice(0, 4084),
          manual: true,
          nextAttemptMs: atMs,
          createdAtMs: atMs,
          expiresAtMs: item.expiresAtMs,
        })
        .run();
      tx.insert(auditLogs)
        .values({
          actor,
          action: 'TELEGRAM_RESEND',
          targetType: 'outbox',
          targetId: id,
          createdAtMs: atMs,
        })
        .run();
    });
  }

  function diagnostics() {
    const counts = db
      .select({ status: outboxMessages.status, total: count() })
      .from(outboxMessages)
      .where(
        inArray(outboxMessages.status, [
          'PENDING',
          'SENDING',
          'DELIVERY_UNKNOWN',
        ]),
      )
      .groupBy(outboxMessages.status)
      .all();
    const latest = db
      .select({
        approvedAtMs: signals.approvedAtMs,
        triggerCloseMs: signalCandidates.triggerCloseMs,
      })
      .from(signals)
      .innerJoin(signalCandidates, eq(signalCandidates.id, signals.candidateId))
      .orderBy(desc(signals.approvedAtMs))
      .get();
    return {
      pending: counts
        .filter((row) => row.status !== 'DELIVERY_UNKNOWN')
        .reduce((total, row) => total + row.total, 0),
      deliveryUnknown:
        counts.find((row) => row.status === 'DELIVERY_UNKNOWN')?.total ?? 0,
      lastQueueDelayMs: latest
        ? latest.approvedAtMs - latest.triggerCloseMs
        : null,
    };
  }

  async function testAi(actor: string) {
    await ai.review(
      {
        purpose: 'connection_test',
        direction: 'LONG',
        market: { symbol: 'TEST', type: 'SPOT' },
        proposal: {
          entry: '100',
          stop: '98',
          takeProfits: [
            { price: '103', closePct: 50 },
            { price: '106', closePct: 50 },
          ],
          weightedRR: '2.25',
        },
      },
      lifecycle.signal,
      undefined,
      actor,
    );
    return ai.settings();
  }

  const tickPair = () => telegram.poll(lifecycle.signal);
  function schedule(task: () => Promise<void> | void) {
    if (tasks.has(task)) return;
    tasks.set(
      task,
      Promise.resolve()
        .then(task)
        .catch(onError)
        .finally(() => tasks.delete(task)),
    );
  }
  return {
    telegram,
    ai,
    testAi,
    enqueueTest,
    enqueueUpdate,
    enqueueAlert,
    resend,
    diagnostics,
    tickSignals,
    tickOutbox,
    tickPair,
    canResend: (signalId: string | null) => !!resendable(signalId),
    start() {
      if (timer || lifecycle.signal.aborted) return;
      timer = setInterval(() => {
        schedule(tickSignals);
        schedule(tickOutbox);
        schedule(tickPair);
      }, 1000);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      lifecycle.abort();
      await Promise.all(tasks.values());
    },
  };
}

export type Notifications = ReturnType<typeof createNotifications>;
