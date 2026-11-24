import { randomUUID } from 'node:crypto';
import {
  marketQuerySchema,
  monitorBatchSchema,
  monitorCreateSchema,
  monitorPatchSchema,
} from '@market-sentinel/contracts/markets';
import type { Market, MonitorConfig } from '@market-sentinel/contracts/markets';
import {
  signalQuerySchema,
  strategyParametersSchema,
} from '@market-sentinel/contracts/strategies';
import { MARKET_TYPES } from '@market-sentinel/domain';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, validated } from '../api-error.js';
import { requireSession } from '../auth.js';
import type { AppDatabase } from '../database.js';
import type { Notifications } from '../notification/service.js';
import { auditLogs, monitorConfigs } from '../schema.js';
import type { StrategyService } from '../strategy/service.js';
import {
  listSignals,
  saveStrategyVersion,
  signalDetail,
  strategyConfiguration,
  strategyTemplate,
} from '../strategy/store.js';
import { monitoredTimeframes } from './model.js';
import type { MarketData } from './service.js';
import { configuredMarkets, marketById, marketPage } from './store.js';
import type { MonitorRow } from './store.js';

const idParameter = z.strictObject({ id: z.uuid() });

function auditRow(
  actor: string,
  action: string,
  targetId: string,
  targetType = 'monitor',
) {
  return { actor, action, targetId, targetType, createdAtMs: Date.now() };
}

function ensureSupported(market: Market, config: MonitorConfig) {
  if (config.enabled && market.status !== 'ACTIVE') {
    throw new ApiError(409, 'MARKET_UNAVAILABLE', '该市场当前无法开启监控。');
  }
  const unsupported = monitoredTimeframes(config).filter(
    (timeframe) => !market.capabilities.intervals.includes(timeframe),
  );
  if (unsupported.length) {
    const reason =
      market.intervalRestrictions[unsupported[0]!] ?? '交易所不支持此周期。';
    throw new ApiError(
      422,
      'UNSUPPORTED_TIMEFRAME',
      reason,
      unsupported.map((field) => ({ field, code: 'UNSUPPORTED_TIMEFRAME' })),
    );
  }
}

export function registerMarketRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  service: MarketData,
  strategies: StrategyService,
  timeZone: string,
  notifications: Notifications,
) {
  const actor = (request: FastifyRequest) =>
    requireSession(database, request).username;

  function requireMarket(marketId: string) {
    const row = marketById(database, marketId);
    if (!row)
      throw new ApiError(404, 'MARKET_NOT_FOUND', '未在目录中找到该市场。');
    return row;
  }

  function requireMonitor(id: string) {
    const row = database
      .select()
      .from(monitorConfigs)
      .where(eq(monitorConfigs.id, id))
      .get();
    if (!row) throw new ApiError(404, 'MONITOR_NOT_FOUND', '监控配置不存在。');
    return row;
  }

  const listMonitors = () =>
    service.listMonitors().map((monitor) => ({
      ...monitor,
      strategy: strategies.describe(
        requireMonitor(monitor.id),
        monitor.market.marketType,
      ),
    }));

  function ensureCurrent(before: MonitorRow) {
    if (JSON.stringify(requireMonitor(before.id)) !== JSON.stringify(before)) {
      throw new ApiError(
        409,
        'MONITOR_CHANGED',
        '监控配置已更新，请刷新后再试。',
      );
    }
  }

  function ensureCapacity(changes: Array<MonitorConfig & { id: string }>) {
    const next = new Map(changes.map((change) => [change.id, change]));
    const selected = configuredMarkets(database).map(({ config, market }) => {
      const replacement = next.get(config.id);
      next.delete(config.id);
      return { market: service.view(market), config: replacement ?? config };
    });
    for (const config of next.values())
      selected.push({
        config,
        market: service.view(requireMarket(config.marketId)),
      });
    const exchange = service.capacityExceeded(selected);
    if (exchange)
      throw new ApiError(
        409,
        'SUBSCRIPTION_CAPACITY',
        exchange + ' 已达到订阅容量。请暂停监控或减少额外周期。',
      );
  }

  app.get('/markets', async (request) => {
    actor(request);
    const query = validated(marketQuerySchema, request.query);
    const rows = marketPage(database, query);
    return {
      requestId: request.id,
      data: {
        items: rows.slice(0, query.limit).map(service.view),
        nextOffset:
          rows.length > query.limit ? query.offset + query.limit : null,
      },
    };
  });

  app.get('/markets/:id', async (request) => {
    actor(request);
    const { id } = validated(idParameter, request.params);
    return {
      requestId: request.id,
      data: await service.checkPeriods(requireMarket(id)),
    };
  });

  app.post('/markets/sync', async (request, reply) => {
    const username = actor(request);
    if (!service.diagnostics().syncing) {
      database
        .insert(auditLogs)
        .values(
          auditRow(username, 'MARKET_SYNC_REQUESTED', 'all', 'market_catalog'),
        )
        .run();
      void service
        .runSync()
        .catch(() =>
          request.log.warn(
            { code: 'MARKET_SYNC_FAILED' },
            'Market sync failed',
          ),
        );
    }
    return reply
      .code(202)
      .send({ requestId: request.id, data: { syncing: true } });
  });

  app.get('/monitors', async (request) => {
    actor(request);
    return { requestId: request.id, data: listMonitors() };
  });

  app.post('/monitors', async (request, reply) => {
    const username = actor(request);
    const settings = validated(monitorCreateSchema, request.body);
    const config = {
      ...settings,
      extra: [...new Set(settings.extra)],
      id: randomUUID(),
    };
    const market = requireMarket(config.marketId);
    await service.checkPeriods(market, monitoredTimeframes(config));
    database.transaction((tx) => {
      ensureSupported(service.view(requireMarket(config.marketId)), config);
      const existing = tx
        .select({ id: monitorConfigs.id })
        .from(monitorConfigs)
        .where(eq(monitorConfigs.marketId, config.marketId))
        .get();
      if (existing)
        throw new ApiError(409, 'MONITOR_EXISTS', '此市场已有监控配置。');
      ensureCapacity([config]);
      tx.insert(monitorConfigs)
        .values({ ...config, strategyAfterMs: service.now() })
        .run();
      tx.insert(auditLogs)
        .values(auditRow(username, 'MONITOR_CREATED', config.id))
        .run();
    });
    service.reconcile();
    return reply.code(201).send({
      requestId: request.id,
      data: listMonitors().find((monitor) => monitor.id === config.id),
    });
  });

  app.patch('/monitors/:id', async (request) => {
    const username = actor(request);
    const { id } = validated(idParameter, request.params);
    const { strategy, ...patch } = validated(monitorPatchSchema, request.body);
    const before = requireMonitor(id);
    const candidate = {
      ...before,
      ...patch,
      extra: [...new Set(patch.extra ?? before.extra)],
    };
    const needsValidation =
      patch.trigger !== undefined ||
      patch.confirm !== undefined ||
      patch.trend !== undefined ||
      patch.extra !== undefined ||
      patch.enabled === true;
    if (needsValidation)
      await service.checkPeriods(
        requireMarket(before.marketId),
        monitoredTimeframes(candidate),
      );
    const resetStrategy = database.transaction((tx) => {
      ensureCurrent(before);
      const market = requireMarket(before.marketId);
      if (needsValidation) {
        ensureSupported(service.view(market), candidate);
        if (candidate.enabled) ensureCapacity([candidate]);
      }

      const periodsChanged =
        before.trigger !== candidate.trigger ||
        before.confirm !== candidate.confirm ||
        before.trend !== candidate.trend;
      const { marketType } = market;
      if (
        strategy &&
        (marketType === 'SPOT'
          ? strategy.params.oi !== null
          : strategy.params.oi === null)
      )
        throw new ApiError(
          422,
          'INVALID_STRATEGY_OI',
          '永续策略需要 OI 参数，现货策略的 OI 为 N/A。',
        );

      if (strategy || (periodsChanged && before.strategyConfigVersionId)) {
        const config = strategyConfiguration(tx, before, marketType);
        if (strategy) {
          config.params = strategy.params;
          candidate.strategyEnabled = strategy.enabled;
        }
        candidate.strategyConfigVersionId = saveStrategyVersion(
          tx,
          config,
          candidate,
          service.now(),
        ).id;
      }
      const changed =
        periodsChanged ||
        before.enabled !== candidate.enabled ||
        before.strategyEnabled !== candidate.strategyEnabled ||
        before.strategyConfigVersionId !== candidate.strategyConfigVersionId;
      if (changed) candidate.strategyAfterMs = service.now();

      tx.update(monitorConfigs)
        .set(candidate)
        .where(eq(monitorConfigs.id, id))
        .run();
      tx.insert(auditLogs)
        .values(
          auditRow(
            username,
            strategy ? 'MONITOR_STRATEGY_UPDATED' : 'MONITOR_UPDATED',
            id,
          ),
        )
        .run();
      return changed;
    });
    if (resetStrategy) strategies.forget(id);
    if (Object.keys(patch).length) service.reconcile();
    return {
      requestId: request.id,
      data: listMonitors().find((item) => item.id === id),
    };
  });

  app.patch('/monitors/batch', async (request) => {
    const username = actor(request);
    const { ids, enabled } = validated(monitorBatchSchema, request.body);
    const previous = ids.map(requireMonitor);
    const selected = previous.map((row) => ({ ...row, enabled }));
    if (enabled) {
      await Promise.all(
        selected.map((config) =>
          service.checkPeriods(
            requireMarket(config.marketId),
            monitoredTimeframes(config),
          ),
        ),
      );
    }
    database.transaction((tx) => {
      for (const before of previous) ensureCurrent(before);
      if (enabled) {
        for (const config of selected)
          ensureSupported(service.view(requireMarket(config.marketId)), config);
        ensureCapacity(selected);
      }
      tx.update(monitorConfigs)
        .set({ enabled })
        .where(inArray(monitorConfigs.id, ids))
        .run();
      const resumed = enabled
        ? previous.filter((row) => !row.enabled).map((row) => row.id)
        : [];
      if (resumed.length)
        tx.update(monitorConfigs)
          .set({ strategyAfterMs: service.now() })
          .where(inArray(monitorConfigs.id, resumed))
          .run();
      tx.insert(auditLogs)
        .values(
          ids.map((id) =>
            auditRow(
              username,
              enabled ? 'MONITOR_ENABLED' : 'MONITOR_PAUSED',
              id,
            ),
          ),
        )
        .run();
    });
    for (const row of previous)
      if (row.enabled !== enabled) strategies.forget(row.id);
    service.reconcile();
    const requested = new Set(ids);
    return {
      requestId: request.id,
      data: listMonitors().filter(({ id }) => requested.has(id)),
    };
  });

  app.delete('/monitors/:id', async (request) => {
    const username = actor(request);
    const { id } = validated(idParameter, request.params);
    database.transaction((tx) => {
      requireMonitor(id);
      tx.delete(monitorConfigs).where(eq(monitorConfigs.id, id)).run();
      tx.insert(auditLogs)
        .values(auditRow(username, 'MONITOR_DELETED', id))
        .run();
    });
    strategies.forget(id);
    service.reconcile();
    return { requestId: request.id, data: { id } };
  });

  app.get('/diagnostics', async (request) => {
    actor(request);
    return {
      requestId: request.id,
      data: {
        ...service.diagnostics(),
        timeZone,
        notifications: notifications.diagnostics(),
        ai: notifications.ai.usage(),
      },
    };
  });

  app.get('/strategies', async (request) => {
    actor(request);
    return {
      requestId: request.id,
      data: {
        templates: MARKET_TYPES.map(strategyTemplate),
        paramsSchema: z.toJSONSchema(strategyParametersSchema),
      },
    };
  });

  app.get('/signals', async (request) => {
    actor(request);
    const query = validated(signalQuerySchema, request.query);
    const rows = listSignals(database, query);
    return {
      requestId: request.id,
      data: {
        items: rows.slice(0, query.limit),
        nextOffset:
          rows.length > query.limit ? query.offset + query.limit : null,
      },
    };
  });

  app.get('/signals/:id', async (request) => {
    actor(request);
    const { id } = validated(idParameter, request.params);
    const data = signalDetail(database, id);
    if (!data)
      throw new ApiError(404, 'SIGNAL_NOT_FOUND', '找不到这条候选记录。');
    return {
      requestId: request.id,
      data: { ...data, canResend: notifications.canResend(data.signalId) },
    };
  });
}
