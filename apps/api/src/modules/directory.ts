import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { areas, id, profileInput, userSchema, auditSchema } from '@hub/shared';
import { db, found, HttpError, transaction } from '../core/db.js';
import { userColumns } from '../core/records.js';
import { authenticate, requireAdmin } from './auth.js';
import { audit } from '../core/access.js';
export async function directoryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.get('/areas', async () => areas);
  app.get('/audit', { preHandler: requireAdmin }, async (request) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(request.query);
    return z
      .array(auditSchema)
      .parse(
        (
          await db.query(
            'SELECT id,actor_id AS "actorId",action,resource_id AS "resourceId",payload,created_at::text AS "createdAt" FROM audit_log ORDER BY created_at DESC LIMIT $1',
            [limit],
          )
        ).rows,
      );
  });
  app.patch('/users/:id/active', { preHandler: requireAdmin }, async (request) => {
    const userId = z.object({ id }).parse(request.params).id;
    const { active } = z.object({ active: z.boolean() }).strict().parse(request.body);
    if (userId === request.actor.id && !active)
      throw new HttpError(409, 'Não é possível desativar sua própria conta.');
    await transaction(async (client) => {
      found(
        (
          await client.query('UPDATE users SET active=$2 WHERE id=$1 RETURNING id', [
            userId,
            active,
          ])
        ).rows[0],
      );
      if (!active)
        await client.query('UPDATE refresh_tokens SET revoked=true WHERE user_id=$1', [userId]);
      await audit(client, request.actor.id, 'user.active_changed', userId, { active });
    });
    return { ok: true };
  });

  app.get('/users', async (request) => {
    // Minimal directory profile, visible only to fellow project members; admin sees all.
    const rows = await db.query(
      `SELECT ${userColumns} FROM users WHERE active=true AND ($1::boolean OR id=$2 OR id IN (SELECT a.user_id FROM allocations a JOIN allocations mine ON mine.project_id=a.project_id WHERE mine.user_id=$2)) ORDER BY name`,
      [request.actor.role === 'ADMIN', request.actor.id],
    );
    return z.array(userSchema).parse(rows.rows);
  });
  app.post('/users', { preHandler: requireAdmin }, async (request, reply) => {
    const input = profileInput.parse(request.body),
      userId = crypto.randomUUID();
    const result = await transaction(async (client) => {
      const row = await client.query(
        `INSERT INTO users(id,name,email,role,area,subarea,title,weekly_hours) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${userColumns}`,
        [
          userId,
          input.name,
          input.email.toLowerCase(),
          input.role,
          input.area,
          input.subarea,
          input.title,
          input.weeklyHours,
        ],
      );
      await audit(client, request.actor.id, 'user.created', userId, input);
      return userSchema.parse(row.rows[0]);
    });
    return reply.code(201).send(result);
  });
  app.patch('/users/:id', { preHandler: requireAdmin }, async (request) => {
    const userId = id.parse(z.object({ id }).parse(request.params).id),
      input = profileInput.parse(request.body);
    return transaction(async (client) => {
      const previous = await client.query('SELECT role FROM users WHERE id=$1 FOR UPDATE', [
        userId,
      ]);
      found(previous.rows[0]);
      if (userId === request.actor.id && input.role !== 'ADMIN')
        throw new HttpError(409, 'Não é possível remover sua própria administração.');
      const row = await client.query(
        `UPDATE users SET name=$2,email=$3,role=$4,area=$5,subarea=$6,title=$7,weekly_hours=$8 WHERE id=$1 RETURNING ${userColumns}`,
        [
          userId,
          input.name,
          input.email.toLowerCase(),
          input.role,
          input.area,
          input.subarea,
          input.title,
          input.weeklyHours,
        ],
      );
      await audit(client, request.actor.id, 'user.updated', userId, input);
      return userSchema.parse(found(row.rows[0]));
    });
  });
}
