import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import argon2 from 'argon2';
import { z } from 'zod';
import {
  areas,
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
