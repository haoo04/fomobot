import {
  aiSettingsPatchSchema,
  telegramSettingsPatchSchema,
} from '@market-sentinel/contracts/notifications';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { validated } from '../api-error.js';
import { requireSession } from '../auth.js';
import type { AppDatabase } from '../database.js';
import type { Notifications } from './service.js';

const sensitiveAction = {
  config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
};
const resendSchema = z.strictObject({ confirm: z.literal(true) });
const idSchema = z.strictObject({ id: z.uuid() });

export function registerNotificationRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  service: Notifications,
) {
  const actor = (request: FastifyRequest) =>
    requireSession(db, request).username;
  const { telegram } = service;
  const path = '/settings/telegram';

  app.get(path, async (request) => {
    actor(request);
    return { requestId: request.id, data: telegram.settings() };
  });
  app.put(path, async (request) => {
    const username = actor(request);
    const patch = validated(telegramSettingsPatchSchema, request.body);
    return { requestId: request.id, data: telegram.save(patch, username) };
  });
  app.post(path + '/pair', sensitiveAction, async (request) => {
    return { requestId: request.id, data: await telegram.pair(actor(request)) };
  });
  app.delete(path + '/pair', async (request) => {
    return { requestId: request.id, data: telegram.unpair(actor(request)) };
  });
  app.post(path + '/test', sensitiveAction, async (request, reply) => {
    const data = service.enqueueTest(actor(request));
    return reply.code(202).send({ requestId: request.id, data });
  });
  app.post('/signals/:id/resend', sensitiveAction, async (request, reply) => {
    const username = actor(request);
    const { id } = validated(idSchema, request.params);
    validated(resendSchema, request.body);
    service.resend(id, username);
    return reply.code(202).send({ requestId: request.id });
  });
  app.get('/settings/ai', async (request) => {
    actor(request);
    return { requestId: request.id, data: service.ai.settings() };
  });
  app.put('/settings/ai', async (request) => {
    const username = actor(request);
    const patch = validated(aiSettingsPatchSchema, request.body);
    return { requestId: request.id, data: service.ai.save(patch, username) };
  });
  app.post('/settings/ai/test', sensitiveAction, async (request) => {
    return {
      requestId: request.id,
      data: await service.testAi(actor(request)),
    };
  });
}
