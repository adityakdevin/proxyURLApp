# Claims Management Phase 2A — Claim Ingestion Scanner Design

**Status:** Draft for review
**Date:** 2026-05-31
**Author:** Aditya Kumar (with Claude)
**Scope:** Filesystem scanner that turns `ClaimIdRule` configuration into ingested `Claim` rows. First sub-project of Phase 2.

---

## 0. Executive Summary

Phase 1 shipped the `ClaimIdRule` master (start position, length, scan target, scan location) as **configuration only** — nothing reads the disk. Phase 2A activates it: an admin presses **Scan now** for a rule, and a **background job** enumerates the immediate children of `scanLocation`, extracts a Claim ID from each folder/file name, and **idempotently creates** `Claim` rows (skipping ones that already exist). Progress is tracked in a `ScanJob` table the UI polls.

This is the foundation the rest of Phase 2 builds on — without ingested claims there is nothing to attach documents to (2B) or validate (2C/2D).

### Decisions locked during brainstorming (2026-05-31)

| Topic | Decision |
|-------|----------|
| Execution host | Production = Node/Express on **Windows** with direct `fs` access to the drive (e.g. `D:\`). Development = **macOS** (real paths won't resolve → must be testable without them). |
| Trigger | **Manual "Scan now"** per rule. No scheduler, no folder watcher. |
| On-disk layout | **Immediate children, non-recursive.** `scanTarget = FOLDER` → each immediate sub-folder is one claim; `FILE` → each file directly under `scanLocation` is one claim. |
| Re-scan semantics | **Idempotent: skip existing, create only new.** Re-scanning is always safe. |
| Scale | **Thousands+** entries per scan → background job + progress polling (not a synchronous response). |
| Execution mechanism | **In-process background runner + `ScanJob` status table.** No Redis/queue (work is I/O-bound; lean ops consistent with the project). |
| Permissions | **Admin-only** for Phase 2A (scanning operates on admin-managed rule config). Team-Lead-scoped scanning is explicitly deferred. |

### Out of scope (Phase 2A boundary)

- No document association / upload / classification (Phase 2B).
- No validators — the 5 validation columns stay `PENDING` (Phase 2C/2D).
- No scheduled/cron scans, no real-time folder watching.
- No recursive directory walking.
- No external job queue (BullMQ/Redis), no multi-worker scaling.
- No update/delete of existing claims from a scan (skip-only).
- No moving/renaming/deleting of files on disk — the scanner is **read-only** against the filesystem.

---

## 1. Architecture

A new, self-contained ingestion module alongside the Phase 1 claims code. It **reuses** `ClaimService.create` for claim creation (so default-status assignment, scope rules, and duplicate handling stay in one place) and **does not** touch the proxy module.

```
server/src/
├── services/
│   ├── scanService.ts          (new — orchestrates a scan run)
│   └── fsDirectoryReader.ts    (new — production fs implementation of DirectoryReader)
├── lib/
│   └── directoryReader.ts      (new — DirectoryReader interface + dev path remap)
├── routes/admin/
│   └── scans.ts                (new — POST /scans, GET /scans/:id, GET /scans)
└── (modified) claimService.ts  (add trusted folderPath path for scanner-created claims)
                index.ts         (mount /api/admin/scans; run restart sweep on boot)
                prisma/schema.prisma (add ScanJob + relations)
                prisma/seed.ts   (optional: no change required)

client/src/
└── pages/admin/ClaimIdRules.tsx (modified — "Scan now" action + progress panel + history)
```

### The testability seam (`DirectoryReader`)

```ts
export interface DirectoryEntry { name: string; }
export interface DirectoryReader {
  // Lists immediate children of `absolutePath` matching the scan target.
  list(absolutePath: string, target: 'FOLDER' | 'FILE'): Promise<DirectoryEntry[]>;
}
```

- **Production:** `FsDirectoryReader` uses `fs.promises.readdir(path, { withFileTypes: true })` and filters to directories (FOLDER) or files (FILE).
- **Tests / macOS dev:** a fake reader returns a fixed list of names — **no real filesystem required**, so the scan logic is fully unit-testable on macOS.
- **Dev path remap:** an optional `CLAIMS_SCAN_ROOT` env var redirects a Windows `scanLocation` to a local folder so the real `FsDirectoryReader` can be exercised on macOS if desired. When unset, the raw `scanLocation` is used.

---

## 2. Data model (Prisma — applied via `npm run db:push`)

> This project manages schema with `prisma db push` (no migrations directory). Apply with `db:push` then `db:generate`.

```prisma
enum ScanJobStatus {
  QUEUED
  RUNNING
  COMPLETED
  FAILED
}

model ScanJob {
  id            String        @id @default(uuid()) @db.VarChar(36)
  claimIdRuleId String        @map("claim_id_rule_id") @db.VarChar(36)
  subCategoryId String        @map("sub_category_id") @db.VarChar(36)
  status        ScanJobStatus @default(QUEUED)

  // Snapshot of the rule at run time (rule may change later).
  scanLocation  String        @map("scan_location") @db.VarChar(500)
  scanTarget    ScanTarget    @map("scan_target")

  totalEntries  Int           @default(0) @map("total_entries")
  createdCount  Int           @default(0) @map("created_count")
  skippedCount  Int           @default(0) @map("skipped_count")
  errorCount    Int           @default(0) @map("error_count")
  errors        Json?         // [{ entry: string, reason: string }], capped at 100
  message       String?       @db.VarChar(500) // failure reason when FAILED

  startedAt     DateTime?     @map("started_at")
  finishedAt    DateTime?     @map("finished_at")
  createdAt     DateTime      @default(now()) @map("created_at")
  triggeredBy   String?       @map("triggered_by") @db.VarChar(36)

  claimIdRule   ClaimIdRule   @relation(fields: [claimIdRuleId], references: [id], onDelete: Cascade)
  subCategory   SubCategory   @relation(fields: [subCategoryId], references: [id])

  @@index([subCategoryId])
  @@index([claimIdRuleId])
  @@index([status])
  @@map("scan_jobs")
}
```

Back-relations to add:

```prisma
model ClaimIdRule { /* ... */ scanJobs ScanJob[] }
model SubCategory { /* ... */ scanJobs ScanJob[] }
```

Notes:
- `errors` is a capped JSON array (first 100 problem entries) so a bad scan can't bloat the row.
- `scanLocation`/`scanTarget` are snapshotted onto the job so history stays meaningful if the rule is later edited.

---

## 3. ScanService

```ts
class ScanService {
  constructor(prisma: PrismaClient, reader: DirectoryReader) {}

  // Validates + creates the job row, returns it as QUEUED. Throws ScanServiceError
  // (SCAN_IN_PROGRESS, RULE_NOT_FOUND, RULE_INACTIVE, NO_DEFAULT_STATUS) on pre-check failure.
  async enqueue(claimIdRuleId: string, triggeredBy: string): Promise<ScanJob>;

  // Runs the scan to completion, updating the job row. Never throws to the caller
  // (failures are recorded on the job as FAILED). Intended to be called un-awaited.
  async run(jobId: string): Promise<void>;

  // Boot-time recovery: mark any RUNNING/QUEUED job FAILED ("interrupted by restart").
  async sweepStaleJobs(): Promise<number>;
}
```

### 3.1 `enqueue` pre-checks (fail fast, surfaced as HTTP 4xx)

1. Rule exists and is `ACTIVE` → else `RULE_NOT_FOUND` (404) / `RULE_INACTIVE` (400).
2. SubCategory `ACTIVE`.
3. SubCategory has an active default `StatusMaster` → else `NO_DEFAULT_STATUS` (400). (Claims can't be created without it.)
4. No `QUEUED`/`RUNNING` `ScanJob` for this rule → else `SCAN_IN_PROGRESS` (409).

On success: insert `ScanJob` (`QUEUED`, snapshot `scanLocation`/`scanTarget`, `triggeredBy`).

### 3.2 `run` algorithm

1. Set `RUNNING` + `startedAt`.
2. Resolve the scan root: `CLAIMS_SCAN_ROOT`-remapped path in dev, else raw `scanLocation`.
3. `entries = reader.list(root, scanTarget)`; set `totalEntries`.
4. For each `entry.name`:
   - `start = startPosition - 1` (rule positions are 1-indexed); if `name.length < start + length` → record `{ entry, reason: 'NAME_TOO_SHORT' }`, `errorCount++`, continue.
   - `claimId = name.substring(start, start + length).trim()`; if empty → `errorCount++` (`EMPTY_CLAIM_ID`), continue.
   - `folderPath = join(scanLocation, name)` (the **stored** Windows path, not the dev-remapped one).
   - Idempotent create via `ClaimService.create({ subCategoryId, claimId, folderPath }, triggeredBy, 'ALL', { trustedFolderPath: true })`:
     - success → `createdCount++`
     - `DUPLICATE_CLAIM_ID` → `skippedCount++`
     - any other error → `errorCount++` with reason.
   - Flush counts to the row every ~50 entries.
5. On normal completion: `COMPLETED` + `finishedAt` + final counts.
6. On unexpected throw (e.g. path missing, permission denied): `FAILED` + `message` + `finishedAt`.

### 3.3 The `trustedFolderPath` option on `ClaimService.create`

Phase 1's `create` validates `folderPath` against the drive-letter rule (rejecting non-`[A-Za-z]:\` and `C:\`). Scanner-generated paths originate from an already-validated `scanLocation`, and in **dev** the resolved path may be a macOS path. So `create` gains an internal options arg:

```ts
create(input, actorId, scope?, opts?: { trustedFolderPath?: boolean })
```

When `opts.trustedFolderPath` is true, the `folderPath` validation is skipped. User-facing routes never set this flag, so user input stays validated. (Default behaviour unchanged.)

---

## 4. API surface (all under `adminMiddleware`)

```
POST   /api/admin/scans
       Body: { claimIdRuleId: string (uuid) }
       → 202 { data: { jobId } }
       → 409 { code: 'SCAN_IN_PROGRESS' } | 400 { code: 'NO_DEFAULT_STATUS' | 'RULE_INACTIVE' } | 404 { code: 'RULE_NOT_FOUND' }

GET    /api/admin/scans/:id
       → 200 { data: ScanJob }  (status + live counts + errors)

GET    /api/admin/scans?subCategoryId=&claimIdRuleId=&page=&limit=
       → 200 { data: ScanJob[], pagination }  (newest first)
```

`POST` calls `enqueue`, then fires `run(jobId)` **un-awaited** (`void scanService.run(jobId)`), and responds `202` immediately. Prisma errors map through the central handler (P2002→409, P2025→404) added in the Phase 1 hardening pass.

---

## 5. Lifecycle & concurrency

- **One live scan per rule** — enforced in `enqueue` (`SCAN_IN_PROGRESS`).
- **Restart recovery** — `index.ts` calls `scanService.sweepStaleJobs()` on boot; in-process jobs don't survive a restart, so any `RUNNING`/`QUEUED` row is marked `FAILED` with `message = 'Interrupted by server restart'`. (Re-scan is safe because ingestion is idempotent.)
- **Single process assumption** — valid: one Node server on one Windows host. Documented so a future move to multi-instance triggers a queue (Approach 2) instead.

---

## 6. Error handling

| Situation | Handling |
|-----------|----------|
| Folder/file name too short for the rule | per-entry `errorCount++`, reason `NAME_TOO_SHORT`, scan continues |
| Extracted Claim ID empty after trim | per-entry `errorCount++`, reason `EMPTY_CLAIM_ID` |
| Claim already exists | `skippedCount++` (not an error) |
| Other per-claim create error | `errorCount++` with the error code/message |
| `scanLocation` missing / permission denied | whole job `FAILED` + `message` |
| SubCategory has no active default status | `enqueue` rejects (`NO_DEFAULT_STATUS`), no job runs |
| Server restart mid-scan | boot sweep → job `FAILED`; user re-scans (idempotent) |

Per-entry errors are recorded in `errors` (capped at 100; if exceeded, a final note records the overflow count).

---

## 7. Admin UI (`ClaimIdRules.tsx`)

- Each rule row gains a **Scan now** action.
- Clicking it `POST`s a scan and opens a **progress panel** that polls `GET /scans/:id` (~every 1.5s): a progress bar of `processed (created+skipped+errored) / totalEntries`, plus live `created / skipped / errored` counts.
- On `COMPLETED`: a summary toast ("Created X, skipped Y, Z errors") and a link to **Claims (All)** filtered to that SubCategory. On `FAILED`: show `message`.
- A compact **scan history** (last few `ScanJob`s for the rule) with status, counts, and timestamp.
- Errors list (first N) viewable for a finished job.

---

## 8. Testing approach

### 8.1 Backend (Jest, fully runnable on macOS)
`scanService` is tested with a **fake `DirectoryReader`** (returns a chosen list of names) — no real filesystem. Tests build a self-contained SubCategory + default status + actor (reusing the fixture/teardown pattern from `claimSecurity.test.ts`) and assert:
- Mixed input (valid names, too-short names, an already-existing claim) → exact `createdCount / skippedCount / errorCount` and that the expected `Claim` rows exist with `folderPath` set.
- **Idempotency**: running the same scan twice → second run is all-skipped, no duplicate claims.
- `NO_DEFAULT_STATUS`: `enqueue` rejects; no job created.
- `SCAN_IN_PROGRESS`: a second `enqueue` while one is live is rejected.
- `sweepStaleJobs` flips a seeded `RUNNING` job to `FAILED`.
- `FsDirectoryReader` gets a thin test against a real temp dir (`os.tmpdir()`), confirming FOLDER vs FILE filtering — cross-platform, so it runs on macOS too.

### 8.2 Type-check
`npx tsc --noEmit` clean in both workspaces. (`npm run lint` is not wired in this repo — `tsc` is the static gate.)

### 8.3 Manual (production-like) verification
On a Windows host (or via `CLAIMS_SCAN_ROOT` pointed at a local fixture tree on macOS): create a rule, drop sample folders, click **Scan now**, watch progress, confirm claims appear in **Claims (All)**, re-scan to confirm skip-only.

---

## 9. Open items for the implementation plan

- Exact poll interval / backoff and whether the progress panel is a modal or inline.
- Whether to expose the per-entry `errors` list inline or behind a "view errors" expander.
- `flush every ~50 entries` cadence (tune for thousands of rows vs. DB write volume).
- Whether `GET /scans` history is per-rule only or also a global admin view.

These are small enough to settle during plan-writing or implementation without changing the design.
