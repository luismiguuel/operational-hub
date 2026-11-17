import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  allocationInput,
  closeSprintSchema,
  eventSchema,
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
import {
  getProjectHealth,
  listProjectHealth,
  assertProjectVisible,
} from '../core/health-and-radar.service.js';
const params = z.object({ projectId: id });
export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.get('/projects/health', async (request) => listProjectHealth(request.actor));
  app.get('/projects/:projectId/health', async (request) => {
    const { projectId } = params.parse(request.params);
    await assertProjectVisible(request.actor, projectId);
    return getProjectHealth(request.actor, projectId);
  });
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
              await client.query('SELECT role FROM users WHERE id=$1 AND is_active=true', [
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
    const body = z
      .object({ state: z.enum(['ACTIVE', 'CLOSED']) })
      .passthrough()
      .parse(request.body);
    const close =
      body.state === 'CLOSED'
        ? closeSprintSchema.parse(
            Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'state')),
          )
        : null;
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
        (previous.state === 'PLANNED' && body.state === 'ACTIVE') ||
        (previous.state === 'ACTIVE' && body.state === 'CLOSED')
      ))
        throw new HttpError(409, 'Transição de sprint inválida.');
      let moved = 0;
      let doneCount = 0;
      let donePoints = 0;
      let movedPoints = 0;
      if (close) {
        if (close.unfinishedAction === 'NEXT_SPRINT') {
          const target = (
            await client.query(
              'SELECT state FROM sprints WHERE project_id=$1 AND id=$2 FOR UPDATE',
              [projectId, close.targetSprintId],
            )
          ).rows[0];
          if (!target) throw new HttpError(404, 'Sprint de destino não encontrada neste projeto.');
          if ((target as { state: string }).state !== 'PLANNED')
            throw new HttpError(400, 'A sprint de destino precisa estar planejada.');
        }
        const summary = (
          await client.query(
            "SELECT count(*) FILTER (WHERE status='DONE')::int AS done_count, coalesce(sum(points) FILTER (WHERE status='DONE'),0)::int AS done_points, count(*) FILTER (WHERE status<>'DONE')::int AS open_count, coalesce(sum(points) FILTER (WHERE status<>'DONE'),0)::int AS open_points FROM tasks WHERE project_id=$1 AND sprint_id=$2 AND kind='TASK'",
            [projectId, sprintId],
          )
        ).rows[0] as {
          done_count: number;
          done_points: number;
          open_count: number;
          open_points: number;
        };
        doneCount = summary.done_count;
        donePoints = summary.done_points;
        moved = summary.open_count;
        movedPoints = summary.open_points;
        const destination = close.unfinishedAction === 'BACKLOG' ? null : close.targetSprintId;
        const tasks = await client.query<{ id: string }>(
          "UPDATE tasks SET sprint_id=$3, version=version+1, updated_at=now() WHERE project_id=$1 AND sprint_id=$2 AND status<>'DONE' RETURNING id",
          [projectId, sprintId, destination],
        );
        for (const task of tasks.rows) {
          const event = eventSchema.parse({
            id: crypto.randomUUID(),
            type: 'TaskCarriedOver',
            sprintId,
            targetSprintId: destination,
            projectId,
            taskId: task.id,
            actorId: request.actor.id,
            occurredAt: new Date().toISOString(),
          });
          await client.query(
            'INSERT INTO activity_log(id,project_id,actor_id,action,payload) VALUES($1,$2,$3,$4,$5)',
            [event.id, projectId, request.actor.id, 'sprint.carryover', JSON.stringify(event)],
          );
          await client.query('INSERT INTO outbox(id,payload) VALUES($1,$2)', [
            event.id,
            JSON.stringify(event),
          ]);
        }
      }
      const row = await client.query(
        `UPDATE sprints SET state=$3, closed_at=CASE WHEN $3='CLOSED' THEN now() ELSE closed_at END WHERE project_id=$1 AND id=$2 RETURNING ${sprintColumns}`,
        [projectId, sprintId, body.state],
      );
      const auditPayload = close
        ? {
            from: previous.state,
            to: body.state,
            doneCount,
            donePoints,
            carryoverCount: moved,
            carryoverPoints: movedPoints,
            unfinishedAction: close.unfinishedAction,
            targetSprintId: close.unfinishedAction === 'NEXT_SPRINT' ? close.targetSprintId : null,
          }
        : { from: previous.state, to: body.state };
      await audit(client, request.actor.id, 'sprint.state_changed', sprintId, auditPayload);
      if (close) {
        const event = eventSchema.parse({
          ...auditPayload,
          id: crypto.randomUUID(),
          type: 'SprintClosed',
          sprintId,
          projectId,
          actorId: request.actor.id,
          occurredAt: new Date().toISOString(),
        });
        await client.query('INSERT INTO outbox(id,payload) VALUES($1,$2)', [
          event.id,
          JSON.stringify(event),
        ]);
      }

      return sprintSchema.parse(row.rows[0]);
    });
  });
}
