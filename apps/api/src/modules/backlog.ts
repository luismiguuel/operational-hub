import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { id, pullBacklogToSprintSchema, reorderBacklogSchema } from '@hub/shared';
import { found, HttpError, transaction } from '../core/db.js';
import { audit, projectAccess } from '../core/access.js';
import { authenticate } from './auth.js';

const projectParams = z.object({ projectId: id });

export async function backlogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.patch('/projects/:projectId/backlog/reorder', async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const { orderedTaskIds } = reorderBacklogSchema.parse(request.body);
    if (new Set(orderedTaskIds).size !== orderedTaskIds.length)
      throw new HttpError(400, 'A lista contém tarefas repetidas.');

    return transaction(async (client) => {
      await projectAccess(request.actor, projectId, true, client);
      const selected = await client.query<{ id: string; sprint_id: string | null }>(
        'SELECT id,sprint_id FROM tasks WHERE project_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE',
        [projectId, orderedTaskIds],
      );
      if (selected.rowCount !== orderedTaskIds.length)
        throw new HttpError(404, 'Uma ou mais tarefas não pertencem a este projeto.');
      if (selected.rows.some((task) => task.sprint_id !== null))
        throw new HttpError(400, 'Só é possível reordenar tarefas que ainda estão no backlog.');

      const backlog = await client.query<{ id: string }>(
        'SELECT id FROM tasks WHERE project_id=$1 AND sprint_id IS NULL ORDER BY backlog_position,created_at,id FOR UPDATE',
        [projectId],
      );
      const selectedIds = new Set(orderedTaskIds);
      const completeOrder = [
        ...orderedTaskIds,
        ...backlog.rows.map((task) => task.id).filter((taskId) => !selectedIds.has(taskId)),
      ];
      await client.query(
        'UPDATE tasks AS task SET backlog_position=ordered.position::int-1 FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id,position) WHERE task.project_id=$1 AND task.id=ordered.id',
        [projectId, completeOrder],
      );

      const event = {
        id: crypto.randomUUID(),
        type: 'BacklogReordered' as const,
        projectId,
        actorId: request.actor.id,
        taskCount: completeOrder.length,
        occurredAt: new Date().toISOString(),
      };
      await audit(client, request.actor.id, 'backlog.reordered', projectId, {
        orderedTaskIds,
        taskCount: completeOrder.length,
      });
      await client.query('INSERT INTO outbox(id,payload) VALUES($1,$2)', [
        event.id,
        JSON.stringify(event),
      ]);
      return { ok: true, orderedTaskIds: completeOrder };
    });
  });

  app.post('/projects/:projectId/backlog/pull-to-sprint', async (request) => {
    const { projectId } = projectParams.parse(request.params);
    const { taskIds, targetSprintId } = pullBacklogToSprintSchema.parse(request.body);
    if (new Set(taskIds).size !== taskIds.length)
      throw new HttpError(400, 'A lista contém tarefas repetidas.');

    return transaction(async (client) => {
      await projectAccess(request.actor, projectId, true, client);
      const targetSprint = z
        .object({ id, project_id: id, state: z.string() })
        .parse(
          found(
            (
              await client.query('SELECT id,project_id,state FROM sprints WHERE id=$1 FOR UPDATE', [
                targetSprintId,
              ])
            ).rows[0],
          ),
        );
      if (targetSprint.project_id !== projectId)
        throw new HttpError(404, 'Sprint não encontrada neste projeto.');
      if (targetSprint.state !== 'PLANNED')
        throw new HttpError(400, 'O destino precisa ser uma sprint planejada.');

      const tasks = await client.query<{ id: string; sprint_id: string | null }>(
        'SELECT id,sprint_id FROM tasks WHERE project_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE',
        [projectId, taskIds],
      );
      if (tasks.rowCount !== taskIds.length)
        throw new HttpError(404, 'Uma ou mais tarefas não pertencem a este projeto.');
      if (tasks.rows.some((task) => task.sprint_id !== null))
        throw new HttpError(400, 'Só é possível enviar tarefas que ainda estão no backlog.');

      const moved = await client.query<{ id: string }>(
        'UPDATE tasks SET sprint_id=$3,version=version+1,updated_at=now() WHERE project_id=$1 AND id=ANY($2::uuid[]) AND sprint_id IS NULL RETURNING id',
        [projectId, taskIds, targetSprintId],
      );
      if (moved.rowCount !== taskIds.length)
        throw new HttpError(
          409,
          'O backlog mudou durante a operação. Recarregue e tente novamente.',
        );

      const occurredAt = new Date().toISOString();
      for (const task of moved.rows) {
        const event = {
          id: crypto.randomUUID(),
          type: 'TaskPulledToSprint' as const,
          projectId,
          taskId: task.id,
          targetSprintId,
          actorId: request.actor.id,
          occurredAt,
        };
        await client.query(
          'INSERT INTO activity_log(id,project_id,actor_id,action,payload) VALUES($1,$2,$3,$4,$5)',
          [event.id, projectId, request.actor.id, event.type, JSON.stringify(event)],
        );
      }
      const event = {
        id: crypto.randomUUID(),
        type: 'BacklogPulledToSprint' as const,
        projectId,
        targetSprintId,
        actorId: request.actor.id,
        taskCount: moved.rowCount ?? 0,
        occurredAt,
      };
      await audit(client, request.actor.id, 'backlog.pulled_to_sprint', projectId, {
        taskIds,
        targetSprintId,
      });
      await client.query('INSERT INTO outbox(id,payload) VALUES($1,$2)', [
        event.id,
        JSON.stringify(event),
      ]);
      return { ok: true, movedCount: moved.rowCount ?? 0, targetSprintId };
    });
  });
}
