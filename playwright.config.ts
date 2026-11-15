import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
export default defineConfig({
  testDir: './tests',
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  use: { baseURL: 'http://localhost:5173', trace: 'off' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: [
    {
      command: 'npx --yes pnpm@10 --filter @hub/api dev',
      url: `http://localhost:${process.env['PORT'] ?? '3001'}/api/v1/health`,
      reuseExistingServer: !process.env['CI'],
      timeout: 30000,
    },
    {
      command: 'npx --yes pnpm@10 --filter @hub/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env['CI'],
      timeout: 30000,
    },
  ],
});
