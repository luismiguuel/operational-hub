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
} from '@hub/shared';
import { schema } from '../scripts/schema.js';
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
  for (const [area, subareas] of Object.entries(areas))
    await db.query('INSERT INTO areas VALUES($1,$2)', [area, JSON.stringify(subareas)]);
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
