import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4180',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 960 } },
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: '../../node_modules/.bin/tsx e2e/portalApiServer.ts',
      url: 'http://127.0.0.1:4181/health',
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev -- --port 4180',
      url: 'http://127.0.0.1:4180',
      env: { PORTAL_API_TARGET: 'http://127.0.0.1:4181' },
      reuseExistingServer: false,
    },
  ],
});
