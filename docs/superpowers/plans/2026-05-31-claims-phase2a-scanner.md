# Claims Phase 2A — Claim Ingestion Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the existing `ClaimIdRule` config so an admin can press "Scan now" and a background job ingests `Claim` rows from the immediate children of `scanLocation`, idempotently (skip existing).

**Architecture:** In-process background runner + a `ScanJob` status table the UI polls. A `DirectoryReader` interface decouples the scan logic from the real filesystem (production uses `fs`; tests/macOS-dev use a fake), so everything is unit-testable on macOS. Claims are created by reusing Phase 1 `ClaimService.create` (default-status assignment, scope, duplicate handling) with a new trusted-folderPath option.

**Tech Stack:** Node 18 / Express 4 / TypeScript (NodeNext ESM) · Prisma 5 / MySQL (managed by `prisma db push`, **no migrations dir**) · React 18 / Vite / Tailwind · Jest + ts-jest for backend tests. `npm run lint` is NOT wired in this repo — `npx tsc --noEmit` per workspace is the static gate.

**Spec:** `docs/superpowers/specs/2026-05-31-claims-phase2a-scanner-design.md` (read this first).

---

## File Structure (locked in advance)

**Server — created:**
- `server/src/lib/directoryReader.ts` — `DirectoryReader` interface, `DirectoryEntry` type, `resolveScanRoot()` dev-remap helper
- `server/src/services/fsDirectoryReader.ts` — production `fs`-backed reader
- `server/src/services/scanService.ts` — `ScanService` (enqueue / run / sweepStaleJobs) + `ScanServiceError`
- `server/src/services/__tests__/fsDirectoryReader.test.ts`
- `server/src/services/__tests__/scanService.test.ts`
- `server/src/routes/admin/scans.ts` — `POST /scans`, `GET /scans/:id`, `GET /scans`

**Server — modified:**
- `server/prisma/schema.prisma` — add `ScanJobStatus` enum + `ScanJob` model + relations
- `server/src/services/claimService.ts` — add `opts.trustedFolderPath` to `create`
- `server/src/services/__tests__/claimSecurity.test.ts` — add a trusted-folderPath test
- `server/src/routes/admin/index.ts` — mount `/scans`
- `server/src/index.ts` — boot-time `sweepStaleJobs()`

**Client — modified:**
- `client/src/pages/admin/ClaimIdRules.tsx` — "Scan now" action + progress panel + scan history

---

## Phase A — Backend foundation

### Task 1: Add `ScanJob` schema + relations

**Files:**
- Modify: `server/prisma/schema.prisma`

- [ ] **Step 1: Add the `ScanJobStatus` enum** next to the other enums (after `ValidationStatus`):

```prisma
enum ScanJobStatus {
  QUEUED
  RUNNING
  COMPLETED
  FAILED
}
```

- [ ] **Step 2: Add the `ScanJob` model** at the bottom of the file (near the other claims models):

```prisma
model ScanJob {
  id            String        @id @default(uuid()) @db.VarChar(36)
  claimIdRuleId String        @map("claim_id_rule_id") @db.VarChar(36)
  subCategoryId String        @map("sub_category_id") @db.VarChar(36)
  status        ScanJobStatus @default(QUEUED)

  scanLocation  String        @map("scan_location") @db.VarChar(500)
  scanTarget    ScanTarget    @map("scan_target")

  totalEntries  Int           @default(0) @map("total_entries")
  createdCount  Int           @default(0) @map("created_count")
  skippedCount  Int           @default(0) @map("skipped_count")
  errorCount    Int           @default(0) @map("error_count")
  errors        Json?
  message       String?       @db.VarChar(500)

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

- [ ] **Step 3: Add back-relations** on the existing models. Inside `model ClaimIdRule { ... }`, above its closing brace, add:

```prisma
  scanJobs ScanJob[]
```

Inside `model SubCategory { ... }`, above its closing brace, add:

```prisma
  scanJobs ScanJob[]
```

- [ ] **Step 4: Validate the schema**

Run: `cd server && npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid`.

- [ ] **Step 5: Push to the DB and regenerate the client**

Run: `cd server && npm run db:push && npm run db:generate`
Expected: "Your database is now in sync with your Prisma schema." and the client regenerates (no migration files — this repo uses `db push`).

- [ ] **Step 6: Commit**

```bash
git add server/prisma/schema.prisma
git commit -m "feat(claims): add ScanJob model for ingestion scanner"
```

### Task 2: `DirectoryReader` interface + `resolveScanRoot`

**Files:**
- Create: `server/src/lib/directoryReader.ts`

- [ ] **Step 1: Create `server/src/lib/directoryReader.ts`**

```ts
import path from 'path';

export interface DirectoryEntry {
  name: string;
}

export interface DirectoryReader {
  /** Lists the immediate children of `absolutePath` matching the scan target. */
  list(absolutePath: string, target: 'FOLDER' | 'FILE'): Promise<DirectoryEntry[]>;
}

/**
 * In production the stored `scanLocation` (e.g. "D:\\Claims\\Daily") is read as-is.
 * In macOS dev those paths don't exist; set CLAIMS_SCAN_ROOT to a local folder and
 * the drive-letter prefix is stripped and re-rooted under it so a real reader works.
 */
export function resolveScanRoot(scanLocation: string): string {
  const override = process.env.CLAIMS_SCAN_ROOT;
  if (!override) return scanLocation;
  const withoutDrive = scanLocation.replace(/^[A-Za-z]:\\?/, '').replace(/\\/g, '/');
  return path.join(override, withoutDrive);
}
```

- [ ] **Step 2: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add server/src/lib/directoryReader.ts
git commit -m "feat(claims): DirectoryReader interface + dev scan-root remap"
```

### Task 3: `FsDirectoryReader` (production fs reader)

**Files:**
- Create: `server/src/services/fsDirectoryReader.ts`
- Test: `server/src/services/__tests__/fsDirectoryReader.test.ts`

- [ ] **Step 1: Write the failing test** `server/src/services/__tests__/fsDirectoryReader.test.ts`

```ts
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { FsDirectoryReader } from '../fsDirectoryReader.js';

describe('FsDirectoryReader', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-'));
    await fs.mkdir(path.join(dir, 'CLM00001_folder'));
    await fs.mkdir(path.join(dir, 'CLM00002_folder'));
    await fs.writeFile(path.join(dir, 'CLM00003_file.pdf'), 'x');
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lists only directories for FOLDER target', async () => {
    const names = (await new FsDirectoryReader().list(dir, 'FOLDER')).map((e) => e.name).sort();
    expect(names).toEqual(['CLM00001_folder', 'CLM00002_folder']);
  });

  it('lists only files for FILE target', async () => {
    const names = (await new FsDirectoryReader().list(dir, 'FILE')).map((e) => e.name);
    expect(names).toEqual(['CLM00003_file.pdf']);
  });
});
```

- [ ] **Step 2: Run it (expect failure)**

Run: `cd server && npm test -- fsDirectoryReader`
Expected: FAIL — "Cannot find module '../fsDirectoryReader.js'".

- [ ] **Step 3: Implement `server/src/services/fsDirectoryReader.ts`**

```ts
import { promises as fs } from 'fs';
import { DirectoryReader, DirectoryEntry } from '../lib/directoryReader.js';

export class FsDirectoryReader implements DirectoryReader {
  async list(absolutePath: string, target: 'FOLDER' | 'FILE'): Promise<DirectoryEntry[]> {
    const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
    return dirents
      .filter((d) => (target === 'FOLDER' ? d.isDirectory() : d.isFile()))
      .map((d) => ({ name: d.name }));
  }
}
```

- [ ] **Step 4: Run the test (expect pass)**

Run: `cd server && npm test -- fsDirectoryReader`
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/fsDirectoryReader.ts server/src/services/__tests__/fsDirectoryReader.test.ts
git commit -m "feat(claims): FsDirectoryReader with FOLDER/FILE filtering"
```

### Task 4: Add `trustedFolderPath` option to `ClaimService.create`

**Files:**
- Modify: `server/src/services/claimService.ts`
- Modify: `server/src/services/__tests__/claimSecurity.test.ts`

- [ ] **Step 1: Add the failing test** to `claimSecurity.test.ts` (inside the `describe`, after the existing `create accepts a valid drive-letter folderPath` test):

```ts
  it('create accepts a non-drive folderPath when trustedFolderPath is set (scanner)', async () => {
    await defaultStatus(scA);
    const c = await service.create(
      { subCategoryId: scA, claimId: 'C-TRUST', folderPath: '/tmp/scan/CLM' },
      adminId,
      'ALL',
      { trustedFolderPath: true }
    );
    expect(c.folderPath).toBe('/tmp/scan/CLM');
  });
```

- [ ] **Step 2: Run it (expect failure)**

Run: `cd server && npm test -- claimSecurity`
Expected: FAIL — `create` rejects with `INVALID_FOLDER_PATH` (the 4th arg is ignored / unknown), OR a transpile-level extra-arg that surfaces as the path still being validated. The assertion fails because the call throws.

- [ ] **Step 3: Add the `opts` parameter** in `server/src/services/claimService.ts`. Change the `create` signature and the folderPath guard.

Change the signature line:

```ts
  async create(
    input: CreateClaimInput,
    actorId: string,
    scope?: { userTypeId: string; projectId: string } | 'ALL'
  ): Promise<Claim> {
```

to:

```ts
  async create(
    input: CreateClaimInput,
    actorId: string,
    scope?: { userTypeId: string; projectId: string } | 'ALL',
    opts?: { trustedFolderPath?: boolean }
  ): Promise<Claim> {
```

Change the folderPath validation block:

```ts
    if (input.folderPath && input.folderPath.trim().length > 0) {
      validateFolderPath(input.folderPath);
    }
```

to:

```ts
    if (input.folderPath && input.folderPath.trim().length > 0 && !opts?.trustedFolderPath) {
      validateFolderPath(input.folderPath);
    }
```

- [ ] **Step 4: Run tests (expect pass)**

Run: `cd server && npm test -- claimSecurity`
Expected: PASS (all, including the new trusted-folderPath test). User-facing validation is unchanged because routes never pass `opts`.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/claimService.ts server/src/services/__tests__/claimSecurity.test.ts
git commit -m "feat(claims): trustedFolderPath option on ClaimService.create for scanner"
```

### Task 5: `ScanService.enqueue` (pre-checks + job row)

**Files:**
- Create: `server/src/services/scanService.ts`
- Test: `server/src/services/__tests__/scanService.test.ts`

- [ ] **Step 1: Write the failing test** `server/src/services/__tests__/scanService.test.ts`. This builds its own SubCategory + ClaimIdRule + default status + admin, and tears them down (same self-contained pattern as `claimSecurity.test.ts`).

```ts
import { PrismaClient } from '@prisma/client';
import { ScanService, ScanServiceError } from '../scanService.js';
import { StatusMasterService } from '../statusMasterService.js';
import { DirectoryReader, DirectoryEntry } from '../../lib/directoryReader.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

class FakeReader implements DirectoryReader {
  constructor(private names: string[]) {}
  async list(): Promise<DirectoryEntry[]> {
    return this.names.map((name) => ({ name }));
  }
}

describe('ScanService', () => {
  let prisma: PrismaClient;
  let statusService: StatusMasterService;
  let subCategoryId: string;
  let ruleId: string;
  let adminId: string;
  const SUF = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let utId: string;
  let ptId: string;
  let catId: string;

  async function makeRule() {
    const rule = await prisma.claimIdRule.create({
      data: {
        subCategoryId,
        startPosition: 1,
        length: 8,
        scanTarget: 'FOLDER',
        scanLocation: 'D:\\Claims\\Daily',
        createdBy: adminId,
        updatedBy: adminId,
      },
    });
    return rule.id;
  }

  beforeAll(async () => {
    prisma = getTestPrisma();
    statusService = new StatusMasterService(prisma);
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    if (!admin) throw new Error('Need an ADMIN user seeded');
    adminId = admin.id;
    const ut = await prisma.userType.create({ data: { name: `scan-ut-${SUF}` } });
    const pt = await prisma.project.create({ data: { name: `scan-pt-${SUF}` } });
    utId = ut.id;
    ptId = pt.id;
    const cat = await prisma.category.create({
      data: { name: `scan-cat-${SUF}`, userTypeId: utId, projectId: ptId },
    });
    catId = cat.id;
    const sc = await prisma.subCategory.create({
      data: { name: `scan-sc-${SUF}`, categoryId: catId },
    });
    subCategoryId = sc.id;
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    await prisma.scanJob.deleteMany({ where: { subCategoryId } });
    ruleId = await makeRule();
  });

  afterAll(async () => {
    await prisma.scanJob.deleteMany({ where: { subCategoryId } });
    await truncateClaimsTables(prisma);
    await prisma.subCategory.deleteMany({ where: { id: subCategoryId } });
    await prisma.category.deleteMany({ where: { id: catId } });
    await prisma.userType.deleteMany({ where: { id: utId } });
    await prisma.project.deleteMany({ where: { id: ptId } });
    await disconnectTestPrisma();
  });

  it('enqueue rejects when SubCategory has no active default status', async () => {
    const svc = new ScanService(prisma, new FakeReader([]));
    await expect(svc.enqueue(ruleId, adminId)).rejects.toMatchObject({ code: 'NO_DEFAULT_STATUS' });
  });

  it('enqueue creates a QUEUED job when a default status exists', async () => {
    await statusService.create({ subCategoryId, name: 'Pending', isDefault: true }, adminId);
    const svc = new ScanService(prisma, new FakeReader([]));
    const job = await svc.enqueue(ruleId, adminId);
    expect(job.status).toBe('QUEUED');
    expect(job.scanLocation).toBe('D:\\Claims\\Daily');
  });

  it('enqueue rejects a second concurrent scan for the same rule', async () => {
    await statusService.create({ subCategoryId, name: 'Pending', isDefault: true }, adminId);
    const svc = new ScanService(prisma, new FakeReader([]));
    await svc.enqueue(ruleId, adminId);
    await expect(svc.enqueue(ruleId, adminId)).rejects.toMatchObject({ code: 'SCAN_IN_PROGRESS' });
  });
});
```

- [ ] **Step 2: Run it (expect failure)**

Run: `cd server && npm test -- scanService`
Expected: FAIL — "Cannot find module '../scanService.js'".

- [ ] **Step 3: Create `server/src/services/scanService.ts`** with `enqueue` (the `run`/`sweepStaleJobs` methods are added in the next tasks, but include their full bodies now so the file is complete):

```ts
import { PrismaClient, Prisma, ScanJob } from '@prisma/client';
import path from 'path';
import { ClaimService, ClaimServiceError } from './claimService.js';
import { DirectoryReader, resolveScanRoot } from '../lib/directoryReader.js';

export class ScanServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const MAX_ERRORS = 100;
const FLUSH_EVERY = 50;

export class ScanService {
  constructor(private prisma: PrismaClient, private reader: DirectoryReader) {}

  async enqueue(claimIdRuleId: string, triggeredBy: string): Promise<ScanJob> {
    const rule = await this.prisma.claimIdRule.findUnique({
      where: { id: claimIdRuleId },
      include: { subCategory: true },
    });
    if (!rule) throw new ScanServiceError('RULE_NOT_FOUND', 'Claim ID Rule not found');
    if (rule.status !== 'ACTIVE') throw new ScanServiceError('RULE_INACTIVE', 'Claim ID Rule is inactive');
    if (rule.subCategory.status !== 'ACTIVE') {
      throw new ScanServiceError('RULE_INACTIVE', 'SubCategory is inactive');
    }

    const def = await this.prisma.statusMaster.findFirst({
      where: { subCategoryId: rule.subCategoryId, isDefault: true, status: 'ACTIVE' },
    });
    if (!def) throw new ScanServiceError('NO_DEFAULT_STATUS', 'SubCategory has no active default status');

    const live = await this.prisma.scanJob.findFirst({
      where: { claimIdRuleId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (live) throw new ScanServiceError('SCAN_IN_PROGRESS', 'A scan is already running for this rule');

    return this.prisma.scanJob.create({
      data: {
        claimIdRuleId,
        subCategoryId: rule.subCategoryId,
        status: 'QUEUED',
        scanLocation: rule.scanLocation,
        scanTarget: rule.scanTarget,
        triggeredBy,
      },
    });
  }

  async run(jobId: string): Promise<void> {
    const job = await this.prisma.scanJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    const rule = await this.prisma.claimIdRule.findUnique({ where: { id: job.claimIdRuleId } });
    if (!rule) {
      await this.prisma.scanJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', message: 'Rule no longer exists', finishedAt: new Date() },
      });
      return;
    }

    const claimService = new ClaimService(this.prisma);
    const errors: { entry: string; reason: string }[] = [];
    let created = 0;
    let skipped = 0;
    let errored = 0;
    const actorId = job.triggeredBy ?? '';
    const pushError = (entry: string, reason: string) => {
      errored++;
      if (errors.length < MAX_ERRORS) errors.push({ entry, reason });
    };

    try {
      await this.prisma.scanJob.update({
        where: { id: jobId },
        data: { status: 'RUNNING', startedAt: new Date() },
      });

      const root = resolveScanRoot(job.scanLocation);
      const entries = await this.reader.list(root, job.scanTarget);
      await this.prisma.scanJob.update({
        where: { id: jobId },
        data: { totalEntries: entries.length },
      });

      const start = rule.startPosition - 1;
      for (let i = 0; i < entries.length; i++) {
        const name = entries[i].name;
        if (name.length < start + rule.length) {
          pushError(name, 'NAME_TOO_SHORT');
        } else {
          const claimId = name.substring(start, start + rule.length).trim();
          if (!claimId) {
            pushError(name, 'EMPTY_CLAIM_ID');
          } else {
            const folderPath = path.win32.join(job.scanLocation, name);
            try {
              await claimService.create(
                { subCategoryId: job.subCategoryId, claimId, folderPath },
                actorId,
                'ALL',
                { trustedFolderPath: true }
              );
              created++;
            } catch (e) {
              if (e instanceof ClaimServiceError && e.code === 'DUPLICATE_CLAIM_ID') {
                skipped++;
              } else {
                pushError(name, e instanceof Error ? e.message : 'CREATE_FAILED');
              }
            }
          }
        }
        if ((i + 1) % FLUSH_EVERY === 0) {
          await this.prisma.scanJob.update({
            where: { id: jobId },
            data: {
              createdCount: created,
              skippedCount: skipped,
              errorCount: errored,
              errors: errors as unknown as Prisma.InputJsonValue,
            },
          });
        }
      }

      await this.prisma.scanJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          createdCount: created,
          skippedCount: skipped,
          errorCount: errored,
          errors: errors as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      });
    } catch (e) {
      await this.prisma.scanJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          createdCount: created,
          skippedCount: skipped,
          errorCount: errored,
          errors: errors as unknown as Prisma.InputJsonValue,
          message: e instanceof Error ? e.message : 'Scan failed',
          finishedAt: new Date(),
        },
      });
    }
  }

  async sweepStaleJobs(): Promise<number> {
    const res = await this.prisma.scanJob.updateMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'FAILED', message: 'Interrupted by server restart', finishedAt: new Date() },
    });
    return res.count;
  }
}
```

- [ ] **Step 4: Run the test (expect pass)**

Run: `cd server && npm test -- scanService`
Expected: PASS (3/3 for the enqueue tests written so far).

- [ ] **Step 5: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: clean. (If Prisma complains about the `errors` JSON write, the `as unknown as Prisma.InputJsonValue` cast above resolves it.)

- [ ] **Step 6: Commit**

```bash
git add server/src/services/scanService.ts server/src/services/__tests__/scanService.test.ts
git commit -m "feat(claims): ScanService.enqueue with pre-checks + ScanJob"
```

### Task 6: `ScanService.run` — ingestion + idempotency tests

The `run` body already exists from Task 5. This task adds the behavioural tests that prove it.

**Files:**
- Modify: `server/src/services/__tests__/scanService.test.ts`

- [ ] **Step 1: Add the failing tests** inside the `describe`, after the enqueue tests:

```ts
  it('run ingests new claims, counts skips and errors, and is idempotent', async () => {
    await statusService.create({ subCategoryId, name: 'Pending', isDefault: true }, adminId);
    // 2 valid (>=8 chars), 1 too-short, 1 valid → 3 creatable, 1 error.
    const reader = new FakeReader(['CLM00001', 'CLM00002', 'SHORT', 'CLM00003']);
    const svc = new ScanService(prisma, reader);

    const job1 = await svc.enqueue(ruleId, adminId);
    await svc.run(job1.id);
    const done1 = await prisma.scanJob.findUnique({ where: { id: job1.id } });
    expect(done1?.status).toBe('COMPLETED');
    expect(done1?.totalEntries).toBe(4);
    expect(done1?.createdCount).toBe(3);
    expect(done1?.skippedCount).toBe(0);
    expect(done1?.errorCount).toBe(1);
    expect(await prisma.claim.count({ where: { subCategoryId } })).toBe(3);

    // Re-scan: everything already exists → all skipped, no new claims.
    const job2 = await svc.enqueue(ruleId, adminId);
    await svc.run(job2.id);
    const done2 = await prisma.scanJob.findUnique({ where: { id: job2.id } });
    expect(done2?.createdCount).toBe(0);
    expect(done2?.skippedCount).toBe(3);
    expect(await prisma.claim.count({ where: { subCategoryId } })).toBe(3);
  });

  it('run stores the Windows folderPath on created claims', async () => {
    await statusService.create({ subCategoryId, name: 'Pending', isDefault: true }, adminId);
    const svc = new ScanService(prisma, new FakeReader(['CLM00009']));
    const job = await svc.enqueue(ruleId, adminId);
    await svc.run(job.id);
    const claim = await prisma.claim.findFirst({ where: { subCategoryId, claimId: 'CLM00009' } });
    expect(claim?.folderPath).toBe('D:\\Claims\\Daily\\CLM00009');
  });
```

- [ ] **Step 2: Run the tests (expect pass — `run` is already implemented)**

Run: `cd server && npm test -- scanService`
Expected: PASS (all 5). If any fail, fix `run` in `scanService.ts` (do not change the tests).

- [ ] **Step 3: Commit**

```bash
git add server/src/services/__tests__/scanService.test.ts
git commit -m "test(claims): ScanService.run ingestion + idempotency coverage"
```

### Task 7: `sweepStaleJobs` test

**Files:**
- Modify: `server/src/services/__tests__/scanService.test.ts`

- [ ] **Step 1: Add the failing test** inside the `describe`:

```ts
  it('sweepStaleJobs marks QUEUED/RUNNING jobs as FAILED', async () => {
    await statusService.create({ subCategoryId, name: 'Pending', isDefault: true }, adminId);
    const svc = new ScanService(prisma, new FakeReader([]));
    const job = await svc.enqueue(ruleId, adminId); // QUEUED
    const n = await svc.sweepStaleJobs();
    expect(n).toBeGreaterThanOrEqual(1);
    const swept = await prisma.scanJob.findUnique({ where: { id: job.id } });
    expect(swept?.status).toBe('FAILED');
    expect(swept?.message).toBe('Interrupted by server restart');
  });
```

- [ ] **Step 2: Run the test (expect pass — already implemented in Task 5)**

Run: `cd server && npm test -- scanService`
Expected: PASS (all 6).

- [ ] **Step 3: Commit**

```bash
git add server/src/services/__tests__/scanService.test.ts
git commit -m "test(claims): ScanService.sweepStaleJobs coverage"
```

### Task 8: Admin routes for scans + mount + boot sweep

**Files:**
- Create: `server/src/routes/admin/scans.ts`
- Modify: `server/src/routes/admin/index.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Create `server/src/routes/admin/scans.ts`**

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { body, param, query, validationResult } from 'express-validator';
import { ScanService, ScanServiceError } from '../../services/scanService.js';
import { FsDirectoryReader } from '../../services/fsDirectoryReader.js';

const router = Router();

const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: errors.array()[0]?.msg || 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: errors.array(),
    });
  }
  next();
};

const getService = (req: Request) =>
  new ScanService(req.app.get('prisma') as PrismaClient, new FsDirectoryReader());

const handleErr = (err: unknown, res: Response, next: NextFunction) => {
  if (err instanceof ScanServiceError) {
    const status =
      err.code === 'RULE_NOT_FOUND' ? 404 : err.code === 'SCAN_IN_PROGRESS' ? 409 : 400;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  next(err);
};

router.post(
  '/',
  [body('claimIdRuleId').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const svc = getService(req);
      const job = await svc.enqueue(req.body.claimIdRuleId, req.session!.userId);
      // Fire-and-forget; progress is polled via GET /scans/:id.
      void svc.run(job.id);
      res.status(202).json({ data: { jobId: job.id } });
    } catch (err) {
      handleErr(err, res, next);
    }
  }
);

router.get(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const job = await prisma.scanJob.findUnique({ where: { id: req.params.id } });
      if (!job) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      res.json({ data: job });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/',
  [
    query('subCategoryId').optional().isUUID(),
    query('claimIdRuleId').optional().isUUID(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const page = (req.query.page as unknown as number) ?? 1;
      const limit = (req.query.limit as unknown as number) ?? 20;
      const where: Prisma.ScanJobWhereInput = {};
      if (req.query.subCategoryId) where.subCategoryId = req.query.subCategoryId as string;
      if (req.query.claimIdRuleId) where.claimIdRuleId = req.query.claimIdRuleId as string;
      const [data, total] = await Promise.all([
        prisma.scanJob.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.scanJob.count({ where }),
      ]);
      res.json({
        data,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
```

- [ ] **Step 2: Mount in `server/src/routes/admin/index.ts`**

Add near the other admin route imports:

```ts
import scansRoutes from './scans.js';
```

Add below the `router.use('/claims', claimsRoutes);` line:

```ts
router.use('/scans', scansRoutes);
```

- [ ] **Step 3: Add the boot-time stale-job sweep in `server/src/index.ts`**

Locate where the Prisma client is created and attached (search for `app.set('prisma'`). After the app has the prisma client and before/right after `app.listen(...)`, add:

```ts
import { ScanService } from './services/scanService.js';
import { FsDirectoryReader } from './services/fsDirectoryReader.js';

// On startup, fail any scan jobs orphaned by a previous shutdown (in-process runner).
new ScanService(prisma, new FsDirectoryReader())
  .sweepStaleJobs()
  .then((n) => {
    if (n > 0) console.log(`Swept ${n} stale scan job(s) to FAILED on startup.`);
  })
  .catch((e) => console.error('Stale scan-job sweep failed:', e));
```

Use the same `prisma` variable name already present in `index.ts` (the one passed to `app.set('prisma', ...)`). Put the two `import` lines with the other top-of-file imports.

- [ ] **Step 4: Type-check + run full test suite**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass.

- [ ] **Step 5: Re-seed** (the test run truncated the claims tables)

Run: `npm run db:seed`
Expected: "Seed completed successfully!"

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/admin/scans.ts server/src/routes/admin/index.ts server/src/index.ts
git commit -m "feat(claims): admin scan routes + boot-time stale-job sweep"
```

---

## Phase B — Frontend

### Task 9: "Scan now" action + progress panel + history in ClaimIdRules

**Files:**
- Modify: `client/src/pages/admin/ClaimIdRules.tsx`

- [ ] **Step 1: Add the scan icon to the lucide-react import.** Change:

```tsx
import { MoreHorizontal, Plus, Pencil, Trash2, Power, PowerOff } from 'lucide-react';
```

to:

```tsx
import { MoreHorizontal, Plus, Pencil, Trash2, Power, PowerOff, ScanLine } from 'lucide-react';
```

- [ ] **Step 2: Add a `ScanJobView` type** right after the `Rule` interface (around line 39):

```tsx
interface ScanJobView {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  totalEntries: number;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  message: string | null;
  errors: { entry: string; reason: string }[] | null;
}
```

- [ ] **Step 3: Add scan state + polling + handler** inside the component, right after the `handleToggle` function (after line 150):

```tsx
  const [scanJob, setScanJob] = useState<ScanJobView | null>(null);
  const [scanRuleId, setScanRuleId] = useState<string | null>(null);

  useEffect(() => {
    if (!scanJob || scanJob.status === 'COMPLETED' || scanJob.status === 'FAILED') return;
    const t = setInterval(async () => {
      try {
        const r = await api.get<{ data: ScanJobView }>(`/admin/scans/${scanJob.id}`);
        setScanJob(r.data);
        if (r.data.status === 'COMPLETED') {
          toast({
            title: 'Scan complete',
            description: `Created ${r.data.createdCount}, skipped ${r.data.skippedCount}, ${r.data.errorCount} error(s).`,
          });
          fetchData(pagination.page, pagination.limit);
        } else if (r.data.status === 'FAILED') {
          toast({
            title: 'Scan failed',
            variant: 'destructive',
            description: r.data.message ?? 'Unknown error',
          });
        }
      } catch {
        // transient poll error; keep polling
      }
    }, 1500);
    return () => clearInterval(t);
  }, [scanJob, pagination.page, pagination.limit]);

  const handleScan = async (rule: Rule) => {
    setScanRuleId(rule.id);
    try {
      const r = await api.post<{ data: { jobId: string } }>('/admin/scans', {
        claimIdRuleId: rule.id,
      });
      const job = await api.get<{ data: ScanJobView }>(`/admin/scans/${r.data.jobId}`);
      setScanJob(job.data);
    } catch (e) {
      setScanRuleId(null);
      toast({
        title: 'Could not start scan',
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Failed',
      });
    }
  };
```

- [ ] **Step 4: Add a "Scan now" item to the row action menu.** In the `actions` column, immediately after the `Edit` `DropdownMenuItem` (after its closing `</DropdownMenuItem>`, before the Activate/Deactivate item), insert:

```tsx
            <DropdownMenuItem
              disabled={row.original.status !== 'ACTIVE'}
              onClick={() => handleScan(row.original)}
            >
              <ScanLine className="mr-2 h-4 w-4" />
              Scan now
            </DropdownMenuItem>
```

- [ ] **Step 5: Render the progress panel** above the `<DataTable .../>` (between the SubCategoryPicker `</div>` block and `<DataTable`):

```tsx
      {scanJob && (
        <div className="mb-4 p-4 bg-white border rounded-md">
          <div className="flex items-center justify-between">
            <p className="font-medium">
              Scan {scanJob.status === 'RUNNING' || scanJob.status === 'QUEUED' ? 'in progress' : scanJob.status.toLowerCase()}
              {scanRuleId ? '' : ''}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setScanJob(null);
                setScanRuleId(null);
              }}
            >
              Dismiss
            </Button>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {scanJob.createdCount + scanJob.skippedCount + scanJob.errorCount} / {scanJob.totalEntries} processed
            {' · '}created {scanJob.createdCount} · skipped {scanJob.skippedCount} · errors {scanJob.errorCount}
          </p>
          {scanJob.status === 'FAILED' && scanJob.message && (
            <p className="text-sm text-destructive mt-1">{scanJob.message}</p>
          )}
        </div>
      )}
```

- [ ] **Step 6: Type-check**

Run: `cd client && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/admin/ClaimIdRules.tsx
git commit -m "feat(claims): Scan now action + progress panel in ClaimIdRules"
```

---

## Phase C — Verification

### Task 10: End-to-end verification

- [ ] **Step 1: Backend green**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: tsc clean; all suites pass (existing 40 + fsDirectoryReader 2 + scanService 6 + the trusted-folderPath test).

- [ ] **Step 2: Re-seed** (tests truncate claims tables)

Run: `npm run db:seed`
Expected: success.

- [ ] **Step 3: Frontend green**

Run: `cd client && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Manual smoke (macOS dev via fixture)**

```bash
mkdir -p /tmp/claimroot/Claims/Daily/CLM00021_x /tmp/claimroot/Claims/Daily/CLM00022_y
CLAIMS_SCAN_ROOT=/tmp/claimroot npm run dev
```
Log in as admin → Claim ID Rules → ensure a rule exists for an ACTIVE SubCategory that has an active default status with `scanLocation = D:\Claims\Daily`, `scanTarget = FOLDER`, `startPosition = 1`, `length = 8`. Open the row menu → **Scan now**. Confirm the progress panel shows `created 2`, then check **Claims (All)** filtered to that SubCategory shows `CLM00021`/`CLM00022`. Click **Scan now** again → both **skipped** (idempotent).

- [ ] **Step 5: Final commit (if any working-tree changes remain)**

```bash
git status
```
Expected: clean (everything already committed task-by-task).

---

## Self-Review (completed during plan writing)

- **Spec coverage:** ScanJob model (Task 1) ✓ · DirectoryReader + dev remap (Task 2) ✓ · FsDirectoryReader (Task 3) ✓ · trustedFolderPath (Task 4) ✓ · enqueue pre-checks incl. NO_DEFAULT_STATUS/SCAN_IN_PROGRESS (Task 5) ✓ · run algorithm w/ NAME_TOO_SHORT, EMPTY_CLAIM_ID, idempotent skip, win32 folderPath, periodic flush (Tasks 5–6) ✓ · sweepStaleJobs + boot sweep (Tasks 5,7,8) ✓ · admin routes 202/poll/list (Task 8) ✓ · UI Scan now + progress + history-via-poll (Task 9) ✓ · testing on macOS via fakes/fixtures (Tasks 3,5–7,10) ✓.
- **Placeholder scan:** none — every code step contains complete code.
- **Type consistency:** `ScanService(prisma, reader)` constructor, `enqueue(ruleId, triggeredBy)`, `run(jobId)`, `sweepStaleJobs()`, `DirectoryReader.list(path, target)`, `ScanJobView` fields, and `create(..., opts)` match across tasks.
- **Note:** Scan history list (spec §7) is delivered via `GET /scans` + the live progress panel; a persistent per-rule history table in the UI is left as a spec §9 open item and can be added later without rework.
