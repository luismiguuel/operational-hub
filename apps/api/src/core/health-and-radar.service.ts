import { z } from 'zod';
import { allocationOverloadSummarySchema, projectHealthReportSchema } from '@hub/shared';
import type { AllocationOverloadSummary, ProjectHealthReport } from '@hub/shared';
import { db, HttpError } from './db.js';
import { projectAccess } from './access.js';

type Actor = { id: string; role: 'ADMIN' | 'LEADER' | 'MEMBER' };
type HealthInput = {
  projectId: string;
  projectName: string;
  totalPoints: number;
  donePoints: number;
  overdueTasksCount: number;
  blockedTasksCount: number;
  carryoverRate: number;
  activeSprintDaysRemaining: number | null;
};
export function calculateProjectHealth(input: HealthInput): ProjectHealthReport {
  const completionRate = input.totalPoints
    ? Math.round((input.donePoints / input.totalPoints) * 100)
    : 100;
  let score = 100;
  const signals: string[] = [];
  score -= Math.min(35, input.overdueTasksCount * 10);
  if (input.overdueTasksCount) signals.push(`${input.overdueTasksCount} tarefas vencidas`);
  score -= Math.min(30, input.blockedTasksCount * 10);
  if (input.blockedTasksCount) signals.push(`${input.blockedTasksCount} tarefas estagnadas`);
  if (
    input.activeSprintDaysRemaining !== null &&
    input.activeSprintDaysRemaining <= 3 &&
    completionRate < 50
  ) {
    score -= 20;
    signals.push('Taxa de entrega abaixo de 50% com sprint próxima do fim');
  }
  score -= Math.min(30, Math.round(input.carryoverRate * 0.3));
  if (input.carryoverRate > 30)
    signals.push(`Taxa de carryover de ${Math.round(input.carryoverRate)}%`);
  score = Math.max(0, Math.min(100, score));
  return projectHealthReportSchema.parse({
    projectId: input.projectId,
    projectName: input.projectName,
    score,
    status: score >= 75 ? 'HEALTHY' : score >= 50 ? 'WARNING' : 'CRITICAL',
    metrics: {
      completionRate,
      overdueTasksCount: input.overdueTasksCount,
      blockedTasksCount: input.blockedTasksCount,
      carryoverRate: input.carryoverRate,
    },
    signals,
  });
}
export async function getProjectHealth(
  actor: Actor,
  projectId: string,
): Promise<ProjectHealthReport> {
  await projectAccess(actor, projectId);
  const row = z
    .object({
      name: z.string(),
      total: z.number(),
      done: z.number(),
      overdue: z.number(),
      stale: z.number(),
      carryover: z.number(),
      daysRemaining: z.number().nullable(),
    })
    .parse(
      (
        await db.query(
          `SELECT p.name,
    COALESCE(sum(t.points) FILTER (WHERE t.kind='TASK'),0)::int AS total,
    COALESCE(sum(t.points) FILTER (WHERE t.kind='TASK' AND t.status='DONE'),0)::int AS done,
    count(*) FILTER (WHERE t.kind='TASK' AND t.status<>'DONE' AND t.due_date<current_date)::int AS overdue,
    count(*) FILTER (WHERE t.kind='TASK' AND t.status<>'DONE' AND t.updated_at<now()-interval '3 days')::int AS stale,
    COALESCE((SELECT 100.0*count(*) FILTER (WHERE status<>'DONE')/NULLIF(count(*),0) FROM tasks WHERE project_id=p.id AND sprint_id IN (SELECT id FROM sprints WHERE project_id=p.id AND state='CLOSED')),0)::int AS carryover,
    (SELECT (ends_on-current_date)::int FROM sprints WHERE project_id=p.id AND state='ACTIVE') AS "daysRemaining"
    FROM projects p LEFT JOIN sprints s ON s.project_id=p.id AND s.state='ACTIVE'
    LEFT JOIN tasks t ON t.project_id=p.id AND (s.id IS NULL OR t.sprint_id=s.id)
    WHERE p.id=$1 GROUP BY p.id,p.name`,
          [projectId],
        )
      ).rows[0],
    );
  return calculateProjectHealth({
    projectId,
    projectName: row.name,
    totalPoints: row.total,
    donePoints: row.done,
    overdueTasksCount: row.overdue,
    blockedTasksCount: row.stale,
    carryoverRate: row.carryover,
    activeSprintDaysRemaining: row.daysRemaining,
  });
}
export async function listProjectHealth(actor: Actor): Promise<ProjectHealthReport[]> {
  const visible = await db.query<{ id: string }>(
    'SELECT p.id FROM projects p WHERE NOT p.archived AND ($1::boolean OR EXISTS(SELECT 1 FROM allocations a WHERE a.project_id=p.id AND a.user_id=$2)) ORDER BY p.name',
    [actor.role === 'ADMIN', actor.id],
  );
  return Promise.all(visible.rows.map(({ id }) => getProjectHealth(actor, id)));
}
export async function getAllocationRadar(): Promise<AllocationOverloadSummary> {
  const rows = await db.query(`SELECT u.id AS "userId",u.name,u.area,u.role,
    u.weekly_hours AS "capacity",COALESCE(sum(a.weekly_hours) FILTER (WHERE p.id IS NOT NULL),0)::int AS "allocated",
    count(DISTINCT t.id)::int AS "tasks",COALESCE(sum(DISTINCT t.points),0)::int AS "points"
    FROM users u LEFT JOIN allocations a ON a.user_id=u.id
    LEFT JOIN projects p ON p.id=a.project_id AND p.archived=false
    LEFT JOIN tasks t ON t.assignee_id=u.id AND t.project_id=p.id AND t.status<>'DONE' AND t.kind='TASK'
    WHERE u.is_active=true GROUP BY u.id ORDER BY u.name`);
  const parsed = z
    .array(
      z.object({
        userId: z.string().uuid(),
        name: z.string(),
        area: z.string(),
        role: z.string(),
        capacity: z.number(),
        allocated: z.number(),
        tasks: z.number(),
        points: z.number(),
      }),
    )
    .parse(rows.rows);
  const members = parsed.map((member) => {
    const utilizationPercent = member.capacity
      ? Math.round((member.allocated / member.capacity) * 100)
      : 0;
    return {
      userId: member.userId,
      name: member.name,
      area: member.area,
      role: member.role,
      weeklyCapacityHours: member.capacity,
      allocatedHours: member.allocated,
      utilizationPercent,
      activeTasksCount: member.tasks,
      activeStoryPoints: member.points,
      riskLevel:
        utilizationPercent > 100
          ? ('OVERLOADED' as const)
          : utilizationPercent >= 85
            ? ('NEAR_LIMIT' as const)
            : ('OPTIMAL' as const),
    };
  });
  return allocationOverloadSummarySchema.parse({
    members,
    totals: {
      totalMembers: members.length,
      overloadedCount: members.filter((m) => m.riskLevel === 'OVERLOADED').length,
      nearLimitCount: members.filter((m) => m.riskLevel === 'NEAR_LIMIT').length,
      availableHoursTotal: members.reduce(
        (sum, m) => sum + Math.max(0, m.weeklyCapacityHours - m.allocatedHours),
        0,
      ),
    },
  });
}
export async function assertProjectVisible(actor: Actor, projectId: string): Promise<void> {
  await projectAccess(actor, projectId);
  const row = (await db.query('SELECT archived FROM projects WHERE id=$1', [projectId])).rows[0] as
    { archived?: boolean } | undefined;
  if (row?.archived) throw new HttpError(404, 'Projeto não encontrado.');
}
