import type { Role, Task } from '@hub/shared';
import { HttpError } from './errors.js';
export interface Principal {
  id: string;
  role: Role;
}
export type ProjectRole = 'LEADER' | 'MEMBER' | null;
export function canReadProject(actor: Principal, membership: ProjectRole): boolean {
  return actor.role === 'ADMIN' || membership !== null;
}
export function canManageProject(actor: Principal, membership: ProjectRole): boolean {
  return actor.role === 'ADMIN' || (actor.role === 'LEADER' && membership === 'LEADER');
}
export function assertRead(actor: Principal, membership: ProjectRole): void {
  if (!canReadProject(actor, membership)) throw new HttpError(404, 'Projeto não encontrado.');
}
export function assertManage(actor: Principal, membership: ProjectRole): void {
  assertRead(actor, membership);
  if (!canManageProject(actor, membership))
    throw new HttpError(403, 'Ação exclusiva da liderança deste projeto.');
}
export function assertOwnTask(
  actor: Principal,
  membership: ProjectRole,
  task: Pick<Task, 'assigneeId' | 'createdBy'>,
): void {
  assertRead(actor, membership);
  if (
    !canManageProject(actor, membership) &&
    task.assigneeId !== actor.id &&
    !(task.assigneeId === null && task.createdBy === actor.id)
  )
    throw new HttpError(403, 'Você só pode alterar seus próprios cards.');
}
