import { chromium, type FullConfig } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * Sign in once through the real login form and persist browser storage (session
 * cookie + the zustand `auth-storage` localStorage entry) so every spec starts
 * authenticated. ProtectedRoute keys off the persisted authStore, so API-only
 * login is NOT sufficient — we drive the actual form.
 *
 * The admin must exist in the target (test) DB with forcePasswordChange=false —
 * `npm run db:seed:e2e` creates exactly that. `test:e2e:ui` runs it first.
 */
const ADMIN_USER = process.env.E2E_ADMIN_USERNAME || 'e2e_admin';
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD || 'E2eAdmin#2026';

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const baseURL = process.env.E2E_BASE_URL || 'http://localhost:5173';
  const authFile = path.join(__dirname, '.auth', 'admin.json');
  fs.mkdirSync(path.dirname(authFile), { recursive: true });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL });
    await page.goto('/login');
    await page.fill('#username', ADMIN_USER);
    await page.fill('#password', ADMIN_PASS);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });

    const pathname = new URL(page.url()).pathname;
    if (pathname.startsWith('/change-password')) {
      throw new Error(
        `UI E2E: "${ADMIN_USER}" was redirected to /change-password (forcePasswordChange=true). ` +
          'Run `npm run db:seed:e2e` against the test DB so the admin does not require a password change.'
      );
    }
    await page.context().storageState({ path: authFile });
  } finally {
    await browser.close();
  }
}
