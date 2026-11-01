# Dependency upgrade to latest: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every dependency in root, `client/` and `server/` at its newest stable version that works with the rest, production on Node 24 LTS, and CI plus branch protection that stop a breaking bump before merge.

**Architecture:** One branch (`chore/deps-latest`), one PR, one commit per upgrade group in the spec's order. The server and frontend groups are each split into two commits (see Plan-level calls). Each upgrade that changes behaviour gets a characterization test first: written against the old version, passing there, then kept passing on the new one. App behaviour is proven by three before/after comparisons, all run against cloned QA databases: validation findings on ~600 sample claims, Playwright screenshots, and proxy request statuses.

**Tech Stack:** npm 11 workspaces, Node 24, TypeScript 6.0, Express 5, Prisma 7 + `@prisma/adapter-mariadb`, React 19, Vite 8, Tailwind 4, Jest 30, ESLint 10 flat config, Playwright, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-24-dependency-upgrade-design.md` (approved 2026-10-24). Read it before starting. Its anti-goals and verification list are binding.

## Global Constraints

- Version policy: latest stable, no pre-releases. Held back, with the reason recorded in the spec's "Held back" section:
  - `typescript` 6.0.3, not 7.0.2: `typescript-eslint` peers `<6.1.0` and `ts-jest` peers `<7`.
  - `prisma` / `@prisma/client` 7.10.1, not 8.0.0-rc.
  - Client `pdfjs-dist` exactly `6.3.289`, not 6.4.299: react-pdf 11.0.0 pins it.
  - `@types/node` `^24`, not 26: it follows the runtime.
- Target versions (caret unless noted):
  - Both workspaces: `typescript` `~6.0.3` (tilde, so a 6.1 that typescript-eslint doesn't support isn't picked up).
  - Root: `@playwright/test` 1.64.1, `concurrently` 10.0.6.
  - Client: react / react-dom 19.3.1, `@types/react` / `@types/react-dom` 19.3.0, react-pdf 11.0.0, zustand 5.0.16, `@tanstack/react-table` 9.3.1, lucide-react 1.61.0, tailwindcss 4.3.3, `@tailwindcss/vite` 4.3.3, tailwind-merge 3.7.0, vite 8.3.5, `@vitejs/plugin-react` 6.1.2, eslint 10.13.0, `@eslint/js` 10.0.1, globals 17.13.0, `typescript-eslint` 8.72.0, eslint-plugin-react-hooks 7.1.1, eslint-plugin-react-refresh 0.5.7, react-router-dom 7.18.4, plus the Radix minors.
  - Server: express 5.3.0, `@types/express` 5.0.6, helmet 8.3.0, dotenv 18.0.9, `@prisma/adapter-mariadb` 7.10.1, exceljs 4.4.0, supertest 7.3.1, `@types/supertest` 7.2.1, `@types/bcrypt` 6.0.0, jest 30.5.2, `@types/jest` 30.0.0, ts-jest 29.4.15, tsx 4.23.15, tesseract.js 7.0.0, server pdfjs-dist 6.4.299, `@napi-rs/canvas` 1.0.13, pdf-parse 2.4.5, dictionary-en 4.0.0, multer 2.5.0, playwright 1.64.1, zxing-wasm 3.1.6.
  - Removed: `http-proxy-middleware`, `@types/pdf-parse`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin` (replaced by `typescript-eslint`), client `postcss` and `autoprefixer`.
- Run everything on Node 24 (`nvm install 24`, currently 24.22.1). The local default is Node 26; don't use it for verification.
- **Never connect to `proxyapp_db`.** `server/.env` points `DATABASE_URL` at it, and dotenv never overrides a variable that's already set. Every shell that runs server, Prisma or seed commands must `source /tmp/upg/env.sh` (Task 0), which sets `DATABASE_URL` to a QA database. The only other databases used are `proxyapp_test` (the existing E2E database) and the `proxyapp_upg_*` clones.
- Schema changes are applied with `db push`, never `db:migrate`.
- Commits: the sandbox can't GPG-sign, and `commit.gpgsign=true`, so never commit unsigned. Stage the files, write the message to `.git/UPG_MSG_<task>`, and hand Aditya one line to run: `! git commit -F .git/UPG_MSG_<task>`. Don't push until Task 11.
- npm 11 install scripts: after any install, approve blocked scripts with `npm install-scripts approve <pkg>` (never hand-edit `allowScripts`). Approve only new versions of packages already approved, plus `prisma`, `@prisma/engines`, `esbuild` and `fsevents`. Delete keys whose version is no longer in the lockfile (`canvas@3.2.3` goes away in Task 5). `tesseract.js` stays `false`.
- The lockfile is generated on macOS. Every native package needs its `win32-x64` and `linux-x64` binaries listed in root `optionalDependencies`, at the exact version the tree uses (see the existing `//optionalDependencies` note).
- Lint result must stay at **0 errors** (baseline on `main`: 0 errors, 21 warnings). Rules that ESLint 10 or eslint-plugin-react-hooks 7 newly enable stay off. Each one is turned off by name with a `// new in <pkg> <ver>, off per upgrade design` comment and listed in the PR body.
- No refactors, renames or new features beyond what an upgrade forces (spec non-goals).

## Review Focus

These are failure modes the spec implies but no ordinary test catches, most likely first. Each has its pinning test or check in the task named.

1. **Express 5 runs the `listen` callback on bind errors.** If port 3001 is taken (the orphan-process incident in `ecosystem.config.js`), Express 5 logs "Server running" and calls `runStartupSweeps()`. That re-queues claims the live orphan is still processing. Expected: no success line, no sweep, the EADDRINUSE message, and the process exits. Pinned by the port-collision check in Task 3.
2. **Prisma 7 stops loading `server/.env`.** Prisma 5 loaded it as a side effect of importing `@prisma/client`, and that's how the server gets `SESSION_SECRET`, `CLIENT_URL`, `CLAIMS_SCAN_ROOT` and the rest. Expected: the same variables are present at boot. Pinned by the `env -i` check in Task 4.
3. **Express 5 proxy wildcard.** An empty sub-path, a trailing slash, an encoded segment and `_ext/` URLs must reach the target exactly as they did on Express 4. Pinned by `proxySubPath.test.ts` in Task 3, which is written and passing on Express 4 first.
4. **Express 5 leaves `req.body` undefined for requests without a JSON body.** For example, `PUT /api/admin/settings` with an empty body destructures `undefined` and returns 500. Expected: 200, as today. Pinned by `upgradeCompat.e2e.test.ts` in Task 3.
5. **Production-only paths that dev and tests never run:**
   - The `NODE_ENV=production` SPA fallback route. Express 5 throws at registration on the old `'*'` syntax, which means a crash loop at boot.
   - Windows native binaries missing from the macOS lockfile.
   - The MariaDB adapter on MySQL 5.7, and on MySQL 8+ with `caching_sha2_password`.
   - The PM2 daemon still running the old Node after the MSI upgrade.

   Pinned by:
   - the production-mode checks in Tasks 3 and 9;
   - `prisma.test.ts` in Task 4;
   - the `windows-latest` build job and the MySQL 5.7 `api-e2e` job in Task 8;
   - `pm2 describe` in the deploy steps (Task 11).

## Plan-level calls (not in the spec; for Aditya to check)

- **Keep the `prisma-client-js` generator on Prisma 7.** It's deprecated but still shipped in 7. Moving to `prisma-client` would rewrite the `@prisma/client` import in 74 files, and the spec forbids refactors an upgrade doesn't force. It moves with Prisma 8.
- **Shared Prisma factory.** All 14 `new PrismaClient()` sites now need an adapter, so they all go through one small factory, `server/src/lib/prisma.ts`, instead of 14 copies of the pool settings.
- **Pool settings.** The adapter honours a `connection_limit` URL parameter, like Prisma 5 did. Any other URL parameter is logged as ignored. `allowPublicKeyRetrieval: true` is on because every database is on the same host, and MySQL 8+ `caching_sha2_password` over non-TLS needs it.
- **Two commits each for the server and frontend groups,** so `git bisect` is finer:
  - server: Express/helmet/dotenv, then Prisma;
  - frontend: React family, then Tailwind/Vite.
- **CI `api-e2e` moves to MySQL 5.7** (production's version) and `ui-e2e` stays on 8.0. Both versions are covered without renaming any required check.
- **`dependabot.yml` has one npm entry at `/`.** Dependabot updates all three workspaces from the root lockfile. Separate entries for `/client` and `/server` would raise duplicate PRs. As a result, minor and patch updates are grouped repo-wide, not per directory.
- **Helmet 8's HSTS `max-age`** of 31536000 (up from 15552000) is accepted. Browsers ignore HSTS over plain HTTP, which is how the box is reached.
- **The OCR comparison and screenshot tooling** live in `/tmp/upg` and aren't committed. The spec leaves this to the builder, and nothing in the app needs them.
- **Production dry run.** Instead of a schema-only dump, the dry run is `prisma migrate diff --from-config-datasource --to-schema` on the box against the live database. It reads only, and shows the exact SQL `db push` would run. There's no Docker locally to host a MySQL 5.7 copy.

---

### Task 0: Baseline environment and "before" captures (no commit)

**Files:**
- Create (outside repo): `/tmp/upg/env.sh`, `/tmp/upg/findings.sql`, `/tmp/upg/statuses.sql`, worktree `/tmp/upg/before`

**Interfaces:**
- Produces:
  - `/tmp/upg/env.sh`, which every later task sources.
  - Databases `proxyapp_upg_before`, `proxyapp_upg_after` and `proxyapp_upg_ui`.
  - `/tmp/upg/before-findings.tsv` and `/tmp/upg/before-statuses.tsv`.
  - The before stack in `/tmp/upg/before`, built the way production runs it today.

- [ ] **Step 1: Write `/tmp/upg/env.sh`**

```sh
source ~/.nvm/nvm.sh >/dev/null && nvm use 24 >/dev/null
export REPO=/Users/adityakdevin/Projects/exceledunet/proxyURLApp
export QA_BASE=$(grep '^DATABASE_URL=' "$REPO/server/.env" | cut -d'"' -f2 | sed 's#/[^/]*$##')
eval "$(node -e 'const u=new URL(process.argv[1]+"/x");console.log(`export MYSQL_PWD=${JSON.stringify(decodeURIComponent(u.password))}; export MY="-h${u.hostname} -P${u.port||3306} -u${decodeURIComponent(u.username)}"`)' "$QA_BASE")"
export DATABASE_URL="$QA_BASE/proxyapp_upg_after"   # never proxyapp_db
export TEST_DATABASE_URL="$QA_BASE/proxyapp_test"
export OCR_CACHE_DIR=/tmp/upg/ocr-cache
export CLAIMS_SCAN_ROOT="$REPO/docs/samples"
```

Run: `source /tmp/upg/env.sh && node -v && echo "$DATABASE_URL" | sed 's#//[^@]*@#//***@#'`
Expected: `v24.22.1` (or newer 24.x), and a URL ending in `/proxyapp_upg_after`.

- [ ] **Step 2: Bring local `node_modules` back in line with the lockfile**

Local tailwind has drifted to 3.4.19, like the box. Run `npm ci` at `$REPO`.
Expected: exit 0. `npm ls tailwindcss -w client` shows 4.3.3.

- [ ] **Step 3: Create the before worktree, reproducing production**

```sh
git -C "$REPO" worktree add /tmp/upg/before 60910e3
cd /tmp/upg/before && npm ci && npm install --no-save -w client tailwindcss@3.4.19
npm run db:generate && npm run build
```

Expected: build exits 0. Production runs exactly this: `main` 60910e3 with tailwind 3.4.19.

- [ ] **Step 4: Clone the QA databases**

`proxyapp_qa` holds config plus the 570 spelling-check claims.

```sh
mysql $MY -e 'CREATE DATABASE proxyapp_upg_before'
mysqldump $MY --single-transaction proxyapp_qa | mysql $MY proxyapp_upg_before
```

Check that the forgery and Claims samples are present:
`mysql $MY -N proxyapp_upg_before -e "SELECT SUM(folder_path LIKE '%forgery-samples%'), SUM(folder_path LIKE '%Claims%Daily%') FROM claims"`.
For any count that's 0, load that set into `proxyapp_upg_before` using the before worktree and `DATABASE_URL=$QA_BASE/proxyapp_upg_before`:
- `docs/samples/Claims`: import `Forged Documents Observations.xlsx` per the header of `server/prisma/setupSampleClaims.ts`, then `npm run db:setup:samples`.
- `docs/samples/forgery-samples`: the existing rule's "Scan now", per the `qa-two-stack-setup` memory. Aditya signs in; don't type passwords.

Then clone `proxyapp_upg_before` into `proxyapp_upg_after` and into `proxyapp_upg_ui`, the same way.
Expected: all three databases have the same `SELECT COUNT(*) FROM claims`.

- [ ] **Step 5: Write `/tmp/upg/findings.sql` and `/tmp/upg/statuses.sql`**

Both select from each claim's latest `COMPLETED` run only, keyed so `comm` can diff them. Document ids match across the clones.

```sql
-- findings.sql
SELECT c.claim_id, f.validator_key, f.code, f.severity, COALESCE(f.document_id,'-'), COALESCE(f.page,0), f.message
FROM validation_runs r
JOIN claims c ON c.id = r.claim_id
JOIN validation_results vr ON vr.run_id = r.id
JOIN validation_findings f ON f.result_id = vr.id
WHERE r.status = 'COMPLETED'
  AND r.created_at = (SELECT MAX(r2.created_at) FROM validation_runs r2 WHERE r2.claim_id = r.claim_id AND r2.status = 'COMPLETED');
```

`statuses.sql` uses the same `FROM`/`WHERE`, without the findings join, and selects `c.claim_id, vr.validator_key, vr.status`.

- [ ] **Step 6: Run the baseline validation**

Run it in the background, from `/tmp/upg/before/server`:
`DATABASE_URL=$QA_BASE/proxyapp_upg_before npm run db:revalidate`.
When it finishes, export:
`mysql $MY -N -B proxyapp_upg_before < /tmp/upg/findings.sql | LC_ALL=C sort > /tmp/upg/before-findings.tsv`. Do the same with `statuses.sql` into `before-statuses.tsv`.
Expected:
- every claim with documents has a run after the start time;
- `SELECT COUNT(*) FROM validation_runs WHERE status='FAILED' AND created_at > <start>` is recorded (it should be 0);
- `wc -l` on both files is greater than 0.

Leave `OCR_CACHE_DIR` alone from now on. Both runs read the same cached traineddata, the same way production's cache will carry over.

- [ ] **Step 7: Record the before characterizations that Tasks 3 and 9 compare against**

1. **Port collision:** run `python3 -m http.server 3299 &`, then in `/tmp/upg/before/server` run `PORT=3299 NODE_ENV=production DATABASE_URL=$QA_BASE/proxyapp_upg_ui node dist/index.js 2>&1 | head -20`, then kill the http.server. Save the output to `/tmp/upg/before-port.txt`. Expected: the EADDRINUSE message, no `Server running on port 3299`, no `Re-queued`.
2. **Spreadsheets:** write `/tmp/upg/xlsx-roundtrip.ts`. It takes a repo root as `argv[2]` and imports that root's `server/src/services/observationImportService.ts` and `claimReportService.ts` by absolute path. It prints one JSON document containing:
   - `parseObservationWorkbook` run on each `docs/samples/*.xlsx`;
   - `buildClaimsWorkbook` and `buildObservationWorkbook` (each followed by `addFindingsSheet`), fed two fixed rows, then `writeBuffer`, re-read with exceljs, and reduced to sheet names plus every cell value.

   From `/tmp/upg/before/server`, run `node --import tsx /tmp/upg/xlsx-roundtrip.ts /tmp/upg/before > /tmp/upg/before-xlsx.json`.
   Expected: valid JSON with one entry per sample file.
3. **Screenshots and proxy statuses:** these are recorded in Task 9 Step 2, against this worktree.

---

### Task 1: Minor and patch updates (commit 1)

**Files:**
- Modify: `package.json`, `client/package.json`, `server/package.json`, `package-lock.json`

- [ ] **Step 1: Update within ranges and save the ranges**

Run `npm update --save -ws --include-workspace-root` at `$REPO`, then approve install scripts per Global Constraints.
Then run `npx playwright install chromium`, so the browser matches Playwright 1.64.
Expected: `npm outdated -ws --include-workspace-root` shows nothing in the "Wanted" column that's newer than "Current".

- [ ] **Step 2: Verify**

Run `npm test`, `npm run lint`, `npm run build -w server` and `npx tsc -b client`.
Expected: all exit 0, and lint shows 0 errors.

`vite build` is skipped until Task 6. `main` already fails it on a clean install because of #115.

- [ ] **Step 3: Commit**

Stage the four files. Message `.git/UPG_MSG_1`: `chore(deps): minor and patch updates within existing ranges`.

---

### Task 2: Tooling (commit 2)

The tooling group is Node 24, TypeScript 6, ESLint 10 flat config, Jest 30, `@types/node` 24 and concurrently 10.

**Files:**
- Delete: `client/.eslintrc.cjs`, `server/.eslintrc.cjs`
- Create: `client/eslint.config.js`, `server/eslint.config.mjs`
- Modify:
  - `server/tsconfig.json` (add `"types": ["node", "jest"]`);
  - `client/tsconfig.json` (drop `baseUrl`; `paths` stays `"@/*": ["./src/*"]`; add `"types": ["vite/client"]`);
  - `client/tsconfig.node.json` (add `"types": ["node"]`);
  - `client/package.json` and `server/package.json` (lint script becomes `eslint src`; deps);
  - `package.json` (`engines.node` becomes `">=24"`; `concurrently`).

**Interfaces:**
- Produces: `npm run lint` in each workspace runs flat config with the same rule settings as the deleted `.eslintrc.cjs` files.

- [ ] **Step 1: Bump the packages**

Bump the tooling versions from Global Constraints in each workspace. Remove the two `@typescript-eslint/*` packages and add `typescript-eslint`, `@eslint/js` and `globals`.

- [ ] **Step 2: Port the server lint config**

Write `server/eslint.config.mjs` with `defineConfig` (from `eslint/config`):
- `{ ignores: ['dist/'] }`, then `js.configs.recommended`, then `tseslint.configs.recommended`;
- `languageOptions.globals` is `{ ...globals.node, ...globals.jest }`;
- the `rules` block from `server/.eslintrc.cjs` copied verbatim, including its `ponytail:` comment.

- [ ] **Step 3: Port the client lint config**

Write `client/eslint.config.js` the same way, with these differences:
- globals: `globals.browser`;
- register the plugins `react-hooks` and `react-refresh`;
- set the old v4 recommended pair explicitly: `'react-hooks/rules-of-hooks': 'error'` and `'react-hooks/exhaustive-deps': 'warn'`;
- copy the rest of the old rules verbatim.

v7's recommended preset isn't used. Its React Compiler rules are new rules, which the spec says stay off.

- [ ] **Step 4: Run lint and turn off newly enabled rules**

Run `npm run lint`.
Expected: 0 errors.

For each error coming from a rule that's newly enabled in ESLint 10 or typescript-eslint, add `'<rule>': 'off'` with the comment from Global Constraints, and write the rule down for the PR body. If lint reports a `/* eslint-env */` comment, delete it; flat config forbids them.

- [ ] **Step 5: Type-check under TypeScript 6 and run the tests**

Run `npm run build -w server`, `npx tsc -b client` and `npm test`.
Expected: all exit 0. If TS 6 reports a deprecated option, fix the tsconfig. Don't add `ignoreDeprecations`.

- [ ] **Step 6: Commit**

Message `.git/UPG_MSG_2`: `chore(tooling): Node 24, TypeScript 6, ESLint 10 flat config, Jest 30`. List the rules that were turned off in the body.

---

### Task 3: Server, part 1: Express 5, helmet 8, dotenv 18, exceljs 4, supertest 7 (commit 3)

**Files:**
- Modify:
  - `server/src/lib/routeHelpers.ts`: add `PROXY_SUBRESOURCE_ROUTE` and `proxySubPath`.
  - `server/src/routes/proxy.ts:860-868`: use both.
  - `server/src/app.ts:59` (body guard) and `server/src/app.ts:75` (SPA fallback).
  - `server/src/index.ts:89`: the listen callback ignores errors.
  - Add `quiet: true` to the dotenv calls in `server/prisma/{qaCaseDiagnostics,qrDebug,clearClaims,syncSpellTerms}.ts` and `server/scripts/backup-db.js`.
  - `server/package.json`: remove `http-proxy-middleware`.
- Create: `server/src/lib/__tests__/proxySubPath.test.ts`, `server/src/__tests__/e2e/upgradeCompat.e2e.test.ts`

**Interfaces:**
- Produces:
  - `export const PROXY_SUBRESOURCE_ROUTE: string`, which is `'/:opaqueId/*'` on Express 4 and the path-to-regexp v8 equivalent on Express 5.
  - `export function proxySubPath(req: Request): string`. It returns exactly what Express 4's `req.params[0] || ''` returned: decoded, with a trailing slash kept, and `''` for an empty sub-path.

- [ ] **Step 1: Write the characterization tests, still on Express 4**

```ts
// proxySubPath.test.ts — builds express(), app.all(PROXY_SUBRESOURCE_ROUTE, (req, res) => res.send(proxySubPath(req)))
it.each([
  ['/abc/', ''],
  ['/abc/css/site.css', 'css/site.css'],
  ['/abc/dir/', 'dir/'],
  ['/abc/a%20b/c.js?x=1', 'a b/c.js'],
  ['/abc/_ext/aHR0cHM6Ly9leGFtcGxlLmNvbS8', '_ext/aHR0cHM6Ly9leGFtcGxlLmNvbS8'],
])('%s -> %j', async (path, expected) => {
  const res = await request(app).get(path);
  expect(res.status).toBe(200);
  expect(res.text).toBe(expected);
});
```

`upgradeCompat.e2e.test.ts` (an admin agent via `loginAs`, using the existing helpers):
- `PUT /api/admin/settings` with no body returns 200.
- `GET /health` has `x-frame-options: SAMEORIGIN`, `x-content-type-options: nosniff` and `referrer-policy: no-referrer`.
- `GET /proxy/00000000-0000-0000-0000-000000000000/x` has no `x-frame-options` header (the iframe anti-goal).

- [ ] **Step 2: Implement the Express 4 versions and run the tests**

Implement `PROXY_SUBRESOURCE_ROUTE = '/:opaqueId/*'` and `proxySubPath = req => req.params[0] || ''`. Switch `proxy.ts` to use them.
Run `npx jest src/lib/__tests__/proxySubPath.test.ts`, then `npm run test:e2e:api -- upgradeCompat`.
Expected: all PASS on Express 4. If a case fails, the test is wrong; fix the test to match Express 4, never the code.

- [ ] **Step 3: Bump the packages**

Bump express, `@types/express`, helmet, dotenv, exceljs, supertest, `@types/supertest` and `@types/bcrypt`. Remove `http-proxy-middleware`.
Run the two tests from Step 2.
Expected: FAIL. Express 5 throws on `'/:opaqueId/*'`, and the settings PUT returns 500.

- [ ] **Step 4: Make the tests pass on Express 5**

- `PROXY_SUBRESOURCE_ROUTE = '/:opaqueId/{*subPath}'`.
- `proxySubPath` rebuilds the Express 4 string from `req.params.subPath`, which Express 5 gives as an array of decoded segments, or undefined when the sub-path is empty. Join the segments with `/`. Restore the trailing slash from `req.path` if Express drops it.
- `app.ts`, right after `express.json()`: `app.use('/api', (req, _res, next) => { req.body ??= {}; next(); })`. This is one guard for all 24 `req.body` readers.
- `app.ts:75`: `app.get('/{*splat}', …)`.
- `index.ts:89`: the callback takes `(err?: Error)` and returns early when `err` is set. The `server.on('error')` handler still reports EADDRINUSE.

- [ ] **Step 5: Verify**

1. Run `npm test`, `npm run test:e2e:api` and `npm run lint`.
   Expected: PASS, with 0 lint errors.
2. Run `npm run build -w server`, then the port-collision check from Task 0 Step 7 against `$REPO/server`.
   Expected: the output matches `/tmp/upg/before-port.txt` in substance: an EADDRINUSE line, no `Server running`, no `Re-queued`.
3. Run `grep -rn "http-proxy-middleware" server/src` (expect no output) and `npm ls follow-redirects` (expect no `http-proxy` path).
4. **exceljs round trip:** from `$REPO/server`, run `node --import tsx /tmp/upg/xlsx-roundtrip.ts "$REPO" > /tmp/upg/after-xlsx.json`, then `diff /tmp/upg/before-xlsx.json /tmp/upg/after-xlsx.json`.
   Expected: no output. Any difference is a regression in import or export; fix it before committing.
5. **Nightly backup under dotenv 18:** from `$REPO/server`, run `DATABASE_URL=$QA_BASE/proxyapp_upg_ui node scripts/backup-db.js`.
   Expected: exit 0, a new dump file reported in the output, and no dotenv banner. Delete the dump afterwards.

- [ ] **Step 6: Commit**

Message `.git/UPG_MSG_3`: `chore(server): Express 5, helmet 8, dotenv 18, exceljs 4, supertest 7; drop unused http-proxy-middleware`.

---

### Task 4: Server, part 2: Prisma 7 with the MariaDB adapter (commit 4)

**Files:**
- Create:
  - `server/src/lib/prisma.ts`
  - `server/src/lib/__tests__/prisma.test.ts`
  - `server/prisma.config.ts`
- Modify:
  - `server/prisma/schema.prisma:1-9`: drop `previewFeatures` and `url`.
  - `server/src/index.ts:3,16`.
  - `server/src/__tests__/helpers/testDb.ts`.
  - The 12 `new PrismaClient(` sites in `server/prisma/*.ts`. To find them: `grep -rn "new PrismaClient" server`.
  - `server/package.json`, root `package.json` (allowScripts) and `package-lock.json`.

**Interfaces:**
- Produces, in `server/src/lib/prisma.ts`:
  - `export function mariadbConfigFromUrl(url: string): ConstructorParameters<typeof PrismaMariaDb>[0]`
  - `export function createPrisma(url: string | undefined = process.env.DATABASE_URL): PrismaClient`, which throws `Error('DATABASE_URL is not set')` when `url` is empty.
  - Side effect on first import: `dotenv.config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true })`. The path resolves to `server/.env` from both `src/lib` and `dist/lib`.

- [ ] **Step 1: Write the failing unit test**

```ts
// prisma.test.ts
it('maps a Prisma-5 style URL to Prisma-5 pool behaviour', () => {
  expect(mariadbConfigFromUrl('mysql://app:p%40ss%23w0rd@127.0.0.1:3307/proxyapp_qa')).toMatchObject({
    host: '127.0.0.1', port: 3307, user: 'app', password: 'p@ss#w0rd', database: 'proxyapp_qa',
    connectTimeout: 5_000, idleTimeout: 300, allowPublicKeyRetrieval: true,
    connectionLimit: os.availableParallelism() + 1,
  });
});
it('defaults the port to 3306', () => {
  expect(mariadbConfigFromUrl('mysql://root@localhost/db').port).toBe(3306);
});
it('honours connection_limit like Prisma 5 did', () => {
  expect(mariadbConfigFromUrl('mysql://u:p@h/db?connection_limit=7').connectionLimit).toBe(7);
});
```

Run: `npx jest src/lib/__tests__/prisma.test.ts`
Expected: FAIL, with the module not found.

- [ ] **Step 2: Bump the packages and approve scripts**

Bump `prisma` and `@prisma/client` to 7.10.1 and add `@prisma/adapter-mariadb` 7.10.1. Approve install scripts for `prisma` and `@prisma/engines`.

- [ ] **Step 3: Implement `server/src/lib/prisma.ts`**

- `idleTimeout` is in seconds.
- `connectionLimit` gets a `ponytail:` comment: Prisma 5 used physical CPUs × 2 + 1, and logical CPUs + 1 approximates that on SMT hardware. Upgrade path: set `connection_limit` in the URL.
- Search parameters other than `connection_limit` are reported once with `console.warn` and otherwise ignored.

- [ ] **Step 4: Wire it in**

- `prisma.config.ts`: `config({ quiet: true })` from dotenv, then `defineConfig({ schema: 'prisma/schema.prisma', datasource: { url: process.env.DATABASE_URL } })`. Prisma only runs from `server/`. `prisma generate` must succeed with `DATABASE_URL` unset, because CI's build job has no database.
- `index.ts`: replace line 3 with `import { createPrisma } from './lib/prisma.js';` in the same position. It must stay the first import that reads the environment, the way the `@prisma/client` import did, so `.env` is loaded before `app.js` and the services evaluate. Line 16 becomes `createPrisma()`.
- `testDb.ts`: `createPrisma(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL)`.
- `seedE2e.ts`: `createPrisma(DB_URL)`.
- The other prisma scripts: `createPrisma()`. Keep their own dotenv calls.
- Types and enums still come from `@prisma/client`.

- [ ] **Step 5: Run the unit test and the full suites**

1. `npx prisma generate` (from `server/`), then `npx jest src/lib/__tests__/prisma.test.ts`.
   Expected: PASS.
2. `npm test`.
3. `DATABASE_URL=$TEST_DATABASE_URL npm run db:push`, then `npm run test:e2e:api`.
   Expected: PASS, against local MySQL 9.4 with `caching_sha2_password`. That exercises `allowPublicKeyRetrieval`.

- [ ] **Step 6: Check the schema is unchanged, and that `.env` still loads**

1. `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` with `DATABASE_URL=$QA_BASE/proxyapp_upg_after`.
   Expected: an empty migration. This proves Prisma 7 sees the existing schema as in sync.
2. `npm run build -w server`, then from `server/`: `env -i PATH="$PATH" HOME="$HOME" node -e "require('./dist/lib/prisma.js'); console.log(Boolean(process.env.SESSION_SECRET && process.env.CLIENT_URL))"`.
   Expected: `true`. This reads only `.env`; no database connection is made.

- [ ] **Step 7: Commit**

Message `.git/UPG_MSG_4`: `chore(server): Prisma 7 with the MariaDB driver adapter, Prisma 5 pool defaults`.

---

### Task 5: Frontend, part 1: React 19 family (commit 5)

The React family here is React 19, react-pdf 11, zustand 5, TanStack Table 9 and lucide 1.

**Files:**
- Modify:
  - `client/package.json`.
  - `client/src/components/shared/DataTable.tsx`.
  - The 14 pages that import `ColumnDef`. To find them: `grep -rl "@tanstack/react-table" client/src/pages`.
  - `client/src/components/claims/DocumentViewer.tsx:6-8` (comment only).
  - `client/src/stores/authStore.ts`, only if zustand 5's types require it.
  - Any file `tsc` flags for a renamed lucide icon.
  - Root `package.json` (allowScripts: drop `canvas@3.2.3`).

**Interfaces:**
- Produces, in `DataTable.tsx`:
  - `export const dataTableFeatures`, at module level: `tableFeatures({ rowSortingFeature, rowPaginationFeature, sortedRowModel: createSortedRowModel(), paginatedRowModel: createPaginatedRowModel(), sortFns })`.
  - `export type DataTableColumn<TData, TValue = unknown> = ColumnDef<typeof dataTableFeatures, TData, TValue>`.
  - Pages replace `ColumnDef<X>` with `DataTableColumn<X>`, imported as a type from `@/components/shared/DataTable`.

- [ ] **Step 1: Bump the packages**

Bump react, react-dom, the React types, react-pdf, zustand, `@tanstack/react-table` and lucide-react. Set client `pdfjs-dist` to exactly `6.3.289`.
Run: `npm view react-pdf@11.0.0 dependencies.pdfjs-dist`
Expected: `6.3.289`. If it isn't, use whatever it prints.

- [ ] **Step 2: Type-check**

Run: `npx tsc -b client`
Expected: FAIL, with TanStack v9 errors in `DataTable.tsx` and the pages (and perhaps lucide or React 19 type errors).

- [ ] **Step 3: Migrate**

- `DataTable.tsx` uses `useTable({ features: dataTableFeatures, columns, data, state: { sorting }, onSortingChange, manualPagination: !!pagination, pageCount })`.
- `table.getState()` becomes `table.state`.
- The custom selection column keeps its own `Set`. It doesn't use a TanStack feature.
- Renamed lucide icons move to their current names (for example `Loader2`→`LoaderCircle`, `AlertCircle`→`CircleAlert`, `MoreHorizontal`→`Ellipsis`, `MoreVertical`→`EllipsisVertical`), and only where `tsc` says the old name is gone.
- Update the comment in `DocumentViewer.tsx` to say react-pdf v11 uses pdfjs-dist 6.3.289.

- [ ] **Step 4: Verify**

1. `npx tsc -b client` and `npm run lint`.
   Expected: exit 0, with 0 errors.
2. `npm ls pdfjs-dist -w client`.
   Expected: one version, `6.3.289`, deduped under react-pdf.
3. `npm ls canvas`.
   Expected: empty.

- [ ] **Step 5: Commit**

Message `.git/UPG_MSG_5`: `chore(client): React 19, react-pdf 11, zustand 5, TanStack Table 9, lucide 1`.

---

### Task 6: Frontend, part 2: Tailwind 4, tailwind-merge 3, Vite 8 (commit 6)

**Files:**
- Delete: `client/postcss.config.js`, `client/tailwind.config.js`
- Modify:
  - `client/src/index.css`, migrated to `@import "tailwindcss"`, `@theme`, `@plugin "tailwindcss-animate"` and the `container` utility.
  - `client/vite.config.ts`, adding `tailwindcss()` from `@tailwindcss/vite`.
  - Class renames in `client/src/**/*.tsx` (done by the upgrade tool).
  - `client/package.json`.
  - Root `package.json`: `optionalDependencies` and its comment.
  - `package-lock.json`.

- [ ] **Step 1: Run the official upgrade tool on a v3 install**

The tool reads the v3 config, so install v3 first:
`npm i -D -w client tailwindcss@3.4.19`, then from `client/` run `npx @tailwindcss/upgrade@latest --force`. The working tree has Aditya's unrelated docs edits, so `--force` is needed.
Expected: `tailwind.config.js` folds into `index.css`, `package.json` gets tailwind 4, and the utilities are renamed.

- [ ] **Step 2: Switch from the PostCSS plugin to the Vite plugin**

Delete the PostCSS config. Uninstall `@tailwindcss/postcss`, `postcss` and `autoprefixer` from client. Install `@tailwindcss/vite`, `tailwind-merge@3`, `vite@8` and `@vitejs/plugin-react@6`. Add `tailwindcss()` to the `plugins` in `vite.config.ts`.

- [ ] **Step 3: Pin the native binaries for Windows and Linux**

Run `npm ls --all | grep -E "rolldown/binding|lightningcss-|tailwindcss/oxide-|@esbuild/|rollup-"` to get the versions in use.

In root `optionalDependencies`, set the `win32-x64-msvc` / `win32-x64` and `linux-x64-gnu` / `linux-x64` variants for `@rolldown/binding-*`, `lightningcss-*`, `@tailwindcss/oxide-*` and `@esbuild/*`. Drop the `@rollup/*` entries if `npm ls rollup` is empty. Update the `//optionalDependencies` comment, which currently names only rollup, esbuild and canvas.

Run: `npm install`, then `grep -c '"node_modules/@rolldown/binding-win32-x64-msvc"\|"node_modules/lightningcss-win32-x64-msvc"\|"node_modules/@tailwindcss/oxide-win32-x64-msvc"' package-lock.json`
Expected: `3`.

- [ ] **Step 4: Build the client**

Run `npm run build` (client, then server, now complete again), then `npm run lint`.
Expected: exit 0, with 0 errors. The tool may leave a compatibility `border-color` base layer. Keep it; it's what keeps v3's default border colour.

- [ ] **Step 5: Commit**

Message `.git/UPG_MSG_6`: `chore(client): Tailwind 4 via @tailwindcss/vite, tailwind-merge 3, Vite 8`. This commit restores a clean-install `npm run build`, which `main` lost in #115.

---

### Task 7: OCR and validation stack (commit 7)

The stack is tesseract.js 7, pdfjs-dist 6, `@napi-rs/canvas` 1, pdf-parse 2, dictionary-en 4 and the zod override.

**Files:**
- Modify:
  - `server/package.json`.
  - Root `package.json`: `overrides` gets `"zod": "^4.6.6"` and `"pdf-parse": { "pdfjs-dist": "6.4.299", "@napi-rs/canvas": "1.0.13" }`. `optionalDependencies` gets canvas 1.0.13 for win32 and linux.
  - `server/src/validators/metaValidator.ts:2-3,102`: pdf-parse 2 API.
  - `server/src/validators/dictionary.ts` and `server/scripts/spell-check.ts`: dictionary-en 4 is ESM, with the default export `{ aff, dic }`.
  - `server/src/lib/ocr.ts`, only where tesseract.js 7 types require it. The `errorHandler` and its comment block stay word for word.
  - `package-lock.json`.

- [ ] **Step 1: Bump the packages and add the overrides**

Remove `@types/pdf-parse`; pdf-parse 2 ships its own types.
Run: `npm ls zod pdfjs-dist @napi-rs/canvas`
Expected:
- every zod is 4.6.6 or newer;
- server pdfjs-dist is 6.4.299, including under pdf-parse;
- one `@napi-rs/canvas`, version 1.0.13.

- [ ] **Step 2: Type-check and fix the call sites**

Run `npm run build -w server`.
- `metaValidator.ts`: the fallback becomes `const parser = new PDFParse({ data: buf }); try { text = (await parser.getText()).text } finally { await parser.destroy() }`, imported from `'pdf-parse'`. Delete the old subpath-import comment, which applies to 1.x only.
- `dictionary.ts`: drop the v3 callback-style loader comment and code, and read `enDictionary.aff` / `enDictionary.dic` directly.

Expected: exit 0.

- [ ] **Step 3: Run the script checks**

From `server/` (there's no tsx CLI in the sandbox, so use `node --import tsx`):
- `OCR_CACHE_DIR=. node --import tsx scripts/ocr-bad-file.ts`
  Expected: `ok: unreadable image read as empty, process survived`.
- A spot run of `scripts/spell-check.ts` and `scripts/scan-qr.ts` on one sample each (usage is in each file's header).
  Expected: the same output as the same commands in `/tmp/upg/before/server`.

If jimp fails on zod 4 (any jimp error in `scan-qr.ts` or the OCR path), **stop and ask Aditya** before holding zod back. That's a spec call.

If pdf-parse 2 breaks with the pdfjs override, hold pdf-parse at 1.1.4 and record it as held back. Its fallback value comes from bundling an independent pdf.js anyway.

- [ ] **Step 4: Run the full suites**

Run `npm test`, `npm run test:e2e:api` and `npm run lint`.
Expected: PASS, with 0 errors.

- [ ] **Step 5: Commit**

Message `.git/UPG_MSG_7`: `chore(ocr): tesseract.js 7, pdfjs-dist 6, @napi-rs/canvas 1, pdf-parse 2, dictionary-en 4; force zod >=4.6.6`.

---

### Task 8: CI, Dependabot and docs (commit 8)

**Files:**
- Create: `.github/workflows/build.yml`, `.github/dependabot.yml`
- Modify:
  - `.github/workflows/e2e.yml`: `node-version: 24` in both jobs. `api-e2e` service image becomes `mysql:5.7`, and the InnoDB comment changes to say 5.7.7+ also defaults to DYNAMIC.
  - `docs/DEPLOYMENT.md`: a one-line TODO at the stale MySQL 8.0 / :3307 note.
  - `CLAUDE.md` Tech Stack: Node 24, React 19, Prisma 7. Database Notes: `db:push` no longer regenerates the client; run `db:generate`.

- [ ] **Step 1: Write `build.yml`**

```yaml
name: build
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  build:            # name is referenced by branch protection — do not rename
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run db:generate
      - run: npm run build
      - run: npm run lint
```

- [ ] **Step 2: Write `dependabot.yml`**

Use `version: 2`, with:
- one `npm` entry at `directory: /`, `schedule.interval: weekly`, and `groups.minor-and-patch.update-types: [minor, patch]`;
- one `github-actions` entry at `/`, weekly.

- [ ] **Step 3: Verify the YAML parses**

Run: `node -e "for (const f of ['.github/workflows/build.yml','.github/workflows/e2e.yml','.github/dependabot.yml']) require('yaml').parse(require('fs').readFileSync(f,'utf8'))"`. The `yaml` package is in the tree through vite; if it isn't, use `npx yaml-lint`.
Expected: no output, exit 0. The real check is the first CI run in Task 11.

- [ ] **Step 4: Commit**

Message `.git/UPG_MSG_8`: `ci: Windows build gate on Node 24, API E2E on MySQL 5.7, Dependabot`.

---

### Task 9: UI, proxy and production-mode comparison (no commit unless a fix is needed)

**Files:**
- Create (outside repo):
  - `/tmp/upg/visual/playwright.config.ts`
  - `/tmp/upg/visual/visual.spec.ts`
  - `/tmp/upg/visual/node_modules`, a symlink to `$REPO/node_modules`

**Interfaces:**
- Consumes: the before stack from Task 0 and `proxyapp_upg_ui`.
- `visual.spec.ts`:
  - Logs in once as the E2E admin through the form, per `e2e/global-setup.ts`.
  - For each page in the spec's list (login, user dashboard and menu, every admin CRUD page, claims list, claim detail, document viewer, `/view/:opaqueId`), calls `expect(page).toHaveScreenshot('<page>.png', { fullPage: true, mask: [<timestamps>] })`.
  - Has one test, `proxy statuses`, that for one active DIRECT `UrlConfiguration`:
    - loads `/view/<opaqueId>`;
    - collects every response under `/proxy/` with status ≥ 400;
    - sends `page.request.post` and `page.request.put` to `/proxy/<opaqueId>/`;
    - writes all of this to `/tmp/upg/proxy-<STACK>.json`.
  - `baseURL` comes from `process.env.BASE_URL`.

- [ ] **Step 1: Seed the E2E admin**

From `/tmp/upg/before`: `E2E_DATABASE_URL=$QA_BASE/proxyapp_upg_ui npm run db:seed:e2e`.

- [ ] **Step 2: Record the before stack**

Start it from `/tmp/upg/before/server` with `NODE_ENV=production PORT=3201 CLIENT_URL=http://127.0.0.1:3201 DATABASE_URL=$QA_BASE/proxyapp_upg_ui node dist/index.js`. Use 127.0.0.1, not localhost (the cookie trap).
Run `BASE_URL=http://127.0.0.1:3201 STACK=before npx playwright test -c /tmp/upg/visual --update-snapshots`, then stop the stack.
Expected: one PNG per page, and `proxy-before.json`.

- [ ] **Step 3: Compare the after stack**

Start the repo build the same way on port 3202. Only one stack runs at a time on the shared database.
Run `BASE_URL=http://127.0.0.1:3202 STACK=after npx playwright test -c /tmp/upg/visual`.
Expected: every screenshot matches, or each diff image in `test-results/` is reviewed and listed for Aditya. `proxy-after.json` must equal `proxy-before.json`, with the same failed-resource set and the same POST/PUT statuses.

- [ ] **Step 4: Check the production SPA fallback**

With the after stack running: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3202/admin/users` should print `200`, and `curl -s http://127.0.0.1:3202/admin/users | grep -c 'id="root"'` should print `1`.

- [ ] **Step 5: Run the UI smoke test on Node 24**

Stop both stacks and free ports 5173 and 3001. Run `E2E_DATABASE_URL=$TEST_DATABASE_URL npm run test:e2e:ui`.
Expected: PASS.

- [ ] **Step 6: Hand over to Aditya**

Show Aditya the screenshot diffs and the proxy comparison. Aditya clicks through the after stack, which stays up on :3202, before merge.

---

### Task 10: OCR comparison and triage (no commit unless a fix or hold-back is needed)

**Interfaces:**
- Consumes:
  - `/tmp/upg/before-findings.tsv` and `before-statuses.tsv`
  - `findings.sql` and `statuses.sql`
  - the database `proxyapp_upg_after`
- Produces:
  - `/tmp/upg/lost.tsv`, `/tmp/upg/new.tsv` and `/tmp/upg/status-changes.tsv`
  - `/tmp/upg/triage.md`, for Aditya to approve

- [ ] **Step 1: Run the upgraded validation**

From `$REPO/server`: `DATABASE_URL=$QA_BASE/proxyapp_upg_after npm run db:revalidate`, run in the background. Use the same `OCR_CACHE_DIR` and `CLAIMS_SCAN_ROOT` as Task 0.
Export to `after-findings.tsv` and `after-statuses.tsv` exactly as Task 0 Step 6 did.
Expected: the same number of claims got a run, and the FAILED-run count is no higher than the baseline's.

- [ ] **Step 2: Diff**

```sh
cd /tmp/upg
comm -23 before-findings.tsv after-findings.tsv > lost.tsv
comm -13 before-findings.tsv after-findings.tsv > new.tsv
comm -3  before-statuses.tsv after-statuses.tsv > status-changes.tsv
wc -l lost.tsv new.tsv status-changes.tsv
```

- [ ] **Step 3: Triage**

Read the page image for each row of `lost.tsv` and `new.tsv` (the claim's document, at that page). Write `triage.md` with the columns: claim, check, code, page, message, lost/new, verdict (`real` / `false alarm`), and a one-line reason.

A message that changed only because the OCR read differs shows up as a lost/new pair. Triage the pair as one row.

- [ ] **Step 4: Apply the gate**

Pass means no lost row is `real` and no new row is `false alarm`.

For each failing row, find the responsible package. Re-run only those claims (`npm run db:revalidate -- <claimIds>`) with one OCR-group package reverted at a time, using `npm i --no-save -w server <pkg>@<old>`. Then either fix the code for that package (a `fix(ocr): …` commit) or hold that package back at its old version (a `chore(ocr): hold <pkg> at <ver>` commit, recorded in the spec). After any change, repeat Steps 1–3.

- [ ] **Step 5: Hand `triage.md` to Aditya**

Merge is blocked until Aditya approves it.

---

### Task 11: Audit, held-back record, PR, and branch protection

**Files:**
- Modify: `docs/superpowers/specs/2026-10-24-dependency-upgrade-design.md`, the "Held back" section
- Create: `.git/UPG_PR_BODY.md`, `.git/UPG_MSG_11`

- [ ] **Step 1: Audit**

Run: `npm audit --omit=dev; npm audit`
Expected: no high or critical advisories. List any that remain, with the reason.

- [ ] **Step 2: Fill in "Held back" in the spec**

Use a table with: package, version kept, latest, reason. It contains the four entries from Global Constraints, plus anything from Tasks 7 and 10. Commit it (`.git/UPG_MSG_11`: `docs: record held-back packages for the dependency upgrade`).

- [ ] **Step 3: Write the PR body**

The PR body contains:
- What changed, per commit.
- The held-back table.
- The lint rules that were turned off.
- `npm audit` before (33 high) and after.
- The screenshot-diff summary and the proxy comparison.
- A link to the triage list, or its counts.
- **Production steps.** One copy-pasteable PowerShell command per line, no backtick continuations, `;` never `|`. In order:
  1. `Select-String -Path C:\ProxyApp\server\.env -Pattern '^DATABASE_URL=.*\?'`. Expected: no output. Otherwise stop and send it: only `connection_limit` is honoured now.
  2. `node -v`. Then download that same version's MSI as the rollback installer: `Invoke-WebRequest -Uri "https://nodejs.org/dist/$(node -v)/node-$(node -v)-x64.msi" -OutFile C:\node-rollback.msi`.
  3. `Invoke-WebRequest -Uri https://nodejs.org/dist/v24.22.1/node-v24.22.1-x64.msi -OutFile C:\node-v24.22.1-x64.msi`
  4. `pm2 stop all`
  5. `Start-Process msiexec.exe -Wait -ArgumentList '/i C:\node-v24.22.1-x64.msi /qn'`
  6. In a new PowerShell window: `node -v` (expect `v24.22.1`) and `npm -v`. If npm is older than 11.17.0, run `npm install -g npm@11`.
  7. `pm2 kill`. The daemon was spawned by the old `node.exe`, and apps inherit its runtime.
  8. `cd C:\ProxyApp`, then `git pull origin main`, then `npm ci`. Confirm each succeeds before the next.
  9. `cd server`, then `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`, then `cd ..`. Expected: an empty migration. If any SQL appears, stop and send it.
  10. `npm run deploy`. It must end without an error.
  11. `pm2 start ecosystem.config.js`, then `pm2 save`.
  12. Prove the deploy:
      - `pm2 describe proxyurl-server | Select-String 'node.js version'` shows 24.22.1;
      - `Select-String -Path server\dist\lib\prisma.js -Pattern 'PrismaMariaDb'` matches;
      - `(Get-Item server\dist\index.js).LastWriteTime` and `(Get-Item client\dist\index.html).LastWriteTime` are today;
      - `pm2 logs proxyurl-server --lines 30 --nostream` shows `Server running` and no error.
  - Rollback: `git checkout <previous main sha>`, reinstall from `C:\node-rollback.msi`, `pm2 kill`, `npm ci`, `npm run deploy`, `pm2 start ecosystem.config.js`. Keep `C:\node-rollback.msi` for a week.
- End with the attribution lines from the system reminder, if there are any.

- [ ] **Step 4: Push and open the PR**

Hand Aditya: `! git push -u origin chore/deps-latest && GH_TOKEN=$(gh auth token -u adityakdevin) gh pr create --base main --title "Upgrade every dependency to latest; Node 24; CI build gate" --body-file .git/UPG_PR_BODY.md`.
The pre-push hook runs the API E2E suite. If the first push fails, retry once and read the output.
Expected: a PR URL. The checks `build`, `api-e2e` and `ui-e2e` all go green.

- [ ] **Step 5: Branch protection, with Aditya's explicit go-ahead at that moment**

Once `build` has run at least once, ask for the go-ahead. Then hand Aditya:

```
! GH_TOKEN=$(gh auth token -u adityakdevin) gh api -X PUT repos/adityakdevin/proxyURLApp/branches/main/protection --input - <<< '{"required_status_checks":{"strict":false,"contexts":["build","api-e2e","ui-e2e"]},"enforce_admins":true,"required_pull_request_reviews":null,"restrictions":null}'
```

Expected: JSON echoing the three contexts and `"enforce_admins":{"enabled":true}`.

- [ ] **Step 6: Merge gate**

The PR stays unmerged until:
- Aditya approves `triage.md` (Task 10);
- Aditya has reviewed the screenshots and clicked through (Task 9);
- all checks are green.

Aditya merges it.
