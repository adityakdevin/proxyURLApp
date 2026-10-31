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

/**
 * The shared DataTable backs every admin list. A heading proves the page mounted, not
 * that the table rendered rows, so assert one row and the pager on each of its two
 * paths: server pagination (Projects) and client pagination (Sessions). A fresh CI
 * database holds only the E2E admin, whom the Users list leaves out, so the server path
 * creates a project for itself; global-setup's login is already an active session.
 */
test.describe('DataTable smoke', () => {
  for (const [path, mode] of [
    ['/admin/projects', 'server'],
    ['/admin/sessions', 'client'],
  ] as const) {
    test(`renders rows and the pager with ${mode} pagination (${path})`, async ({ page }) => {
      let projectId: string | undefined;
      if (mode === 'server') {
        const res = await page.request.post('/api/admin/projects', {
          data: { name: `E2E smoke ${Date.now()}` },
        });
        expect(res.status()).toBe(201);
        projectId = (await res.json()).id;
      }
      try {
        await page.goto(path);
        // The pager reads "of 0" until rows arrive, so it goes first: only then do the absent
        // placeholders ("Loading...", "No results.", rows too) prove row 1 is data. Not the
        // created project's row: on a reused test DB it need not be on page 1.
        await expect(page.getByText(/^Page 1 of [1-9]\d*$/)).toBeVisible();
        await expect(page.getByText('Loading...')).toHaveCount(0);
        await expect(page.getByText('No results.')).toHaveCount(0);
        await expect(page.getByRole('row').nth(1)).toBeVisible();
      } finally {
        if (projectId) await page.request.delete(`/api/admin/projects/${projectId}`);
      }
    });
  }
});

/**
 * pdf.js 5+ decodes JPEG 2000 and JBIG2 images (most office scans) with wasm it fetches
 * from DocumentViewer's `wasmUrl`, '/pdfjs-wasm/', which vite.config.ts copies there.
 * The SPA fallback answers any missing path with index.html and a 200, so check the bytes.
 */
// Value: protects=the PDF viewer's JBIG2 and JPEG 2000 decoders are served where DocumentViewer looks; fails_when=the static-copy target or the wasmUrl path drifts and scanned pages render blank; why_new=build and smoke never fetch them; seam=none; no_claim=decoding a real scan, the production dist
test('serves the pdf.js image decoders the document viewer loads', async ({ request }) => {
  for (const file of ['jbig2.wasm', 'openjpeg.wasm']) {
    const res = await request.get(`/pdfjs-wasm/${file}`);
    expect(res.status(), file).toBe(200);
    // Every wasm module starts with "\0asm".
    expect((await res.body()).subarray(0, 4).toString('latin1'), file).toBe('\0asm');
  }
});

/**
 * A heading proves React mounted, not that Tailwind 4 compiled. The Sign in button has no
 * colour or cursor of its own: bg-primary comes from index.css's @theme tokens, and the
 * pointer from its compat rule (v4 Preflight gave buttons the default cursor). Compared with
 * --primary as the page resolves it, so retheming does not break this. Signed out, because
 * /login is the one page every user sees.
 */
test.describe('Tailwind 4 styles', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // Value: protects=Tailwind 4 compiles the theme colours and the v3 pointer cursor onto the UI's buttons; fails_when=the Tailwind Vite plugin, the @theme tokens or the cursor compat rule is dropped; why_new=the boot smoke only proves React mounted; seam=none; no_claim=pixel parity, dialogs, space-y gaps, placeholders
  test('a primary button gets the theme colour and the pointer cursor', async ({ page }) => {
    await page.goto('/login');
    const signIn = page.getByRole('button', { name: 'Sign in' });
    await expect(signIn).toBeEnabled();
    const primary = await page.evaluate(() => {
      const probe = document.createElement('i');
      probe.style.color = 'hsl(var(--primary))';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(signIn).toHaveCSS('background-color', primary);
    await expect(signIn).toHaveCSS('cursor', 'pointer');
  });
});
