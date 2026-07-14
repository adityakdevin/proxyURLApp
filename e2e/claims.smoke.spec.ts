import { test, expect } from '@playwright/test';

/**
 * Browser-level smoke journeys. Deep behavior (RBAC, validation, import/export)
 * is covered by the API E2E suite; here we prove auth + routing + that the claim
 * screens actually render in the real client, using the admin storageState from
 * global-setup. Headings are the real ones from AdminClaims / ClaimDashboard.
 */
test.describe('Claims UI smoke', () => {
  test('admin opens the Admin Claims screen', async ({ page }) => {
    await page.goto('/admin/claims');
    await expect(page).toHaveURL(/\/admin\/claims/);
    await expect(page.getByRole('heading', { name: 'Claims Dashboard' })).toBeVisible();
  });

  test('claim dashboard renders for the authenticated session', async ({ page }) => {
    await page.goto('/claims');
    await expect(page).not.toHaveURL(/\/login|\/change-password/);
    await expect(page.getByRole('heading', { name: 'Claim Dashboard' })).toBeVisible();
  });
});
