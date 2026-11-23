import { randomUUID } from 'node:crypto';
import {
  marketQuerySchema,
  monitorBatchSchema,
  monitorCreateSchema,
  monitorPatchSchema,
} from '@market-sentinel/contracts/markets';
import type { Market, MonitorConfig } from '@market-sentinel/contracts/markets';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../api-error.js';
import { requireSession } from '../auth.js';
import type { AppDatabase } from '../database.js';
import { auditLogs, monitorConfigs } from '../schema.js';
import { monitoredTimeframes } from './model.js';
import type { MarketData } from './service.js';
import { configuredMarkets, marketById, marketPage } from './store.js';
import type { MonitorRow } from './store.js';

const idParameter = z.strictObject({ id: z.uuid() });

function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(
      400,
      'INVALID_REQUEST',
      '请检查市场或监控参数。',
      result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        code: issue.code,
      })),
    );
  return result.data;
}

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
  timeZone: string,
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

  function ensureCurrent(before: MonitorRow) {
    if (JSON.stringify(requireMonitor(before.id)) !== JSON.stringify(before)) {
      throw new ApiError(
        409,
        'MONITOR_CHANGED',
        '监控配置已更新，请刷新后再试。',
      );
    }
  }

  function ensureCapacity(changes: MonitorRow[]) {
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
    return { requestId: request.id, data: service.listMonitors() };
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
      tx.insert(monitorConfigs).values(config).run();
      tx.insert(auditLogs)
        .values(auditRow(username, 'MONITOR_CREATED', config.id))
        .run();
    });
    service.reconcile();
    return reply.code(201).send({
      requestId: request.id,
      data: service.listMonitors().find((monitor) => monitor.id === config.id),
    });
  });

  app.patch('/monitors/:id', async (request) => {
    const username = actor(request);
    const { id } = validated(idParameter, request.params);
    const patch = validated(monitorPatchSchema, request.body);
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
    database.transaction((tx) => {
      ensureCurrent(before);
      if (needsValidation)
        ensureSupported(
          service.view(requireMarket(before.marketId)),
          candidate,
        );
      if (candidate.enabled) ensureCapacity([candidate]);
      tx.update(monitorConfigs)
        .set(candidate)
        .where(eq(monitorConfigs.id, id))
        .run();
      tx.insert(auditLogs)
        .values(auditRow(username, 'MONITOR_UPDATED', id))
        .run();
    });
    service.reconcile();
    return {
      requestId: request.id,
      data: service.listMonitors().find((item) => item.id === id),
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
    service.reconcile();
    const requested = new Set(ids);
    return {
      requestId: request.id,
      data: service.listMonitors().filter(({ id }) => requested.has(id)),
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
    service.reconcile();
    return { requestId: request.id, data: { id } };
  });

  app.get('/diagnostics', async (request) => {
    actor(request);
    return {
      requestId: request.id,
      data: { ...service.diagnostics(), timeZone },
    };
  });
}
