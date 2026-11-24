import { existsSync, statSync } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { startOfCalendarDay } from '@market-sentinel/contracts';
import type { SystemDiagnostics } from '@market-sentinel/contracts/notifications';
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  sql,
} from 'drizzle-orm';
import type { AppConfig } from './config.js';
import {
  verifyDatabaseFile,
  writeDatabaseBackup,
  type AppDatabase,
} from './database.js';
import { monitoredTimeframes, warmupTarget } from './market-data/model.js';
import type { MarketData } from './market-data/service.js';
import { configuredMarkets } from './market-data/store.js';
import type { Notifications } from './notification/service.js';
import { deliveryFields } from './notification/telegram.js';
import {
  aiReviews,
  candles,
  markets,
  monitorConfigs,
  oiSnapshots,
  outboxMessages,
  quotes,
  riskEvaluations,
  signalCandidates,
  signalOutcomes,
  signals,
  systemEvents,
} from './schema.js';

const dayMs = 86_400_000;
const batchSize = 1_000;
const backupName = /^backup-\d{4}-\d{2}-\d{2}\.sqlite$/;
type Event = typeof systemEvents.$inferInsert;

function trackedPeriods(database: AppDatabase) {
  return new Set(
    configuredMarkets(database)
      .filter(
        ({ market, config }) => config.enabled && market.status === 'ACTIVE',
      )
      .flatMap(({ config }) =>
        monitoredTimeframes(config).map(
          (timeframe) => config.marketId + '/' + timeframe,
        ),
      ),
  );
}

export async function cleanupMarketData(
  db: AppDatabase,
  config: AppConfig,
  now: number,
) {
  const configured = trackedPeriods(db);
  const protectedStarts = new Map<string, number>();
  const tracking = db
    .select({
      marketId: signalCandidates.marketId,
      timeframe: signalCandidates.triggerTimeframe,
      start: signalOutcomes.startAtMs,
    })
    .from(signalOutcomes)
    .innerJoin(signals, eq(signals.id, signalOutcomes.signalId))
    .innerJoin(signalCandidates, eq(signalCandidates.id, signals.candidateId))
    .where(isNull(signalOutcomes.finishedAtMs))
    .all();
  for (const { marketId, timeframe, start } of tracking) {
    const key = marketId + '/' + timeframe;
    protectedStarts.set(
      key,
      Math.min(protectedStarts.get(key) ?? start, start),
    );
  }

  const removeCandles = db.$client.prepare(`
    DELETE FROM candles WHERE rowid IN (
      SELECT rowid FROM candles WHERE market_id = ? AND timeframe = ? AND open_time_ms < ? LIMIT ${batchSize}
    )
  `);
  const keepWarm = db.$client.prepare(`
    SELECT open_time_ms FROM candles WHERE market_id = ? AND timeframe = ?
    ORDER BY open_time_ms DESC LIMIT 1 OFFSET ${warmupTarget - 1}
  `);
  const candleGroups = db
    .selectDistinct({
      marketId: candles.marketId,
      timeframe: candles.timeframe,
    })
    .from(candles)
    .all();
  let candleRows = 0;
  for (const { marketId, timeframe } of candleGroups) {
    const key = marketId + '/' + timeframe;
    const days = config.CANDLE_RETENTION_DAYS_BY_TIMEFRAME[timeframe] ?? 365;
    const warm = configured.has(key)
      ? Number(keepWarm.get(marketId, timeframe)?.open_time_ms ?? 0)
      : Infinity;
    const cutoff = Math.min(
      now - days * dayMs,
      protectedStarts.get(key) ?? Infinity,
      warm,
    );
    for (;;) {
      const removed = Number(
        removeCandles.run(marketId, timeframe, cutoff).changes,
      );
      candleRows += removed;
      if (removed < batchSize) break;
      await setImmediate();
    }
  }

  const removeOi = db.$client.prepare(`
    DELETE FROM oi_snapshots WHERE rowid IN (
      SELECT rowid FROM oi_snapshots WHERE market_id = ? AND time_ms < ? LIMIT ${batchSize}
    )
  `);
  const oiMarkets = db
    .selectDistinct({ marketId: oiSnapshots.marketId })
    .from(oiSnapshots)
    .all();
  let oiRows = 0;
  for (const { marketId } of oiMarkets) {
    for (;;) {
      const removed = Number(
        removeOi.run(marketId, now - config.OI_RETENTION_DAYS * dayMs).changes,
      );
      oiRows += removed;
      if (removed < batchSize) break;
      await setImmediate();
    }
  }

  const quoteRows = db.transaction((tx) => {
    let removed = 0;
    for (const row of tx.select().from(quotes).all()) {
      const latest = Math.max(
        0,
        ...Object.values(row.quote).map((field) => field?.timestampMs ?? 0),
      );
      if (latest < now - 30 * dayMs)
        removed += Number(
          tx.delete(quotes).where(eq(quotes.marketId, row.marketId)).run()
            .changes,
        );
    }
    return removed;
  });
  db.$client.exec('PRAGMA wal_checkpoint(PASSIVE)');
  return { candles: candleRows, openInterest: oiRows, quotes: quoteRows };
}

export function createOperations(
  db: AppDatabase,
  config: AppConfig,
  marketData: Pick<MarketData, 'now' | 'diagnostics'>,
  notifications: Notifications,
  logError: (code: string) => void,
) {
  const { now } = marketData;
  const timeZone = config.APP_TIMEZONE;
  const calendar = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localHour = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const badSince = new Map<string, number>();
  let missingDatabaseSince: number | undefined;
  let nextMaintenanceAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;

  function databaseUnavailable() {
    if (missingDatabaseSince !== undefined) return;
    missingDatabaseSince = now();
    logError('DATABASE_UNAVAILABLE');
  }

  function record(event: Event, notify = false) {
    db.transaction((tx) => {
      const row = tx
        .insert(systemEvents)
        .values(event)
        .onConflictDoNothing()
        .returning()
        .get();
      if (row && notify) notifications.enqueueAlert(tx, row);
    });
  }

  function observe(
    source: string,
    code: string,
    active: boolean,
    atMs: number,
    options: {
      severity?: 'WARN' | 'ERROR';
      delay?: number;
      detail?: Event['detail'];
      notify?: boolean;
    } = {},
  ) {
    const key = source + '/' + code;
    const previous = db
      .select({ state: systemEvents.state })
      .from(systemEvents)
      .where(
        and(
          eq(systemEvents.source, source),
          eq(systemEvents.code, code),
          ne(systemEvents.state, 'INFO'),
        ),
      )
      .orderBy(desc(systemEvents.createdAtMs), desc(systemEvents.id))
      .get();
    if (active) {
      const since = badSince.get(key) ?? atMs;
      badSince.set(key, since);
      if (previous?.state !== 'OPEN' && atMs - since >= (options.delay ?? 0))
        record(
          {
            source,
            code,
            state: 'OPEN',
            severity: options.severity ?? 'WARN',
            detail: { sinceMs: since, ...options.detail },
            createdAtMs: atMs,
          },
          options.notify ?? true,
        );
    } else {
      badSince.delete(key);
      if (previous?.state === 'OPEN')
        record(
          {
            source,
            code,
            state: 'RECOVERED',
            severity: 'INFO',
            detail: {},
            createdAtMs: atMs,
          },
          options.notify ?? true,
        );
    }
  }

  function pollHealth(atMs: number) {
    const watched = new Set(
      configuredMarkets(db)
        .filter(
          ({ config, market }) => config.enabled && market.status === 'ACTIVE',
        )
        .map(({ market }) => market.exchange),
    );
    for (const provider of marketData.diagnostics().providers) {
      const active = watched.has(provider.exchange);
      observe(
        provider.exchange,
        'WS_DISCONNECTED',
        active && provider.connection !== 'CONNECTED',
        atMs,
        { delay: 120_000 },
      );
      observe(
        provider.exchange,
        'REST_FAILED',
        active &&
          (provider.lastRestError !== null ||
            provider.catalog.failedPartitions.length > 0),
        atMs,
        { delay: 120_000 },
      );
    }

    const ai = notifications.ai.current();
    observe(
      'OpenAI',
      'AI_CONFIGURATION',
      ai.enabled && ai.configurationError !== null,
      atMs,
      {
        detail: ai.configurationError ? { reason: ai.configurationError } : {},
      },
    );
    const latestAi = ai.enabled
      ? db
          .select({ reason: aiReviews.reasonCode })
          .from(aiReviews)
          .where(eq(aiReviews.settingsRevision, ai.revision))
          .orderBy(desc(aiReviews.createdAtMs), desc(aiReviews.id))
          .get()
      : undefined;
    observe(
      'OpenAI',
      'AI_AUTH_FAILED',
      latestAi?.reason === 'AI_AUTH_FAILED',
      atMs,
    );
    const date = calendar.format(atMs);
    const budget = db
      .select({ id: aiReviews.id })
      .from(aiReviews)
      .where(
        and(
          eq(aiReviews.day, date),
          eq(aiReviews.reasonCode, 'AI_BUDGET_EXHAUSTED'),
        ),
      )
      .get();
    if (budget && ai.enabled)
      record(
        {
          source: 'OpenAI',
          code: 'AI_BUDGET_EXHAUSTED',
          state: 'INFO',
          severity: 'WARN',
          detail: { date },
          createdAtMs: atMs,
          dedupeKey: 'ai-budget:' + date,
        },
        true,
      );

    const telegram = notifications.telegram.current();
    const dispatch = telegram.pairing
      ? db
          .select({ error: outboxMessages.lastError })
          .from(outboxMessages)
          .where(
            and(
              eq(outboxMessages.pairingId, telegram.pairing.id),
              ne(outboxMessages.kind, 'SYSTEM_ALERT'),
              inArray(outboxMessages.status, [
                'SENT',
                'FAILED',
                'DELIVERY_UNKNOWN',
              ]),
            ),
          )
          .orderBy(desc(outboxMessages.createdAtMs), desc(outboxMessages.id))
          .get()
      : undefined;
    observe(
      'Telegram',
      'TELEGRAM_CREDENTIALS',
      !!(telegram.row?.tokenRef && !telegram.token) ||
        dispatch?.error === 'TELEGRAM_HTTP_401' ||
        dispatch?.error === 'TELEGRAM_HTTP_403',
      atMs,
      { notify: false },
    );

    if (missingDatabaseSince !== undefined) {
      const sinceMs = missingDatabaseSince;
      record({
        source: 'SQLite',
        code: 'DATABASE_UNAVAILABLE',
        severity: 'ERROR',
        state: 'OPEN',
        detail: { sinceMs },
        createdAtMs: sinceMs,
        dedupeKey: 'db-outage:' + sinceMs,
      });
      record(
        {
          source: 'SQLite',
          code: 'DATABASE_UNAVAILABLE',
          severity: 'INFO',
          state: 'RECOVERED',
          detail: { sinceMs },
          createdAtMs: atMs,
          dedupeKey: 'db-recovered:' + sinceMs,
        },
        true,
      );
      missingDatabaseSince = undefined;
    }
  }

  async function maintain(atMs: number) {
    const location = db.$client.location();
    if (!location) return;
    const date = calendar.format(atMs);
    const completion = db
      .select({ id: systemEvents.id })
      .from(systemEvents)
      .where(eq(systemEvents.dedupeKey, 'retention:' + date))
      .get();
    if (completion) return;
    const dir = join(dirname(location), basename(location) + '.backups');
    const target = join(dir, 'backup-' + date + '.sqlite');
    try {
      if (existsSync(target)) {
        try {
          await verifyDatabaseFile(target);
        } catch {
          await writeDatabaseBackup(db, target);
        }
      } else await writeDatabaseBackup(db, target);
      const entries = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && backupName.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const name of entries
        .filter((name) => name !== basename(target))
        .slice(6))
        await unlink(join(dir, name));
      record({
        source: 'SQLite',
        code: 'BACKUP_VERIFIED',
        state: 'INFO',
        severity: 'INFO',
        detail: { date },
        createdAtMs: now(),
        dedupeKey: 'backup:' + date,
      });
      observe('SQLite', 'BACKUP_FAILED', false, now());
    } catch {
      logError('BACKUP_FAILED');
      observe('SQLite', 'BACKUP_FAILED', true, now(), { severity: 'ERROR' });
      return;
    }
    try {
      const counts = await cleanupMarketData(db, config, atMs);
      record({
        source: 'SQLite',
        code: 'RETENTION_COMPLETE',
        state: 'INFO',
        severity: 'INFO',
        detail: counts,
        createdAtMs: now(),
        dedupeKey: 'retention:' + date,
      });
      observe('SQLite', 'RETENTION_FAILED', false, now());
    } catch {
      logError('RETENTION_FAILED');
      observe('SQLite', 'RETENTION_FAILED', true, now(), { severity: 'ERROR' });
    }
  }

  function diagnostics(): SystemDiagnostics {
    const view = db
      .select({
        id: systemEvents.id,
        source: systemEvents.source,
        code: systemEvents.code,
        state: systemEvents.state,
        severity: systemEvents.severity,
        detail: systemEvents.detail,
        createdAtMs: systemEvents.createdAtMs,
        delivery: deliveryFields,
      })
      .from(systemEvents)
      .leftJoin(
        outboxMessages,
        eq(outboxMessages.systemEventId, systemEvents.id),
      );
    const latestIds = db
      .select({ id: sql`max(${systemEvents.id})` })
      .from(systemEvents)
      .where(ne(systemEvents.state, 'INFO'))
      .groupBy(systemEvents.source, systemEvents.code);
    const active = view
      .$dynamic()
      .where(
        and(
          eq(systemEvents.state, 'OPEN'),
          inArray(systemEvents.id, latestIds),
        ),
      )
      .orderBy(desc(systemEvents.createdAtMs), desc(systemEvents.id))
      .all();
    const recent = view
      .where(
        and(
          ne(systemEvents.code, 'RETENTION_COMPLETE'),
          ne(systemEvents.code, 'BACKUP_VERIFIED'),
        ),
      )
      .orderBy(desc(systemEvents.createdAtMs), desc(systemEvents.id))
      .limit(15)
      .all();
    const latest = (code: string) =>
      db
        .select({ atMs: systemEvents.createdAtMs })
        .from(systemEvents)
        .where(eq(systemEvents.code, code))
        .orderBy(desc(systemEvents.createdAtMs))
        .get()?.atMs ?? null;
    const location = db.$client.location();
    const databaseBytes = location
      ? (statSync(location, { throwIfNoEntry: false })?.size ?? 0) +
        (statSync(location + '-wal', { throwIfNoEntry: false })?.size ?? 0)
      : null;
    return {
      alerts: recent,
      active,
      databaseBytes,
      latestBackupAtMs: latest('BACKUP_VERIFIED'),
      latestCleanupAtMs: latest('RETENTION_COMPLETE'),
    };
  }

  function overview() {
    const atMs = now();
    const start = startOfCalendarDay(calendar.format(atMs), timeZone);
    const today = (
      column:
        | typeof signalCandidates.evaluatedAtMs
        | typeof riskEvaluations.atMs
        | typeof outboxMessages.sentAtMs,
    ) => and(gte(column, start), lte(column, atMs));
    const monitors = db
      .select({ total: count() })
      .from(monitorConfigs)
      .where(eq(monitorConfigs.enabled, true))
      .get()!.total;
    const candidates = db
      .select({ total: count() })
      .from(signalCandidates)
      .where(today(signalCandidates.evaluatedAtMs))
      .get()!.total;
    const preRejected = db
      .select({ total: count() })
      .from(signalCandidates)
      .innerJoin(
        riskEvaluations,
        eq(riskEvaluations.candidateId, signalCandidates.id),
      )
      .where(
        and(
          today(signalCandidates.evaluatedAtMs),
          eq(riskEvaluations.stage, 'PRE'),
          eq(riskEvaluations.outcome, 'REJECTED'),
        ),
      )
      .get()!.total;
    const finalRejected = db
      .select({ total: count() })
      .from(riskEvaluations)
      .where(
        and(
          today(riskEvaluations.atMs),
          eq(riskEvaluations.stage, 'FINAL'),
          eq(riskEvaluations.outcome, 'REJECTED'),
        ),
      )
      .get()!.total;
    const sent = db
      .select({
        total: sql`count(distinct ${outboxMessages.signalId})`.mapWith(Number),
      })
      .from(outboxMessages)
      .where(
        and(
          today(outboxMessages.sentAtMs),
          eq(outboxMessages.kind, 'TRADE_SIGNAL'),
          eq(outboxMessages.status, 'SENT'),
        ),
      )
      .get()!.total;
    const recentSignals = db
      .select({
        signalId: signals.id,
        candidateId: signalCandidates.id,
        exchange: markets.exchange,
        symbol: markets.nativeSymbol,
        sentAtMs: sql`max(${outboxMessages.sentAtMs})`.mapWith(Number),
      })
      .from(outboxMessages)
      .innerJoin(signals, eq(signals.id, outboxMessages.signalId))
      .innerJoin(signalCandidates, eq(signalCandidates.id, signals.candidateId))
      .innerJoin(markets, eq(markets.id, signalCandidates.marketId))
      .where(
        and(
          eq(outboxMessages.kind, 'TRADE_SIGNAL'),
          eq(outboxMessages.status, 'SENT'),
        ),
      )
      .groupBy(signals.id)
      .orderBy(desc(sql`max(${outboxMessages.sentAtMs})`), desc(signals.id))
      .limit(6)
      .all();
    return {
      timeZone,
      monitors,
      candidates,
      rejected: preRejected + finalRejected,
      sent,
      recentSignals,
      system: diagnostics(),
    };
  }

  async function tick() {
    const atMs = now();
    pollHealth(atMs);
    const hour = Number(localHour.format(atMs));
    if (hour < 3 || hour >= 5 || atMs < nextMaintenanceAt) return;
    nextMaintenanceAt = atMs + 15 * 60_000;
    await maintain(atMs);
  }

  return {
    databaseUnavailable,
    diagnostics,
    overview,
    tick,
    start() {
      if (timer) return;
      const schedule = () => {
        if (!running)
          running = tick()
            .catch(databaseUnavailable)
            .finally(() => {
              running = undefined;
            });
      };
      schedule();
      timer = setInterval(schedule, 30_000);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}

export type Operations = ReturnType<typeof createOperations>;
