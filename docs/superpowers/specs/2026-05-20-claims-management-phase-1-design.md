# Claims Management Module — Phase 1 Design
 
**Status:** Draft for review
**Date:** 2026-05-20
**Author:** Aditya Kumar (with Claude)
**Scope:** Admin foundation only (no document processing pipeline)

---

## 0. Executive Summary

A new **Claims Management** module is added to ProxyURLApp. It sits **alongside** the existing URL proxy module — both share users, sessions, and the SubCategory hierarchy, but are otherwise mechanically independent.

Phase 1 builds:

1. A new **Team Lead** role (between User and Admin).
2. Three new master data tables, each scoped per SubCategory:
   - **Status Master** — workflow statuses for claims.
   - **Document Type Master** — types of documents a claim can contain (Govt and Custom).
   - **Claim ID Rule** — config for how a Claim ID is extracted from folder/file names.
3. A **Claim** entity with placeholders for the (future) validation pipeline.
4. A **Claim Dashboard** (end-user) and **Claim Update Page** for managing claims.
5. Manual claim creation (Admin/Team Lead) — no auto-scanner yet.

Phase 1 explicitly does **not** include: filesystem scanning, OCR, spell-check, QR scanning, metadata extraction, document upload/processing, Excel-rules engine, address matching, reports, or any of the document-validation pipeline. Those land in later phases.

---

## 1. Module boundary & overall architecture

This Phase 1 is a brand-new module living alongside the existing URL proxy. The two modules share:

1. The same `User`, `Session`, `UserType`, `ProjectType`, `Category`, `SubCategory` tables (Claims hang off `SubCategory`).
2. The same auth middleware + cookie session.
3. The same admin layout + sidebar (new entries appended).

They share **nothing else**. No service code is reused, no URL configuration touches a Claim, no Claim references a `UrlConfiguration`. Nothing in `server/src/routes/proxy.ts`, `proxyService.ts`, or any proxy-related code changes.

### New backend layout

```
server/src/
├── routes/admin/
│   ├── statusMasters.ts        (new — CRUD)
│   ├── documentTypeMasters.ts  (new — CRUD)
│   ├── claimIdRules.ts         (new — CRUD)
│   └── claims.ts               (new — Admin claims overview)
├── routes/
│   └── claims.ts               (new — user/team-lead claim ops)
├── services/
│   ├── claimService.ts         (new — claim CRUD + remark history)
│   ├── statusMasterService.ts  (new)
│   ├── documentTypeService.ts  (new)
│   └── claimIdRuleService.ts   (new)
└── middleware/
    └── roleGuard.ts            (new — Team Lead / scope checks)
```

### New frontend layout

```
client/src/pages/
├── admin/
│   ├── StatusMasters.tsx        (new)
│   ├── DocumentTypeMasters.tsx  (new)
│   ├── ClaimIdRules.tsx         (new)
│   └── AdminClaims.tsx          (new — Admin claims overview)
└── claims/
    ├── ClaimDashboard.tsx       (new — "/claims")
    └── ClaimUpdate.tsx          (new — "/claims/:id")
```

### Scope flags

- No filesystem scanner — `Claim ID Rule` is just a configuration record.
- No OCR / spell-check / QR / Excel-rules / address-match / report — Phase 2+.
- The 5 validation status columns (spell, QR, meta, intra-claim, full-scan) exist in DB and UI but always show **PENDING**.
- Role enum migration (`User.isAdmin: Boolean` → `User.role: enum`) is Phase 1 work because Team Lead needs it.

---

## 2. Data model (Prisma)

### 2.1 Role enum migration on `User`

```prisma
enum Role {
  USER
  TEAM_LEAD
  ADMIN
}

model User {
  // ... existing fields ...
  role  Role  @default(USER)
  // isAdmin field is REMOVED. See migration plan in §7.
}
```

**Migration steps (server/prisma/migrations):**

1. Add `role` column with default `USER`.
2. Backfill: `UPDATE users SET role = 'ADMIN' WHERE is_admin = TRUE;`
3. Drop `is_admin` column.
4. Code changes in same release: every reference to `user.isAdmin` and `session.isAdmin` is replaced with `user.role === 'ADMIN'` (or via a helper `isAdmin(role)`).

### 2.2 `StatusMaster`

```prisma
model StatusMaster {
  id            String   @id @default(uuid()) @db.VarChar(36)
  subCategoryId String   @map("sub_category_id") @db.VarChar(36)
  name          String   @db.VarChar(100)
  displayOrder  Int      @default(0) @map("display_order")
  isDefault     Boolean  @default(false) @map("is_default")
  isTerminal    Boolean  @default(false) @map("is_terminal")
  status        Status   @default(ACTIVE)
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")
  createdBy     String?  @map("created_by") @db.VarChar(36)
  updatedBy     String?  @map("updated_by") @db.VarChar(36)

  subCategory   SubCategory @relation(fields: [subCategoryId], references: [id], onDelete: Cascade)
  claims        Claim[]     @relation("ClaimWorkflowStatus")

  @@unique([name, subCategoryId])
  @@index([subCategoryId])
  @@map("status_masters")
}
```

**Invariants enforced in service layer:**
- At most one `isDefault = true` per `subCategoryId` among `status = ACTIVE` records. (Zero is allowed; in that case Claim creation under that SubCategory is blocked with `NO_DEFAULT_STATUS`.)
- A `StatusMaster` row cannot be deleted (only deactivated) if any `Claim` references it.
- Tiebreaker for list ordering when two records share `displayOrder`: `name ASC`.

### 2.3 `DocumentTypeMaster`

```prisma
enum DocumentTypeCategory {
  GOVT
  CUSTOM
}

enum GovtDocumentCode {
  AADHAR
  PAN
  DL
  PASSPORT
  VOTER_ID
  RATION_CARD
}

model DocumentTypeMaster {
  id            String                @id @default(uuid()) @db.VarChar(36)
  subCategoryId String                @map("sub_category_id") @db.VarChar(36)
  name          String                @db.VarChar(100)
  category      DocumentTypeCategory
  govtCode      GovtDocumentCode?     @map("govt_code")
  displayOrder  Int                   @default(0) @map("display_order")
  status        Status                @default(ACTIVE)
  createdAt     DateTime              @default(now()) @map("created_at")
  updatedAt     DateTime              @updatedAt @map("updated_at")
  createdBy     String?               @map("created_by") @db.VarChar(36)
  updatedBy     String?               @map("updated_by") @db.VarChar(36)

  subCategory   SubCategory           @relation(fields: [subCategoryId], references: [id], onDelete: Cascade)

  @@unique([name, subCategoryId])
  @@unique([govtCode, subCategoryId])
  @@index([subCategoryId])
  @@map("document_type_masters")
}
```

**Invariants enforced in service layer:**
- If `category = GOVT`, `govtCode` MUST be set. The `name` should be auto-populated from the enum choice (Aadhar / PAN / etc.) but is still required.
- If `category = CUSTOM`, `govtCode` MUST be null.
- A given `govtCode` can appear at most once per SubCategory.

### 2.4 `ClaimIdRule`

```prisma
enum ScanTarget {
  FOLDER
  FILE
}

model ClaimIdRule {
  id            String      @id @default(uuid()) @db.VarChar(36)
  subCategoryId String      @unique @map("sub_category_id") @db.VarChar(36)
  startPosition Int         @map("start_position") // 1-indexed
  length        Int
  scanTarget    ScanTarget  @map("scan_target")
  scanLocation  String      @map("scan_location") @db.VarChar(500)
  status        Status      @default(ACTIVE)
  createdAt     DateTime    @default(now()) @map("created_at")
  updatedAt     DateTime    @updatedAt @map("updated_at")
  createdBy     String?     @map("created_by") @db.VarChar(36)
  updatedBy     String?     @map("updated_by") @db.VarChar(36)

  subCategory   SubCategory @relation(fields: [subCategoryId], references: [id], onDelete: Cascade)

  @@map("claim_id_rules")
}
```

**Validation enforced in service layer:**
- `startPosition >= 1` and `length >= 1` and `(startPosition + length - 1) <= 200` (sanity cap).
- `scanLocation` matches regex `^[A-Za-z]:\\.+` AND does NOT start with `C:\` (case-insensitive). Server returns 400 `INVALID_SCAN_LOCATION` otherwise.
- One rule per SubCategory (unique constraint on `subCategoryId`).

### 2.5 `Claim` + `ClaimRemark`

```prisma
enum ValidationStatus {
  PENDING
  IN_PROGRESS
  PASSED
  FAILED
}

model Claim {
  id                     String           @id @default(uuid()) @db.VarChar(36)
  claimId                String           @map("claim_id") @db.VarChar(100)
  subCategoryId          String           @map("sub_category_id") @db.VarChar(36)
  workflowStatusId       String           @map("workflow_status_id") @db.VarChar(36)
  assignedToUserId       String?          @map("assigned_to_user_id") @db.VarChar(36)
  folderPath             String?          @map("folder_path") @db.VarChar(500)

  // Validation status placeholders — always PENDING in Phase 1
  spellCheckStatus       ValidationStatus @default(PENDING) @map("spell_check_status")
  qrStatus               ValidationStatus @default(PENDING) @map("qr_status")
  metaExtractionStatus   ValidationStatus @default(PENDING) @map("meta_extraction_status")
  intraClaimStatus       ValidationStatus @default(PENDING) @map("intra_claim_status")
  fullScanStatus         ValidationStatus @default(PENDING) @map("full_scan_status")

  status                 Status           @default(ACTIVE)
  createdAt              DateTime         @default(now()) @map("created_at")
  updatedAt              DateTime         @updatedAt @map("updated_at")
  createdBy              String?          @map("created_by") @db.VarChar(36)
  updatedBy              String?          @map("updated_by") @db.VarChar(36)

  subCategory            SubCategory      @relation(fields: [subCategoryId], references: [id])
  workflowStatus         StatusMaster     @relation("ClaimWorkflowStatus", fields: [workflowStatusId], references: [id])
  assignedTo             User?            @relation("ClaimAssignee", fields: [assignedToUserId], references: [id])
  remarks                ClaimRemark[]

  @@unique([claimId, subCategoryId])
  @@index([subCategoryId])
  @@index([workflowStatusId])
  @@index([assignedToUserId])
  @@index([createdBy])
  @@map("claims")
}

model ClaimRemark {
  id              String        @id @default(uuid()) @db.VarChar(36)
  claimId         String        @map("claim_id") @db.VarChar(36)
  userId          String        @map("user_id") @db.VarChar(36)
  remarkText      String        @map("remark_text") @db.Text
  statusBeforeId  String?       @map("status_before_id") @db.VarChar(36)
  statusAfterId   String?       @map("status_after_id") @db.VarChar(36)
  createdAt       DateTime      @default(now()) @map("created_at")

  claim           Claim         @relation(fields: [claimId], references: [id], onDelete: Cascade)
  user            User          @relation("ClaimRemarkAuthor", fields: [userId], references: [id])
  statusBefore    StatusMaster? @relation("ClaimRemarkStatusBefore", fields: [statusBeforeId], references: [id])
  statusAfter     StatusMaster? @relation("ClaimRemarkStatusAfter", fields: [statusAfterId], references: [id])

  @@index([claimId])
  @@index([createdAt])
  @@map("claim_remarks")
}
```

**Notes:**
- `Claim.claimId` is the extracted business identifier (string, free-text in Phase 1). The DB primary key remains `id` (uuid).
- `Claim.workflowStatusId` is the user-editable lifecycle status (from `StatusMaster`).
- `Claim.status` is the lifecycle ACTIVE / INACTIVE pattern used elsewhere (soft-delete).
- `ClaimRemark` is append-only — no UPDATE / DELETE endpoint.
- A claim is uniquely identified by `(claimId, subCategoryId)` — same Claim ID could appear in two different SubCategories.

### 2.6 Relations added on existing tables

```prisma
model SubCategory {
  // ... existing ...
  statusMasters       StatusMaster[]
  documentTypeMasters DocumentTypeMaster[]
  claimIdRule         ClaimIdRule?
  claims              Claim[]
}

model User {
  // ... existing ...
  assignedClaims     Claim[]        @relation("ClaimAssignee")
  authoredRemarks    ClaimRemark[]  @relation("ClaimRemarkAuthor")
}
```

---

## 3. Role & permission model

### 3.1 Role enum

```
USER < TEAM_LEAD < ADMIN
```

All three roles can hold a `UserAssignment` (a single (UserType, ProjectType) pair). Admin's assignment is optional and not used for scoping — Admin sees everything.

### 3.2 Permission matrix — Phase 1 Claims module

| Action                                              | USER                          | TEAM_LEAD        | ADMIN  |
|-----------------------------------------------------|-------------------------------|------------------|--------|
| Access admin master-data screens                    | —                             | —                | Yes    |
| Consume StatusMaster values (status dropdown)       | Yes (own SubCategory, ACTIVE) | Yes (scope)      | All    |
| Consume DocumentTypeMaster / ClaimIdRule values     | Not exposed in Phase 1 UI     | Not exposed      | Edit   |
| Create / edit / delete master data                  | —                             | —                | Yes    |
| View Claim Dashboard (their pair)                   | Yes (read)                    | Yes (read+write) | Yes    |
| Create Claim                                        | —                             | Yes (own pair)   | Yes    |
| Open / view Claim                                   | Own pair (read-only display)  | Own pair         | All    |
| Edit Claim (status, remarks, reassign)              | Only if assigned to caller    | Own pair         | All    |
| Reassign Claim                                      | —                             | Own pair         | All    |
| Soft-delete Claim                                   | —                             | —                | Yes    |
| Manage Users / UserTypes / ProjectTypes / etc.      | —                             | —                | Yes    |
| Use URL proxy (existing feature)                    | Yes                           | Yes              | Yes    |

Phase 1 UI never surfaces DocumentTypeMaster or ClaimIdRule data to non-admins. Those records exist only to be consumed by the (Phase 2) document-validation pipeline.

### 3.3 Authorization plumbing

- **`adminMiddleware`** (existing) — kept. Checks `role === 'ADMIN'`.
- **`teamLeadOrAdminMiddleware`** (new) — checks `role IN ('TEAM_LEAD', 'ADMIN')`.
- **`scopedMiddleware`** (new) — for Team Lead routes, resolves the user's `UserAssignment` and attaches `(userTypeId, projectTypeId)` to `req` so route handlers filter by it. Admin bypasses scoping.
- **Per-claim guard** (`canEditClaim`) — service-layer check, returns true iff:
  - `role === 'ADMIN'`, OR
  - `role === 'TEAM_LEAD'` AND claim's `subCategory.userTypeId/projectTypeId` matches user's assignment, OR
  - `role === 'USER'` AND `claim.assignedToUserId === user.id`.

### 3.4 Session payload change

`SessionData` (in `sessionService.ts`) currently exposes `isAdmin: boolean`. Change to:

```ts
interface SessionData {
  userId: string;
  username: string;
  fullName: string;
  role: 'USER' | 'TEAM_LEAD' | 'ADMIN';
  forcePasswordChange: boolean;
  // ...
}
```

Replace every reference to `session.isAdmin` accordingly. The frontend `authStore.User` interface gets the same change.

### 3.5 Frontend `ProtectedRoute` change

```tsx
function ProtectedRoute({
  children,
  requiredRole,
}: {
  children: React.ReactNode;
  requiredRole?: 'TEAM_LEAD' | 'ADMIN'; // omit = any authenticated
}) { /* ... */ }
```

Replaces the current `adminOnly: boolean` flag. Admin satisfies any `requiredRole`; Team Lead satisfies `TEAM_LEAD`; plain User satisfies only the no-requirement case.

---

## 4. Backend API surface

All paths are under `/api`. All responses follow the existing `{ data, pagination? }` / `{ error, code }` shape. All routes are gated by `authMiddleware + passwordChangedMiddleware` unless otherwise noted.

### 4.1 Admin master data (`adminMiddleware` required)

```
GET    /admin/status-masters?subCategoryId=&status=&page=&limit=
POST   /admin/status-masters
GET    /admin/status-masters/:id
PUT    /admin/status-masters/:id
DELETE /admin/status-masters/:id            (soft delete via status change, hard delete only if unused)
PATCH  /admin/status-masters/:id/status

GET    /admin/document-type-masters?subCategoryId=&status=&category=&page=&limit=
POST   /admin/document-type-masters
GET    /admin/document-type-masters/:id
PUT    /admin/document-type-masters/:id
DELETE /admin/document-type-masters/:id
PATCH  /admin/document-type-masters/:id/status

GET    /admin/claim-id-rules?subCategoryId=&status=&page=&limit=
POST   /admin/claim-id-rules
GET    /admin/claim-id-rules/:id
PUT    /admin/claim-id-rules/:id
DELETE /admin/claim-id-rules/:id
PATCH  /admin/claim-id-rules/:id/status

GET    /admin/claims?subCategoryId=&workflowStatusId=&assignedToUserId=&search=&page=&limit=
GET    /admin/claims/:id
DELETE /admin/claims/:id            (soft delete)
```

### 4.2 Claim endpoints used by Users + Team Leads (`authMiddleware`, scoped)

```
GET    /claims                              List claims in caller's (UserType, ProjectType) pair.
                                            Query: subCategoryId, workflowStatusId, assignedToUserId
                                                   (TL/Admin only), assignedToMe (USER convenience),
                                                   search, page, limit.

GET    /claims/:id                          Get one claim + 20 most-recent remarks (scoped).

POST   /claims                              Create a Claim. TL/ADMIN only.
                                            Body: { subCategoryId, claimId, folderPath?,
                                                    assignedToUserId?, remarkText? (optional first
                                                    timeline entry) }.

POST   /claims/:id/remarks                  Single endpoint for ALL state-changing edits to a Claim.
                                            Body: { remarkText: string (required, non-empty),
                                                    newStatusId?: string,
                                                    newAssigneeId?: string | null
                                                          (null = unassign) }.
                                            Service runs in one transaction:
                                              1. Insert ClaimRemark (statusBefore, statusAfter set
                                                 if status changed; null otherwise).
                                              2. If newStatusId given, update Claim.workflowStatusId.
                                              3. If newAssigneeId given (or explicit null),
                                                 update Claim.assignedToUserId.
                                            Permission gate:
                                              - canEditClaim required to change status.
                                              - TL/ADMIN required to change assignee.
                                              - Any in-scope viewer may post a remark with no state
                                                change ONLY if canEditClaim is true (otherwise the
                                                Update card is disabled in UI and the endpoint
                                                returns 403 CLAIM_NOT_EDITABLE).

GET    /claims/:id/remarks?page=&limit=     Paginated remark history (newest first).
```

There is intentionally no `PATCH /claims/:id` — every mutation to a Claim is funneled through `POST /claims/:id/remarks` so the audit timeline never has gaps.

### 4.3 Helper / lookup endpoints

```
GET    /user/sub-categories                 SubCategories visible to the caller (existing menu API
                                            can be extended OR a new lightweight endpoint added).
                                            Used to populate dropdowns on Claim Dashboard and forms.
GET    /user/status-masters?subCategoryId=  Active StatusMasters for a SubCategory (caller must be
                                            in scope). Used by Claim Update Page status dropdown.
GET    /user/users?subCategoryId=           Active Users in caller's scope (TL/Admin only) — used
                                            for the "Assign to" dropdown.
```

### 4.4 Validation error codes (new)

```
INVALID_SCAN_LOCATION    Claim ID Rule scanLocation must be a drive-letter path, not C:\
INVALID_RANGE            startPosition + length out of bounds
DUPLICATE_DEFAULT_STATUS Already an isDefault status for this SubCategory
DUPLICATE_GOVT_CODE      Govt doc type already exists for this SubCategory
STATUS_IN_USE            Cannot delete StatusMaster referenced by Claims
CLAIM_NOT_EDITABLE       Caller cannot edit this claim
NO_DEFAULT_STATUS        SubCategory has no active default status — cannot create claim
NO_CLAIM_ID_RULE         (Phase 2) Optional: warn if claim being created has no rule
```

---

## 5. Admin UI

### 5.1 Admin sidebar additions (`AdminLayout.tsx`)

After existing entries, three new section header + items:

```
URL Configs              (existing)
─────────────────────────────────
CLAIMS CONFIG
  Status Masters         /admin/status-masters
  Doc Type Masters       /admin/doc-type-masters
  Claim ID Rules         /admin/claim-id-rules
  Claims (all)           /admin/claims
```

### 5.2 Each master-data page follows the existing CRUD pattern

The existing `Users.tsx`, `Categories.tsx`, etc. follow a consistent shape: `DataTable` + form `Dialog` + `ConfirmDialog`. The three new admin pages reuse that exact pattern (no UI invention needed). Each page:

- Top filter row: SubCategory dropdown + Status filter + Search.
- Add button → opens form dialog.
- Row actions (kebab menu): Edit, Activate/Deactivate, Delete (with usage checks).

**StatusMasters page form fields:** SubCategory (cascading from UserType + ProjectType selectors) · Name · Order · IsDefault (checkbox) · IsTerminal (checkbox).

**DocumentTypeMasters page form fields:** SubCategory · Category (radio: GOVT / CUSTOM) · if GOVT → GovtCode dropdown (Aadhar/PAN/DL/Passport/Voter ID/Ration Card) — the dropdown filters out codes already used by an ACTIVE record on the same SubCategory; Name pre-fills from the selection (e.g., AADHAR → "Aadhar Card") and is editable for display purposes · if CUSTOM → Name free text · Order.

**ClaimIdRules page form fields:** SubCategory · Start Position (number, min 1) · Length (number, min 1) · Scan Target (radio: FOLDER / FILE) · Scan Location (text, validated client-side: drive letter, not C:). Inline help: "Example: D:\Claims\Daily. Must be a drive letter on the server. C:\\ is not allowed."

**AdminClaims page:** read-only table of all claims across all SubCategories. Same column set as the user-facing Claim Dashboard. Row action: View (opens the same `/claims/:id` page in admin context).

### 5.3 Cascading SubCategory selector

A reusable component `<SubCategoryPicker>` is created in `client/src/components/shared/`. It renders three dependent dropdowns: UserType → ProjectType → SubCategory. Used by all three master-data forms and the Add Claim form. Filters out inactive entries.

---

## 6. End-user UI

### 6.1 Sidebar restructure (`UserLayout.tsx`)

The existing user sidebar shows a dynamic Category → SubCategory tree for URL access. Phase 1 wraps that tree in a labeled section and adds a Claims section above it:

```
PROXY URL APP            (logo)
─────────────────────────────────
  Dashboard              /dashboard          (existing — URL stats)

CLAIMS
  Claim Dashboard        /claims

MY URLS
  > Category A
    > SubCategory A1
    > SubCategory A2
  > Category B
    ...
```

The existing dashboard (`/dashboard`) is **unchanged** in Phase 1. Its title may be tweaked to "URL Activity Dashboard" to disambiguate from the new "Claim Dashboard", but the content stays identical.

### 6.2 Claim Dashboard (`/claims`)

A single screen showing claims in the caller's scope.

**Header row:**
- Page title: "Claim Dashboard"
- "+ Add Claim" button — visible only for `TEAM_LEAD` and `ADMIN`.

**Filter row:**
- SubCategory dropdown (only SubCategories with claims visible to caller).
- Workflow Status dropdown (multi-select).
- Assigned To dropdown — TL/Admin sees all users in scope; regular User sees a fixed "Assigned to me" toggle instead.
- Search box (matches `claimId` substring, case-insensitive).

**Table columns:**

| # | Column                | Note                                                        |
|---|-----------------------|-------------------------------------------------------------|
| 1 | Claim ID              | clickable → `/claims/:id`                                   |
| 2 | SubCategory           |                                                             |
| 3 | Workflow Status       | badge styled by `isTerminal`                                |
| 4 | Assigned To           | user fullName or "Unassigned"                               |
| 5 | Spell Check           | PENDING badge (Phase 1 — always PENDING)                   |
| 6 | QR                    | PENDING badge                                               |
| 7 | Meta Extraction       | PENDING badge                                               |
| 8 | Intra-Claim Compare   | PENDING badge                                               |
| 9 | Full Scan             | PENDING badge                                               |
|10 | Created               | relative time                                               |
|11 | Actions               | "Open" → update page                                        |

For a regular `USER`, rows where `assignedToUserId !== user.id` render the Claim ID and Open action **disabled / muted** (visible-but-not-editable).

**Pagination:** existing `DataTable` pagination component.

### 6.3 Add Claim modal (TL / Admin only)

Fields:
- SubCategory (via `<SubCategoryPicker>`) — required, must have an active IsDefault status.
- Claim ID — required, non-empty string. Backend uniqueness check on (subCategoryId, claimId).
- Folder Path — optional (free-text in Phase 1; format-validated only if non-empty: same drive-letter rule).
- Assign To — optional dropdown (users in scope). Empty = unassigned.
- Initial Remark — optional textarea. If provided, written as the first ClaimRemark.

On submit: server sets `workflowStatusId = the SubCategory's IsDefault active StatusMaster.id`. All 5 validation statuses = PENDING.

### 6.4 Claim Update Page (`/claims/:id`)

Top-of-page metadata (read-only block):
- Claim ID, SubCategory, Created at / by, Assigned to (with reassign action for TL/Admin), Folder Path.
- Validation Status row: five badges (Spell, QR, Meta, Intra-Claim, Full Scan) — all PENDING.

**Update Claim card:**
- Current workflow status (badge).
- "Change Status" dropdown — optional. Lists only ACTIVE StatusMasters of this Claim's SubCategory.
- "Reassign to" dropdown — TL/Admin only. Lists active Users in scope, plus "Unassigned".
- "Remark" textarea — **always required to submit**. Non-empty trim-after.
- "Save" button. Calls `POST /claims/:id/remarks` with whichever fields were changed.

If the caller doesn't pass the `canEditClaim` check (regular User on an unassigned-to-them claim), this card renders disabled with copy: "You can view this claim, but only the assignee or a supervisor can update it." The remark textarea, status dropdown, and Save button are all disabled.

**Remarks timeline:**
- Reverse-chronological list of `ClaimRemark` rows.
- Each item: author full name, relative time, status change badge (e.g., `Pending → Approved`), remark text.
- Paginated (newest 20 inline, "Load more" pulls older).

**Documents section:**
- A placeholder card titled "Documents" with body: "Documents will appear here once the scanner is enabled (Phase 2)."
- No upload control in Phase 1.

### 6.5 Empty / inactive states

- If the user has no `UserAssignment`: Claim Dashboard shows the existing "Limited Access" amber banner pattern, no table.
- If their UserType / ProjectType is inactive: same banner, no table.
- If no claims in scope: friendly empty state with the Add Claim CTA (TL/Admin) or "No claims assigned yet" (User).

---

## 7. Migrations & seeding strategy

### 7.1 Migration order

A single Prisma migration named `add_claims_module` containing, in order:

1. Add `role` column to `users`, default `USER`.
2. Backfill `role`: `UPDATE users SET role = 'ADMIN' WHERE is_admin = TRUE;`
3. Drop `is_admin` column.
4. `CREATE TABLE status_masters`.
5. `CREATE TABLE document_type_masters`.
6. `CREATE TABLE claim_id_rules`.
7. `CREATE TABLE claims`.
8. `CREATE TABLE claim_remarks`.

Generate via `npx prisma migrate dev --name add_claims_module` and review the SQL before commit. Validate that step 2 runs before step 3 in the generated SQL — if not, split into two migrations.

### 7.2 Seed data updates (`server/prisma/seed.ts`)

- Update existing admin user creation to set `role: 'ADMIN'` instead of `isAdmin: true`.
- (Optional, dev-only) Seed a Team Lead user and a few sample claims under existing SubCategories so the dashboard is testable post-seed.
- For each existing SubCategory the seed creates, add at least one default `StatusMaster` (e.g., "Pending" with `isDefault = true`) so manual claim creation works out of the box during testing.

### 7.3 Backward compatibility

`isAdmin` is **removed**, not deprecated. This is a coordinated breaking change across server and client in the same release. No legacy clients are deployed elsewhere, so no shim needed (see CLAUDE.md: "Avoid backwards-compatibility hacks").

---

## 8. Testing approach

### 8.1 Backend (Jest, server workspace)

For each new route file, unit-test the service layer (not the routes directly — too much fixture noise). Tests cover:

- **StatusMasterService**
  - Setting a new `isDefault = true` clears the prior default within the SubCategory.
  - Cannot delete a StatusMaster referenced by a Claim (returns `STATUS_IN_USE`).
  - Listing filters by SubCategory + status.

- **DocumentTypeService**
  - GOVT requires `govtCode`; CUSTOM forbids it.
  - Unique `(govtCode, subCategoryId)` enforced.

- **ClaimIdRuleService**
  - `C:\anything` rejected with `INVALID_SCAN_LOCATION`.
  - `D:\Claims\Daily` accepted.
  - `/unix/path` rejected.
  - `startPosition + length > 200` rejected with `INVALID_RANGE`.
  - One rule per SubCategory enforced.

- **ClaimService**
  - Create assigns workflow status = SubCategory's default.
  - Updating workflow status writes a `ClaimRemark` row when remark provided.
  - `canEditClaim` returns true/false correctly for each role × ownership combination.
  - Soft delete sets `status = INACTIVE`, does not cascade.

- **Role guard** — middleware unit tests covering all three roles × ADMIN_REQUIRED / TEAM_LEAD_REQUIRED / no-requirement.

### 8.2 Frontend (manual verification per CLAUDE.md guidance)

CLAUDE.md says: for UI changes, start the dev server, exercise the golden path and edge cases in a browser, monitor for regressions. Phase 1 checklist:

- Admin can log in and create one of each: StatusMaster, DocumentTypeMaster, ClaimIdRule, Claim.
- Admin can deactivate a StatusMaster; if it's referenced by a Claim, deletion is rejected.
- Team Lead can log in, see only their (UserType, ProjectType) scope, create a Claim, update its status, and add remarks.
- Regular User can log in, see all claims in their pair but can only open + edit the ones assigned to them.
- Switching between My URLs and Claims in the sidebar works; the existing URL proxy flow is unchanged.
- The `/dashboard` page is untouched and still shows URL stats.
- Role enum migration: existing admin user still has admin powers after migration (smoke-check by attempting an admin-only action).

### 8.3 Type-check + lint

`npm run lint` and `npx tsc --noEmit` pass at the end of implementation. Existing tests pass (`npm run test`).

---

## 9. Out of scope (Phase 1 boundary — restated)

Documented to prevent scope creep during implementation:

- **No filesystem scanner.** `ClaimIdRule` is stored configuration only. No code reads files from disk in Phase 1.
- **No document upload or processing.** The Documents section on Claim Update Page is a placeholder.
- **No OCR / spell check / QR scan / metadata extraction / address matching / intra-claim comparison.** The 5 validation statuses are hard-coded PENDING and have no service producing them.
- **No Excel-rules engine, no rule sheet upload, no data point capture.**
- **No reports, no Excel export of claim sheet, no per-scan reports.**
- **No queuing system / background workers.** All operations are synchronous request/response.
- **No watermark / hologram / signature detection** (Phase 2+).
- **No zip/unzip handling.**
- **No status transition rules.** Any active status of a SubCategory can be set on a claim of that SubCategory.
- **No bulk claim import.** Claims are created one-by-one in Phase 1.

Each of these gets its own design when the time comes.

---

## 10. Open items deferred to the implementation plan

- Specific Prisma `onDelete` policies for each FK (the design above lists most explicitly; a couple are left as Prisma defaults — implementation plan will pin them all).
- The exact wording of empty-state copy and validation error messages — finalized during UI build.
- Whether `Claim.folderPath` validation should mirror `ClaimIdRule.scanLocation` (same drive-letter rule). Lean: yes, same regex, but noted as small implementation decision.
- The order in which the new admin sidebar items appear vs. the existing ones — proposal in §5.1 to be confirmed during build.
- Complete list of files affected by the `isAdmin → role` rename (every existing route file under `server/src/routes/admin/`, `auth.ts`, `sessionService.ts`, `authStore.ts`, login/impersonate responses, `ProtectedRoute`, etc.). Enumerated in the implementation plan, not here.

These are all small enough to resolve in the writing-plans step or during implementation without changing the design.

---

**Reviewer:** please read this end-to-end and respond with either:
- "Approved" — I'll move to `superpowers:writing-plans` to produce a step-by-step implementation plan.
- A list of changes — I'll revise this spec and re-run the self-review before plan writing.
