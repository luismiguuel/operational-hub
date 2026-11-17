import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { heatSchema, taskSchema, id, aiJobSchema, activitySchema } from '@hub/shared';
import { db, HttpError, found } from '../core/db.js';
import { redis, aiQueue } from '../core/redis.js';
import { taskColumns } from '../core/records.js';
import { authenticate } from './auth.js';
import { projectAccess } from '../core/access.js';
import { config } from '../core/config.js';
import { getAllocationRadar } from '../core/health-and-radar.service.js';
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.get('/allocation/radar', async (request) => {
    const profile = z
      .object({ area: z.string() })
      .parse(
        found((await db.query('SELECT area FROM users WHERE id=$1', [request.actor.id])).rows[0]),
      );
    if (
      request.actor.role !== 'ADMIN' &&
      request.actor.role !== 'LEADER' &&
      profile.area !== 'Gente e Gestão'
    )
      throw new HttpError(403, 'Visão exclusiva da liderança e Gente e Gestão.');
    return getAllocationRadar();
  });
  app.get('/me/tasks', async (request) =>
    z
      .array(taskSchema)
      .parse(
        (
          await db.query(
            `SELECT ${taskColumns} FROM tasks WHERE assignee_id=$1 AND project_id IN(SELECT id FROM projects WHERE archived=false AND ($2::boolean OR id IN(SELECT project_id FROM allocations WHERE user_id=$1))) ORDER BY CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,due_date NULLS LAST`,
            [request.actor.id, request.actor.role === 'ADMIN'],
          )
        ).rows,
      ),
  );
  app.get('/dashboards/heat', async (request) => {
    const principal = z
      .object({ area: z.string() })
      .parse(
        found((await db.query('SELECT area FROM users WHERE id=$1', [request.actor.id])).rows[0]),
      );
    const global = request.actor.role === 'ADMIN' || principal.area === 'Gente e Gestão';
    if (!global && request.actor.role !== 'LEADER')
      throw new HttpError(403, 'Visão exclusiva da liderança e Gente e Gestão.');
    // Authorization precedes cache reads. Actor-specific key prevents cross-project cache leakage.
    const scope = global
      ? 'global'
      : (
          await db.query<{ project_id: string }>(
            "SELECT a.project_id FROM allocations a JOIN projects p ON p.id=a.project_id WHERE a.user_id=$1 AND a.role='LEADER' AND NOT p.archived ORDER BY a.project_id",
            [request.actor.id],
          )
        ).rows
          .map((row) => row.project_id)
          .join(',');
    const revision = (await redis.get('dashboard:revision')) ?? '0',
      key = `heat:${request.actor.id}:${scope}:${revision}`;
    const cached = await redis.get(key);
    if (cached) return z.array(heatSchema).parse(JSON.parse(cached));
    const result = await db.query(
      `WITH visible AS (
      SELECT p.id FROM projects p WHERE NOT p.archived AND ($1::boolean OR p.id IN(SELECT project_id FROM allocations WHERE user_id=$2 AND role='LEADER'))
    ), load AS (SELECT a.user_id,sum(a.weekly_hours)::int AS allocated FROM allocations a JOIN visible v ON v.id=a.project_id GROUP BY a.user_id),
    work AS (SELECT t.assignee_id,count(*)::int AS tasks,sum(t.points)::int AS points FROM tasks t JOIN visible v ON v.id=t.project_id WHERE t.status<>'DONE' AND t.kind='TASK' GROUP BY t.assignee_id)
    SELECT u.id AS "userId",u.name,u.area,u.weekly_hours AS capacity,coalesce(l.allocated,0) AS allocated,coalesce(w.tasks,0) AS "activeTasks",coalesce(w.points,0) AS points
    FROM users u LEFT JOIN load l ON l.user_id=u.id LEFT JOIN work w ON w.assignee_id=u.id WHERE u.active AND ($1::boolean OR l.user_id IS NOT NULL) ORDER BY u.name`,
      [global, request.actor.id],
    );
    const rows = z.array(heatSchema).parse(result.rows);
    await redis.set(key, JSON.stringify(rows), 'EX', 15);
    return rows;
  });
  app.get('/projects/:projectId/metrics', async (request) => {
    const { projectId } = z.object({ projectId: id }).parse(request.params);
    await projectAccess(request.actor, projectId);
    const row = await db.query(
      `SELECT count(*)::int AS total,count(*) FILTER(WHERE status='DONE')::int AS completed,coalesce(sum(points) FILTER(WHERE status='DONE'),0)::int AS "completedPoints",coalesce(sum(points),0)::int AS "totalPoints" FROM tasks WHERE project_id=$1 AND kind='TASK'`,
      [projectId],
    );
    const velocity = await db.query(
      `SELECT s.id,s.name,coalesce(sum(t.points) FILTER(WHERE t.status='DONE'),0)::int AS points FROM sprints s LEFT JOIN tasks t ON t.sprint_id=s.id AND t.kind='TASK' WHERE s.project_id=$1 AND s.state='CLOSED' GROUP BY s.id ORDER BY s.ends_on DESC LIMIT 6`,
      [projectId],
    );
    return {
      ...z
        .object({
          total: z.number(),
          completed: z.number(),
          completedPoints: z.number(),
          totalPoints: z.number(),
        })
        .parse(row.rows[0]),
      velocity: z
        .array(z.object({ id, name: z.string(), points: z.number() }))
        .parse(velocity.rows),
    };
  });
  app.get('/projects/:projectId/activity', async (request) => {
    const { projectId } = z.object({ projectId: id }).parse(request.params);
    await projectAccess(request.actor, projectId);
    return z
      .array(activitySchema)
      .parse(
        (
          await db.query(
            'SELECT action,payload,created_at::text AS "createdAt" FROM activity_log WHERE project_id=$1 ORDER BY created_at DESC LIMIT 30',
            [projectId],
          )
        ).rows,
      );
  });
  app.post('/projects/:projectId/ai/summary', async (request, reply) => {
    const { projectId } = z.object({ projectId: id }).parse(request.params);
    await projectAccess(request.actor, projectId, true);
    if (!config.AI_API_KEY)
      throw new HttpError(503, 'Configure o provedor de IA para gerar resumos.');
    const job = await aiQueue.add('summary', { projectId, actorId: request.actor.id });
    return reply.code(202).send({ id: job.id });
  });
  app.get('/projects/:projectId/ai/jobs/:jobId', async (request) => {
    const { projectId, jobId } = z
      .object({ projectId: id, jobId: z.string().regex(/^\d+$/) })
      .parse(request.params);
    await projectAccess(request.actor, projectId, true);
    const job = await aiQueue.getJob(jobId);
    if (!job || job.data.projectId !== projectId || job.data.actorId !== request.actor.id)
      throw new HttpError(404, 'Job não encontrado.');
    const state = await job.getState();
    return aiJobSchema.parse({
      id: jobId,
      state,
      result: state === 'completed' ? z.string().parse(job.returnvalue) : null,
    });
  });
}
