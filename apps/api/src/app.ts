import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { config } from './core/config.js';
import { db } from './core/db.js';
import { redis } from './core/redis.js';
import { authRoutes } from './modules/auth.js';
import { directoryRoutes } from './modules/directory.js';
import { projectRoutes } from './modules/projects.js';
import { taskRoutes } from './modules/tasks.js';
import { dashboardRoutes } from './modules/dashboards.js';
import { realtimeRoutes } from './modules/realtime.js';
import { orgRoutes } from './modules/org.js';
import { backlogRoutes } from './modules/backlog.js';
export async function buildApp() {
  const app = Fastify({
    logger: {
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
      serializers: {
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: request.url.split('?')[0] ?? '/',
          remoteAddress: request.ip,
        }),
      },
    },
    bodyLimit: 128 * 1024,
  });
  await app.register(helmet);
  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  await app.register(cookie);
  await app.register(jwt, { secret: config.JWT_SECRET });
  await app.register(rateLimit, {
    redis,
    max: config.NODE_ENV === 'test' ? 1000 : 120,
    timeWindow: '1 minute',
    nameSpace: `hub:${config.NODE_ENV}:`,
  });
  await app.register(websocket, { options: { maxPayload: 8192 } });
  // Cookie-bearing mutations must originate in the configured frontend (including refresh/logout).
  app.addHook('onRequest', async (request, reply) => {
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      request.headers.origin &&
      request.headers.origin !== config.WEB_ORIGIN
    )
      return reply.code(403).send({ message: 'Origem não permitida.' });
    if (
      request.cookies['refresh'] &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      request.headers.origin !== config.WEB_ORIGIN
    )
      return reply.code(403).send({ message: 'Origem obrigatória.' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({ message: 'Dados inválidos.', issues: error.flatten() });
    const details = error instanceof Error ? error : new Error('Unknown error');
    const code = 'code' in details ? details.code : undefined;
    if (code === '23505')
      return reply.code(409).send({ message: 'Registro duplicado ou já existe uma sprint ativa.' });
    if (code === '23503' || code === '23514')
      return reply.code(422).send({ message: 'Vínculo de domínio inválido.' });
    const status =
      'statusCode' in details && typeof details.statusCode === 'number' ? details.statusCode : 500;
    if (status >= 500) app.log.error(error);
    return reply
      .code(status)
      .send({ message: status >= 500 ? 'Falha interna. Tente novamente.' : details.message });
  });
  app.get('/api/v1/health', async () => {
    await db.query('SELECT 1');
    await redis.ping();
    return { status: 'ok' };
  });
  for (const routes of [
    authRoutes,
    directoryRoutes,
    orgRoutes,
    backlogRoutes,
    projectRoutes,
    taskRoutes,
    dashboardRoutes,
    realtimeRoutes,
  ])
    await app.register(routes, { prefix: '/api/v1' });
  return app;
}
