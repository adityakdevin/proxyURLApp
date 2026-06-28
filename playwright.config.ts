import { defineConfig, devices } from '@playwright/test';
import path from 'path';

/**
 * Playwright config for the browser-level claim E2E smoke journeys.
 *
 * Auth is established once in e2e/global-setup.ts (real form login → cookie +
 * zustand localStorage) and reused via storageState. The app's ProtectedRoute
 * keys off the persisted authStore, so API-only login is NOT sufficient — we
 * must drive the actual login form.
 *
 * DB: point the dev server at a disposable schema by exporting E2E_DATABASE_URL.
 * It is injected into the spawned server's env and (because dotenv never
 * overrides an already-set var) wins over server/.env.
 */
const ROOT = __dirname;
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';
const E2E_DB = process.env.E2E_DATABASE_URL || process.env.TEST_DATABASE_URL;

const webServerEnv: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: '3001',
  CLIENT_URL: BASE_URL,
};
if (E2E_DB) {
  webServerEnv.DATABASE_URL = E2E_DB;
} else {
  // eslint-disable-next-line no-console
  console.warn(
    '[playwright] E2E_DATABASE_URL not set — the dev server will use server/.env (likely the DEV DB). ' +
      'Export E2E_DATABASE_URL to a disposable test schema for isolated UI E2E.'
  );
}

export default defineConfig({
  testDir: path.join(ROOT, 'e2e'),
  testMatch: '**/*.spec.ts',
  globalSetup: path.join(ROOT, 'e2e', 'global-setup.ts'),
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    storageState: path.join(ROOT, 'e2e', '.auth', 'admin.json'),
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    cwd: ROOT,
    url: BASE_URL,
    // Always start a fresh stack bound to the TEST DB. Reusing an already-running
    // dev server would silently point the suite at the dev DB. Stop `npm run dev`
    // (free :5173 / :3001) before running the UI suite.
    reuseExistingServer: false,
    timeout: 120_000,
    env: webServerEnv,
  },
});
