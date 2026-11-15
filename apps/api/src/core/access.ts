import { z } from 'zod';
import { db, found, HttpError } from './db.js';
import { assertRead, assertManage } from './policy.js';
import type { Principal, ProjectRole } from './policy.js';
import type pg from 'pg';
export async function projectAccess(
  actor: Principal,
  projectId: string,
  manage = false,
  client: pg.Pool | pg.PoolClient = db,
): Promise<ProjectRole> {
  const result = await client.query(
    `SELECT p.archived,a.role FROM projects p LEFT JOIN allocations a ON a.project_id=p.id AND a.user_id=$2 WHERE p.id=$1${client === db ? '' : ' FOR UPDATE OF p'}`,
    [projectId, actor.id],
  );
  const row = z
    .object({ archived: z.boolean(), role: z.enum(['LEADER', 'MEMBER']).nullable() })
    .parse(found(result.rows[0]));
  if (manage) {
    assertManage(actor, row.role);
    if (row.archived) throw new HttpError(409, 'Projeto arquivado.');
  } else assertRead(actor, row.role);
  return row.role;
}
export async function audit(
  client: pg.Pool | pg.PoolClient,
  actorId: string,
  action: string,
  resourceId: string,
  payload: unknown,
): Promise<void> {
  await client.query(
    'INSERT INTO audit_log(id,actor_id,action,resource_id,payload) VALUES($1,$2,$3,$4,$5)',
    [crypto.randomUUID(), actorId, action, resourceId, JSON.stringify(payload)],
  );
}
