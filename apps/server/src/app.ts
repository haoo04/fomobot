import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type {
  ApiErrorResponse,
  ReadinessResponse,
} from '@market-sentinel/contracts';
import Fastify from 'fastify';
import { ApiError } from './api-error.js';
import { registerAuthRoutes } from './auth.js';
import type { AppConfig } from './config.js';
import type { AppDatabase } from './database.js';
import { registerMarketRoutes } from './market-data/routes.js';
import { createMarketData, type MarketData } from './market-data/service.js';
import { administrators } from './schema.js';

const clientErrors: Record<number, readonly [string, string]> = {
  400: ['INVALID_REQUEST', '请求格式无效。'],
  413: ['PAYLOAD_TOO_LARGE', '请求内容过大。'],
  415: ['UNSUPPORTED_MEDIA_TYPE', '请求内容类型不受支持。'],
  429: ['RATE_LIMITED', '登录尝试过于频繁，请稍后再试。'],
};

export async function buildApp(
  database: AppDatabase,
  config: AppConfig,
  marketData: MarketData = createMarketData(database),
) {
  const app = Fastify({
    bodyLimit: 8_192,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    logger: {
      level: config.LOG_LEVEL,
      serializers: {
        req: (request) => ({ method: request.method }),
        res: (reply) => ({ statusCode: reply.statusCode }),
      },
      redact: {
        paths: [
          'req.headers',
          'req.body',
          'res.headers',
          'password',
          'passwordHash',
          'err',
        ],
        remove: true,
      },
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (
      request.url.startsWith('/api/v1/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers.origin !== config.WEB_ORIGIN
    ) {
      throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', '请求来源不受信任。');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    let apiError: ApiError;
    if (error instanceof ApiError) {
      apiError = error;
    } else {
      const status =
        (error as { statusCode?: number } | null)?.statusCode ?? 500;
      const known = clientErrors[status];
      apiError = known
        ? new ApiError(status, ...known)
        : new ApiError(500, 'INTERNAL_ERROR', '服务暂时无法处理请求。');
    }
    if (apiError.status >= 500) {
      request.log.error({ code: apiError.code }, 'Request failed');
    }
    const response: ApiErrorResponse = {
      requestId: request.id,
      error: {
        code: apiError.code,
        message: apiError.message,
        details: apiError.details,
      },
    };
    return reply.code(apiError.status).send(response);
  });
  app.setNotFoundHandler(() => {
    throw new ApiError(404, 'NOT_FOUND', '请求的接口不存在。');
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(rateLimit, { global: false });
  registerAuthRoutes(app, database, config.NODE_ENV === 'production');
  await app.register(
    async (api) =>
      registerMarketRoutes(api, database, marketData, config.APP_TIMEZONE),
    { prefix: '/api/v1' },
  );
  app.addHook('preClose', async () => marketData.stop());

  app.get('/health/live', async (request) => ({
    status: 'ok',
    requestId: request.id,
  }));

  app.get('/health/ready', async (request): Promise<ReadinessResponse> => {
    try {
      database
        .select({ id: administrators.id })
        .from(administrators)
        .limit(1)
        .get();
    } catch {
      throw new ApiError(503, 'DATABASE_UNAVAILABLE', '数据库暂时不可用。');
    }
    return { status: 'ok', checks: { database: 'ok' }, requestId: request.id };
  });

  return app;
}
