# Claims Management Phase 2F — Claims Export Design

**Status:** Draft for review
**Date:** 2026-05-31
**Author:** Aditya Kumar (with Claude)
**Scope:** A downloadable `.xlsx` export of claims — the rows matching the caller's scope and the current dashboard filters, with key columns. The final Phase 2 sub-project.

---

## 0. Executive Summary

An **Export** button on the Claim Dashboard (and Admin Claims overview) downloads an Excel workbook of the claims the caller can see, honoring the same filters as the dashboard list (SubCategory, workflow status, assignee / assigned-to-me, search) — but **all** matching rows, not a single page. The workbook has one row per claim with key columns (status, assignee, the 5 validation results, document count, dates).

### Decisions locked during brainstorming (2026-05-31)

| Topic | Decision |
|-------|----------|
| Report type | **Claims export** (download), not an on-screen dashboard or per-claim PDF. |
| Format | **True `.xlsx`** via the `exceljs` library. |
| Columns | The 12 efficient, single-query columns in §2 (no "rules passed" column — see Out of scope). |
| Scope | Same as the claim list — USER sees in-scope claims, TL their pair, Admin all; honors dashboard filters. |

### Out of scope (Phase 2F boundary)

- **No "rules passed" column** in the bulk export — computing it requires evaluating every rule for every claim (3+ queries/row), too slow for large exports. Rule results remain available per-claim on the Claim Update page (Phase 2E).
- No on-screen analytics dashboard, no charts, no per-claim PDF (those were the other 2F options, not chosen).
- No scheduled/emailed reports, no saved report definitions.
- No CSV variant (xlsx only).

---

## 1. Architecture

```
server/src/
├── services/claimReportService.ts   (new — buildClaimsWorkbook(rows): ExcelJS.Workbook; pure-ish, testable)
├── services/claimService.ts          (modify — add exportRows(filters): all scoped+filtered claims, no pagination)
├── routes/claims.ts                  (modify — GET /export streams the workbook)
└── package.json                      (add exceljs)

client/src/pages/claims/ClaimDashboard.tsx (modify — Export button)
client/src/pages/admin/AdminClaims.tsx      (modify — Export button)
```

- **New dep:** `exceljs` (ships its own TypeScript types).
- The data query and the workbook building are **separated**: `exportRows` (DB) and `buildClaimsWorkbook` (formatting) — so the workbook builder is unit-testable in memory with no DB/HTTP.

---

## 2. Columns (one efficient query — no N+1)

| # | Header | Source |
|---|--------|--------|
| 1 | Claim ID | `claim.claimId` |
| 2 | Sub-Category | `claim.subCategory.name` |
| 3 | Category | `claim.subCategory.category.name` |
| 4 | Workflow Status | `claim.workflowStatus.name` |
| 5 | Assigned To | `claim.assignedTo.fullName` or "Unassigned" |
| 6 | Spell | `claim.spellCheckStatus` |
| 7 | QR | `claim.qrStatus` |
| 8 | Meta | `claim.metaExtractionStatus` |
| 9 | Intra-Claim | `claim.intraClaimStatus` |
| 10 | Full Scan | `claim.fullScanStatus` |
| 11 | Documents | `claim._count.documents` |
| 12 | Created | `claim.createdAt` (ISO date) |

All from a single `claim.findMany` with `include: { subCategory: { include: { category } }, workflowStatus, assignedTo, _count: { select: { documents: true } } }`.

---

## 3. `ClaimService.exportRows`

```ts
async exportRows(filters: ListClaimsFilters): Promise<ExportRow[]>
```
- Reuses the **exact same `where` construction** as `list()` (scope, subCategoryId, workflowStatusId, assignedToUserId, assignedToMe + callerId, search) — so the export matches what the dashboard shows. The route applies the same USER-can't-filter-by-arbitrary-assignee guard as the list.
- **No pagination**; ordered `createdAt desc`. Capped at `EXPORT_MAX = 50000` rows (`take`). If the unfiltered `count` exceeds the cap, it `console.warn`s (`Export truncated: N of M claims`) — **no silent truncation**; the cap is documented and logged.
- Returns a flat `ExportRow[]` (the 12 fields above already resolved), so the workbook builder needs no Prisma types.

## 4. `claimReportService.buildClaimsWorkbook`

```ts
import ExcelJS from 'exceljs';
export function buildClaimsWorkbook(rows: ExportRow[]): ExcelJS.Workbook;
```
- Creates a workbook with one "Claims" worksheet, a bold header row (the 12 headers), then one row per `ExportRow`. Sets sensible column widths. Returns the in-memory `Workbook` (no I/O) — directly unit-testable (`workbook.getWorksheet('Claims')`, header cells, a data row's values).

## 5. API

```
GET /api/claims/export?subCategoryId=&workflowStatusId=&assignedToUserId=&assignedToMe=&search=
    (authMiddleware + passwordChangedMiddleware + scoped — same as the rest of /claims)
    → 200 application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
      Content-Disposition: attachment; filename="claims-YYYY-MM-DD.xlsx"
      (streams workbook.xlsx.writeBuffer())
```
The handler builds `ListClaimsFilters` from the query (identical mapping to `GET /claims`, including the USER assignee-filter guard and `scope: req.scope`), calls `exportRows`, builds the workbook, and writes the buffer. Errors go through the central error handler. **Route ordering:** declare `GET /export` *before* `GET /:id` in `claims.ts` so "export" isn't captured as an `:id` (and `:id` is UUID-validated anyway).

## 6. UI

- **Claim Dashboard** (`ClaimDashboard.tsx`): an **Export** button in the filter row. On click it builds the current query string from the active filters (same params the list uses) and triggers a download via `window.open('/api/claims/export?' + params)` (a GET with the session cookie). Hidden when the limited-access (no-assignment) banner is shown.
- **Admin Claims** (`AdminClaims.tsx`): the same Export button over its (admin-scope) filters.

## 7. Permissions

Any in-scope viewer can export exactly the claims they can list (USER → in-scope, with the assignee-filter restriction; TL → pair; Admin → all). No separate gate — the export is the list, as a file.

## 8. Testing

- **`buildClaimsWorkbook`** — pure unit test: feed 2 `ExportRow`s, assert the worksheet exists, the header row matches the 12 headers, and a data row's cell values match (in-memory, no I/O, fast).
- **`ClaimService.exportRows`** — fixtures: claims across two SubCategories/scopes + filters; assert scope filtering (a TL/USER scope returns only in-scope rows), filter application (subCategoryId/search), the resolved fields (assignee name vs "Unassigned", document count), and `createdAt desc` order.
- **Type-check** both workspaces; **live smoke**: click Export, confirm a `.xlsx` downloads and opens with the expected rows/columns.

## 9. Open items for the implementation plan

- Exact `EXPORT_MAX` value (start 50000) and whether to expose it via env.
- Column widths / whether to freeze the header row (cosmetic).
- Date formatting in the Created column (ISO date string vs Excel date type) — lean: ISO date string for portability.

These are small and settled during plan-writing.
