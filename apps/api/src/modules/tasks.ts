import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { id, taskInput, taskPatch, taskSchema, commentInput, commentSchema } from '@hub/shared';
import type { Task } from '@hub/shared';
import { db, found, HttpError, transaction } from '../core/db.js';
import { taskColumns } from '../core/records.js';
import { projectAccess, audit } from '../core/access.js';
import { assertOwnTask, canManageProject } from '../core/policy.js';
import { authenticate } from './auth.js';
const params = z.object({ projectId: id }),
  taskParams = params.extend({ taskId: id });
async function validateRelations(
  client: pg.PoolClient,
  projectId: string,
  input: z.infer<typeof taskInput>,
  previous?: Task,
): Promise<void> {
  if (
    input.assigneeId &&
    !(
      await client.query(
        'SELECT 1 FROM allocations a JOIN users u ON u.id=a.user_id WHERE project_id=$1 AND user_id=$2 AND u.is_active=true',
        [projectId, input.assigneeId],
      )
    ).rowCount
  )
    throw new HttpError(422, 'Responsável não está alocado no projeto.');
  if (
    previous?.kind === 'EPIC' &&
    input.kind !== 'EPIC' &&
    (
      await client.query('SELECT 1 FROM tasks WHERE project_id=$1 AND epic_id=$2 LIMIT 1', [
        projectId,
        previous.id,
      ])
    ).rowCount
  )
    throw new HttpError(422, 'Um épico com tarefas vinculadas não pode mudar de tipo.');
  if (input.epicId) {
    const epic = await client.query(
      "SELECT 1 FROM tasks WHERE project_id=$1 AND id=$2 AND kind='EPIC'",
      [projectId, input.epicId],
    );
    if (!epic.rowCount || input.epicId === previous?.id || input.kind === 'EPIC')
      throw new HttpError(422, 'Épico inválido neste projeto.');
  }
  const sprintIds = [
    ...new Set(
      [input.sprintId, previous?.sprintId].filter(
        (value): value is string => typeof value === 'string',
      ),
    ),
  ];
  for (const sprintId of sprintIds) {
    const row = z
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
    if (row.state !== 'PLANNED') {
      const scopeChanged =
        !previous ||
        previous.sprintId !== input.sprintId ||
        previous.points !== input.points ||
        previous.kind !== input.kind ||
        previous.epicId !== input.epicId;
      if (scopeChanged || row.state === 'CLOSED')
        throw new HttpError(409, 'O escopo desta sprint está fechado.');
    }
  }
}
export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.get('/projects/:projectId/tasks', async (request) => {
    const { projectId } = params.parse(request.params);
    await projectAccess(request.actor, projectId);
    return z
      .array(taskSchema)
      .parse(
        (
          await db.query(
            `SELECT ${taskColumns} FROM tasks WHERE project_id=$1 ORDER BY CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,created_at`,
            [projectId],
          )
        ).rows,
      );
  });
  app.post('/projects/:projectId/tasks', async (request, reply) => {
    const { projectId } = params.parse(request.params),
      input = taskInput.parse(request.body),
      taskId = crypto.randomUUID();
    const result = await transaction(async (client) => {
      const membership = await projectAccess(request.actor, projectId, false, client);
      const project = z
        .object({ archived: z.boolean() })
        .parse(
          found(
            (
              await client.query('SELECT archived FROM projects WHERE id=$1 FOR UPDATE', [
                projectId,
              ])
            ).rows[0],
          ),
        );
      if (project.archived) throw new HttpError(409, 'Projeto arquivado.');
      if (
        !canManageProject(request.actor, membership) &&
        (input.assigneeId !== request.actor.id || input.sprintId !== null || input.kind !== 'TASK')
      )
        throw new HttpError(403, 'Membros criam tarefas próprias no backlog.');
      await validateRelations(client, projectId, input);
      const backlogPosition =
        input.sprintId === null
          ? ((
              await client.query<{ nextPosition: number }>(
                'SELECT COALESCE(MAX(backlog_position) + 1, 0)::int AS "nextPosition" FROM tasks WHERE project_id=$1 AND sprint_id IS NULL',
                [projectId],
              )
            ).rows[0]?.nextPosition ?? 0)
          : 0;
      const row = await client.query(
        `INSERT INTO tasks(id,project_id,title,description,acceptance,kind,epic_id,assignee_id,sprint_id,points,priority,due_date,tags,checklist,links,created_by,backlog_position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING ${taskColumns}`,
        [
          taskId,
          projectId,
          input.title,
          input.description,
          input.acceptance,
          input.kind,
          input.epicId,
          input.assigneeId,
          input.sprintId,
          input.points,
          input.priority,
          input.dueDate,
          JSON.stringify(input.tags),
          JSON.stringify(input.checklist),
          JSON.stringify(input.links),
          request.actor.id,
          backlogPosition,
        ],
      );
      await audit(client, request.actor.id, 'task.created', taskId, input);
      return taskSchema.parse(row.rows[0]);
    });
    return reply.code(201).send(result);
  });
  app.patch('/projects/:projectId/tasks/:taskId', async (request) => {
    const { projectId, taskId } = taskParams.parse(request.params),
      patch = taskPatch.parse(request.body);
    return transaction(async (client) => {
      const membership = await projectAccess(request.actor, projectId, false, client);
      const archived = z
        .object({ archived: z.boolean() })
        .parse(
          found(
            (await client.query('SELECT archived FROM projects WHERE id=$1', [projectId])).rows[0],
          ),
        );
      if (archived.archived) throw new HttpError(409, 'Projeto arquivado.');
      const old = taskSchema.parse(
        found(
          (
            await client.query(
              `SELECT ${taskColumns} FROM tasks WHERE project_id=$1 AND id=$2 FOR UPDATE`,
              [projectId, taskId],
            )
          ).rows[0],
        ),
      );
      assertOwnTask(request.actor, membership, old);
      if (old.version !== patch.version)
        throw new HttpError(
          409,
          'O card foi atualizado por outra pessoa. Recarregue e tente novamente.',
        );
      if (
        !canManageProject(request.actor, membership) &&
        Object.keys(patch).some(
          (key) =>
            !['status', 'description', 'acceptance', 'checklist', 'links', 'version'].includes(key),
        )
      )
        throw new HttpError(403, 'Priorização e alocação são ações da liderança.');
      const { version: _version, status: _status, ...fields } = patch;
      void _version;
      void _status;
      const next = taskInput.parse({ ...taskInput.strip().parse(old), ...fields });
      await validateRelations(client, projectId, next, old);
      const result = await client.query(
        `UPDATE tasks SET title=$3,description=$4,acceptance=$5,kind=$6,epic_id=$7,assignee_id=$8,sprint_id=$9,points=$10,priority=$11,due_date=$12,tags=$13,checklist=$14,links=$15,status=$16,version=version+1,updated_at=now() WHERE project_id=$1 AND id=$2 RETURNING ${taskColumns}`,
        [
          projectId,
          taskId,
          next.title,
          next.description,
          next.acceptance,
          next.kind,
          next.epicId,
          next.assigneeId,
          next.sprintId,
          next.points,
          next.priority,
          next.dueDate,
          JSON.stringify(next.tags),
          JSON.stringify(next.checklist),
          JSON.stringify(next.links),
          patch.status ?? old.status,
        ],
      );
      const updated = taskSchema.parse(result.rows[0]);
      await audit(client, request.actor.id, 'task.updated', taskId, {
        before: old,
        after: updated,
      });
      if (old.status !== updated.status) {
        const event = {
          id: crypto.randomUUID(),
          type: 'TaskStatusChanged',
          projectId,
          taskId,
          actorId: request.actor.id,
          from: old.status,
          to: updated.status,
          occurredAt: new Date().toISOString(),
        };
        await client.query(
          'INSERT INTO activity_log(id,project_id,actor_id,action,payload) VALUES($1,$2,$3,$4,$5)',
          [event.id, projectId, request.actor.id, event.type, JSON.stringify(event)],
        );
        await client.query('INSERT INTO outbox(id,payload) VALUES($1,$2)', [
          event.id,
          JSON.stringify(event),
        ]);
      }
      return updated;
    });
  });
  app.get('/projects/:projectId/tasks/:taskId/comments', async (request) => {
    const { projectId, taskId } = taskParams.parse(request.params);
    await projectAccess(request.actor, projectId);
    found(
      (await db.query('SELECT id FROM tasks WHERE project_id=$1 AND id=$2', [projectId, taskId]))
        .rows[0],
    );
    return z
      .array(commentSchema)
      .parse(
        (
          await db.query(
            `SELECT c.id,c.task_id AS "taskId",c.user_id AS "userId",u.name AS author,c.body,c.created_at::text AS "createdAt" FROM comments c JOIN users u ON u.id=c.user_id WHERE c.task_id=$1 ORDER BY c.created_at`,
            [taskId],
          )
        ).rows,
      );
  });
  app.post('/projects/:projectId/tasks/:taskId/comments', async (request, reply) => {
    const { projectId, taskId } = taskParams.parse(request.params),
      input = commentInput.parse(request.body);
    await transaction(async (client) => {
      await projectAccess(request.actor, projectId, false, client);
      found(
        (
          await client.query('SELECT id FROM tasks WHERE project_id=$1 AND id=$2', [
            projectId,
            taskId,
          ])
        ).rows[0],
      );
      if (
        z
          .object({ archived: z.boolean() })
          .parse(
            (await client.query('SELECT archived FROM projects WHERE id=$1', [projectId])).rows[0],
          ).archived
      )
        throw new HttpError(409, 'Projeto arquivado.');
      const commentId = crypto.randomUUID();
      await client.query('INSERT INTO comments(id,task_id,user_id,body) VALUES($1,$2,$3,$4)', [
        commentId,
        taskId,
        request.actor.id,
        input.body,
      ]);
      await audit(client, request.actor.id, 'comment.created', commentId, { taskId });
    });
    return reply.code(201).send({ ok: true });
  });
}
