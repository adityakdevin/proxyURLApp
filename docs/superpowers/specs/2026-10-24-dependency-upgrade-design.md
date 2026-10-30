# Dependency upgrade to latest: design

Date: 2026-10-24 · Status: draft, awaiting Aditya's approval

## Intent and why

Bring every dependency in the root, `client/` and `server/` workspaces to its newest stable
version that works with the others. Move production to Node 24 LTS. Then keep it that way
automatically.

Why (Aditya's reasons):

- Security warnings. `npm audit` reports 33 high-severity entries, which come from 5 distinct
  advisories (below). A specific CVE-2026 was raised; its ID was not given, but every current
  advisory is fixed by this work.
- A client requirement for current versions.
- Avoid future pain. Dependabot PR #115 (tailwindcss 3 → 4) breaks the client build. Its
  `ui-e2e` CI check failed on 2026-10-13, and the PR sat red for 11 days before being merged
  on 2026-10-24. Production didn't break only because the box's `node_modules` had drifted
  from the lockfile.
- New features in the newer majors.

## Goals

1. Every dependency is at its latest stable version, or at the newest version that works with
   the rest. Anything held back is listed with the reason.
2. `npm audit` shows no high or critical advisories, or each remaining one is listed with why it
   can't be fixed yet.
3. The app behaves the same. The UI looks the same apart from reviewed and accepted
   differences. The validation checks find at least everything they found before.
4. Production runs Node 24 LTS.
5. A future breaking bump fails CI, and `main`'s branch protection blocks the merge.

## Non-goals

- No refactors, renames or cleanups beyond what an upgrade forces.
- No new features. The Phase-1-only rule still applies.
- No change to how the database schema is applied: `npm run db:push`, never `db:migrate`
  (see CLAUDE.md).

## Anti-goals (a failure even if everything builds)

- A real red flag, misspelling, QR finding or missing-document finding that `main` reports on a
  sample claim disappears after the upgrade. A false alarm caused by a misread disappearing is
  fine.
- A new false alarm appears. The 2026-10 client QA round was mostly about removing false flags.
- The deploy appears to succeed while the old build keeps running. The `;`-sequenced deploy line
  restarts the old `dist` when the build fails.
- The proxy (`/view/:opaqueId`, `/proxy/:opaqueId/*`) stops loading target sites or their
  sub-resources.

## Constraints

- Production is a Windows box at `C:\ProxyApp`, supervised by PM2. Aditya deploys by hand with
  `git pull origin main`, then `pm2 stop all; npm ci; npm run deploy; pm2 start all`. The
  scheduled task `ProxyURLApp-PM2` runs `scripts/pm2-boot.bat` at boot.
- `npm run build` runs the client build, then the server build (`&&`). A client failure skips
  the server build.
- The server is CommonJS TypeScript. Jest cannot exercise the ESM dynamic imports in the PDF
  rasterization path, so those are verified with `tsx` scripts (`server/scripts/*.ts`).
- The local DB `proxyapp_db` must never be touched by verification runs. Use the QA databases.
- Version policy: no pre-releases. Prisma 8 is an RC, so Prisma stays on 7.x.

## Decided by Aditya

- Scope: every dependency, plus Node 24 LTS on production.
- One PR.
- Conflicts and pre-releases: take the newest stable version that works with everything else,
  and list what's held back.
- The OCR and validation packages are upgraded too, then compared on real claims:
  - **Lost findings:** Claude checks each one against the page image and marks it a real
    problem or a false alarm. A lost false alarm is fine. A lost real problem blocks the
    responsible package (fix it or hold it back). Aditya approves the triage list before merge.
  - **New findings:** new real problems are welcome. A new false alarm blocks the responsible
    package.
- Branch protection on `main`: the build, API E2E and UI E2E checks are required, for
  everyone including Aditya.
- The client's users run modern, auto-updating Chrome/Edge, so Tailwind 4's browser floor
  (Chrome 111+, Safari 16.4+, Firefox 128+) is acceptable.
- UI check: Claude compares before and after screenshots, then Aditya clicks through before
  merging.
- Client QA (2026-10 round) is finished. Ship as soon as the checks pass.
- Staying current: a Dependabot config, plus a CI build gate.

## Inventory (2026-10-24)

From `npm outdated`: 61 packages behind, about 40 of them a major version behind.

| Group | Majors |
|---|---|
| Frontend | tailwindcss 3→4, tailwind-merge 2→3, react / react-dom 18→19 (+ types), react-pdf 9→11, zustand 4→5, @tanstack/react-table 8→9, lucide-react 0.309→1.x, vite 7→8, @vitejs/plugin-react 4→6, eslint-plugin-react-hooks 4→7, eslint-plugin-react-refresh 0.4→0.5 |
| Server | express 4→5 (+ types), helmet 7→8, dotenv 16→18, @prisma/client + prisma 5→7, exceljs 3→4, supertest 6→7 (+ types), @types/bcrypt 6 |
| Tooling | typescript 5→7, eslint 8→10, jest 29→30 (+ types), @types/node 20→(see calls) |
| OCR / validation | tesseract.js 5→7, pdfjs-dist 4→6 (server and client), pdf-parse 1→2, @napi-rs/canvas 0.1→1.0, dictionary-en 3→4 |
| Minor / patch | Radix UI packages, typescript-eslint, multer, playwright, tsx, ts-jest, postcss, autoprefixer, react-router-dom, zxing-wasm |

Advisories from `npm audit`:

1. zod below 4.6.6: memory exhaustion (GHSA-mrhx-c7xc-m3w5). It comes through jimp 1.6.1, which
   is already the latest jimp and still pins zod 3.25.76. This one advisory accounts for 28 of
   the 33 entries. npm's suggested fix, downgrading jimp to 0.22, is wrong: the code uses the
   jimp 1.x API.
2. body-parser below 1.20.9: denial of service (GHSA-27r3-jxmh-p828), through Express 4.
3. follow-redirects 1.16.0: credential headers leak across origins (GHSA-q3jh-wrc6-jgq8,
   GHSA-8r9p-f939-6h3c), through http-proxy-middleware → http-proxy.
4. multer 2.0.0–2.4.0: denial of service (GHSA-q7qp-rjg7-q26m).
5. vite 7.0.0–7.3.6: several advisories, including cross-origin script execution and command
   execution on Windows (GHSA-9jrq-w75r-8gcw and others).

## Known hotspots (found during recon; not exhaustive)

- **Express 5 route syntax:** `server/src/app.ts:75` uses `app.get('*', …)`.
  `server/src/routes/proxy.ts:860` uses `router.all('/:opaqueId/*', …)` and is the main proxy
  handler. Both wildcards need the path-to-regexp v8 syntax.
- **http-proxy-middleware:** declared in `server/package.json` but imported nowhere. Remove it.
  Advisory 3 goes away with it.
- **jimp / zod:** used by `server/src/lib/ocr.ts`, `server/src/validators/qrValidator.ts` and
  `server/scripts/scan-qr.ts`. Force zod 4.6.6 or newer with npm `overrides`, then check that
  jimp still reads, resizes and thresholds images.
- **Prisma 5 → 7:** `server/prisma/schema.prisma` uses `prisma-client-js` with
  `previewFeatures = ["omitApi"]` and `url = env("DATABASE_URL")`. Prisma 7 changes generator,
  config and connection setup. The `server/prisma/*.ts` scripts load dotenv before constructing
  the client. `db push` must keep working from both the root and `server/`.
  - Production's database is WAMP **MySQL 5.7.40 on :3306**. Sources: the `backup-db.js`
    header, and the box's `boot.log`, which shows `MySQL database "proxyapp_db" at
    "localhost:3306"`. The MySQL 8.0 on :3307 in `docs/DEPLOYMENT.md` is stale.
  - Prisma 7 officially supports MySQL 5.6 and later. It connects through
    `@prisma/adapter-mariadb`, whose defaults differ from Prisma 5's built-in engine.
- **pdf-parse 1 → 2:** `server/src/validators/metaValidator.ts`.
- **dictionary-en 3 → 4:** `server/src/validators/dictionary.ts` and
  `server/scripts/spell-check.ts`. The word list may change, which shifts SPELL findings. The OCR
  comparison covers this.
- **pdfjs-dist + @napi-rs/canvas:** server rasterization in `server/src/lib/pdfExtractor.ts`.
  On the client, react-pdf pins its own pdfjs-dist; the client's pdfjs-dist version and worker
  must match react-pdf's.
- **tesseract.js 5 → 7:** `server/src/lib/ocr.ts`. The `errorHandler` added in #117 must
  survive, and `server/scripts/ocr-bad-file.ts` must still pass. The cached language data
  (`OCR_CACHE_DIR`, `server/eng.traineddata`) must still load.
- **exceljs 3 → 4:** `server/src/services/observationImportService.ts` and
  `server/src/services/claimReportService.ts`. Import and export of real sheets
  (`docs/samples/observation-import-template.xlsx`) must round-trip.
- **helmet 7 → 8:** `server/src/app.ts`. Default headers must not break the full-page iframe at
  `/view/:opaqueId` or proxied content.
- **dotenv 16 → 18:** `server/prisma/*.ts` and `server/scripts/backup-db.js`. The backup job
  runs nightly under PM2.
- **ESLint 8 → 10:** `client/.eslintrc.cjs` and `server/.eslintrc.cjs` must become flat config.
- **Tailwind 4:** `client/postcss.config.js`, `client/tailwind.config.js` (shadcn theme,
  `darkMode: ["class"]`, container), `client/src/index.css` (`@tailwind` directives and 2
  `@apply`), and tailwindcss-animate.
- **React 19 family:** `client/src/stores/authStore.ts` (zustand `persist`),
  `client/src/components/shared/DataTable.tsx` plus the admin pages that use react-table,
  `client/src/components/claims/DocumentViewer.tsx` (react-pdf), and lucide-react imports in
  38 files.
- **CI:** `.github/workflows/e2e.yml` runs on `pull_request` with Node 20 and MySQL 8.0. It
  runs API and UI end-to-end tests but never `npm run build`. Its `ui-e2e` check did catch
  #115. `main` has no branch protection, so a red check doesn't block a merge.

## Verification

All of it must pass before the PR is handed to Aditya to merge.

1. **Build and tests:** `npm ci` from a clean checkout, then `npm run build`, `npm run lint`,
   `npm run test`, `npm run test:e2e:api` and the UI smoke test, all on Node 24.
   - Run `npm run db:push` and the API E2E suite against **MySQL 5.7** as well as 8.0, since
     5.7 is what production runs.
   - Run `db push` against a schema-only dump of production as a dry run before deploy.
2. **OCR comparison:** run validation on the same claims with `main` as it was before this work
   and with the upgraded branch, then diff every finding per claim and per check.
   - Claims: the ~570 samples in `docs/samples/spelling-checks/`, plus
     `docs/samples/forgery-samples/` and `docs/samples/Claims/`.
   - Setup: the two-stack approach from the 2026-10 client QA (separate QA databases, never
     `proxyapp_db`).
   - List every finding that disappeared and every finding that is new.
   - Triage each one against the page image as a real problem or a false alarm.
   - Pass means no real problem was lost and no false alarm was added. Otherwise, the
     responsible package is fixed or held back before handover.
   - Aditya approves the triage list.
3. **Scripts:** `server/scripts/ocr-bad-file.ts`, plus a spot run of `spell-check.ts` and
   `scan-qr.ts`.
4. **UI:** take Playwright screenshots of every page, before and after, and show the
   differences.
   - Pages: login, user dashboard and menu, the admin CRUD pages, the claims list, claim detail,
     the document viewer and `/view/:opaqueId`.
   - After Aditya reviews the screenshots, Aditya clicks through.
5. **Proxy:** load a configured URL through `/view/:opaqueId`, including its sub-resources
   (HTML, CSS, JS rewriting), and exercise the non-GET methods.
6. **Audit:** `npm audit` shows no high or critical advisories, or the leftovers are listed.

## Rollout

- One PR, one commit per group, in this order: minor/patch, tooling, server, frontend, OCR and
  validation, CI and Dependabot. `git bisect` can then name the group that broke something.
- The PR stays unmerged until verification is complete. Aditya merges it.
- Production order:
  1. Install Node 24 on the box (exact PowerShell steps go in the PR).
  2. `git pull origin main`.
  3. A real `npm ci`. The box drifted before: lockfile tailwind 4.3.3, installed 3.4.19.
  4. `npm run deploy`, then `pm2 start all`.
  5. Prove the deploy with a compiled marker (`Select-String` on `server\dist`) and file
     `LastWriteTime`s, not "it loads".
- Rollback: check out the previous `main` commit, then `npm ci` and deploy. Keep the Node 20
  installer on the box until the new build has run for a week.

## Staying current

- `.github/dependabot.yml` covers npm for the root, `client/` and `server/`, plus GitHub Actions.
  It checks weekly. Minor and patch updates are grouped per directory; each major gets its own
  PR.
- CI gets a job that runs `npm ci` and `npm run build` (plus lint) on every pull request. It
  runs on `windows-latest`, the same OS as production (free, since the repo is public), with
  the same Node major as production. A bump that breaks the build fails before merge.
- Branch protection on `main` requires the build, `api-e2e` and `ui-e2e` checks, including for
  admins. CI job names must stay stable, because the protection rule refers to them by name.
  Protection is a repo setting, not code, so it's applied with `gh api` once the new build job
  has run at least once. Applying it needs Aditya's go-ahead at that moment.

## Held back

As of 2026-10-30. Everything else is at its latest stable version.

| Package | Kept | Latest | Reason |
|---|---|---|---|
| `typescript` (both workspaces) | `~6.0.3` | 7.0.2 | `typescript-eslint` peers `<6.1.0` and `ts-jest` peers `<7`. The tilde keeps a 6.1 that typescript-eslint doesn't support out. |
| `prisma`, `@prisma/client` | 7.10.1 | 8.0.0-rc.29 | 8 is a release candidate; the policy is latest stable. |
| `pdfjs-dist` (client) | exactly 6.3.289 | 6.4.299 | react-pdf 11.0.0 pins it. The server's copy is 6.4.299. |
| `@types/node` | `^24` (24.19.2) | 26.6.6 | It follows the runtime, Node 24. |
| `@types/express-serve-static-core` | 5.0.7 | 5.1.3 | 5.1 types every `req.params` value as `string \| string[]`, which fails the server typecheck on the `req.params` reads across 18 route files. Runtime is unaffected. Lift it together with typed route params. |
| `@napi-rs/canvas` | 1.0.11 | 1.1.0 | See below. |

`@napi-rs/canvas`: 1.0.12 changed how patterns are sampled (Brooooooklyn/canvas#1357), which
changes the raster of scanned pages, so OCR reads them differently. On the QA set that dropped
real findings (a duplicate address across two claims, a Missing Bill) and added false ones
(Missing Invoice, an impossible date read off an amount). No `imageSmoothingQuality` value
restores the old raster: `high` fixed those pages and dropped duplicate policy and vehicle
numbers on others. 1.0.11 rasterizes byte-identical to 0.1.100 on the affected pages,
satisfies pdfjs-dist's `^1.0.10`, and the full re-validation with it matches the baseline
exactly (0 lost, 0 new, 0 status changes). Lift the hold only with an OCR before/after
comparison.

Not holds, but listed as outdated by `npm outdated`: the `lightningcss-*` binaries are pinned
at 1.32.0 because `@tailwindcss/node` requires exactly that version; vite's own nested 1.33.0
carries its own binaries in the lockfile.

`npm audit`: 0 advisories in production dependencies. The dev tree has one low advisory,
GHSA-gcqx-w48m-w2h4 (deepmerge, via jest-config), which has no patched deepmerge; npm's only
offer is a downgrade to jest 25.

## Left to the builder

- Exact versions within the policy above, migration mechanics for each package, and commit
  contents within each group.
- How the OCR comparison is scripted and how the findings diff is presented.
- How screenshots are captured and compared.

## Calls Claude made (not discussed with Aditya; open to correction)

- One commit per group inside the single PR.
- Remove `http-proxy-middleware` rather than upgrade it, since nothing imports it.
- Fix the zod advisory with an npm `overrides` entry. If jimp breaks on zod 4, stop and ask
  Aditya before holding it back, because that leaves a known high advisory in place.
- `@types/node` follows the runtime major (24), not the latest 26, so the types don't offer
  APIs production lacks.
- New lint rules that arrive with ESLint 10 or eslint-plugin-react-hooks 7 stay off. The PR
  lists them instead of rewriting code to satisfy them, since rewriting would be scope creep.
- The OCR comparison uses the same claim set the client QA was verified on.
- The Prisma 7 MariaDB adapter is configured to match Prisma 5's connection behaviour: 5s
  connect timeout, 300s idle timeout, and a pool sized like the old default. Production then
  behaves the same under load.
- The CI build job runs on `windows-latest`.
- `docs/DEPLOYMENT.md`'s stale MySQL 8.0 / :3307 note is out of scope here, so it gets a
  one-line TODO, not a rewrite.
