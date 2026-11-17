import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import argon2 from 'argon2';
import { z } from 'zod';
import {
  areas,
  activitySchema,
  metricsSchema,
  authResponse,
  taskSchema,
  projectSchema,
  sprintSchema,
  eventSchema,
  wsServerSchema,
  id,
  userSchema,
} from '@hub/shared';
import { schema } from '../scripts/schema.js';
import { knowledgeSchema } from '../scripts/knowledge-schema.js';
// A fresh, randomly named database is created and dropped. The configured DB is never modified.
process.env['NODE_ENV'] = 'test';
const original = z.string().url().parse(process.env['DATABASE_URL']);
const url = new URL(original),
  name = `hub_test_${crypto.randomUUID().replaceAll('-', '')}`;
const maintenance = new pg.Pool({ connectionString: original });
url.pathname = `/${name}`;
process.env['DATABASE_URL'] = url.toString();
const { db } = await import('../core/db.js');
const { redis, aiQueue, queueConnection } = await import('../core/redis.js');
const { buildApp } = await import('../app.js');
const { publishOutbox } = await import('../core/events.js');
const app = await buildApp();
const adminId = crypto.randomUUID(),
  memberId = crypto.randomUUID(),
  outsiderId = crypto.randomUUID();
let adminToken = '',
  memberToken = '',
  outsiderToken = '',
  projectId = '',
  otherProjectId = '',
  taskId = '',
  sprintId = '';
const origin = process.env['WEB_ORIGIN'] ?? 'http://localhost:5173';
const headers = (token: string) => ({ authorization: `Bearer ${token}`, origin });
before(async () => {
  await maintenance.query(`CREATE DATABASE ${name}`);
  await db.query(schema);
  await db.query(knowledgeSchema);
  for (const [area, subareas] of Object.entries(areas))
    await db.query('INSERT INTO areas VALUES($1,$2)', [area, JSON.stringify(subareas)]);
  const orgAreas = [
    ['10000000-0000-4000-8000-000000000001', 'Tech', 'tech'],
    ['10000000-0000-4000-8000-000000000002', 'Produto', 'produto'],
    ['10000000-0000-4000-8000-000000000003', 'Gente e Gestão', 'gente-e-gestao'],
    ['10000000-0000-4000-8000-000000000004', 'Negócios', 'negocios'],
  ];
  for (const [id, name, slug] of orgAreas)
    await db.query('INSERT INTO org_areas(id,name,slug) VALUES($1,$2,$3)', [id, name, slug]);
  for (const [id, areaId, name, slug] of [
    ['20000000-0000-4000-8000-000000000001', orgAreas[0]?.[0], 'Dev', 'tech-dev'],
    ['20000000-0000-4000-8000-000000000002', orgAreas[0]?.[0], 'Dados', 'tech-dados'],
    ['20000000-0000-4000-8000-000000000003', orgAreas[1]?.[0], 'Design/UX', 'produto-design-ux'],
  ])
    await db.query('INSERT INTO org_subareas(id,area_id,name,slug) VALUES($1,$2,$3,$4)', [
      id,
      areaId,
      name,
      slug,
    ]);
  for (const [id, name, slug] of [
    ['30000000-0000-4000-8000-000000000001', 'Diretoria', 'diretoria'],
    ['30000000-0000-4000-8000-000000000002', 'Liderança de Projeto', 'lideranca-de-projeto'],
    ['30000000-0000-4000-8000-000000000003', 'Consultor', 'consultor'],
  ])
    await db.query('INSERT INTO org_roles(id,name,slug) VALUES($1,$2,$3)', [id, name, slug]);
  const hash = await argon2.hash('integration-secret-password', { type: argon2.argon2id });
  for (const [userId, role] of [
    [adminId, 'ADMIN'],
    [memberId, 'MEMBER'],
    [outsiderId, 'LEADER'],
  ])
    await db.query(
      "INSERT INTO users(id,name,email,role,area,subarea,title,weekly_hours,password_hash) VALUES($1,'Test',$2,$3,'Tech','Dev','Tester',16,$4)",
      [userId, `${userId}@example.org`, role, hash],
    );
  for (const userId of [adminId, memberId, outsiderId]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin },
      payload: { email: `${userId}@example.org`, password: 'integration-secret-password' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const data = authResponse.parse(response.json());
    if (userId === adminId) adminToken = data.accessToken;
    else if (userId === memberId) memberToken = data.accessToken;
    else outsiderToken = data.accessToken;
  }
  for (let index = 0; index < 2; index++) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: headers(adminToken),
      payload: { name: `Projeto ${index}`, kind: 'INTERNAL' },
    });
    assert.equal(response.statusCode, 201);
    const data = projectSchema.parse(response.json());
    if (index === 0) projectId = data.id;
    else otherProjectId = data.id;
  }
  const allocation = await app.inject({
    method: 'PUT',
    url: `/api/v1/projects/${projectId}/allocations`,
    headers: headers(adminToken),
    payload: { userId: memberId, role: 'MEMBER', weeklyHours: 12 },
  });
  assert.equal(allocation.statusCode, 200);
});
after(async () => {
  await app.close();
  await aiQueue.close();
  await queueConnection.quit();
  await redis.quit();
  await db.end();
  await maintenance.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await maintenance.end();
});
test('sem token não acessa diretório; líder sem vínculo não acessa projeto', async () => {
  assert.equal((await app.inject({ url: '/api/v1/users' })).statusCode, 401);
  for (const suffix of ['tasks', 'sprints', 'allocations', 'metrics', 'activity'])
    assert.equal(
      (
        await app.inject({
          url: `/api/v1/projects/${projectId}/${suffix}`,
          headers: headers(outsiderToken),
        })
      ).statusCode,
      404,
    );
});
test('membro cria tarefa própria no backlog e não pode atribuí-la a outro', async () => {
  const invalid = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/tasks`,
    headers: headers(memberToken),
    payload: { title: 'Outra pessoa', assigneeId: adminId },
  });
  assert.equal(invalid.statusCode, 403);
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/tasks`,
    headers: headers(memberToken),
    payload: { title: 'Tarefa própria', assigneeId: memberId },
  });
  assert.equal(response.statusCode, 201, response.body);
  taskId = taskSchema.parse(response.json()).id;
});
test('bloqueia BOLA, registra evento e rejeita atualização concorrente', async () => {
  const target = `/api/v1/projects/${projectId}/tasks/${taskId}`;
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${otherProjectId}/tasks/${taskId}`,
        headers: headers(adminToken),
        payload: { status: 'DONE', version: 1 },
      })
    ).statusCode,
    404,
  );
  const response = await app.inject({
    method: 'PATCH',
    url: target,
    headers: headers(memberToken),
    payload: { status: 'IN_PROGRESS', version: 1 },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(taskSchema.parse(response.json()).version, 2);
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: target,
        headers: headers(memberToken),
        payload: { status: 'DONE', version: 1 },
      })
    ).statusCode,
    409,
  );
  const outbox = await db.query<{ payload: unknown }>('SELECT payload FROM outbox');
  assert.equal(outbox.rowCount, 1);
  assert.equal(eventSchema.parse(outbox.rows[0]?.payload).type, 'TaskStatusChanged');
  assert.equal((await db.query('SELECT id FROM activity_log')).rowCount, 1);
});
test('congela escopo da sprint ativa e valida sprint contextual', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/sprints`,
    headers: headers(adminToken),
    payload: {
      name: 'Sprint teste',
      goal: 'Verificar escopo',
      startsOn: '2026-11-15',
      endsOn: '2026-11-30',
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  sprintId = sprintSchema.parse(response.json()).id;
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${projectId}/tasks/${taskId}`,
        headers: headers(adminToken),
        payload: { sprintId, version: 2 },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${projectId}/sprints/${sprintId}`,
        headers: headers(adminToken),
        payload: { state: 'ACTIVE' },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${projectId}/tasks/${taskId}`,
        headers: headers(adminToken),
        payload: { points: 8, version: 3 },
      })
    ).statusCode,
    409,
  );
  const invalid = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${otherProjectId}/tasks`,
    headers: headers(adminToken),
    payload: { title: 'Sprint de outro projeto', sprintId },
  });
  assert.equal(invalid.statusCode, 404);
});
test('auditoria é imutável para update, delete e truncate', async () => {
  for (const sql of [
    "UPDATE audit_log SET action='tamper'",
    'DELETE FROM audit_log',
    'TRUNCATE audit_log',
  ])
    await assert.rejects(db.query(sql), /append-only/);
});
test('rotação detecta replay e revoga a família', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin },
    payload: { email: `${memberId}@example.org`, password: 'integration-secret-password' },
  });
  const cookie = login.cookies.find((c) => c.name === 'refresh');
  assert.ok(cookie);
  assert.ok(login.headers['set-cookie']?.toString().includes('HttpOnly'));
  assert.ok(login.headers['set-cookie']?.toString().includes('SameSite=Strict'));
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    headers: { origin },
    cookies: { refresh: cookie.value },
  });
  assert.equal(response.statusCode, 200);
  const next = response.cookies.find((c) => c.name === 'refresh');
  assert.ok(next);
  assert.notEqual(cookie.value, next.value);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { origin },
        cookies: { refresh: cookie.value },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { origin },
        cookies: { refresh: next.value },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        headers: { origin: 'https://evil.example' },
        cookies: { refresh: next.value },
      })
    ).statusCode,
    403,
  );
});
test('room exige autenticação; entrega evento apenas ao projeto vinculado', async () => {
  await app.ready();
  const ws = await app.injectWS(`/api/v1/ws/projects/${projectId}`, { headers: { origin } });
  const ready = new Promise<unknown>((resolve) =>
    ws.once('message', (data) => resolve(JSON.parse(data.toString()))),
  );
  ws.send(JSON.stringify({ type: 'authenticate', accessToken: memberToken }));
  assert.equal(wsServerSchema.parse(await ready).type, 'ready');
  const delivered = new Promise<unknown>((resolve) =>
    ws.once('message', (data) => resolve(JSON.parse(data.toString()))),
  );
  await publishOutbox();
  assert.equal(wsServerSchema.parse(await delivered).type, 'TaskStatusChanged');
  ws.terminate();
  const denied = await app.injectWS(`/api/v1/ws/projects/${projectId}`, { headers: { origin } });
  const closed = new Promise<number>((resolve) => denied.once('close', (code) => resolve(code)));
  denied.send(JSON.stringify({ type: 'authenticate', accessToken: outsiderToken }));
  assert.equal(await closed, 1008);
});

async function carryoverFixture() {
  const project = crypto.randomUUID(),
    source = crypto.randomUUID(),
    target = crypto.randomUUID();
  await db.query(
    "INSERT INTO projects(id,name,description,kind) VALUES($1,'Carryover','Teste isolado','INTERNAL')",
    [project],
  );
  await db.query(
    "INSERT INTO allocations(project_id,user_id,role,weekly_hours) VALUES($1,$2,'MEMBER',8)",
    [project, memberId],
  );
  for (const [sprint, state] of [
    [source, 'ACTIVE'],
    [target, 'PLANNED'],
  ])
    await db.query(
      "INSERT INTO sprints(id,project_id,name,goal,starts_on,ends_on,state) VALUES($1,$2,'Sprint carryover','Validar encerramento','2026-11-01','2026-11-14',$3)",
      [sprint, project, state],
    );
  const done = crypto.randomUUID(),
    pending = crypto.randomUUID(),
    epic = crypto.randomUUID();
  for (const [task, status, kind, points] of [
    [done, 'DONE', 'TASK', 3],
    [pending, 'REVIEW', 'TASK', 5],
    [epic, 'TODO', 'EPIC', 8],
  ])
    await db.query(
      "INSERT INTO tasks(id,project_id,sprint_id,title,created_by,status,kind,points,priority,updated_at) VALUES($1,$2,$3,'Item carryover',$4,$5,$6,$7,'MEDIUM','2026-10-01')",
      [task, project, source, adminId, status, kind, points],
    );
  return { project, source, target, done, pending, epic };
}

for (const unfinishedAction of ['BACKLOG', 'NEXT_SPRINT'] as const) {
  test(`carryover ${unfinishedAction}: preserva conclusão, versões, histórico, auditoria e velocidade`, async () => {
    const fixture = await carryoverFixture();
    const { project, source, target, done, pending, epic } = fixture;
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project}/sprints/${source}`,
      headers: headers(adminToken),
      payload: {
        state: 'CLOSED',
        unfinishedAction,
        ...(unfinishedAction === 'NEXT_SPRINT' ? { targetSprintId: target } : {}),
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(sprintSchema.parse(response.json()).state, 'CLOSED');
    const destination = unfinishedAction === 'BACKLOG' ? null : target;
    const tasks = await db.query<{
      id: string;
      sprint_id: string | null;
      version: number;
      status: string;
      updated_at: Date;
    }>('SELECT id,sprint_id,version,status,updated_at FROM tasks WHERE project_id=$1', [project]);
    for (const taskId of [pending, epic]) {
      const task = tasks.rows.find((row) => row.id === taskId);
      assert.ok(task);
      assert.equal(task.sprint_id, destination);
      assert.equal(task.version, 2);
      assert.ok(task.updated_at > new Date('2026-10-01'));
    }
    const completed = tasks.rows.find((row) => row.id === done);
    assert.equal(completed?.sprint_id, source);
    assert.equal(completed?.version, 1);
    assert.equal(tasks.rows.find((row) => row.id === pending)?.status, 'REVIEW');
    const sprint = await db.query<{ closed_at: Date | null }>(
      'SELECT closed_at FROM sprints WHERE id=$1',
      [source],
    );
    assert.ok(sprint.rows[0]?.closed_at instanceof Date);
    const auditRow = await db.query<{ payload: unknown }>(
      'SELECT payload FROM audit_log WHERE resource_id=$1 AND action=$2',
      [source, 'sprint.state_changed'],
    );
    assert.equal(auditRow.rowCount, 1);
    assert.deepEqual(auditRow.rows[0]?.payload, {
      from: 'ACTIVE',
      to: 'CLOSED',
      doneCount: 1,
      donePoints: 3,
      carryoverCount: 1,
      carryoverPoints: 5,
      unfinishedAction,
      targetSprintId: destination,
    });
    const activity = await app.inject({
      url: `/api/v1/projects/${project}/activity`,
      headers: headers(adminToken),
    });
    assert.equal(activity.statusCode, 200, activity.body);
    const entries = z.array(activitySchema).parse(activity.json());
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries
        .map((entry) => entry.payload)
        .filter((event) => event.type === 'TaskCarriedOver')
        .map((event) => [event.taskId, event.sprintId, event.targetSprintId])
        .sort(),
      [
        [pending, source, destination],
        [epic, source, destination],
      ].sort(),
    );
    const outbox = await db.query<{ payload: unknown }>(
      "SELECT payload FROM outbox WHERE payload->>'projectId'=$1",
      [project],
    );
    const events = outbox.rows.map((row) => eventSchema.parse(row.payload));
    assert.equal(events.filter((event) => event.type === 'TaskCarriedOver').length, 2);
    assert.equal(events.filter((event) => event.type === 'SprintClosed').length, 1);
    const metrics = await app.inject({
      url: `/api/v1/projects/${project}/metrics`,
      headers: headers(adminToken),
    });
    assert.equal(metrics.statusCode, 200, metrics.body);
    assert.equal(
      metricsSchema.parse(metrics.json()).velocity.find((row) => row.id === source)?.points,
      3,
    );
    // A stale browser cannot overwrite the moved task after the bulk version increment.
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project}/tasks/${pending}`,
      headers: headers(adminToken),
      payload: { version: 1, status: 'DONE' },
    });
    assert.equal(stale.statusCode, 409);
    const repeat = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project}/sprints/${source}`,
      headers: headers(adminToken),
      payload: { state: 'CLOSED' },
    });
    assert.equal(repeat.statusCode, 409);
  });
}

test('carryover rejeita destino ativo, encerrado, inexistente ou de outro projeto sem alterações parciais', async () => {
  const { project, source, target, pending } = await carryoverFixture();
  const foreign = await carryoverFixture();
  await db.query("UPDATE sprints SET state='CLOSED' WHERE id=$1", [target]);
  for (const [targetSprintId, code] of [
    [source, 400],
    [target, 400],
    [crypto.randomUUID(), 404],
    [foreign.target, 404],
  ] as const) {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project}/sprints/${source}`,
      headers: headers(adminToken),
      payload: { state: 'CLOSED', unfinishedAction: 'NEXT_SPRINT', targetSprintId },
    });
    assert.equal(response.statusCode, code, response.body);
  }
  const missing = await app.inject({
    method: 'PATCH',
    url: `/api/v1/projects/${project}/sprints/${source}`,
    headers: headers(adminToken),
    payload: { state: 'CLOSED', unfinishedAction: 'NEXT_SPRINT' },
  });
  assert.equal(missing.statusCode, 400);
  const task = (
    await db.query<{ sprint_id: string; version: number }>(
      'SELECT sprint_id,version FROM tasks WHERE id=$1',
      [pending],
    )
  ).rows[0];
  assert.equal(task?.sprint_id, source);
  assert.equal(task?.version, 1);
  const sprint = (
    await db.query<{ state: string; closed_at: Date | null }>(
      'SELECT state,closed_at FROM sprints WHERE id=$1',
      [source],
    )
  ).rows[0];
  assert.equal(sprint?.state, 'ACTIVE');
  assert.equal(sprint?.closed_at, null);
  assert.equal(
    (await db.query('SELECT id FROM audit_log WHERE resource_id=$1', [source])).rowCount,
    0,
  );
  assert.equal(
    (await db.query('SELECT id FROM activity_log WHERE project_id=$1', [project])).rowCount,
    0,
  );
  assert.equal(
    (await db.query("SELECT id FROM outbox WHERE payload->>'projectId'=$1", [project])).rowCount,
    0,
  );
});

test('encerramento sem pendências usa BACKLOG por padrão e entrega SprintClosed via WebSocket', async () => {
  const { project, source } = await carryoverFixture();
  await db.query("UPDATE tasks SET status='DONE' WHERE project_id=$1", [project]);
  const ws = await app.injectWS(`/api/v1/ws/projects/${project}`, { headers: { origin } });
  const ready = new Promise<unknown>((resolve) =>
    ws.once('message', (data) => resolve(JSON.parse(data.toString()))),
  );
  ws.send(JSON.stringify({ type: 'authenticate', accessToken: memberToken }));
  assert.equal(wsServerSchema.parse(await ready).type, 'ready');
  try {
    for (const [token, code] of [
      [memberToken, 403],
      [outsiderToken, 404],
    ] as const) {
      const denied = await app.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${project}/sprints/${source}`,
        headers: headers(token),
        payload: { state: 'CLOSED' },
      });
      assert.equal(denied.statusCode, code, denied.body);
    }
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project}/sprints/${source}`,
      headers: headers(adminToken),
      payload: { state: 'CLOSED' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const delivered = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SprintClosed não entregue')), 5000);
      ws.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
    });
    // Drain all batches, including events produced by previous tests.
    while ((await db.query('SELECT id FROM outbox WHERE published_at IS NULL')).rowCount)
      await publishOutbox();
    const event = wsServerSchema.parse(await delivered);
    assert.equal(event.type, 'SprintClosed');
    if (event.type !== 'SprintClosed') throw new Error('Evento de encerramento esperado');
    assert.equal(event.sprintId, source);
    assert.equal(event.carryoverCount, 0);
    assert.equal(event.donePoints, 8);
    assert.equal(event.unfinishedAction, 'BACKLOG');
  } finally {
    ws.terminate();
  }
});

test('taxonomia organizacional permite gestão apenas para ADMIN e audita mutações', async () => {
  for (const token of [memberToken, outsiderToken]) {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/org/areas',
          headers: headers(token),
          payload: { name: 'Pesquisa', slug: 'pesquisa' },
        })
      ).statusCode,
      403,
    );
  }
  const createdArea = await app.inject({
    method: 'POST',
    url: '/api/v1/org/areas',
    headers: headers(adminToken),
    payload: { name: 'Pesquisa', slug: 'pesquisa', description: 'Pesquisa aplicada' },
  });
  assert.equal(createdArea.statusCode, 201, createdArea.body);
  const areaId = z.object({ id }).parse(createdArea.json()).id;
  const createdSubarea = await app.inject({
    method: 'POST',
    url: '/api/v1/org/subareas',
    headers: headers(adminToken),
    payload: { areaId, name: 'Pesquisa de Produto', slug: 'pesquisa-de-produto' },
  });
  assert.equal(createdSubarea.statusCode, 201, createdSubarea.body);
  const subareaId = z.object({ id }).parse(createdSubarea.json()).id;
  const createdRole = await app.inject({
    method: 'POST',
    url: '/api/v1/org/roles',
    headers: headers(adminToken),
    payload: { name: 'Pesquisador', slug: 'pesquisador' },
  });
  assert.equal(createdRole.statusCode, 201, createdRole.body);
  const roleId = z.object({ id }).parse(createdRole.json()).id;
  for (const [path, resourceId] of [
    ['areas', areaId],
    ['subareas', subareaId],
    ['roles', roleId],
  ]) {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/org/${path}/${resourceId}`,
      headers: headers(adminToken),
      payload: { isActive: false },
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  const taxonomy = await app.inject({ url: '/api/v1/org/taxonomy', headers: headers(memberToken) });
  assert.equal(taxonomy.statusCode, 200, taxonomy.body);
  const auditRows = await db.query(
    "SELECT id FROM audit_log WHERE action LIKE 'org.%' AND resource_id=$1",
    [areaId],
  );
  assert.ok((auditRows.rowCount ?? 0) >= 2);
  const events = await db.query<{ payload: unknown }>(
    "SELECT payload FROM outbox WHERE payload->>'type'='OrgManagementChanged'",
  );
  assert.ok(events.rows.length >= 6);
});

test('desativação mantém histórico, bloqueia sessões e protege a última conta ADMIN', async () => {
  const forbidden = await app.inject({
    method: 'PATCH',
    url: `/api/v1/users/${adminId}/admin`,
    headers: headers(adminToken),
    payload: {
      area: 'Tech',
      subarea: 'Dev',
      role: 'Consultor',
      systemRole: 'MEMBER',
      weeklyCapacityHours: 16,
      isActive: false,
    },
  });
  assert.equal(forbidden.statusCode, 409);
  const taskCount = await db.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM tasks WHERE assignee_id=$1',
    [memberId],
  );
  assert.ok(Number(taskCount.rows[0]?.['count']) > 0);
  const update = await app.inject({
    method: 'PATCH',
    url: `/api/v1/users/${memberId}/admin`,
    headers: headers(adminToken),
    payload: {
      area: 'Tech',
      subarea: 'Dev',
      role: 'Consultor',
      systemRole: 'MEMBER',
      weeklyCapacityHours: 16,
      isActive: false,
    },
  });
  assert.equal(update.statusCode, 200, update.body);
  assert.equal(userSchema.parse(update.json()).active, false);
  assert.equal(
    (await db.query('SELECT id FROM tasks WHERE assignee_id=$1', [memberId])).rowCount,
    taskCount.rows[0]?.['count'],
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin },
        payload: { email: `${memberId}@example.org`, password: 'integration-secret-password' },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ url: '/api/v1/users', headers: headers(memberToken) })).statusCode,
    401,
  );
  assert.ok(
    (
      await db.query(
        "SELECT id FROM audit_log WHERE action='user.admin_updated' AND resource_id=$1",
        [memberId],
      )
    ).rowCount,
  );
});

test('provisionamento em lote relata emails repetidos e grava auditoria', async () => {
  const member = {
    name: 'Pessoa em lote',
    email: 'batch@example.org',
    area: 'Tech',
    subarea: 'Dev',
    role: 'Consultor',
    systemRole: 'MEMBER',
    weeklyCapacityHours: 12,
  };
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/users/bulk-provision',
    headers: headers(adminToken),
    payload: { members: [member, member] },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    created: ['batch@example.org'],
    existing: ['batch@example.org'],
    createdCount: 1,
    existingCount: 1,
  });
  assert.ok(
    (await db.query("SELECT id FROM audit_log WHERE action='user.bulk_provisioned'")).rowCount,
  );
  assert.ok(
    (await db.query("SELECT id FROM outbox WHERE payload->>'resourceType'='BULK_PROVISION'"))
      .rowCount,
  );
});

async function backlogFixture() {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: headers(adminToken),
    payload: { name: 'Projeto de priorização', kind: 'INTERNAL' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const project = projectSchema.parse(created.json());
  const foreignResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: headers(adminToken),
    payload: { name: 'Projeto externo à priorização', kind: 'INTERNAL' },
  });
  assert.equal(foreignResponse.statusCode, 201, foreignResponse.body);
  const foreignProject = projectSchema.parse(foreignResponse.json());
  await db.query('UPDATE users SET active=true,is_active=true,deactivated_at=NULL WHERE id=$1', [
    memberId,
  ]);
  await db.query(
    "INSERT INTO allocations(project_id,user_id,role,weekly_hours) VALUES($1,$2,'MEMBER',8),($3,$2,'MEMBER',8)",
    [project.id, memberId, foreignProject.id],
  );
  const plannedSprintId = crypto.randomUUID();
  const activeSprintId = crypto.randomUUID();
  const foreignSprintId = crypto.randomUUID();
  for (const [sprintId, owner, state] of [
    [plannedSprintId, project.id, 'PLANNED'],
    [activeSprintId, project.id, 'ACTIVE'],
    [foreignSprintId, foreignProject.id, 'PLANNED'],
  ])
    await db.query(
      'INSERT INTO sprints(id,project_id,name,goal,starts_on,ends_on,state) VALUES($1,$2,$3,$4,current_date,current_date+14,$5)',
      [sprintId, owner, 'Sprint de priorização', 'Escopo de teste', state],
    );
  return {
    projectId: project.id,
    foreignProjectId: foreignProject.id,
    plannedSprintId,
    activeSprintId,
    foreignSprintId,
  };
}

async function createBacklogTask(projectId: string, title: string, sprintId?: string) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/tasks`,
    headers: headers(adminToken),
    payload: { title, ...(sprintId ? { sprintId } : {}) },
  });
  assert.equal(response.statusCode, 201, response.body);
  return taskSchema.parse(response.json());
}

test('ordenação manual persiste posição, preserva a cauda e bloqueia IDs inválidos ou sem liderança', async () => {
  const fixture = await backlogFixture();
  const first = await createBacklogTask(fixture.projectId, 'Primeira tarefa');
  const second = await createBacklogTask(fixture.projectId, 'Segunda tarefa');
  const third = await createBacklogTask(fixture.projectId, 'Terceira tarefa');
  const foreignTask = await createBacklogTask(fixture.foreignProjectId, 'Tarefa de outro projeto');
  const sprintTask = await createBacklogTask(
    fixture.projectId,
    'Tarefa já planejada',
    fixture.plannedSprintId,
  );

  const reordered = await app.inject({
    method: 'PATCH',
    url: `/api/v1/projects/${fixture.projectId}/backlog/reorder`,
    headers: headers(adminToken),
    payload: { orderedTaskIds: [third.id, first.id] },
  });
  assert.equal(reordered.statusCode, 200, reordered.body);
  assert.deepEqual(reordered.json().orderedTaskIds, [third.id, first.id, second.id]);
  const listed = await app.inject({
    url: `/api/v1/projects/${fixture.projectId}/tasks`,
    headers: headers(adminToken),
  });
  assert.deepEqual(
    z
      .array(taskSchema)
      .parse(listed.json())
      .map((task) => task.id),
    [third.id, first.id, second.id, sprintTask.id],
  );
  const positions = await db.query<{ id: string; backlog_position: number }>(
    'SELECT id,backlog_position FROM tasks WHERE project_id=$1 AND sprint_id IS NULL ORDER BY backlog_position,id',
    [fixture.projectId],
  );
  assert.deepEqual(
    positions.rows.map((task) => [task.id, task.backlog_position]),
    [
      [third.id, 0],
      [first.id, 1],
      [second.id, 2],
    ],
  );
  for (const [orderedTaskIds, status] of [
    [[foreignTask.id], 404],
    [[sprintTask.id], 400],
    [[first.id, first.id], 400],
  ] as const) {
    const rejected = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${fixture.projectId}/backlog/reorder`,
      headers: headers(adminToken),
      payload: { orderedTaskIds },
    });
    assert.equal(rejected.statusCode, status, rejected.body);
  }
  const memberAttempt = await app.inject({
    method: 'PATCH',
    url: `/api/v1/projects/${fixture.projectId}/backlog/reorder`,
    headers: headers(memberToken),
    payload: { orderedTaskIds: [first.id] },
  });
  assert.equal(memberAttempt.statusCode, 403, memberAttempt.body);
  const event = await db.query<{ payload: unknown }>(
    "SELECT payload FROM outbox WHERE payload->>'type'='BacklogReordered' AND payload->>'projectId'=$1",
    [fixture.projectId],
  );
  assert.equal(event.rows.length, 1);
  assert.equal(eventSchema.parse(event.rows[0]?.payload).type, 'BacklogReordered');
  assert.ok(
    (
      await db.query(
        "SELECT id FROM audit_log WHERE action='backlog.reordered' AND resource_id=$1",
        [fixture.projectId],
      )
    ).rowCount,
  );
});

test('pull do backlog move tarefas à sprint planejada e rejeita destino inválido ou tarefa fora do backlog', async () => {
  const fixture = await backlogFixture();
  const first = await createBacklogTask(fixture.projectId, 'Tarefa priorizada um');
  const second = await createBacklogTask(fixture.projectId, 'Tarefa priorizada dois');
  const remaining = await createBacklogTask(fixture.projectId, 'Tarefa restante');
  const foreignTask = await createBacklogTask(fixture.foreignProjectId, 'Tarefa em outro projeto');
  const sprintTask = await createBacklogTask(
    fixture.projectId,
    'Tarefa já em sprint',
    fixture.plannedSprintId,
  );
  for (const [targetSprintId, taskIds, status] of [
    [fixture.activeSprintId, [first.id], 400],
    [fixture.foreignSprintId, [first.id], 404],
    [crypto.randomUUID(), [first.id], 404],
    [fixture.plannedSprintId, [foreignTask.id], 404],
    [fixture.plannedSprintId, [sprintTask.id], 400],
  ] as const) {
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${fixture.projectId}/backlog/pull-to-sprint`,
      headers: headers(adminToken),
      payload: { taskIds, targetSprintId },
    });
    assert.equal(rejected.statusCode, status, rejected.body);
  }
  const pulled = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${fixture.projectId}/backlog/pull-to-sprint`,
    headers: headers(adminToken),
    payload: { taskIds: [first.id, second.id], targetSprintId: fixture.plannedSprintId },
  });
  assert.equal(pulled.statusCode, 200, pulled.body);
  assert.equal(pulled.json().movedCount, 2);
  const records = await db.query<{ sprint_id: string | null; version: number }>(
    'SELECT sprint_id,version FROM tasks WHERE id=ANY($1::uuid[]) ORDER BY id',
    [[first.id, second.id]],
  );
  assert.ok(records.rows.every((task) => task.sprint_id === fixture.plannedSprintId));
  assert.ok(records.rows.every((task) => task.version === 2));
  const activity = await db.query<{ payload: unknown }>(
    "SELECT payload FROM activity_log WHERE project_id=$1 AND action='TaskPulledToSprint'",
    [fixture.projectId],
  );
  assert.deepEqual(
    activity.rows.map((row) => eventSchema.parse(row.payload).type),
    ['TaskPulledToSprint', 'TaskPulledToSprint'],
  );
  assert.ok(
    (
      await db.query(
        "SELECT id FROM audit_log WHERE action='backlog.pulled_to_sprint' AND resource_id=$1",
        [fixture.projectId],
      )
    ).rowCount,
  );
  const outbox = await db.query<{ payload: unknown }>(
    "SELECT payload FROM outbox WHERE payload->>'type'='BacklogPulledToSprint' AND payload->>'projectId'=$1",
    [fixture.projectId],
  );
  assert.equal(eventSchema.parse(outbox.rows[0]?.payload).type, 'BacklogPulledToSprint');
  const remainingList = await app.inject({
    url: `/api/v1/projects/${fixture.projectId}/tasks`,
    headers: headers(adminToken),
  });
  assert.deepEqual(
    z
      .array(taskSchema)
      .parse(remainingList.json())
      .filter((task) => task.sprintId === null)
      .map((task) => task.id),
    [remaining.id],
  );
});

test('memória institucional indexa documentos e isola consultas por projeto', async () => {
  await db.query('UPDATE users SET active=true,is_active=true,deactivated_at=NULL WHERE id=$1', [
    memberId,
  ]);
  const create = async (token: string, title: string, scope: string | null) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/documents',
      headers: headers(token),
      payload: {
        title,
        category: 'ADR',
        content: `arquitetura identidade ${title} informação preservada para consulta`,
        projectId: scope,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().status, 'INDEXED');
    return z.string().uuid().parse(res.json().id);
  };
  const global = await create(adminToken, 'memoria global', null);
  const own = await create(memberToken, 'projeto publico', projectId);
  const secret = await create(adminToken, 'segredo confidencial', otherProjectId);
  const rows = await db.query(
    'SELECT embedding FROM knowledge_chunks WHERE document_id=$1 AND embedding IS NOT NULL',
    [own],
  );
  assert.ok(rows.rowCount);
  for (const action of ['created', 'indexed']) {
    assert.ok(
      (
        await db.query('SELECT id FROM audit_log WHERE resource_id=$1 AND action=$2', [
          own,
          `knowledge.${action}`,
        ])
      ).rowCount,
    );
    assert.ok(
      (
        await db.query(
          "SELECT id FROM outbox WHERE payload->>'documentId'=$1 AND payload->>'action'=$2",
          [own, action],
        )
      ).rowCount,
    );
  }
  for (const scope of [undefined, null]) {
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/knowledge/query',
      headers: headers(memberToken),
      payload: { question: 'arquitetura identidade', projectId: scope },
    });
    assert.equal(result.statusCode, 200, result.body);
    const body = z
      .object({
        answer: z.string().min(1),
        citations: z.array(
          z.object({ documentId: z.string(), score: z.number(), snippet: z.string() }),
        ),
      })
      .parse(result.json());
    assert.ok(body.citations.some((c) => c.documentId === own));
    assert.ok(body.citations.some((c) => c.documentId === global));
    assert.ok(body.citations.every((c) => c.documentId !== secret));
    assert.ok(
      body.citations.every((c, i) => i === 0 || c.score <= (body.citations[i - 1]?.score ?? 0)),
    );
  }
  for (const [method, url, payload] of [
    ['GET', `/api/v1/knowledge/documents?projectId=${otherProjectId}`, undefined],
    [
      'POST',
      '/api/v1/knowledge/query',
      { question: 'arquitetura identidade', projectId: otherProjectId },
    ],
  ] as const) {
    const result = await app.inject({
      method,
      url,
      headers: headers(memberToken),
      ...(payload ? { payload } : {}),
    });
    assert.ok([403, 404].includes(result.statusCode), result.body);
  }
  for (const [method, suffix] of [
    ['POST', '/reindex'],
    ['DELETE', ''],
  ] as const) {
    const denied = await app.inject({
      method,
      url: `/api/v1/knowledge/documents/${secret}${suffix}`,
      headers: headers(memberToken),
    });
    assert.ok([403, 404].includes(denied.statusCode), denied.body);
    const allowed = await app.inject({
      method,
      url: `/api/v1/knowledge/documents/${own}${suffix}`,
      headers: headers(memberToken),
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
  }
});
