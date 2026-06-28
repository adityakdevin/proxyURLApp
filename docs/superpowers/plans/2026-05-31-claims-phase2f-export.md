# Claims Phase 2F — Claims Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An "Export" button on the Claim Dashboard and Admin Claims downloads an `.xlsx` of the claims matching the caller's scope + current filters (all rows, not one page).

**Architecture:** `ClaimService.exportRows(filters)` returns all scoped+filtered claims (one query, no pagination, capped) as flat `ExportRow`s; `claimReportService.buildClaimsWorkbook(rows)` turns them into an `exceljs` workbook (pure, testable); `GET /api/claims/export` streams it. UI buttons build the filter query string and trigger a cookie-authenticated download.

**Tech Stack:** Node/Express/TS (NodeNext ESM) · Prisma 5 / MySQL · `exceljs` (new dep) · React 18 / Vite. Static gate: `npx tsc --noEmit` per workspace.

**Spec:** `docs/superpowers/specs/2026-05-31-claims-phase2f-export-design.md`.

---

## File Structure (locked in advance)

**Server — created:** `server/src/services/claimReportService.ts` · tests `services/__tests__/claimReportService.test.ts`, `services/__tests__/claimExport.test.ts`
**Server — modified:** `server/src/services/claimService.ts` (`buildWhere` extract + `ExportRow` + `exportRows`) · `server/src/routes/claims.ts` (`GET /export`) · `server/package.json` (exceljs)
**Client — modified:** `client/src/pages/claims/ClaimDashboard.tsx` · `client/src/pages/admin/AdminClaims.tsx`

---

## Task 1: `ClaimService.exportRows` (+ shared `buildWhere`)

**Files:** Modify `server/src/services/claimService.ts`; Test `server/src/services/__tests__/claimExport.test.ts`

- [ ] **Step 1: Write the failing test** `server/src/services/__tests__/claimExport.test.ts` (self-contained fixtures across two scopes; asserts scope filtering + resolved fields).

```ts
import { PrismaClient } from '@prisma/client';
import { ClaimService } from '../claimService.js';
import { StatusMasterService } from '../statusMasterService.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

describe('ClaimService.exportRows', () => {
  let prisma: PrismaClient;
  let service: ClaimService;
  let statusService: StatusMasterService;
  let adminId: string;
  const SUF = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let utA: string; let ptA: string; let scA: string;
  let utB: string; let ptB: string; let scB: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    service = new ClaimService(prisma);
    statusService = new StatusMasterService(prisma);
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    adminId = admin!.id;
    const [a, b, pa, pb] = await Promise.all([
      prisma.userType.create({ data: { name: `ex-utA-${SUF}` } }),
      prisma.userType.create({ data: { name: `ex-utB-${SUF}` } }),
      prisma.projectType.create({ data: { name: `ex-ptA-${SUF}` } }),
      prisma.projectType.create({ data: { name: `ex-ptB-${SUF}` } }),
    ]);
    utA = a.id; utB = b.id; ptA = pa.id; ptB = pb.id;
    const catA = await prisma.category.create({ data: { name: `ex-catA-${SUF}`, userTypeId: utA, projectTypeId: ptA } });
    const catB = await prisma.category.create({ data: { name: `ex-catB-${SUF}`, userTypeId: utB, projectTypeId: ptB } });
    scA = (await prisma.subCategory.create({ data: { name: `ex-scA-${SUF}`, categoryId: catA.id } })).id;
    scB = (await prisma.subCategory.create({ data: { name: `ex-scB-${SUF}`, categoryId: catB.id } })).id;
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    const defA = await statusService.create({ subCategoryId: scA, name: 'Pending', isDefault: true }, adminId);
    const defB = await statusService.create({ subCategoryId: scB, name: 'Pending', isDefault: true }, adminId);
    await prisma.claim.create({ data: { claimId: 'EX-A1', subCategoryId: scA, workflowStatusId: defA.id, createdBy: adminId, updatedBy: adminId } });
    await prisma.claim.create({ data: { claimId: 'EX-B1', subCategoryId: scB, workflowStatusId: defB.id, createdBy: adminId, updatedBy: adminId } });
  });

  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await prisma.subCategory.deleteMany({ where: { id: { in: [scA, scB] } } });
    await prisma.category.deleteMany({ where: { userTypeId: { in: [utA, utB] } } });
    await prisma.userType.deleteMany({ where: { id: { in: [utA, utB] } } });
    await prisma.projectType.deleteMany({ where: { id: { in: [ptA, ptB] } } });
    await disconnectTestPrisma();
  });

  it('ADMIN scope ALL exports both claims with resolved fields', async () => {
    const rows = await service.exportRows({ scope: 'ALL' });
    const ours = rows.filter((r) => r.claimId === 'EX-A1' || r.claimId === 'EX-B1');
    expect(ours.length).toBe(2);
    const a = ours.find((r) => r.claimId === 'EX-A1')!;
    expect(a.workflowStatus).toBe('Pending');
    expect(a.assignedTo).toBe('Unassigned');
    expect(a.documents).toBe(0);
    expect(a.spell).toBe('PENDING');
    expect(typeof a.created).toBe('string');
  });

  it('TEAM_LEAD scope returns only in-scope claims', async () => {
    const rows = await service.exportRows({ scope: { userTypeId: utA, projectTypeId: ptA } });
    const ids = rows.map((r) => r.claimId);
    expect(ids).toContain('EX-A1');
    expect(ids).not.toContain('EX-B1');
  });

  it('applies the search filter', async () => {
    const rows = await service.exportRows({ scope: 'ALL', search: 'EX-A' });
    expect(rows.some((r) => r.claimId === 'EX-A1')).toBe(true);
    expect(rows.some((r) => r.claimId === 'EX-B1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run (expect fail)** — `cd server && npm test -- claimExport` → FAIL (`exportRows` undefined).

- [ ] **Step 3: Refactor `list`'s where into `buildWhere`, add `ExportRow` + `exportRows`.** In `server/src/services/claimService.ts`:

First add the export-row type near the other interfaces (after `ListClaimsFilters`):

```ts
export interface ExportRow {
  claimId: string;
  subCategory: string;
  category: string;
  workflowStatus: string;
  assignedTo: string;
  spell: string;
  qr: string;
  meta: string;
  intra: string;
  full: string;
  documents: number;
  created: string;
}

const EXPORT_MAX = 50000;
```

In the `list` method, replace its inline `where` construction:

```ts
    const where: Prisma.ClaimWhereInput = { status: 'ACTIVE' };
    if (filters.subCategoryId) where.subCategoryId = filters.subCategoryId;
    if (filters.workflowStatusId) where.workflowStatusId = filters.workflowStatusId;
    if (filters.assignedToUserId) where.assignedToUserId = filters.assignedToUserId;
    if (filters.assignedToMe && filters.callerId) where.assignedToUserId = filters.callerId;
    if (filters.search) where.claimId = { contains: filters.search };
    if (filters.scope && filters.scope !== 'ALL') {
      where.subCategory = {
        category: {
          userTypeId: filters.scope.userTypeId,
          projectTypeId: filters.scope.projectTypeId,
        },
      };
    }
```

with:

```ts
    const where = this.buildWhere(filters);
```

Add the `buildWhere` private method and `exportRows` (place after `list`):

```ts
  private buildWhere(filters: ListClaimsFilters): Prisma.ClaimWhereInput {
    const where: Prisma.ClaimWhereInput = { status: 'ACTIVE' };
    if (filters.subCategoryId) where.subCategoryId = filters.subCategoryId;
    if (filters.workflowStatusId) where.workflowStatusId = filters.workflowStatusId;
    if (filters.assignedToUserId) where.assignedToUserId = filters.assignedToUserId;
    if (filters.assignedToMe && filters.callerId) where.assignedToUserId = filters.callerId;
    if (filters.search) where.claimId = { contains: filters.search };
    if (filters.scope && filters.scope !== 'ALL') {
      where.subCategory = {
        category: {
          userTypeId: filters.scope.userTypeId,
          projectTypeId: filters.scope.projectTypeId,
        },
      };
    }
    return where;
  }

  async exportRows(filters: ListClaimsFilters): Promise<ExportRow[]> {
    const where = this.buildWhere(filters);
    const total = await this.prisma.claim.count({ where });
    if (total > EXPORT_MAX) {
      console.warn(`Claims export truncated: ${EXPORT_MAX} of ${total} claims`);
    }
    const claims = await this.prisma.claim.findMany({
      where,
      include: {
        subCategory: { select: { name: true, category: { select: { name: true } } } },
        workflowStatus: { select: { name: true } },
        assignedTo: { select: { fullName: true } },
        _count: { select: { documents: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_MAX,
    });
    return claims.map((c) => ({
      claimId: c.claimId,
      subCategory: c.subCategory.name,
      category: c.subCategory.category.name,
      workflowStatus: c.workflowStatus.name,
      assignedTo: c.assignedTo?.fullName ?? 'Unassigned',
      spell: c.spellCheckStatus,
      qr: c.qrStatus,
      meta: c.metaExtractionStatus,
      intra: c.intraClaimStatus,
      full: c.fullScanStatus,
      documents: c._count.documents,
      created: c.createdAt.toISOString().slice(0, 10),
    }));
  }
```

- [ ] **Step 4: Run (expect pass)** — `cd server && npm test -- claimExport` → PASS (3/3). Then `npx tsc --noEmit` → clean.
- [ ] **Step 5: Commit** — `git add server/src/services/claimService.ts server/src/services/__tests__/claimExport.test.ts && git commit -m "feat(claims): ClaimService.exportRows + shared buildWhere"`

## Task 2: `claimReportService.buildClaimsWorkbook` (+ exceljs)

**Files:** Modify `server/package.json`; Create `server/src/services/claimReportService.ts`, `server/src/services/__tests__/claimReportService.test.ts`

- [ ] **Step 1: Install** — `cd server && npm install exceljs` (ships its own types).

- [ ] **Step 2: Write the failing test** `server/src/services/__tests__/claimReportService.test.ts`

```ts
import { buildClaimsWorkbook } from '../claimReportService.js';
import { ExportRow } from '../claimService.js';

const row: ExportRow = {
  claimId: 'EX-1', subCategory: 'RC', category: 'Cat', workflowStatus: 'Pending',
  assignedTo: 'Unassigned', spell: 'PASSED', qr: 'FAILED', meta: 'PASSED', intra: 'PENDING',
  full: 'PASSED', documents: 2, created: '2026-05-31',
};

describe('buildClaimsWorkbook', () => {
  it('creates a Claims sheet with a header row and data rows', () => {
    const wb = buildClaimsWorkbook([row]);
    const ws = wb.getWorksheet('Claims')!;
    expect(ws.getRow(1).getCell(1).value).toBe('Claim ID');
    expect(ws.getRow(1).getCell(11).value).toBe('Documents');
    expect(ws.getRow(2).getCell(1).value).toBe('EX-1');
    expect(ws.getRow(2).getCell(4).value).toBe('Pending');
    expect(ws.getRow(2).getCell(11).value).toBe(2);
    expect(ws.getRow(2).getCell(12).value).toBe('2026-05-31');
  });
  it('handles an empty row set (header only)', () => {
    const ws = buildClaimsWorkbook([]).getWorksheet('Claims')!;
    expect(ws.rowCount).toBe(1);
  });
});
```

- [ ] **Step 3: Run (expect fail)** — `cd server && npm test -- claimReportService` → FAIL (module not found).

- [ ] **Step 4: Create `server/src/services/claimReportService.ts`**

```ts
import ExcelJS from 'exceljs';
import { ExportRow } from './claimService.js';

const HEADERS = [
  'Claim ID', 'Sub-Category', 'Category', 'Workflow Status', 'Assigned To',
  'Spell', 'QR', 'Meta', 'Intra-Claim', 'Full Scan', 'Documents', 'Created',
];

export function buildClaimsWorkbook(rows: ExportRow[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Claims');
  ws.addRow(HEADERS);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow([
      r.claimId, r.subCategory, r.category, r.workflowStatus, r.assignedTo,
      r.spell, r.qr, r.meta, r.intra, r.full, r.documents, r.created,
    ]);
  }
  ws.columns.forEach((col) => {
    col.width = 16;
  });
  return wb;
}
```

- [ ] **Step 5: Run (expect pass)** — `cd server && npm test -- claimReportService` → PASS. Then `npx tsc --noEmit` → clean.
- [ ] **Step 6: Commit** — `git add server/package.json server/package-lock.json package-lock.json server/src/services/claimReportService.ts server/src/services/__tests__/claimReportService.test.ts && git commit -m "feat(claims): buildClaimsWorkbook (exceljs)"`

## Task 3: `GET /api/claims/export` route

**Files:** Modify `server/src/routes/claims.ts`

- [ ] **Step 1: Add the import** near the other service imports:

```ts
import { buildClaimsWorkbook } from '../services/claimReportService.js';
```

- [ ] **Step 2: Add the route immediately after the `router.get('/', ...)` list handler and BEFORE `router.get('/:id', ...)`** (so "export" is not captured as `:id`):

```ts
router.get(
  '/export',
  [
    query('subCategoryId').optional().isUUID(),
    query('workflowStatusId').optional().isUUID(),
    query('assignedToUserId').optional().isUUID(),
    query('assignedToMe').optional().isBoolean().toBoolean(),
    query('search').optional().isString(),
  ],
  validate,
  async (req: ScopedRequest, res: Response, next: NextFunction) => {
    try {
      const rows = await getService(req).exportRows({
        subCategoryId: req.query.subCategoryId as string | undefined,
        workflowStatusId: req.query.workflowStatusId as string | undefined,
        assignedToUserId:
          req.session!.role === 'USER'
            ? undefined
            : (req.query.assignedToUserId as string | undefined),
        assignedToMe: req.query.assignedToMe as unknown as boolean | undefined,
        search: req.query.search as string | undefined,
        scope: req.scope!,
        callerId: req.session!.userId,
      });
      const wb = buildClaimsWorkbook(rows);
      const buf = await wb.xlsx.writeBuffer();
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="claims-${date}.xlsx"`);
      res.send(Buffer.from(buf));
    } catch (err) {
      next(err);
    }
  }
);
```

(`query`, `validate`, `getService`, `ScopedRequest`, `Response`, `NextFunction` are already imported/defined in `claims.ts`.)

- [ ] **Step 3: Type-check + full tests + re-seed**

Run: `cd server && npx tsc --noEmit && npm test`
Then: `npm run db:seed` (root).
Expected: tsc clean; all suites pass; seed completes.

- [ ] **Step 4: Commit** — `git add server/src/routes/claims.ts && git commit -m "feat(claims): GET /claims/export streams xlsx"`

## Task 4: Export buttons (Dashboard + Admin Claims)

**Files:** Modify `client/src/pages/claims/ClaimDashboard.tsx`, `client/src/pages/admin/AdminClaims.tsx`

- [ ] **Step 1: Add the export handler to `ClaimDashboard.tsx`** — insert after the `handleAdd` function:

```tsx
  const handleExport = () => {
    const params = new URLSearchParams();
    if (filters.subCategoryId) params.set('subCategoryId', filters.subCategoryId);
    if (filters.workflowStatusId) params.set('workflowStatusId', filters.workflowStatusId);
    if (filters.assignedToMe) params.set('assignedToMe', 'true');
    if (filters.assignedToUserId) params.set('assignedToUserId', filters.assignedToUserId);
    if (filters.search) params.set('search', filters.search);
    window.open(`/api/claims/export?${params.toString()}`, '_blank');
  };
```

- [ ] **Step 2: Add the Export button** in the filter row's apply bar. Replace:

```tsx
        <div className="col-span-4 flex justify-end">
          <Button onClick={() => fetchData(1, pagination.limit)}>Apply filters</Button>
        </div>
```

with:

```tsx
        <div className="col-span-4 flex justify-end gap-2">
          <Button variant="outline" onClick={handleExport}>Export</Button>
          <Button onClick={() => fetchData(1, pagination.limit)}>Apply filters</Button>
        </div>
```

- [ ] **Step 3: Add the Export button to `AdminClaims.tsx`.** Replace the header's button group:

```tsx
        <div className="flex gap-2">
          <Input
            placeholder="Search claim id..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fetchData(1, pagination.limit)}
            className="w-64"
          />
          <Button onClick={() => fetchData(1, pagination.limit)}>Search</Button>
        </div>
```

with:

```tsx
        <div className="flex gap-2">
          <Input
            placeholder="Search claim id..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fetchData(1, pagination.limit)}
            className="w-64"
          />
          <Button onClick={() => fetchData(1, pagination.limit)}>Search</Button>
          <Button
            variant="outline"
            onClick={() => {
              const params = new URLSearchParams();
              if (search) params.set('search', search);
              window.open(`/api/claims/export?${params.toString()}`, '_blank');
            }}
          >
            Export
          </Button>
        </div>
```

- [ ] **Step 4: Type-check** — `cd client && npx tsc --noEmit` → clean.
- [ ] **Step 5: Commit** — `git add client/src/pages/claims/ClaimDashboard.tsx client/src/pages/admin/AdminClaims.tsx && git commit -m "feat(claims): Export buttons on dashboard + admin claims"`

## Task 5: End-to-end verification

- [ ] **Step 1: Backend green + re-seed** — `cd server && npx tsc --noEmit && npm test` then `npm run db:seed` (root). Expected: all suites pass (existing 91 + claimExport 3 + claimReportService 2); seed completes.
- [ ] **Step 2: Frontend green** — `cd client && npx tsc --noEmit` → clean.
- [ ] **Step 3: Manual smoke (API)** — start the server; log in as admin; `curl -b <cookie> 'http://localhost:3010/api/claims/export' -o /tmp/claims.xlsx` and confirm a non-trivial `.xlsx` is produced (e.g., `unzip -l /tmp/claims.xlsx` shows `xl/worksheets/sheet1.xml`). In the browser, click **Export** on the dashboard and confirm a `claims-<date>.xlsx` downloads with the seeded claims.
- [ ] **Step 4: Final status** — `git status` (clean if committing per task).

---

## Self-Review (completed during plan writing)

- **Spec coverage:** exceljs dep (T2) ✓ · `exportRows` scoped+filtered, no pagination, cap+`console.warn` (T1) ✓ · 12 columns from one query with `_count` (T1/T2) ✓ · `buildClaimsWorkbook` pure + testable (T2) ✓ · `GET /export` streaming xlsx with attachment headers + declared before `/:id` + USER assignee guard + `req.scope` (T3) ✓ · Export buttons on Dashboard + Admin Claims building the filter query (T4) ✓ · scope = list scope ✓ · no rules-passed column ✓.
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `ExportRow` (12 fields) defined in `claimService.ts` and imported by `claimReportService.ts` + its test; `exportRows(filters: ListClaimsFilters)`, `buildClaimsWorkbook(rows: ExportRow[])`, the route's filter mapping (mirrors `GET /claims`, incl. USER assignee guard), and the client param names all match.
- **Note:** the `list` refactor to `buildWhere` is behavior-preserving (identical where logic), and `exportRows`'s tests exercise that shared `buildWhere` for scope/search.
