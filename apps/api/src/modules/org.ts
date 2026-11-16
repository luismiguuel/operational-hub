import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  bulkProvisionMembersSchema,
  createAreaSchema,
  createRoleSchema,
  createSubareaSchema,
  id,
  orgTaxonomySchema,
  updateAreaSchema,
  updateMemberAdminSchema,
  updateRoleSchema,
  updateSubareaSchema,
  userSchema,
} from '@hub/shared';
import { db, found, HttpError, transaction } from '../core/db.js';
import { userColumns } from '../core/records.js';
import { authenticate, requireAdmin } from './auth.js';
import { audit } from '../core/access.js';

const paramsSchema = z.object({ id });
const slugify = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

async function publishOrgChange(
  client: import('pg').PoolClient,
  actorId: string,
  resourceType: 'AREA' | 'SUBAREA' | 'ROLE' | 'MEMBER' | 'BULK_PROVISION',
  resourceId: string | null,
): Promise<void> {
  const event = {
    id: crypto.randomUUID(),
    type: 'OrgManagementChanged' as const,
    actorId,
    resourceType,
    resourceId,
    occurredAt: new Date().toISOString(),
  };
  await client.query('INSERT INTO outbox(id,payload) VALUES($1,$2)', [
    event.id,
    JSON.stringify(event),
  ]);
}

export async function orgRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/org/taxonomy', async () => {
    const [areas, subareas, roles] = await Promise.all([
      db.query(
        'SELECT id,name,slug,description,is_active AS "isActive" FROM org_areas ORDER BY name',
      ),
      db.query(
        'SELECT id,area_id AS "areaId",name,slug,is_active AS "isActive" FROM org_subareas ORDER BY name',
      ),
      db.query('SELECT id,name,slug,is_active AS "isActive" FROM org_roles ORDER BY name'),
    ]);
    return orgTaxonomySchema.parse({
      areas: areas.rows.map((area) => ({
        ...area,
        subareas: subareas.rows.filter((subarea) => subarea['areaId'] === area['id']),
      })),
      roles: roles.rows,
    });
  });

  app.post('/org/areas', { preHandler: requireAdmin }, async (request, reply) => {
    const input = createAreaSchema.parse(request.body);
    const areaId = crypto.randomUUID();
    const result = await transaction(async (client) => {
      const row = found(
        (
          await client.query(
            'INSERT INTO org_areas(id,name,slug,description) VALUES($1,$2,$3,$4) RETURNING id,name,slug,description,is_active AS "isActive"',
            [areaId, input.name, input.slug || slugify(input.name), input.description],
          )
        ).rows[0],
      );
      await client.query(
        "INSERT INTO areas(name,subareas) VALUES($1,'[]') ON CONFLICT(name) DO NOTHING",
        [input.name],
      );
      await audit(client, request.actor.id, 'org.area_created', areaId, input);
      await publishOrgChange(client, request.actor.id, 'AREA', areaId);
      return row;
    });
    return reply.code(201).send(result);
  });

  app.patch('/org/areas/:id', { preHandler: requireAdmin }, async (request) => {
    const areaId = paramsSchema.parse(request.params).id;
    const input = updateAreaSchema.parse(request.body);
    return transaction(async (client) => {
      const current = found(
        (await client.query('SELECT id,name FROM org_areas WHERE id=$1 FOR UPDATE', [areaId]))
          .rows[0],
      );
      if (input.name && input.name !== current['name']) {
        await client.query('UPDATE areas SET name=$2 WHERE name=$1', [current['name'], input.name]);
        await client.query('UPDATE users SET area=$2 WHERE area=$1', [current['name'], input.name]);
      }
      const row = found(
        (
          await client.query(
            'UPDATE org_areas SET name=COALESCE($2,name),slug=COALESCE($3,slug),description=COALESCE($4,description),is_active=COALESCE($5,is_active),updated_at=now() WHERE id=$1 RETURNING id,name,slug,description,is_active AS "isActive"',
            [
              areaId,
              input.name ?? null,
              input.slug ?? null,
              input.description ?? null,
              input.isActive ?? null,
            ],
          )
        ).rows[0],
      );
      await audit(client, request.actor.id, 'org.area_updated', areaId, input);
      await publishOrgChange(client, request.actor.id, 'AREA', areaId);
      return row;
    });
  });

  app.post('/org/subareas', { preHandler: requireAdmin }, async (request, reply) => {
    const input = createSubareaSchema.parse(request.body);
    const subareaId = crypto.randomUUID();
    const result = await transaction(async (client) => {
      found(
        (
          await client.query('SELECT id FROM org_areas WHERE id=$1 AND is_active=true', [
            input.areaId,
          ])
        ).rows[0],
      );
      const row = found(
        (
          await client.query(
            'INSERT INTO org_subareas(id,area_id,name,slug) VALUES($1,$2,$3,$4) RETURNING id,area_id AS "areaId",name,slug,is_active AS "isActive"',
            [subareaId, input.areaId, input.name, input.slug || slugify(input.name)],
          )
        ).rows[0],
      );
      await audit(client, request.actor.id, 'org.subarea_created', subareaId, input);
      await publishOrgChange(client, request.actor.id, 'SUBAREA', subareaId);
      return row;
    });
    return reply.code(201).send(result);
  });

  app.patch('/org/subareas/:id', { preHandler: requireAdmin }, async (request) => {
    const subareaId = paramsSchema.parse(request.params).id;
    const input = updateSubareaSchema.parse(request.body);
    return transaction(async (client) => {
      const row = found(
        (
          await client.query(
            'UPDATE org_subareas SET area_id=COALESCE($2,area_id),name=COALESCE($3,name),slug=COALESCE($4,slug),is_active=COALESCE($5,is_active),updated_at=now() WHERE id=$1 AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM org_areas WHERE id=$2 AND is_active=true)) RETURNING id,area_id AS "areaId",name,slug,is_active AS "isActive"',
            [
              subareaId,
              input.areaId ?? null,
              input.name ?? null,
              input.slug ?? null,
              input.isActive ?? null,
            ],
          )
        ).rows[0],
      );
      await audit(client, request.actor.id, 'org.subarea_updated', subareaId, input);
      await publishOrgChange(client, request.actor.id, 'SUBAREA', subareaId);
      return row;
    });
  });

  app.post('/org/roles', { preHandler: requireAdmin }, async (request, reply) => {
    const input = createRoleSchema.parse(request.body);
    const roleId = crypto.randomUUID();
    const result = await transaction(async (client) => {
      const row = found(
        (
          await client.query(
            'INSERT INTO org_roles(id,name,slug) VALUES($1,$2,$3) RETURNING id,name,slug,is_active AS "isActive"',
            [roleId, input.name, input.slug || slugify(input.name)],
          )
        ).rows[0],
      );
      await audit(client, request.actor.id, 'org.role_created', roleId, input);
      await publishOrgChange(client, request.actor.id, 'ROLE', roleId);
      return row;
    });
    return reply.code(201).send(result);
  });

  app.patch('/org/roles/:id', { preHandler: requireAdmin }, async (request) => {
    const roleId = paramsSchema.parse(request.params).id;
    const input = updateRoleSchema.parse(request.body);
    return transaction(async (client) => {
      const row = found(
        (
          await client.query(
            'UPDATE org_roles SET name=COALESCE($2,name),slug=COALESCE($3,slug),is_active=COALESCE($4,is_active),updated_at=now() WHERE id=$1 RETURNING id,name,slug,is_active AS "isActive"',
            [roleId, input.name ?? null, input.slug ?? null, input.isActive ?? null],
          )
        ).rows[0],
      );
      await audit(client, request.actor.id, 'org.role_updated', roleId, input);
      await publishOrgChange(client, request.actor.id, 'ROLE', roleId);
      return row;
    });
  });

  app.patch('/users/:userId/admin', { preHandler: requireAdmin }, async (request) => {
    const userId = z.object({ userId: id }).parse(request.params).userId;
    const input = updateMemberAdminSchema.parse(request.body);
    return transaction(async (client) => {
      const previous = found(
        (await client.query('SELECT id,role,is_active FROM users WHERE id=$1 FOR UPDATE', [userId]))
          .rows[0],
      );
      const role = z.enum(['ADMIN', 'LEADER', 'MEMBER']).parse(previous['role']);
      const currentlyActive = previous['is_active'] === true;
      if (
        role === 'ADMIN' &&
        currentlyActive &&
        (!input.isActive || input.systemRole !== 'ADMIN')
      ) {
        const count = await client.query(
          "SELECT count(*)::int AS count FROM users WHERE role='ADMIN' AND is_active=true AND id<>$1",
          [userId],
        );
        if (count.rows[0]?.['count'] === 0)
          throw new HttpError(409, 'Não é possível desativar ou rebaixar o último ADMIN ativo.');
      }
      if (userId === request.actor.id && (!input.isActive || input.systemRole !== 'ADMIN'))
        throw new HttpError(409, 'Não é possível desativar ou rebaixar sua própria administração.');
      const taxonomy = await client.query(
        'SELECT a.name,sa.name AS subarea FROM org_areas a LEFT JOIN org_subareas sa ON sa.area_id=a.id AND sa.is_active=true AND sa.name=$2 WHERE a.name=$1 AND a.is_active=true AND ($2::text IS NULL OR sa.id IS NOT NULL) AND EXISTS(SELECT 1 FROM org_roles WHERE name=$3 AND is_active=true)',
        [input.area, input.subarea, input.role],
      );
      if (!taxonomy.rowCount)
        throw new HttpError(422, 'Área, subárea ou cargo inativo/inexistente.');
      await client.query(
        "INSERT INTO areas(name,subareas) VALUES($1,'[]') ON CONFLICT(name) DO NOTHING",
        [input.area],
      );
      const row = found(
        (
          await client.query(
            `UPDATE users SET area=$2,subarea=$3,title=$4,role=$5,weekly_hours=$6,active=$7,is_active=$7,deactivated_at=CASE WHEN $7 THEN NULL ELSE COALESCE(deactivated_at,now()) END WHERE id=$1 RETURNING ${userColumns}`,
            [
              userId,
              input.area,
              input.subarea,
              input.role,
              input.systemRole,
              input.weeklyCapacityHours,
              input.isActive,
            ],
          )
        ).rows[0],
      );
      if (!input.isActive)
        await client.query('UPDATE refresh_tokens SET revoked=true WHERE user_id=$1', [userId]);
      await audit(client, request.actor.id, 'user.admin_updated', userId, input);
      await publishOrgChange(client, request.actor.id, 'MEMBER', userId);
      return userSchema.parse(row);
    });
  });

  app.post('/users/bulk-provision', { preHandler: requireAdmin }, async (request) => {
    const { members } = bulkProvisionMembersSchema.parse(request.body);
    return transaction(async (client) => {
      const created: string[] = [];
      const existing: string[] = [];
      for (const member of members) {
        const area = await client.query(
          'SELECT id FROM org_areas WHERE name=$1 AND is_active=true',
          [member.area],
        );
        if (!area.rowCount) throw new HttpError(422, `Área inválida para ${member.email}.`);
        if (member.subarea) {
          const subarea = await client.query(
            'SELECT id FROM org_subareas WHERE area_id=$1 AND name=$2 AND is_active=true',
            [area.rows[0]?.['id'], member.subarea],
          );
          if (!subarea.rowCount) throw new HttpError(422, `Subárea inválida para ${member.email}.`);
        }
        const orgRole = await client.query(
          'SELECT id FROM org_roles WHERE name=$1 AND is_active=true',
          [member.role],
        );
        if (!orgRole.rowCount) throw new HttpError(422, `Cargo inválido para ${member.email}.`);
        const email = member.email.toLowerCase();
        await client.query(
          "INSERT INTO areas(name,subareas) VALUES($1,'[]') ON CONFLICT(name) DO NOTHING",
          [member.area],
        );
        const row = await client.query(
          'INSERT INTO users(id,name,email,role,area,subarea,title,weekly_hours) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(email) DO NOTHING RETURNING id,email',
          [
            crypto.randomUUID(),
            member.name,
            email,
            member.systemRole,
            member.area,
            member.subarea ?? null,
            member.role,
            member.weeklyCapacityHours,
          ],
        );
        const inserted = row.rows[0];
        if (inserted) created.push(String(inserted['email']));
        else existing.push(email);
      }
      await audit(client, request.actor.id, 'user.bulk_provisioned', request.actor.id, {
        created,
        existing,
      });
      await publishOrgChange(client, request.actor.id, 'BULK_PROVISION', null);
      return { created, existing, createdCount: created.length, existingCount: existing.length };
    });
  });
}
