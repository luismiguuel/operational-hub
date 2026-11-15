import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canReadProject, canManageProject, assertOwnTask, assertManage } from '../core/policy.js';
import { taskInput, profileInput, sprintInput } from '@hub/shared';
const member = { id: crypto.randomUUID(), role: 'MEMBER' as const },
  leader = { id: crypto.randomUUID(), role: 'LEADER' as const },
  admin = { id: crypto.randomUUID(), role: 'ADMIN' as const };
test('papel de sistema e vínculo contextual são independentes', () => {
  assert.equal(canReadProject(leader, null), false);
  assert.equal(canManageProject(leader, 'MEMBER'), false);
  assert.equal(canManageProject(member, 'LEADER'), false);
  assert.equal(canManageProject(leader, 'LEADER'), true);
  assert.equal(canManageProject(admin, null), true);
  assert.throws(() => assertManage(leader, null), /Projeto não encontrado/);
});
test('membro altera card próprio, mas não card atribuído a terceiro', () => {
  assert.doesNotThrow(() =>
    assertOwnTask(member, 'MEMBER', { assigneeId: member.id, createdBy: leader.id }),
  );
  assert.throws(
    () => assertOwnTask(member, 'MEMBER', { assigneeId: leader.id, createdBy: member.id }),
    /próprios cards/,
  );
  assert.throws(
    () => assertOwnTask(member, null, { assigneeId: member.id, createdBy: member.id }),
    /Projeto não encontrado/,
  );
});
test('contratos rejeitam pontos arbitrários, campos extras e links executáveis', () => {
  assert.equal(taskInput.safeParse({ title: 'Tarefa', points: 4 }).success, false);
  assert.equal(
    taskInput.safeParse({ title: 'Tarefa', projectId: crypto.randomUUID() }).success,
    false,
  );
  assert.equal(
    taskInput.safeParse({ title: 'Tarefa', links: ['javascript:alert(1)'] }).success,
    false,
  );
  assert.equal(
    taskInput.safeParse({ title: 'Tarefa', links: ['https://github.com/ej/repo'] }).success,
    true,
  );
});
test('valida compatibilidade da subárea e sequência temporal', () => {
  assert.equal(
    profileInput.safeParse({
      name: 'Pessoa',
      email: 'p@example.org',
      role: 'MEMBER',
      area: 'Tech',
      subarea: 'Marketing',
      title: 'Dev',
      weeklyHours: 16,
    }).success,
    false,
  );
  assert.equal(
    sprintInput.safeParse({
      name: 'Ciclo',
      goal: 'Entregar valor',
      startsOn: '2026-11-20',
      endsOn: '2026-11-10',
    }).success,
    false,
  );
});
