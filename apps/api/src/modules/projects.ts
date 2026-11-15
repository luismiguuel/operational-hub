import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  allocationInput,
  id,
  projectInput,
  projectSchema,
  sprintInput,
  sprintSchema,
} from '@hub/shared';
import { db, transaction, found, HttpError } from '../core/db.js';
import { projectAccess, audit } from '../core/access.js';
import { authenticate, requireAdmin } from './auth.js';
import { sprintColumns } from '../core/records.js';
const params = z.object({ projectId: id });
export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.get('/projects', async (request) => {
    const result = await db.query(
      `SELECT p.*,a.role AS "myRole" FROM projects p LEFT JOIN allocations a ON a.project_id=p.id AND a.user_id=$1 WHERE ($2::boolean OR a.user_id IS NOT NULL) ORDER BY p.archived,p.name`,
      [request.actor.id, request.actor.role === 'ADMIN'],
    );
    return z.array(projectSchema).parse(result.rows);
  });
  app.post('/projects', { preHandler: requireAdmin }, async (request, reply) => {
    const input = projectInput.parse(request.body),
      projectId = crypto.randomUUID();
    await transaction(async (client) => {
      await client.query('INSERT INTO projects(id,name,description,kind) VALUES($1,$2,$3,$4)', [
        projectId,
        input.name,
        input.description,
        input.kind,
      ]);
      await audit(client, request.actor.id, 'project.created', projectId, input);
    });
    return reply.code(201).send({ ...input, id: projectId, archived: false, myRole: null });
  });
  app.patch('/projects/:projectId', { preHandler: requireAdmin }, async (request) => {
    const { projectId } = params.parse(request.params),
      input = z.object({ archived: z.boolean() }).strict().parse(request.body);
    await transaction(async (client) => {
      found(
        (
          await client.query('UPDATE projects SET archived=$2 WHERE id=$1 RETURNING id', [
            projectId,
            input.archived,
          ])
        ).rows[0],
      );
      await audit(client, request.actor.id, 'project.archived', projectId, input);
    });
    return { ok: true };
  });
  app.get('/projects/:projectId/allocations', async (request) => {
    const { projectId } = params.parse(request.params);
    await projectAccess(request.actor, projectId);
    const rows = await db.query(
      'SELECT a.user_id AS "userId",u.name,a.role,a.weekly_hours AS "weeklyHours" FROM allocations a JOIN users u ON u.id=a.user_id WHERE a.project_id=$1 ORDER BY u.name',
      [projectId],
    );
    return z.array(allocationInput.extend({ name: z.string() })).parse(rows.rows);
  });
  app.put('/projects/:projectId/allocations', async (request) => {
    const { projectId } = params.parse(request.params),
      input = allocationInput.parse(request.body);
    await transaction(async (client) => {
      await projectAccess(request.actor, projectId, true, client);
      const user = z
        .object({ role: z.string() })
        .parse(
          found(
            (
              await client.query('SELECT role FROM users WHERE id=$1 AND active=true', [
                input.userId,
              ])
            ).rows[0],
          ),
        );
      if (input.role === 'LEADER' && user.role !== 'LEADER' && user.role !== 'ADMIN')
        throw new HttpError(422, 'O líder contextual deve ter papel de liderança no sistema.');
      await client.query(
        'INSERT INTO allocations(project_id,user_id,role,weekly_hours) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,user_id) DO UPDATE SET role=$3,weekly_hours=$4',
        [projectId, input.userId, input.role, input.weeklyHours],
      );
      await audit(client, request.actor.id, 'allocation.updated', projectId, input);
    });
    return { ok: true };
  });
  app.get('/projects/:projectId/sprints', async (request) => {
    const { projectId } = params.parse(request.params);
    await projectAccess(request.actor, projectId);
    return z
      .array(sprintSchema)
      .parse(
        (
          await db.query(
            `SELECT ${sprintColumns} FROM sprints WHERE project_id=$1 ORDER BY starts_on DESC`,
            [projectId],
          )
        ).rows,
      );
  });
  app.post('/projects/:projectId/sprints', async (request, reply) => {
    const { projectId } = params.parse(request.params),
      input = sprintInput.parse(request.body),
      sprintId = crypto.randomUUID();
    const result = await transaction(async (client) => {
      await projectAccess(request.actor, projectId, true, client);
      const row = await client.query(
        `INSERT INTO sprints(id,project_id,name,goal,starts_on,ends_on) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${sprintColumns}`,
        [sprintId, projectId, input.name, input.goal, input.startsOn, input.endsOn],
      );
      await audit(client, request.actor.id, 'sprint.created', sprintId, input);
      return sprintSchema.parse(row.rows[0]);
    });
    return reply.code(201).send(result);
  });
  app.patch('/projects/:projectId/sprints/:sprintId', async (request) => {
    const { projectId, sprintId } = params.extend({ sprintId: id }).parse(request.params);
    const { state } = z
      .object({ state: z.enum(['ACTIVE', 'CLOSED']) })
      .strict()
      .parse(request.body);
    return transaction(async (client) => {
      await projectAccess(request.actor, projectId, true, client);
      const previous = z
        .object({ state: z.string() })
        .parse(
          found(
            (
              await client.query(
                'SELECT state FROM sprints WHERE project_id=$1 AND id=$2 FOR UPDATE',
                [projectId, sprintId],
              )
            ).rows[0],
          ),
        );
      if (!(
        (previous.state === 'PLANNED' && state === 'ACTIVE') ||
        (previous.state === 'ACTIVE' && state === 'CLOSED')
      ))
        throw new HttpError(409, 'Transição de sprint inválida.');
      if (
        state === 'CLOSED' &&
        (
          await client.query(
            "SELECT 1 FROM tasks WHERE project_id=$1 AND sprint_id=$2 AND kind='TASK' AND status<>'DONE' LIMIT 1",
            [projectId, sprintId],
          )
        ).rowCount
      )
        throw new HttpError(409, 'Conclua as tarefas antes de encerrar esta sprint.');
      const row = await client.query(
        `UPDATE sprints SET state=$3 WHERE project_id=$1 AND id=$2 RETURNING ${sprintColumns}`,
        [projectId, sprintId, state],
      );
      await audit(client, request.actor.id, 'sprint.state_changed', sprintId, {
        from: previous.state,
        to: state,
      });
      return sprintSchema.parse(row.rows[0]);
    });
  });
}
