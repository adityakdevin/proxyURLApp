# Claim Module — End-to-End Test Plan

Status: **scaffolded** (foundational refactor + API harness + UI smoke + CI in place; suites compile & are wired). Author: generated 2026-06-27.

This plan covers two E2E layers for the Claim module:

1. **API / HTTP E2E** (supertest) — drives the real Express stack (`auth → scope → role guards → service → Prisma → MySQL`) in-process, no browser. Primary coverage.
2. **Browser UI E2E** (Playwright) — drives the real React client against a running stack. Smoke-level coverage of the critical journeys.

---

## 1. Scope & priorities

All four claim flows are in scope (per request):

| # | Flow | Layer(s) | Spec |
|---|------|----------|------|
| 1 | Claim lifecycle + RBAC (create, remarks, status transitions, terminal guard, reassign, soft-delete/restore, scope isolation) | API + UI | `claimLifecycle.e2e.test.ts` |
| 2 | Documents + validation (upload, `DOCS_NOT_AVAILABLE`, manual validate) | API | `documentsValidation.e2e.test.ts` |
| 3 | Forged-Docs observation import/export (XLSX, create-or-update, error rows) | API | `observations.e2e.test.ts` |
| 4 | Claim rules + claim-id rules (admin CRUD + evaluation) | API | `claimRules.e2e.test.ts` |
| — | Auth/session (login, /me, logout, guards) | API + UI | `auth.e2e.test.ts` |

---

## 2. Architecture decisions

### 2.1 App factory (foundational refactor)

`server/src/index.ts` used to call `app.listen()` and start background sweeps at
import time, so importing it into a test would boot the server and drain the
queue against the **dev** DB. Split into:

- **`server/src/app.ts`** — `createApp(prisma)`: builds the fully-wired Express
  app (middleware + routes + error handler). No `listen`, no sweeps, no headless
  pool. Accepts an injected Prisma so tests target the test DB.
- **`server/src/index.ts`** — constructs the production Prisma, calls
  `createApp`, then owns `listen()`, startup sweeps, and signal handlers.
  Behavior is identical (nothing imported `app` from `index.ts`).

API E2E tests do `createApp(getTestPrisma())` and drive it with supertest — no
port is bound.

### 2.2 Database strategy (recommended)

**Dedicated MySQL test schema via `TEST_DATABASE_URL`, schema applied with
`prisma db push`, self-contained fixture seeding, claim tables truncated between
tests. CI uses an ephemeral MySQL 8 service container.**

Rationale:
- Reuses the existing `server/src/__tests__/helpers/testDb.ts` pattern
  (`getTestPrisma` already honors `TEST_DATABASE_URL`; `truncateClaimsTables`
  already exists) — lowest friction, consistent with current unit/integration
  tests.
- MySQL 8 defaults to **InnoDB + DYNAMIC** row format, which sidesteps the
  2144-byte key-length failure that hit the legacy MyISAM/COMPACT Windows box on
  the `documents` table — so CI "just works" without `my.ini` tuning.
- No Docker tooling required beyond GitHub Actions `services:`.

> ⚠️ **Never point the E2E suites at the dev/prod DB.** The suites call
> `truncateClaimsTables` in `beforeEach`/`afterAll`, which deletes **all**
> claims, remarks, statuses, doc-type masters, and claim-id rules. Only run with
> `TEST_DATABASE_URL` set to a disposable schema.

### 2.3 Fixtures — self-contained access graph

`server/src/__tests__/e2e/helpers/factories.ts` seeds a complete graph so suites
don't depend on `db:seed` specifics:

```
UserType + ProjectType ─ Category ─ SubCategory ─ (StatusMaster, Claims)
(a second, disjoint pair) ─ … ─ SubCategory   ← used for OUT_OF_SCOPE
Users: admin (scope ALL), teamLead + user (in-scope), otherTeamLead (disjoint)
```

All users share `TEST_PASSWORD`, `forcePasswordChange=false`. Names carry a
per-suite random suffix. `cleanupScopeGraph` removes everything in FK-safe order.
`seedStatuses` seeds a default + terminal `StatusMaster` per test (claim tables —
including statuses — are truncated between tests).

### 2.4 Auth in tests

- **API:** `loginAs(app, username)` → a cookie-carrying supertest agent via the
  real `POST /api/auth/login` (exercises the genuine login path).
- **UI:** `e2e/global-setup.ts` logs in through the **actual login form** (the
  client's `ProtectedRoute` keys off the persisted `auth-storage` zustand state,
  so API-only login is insufficient) and saves `storageState` for all specs.

### 2.5 Validation timing

`POST /claims/:id/validate` enqueues a run and `enqueue` kicks an in-process
drain that resolves when the queue empties. Tests poll `GET /claims/:id/validation`
until the run is `COMPLETED`/`FAILED` (`waitForValidation` helper). A
zero-document claim short-circuits to all five columns = `DOCS_NOT_AVAILABLE`
(no OCR) — the deterministic, always-on validation assertion. Document upload
triggers real OCR (tesseract) in the background, so the upload spec is gated
behind `E2E_HEAVY=1`.

---

## 3. Layout

```
server/
  jest.config.mjs            # unit/integration — now ignores *.e2e.test.ts
  jest.e2e.config.mjs        # API E2E config (testMatch e2e/**/*.e2e.test.ts)
  src/
    app.ts                   # createApp(prisma) factory  ← new
    index.ts                 # listen + sweeps (uses createApp)
    __tests__/e2e/
      helpers/{app,factories,auth,xlsx}.ts
      auth.e2e.test.ts
      claimLifecycle.e2e.test.ts
      documentsValidation.e2e.test.ts
      observations.e2e.test.ts
      claimRules.e2e.test.ts
playwright.config.ts         # UI E2E (webServer = npm run dev)
e2e/
  global-setup.ts            # form login → storageState
  claims.smoke.spec.ts
  tsconfig.json / .gitignore
.github/workflows/e2e.yml    # api-e2e + ui-e2e jobs (MySQL 8 service)
```

---

## 4. Scenario matrix

### API — auth (`auth.e2e.test.ts`)
- ✅ valid login sets cookie; `/api/auth/me` resolves the user
- ✅ invalid password → 401 `LOGIN_FAILED`
- ✅ protected route without session → 401 `AUTH_REQUIRED`
- ✅ logout invalidates the session

### API — lifecycle + RBAC (`claimLifecycle.e2e.test.ts`)
- ✅ TEAM_LEAD creates claim (seeded default status); USER → 403 `TEAM_LEAD_OR_ADMIN_REQUIRED`
- ✅ remark + status change persists transition and writes a remark
- ✅ terminal-status guard: TL out-of-terminal → 409 `TERMINAL_STATUS`; ADMIN override → 200
- ✅ USER (even assignee) reassign → 403 `REASSIGN_FORBIDDEN`
- ✅ scope: TL creating in another scope → 403 `OUT_OF_SCOPE`
- ✅ admin soft-delete hides claim from TL (404); restore re-enables (200)

### API — documents + validation (`documentsValidation.e2e.test.ts`)
- ✅ zero-doc claim → `POST /validate` (202) → poll → run `COMPLETED`, all 5 columns `DOCS_NOT_AVAILABLE`
- ⏭️ (E2E_HEAVY) upload PNG → 201 + listed → delete → 200; drain settles

### API — observations (`observations.e2e.test.ts`)
- ✅ import create (`parsed/created/updated/failed`); business fields persisted
- ✅ re-import same `claimId` → update, not create; dealer updated
- ✅ row missing Claim ID → `failed ≥ 1`, valid row still created
- ✅ export → canonical 10-col header + claim row present

### API — rules (`claimRules.e2e.test.ts`)
- ✅ create `DOCUMENT_COUNT GTE 1` rule → evaluate zero-doc claim → `passed=false`, `passedCount=0`
- ✅ create claim-id rule → duplicate per sub-category → 409 `RULE_EXISTS`

### UI smoke (`claims.smoke.spec.ts`)
- ✅ admin opens `/admin/claims` (not bounced to `/login`)
- ✅ `/claims` dashboard renders for the authenticated session

### Backlog (next iterations)
- Pagination/filter/search on list + `GET /claims/export` workbook assertions
- TEAM_LEAD scoped list visibility (only own scope) vs ADMIN global list
- Document content download (MIME/inline vs attachment), `documents/sync`
- Heavy validators (SPELL/QR/META/INTRA/FULL) against real fixture files —
  better as **service-level integration tests** (stub `registry`) than slow E2E
- UI journeys: create-claim dialog, add-remark + status change, observation
  upload dialog (require seeded sub-category + statuses)

---

## 5. How to run

### Prereqs (once)
```bash
# 1. Export the test-schema URL. Use the SAME credentials/host/port as your dev
#    DATABASE_URL (server/.env), only the database name differs (proxyapp_test).
#    For the local dev box that is root with an empty password on 127.0.0.1:3307:
export TEST_DATABASE_URL="mysql://root:@127.0.0.1:3307/proxyapp_test"

# 2. Apply the schema (creates the database if missing). Already provisioned once;
#    re-run only after a schema change.
DATABASE_URL="$TEST_DATABASE_URL" npm run db:push
```

> The `user`/`pass`/`localhost` form is a placeholder — copying it verbatim fails
> with `P1000: Authentication failed ... credentials for 'user' are not valid`.

### API E2E
```bash
npm run test:e2e:api          # jest --config jest.e2e.config.mjs (server)
E2E_HEAVY=1 npm run test:e2e:api   # also run OCR-backed upload spec
```

### UI E2E (Playwright)
```bash
npm i                          # ensures @playwright/test is installed
npx playwright install chromium
export E2E_DATABASE_URL="mysql://root:@127.0.0.1:3307/proxyapp_test"
# Stop `npm run dev` first — the UI suite starts its OWN stack on :5173/:3001
# bound to the test DB (reuseExistingServer=false), so a running dev server
# would either conflict on the port or point at the wrong DB.
npm run test:e2e:ui            # seeds e2e_admin (forcePasswordChange=false) → playwright
```
The default `db:seed` admin has `forcePasswordChange=true` (→ ProtectedRoute
bounces to /change-password), so the UI suite uses a dedicated `e2e_admin`
seeded by `db:seed:e2e` (chained inside `test:e2e:ui`). Override creds with
`E2E_ADMIN_USERNAME` / `E2E_ADMIN_PASSWORD` if desired.

### Everything
```bash
npm run test:e2e               # api then ui
```

### CI
`.github/workflows/e2e.yml` runs `api-e2e` and `ui-e2e` on push/PR with a MySQL 8
service container (`prisma db push` → run). `ui-e2e` additionally seeds the admin
and installs the Chromium browser.

---

## 6. Verification status

- ✅ `tsc --noEmit` clean (server + `e2e/`).
- ✅ `npm test` (unit) excludes `*.e2e.test.ts`; `test:e2e:api` lists exactly the 5 specs.
- ✅ **API executed green** against `proxyapp_test` (`mysql://root@127.0.0.1:3307/proxyapp_test`,
  created via `db:push`): **5 suites, 17 passed + 1 skipped**; with `E2E_HEAVY=1`
  the upload spec passes too (**18/18**). Run time ~14s.
- ✅ **UI executed green**: Playwright booted a fresh stack on the test DB,
  seeded `e2e_admin`, logged in via the real form, and both smoke specs pass
  (**2/2**). This also exercised the refactored `index.ts`/`createApp` startup
  path serving live requests.
- ⏳ **CI (`.github/workflows/e2e.yml`) not yet run on GitHub** — both jobs are
  unexecuted; logic mirrors the verified local flow but timing/service details
  are unproven until a push.

> Do not run any suite against the dev DB (truncation, see §2.2). A local
> `proxyapp_test` schema now exists on `127.0.0.1:3307` for re-runs.
