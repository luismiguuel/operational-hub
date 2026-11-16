import { test, expect } from '@playwright/test';
test('autenticação, navegação responsiva e abertura de card', async ({ page }, info) => {
  const email = process.env['SEED_ADMIN_EMAIL'],
    password = process.env['SEED_ADMIN_PASSWORD'];
  test.skip(
    !email || !password || process.env['SEED_DEMO'] !== 'true',
    'Requer seed de demonstração explícito.',
  );
  await page.goto('/');
  await page.getByLabel('E-mail institucional').fill(email ?? '');
  await page.getByLabel('Senha', { exact: true }).fill(password ?? '');
  await page.getByRole('button', { name: 'Acessar meu workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Portal do cliente', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Kanban' })).toHaveAttribute('aria-selected', 'true');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: `/tmp/citi-hub-${info.project.name}.png`, fullPage: true });
  if (info.project.name === 'desktop') {
    const source = await page
      .locator('.task-card')
      .filter({ hasText: 'Mapear a jornada do cliente' })
      .locator('.task-code')
      .boundingBox();
    const target = await page
      .locator('.kanban-column[aria-label="Em Andamento"] .column-heading')
      .boundingBox();
    expect(source).toBeTruthy();
    expect(target).toBeTruthy();
    if (source && target) {
      const moved = page.waitForResponse(
        (response) => response.request().method() === 'PATCH' && response.url().includes('/tasks/'),
      );
      await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
      await page.mouse.down();
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {
        steps: 20,
      });
      await page.mouse.up();
      expect((await moved).status()).toBe(200);
      await page.reload();
      await expect(
        page.getByRole('heading', { name: 'Portal do cliente', exact: true }),
      ).toBeVisible();
    }
  }
  await page.getByRole('button', { name: 'Mapear a jornada do cliente', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue(
    info.project.name === 'desktop' ? 'IN_PROGRESS' : 'TODO',
  );
  if (info.project.name === 'desktop') {
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('TODO');
    await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue('TODO');
  }
  await page.getByRole('button', { name: 'Fechar', exact: true }).click();
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await page.getByRole('button', { name: 'Mapa de alocação', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mapa de alocação' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: 'Abrir navegação' }).click();
  await page.getByRole('button', { name: 'Sair da conta' }).click();
  await expect(page.getByRole('heading', { name: 'Vamos construir juntos.' })).toBeVisible();
});
