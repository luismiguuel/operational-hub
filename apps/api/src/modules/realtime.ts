import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { id, eventSchema, wsClientSchema } from '@hub/shared';
import { z } from 'zod';
import { redis } from '../core/redis.js';
import { bus } from '../core/events.js';
import { db, HttpError } from '../core/db.js';
import { projectAccess } from '../core/access.js';
import { config } from '../core/config.js';
export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  const subscriber = redis.duplicate();
  await subscriber.psubscribe('project:*');
  subscriber.on('pmessage', (_pattern, _channel, message) => {
    try {
      const event = eventSchema.parse(JSON.parse(message));
      bus.publish(event);
    } catch {
      app.log.warn('Evento inválido ignorado.');
    }
  });
  const sockets = new Set<WebSocket>();
  app.addHook('onClose', async () => {
    for (const socket of sockets) socket.close(1001);
    await subscriber.quit();
  });
  app.get(
    '/ws/projects/:projectId',
    {
      websocket: true,
      preValidation: async (request) => {
        if (request.headers.origin !== config.WEB_ORIGIN)
          throw new HttpError(403, 'Origem não permitida.');
        z.object({ projectId: id }).parse(request.params);
      },
    },
    (socket, request) => {
      const { projectId } = z.object({ projectId: id }).parse(request.params);
      sockets.add(socket);
      let authenticated = false,
        started = false,
        unsubscribe: (() => void) | undefined,
        expires: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(() => socket.close(1008, 'Autenticação necessária'), 5000);
      socket.on('close', () => {
        clearTimeout(timeout);
        if (expires) clearTimeout(expires);
        unsubscribe?.();
        sockets.delete(socket);
      });
      socket.on('error', () => socket.close());
      socket.on('message', (data) => {
        if (started || authenticated) {
          socket.close(1008);
          return;
        }
        started = true;
        void (async () => {
          try {
            const message = wsClientSchema.parse(JSON.parse(data.toString()));
            const claims = z
              .object({ sub: id, exp: z.number() })
              .parse(app.jwt.verify(message.accessToken));
            const row = z
              .object({ id, role: z.enum(['ADMIN', 'LEADER', 'MEMBER']) })
              .parse(
                (
                  await db.query('SELECT id,role FROM users WHERE id=$1 AND active=true', [
                    claims.sub,
                  ])
                ).rows[0],
              );
            await projectAccess(row, projectId);
            authenticated = true;
            clearTimeout(timeout);
            expires = setTimeout(
              () => socket.close(1008, 'Token expirado'),
              Math.max(0, claims.exp * 1000 - Date.now()),
            );
            unsubscribe = bus.onEvent((event) => {
              if (event.projectId !== projectId) return;
              // Revalidate each delivery, so revoked allocations never keep room access.
              void (async () => {
                try {
                  const fresh = z
                    .object({ id, role: z.enum(['ADMIN', 'LEADER', 'MEMBER']) })
                    .parse(
                      (
                        await db.query('SELECT id,role FROM users WHERE id=$1 AND active=true', [
                          row.id,
                        ])
                      ).rows[0],
                    );
                  await projectAccess(fresh, projectId);
                  if (socket.readyState === 1) socket.send(JSON.stringify(event));
                } catch {
                  socket.close(1008);
                }
              })();
            });
            socket.send(JSON.stringify({ type: 'ready', projectId }));
          } catch {
            socket.close(1008, 'Acesso negado.');
          }
        })();
      });
    },
  );
}
