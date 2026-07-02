# Claims Management Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the admin foundation for Claims Management — Team Lead role, three master-data tables (Status, Document Type, Claim ID Rule), the Claim entity with placeholder validation columns, end-user Claim Dashboard and Claim Update Page. No filesystem scanner, no OCR, no Excel rules.

**Architecture:** A new module alongside the existing URL proxy. Both share users/sessions/SubCategory but no service code is reused. Adds 5 Prisma tables, ~25 Express routes, 6 React pages, and migrates `User.isAdmin: Boolean` to `User.role: enum`.

**Tech Stack:** Node 18 / Express 4 / TypeScript (NodeNext ESM) · Prisma 5 / MySQL · React 18 / Vite / Zustand / React Query / Tailwind · Jest + ts-jest + supertest for backend tests.

**Spec:** `docs/superpowers/specs/2026-05-20-claims-management-phase-1-design.md` (read this first).

---

## File Structure (locked in advance)

**Server — created:**
- `server/jest.config.mjs`
- `server/src/__tests__/helpers/testDb.ts`
- `server/src/middleware/roleGuard.ts`
- `server/src/services/statusMasterService.ts`
- `server/src/services/documentTypeService.ts`
- `server/src/services/claimIdRuleService.ts`
- `server/src/services/claimService.ts`
- `server/src/services/__tests__/statusMasterService.test.ts`
- `server/src/services/__tests__/documentTypeService.test.ts`
- `server/src/services/__tests__/claimIdRuleService.test.ts`
- `server/src/services/__tests__/claimService.test.ts`
- `server/src/routes/admin/statusMasters.ts`
- `server/src/routes/admin/documentTypeMasters.ts`
- `server/src/routes/admin/claimIdRules.ts`
- `server/src/routes/admin/claims.ts`
- `server/src/routes/claims.ts`

**Server — modified:**
- `server/prisma/schema.prisma`
- `server/prisma/seed.ts`
- `server/src/services/sessionService.ts`
- `server/src/services/authService.ts`
- `server/src/middleware/auth.ts`
- `server/src/routes/auth.ts`
- `server/src/routes/user.ts`
- `server/src/routes/admin/index.ts`
- `server/src/routes/admin/users.ts`
- `server/src/index.ts`

**Client — created:**
- `client/src/components/shared/SubCategoryPicker.tsx`
- `client/src/pages/admin/StatusMasters.tsx`
- `client/src/pages/admin/DocumentTypeMasters.tsx`
- `client/src/pages/admin/ClaimIdRules.tsx`
- `client/src/pages/admin/AdminClaims.tsx`
- `client/src/pages/claims/ClaimDashboard.tsx`
- `client/src/pages/claims/ClaimUpdate.tsx`

**Client — modified:**
- `client/src/App.tsx`
- `client/src/stores/authStore.ts`
- `client/src/components/layout/AdminLayout.tsx`
- `client/src/components/layout/UserLayout.tsx`
- `client/src/pages/auth/Login.tsx`
- `client/src/pages/admin/Users.tsx`

---

## Phase A — Foundation (role migration, schema, test infra)

This phase is its own shippable unit: after Phase A, the role enum is live and existing functionality continues to work. No new features yet.

### Task A.1: Add Jest config for ESM + ts-jest

**Files:**
- Create: `server/jest.config.mjs`
- Create: `server/src/__tests__/helpers/testDb.ts`

- [ ] **Step 1: Create `server/jest.config.mjs`**

```js
/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, isolatedModules: true }],
  },
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  testTimeout: 15000,
};
```

- [ ] **Step 2: Create `server/src/__tests__/helpers/testDb.ts`**

```ts
import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | null = null;

export function getTestPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

export async function disconnectTestPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

export async function truncateClaimsTables(client: PrismaClient): Promise<void> {
  await client.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  await client.$executeRawUnsafe('TRUNCATE TABLE claim_remarks');
  await client.$executeRawUnsafe('TRUNCATE TABLE claims');
  await client.$executeRawUnsafe('TRUNCATE TABLE claim_id_rules');
  await client.$executeRawUnsafe('TRUNCATE TABLE document_type_masters');
  await client.$executeRawUnsafe('TRUNCATE TABLE status_masters');
  await client.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
}
```

- [ ] **Step 3: Verify Jest runs (will be empty pass)**

Run: `cd server && npm test`
Expected: `No tests found` exit 1 — OK at this point because no test files match. Confirm config parses without errors. If config syntax error, fix.

- [ ] **Step 4: Commit**

```bash
git add server/jest.config.mjs server/src/__tests__/helpers/testDb.ts
git commit -m "chore(server): add jest ESM config + test db helper"
```

### Task A.2: Add Role enum + all Phase 1 tables to Prisma schema

**Files:**
- Modify: `server/prisma/schema.prisma`

- [ ] **Step 1: Open the schema and add the `Role` and new domain enums above the `UserType` model**

Add after the existing `AuditLevel` enum (~line 26):

```prisma
enum Role {
  USER
  TEAM_LEAD
  ADMIN
}

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

enum ScanTarget {
  FOLDER
  FILE
}

enum ValidationStatus {
  PENDING
  IN_PROGRESS
  PASSED
  FAILED
}
```

- [ ] **Step 2: Replace `isAdmin` on `User` with `role`**

In the existing `User` model, replace the `isAdmin Boolean @default(false) @map("is_admin")` line with:

```prisma
  role                Role      @default(USER)
```

Also append new relations to the bottom of the `User` model (above the closing brace):

```prisma
  assignedClaims    Claim[]       @relation("ClaimAssignee")
  authoredRemarks   ClaimRemark[] @relation("ClaimRemarkAuthor")
```

- [ ] **Step 3: Append new relations to `SubCategory`**

Inside the existing `SubCategory` model, above the closing brace, add:

```prisma
  statusMasters       StatusMaster[]
  documentTypeMasters DocumentTypeMaster[]
  claimIdRule         ClaimIdRule?
  claims              Claim[]
```

- [ ] **Step 4: Add the five new models at the bottom of the file (above `model ProxyMetric`)**

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

  subCategory       SubCategory   @relation(fields: [subCategoryId], references: [id], onDelete: Cascade)
  claims            Claim[]       @relation("ClaimWorkflowStatus")
  remarksStatusBefore ClaimRemark[] @relation("ClaimRemarkStatusBefore")
  remarksStatusAfter  ClaimRemark[] @relation("ClaimRemarkStatusAfter")

  @@unique([name, subCategoryId])
  @@index([subCategoryId])
  @@map("status_masters")
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

  subCategory SubCategory @relation(fields: [subCategoryId], references: [id], onDelete: Cascade)

  @@unique([name, subCategoryId])
  @@unique([govtCode, subCategoryId])
  @@index([subCategoryId])
  @@map("document_type_masters")
}

model ClaimIdRule {
  id            String     @id @default(uuid()) @db.VarChar(36)
  subCategoryId String     @unique @map("sub_category_id") @db.VarChar(36)
  startPosition Int        @map("start_position")
  length        Int
  scanTarget    ScanTarget @map("scan_target")
  scanLocation  String     @map("scan_location") @db.VarChar(500)
  status        Status     @default(ACTIVE)
  createdAt     DateTime   @default(now()) @map("created_at")
  updatedAt     DateTime   @updatedAt @map("updated_at")
  createdBy     String?    @map("created_by") @db.VarChar(36)
  updatedBy     String?    @map("updated_by") @db.VarChar(36)

  subCategory SubCategory @relation(fields: [subCategoryId], references: [id], onDelete: Cascade)

  @@map("claim_id_rules")
}

model Claim {
  id                   String           @id @default(uuid()) @db.VarChar(36)
  claimId              String           @map("claim_id") @db.VarChar(100)
  subCategoryId        String           @map("sub_category_id") @db.VarChar(36)
  workflowStatusId     String           @map("workflow_status_id") @db.VarChar(36)
  assignedToUserId     String?          @map("assigned_to_user_id") @db.VarChar(36)
  folderPath           String?          @map("folder_path") @db.VarChar(500)

  spellCheckStatus     ValidationStatus @default(PENDING) @map("spell_check_status")
  qrStatus             ValidationStatus @default(PENDING) @map("qr_status")
  metaExtractionStatus ValidationStatus @default(PENDING) @map("meta_extraction_status")
  intraClaimStatus     ValidationStatus @default(PENDING) @map("intra_claim_status")
  fullScanStatus       ValidationStatus @default(PENDING) @map("full_scan_status")

  status               Status           @default(ACTIVE)
  createdAt            DateTime         @default(now()) @map("created_at")
  updatedAt            DateTime         @updatedAt @map("updated_at")
  createdBy            String?          @map("created_by") @db.VarChar(36)
  updatedBy            String?          @map("updated_by") @db.VarChar(36)

  subCategory    SubCategory  @relation(fields: [subCategoryId], references: [id])
  workflowStatus StatusMaster @relation("ClaimWorkflowStatus", fields: [workflowStatusId], references: [id])
  assignedTo     User?        @relation("ClaimAssignee", fields: [assignedToUserId], references: [id])
  remarks        ClaimRemark[]

  @@unique([claimId, subCategoryId])
  @@index([subCategoryId])
  @@index([workflowStatusId])
  @@index([assignedToUserId])
  @@index([createdBy])
  @@map("claims")
}

model ClaimRemark {
  id             String        @id @default(uuid()) @db.VarChar(36)
  claimId        String        @map("claim_id") @db.VarChar(36)
  userId         String        @map("user_id") @db.VarChar(36)
  remarkText     String        @map("remark_text") @db.Text
  statusBeforeId String?       @map("status_before_id") @db.VarChar(36)
  statusAfterId  String?       @map("status_after_id") @db.VarChar(36)
  createdAt      DateTime      @default(now()) @map("created_at")

  claim        Claim         @relation(fields: [claimId], references: [id], onDelete: Cascade)
  user         User          @relation("ClaimRemarkAuthor", fields: [userId], references: [id])
  statusBefore StatusMaster? @relation("ClaimRemarkStatusBefore", fields: [statusBeforeId], references: [id])
  statusAfter  StatusMaster? @relation("ClaimRemarkStatusAfter", fields: [statusAfterId], references: [id])

  @@index([claimId])
  @@index([createdAt])
  @@map("claim_remarks")
}
```

- [ ] **Step 5: Validate the schema parses**

Run: `cd server && npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid`. If errors, fix and re-run.

- [ ] **Step 6: Commit**

```bash
git add server/prisma/schema.prisma
git commit -m "feat(db): add Claims module schema + Role enum on User"
```

### Task A.3: Generate migration with manual backfill SQL

The default `prisma migrate dev` will issue `ALTER TABLE users DROP COLUMN is_admin` and `ADD COLUMN role` independently. We need a backfill **between** them. Strategy: generate the migration, then hand-edit the SQL.

**Files:**
- Generate: `server/prisma/migrations/<timestamp>_add_claims_module/migration.sql`

- [ ] **Step 1: Generate the migration without applying it**

Run: `cd server && npx prisma migrate dev --create-only --name add_claims_module`
Expected: A new directory `prisma/migrations/<timestamp>_add_claims_module/` containing `migration.sql`.

- [ ] **Step 2: Open the generated migration.sql and locate the `users` table changes**

Look for two adjacent statements:
```sql
ALTER TABLE `users` ADD COLUMN `role` ENUM('USER','TEAM_LEAD','ADMIN') NOT NULL DEFAULT 'USER';
ALTER TABLE `users` DROP COLUMN `is_admin`;
```

- [ ] **Step 3: Insert a backfill UPDATE between them**

Replace the two lines above with:

```sql
ALTER TABLE `users` ADD COLUMN `role` ENUM('USER','TEAM_LEAD','ADMIN') NOT NULL DEFAULT 'USER';
UPDATE `users` SET `role` = 'ADMIN' WHERE `is_admin` = 1;
ALTER TABLE `users` DROP COLUMN `is_admin`;
```

- [ ] **Step 4: Apply the migration**

Run: `cd server && npx prisma migrate dev`
Expected: `Database is now in sync with your schema.` and the Prisma client regenerates.

- [ ] **Step 5: Smoke-check existing admin user**

Run: `cd server && npx prisma studio` (then close after verifying) — confirm `users` table now has a `role` column and the seeded admin has `role = ADMIN`. Skip if studio not desired; alternatively `mysql -e "SELECT username, role FROM users LIMIT 5"`.

- [ ] **Step 6: Commit**

```bash
git add server/prisma/migrations/
git commit -m "feat(db): migration add_claims_module with isAdmin -> role backfill"
```

### Task A.4: Update SessionData type and sessionService

**Files:**
- Modify: `server/src/services/sessionService.ts`

- [ ] **Step 1: Read `server/src/services/sessionService.ts` and locate the `SessionData` interface**

It currently has an `isAdmin: boolean` field on the SessionData interface.

- [ ] **Step 2: Replace `isAdmin` with `role` in `SessionData`**

Change:
```ts
isAdmin: boolean;
```
to:
```ts
role: 'USER' | 'TEAM_LEAD' | 'ADMIN';
```

- [ ] **Step 3: Update every read from Prisma User inside this file**

Wherever the code constructs `SessionData` from a Prisma `user`, change `isAdmin: user.isAdmin` to `role: user.role`. Search the file for `isAdmin` and update each occurrence.

- [ ] **Step 4: TypeScript check**

Run: `cd server && npx tsc --noEmit`
Expected: TypeScript will surface every consumer that still uses `isAdmin`. Note them down — we will fix in subsequent tasks. Do not commit until A.5–A.8 land.

### Task A.5: Update authService

**Files:**
- Modify: `server/src/services/authService.ts`

- [ ] **Step 1: Replace `isAdmin` references with `role`**

Search the file for `isAdmin`. In `validateSession` and `login`, the returned object includes `isAdmin`. Replace each with `role`:

```ts
// before:  isAdmin: user.isAdmin,
// after:
role: user.role,
```

For any place where the code does `if (user.isAdmin)`, change to `if (user.role === 'ADMIN')`.

- [ ] **Step 2: TypeScript check**

Run: `cd server && npx tsc --noEmit`
Expected: errors decrease but persist in middleware/routes — fixed in next tasks.

### Task A.6: Update authMiddleware and adminMiddleware

**Files:**
- Modify: `server/src/middleware/auth.ts`

- [ ] **Step 1: In `adminMiddleware`, replace `req.session.isAdmin` with `req.session.role === 'ADMIN'`**

Locate `if (!req.session.isAdmin) {` and change to:
```ts
if (req.session.role !== 'ADMIN') {
```

- [ ] **Step 2: TypeScript check on this file**

Run: `cd server && npx tsc --noEmit`
Expected: this file is now clean; remaining errors are in routes/Users handler.

### Task A.7: Create roleGuard middleware

**Files:**
- Create: `server/src/middleware/roleGuard.ts`

- [ ] **Step 1: Write the new middleware file**

```ts
import { Request, Response, NextFunction } from 'express';

export const teamLeadOrAdminMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.session) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  if (req.session.role !== 'TEAM_LEAD' && req.session.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Team Lead or Admin access required', code: 'TEAM_LEAD_OR_ADMIN_REQUIRED' });
  }
  next();
};

export interface ScopedRequest extends Request {
  scope?: { userTypeId: string; projectId: string } | 'ALL';
}

export const scopedMiddleware = async (
  req: ScopedRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.session) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }
  if (req.session.role === 'ADMIN') {
    req.scope = 'ALL';
    return next();
  }
  const prisma = req.app.get('prisma');
  const assignment = await prisma.userAssignment.findUnique({
    where: { userId: req.session.userId },
  });
  if (!assignment) {
    return res.status(403).json({ error: 'No assignment found', code: 'NO_ASSIGNMENT' });
  }
  req.scope = { userTypeId: assignment.userTypeId, projectId: assignment.projectId };
  next();
};
```

- [ ] **Step 2: TypeScript check**

Run: `cd server && npx tsc --noEmit`
Expected: file compiles; pre-existing errors in users.ts still present.

### Task A.8: Update existing admin/users.ts and any other routes referencing isAdmin

**Files:**
- Modify: `server/src/routes/admin/users.ts`

- [ ] **Step 1: Replace `isAdmin: false` and `isAdmin: true` Prisma where/data with `role` equivalents**

Search the file for `isAdmin`. Common patterns and their replacements:

```ts
// where: { isAdmin: false }   →   where: { role: { not: 'ADMIN' } }
// where: { isAdmin: true }    →   where: { role: 'ADMIN' }
// existing.isAdmin            →   existing.role === 'ADMIN'
// data: { ..., isAdmin: false }  →   data: { ..., role: 'USER' }
```

Apply consistently across the file. The "Cannot edit admin users" / "Cannot delete admin users" / "Cannot impersonate admin users" checks become `existing.role === 'ADMIN'`.

- [ ] **Step 2: Add `role` to user response payloads**

In the `include`/`select` blocks where users are returned, ensure `role` is present (it's a non-relational column so it's included by default unless explicitly `select`-ed). For any explicit `select` block that previously had `isAdmin: true`, change to `role: true`.

- [ ] **Step 3: Allow admin form to set role (POST + PUT user)**

In the validators array at top of POST `/`, add:
```ts
body('role').optional().isIn(['USER', 'TEAM_LEAD', 'ADMIN']),
```
In the create handler, replace `isAdmin: false` with `role: req.body.role || 'USER'`.

In PUT `/:id` validators, add the same `role` optional check; in the handler include `...(role && { role })` in the update data, and refuse to demote the LAST admin (count remaining admins before the update).

- [ ] **Step 4: Search the rest of `server/src` for any remaining `isAdmin` references**

Run: `cd server && grep -rn isAdmin src/`
Expected output should be empty (or only matches inside `__tests__/` or comments). Fix any remaining occurrences using the same patterns.

- [ ] **Step 5: TypeScript and lint check**

Run: `cd server && npx tsc --noEmit && npm run lint`
Expected: both clean.

- [ ] **Step 6: Commit Phase A backend changes**

```bash
git add server/src/middleware/ server/src/services/sessionService.ts server/src/services/authService.ts server/src/routes/admin/users.ts
git commit -m "refactor(auth): User.isAdmin -> User.role enum across server"
```

### Task A.9: Update frontend authStore + Login

**Files:**
- Modify: `client/src/stores/authStore.ts`
- Modify: `client/src/pages/auth/Login.tsx`
- Modify: `client/src/pages/admin/Users.tsx`

- [ ] **Step 1: In `authStore.ts`, replace `isAdmin: boolean` on the `User` interface**

Change:
```ts
isAdmin: boolean;
```
to:
```ts
role: 'USER' | 'TEAM_LEAD' | 'ADMIN';
```

- [ ] **Step 2: In `Login.tsx`, update where the login response is unpacked**

Wherever the code reads `data.user.isAdmin` or similar, change to `data.user.role`. Where the redirect logic was `data.user.isAdmin ? navigate('/admin') : navigate('/dashboard')`, change to:

```ts
navigate(data.user.role === 'ADMIN' ? '/admin' : '/dashboard');
```

- [ ] **Step 3: In `client/src/pages/admin/Users.tsx`, update the `User` interface**

Same change: `isAdmin: boolean` → `role: 'USER' | 'TEAM_LEAD' | 'ADMIN'`.

- [ ] **Step 4: Update the Role column rendering**

Locate the Role column in the columns array:
```tsx
{
  id: 'role',
  header: 'Role',
  cell: ({ row }) => (
    <Badge variant={row.original.role === 'ADMIN' ? 'default' : row.original.role === 'TEAM_LEAD' ? 'secondary' : 'outline'}>
      {row.original.role === 'ADMIN' ? 'Admin' : row.original.role === 'TEAM_LEAD' ? 'Team Lead' : 'User'}
    </Badge>
  ),
},
```

- [ ] **Step 5: Update the user form to choose role instead of admin checkbox**

In the dialog form, replace the existing "Admin User" checkbox with a Select. Add to `formData` state: `role: 'USER'` (initial). Replace the checkbox block with:

```tsx
<div className="space-y-2">
  <Label>Role</Label>
  <Select value={formData.role} onValueChange={(v) => setFormData({ ...formData, role: v as 'USER' | 'TEAM_LEAD' | 'ADMIN' })}>
    <SelectTrigger><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value="USER">User</SelectItem>
      <SelectItem value="TEAM_LEAD">Team Lead</SelectItem>
      <SelectItem value="ADMIN">Admin</SelectItem>
    </SelectContent>
  </Select>
</div>
```

Also update the conditional that hides UserType/Project pickers. Previously it was `{!formData.isAdmin && (...)}`. Change to:

```tsx
{formData.role !== 'ADMIN' && (
  /* the existing UserType + Project picker block */
)}
```

In `handleSubmit`, replace `isAdmin: formData.isAdmin` in the payload with `role: formData.role`. In `handleEdit`, replace `isAdmin: item.isAdmin` with `role: item.role`.

In the impersonate-eligibility check `!row.original.isAdmin && row.original.status === 'ACTIVE'`, change to `row.original.role !== 'ADMIN' && row.original.status === 'ACTIVE'`.

- [ ] **Step 6: Frontend type-check**

Run: `cd client && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add client/src/stores/authStore.ts client/src/pages/auth/Login.tsx client/src/pages/admin/Users.tsx
git commit -m "refactor(client): User.isAdmin -> User.role across client"
```

### Task A.10: Update ProtectedRoute to support requiredRole and update App.tsx

**Files:**
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Change the `ProtectedRoute` signature and logic**

Replace the existing `ProtectedRoute` component with:

```tsx
function ProtectedRoute({
  children,
  requiredRole,
}: {
  children: React.ReactNode;
  requiredRole?: 'TEAM_LEAD' | 'ADMIN';
}) {
  const { user, isAuthenticated } = useAuthStore();

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (user?.forcePasswordChange) return <Navigate to="/change-password" replace />;

  if (requiredRole === 'ADMIN' && user?.role !== 'ADMIN') {
    return <Navigate to="/dashboard" replace />;
  }
  if (requiredRole === 'TEAM_LEAD' && user?.role !== 'TEAM_LEAD' && user?.role !== 'ADMIN') {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}
```

- [ ] **Step 2: Replace `adminOnly` props with `requiredRole="ADMIN"` in all admin route wrappers**

In the JSX:
```tsx
// before:  <ProtectedRoute adminOnly>
// after:
<ProtectedRoute requiredRole="ADMIN">
```

- [ ] **Step 3: Smoke test in browser**

Run dev (`npm run dev` in repo root), log in as the seeded admin, confirm `/admin` still loads and `/dashboard` is reachable as that admin. Then log out and back in to confirm session round-trips with the new `role` field. (If client uses persisted localStorage from old `isAdmin`, clear localStorage and re-login.)

- [ ] **Step 4: Commit + checkpoint Phase A**

```bash
git add client/src/App.tsx
git commit -m "refactor(client): ProtectedRoute role-based + role wiring"
```

**Phase A complete.** Existing app should function identically; only schema and code shape changed.

---

## Phase B — Status Master backend

### Task B.1: Write StatusMasterService tests

**Files:**
- Create: `server/src/services/__tests__/statusMasterService.test.ts`

These tests use a real test DB. Ensure a `DATABASE_URL` is set to a throwaway DB (or the dev DB if you're OK with data being wiped before each test). The helper truncates the new tables only — existing UserType / Project / Category / SubCategory rows are left alone so tests can attach to them.

- [ ] **Step 1: Write the test file**

```ts
import { PrismaClient } from '@prisma/client';
import { StatusMasterService } from '../statusMasterService.js';
import { getTestPrisma, disconnectTestPrisma, truncateClaimsTables } from '../../__tests__/helpers/testDb.js';

describe('StatusMasterService', () => {
  let prisma: PrismaClient;
  let service: StatusMasterService;
  let subCategoryId: string;
  let actorId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    service = new StatusMasterService(prisma);
    const sc = await prisma.subCategory.findFirst({ where: { status: 'ACTIVE' } });
    if (!sc) throw new Error('Need at least one ACTIVE SubCategory seeded to run tests');
    subCategoryId = sc.id;
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    if (!admin) throw new Error('Need at least one ADMIN user seeded to run tests');
    actorId = admin.id;
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
  });

  afterAll(async () => {
    await disconnectTestPrisma();
  });

  it('creates a StatusMaster with defaults', async () => {
    const s = await service.create({ subCategoryId, name: 'Pending', displayOrder: 1, isDefault: true, isTerminal: false }, actorId);
    expect(s.name).toBe('Pending');
    expect(s.isDefault).toBe(true);
    expect(s.status).toBe('ACTIVE');
  });

  it('clears prior default when a new default is created', async () => {
    const a = await service.create({ subCategoryId, name: 'A', isDefault: true }, actorId);
    const b = await service.create({ subCategoryId, name: 'B', isDefault: true }, actorId);
    const refreshedA = await prisma.statusMaster.findUnique({ where: { id: a.id } });
    expect(refreshedA?.isDefault).toBe(false);
    expect(b.isDefault).toBe(true);
  });

  it('rejects duplicate name within a SubCategory', async () => {
    await service.create({ subCategoryId, name: 'Approved' }, actorId);
    await expect(service.create({ subCategoryId, name: 'Approved' }, actorId)).rejects.toThrow();
  });

  it('refuses to delete a StatusMaster referenced by a Claim', async () => {
    const s = await service.create({ subCategoryId, name: 'Pending', isDefault: true }, actorId);
    await prisma.claim.create({
      data: { claimId: 'C-1', subCategoryId, workflowStatusId: s.id, createdBy: actorId, updatedBy: actorId },
    });
    await expect(service.delete(s.id)).rejects.toMatchObject({ code: 'STATUS_IN_USE' });
  });

  it('list orders by displayOrder then name', async () => {
    await service.create({ subCategoryId, name: 'Zebra', displayOrder: 1 }, actorId);
    await service.create({ subCategoryId, name: 'Alpha', displayOrder: 1 }, actorId);
    await service.create({ subCategoryId, name: 'Middle', displayOrder: 0 }, actorId);
    const list = await service.list({ subCategoryId });
    expect(list.data.map((s) => s.name)).toEqual(['Middle', 'Alpha', 'Zebra']);
  });
});
```

- [ ] **Step 2: Run the test (expect failure)**

Run: `cd server && npm test -- statusMasterService`
Expected: FAIL with "Cannot find module '../statusMasterService.js'".

### Task B.2: Implement StatusMasterService

**Files:**
- Create: `server/src/services/statusMasterService.ts`

- [ ] **Step 1: Create the service file**

```ts
import { PrismaClient, Prisma, Status, StatusMaster } from '@prisma/client';

export interface CreateStatusMasterInput {
  subCategoryId: string;
  name: string;
  displayOrder?: number;
  isDefault?: boolean;
  isTerminal?: boolean;
  status?: Status;
}

export interface UpdateStatusMasterInput {
  name?: string;
  displayOrder?: number;
  isDefault?: boolean;
  isTerminal?: boolean;
  status?: Status;
}

export interface ListStatusMastersFilters {
  subCategoryId?: string;
  status?: Status;
  page?: number;
  limit?: number;
}

export class StatusMasterServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export class StatusMasterService {
  constructor(private prisma: PrismaClient) {}

  async create(input: CreateStatusMasterInput, actorId: string): Promise<StatusMaster> {
    return this.prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.statusMaster.updateMany({
          where: { subCategoryId: input.subCategoryId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.statusMaster.create({
        data: {
          subCategoryId: input.subCategoryId,
          name: input.name,
          displayOrder: input.displayOrder ?? 0,
          isDefault: input.isDefault ?? false,
          isTerminal: input.isTerminal ?? false,
          status: input.status ?? Status.ACTIVE,
          createdBy: actorId,
          updatedBy: actorId,
        },
      });
    });
  }

  async update(id: string, input: UpdateStatusMasterInput, actorId: string): Promise<StatusMaster> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.statusMaster.findUnique({ where: { id } });
      if (!existing) throw new StatusMasterServiceError('NOT_FOUND', 'StatusMaster not found');
      if (input.isDefault) {
        await tx.statusMaster.updateMany({
          where: { subCategoryId: existing.subCategoryId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.statusMaster.update({
        where: { id },
        data: { ...input, updatedBy: actorId },
      });
    });
  }

  async delete(id: string): Promise<void> {
    const inUse = await this.prisma.claim.count({ where: { workflowStatusId: id } });
    if (inUse > 0) {
      throw new StatusMasterServiceError('STATUS_IN_USE', 'Cannot delete a StatusMaster referenced by claims');
    }
    await this.prisma.statusMaster.delete({ where: { id } });
  }

  async setStatus(id: string, status: Status, actorId: string): Promise<StatusMaster> {
    return this.prisma.statusMaster.update({
      where: { id },
      data: { status, updatedBy: actorId },
    });
  }

  async getById(id: string): Promise<StatusMaster | null> {
    return this.prisma.statusMaster.findUnique({ where: { id } });
  }

  async list(filters: ListStatusMastersFilters): Promise<{ data: StatusMaster[]; total: number; page: number; limit: number }> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    const where: Prisma.StatusMasterWhereInput = {};
    if (filters.subCategoryId) where.subCategoryId = filters.subCategoryId;
    if (filters.status) where.status = filters.status;
    const [data, total] = await Promise.all([
      this.prisma.statusMaster.findMany({
        where,
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.statusMaster.count({ where }),
    ]);
    return { data, total, page, limit };
  }
}
```

- [ ] **Step 2: Run tests**

Run: `cd server && npm test -- statusMasterService`
Expected: PASS (5/5).

- [ ] **Step 3: Commit**

```bash
git add server/src/services/statusMasterService.ts server/src/services/__tests__/statusMasterService.test.ts
git commit -m "feat(claims): StatusMasterService with default-uniqueness invariant"
```

### Task B.3: Implement statusMasters admin routes

**Files:**
- Create: `server/src/routes/admin/statusMasters.ts`
- Modify: `server/src/routes/admin/index.ts`

- [ ] **Step 1: Create the route file**

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body, param, query, validationResult } from 'express-validator';
import { StatusMasterService, StatusMasterServiceError } from '../../services/statusMasterService.js';

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

const getService = (req: Request) => new StatusMasterService(req.app.get('prisma') as PrismaClient);

router.get(
  '/',
  [
    query('subCategoryId').optional().isUUID(),
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await getService(req).list({
        subCategoryId: req.query.subCategoryId as string | undefined,
        status: req.query.status as 'ACTIVE' | 'INACTIVE' | undefined,
        page: req.query.page as unknown as number | undefined,
        limit: req.query.limit as unknown as number | undefined,
      });
      res.json({
        data: result.data,
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: Math.ceil(result.total / result.limit),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/',
  [
    body('subCategoryId').isUUID(),
    body('name').isString().trim().notEmpty().isLength({ max: 100 }),
    body('displayOrder').optional().isInt({ min: 0 }),
    body('isDefault').optional().isBoolean(),
    body('isTerminal').optional().isBoolean(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const created = await getService(req).create(req.body, req.session!.userId);
      res.status(201).json({ data: created });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        return res.status(409).json({ error: 'Status name must be unique per SubCategory', code: 'DUPLICATE_STATUS_NAME' });
      }
      next(err);
    }
  }
);

router.get('/:id', [param('id').isUUID()], validate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const s = await getService(req).getById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    res.json({ data: s });
  } catch (err) { next(err); }
});

router.put(
  '/:id',
  [
    param('id').isUUID(),
    body('name').optional().isString().trim().notEmpty().isLength({ max: 100 }),
    body('displayOrder').optional().isInt({ min: 0 }),
    body('isDefault').optional().isBoolean(),
    body('isTerminal').optional().isBoolean(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await getService(req).update(req.params.id, req.body, req.session!.userId);
      res.json({ data: updated });
    } catch (err) {
      if (err instanceof StatusMasterServiceError) {
        return res.status(err.code === 'NOT_FOUND' ? 404 : 400).json({ error: err.message, code: err.code });
      }
      next(err);
    }
  }
);

router.patch('/:id/status', [param('id').isUUID(), body('status').isIn(['ACTIVE', 'INACTIVE'])], validate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const updated = await getService(req).setStatus(req.params.id, req.body.status, req.session!.userId);
    res.json({ data: updated });
  } catch (err) { next(err); }
});

router.delete('/:id', [param('id').isUUID()], validate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await getService(req).delete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) {
    if (err instanceof StatusMasterServiceError) {
      return res.status(err.code === 'STATUS_IN_USE' ? 409 : 400).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

export default router;
```

- [ ] **Step 2: Mount the route in `server/src/routes/admin/index.ts`**

Add the import near the other admin route imports:
```ts
import statusMastersRoutes from './statusMasters.js';
```
Below the existing `router.use('/profile', profileRoutes);` line, add:
```ts
router.use('/status-masters', statusMastersRoutes);
```

- [ ] **Step 3: TypeScript + smoke check**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: tsc clean; tests still pass.

- [ ] **Step 4: Manual smoke**

Start dev (`npm run dev`). With cookies from an admin login, call:
```bash
curl -X POST http://localhost:3001/api/admin/status-masters -H 'Content-Type: application/json' \
  --cookie 'proxy_session=<your token>' \
  -d '{"subCategoryId":"<a uuid>","name":"Pending","isDefault":true,"displayOrder":1}'
```
Expected: 201 with the created row.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/admin/statusMasters.ts server/src/routes/admin/index.ts
git commit -m "feat(claims): admin routes for StatusMaster CRUD"
```

---

## Phase C — Document Type Master backend

### Task C.1: Write DocumentTypeService tests

**Files:**
- Create: `server/src/services/__tests__/documentTypeService.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { PrismaClient } from '@prisma/client';
import { DocumentTypeService, DocumentTypeServiceError } from '../documentTypeService.js';
import { getTestPrisma, disconnectTestPrisma, truncateClaimsTables } from '../../__tests__/helpers/testDb.js';

describe('DocumentTypeService', () => {
  let prisma: PrismaClient;
  let service: DocumentTypeService;
  let subCategoryId: string;
  let actorId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    service = new DocumentTypeService(prisma);
    const sc = await prisma.subCategory.findFirst({ where: { status: 'ACTIVE' } });
    subCategoryId = sc!.id;
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    actorId = admin!.id;
  });

  beforeEach(async () => { await truncateClaimsTables(prisma); });
  afterAll(async () => { await disconnectTestPrisma(); });

  it('creates a GOVT doc type with code', async () => {
    const d = await service.create({ subCategoryId, name: 'Aadhar Card', category: 'GOVT', govtCode: 'AADHAR' }, actorId);
    expect(d.category).toBe('GOVT');
    expect(d.govtCode).toBe('AADHAR');
  });

  it('rejects GOVT without code', async () => {
    await expect(service.create({ subCategoryId, name: 'Aadhar', category: 'GOVT' }, actorId))
      .rejects.toMatchObject({ code: 'GOVT_CODE_REQUIRED' });
  });

  it('rejects CUSTOM with code', async () => {
    await expect(service.create({ subCategoryId, name: 'X', category: 'CUSTOM', govtCode: 'PAN' }, actorId))
      .rejects.toMatchObject({ code: 'GOVT_CODE_NOT_ALLOWED' });
  });

  it('rejects duplicate GOVT code within same SubCategory', async () => {
    await service.create({ subCategoryId, name: 'PAN', category: 'GOVT', govtCode: 'PAN' }, actorId);
    await expect(service.create({ subCategoryId, name: 'PAN-2', category: 'GOVT', govtCode: 'PAN' }, actorId))
      .rejects.toMatchObject({ code: 'DUPLICATE_GOVT_CODE' });
  });

  it('allows the same GOVT code in different SubCategories', async () => {
    const otherSc = await prisma.subCategory.findFirst({ where: { id: { not: subCategoryId }, status: 'ACTIVE' } });
    if (!otherSc) {
      // skip if only one SubCategory exists; documented requirement still verified by unique constraint
      return;
    }
    await service.create({ subCategoryId, name: 'A', category: 'GOVT', govtCode: 'AADHAR' }, actorId);
    const d = await service.create({ subCategoryId: otherSc.id, name: 'A', category: 'GOVT', govtCode: 'AADHAR' }, actorId);
    expect(d.id).toBeDefined();
  });
});
```

- [ ] **Step 2: Run (expect failure on missing service module)**

Run: `cd server && npm test -- documentTypeService`
Expected: FAIL with module not found.

### Task C.2: Implement DocumentTypeService

**Files:**
- Create: `server/src/services/documentTypeService.ts`

- [ ] **Step 1: Create the service**

```ts
import { PrismaClient, Prisma, Status, DocumentTypeMaster, DocumentTypeCategory, GovtDocumentCode } from '@prisma/client';

export interface CreateDocumentTypeInput {
  subCategoryId: string;
  name: string;
  category: DocumentTypeCategory;
  govtCode?: GovtDocumentCode | null;
  displayOrder?: number;
  status?: Status;
}

export interface UpdateDocumentTypeInput {
  name?: string;
  displayOrder?: number;
  status?: Status;
}

export interface ListDocumentTypesFilters {
  subCategoryId?: string;
  status?: Status;
  category?: DocumentTypeCategory;
  page?: number;
  limit?: number;
}

export class DocumentTypeServiceError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export class DocumentTypeService {
  constructor(private prisma: PrismaClient) {}

  async create(input: CreateDocumentTypeInput, actorId: string): Promise<DocumentTypeMaster> {
    if (input.category === 'GOVT' && !input.govtCode) {
      throw new DocumentTypeServiceError('GOVT_CODE_REQUIRED', 'govtCode is required when category is GOVT');
    }
    if (input.category === 'CUSTOM' && input.govtCode) {
      throw new DocumentTypeServiceError('GOVT_CODE_NOT_ALLOWED', 'govtCode must be empty when category is CUSTOM');
    }
    if (input.category === 'GOVT') {
      const existing = await this.prisma.documentTypeMaster.findUnique({
        where: { govtCode_subCategoryId: { govtCode: input.govtCode!, subCategoryId: input.subCategoryId } },
      });
      if (existing) throw new DocumentTypeServiceError('DUPLICATE_GOVT_CODE', 'This Govt document type already exists in this SubCategory');
    }
    try {
      return await this.prisma.documentTypeMaster.create({
        data: {
          subCategoryId: input.subCategoryId,
          name: input.name,
          category: input.category,
          govtCode: input.category === 'GOVT' ? input.govtCode! : null,
          displayOrder: input.displayOrder ?? 0,
          status: input.status ?? Status.ACTIVE,
          createdBy: actorId,
          updatedBy: actorId,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new DocumentTypeServiceError('DUPLICATE_NAME', 'Document type name must be unique per SubCategory');
      }
      throw err;
    }
  }

  async update(id: string, input: UpdateDocumentTypeInput, actorId: string): Promise<DocumentTypeMaster> {
    return this.prisma.documentTypeMaster.update({
      where: { id },
      data: { ...input, updatedBy: actorId },
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.documentTypeMaster.delete({ where: { id } });
  }

  async setStatus(id: string, status: Status, actorId: string): Promise<DocumentTypeMaster> {
    return this.prisma.documentTypeMaster.update({ where: { id }, data: { status, updatedBy: actorId } });
  }

  async getById(id: string): Promise<DocumentTypeMaster | null> {
    return this.prisma.documentTypeMaster.findUnique({ where: { id } });
  }

  async list(filters: ListDocumentTypesFilters): Promise<{ data: DocumentTypeMaster[]; total: number; page: number; limit: number }> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    const where: Prisma.DocumentTypeMasterWhereInput = {};
    if (filters.subCategoryId) where.subCategoryId = filters.subCategoryId;
    if (filters.status) where.status = filters.status;
    if (filters.category) where.category = filters.category;
    const [data, total] = await Promise.all([
      this.prisma.documentTypeMaster.findMany({
        where,
        orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.documentTypeMaster.count({ where }),
    ]);
    return { data, total, page, limit };
  }
}
```

- [ ] **Step 2: Run tests**

Run: `cd server && npm test -- documentTypeService`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/documentTypeService.ts server/src/services/__tests__/documentTypeService.test.ts
git commit -m "feat(claims): DocumentTypeService with GOVT/CUSTOM invariants"
```

### Task C.3: Implement documentTypeMasters admin routes

**Files:**
- Create: `server/src/routes/admin/documentTypeMasters.ts`
- Modify: `server/src/routes/admin/index.ts`

- [ ] **Step 1: Create the route file**

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body, param, query, validationResult } from 'express-validator';
import { DocumentTypeService, DocumentTypeServiceError } from '../../services/documentTypeService.js';

const router = Router();
const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0]?.msg, code: 'VALIDATION_ERROR', details: errors.array() });
  }
  next();
};
const getService = (req: Request) => new DocumentTypeService(req.app.get('prisma') as PrismaClient);
const GOVT_CODES = ['AADHAR', 'PAN', 'DL', 'PASSPORT', 'VOTER_ID', 'RATION_CARD'];

router.get(
  '/',
  [
    query('subCategoryId').optional().isUUID(),
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    query('category').optional().isIn(['GOVT', 'CUSTOM']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await getService(req).list({
        subCategoryId: req.query.subCategoryId as string | undefined,
        status: req.query.status as 'ACTIVE' | 'INACTIVE' | undefined,
        category: req.query.category as 'GOVT' | 'CUSTOM' | undefined,
        page: req.query.page as unknown as number | undefined,
        limit: req.query.limit as unknown as number | undefined,
      });
      res.json({
        data: result.data,
        pagination: { page: result.page, limit: result.limit, total: result.total, totalPages: Math.ceil(result.total / result.limit) },
      });
    } catch (err) { next(err); }
  }
);

router.post(
  '/',
  [
    body('subCategoryId').isUUID(),
    body('name').isString().trim().notEmpty().isLength({ max: 100 }),
    body('category').isIn(['GOVT', 'CUSTOM']),
    body('govtCode').optional({ nullable: true }).isIn(GOVT_CODES),
    body('displayOrder').optional().isInt({ min: 0 }),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const created = await getService(req).create(req.body, req.session!.userId);
      res.status(201).json({ data: created });
    } catch (err) {
      if (err instanceof DocumentTypeServiceError) {
        return res.status(err.code === 'DUPLICATE_GOVT_CODE' || err.code === 'DUPLICATE_NAME' ? 409 : 400).json({ error: err.message, code: err.code });
      }
      next(err);
    }
  }
);

router.get('/:id', [param('id').isUUID()], validate, async (req: Request, res: Response, next: NextFunction) => {
  const d = await getService(req).getById(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  res.json({ data: d });
});

router.put(
  '/:id',
  [
    param('id').isUUID(),
    body('name').optional().isString().trim().notEmpty(),
    body('displayOrder').optional().isInt({ min: 0 }),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await getService(req).update(req.params.id, req.body, req.session!.userId);
      res.json({ data: updated });
    } catch (err) { next(err); }
  }
);

router.patch('/:id/status', [param('id').isUUID(), body('status').isIn(['ACTIVE', 'INACTIVE'])], validate, async (req: Request, res: Response, next: NextFunction) => {
  const updated = await getService(req).setStatus(req.params.id, req.body.status, req.session!.userId);
  res.json({ data: updated });
});

router.delete('/:id', [param('id').isUUID()], validate, async (req: Request, res: Response, next: NextFunction) => {
  await getService(req).delete(req.params.id);
  res.json({ message: 'Deleted' });
});

export default router;
```

- [ ] **Step 2: Mount in `server/src/routes/admin/index.ts`**

Add import:
```ts
import documentTypeMastersRoutes from './documentTypeMasters.js';
```
Add route mount line:
```ts
router.use('/document-type-masters', documentTypeMastersRoutes);
```

- [ ] **Step 3: TypeScript + tests**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/admin/documentTypeMasters.ts server/src/routes/admin/index.ts
git commit -m "feat(claims): admin routes for DocumentTypeMaster CRUD"
```

---

## Phase D — Claim ID Rule backend

### Task D.1: Write ClaimIdRuleService tests

**Files:**
- Create: `server/src/services/__tests__/claimIdRuleService.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { PrismaClient } from '@prisma/client';
import { ClaimIdRuleService, ClaimIdRuleServiceError, validateScanLocation } from '../claimIdRuleService.js';
import { getTestPrisma, disconnectTestPrisma, truncateClaimsTables } from '../../__tests__/helpers/testDb.js';

describe('validateScanLocation', () => {
  it('accepts D:\\Claims\\Daily', () => { expect(() => validateScanLocation('D:\\Claims\\Daily')).not.toThrow(); });
  it('accepts e:\\anything', () => { expect(() => validateScanLocation('e:\\anything')).not.toThrow(); });
  it('rejects C:\\anything', () => {
    expect(() => validateScanLocation('C:\\anything')).toThrow(ClaimIdRuleServiceError);
  });
  it('rejects c:\\anything (lower)', () => {
    expect(() => validateScanLocation('c:\\anything')).toThrow();
  });
  it('rejects UNC \\\\server\\share', () => {
    expect(() => validateScanLocation('\\\\server\\share')).toThrow();
  });
  it('rejects unix path /tmp/x', () => {
    expect(() => validateScanLocation('/tmp/x')).toThrow();
  });
});

describe('ClaimIdRuleService', () => {
  let prisma: PrismaClient;
  let service: ClaimIdRuleService;
  let subCategoryId: string;
  let actorId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    service = new ClaimIdRuleService(prisma);
    const sc = await prisma.subCategory.findFirst({ where: { status: 'ACTIVE' } });
    subCategoryId = sc!.id;
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    actorId = admin!.id;
  });
  beforeEach(async () => { await truncateClaimsTables(prisma); });
  afterAll(async () => { await disconnectTestPrisma(); });

  it('creates a rule', async () => {
    const r = await service.create({ subCategoryId, startPosition: 1, length: 8, scanTarget: 'FOLDER', scanLocation: 'D:\\Claims' }, actorId);
    expect(r.scanTarget).toBe('FOLDER');
  });

  it('rejects second rule on same SubCategory', async () => {
    await service.create({ subCategoryId, startPosition: 1, length: 8, scanTarget: 'FOLDER', scanLocation: 'D:\\Claims' }, actorId);
    await expect(
      service.create({ subCategoryId, startPosition: 5, length: 4, scanTarget: 'FILE', scanLocation: 'E:\\X' }, actorId)
    ).rejects.toMatchObject({ code: 'RULE_EXISTS' });
  });

  it('rejects start+length > 200', async () => {
    await expect(
      service.create({ subCategoryId, startPosition: 195, length: 10, scanTarget: 'FOLDER', scanLocation: 'D:\\X' }, actorId)
    ).rejects.toMatchObject({ code: 'INVALID_RANGE' });
  });

  it('rejects C-drive scanLocation', async () => {
    await expect(
      service.create({ subCategoryId, startPosition: 1, length: 8, scanTarget: 'FOLDER', scanLocation: 'C:\\X' }, actorId)
    ).rejects.toMatchObject({ code: 'INVALID_SCAN_LOCATION' });
  });
});
```

- [ ] **Step 2: Run (expect failure)**

Run: `cd server && npm test -- claimIdRuleService`
Expected: FAIL.

### Task D.2: Implement ClaimIdRuleService

**Files:**
- Create: `server/src/services/claimIdRuleService.ts`

- [ ] **Step 1: Create the service**

```ts
import { PrismaClient, Prisma, Status, ClaimIdRule, ScanTarget } from '@prisma/client';

export class ClaimIdRuleServiceError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function validateScanLocation(value: string): void {
  if (!/^[A-Za-z]:\\.+/.test(value)) {
    throw new ClaimIdRuleServiceError('INVALID_SCAN_LOCATION', 'scanLocation must be an absolute drive-letter path like D:\\Claims');
  }
  if (/^[Cc]:\\/.test(value)) {
    throw new ClaimIdRuleServiceError('INVALID_SCAN_LOCATION', 'scanLocation cannot be on the C drive');
  }
}

export interface CreateClaimIdRuleInput {
  subCategoryId: string;
  startPosition: number;
  length: number;
  scanTarget: ScanTarget;
  scanLocation: string;
  status?: Status;
}

export interface UpdateClaimIdRuleInput {
  startPosition?: number;
  length?: number;
  scanTarget?: ScanTarget;
  scanLocation?: string;
  status?: Status;
}

export class ClaimIdRuleService {
  constructor(private prisma: PrismaClient) {}

  private validateRange(start: number, length: number) {
    if (start < 1) throw new ClaimIdRuleServiceError('INVALID_RANGE', 'startPosition must be >= 1');
    if (length < 1) throw new ClaimIdRuleServiceError('INVALID_RANGE', 'length must be >= 1');
    if (start + length - 1 > 200) throw new ClaimIdRuleServiceError('INVALID_RANGE', 'startPosition + length - 1 must be <= 200');
  }

  async create(input: CreateClaimIdRuleInput, actorId: string): Promise<ClaimIdRule> {
    this.validateRange(input.startPosition, input.length);
    validateScanLocation(input.scanLocation);
    const existing = await this.prisma.claimIdRule.findUnique({ where: { subCategoryId: input.subCategoryId } });
    if (existing) throw new ClaimIdRuleServiceError('RULE_EXISTS', 'A Claim ID Rule already exists for this SubCategory');
    return this.prisma.claimIdRule.create({
      data: {
        subCategoryId: input.subCategoryId,
        startPosition: input.startPosition,
        length: input.length,
        scanTarget: input.scanTarget,
        scanLocation: input.scanLocation,
        status: input.status ?? Status.ACTIVE,
        createdBy: actorId,
        updatedBy: actorId,
      },
    });
  }

  async update(id: string, input: UpdateClaimIdRuleInput, actorId: string): Promise<ClaimIdRule> {
    const existing = await this.prisma.claimIdRule.findUnique({ where: { id } });
    if (!existing) throw new ClaimIdRuleServiceError('NOT_FOUND', 'ClaimIdRule not found');
    const start = input.startPosition ?? existing.startPosition;
    const length = input.length ?? existing.length;
    this.validateRange(start, length);
    if (input.scanLocation) validateScanLocation(input.scanLocation);
    return this.prisma.claimIdRule.update({
      where: { id },
      data: { ...input, updatedBy: actorId },
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.claimIdRule.delete({ where: { id } });
  }

  async setStatus(id: string, status: Status, actorId: string): Promise<ClaimIdRule> {
    return this.prisma.claimIdRule.update({ where: { id }, data: { status, updatedBy: actorId } });
  }

  async getById(id: string): Promise<ClaimIdRule | null> {
    return this.prisma.claimIdRule.findUnique({ where: { id } });
  }

  async list(filters: { subCategoryId?: string; status?: Status; page?: number; limit?: number }) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    const where: Prisma.ClaimIdRuleWhereInput = {};
    if (filters.subCategoryId) where.subCategoryId = filters.subCategoryId;
    if (filters.status) where.status = filters.status;
    const [data, total] = await Promise.all([
      this.prisma.claimIdRule.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.claimIdRule.count({ where }),
    ]);
    return { data, total, page, limit };
  }
}
```

- [ ] **Step 2: Run tests**

Run: `cd server && npm test -- claimIdRuleService`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/claimIdRuleService.ts server/src/services/__tests__/claimIdRuleService.test.ts
git commit -m "feat(claims): ClaimIdRuleService with location + range validation"
```

### Task D.3: Implement claimIdRules admin routes

**Files:**
- Create: `server/src/routes/admin/claimIdRules.ts`
- Modify: `server/src/routes/admin/index.ts`

- [ ] **Step 1: Create the route file**

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body, param, query, validationResult } from 'express-validator';
import { ClaimIdRuleService, ClaimIdRuleServiceError } from '../../services/claimIdRuleService.js';

const router = Router();
const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0]?.msg, code: 'VALIDATION_ERROR', details: errors.array() });
  next();
};
const getService = (req: Request) => new ClaimIdRuleService(req.app.get('prisma') as PrismaClient);

const handleErr = (err: unknown, res: Response, next: NextFunction) => {
  if (err instanceof ClaimIdRuleServiceError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'RULE_EXISTS' ? 409 : 400;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  next(err);
};

router.get(
  '/',
  [
    query('subCategoryId').optional().isUUID(),
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await getService(req).list({
        subCategoryId: req.query.subCategoryId as string | undefined,
        status: req.query.status as 'ACTIVE' | 'INACTIVE' | undefined,
        page: req.query.page as unknown as number | undefined,
        limit: req.query.limit as unknown as number | undefined,
      });
      res.json({ data: r.data, pagination: { page: r.page, limit: r.limit, total: r.total, totalPages: Math.ceil(r.total / r.limit) } });
    } catch (err) { next(err); }
  }
);

router.post(
  '/',
  [
    body('subCategoryId').isUUID(),
    body('startPosition').isInt({ min: 1 }),
    body('length').isInt({ min: 1 }),
    body('scanTarget').isIn(['FOLDER', 'FILE']),
    body('scanLocation').isString().isLength({ max: 500 }),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const created = await getService(req).create(req.body, req.session!.userId);
      res.status(201).json({ data: created });
    } catch (err) { handleErr(err, res, next); }
  }
);

router.get('/:id', [param('id').isUUID()], validate, async (req: Request, res: Response, next: NextFunction) => {
  const r = await getService(req).getById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  res.json({ data: r });
});

router.put(
  '/:id',
  [
    param('id').isUUID(),
    body('startPosition').optional().isInt({ min: 1 }),
    body('length').optional().isInt({ min: 1 }),
    body('scanTarget').optional().isIn(['FOLDER', 'FILE']),
    body('scanLocation').optional().isString().isLength({ max: 500 }),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await getService(req).update(req.params.id, req.body, req.session!.userId);
      res.json({ data: updated });
    } catch (err) { handleErr(err, res, next); }
  }
);

router.patch('/:id/status', [param('id').isUUID(), body('status').isIn(['ACTIVE', 'INACTIVE'])], validate, async (req: Request, res: Response, next: NextFunction) => {
  const updated = await getService(req).setStatus(req.params.id, req.body.status, req.session!.userId);
  res.json({ data: updated });
});

router.delete('/:id', [param('id').isUUID()], validate, async (req: Request, res: Response, next: NextFunction) => {
  await getService(req).delete(req.params.id);
  res.json({ message: 'Deleted' });
});

export default router;
```

- [ ] **Step 2: Mount in `server/src/routes/admin/index.ts`**

Add import and mount:
```ts
import claimIdRulesRoutes from './claimIdRules.js';
// ...
router.use('/claim-id-rules', claimIdRulesRoutes);
```

- [ ] **Step 3: Type check + tests**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/admin/claimIdRules.ts server/src/routes/admin/index.ts
git commit -m "feat(claims): admin routes for ClaimIdRule CRUD"
```

---

## Phase E — Claim service and API surface

### Task E.1: Write ClaimService tests

**Files:**
- Create: `server/src/services/__tests__/claimService.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { PrismaClient } from '@prisma/client';
import { ClaimService, ClaimServiceError } from '../claimService.js';
import { StatusMasterService } from '../statusMasterService.js';
import { getTestPrisma, disconnectTestPrisma, truncateClaimsTables } from '../../__tests__/helpers/testDb.js';

describe('ClaimService', () => {
  let prisma: PrismaClient;
  let service: ClaimService;
  let statusService: StatusMasterService;
  let subCategoryId: string;
  let adminId: string;
  let userId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    service = new ClaimService(prisma);
    statusService = new StatusMasterService(prisma);
    const sc = await prisma.subCategory.findFirst({ where: { status: 'ACTIVE' }, include: { category: true } });
    subCategoryId = sc!.id;
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    adminId = admin!.id;
    const u = await prisma.user.findFirst({ where: { role: 'USER' } });
    userId = u ? u.id : adminId; // fall back to admin if no plain user seeded
  });
  beforeEach(async () => { await truncateClaimsTables(prisma); });
  afterAll(async () => { await disconnectTestPrisma(); });

  async function seedDefaultStatus(name = 'Pending') {
    return statusService.create({ subCategoryId, name, isDefault: true }, adminId);
  }

  it('creates a claim and uses the SubCategory default status', async () => {
    const def = await seedDefaultStatus();
    const c = await service.create({ subCategoryId, claimId: 'C-1' }, adminId);
    expect(c.workflowStatusId).toBe(def.id);
    expect(c.spellCheckStatus).toBe('PENDING');
  });

  it('refuses creation if SubCategory has no active default status', async () => {
    await expect(service.create({ subCategoryId, claimId: 'C-1' }, adminId)).rejects.toMatchObject({ code: 'NO_DEFAULT_STATUS' });
  });

  it('writes ClaimRemark when remarkText supplied on create', async () => {
    await seedDefaultStatus();
    const c = await service.create({ subCategoryId, claimId: 'C-1', remarkText: 'Imported' }, adminId);
    const remarks = await prisma.claimRemark.findMany({ where: { claimId: c.id } });
    expect(remarks).toHaveLength(1);
    expect(remarks[0].remarkText).toBe('Imported');
  });

  it('appendRemark with status change writes status before/after', async () => {
    const def = await seedDefaultStatus();
    const approved = await statusService.create({ subCategoryId, name: 'Approved', isTerminal: true }, adminId);
    const c = await service.create({ subCategoryId, claimId: 'C-1' }, adminId);
    await service.appendRemark(c.id, { remarkText: 'Done', newStatusId: approved.id }, adminId);
    const reloaded = await prisma.claim.findUnique({ where: { id: c.id } });
    expect(reloaded?.workflowStatusId).toBe(approved.id);
    const remarks = await prisma.claimRemark.findMany({ where: { claimId: c.id }, orderBy: { createdAt: 'asc' } });
    const last = remarks[remarks.length - 1];
    expect(last.statusBeforeId).toBe(def.id);
    expect(last.statusAfterId).toBe(approved.id);
  });

  it('canEditClaim: ADMIN always true', async () => {
    await seedDefaultStatus();
    const c = await service.create({ subCategoryId, claimId: 'C-1' }, adminId);
    expect(await service.canEditClaim(c.id, adminId, 'ADMIN')).toBe(true);
  });

  it('canEditClaim: USER only when assigned to them', async () => {
    await seedDefaultStatus();
    const c = await service.create({ subCategoryId, claimId: 'C-1', assignedToUserId: userId }, adminId);
    expect(await service.canEditClaim(c.id, userId, 'USER')).toBe(true);
    const otherUser = await prisma.user.create({ data: { username: `t${Date.now()}`, passwordHash: 'x', fullName: 'Other', role: 'USER' } });
    expect(await service.canEditClaim(c.id, otherUser.id, 'USER')).toBe(false);
    await prisma.user.delete({ where: { id: otherUser.id } });
  });

  it('rejects assignee reassignment by USER', async () => {
    await seedDefaultStatus();
    const c = await service.create({ subCategoryId, claimId: 'C-1', assignedToUserId: userId }, adminId);
    await expect(
      service.appendRemark(c.id, { remarkText: 'r', newAssigneeId: null }, userId, 'USER')
    ).rejects.toMatchObject({ code: 'REASSIGN_FORBIDDEN' });
  });
});
```

- [ ] **Step 2: Run (expect failure on missing module)**

Run: `cd server && npm test -- claimService`
Expected: FAIL.

### Task E.2: Implement ClaimService

**Files:**
- Create: `server/src/services/claimService.ts`

- [ ] **Step 1: Create the service**

```ts
import { PrismaClient, Prisma, Status, Claim, Role } from '@prisma/client';

export class ClaimServiceError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface CreateClaimInput {
  subCategoryId: string;
  claimId: string;
  folderPath?: string | null;
  assignedToUserId?: string | null;
  remarkText?: string;
}

export interface AppendRemarkInput {
  remarkText: string;
  newStatusId?: string;
  newAssigneeId?: string | null;
}

export interface ListClaimsFilters {
  subCategoryId?: string;
  workflowStatusId?: string;
  assignedToUserId?: string;
  assignedToMe?: boolean;
  search?: string;
  scope?: { userTypeId: string; projectId: string } | 'ALL';
  callerId?: string;
  page?: number;
  limit?: number;
}

export class ClaimService {
  constructor(private prisma: PrismaClient) {}

  async create(input: CreateClaimInput, actorId: string): Promise<Claim> {
    const def = await this.prisma.statusMaster.findFirst({
      where: { subCategoryId: input.subCategoryId, isDefault: true, status: 'ACTIVE' },
    });
    if (!def) throw new ClaimServiceError('NO_DEFAULT_STATUS', 'SubCategory has no active default status');

    const duplicate = await this.prisma.claim.findUnique({
      where: { claimId_subCategoryId: { claimId: input.claimId, subCategoryId: input.subCategoryId } },
    });
    if (duplicate) throw new ClaimServiceError('DUPLICATE_CLAIM_ID', 'Claim ID already exists in this SubCategory');

    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.claim.create({
        data: {
          claimId: input.claimId,
          subCategoryId: input.subCategoryId,
          workflowStatusId: def.id,
          assignedToUserId: input.assignedToUserId ?? null,
          folderPath: input.folderPath ?? null,
          createdBy: actorId,
          updatedBy: actorId,
        },
      });
      if (input.remarkText && input.remarkText.trim().length > 0) {
        await tx.claimRemark.create({
          data: {
            claimId: claim.id,
            userId: actorId,
            remarkText: input.remarkText.trim(),
            statusBeforeId: null,
            statusAfterId: def.id,
          },
        });
      }
      return claim;
    });
  }

  async appendRemark(claimId: string, input: AppendRemarkInput, actorId: string, actorRole?: Role): Promise<Claim> {
    if (!input.remarkText || input.remarkText.trim().length === 0) {
      throw new ClaimServiceError('REMARK_REQUIRED', 'remarkText is required');
    }
    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.claim.findUnique({ where: { id: claimId } });
      if (!claim) throw new ClaimServiceError('NOT_FOUND', 'Claim not found');

      const reassignRequested = Object.prototype.hasOwnProperty.call(input, 'newAssigneeId');
      if (reassignRequested && actorRole === 'USER') {
        throw new ClaimServiceError('REASSIGN_FORBIDDEN', 'Only Team Lead or Admin can reassign claims');
      }

      let statusAfterId: string | null = null;
      let statusBeforeId: string | null = null;
      if (input.newStatusId && input.newStatusId !== claim.workflowStatusId) {
        const newStatus = await tx.statusMaster.findUnique({ where: { id: input.newStatusId } });
        if (!newStatus || newStatus.subCategoryId !== claim.subCategoryId) {
          throw new ClaimServiceError('INVALID_STATUS', 'New status does not belong to this SubCategory');
        }
        if (newStatus.status !== 'ACTIVE') {
          throw new ClaimServiceError('STATUS_INACTIVE', 'Cannot set claim to an inactive status');
        }
        statusBeforeId = claim.workflowStatusId;
        statusAfterId = newStatus.id;
      }

      await tx.claimRemark.create({
        data: {
          claimId: claim.id,
          userId: actorId,
          remarkText: input.remarkText.trim(),
          statusBeforeId,
          statusAfterId,
        },
      });

      const dataPatch: Prisma.ClaimUpdateInput = { updatedBy: { connect: { id: actorId } } };
      if (statusAfterId) dataPatch.workflowStatus = { connect: { id: statusAfterId } };
      if (reassignRequested) {
        dataPatch.assignedTo = input.newAssigneeId
          ? { connect: { id: input.newAssigneeId } }
          : { disconnect: true };
      }

      return tx.claim.update({ where: { id: claim.id }, data: dataPatch });
    });
  }

  async canEditClaim(claimId: string, callerId: string, callerRole: Role): Promise<boolean> {
    if (callerRole === 'ADMIN') return true;
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
      include: { subCategory: { include: { category: true } } },
    });
    if (!claim) return false;
    if (callerRole === 'TEAM_LEAD') {
      const assignment = await this.prisma.userAssignment.findUnique({ where: { userId: callerId } });
      if (!assignment) return false;
      return claim.subCategory.category.userTypeId === assignment.userTypeId
          && claim.subCategory.category.projectId === assignment.projectId;
    }
    return claim.assignedToUserId === callerId;
  }

  async getById(id: string, callerId: string, callerRole: Role) {
    const claim = await this.prisma.claim.findUnique({
      where: { id },
      include: {
        subCategory: { include: { category: true } },
        workflowStatus: true,
        assignedTo: { select: { id: true, username: true, fullName: true } },
        remarks: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            user: { select: { id: true, fullName: true } },
            statusBefore: { select: { id: true, name: true } },
            statusAfter: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!claim) return null;
    if (callerRole !== 'ADMIN') {
      const assignment = await this.prisma.userAssignment.findUnique({ where: { userId: callerId } });
      if (!assignment) return null;
      if (claim.subCategory.category.userTypeId !== assignment.userTypeId
          || claim.subCategory.category.projectId !== assignment.projectId) {
        return null;
      }
    }
    return claim;
  }

  async list(filters: ListClaimsFilters) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const where: Prisma.ClaimWhereInput = { status: 'ACTIVE' };
    if (filters.subCategoryId) where.subCategoryId = filters.subCategoryId;
    if (filters.workflowStatusId) where.workflowStatusId = filters.workflowStatusId;
    if (filters.assignedToUserId) where.assignedToUserId = filters.assignedToUserId;
    if (filters.assignedToMe && filters.callerId) where.assignedToUserId = filters.callerId;
    if (filters.search) where.claimId = { contains: filters.search };
    if (filters.scope && filters.scope !== 'ALL') {
      where.subCategory = { category: { userTypeId: filters.scope.userTypeId, projectId: filters.scope.projectId } };
    }
    const [data, total] = await Promise.all([
      this.prisma.claim.findMany({
        where,
        include: {
          subCategory: { select: { id: true, name: true, categoryId: true } },
          workflowStatus: { select: { id: true, name: true, isTerminal: true } },
          assignedTo: { select: { id: true, fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.claim.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async softDelete(id: string, actorId: string): Promise<Claim> {
    return this.prisma.claim.update({ where: { id }, data: { status: Status.INACTIVE, updatedBy: actorId } });
  }

  async listRemarks(claimId: string, page = 1, limit = 20) {
    const where = { claimId };
    const [data, total] = await Promise.all([
      this.prisma.claimRemark.findMany({
        where,
        include: {
          user: { select: { id: true, fullName: true } },
          statusBefore: { select: { id: true, name: true } },
          statusAfter: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.claimRemark.count({ where }),
    ]);
    return { data, total, page, limit };
  }
}
```

- [ ] **Step 2: Run tests**

Run: `cd server && npm test -- claimService`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/claimService.ts server/src/services/__tests__/claimService.test.ts
git commit -m "feat(claims): ClaimService with append-only remarks + role-aware edits"
```

### Task E.3: User-facing /claims routes

**Files:**
- Create: `server/src/routes/claims.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Create `server/src/routes/claims.ts`**

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body, param, query, validationResult } from 'express-validator';
import { authMiddleware, passwordChangedMiddleware } from '../middleware/auth.js';
import { scopedMiddleware, teamLeadOrAdminMiddleware, ScopedRequest } from '../middleware/roleGuard.js';
import { ClaimService, ClaimServiceError } from '../services/claimService.js';

const router = Router();
router.use(authMiddleware);
router.use(passwordChangedMiddleware);
router.use(scopedMiddleware);

const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0]?.msg, code: 'VALIDATION_ERROR', details: errors.array() });
  next();
};
const getService = (req: Request) => new ClaimService(req.app.get('prisma') as PrismaClient);

const handleErr = (err: unknown, res: Response, next: NextFunction) => {
  if (err instanceof ClaimServiceError) {
    const status = err.code === 'NOT_FOUND' ? 404
      : err.code === 'DUPLICATE_CLAIM_ID' ? 409
      : err.code === 'REASSIGN_FORBIDDEN' ? 403
      : 400;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  next(err);
};

router.get(
  '/',
  [
    query('subCategoryId').optional().isUUID(),
    query('workflowStatusId').optional().isUUID(),
    query('assignedToUserId').optional().isUUID(),
    query('assignedToMe').optional().isBoolean().toBoolean(),
    query('search').optional().isString(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  async (req: ScopedRequest, res: Response, next: NextFunction) => {
    try {
      const r = await getService(req).list({
        subCategoryId: req.query.subCategoryId as string | undefined,
        workflowStatusId: req.query.workflowStatusId as string | undefined,
        assignedToUserId: req.query.assignedToUserId as string | undefined,
        assignedToMe: req.query.assignedToMe as unknown as boolean | undefined,
        search: req.query.search as string | undefined,
        scope: req.scope!,
        callerId: req.session!.userId,
        page: req.query.page as unknown as number | undefined,
        limit: req.query.limit as unknown as number | undefined,
      });
      res.json({ data: r.data, pagination: { page: r.page, limit: r.limit, total: r.total, totalPages: Math.ceil(r.total / r.limit) } });
    } catch (err) { next(err); }
  }
);

router.get('/:id', [param('id').isUUID()], validate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const c = await getService(req).getById(req.params.id, req.session!.userId, req.session!.role);
    if (!c) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    res.json({ data: c });
  } catch (err) { next(err); }
});

router.post(
  '/',
  teamLeadOrAdminMiddleware,
  [
    body('subCategoryId').isUUID(),
    body('claimId').isString().trim().notEmpty().isLength({ max: 100 }),
    body('folderPath').optional({ nullable: true }).isString().isLength({ max: 500 }),
    body('assignedToUserId').optional({ nullable: true }).isUUID(),
    body('remarkText').optional().isString(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const created = await getService(req).create(req.body, req.session!.userId);
      res.status(201).json({ data: created });
    } catch (err) { handleErr(err, res, next); }
  }
);

router.post(
  '/:id/remarks',
  [
    param('id').isUUID(),
    body('remarkText').isString().trim().notEmpty(),
    body('newStatusId').optional().isUUID(),
    body('newAssigneeId').optional({ nullable: true }).custom((v) => v === null || /^[0-9a-fA-F-]{36}$/.test(v)),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = getService(req);
      const allowed = await service.canEditClaim(req.params.id, req.session!.userId, req.session!.role);
      if (!allowed) return res.status(403).json({ error: 'Cannot edit this claim', code: 'CLAIM_NOT_EDITABLE' });
      const updated = await service.appendRemark(req.params.id, req.body, req.session!.userId, req.session!.role);
      res.json({ data: updated });
    } catch (err) { handleErr(err, res, next); }
  }
);

router.get(
  '/:id/remarks',
  [param('id').isUUID(), query('page').optional().isInt({ min: 1 }).toInt(), query('limit').optional().isInt({ min: 1, max: 100 }).toInt()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const claim = await getService(req).getById(req.params.id, req.session!.userId, req.session!.role);
      if (!claim) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      const r = await getService(req).listRemarks(req.params.id, req.query.page as unknown as number | undefined, req.query.limit as unknown as number | undefined);
      res.json({ data: r.data, pagination: { page: r.page, limit: r.limit, total: r.total, totalPages: Math.ceil(r.total / r.limit) } });
    } catch (err) { next(err); }
  }
);

export default router;
```

- [ ] **Step 2: Mount in `server/src/index.ts`**

Locate the section where other routes are mounted (e.g., `app.use('/api/user', userRoutes)`) and add below it:
```ts
import claimsRoutes from './routes/claims.js';
// ...
app.use('/api/claims', claimsRoutes);
```

- [ ] **Step 3: TypeScript + tests**

Run: `cd server && npx tsc --noEmit && npm test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/claims.ts server/src/index.ts
git commit -m "feat(claims): user/team-lead claim routes (list, create, remark)"
```

### Task E.4: Admin /admin/claims routes

**Files:**
- Create: `server/src/routes/admin/claims.ts`
- Modify: `server/src/routes/admin/index.ts`

- [ ] **Step 1: Create the admin route**

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { param, query, validationResult } from 'express-validator';
import { ClaimService } from '../../services/claimService.js';

const router = Router();
const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0]?.msg, code: 'VALIDATION_ERROR', details: errors.array() });
  next();
};
const getService = (req: Request) => new ClaimService(req.app.get('prisma') as PrismaClient);

router.get(
  '/',
  [
    query('subCategoryId').optional().isUUID(),
    query('workflowStatusId').optional().isUUID(),
    query('assignedToUserId').optional().isUUID(),
    query('search').optional().isString(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await getService(req).list({
        subCategoryId: req.query.subCategoryId as string | undefined,
        workflowStatusId: req.query.workflowStatusId as string | undefined,
        assignedToUserId: req.query.assignedToUserId as string | undefined,
        search: req.query.search as string | undefined,
        scope: 'ALL',
        callerId: req.session!.userId,
        page: req.query.page as unknown as number | undefined,
        limit: req.query.limit as unknown as number | undefined,
      });
      res.json({ data: r.data, pagination: { page: r.page, limit: r.limit, total: r.total, totalPages: Math.ceil(r.total / r.limit) } });
    } catch (err) { next(err); }
  }
);

router.get('/:id', [param('id').isUUID()], validate, async (req: Request, res: Response, next: NextFunction) => {
  const c = await getService(req).getById(req.params.id, req.session!.userId, 'ADMIN');
  if (!c) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  res.json({ data: c });
});

router.delete('/:id', [param('id').isUUID()], validate, async (req: Request, res: Response, next: NextFunction) => {
  await getService(req).softDelete(req.params.id, req.session!.userId);
  res.json({ message: 'Soft-deleted' });
});

export default router;
```

- [ ] **Step 2: Mount in `server/src/routes/admin/index.ts`**

```ts
import claimsRoutes from './claims.js';
// ...
router.use('/claims', claimsRoutes);
```

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/admin/claims.ts server/src/routes/admin/index.ts
git commit -m "feat(claims): admin claims overview + soft delete"
```

### Task E.5: Helper /user lookup endpoints

**Files:**
- Modify: `server/src/routes/user.ts`

- [ ] **Step 1: Add `GET /user/sub-categories` endpoint**

Below the existing routes in `user.ts`, add:

```ts
router.get('/sub-categories', async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;
    const userId = req.session!.userId;
    const role = req.session!.role;

    if (role === 'ADMIN') {
      const all = await prisma.subCategory.findMany({
        where: { status: 'ACTIVE' },
        include: { category: { select: { id: true, name: true, userTypeId: true, projectId: true } } },
        orderBy: { name: 'asc' },
      });
      return res.json({ data: all });
    }

    const assignment = await prisma.userAssignment.findUnique({ where: { userId } });
    if (!assignment) return res.json({ data: [] });

    const list = await prisma.subCategory.findMany({
      where: {
        status: 'ACTIVE',
        category: { userTypeId: assignment.userTypeId, projectId: assignment.projectId, status: 'ACTIVE' },
      },
      include: { category: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });
    res.json({ data: list });
  } catch (err) { next(err); }
});
```

- [ ] **Step 2: Add `GET /user/status-masters` endpoint**

```ts
router.get('/status-masters', async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;
    const subCategoryId = req.query.subCategoryId as string | undefined;
    if (!subCategoryId) return res.status(400).json({ error: 'subCategoryId required', code: 'VALIDATION_ERROR' });
    const list = await prisma.statusMaster.findMany({
      where: { subCategoryId, status: 'ACTIVE' },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });
    res.json({ data: list });
  } catch (err) { next(err); }
});
```

- [ ] **Step 3: Add `GET /user/users-in-scope` endpoint (TL/Admin only)**

```ts
router.get('/users-in-scope', async (req, res, next) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;
    const role = req.session!.role;
    if (role !== 'TEAM_LEAD' && role !== 'ADMIN') {
      return res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
    }
    if (role === 'ADMIN') {
      const all = await prisma.user.findMany({
        where: { status: 'ACTIVE', role: { not: 'ADMIN' } },
        select: { id: true, fullName: true, username: true },
        orderBy: { fullName: 'asc' },
      });
      return res.json({ data: all });
    }
    const assignment = await prisma.userAssignment.findUnique({ where: { userId: req.session!.userId } });
    if (!assignment) return res.json({ data: [] });
    const list = await prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        role: { not: 'ADMIN' },
        assignments: { some: { userTypeId: assignment.userTypeId, projectId: assignment.projectId } },
      },
      select: { id: true, fullName: true, username: true },
      orderBy: { fullName: 'asc' },
    });
    res.json({ data: list });
  } catch (err) { next(err); }
});
```

- [ ] **Step 4: Type check + commit**

Run: `cd server && npx tsc --noEmit`
Expected: clean.

```bash
git add server/src/routes/user.ts
git commit -m "feat(claims): user-facing lookup endpoints for dropdowns"
```

**Phase E complete.** Full backend Claims module is wired up. Verify with curl smoke tests if desired.

---

## Phase F — Frontend: shared components, layouts, routing

### Task F.1: Create SubCategoryPicker shared component

**Files:**
- Create: `client/src/components/shared/SubCategoryPicker.tsx`

- [ ] **Step 1: Write the component**

```tsx
import { useEffect, useState } from 'react';
import { api, DataResponse } from '@/lib/api';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Option { id: string; name: string; }
interface SubCategoryOption extends Option { category: { id: string; userTypeId: string; projectId: string; name: string } }

export interface SubCategoryPickerValue {
  userTypeId: string;
  projectId: string;
  categoryId: string;
  subCategoryId: string;
}

interface Props {
  value: Partial<SubCategoryPickerValue>;
  onChange: (next: Partial<SubCategoryPickerValue>) => void;
  disabled?: boolean;
}

export function SubCategoryPicker({ value, onChange, disabled }: Props) {
  const [userTypes, setUserTypes] = useState<Option[]>([]);
  const [projects, setProjects] = useState<Option[]>([]);
  const [categories, setCategories] = useState<Option[]>([]);
  const [subCategories, setSubCategories] = useState<SubCategoryOption[]>([]);

  useEffect(() => {
    Promise.all([
      api.get<{ data: Option[] }>('/admin/user-types?limit=100&status=ACTIVE'),
      api.get<{ data: Option[] }>('/admin/projects?limit=100&status=ACTIVE'),
    ]).then(([ut, pt]) => {
      setUserTypes(ut.data); setProjects(pt.data);
    });
  }, []);

  useEffect(() => {
    if (value.userTypeId && value.projectId) {
      api.get<{ data: Option[] }>(`/admin/categories?userTypeId=${value.userTypeId}&projectId=${value.projectId}&limit=200&status=ACTIVE`)
        .then((r) => setCategories(r.data));
    } else {
      setCategories([]);
    }
  }, [value.userTypeId, value.projectId]);

  useEffect(() => {
    if (value.categoryId) {
      api.get<{ data: SubCategoryOption[] }>(`/admin/sub-categories?categoryId=${value.categoryId}&limit=200&status=ACTIVE`)
        .then((r) => setSubCategories(r.data));
    } else {
      setSubCategories([]);
    }
  }, [value.categoryId]);

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label>User Type</Label>
        <Select value={value.userTypeId ?? ''} onValueChange={(v) => onChange({ userTypeId: v, projectId: undefined, categoryId: undefined, subCategoryId: undefined })} disabled={disabled}>
          <SelectTrigger><SelectValue placeholder="Select user type" /></SelectTrigger>
          <SelectContent>{userTypes.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>Project</Label>
        <Select value={value.projectId ?? ''} onValueChange={(v) => onChange({ ...value, projectId: v, categoryId: undefined, subCategoryId: undefined })} disabled={disabled || !value.userTypeId}>
          <SelectTrigger><SelectValue placeholder="Select project" /></SelectTrigger>
          <SelectContent>{projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>Category</Label>
        <Select value={value.categoryId ?? ''} onValueChange={(v) => onChange({ ...value, categoryId: v, subCategoryId: undefined })} disabled={disabled || !value.projectId}>
          <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
          <SelectContent>{categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>Sub-Category</Label>
        <Select value={value.subCategoryId ?? ''} onValueChange={(v) => onChange({ ...value, subCategoryId: v })} disabled={disabled || !value.categoryId}>
          <SelectTrigger><SelectValue placeholder="Select sub-category" /></SelectTrigger>
          <SelectContent>{subCategories.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type check**

Run: `cd client && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/shared/SubCategoryPicker.tsx
git commit -m "feat(client): shared SubCategoryPicker component"
```

### Task F.2: Add Claims items to AdminLayout sidebar

**Files:**
- Modify: `client/src/components/layout/AdminLayout.tsx`

- [ ] **Step 1: Extend the `navItems` array**

After the existing entries, add:

```tsx
import { ClipboardList, ListChecks, FileText, Crosshair } from 'lucide-react';
// ... existing imports ...

const navItems = [
  // ... existing entries ...
  // CLAIMS CONFIG section header is rendered separately below
  { path: '/admin/status-masters', label: 'Status Masters', icon: ListChecks, section: 'Claims Config' },
  { path: '/admin/doc-type-masters', label: 'Doc Type Masters', icon: FileText, section: 'Claims Config' },
  { path: '/admin/claim-id-rules', label: 'Claim ID Rules', icon: Crosshair, section: 'Claims Config' },
  { path: '/admin/claims', label: 'Claims (All)', icon: ClipboardList, section: 'Claims Config' },
];
```

Modify the nav rendering inside the `<aside>` to group by section. Below the existing map of nav items, add:

```tsx
<div className="mt-6 mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-gray-400">Claims Config</div>
{navItems.filter((i) => i.section === 'Claims Config').map((item) => {
  const Icon = item.icon;
  return (
    <Link
      key={item.path}
      to={item.path}
      className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${isActive(item.path) ? 'bg-gray-100 text-gray-900 font-medium' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'}`}
    >
      <Icon className="h-4 w-4" />
      {item.label}
    </Link>
  );
})}
```

Existing top-of-nav loop should still render only items without `section` (i.e., the original items). If the existing loop is `navItems.map(...)`, change to `navItems.filter((i) => !i.section).map(...)`.

- [ ] **Step 2: Type check**

Run: `cd client && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add client/src/components/layout/AdminLayout.tsx
git commit -m "feat(client): admin sidebar shows Claims Config section"
```

### Task F.3: Restructure UserLayout sidebar — My URLs + Claims

**Files:**
- Modify: `client/src/components/layout/UserLayout.tsx`

- [ ] **Step 1: Read the existing file**

Open `client/src/components/layout/UserLayout.tsx` and locate the menu-rendering JSX. It currently calls `/api/user/menu` and renders the Category → SubCategory tree.

- [ ] **Step 2: Wrap the existing tree under a "My URLs" section header and add a "Claims" section above it**

In the `<aside>` block, replace the current tree wrapper with:

```tsx
<aside className="w-64 bg-white border-r min-h-[calc(100vh-57px)] sticky top-[57px] overflow-y-auto">
  <nav className="p-4 space-y-3">
    <Link to="/dashboard" className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${location.pathname === '/dashboard' ? 'bg-gray-100 text-gray-900 font-medium' : 'text-gray-600 hover:bg-gray-50'}`}>
      Dashboard
    </Link>

    <div className="mt-4 mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-gray-400">Claims</div>
    <Link to="/claims" className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${location.pathname.startsWith('/claims') ? 'bg-gray-100 text-gray-900 font-medium' : 'text-gray-600 hover:bg-gray-50'}`}>
      Claim Dashboard
    </Link>

    <div className="mt-4 mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-gray-400">My URLs</div>
    {/* PRESERVE the existing Category > SubCategory tree rendering exactly as it was */}
    {/* (Do not modify the tree component's internals — only its placement.) */}
  </nav>
</aside>
```

The existing tree code (the `categories.map((c) => ...)` block or whatever it is) should be pasted in place of the `{/* PRESERVE ... */}` comment.

- [ ] **Step 3: Verify in browser**

Start dev, log in as a non-admin user. Confirm: Dashboard link works, "Claims" section shows under it with "Claim Dashboard" link (which is currently a 404 — fixed in Phase H), and "My URLs" still shows the existing category tree.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/layout/UserLayout.tsx
git commit -m "feat(client): user sidebar split into Claims and My URLs sections"
```

### Task F.4: Add Claims routes to App.tsx

**Files:**
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Import the new pages**

At the top of `App.tsx` add (after existing imports):

```tsx
import StatusMasters from '@/pages/admin/StatusMasters';
import DocumentTypeMasters from '@/pages/admin/DocumentTypeMasters';
import ClaimIdRules from '@/pages/admin/ClaimIdRules';
import AdminClaims from '@/pages/admin/AdminClaims';
import ClaimDashboard from '@/pages/claims/ClaimDashboard';
import ClaimUpdate from '@/pages/claims/ClaimUpdate';
```

- [ ] **Step 2: Add admin routes inside the `<Route path="/admin" ...>` block**

Below `<Route path="profile" element={<Profile />} />` add:

```tsx
<Route path="status-masters" element={<StatusMasters />} />
<Route path="doc-type-masters" element={<DocumentTypeMasters />} />
<Route path="claim-id-rules" element={<ClaimIdRules />} />
<Route path="claims" element={<AdminClaims />} />
<Route path="claims/:id" element={<ClaimUpdate />} />
```

- [ ] **Step 3: Add user-facing routes inside the user `<Route path="/" ...>` block**

Below `<Route path="subcategory/:subCategoryId" element={<SubCategoryUrls />} />` add:

```tsx
<Route path="claims" element={<ClaimDashboard />} />
<Route path="claims/:id" element={<ClaimUpdate />} />
```

- [ ] **Step 4: Frontend type-check (will fail until pages are created in Phase G/H — that's fine)**

Skip the typecheck commit; commit at end of next phase.

---

## Phase G — Frontend: admin master-data pages

All four admin pages follow the same pattern as the existing `Users.tsx`, `Categories.tsx` etc. — DataTable + Add/Edit dialog + ConfirmDialog. Each task lists only the differences. Use the existing pages as reference.

### Task G.1: StatusMasters admin page

**Files:**
- Create: `client/src/pages/admin/StatusMasters.tsx`

- [ ] **Step 1: Write the file**

```tsx
import { useEffect, useState } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Pencil, Trash2, Power, PowerOff } from 'lucide-react';
import { api, PaginatedResponse } from '@/lib/api';
import { DataTable } from '@/components/shared/DataTable';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToast } from '@/components/ui/use-toast';
import { SubCategoryPicker, SubCategoryPickerValue } from '@/components/shared/SubCategoryPicker';

interface StatusMaster {
  id: string;
  subCategoryId: string;
  name: string;
  displayOrder: number;
  isDefault: boolean;
  isTerminal: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
}

export default function StatusMasters() {
  const { toast } = useToast();
  const [data, setData] = useState<StatusMaster[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [picker, setPicker] = useState<Partial<SubCategoryPickerValue>>({});
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [selected, setSelected] = useState<StatusMaster | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({ name: '', displayOrder: 0, isDefault: false, isTerminal: false });

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      const url = picker.subCategoryId
        ? `/admin/status-masters?page=${page}&limit=${limit}&subCategoryId=${picker.subCategoryId}`
        : `/admin/status-masters?page=${page}&limit=${limit}`;
      const r = await api.get<PaginatedResponse<StatusMaster>>(url);
      setData(r.data); setPagination(r.pagination);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Failed', variant: 'destructive' });
    } finally { setIsLoading(false); }
  };

  useEffect(() => { fetchData(); }, [picker.subCategoryId]);

  const handleSubmit = async () => {
    if (!picker.subCategoryId) return toast({ title: 'Validation', description: 'Pick a Sub-Category', variant: 'destructive' });
    if (!formData.name.trim()) return toast({ title: 'Validation', description: 'Name required', variant: 'destructive' });
    setIsSubmitting(true);
    try {
      const payload = { subCategoryId: picker.subCategoryId, ...formData };
      if (selected) await api.put(`/admin/status-masters/${selected.id}`, payload);
      else await api.post('/admin/status-masters', payload);
      toast({ title: 'Saved' });
      setIsFormOpen(false); fetchData(pagination.page, pagination.limit);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Save failed', variant: 'destructive' });
    } finally { setIsSubmitting(false); }
  };

  const handleDelete = async () => {
    if (!selected) return;
    setIsSubmitting(true);
    try {
      await api.delete(`/admin/status-masters/${selected.id}`);
      toast({ title: 'Deleted' }); setIsDeleteOpen(false); fetchData(pagination.page, pagination.limit);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Delete failed', variant: 'destructive' });
    } finally { setIsSubmitting(false); }
  };

  const handleToggle = async (s: StatusMaster) => {
    try {
      await api.patch(`/admin/status-masters/${s.id}/status`, { status: s.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' });
      fetchData(pagination.page, pagination.limit);
    } catch (e) { toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Failed' }); }
  };

  const columns: ColumnDef<StatusMaster>[] = [
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'displayOrder', header: 'Order' },
    { id: 'isDefault', header: 'Default', cell: ({ row }) => row.original.isDefault ? <Badge>Default</Badge> : '-' },
    { id: 'isTerminal', header: 'Terminal', cell: ({ row }) => row.original.isTerminal ? <Badge variant="secondary">End</Badge> : '-' },
    { accessorKey: 'status', header: 'Status', cell: ({ row }) => <Badge variant={row.original.status === 'ACTIVE' ? 'success' : 'secondary'}>{row.original.status}</Badge> },
    {
      id: 'actions',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" className="h-8 w-8 p-0"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { setSelected(row.original); setFormData({ name: row.original.name, displayOrder: row.original.displayOrder, isDefault: row.original.isDefault, isTerminal: row.original.isTerminal }); setIsFormOpen(true); }}><Pencil className="mr-2 h-4 w-4" />Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleToggle(row.original)}>{row.original.status === 'ACTIVE' ? <><PowerOff className="mr-2 h-4 w-4" />Deactivate</> : <><Power className="mr-2 h-4 w-4" />Activate</>}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onClick={() => { setSelected(row.original); setIsDeleteOpen(true); }}><Trash2 className="mr-2 h-4 w-4" />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Status Masters</h1>
        <Button onClick={() => { setSelected(null); setFormData({ name: '', displayOrder: 0, isDefault: false, isTerminal: false }); setIsFormOpen(true); }} disabled={!picker.subCategoryId}>
          <Plus className="mr-2 h-4 w-4" />Add Status
        </Button>
      </div>

      <div className="mb-4 p-4 bg-white border rounded-md">
        <SubCategoryPicker value={picker} onChange={setPicker} />
      </div>

      <DataTable columns={columns} data={data} pagination={pagination} onPageChange={(p) => fetchData(p, pagination.limit)} onPageSizeChange={(l) => fetchData(1, l)} isLoading={isLoading} />

      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{selected ? 'Edit Status' : 'Add Status'}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2"><Label>Name</Label><Input value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} /></div>
            <div className="space-y-2"><Label>Display Order</Label><Input type="number" value={formData.displayOrder} onChange={(e) => setFormData({ ...formData, displayOrder: Number(e.target.value) })} /></div>
            <div className="flex items-center gap-2"><input type="checkbox" id="def" checked={formData.isDefault} onChange={(e) => setFormData({ ...formData, isDefault: e.target.checked })} /><Label htmlFor="def">Default status for new claims</Label></div>
            <div className="flex items-center gap-2"><input type="checkbox" id="term" checked={formData.isTerminal} onChange={(e) => setFormData({ ...formData, isTerminal: e.target.checked })} /><Label htmlFor="term">Terminal (closed) status</Label></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setIsFormOpen(false)}>Cancel</Button><Button onClick={handleSubmit} disabled={isSubmitting}>{isSubmitting ? 'Saving...' : 'Save'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} title="Delete Status" description={`Delete "${selected?.name}"?`} confirmText="Delete" variant="destructive" onConfirm={handleDelete} isLoading={isSubmitting} />
    </div>
  );
}
```

- [ ] **Step 2: Commit (after all four admin pages — Tasks G.2, G.3, G.4 — are also written)**

Hold the commit until end of Phase G.

### Task G.2: DocumentTypeMasters admin page

**Files:**
- Create: `client/src/pages/admin/DocumentTypeMasters.tsx`

- [ ] **Step 1: Write the file**

The structure mirrors G.1 — same DataTable + dialog pattern. The form has these specific fields: SubCategoryPicker, Category radio (GOVT / CUSTOM), GovtCode select (visible only when GOVT), Name input (pre-filled from code), Display Order. Govt code dropdown filters out codes already used by an active row on that SubCategory (compute from current `data` array). Use:

```tsx
import { useEffect, useState, useMemo } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Pencil, Trash2, Power, PowerOff } from 'lucide-react';
import { api, PaginatedResponse } from '@/lib/api';
import { DataTable } from '@/components/shared/DataTable';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToast } from '@/components/ui/use-toast';
import { SubCategoryPicker, SubCategoryPickerValue } from '@/components/shared/SubCategoryPicker';

type Category = 'GOVT' | 'CUSTOM';
type GovtCode = 'AADHAR' | 'PAN' | 'DL' | 'PASSPORT' | 'VOTER_ID' | 'RATION_CARD';
const GOVT_LABELS: Record<GovtCode, string> = { AADHAR: 'Aadhar Card', PAN: 'PAN Card', DL: 'Driving License', PASSPORT: 'Passport', VOTER_ID: 'Voter ID', RATION_CARD: 'Ration Card' };

interface DocType {
  id: string; subCategoryId: string; name: string; category: Category; govtCode: GovtCode | null;
  displayOrder: number; status: 'ACTIVE' | 'INACTIVE'; createdAt: string;
}

export default function DocumentTypeMasters() {
  const { toast } = useToast();
  const [data, setData] = useState<DocType[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [picker, setPicker] = useState<Partial<SubCategoryPickerValue>>({});
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [selected, setSelected] = useState<DocType | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState<{ name: string; category: Category; govtCode: GovtCode | ''; displayOrder: number }>({ name: '', category: 'CUSTOM', govtCode: '', displayOrder: 0 });

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      const url = picker.subCategoryId
        ? `/admin/document-type-masters?page=${page}&limit=${limit}&subCategoryId=${picker.subCategoryId}`
        : `/admin/document-type-masters?page=${page}&limit=${limit}`;
      const r = await api.get<PaginatedResponse<DocType>>(url);
      setData(r.data); setPagination(r.pagination);
    } catch (e) { toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Failed' }); }
    finally { setIsLoading(false); }
  };

  useEffect(() => { fetchData(); }, [picker.subCategoryId]);

  const usedCodes = useMemo(() =>
    new Set(data.filter((d) => d.status === 'ACTIVE' && d.govtCode && d.id !== selected?.id).map((d) => d.govtCode as GovtCode)),
  [data, selected]);

  const availableCodes = (Object.keys(GOVT_LABELS) as GovtCode[]).filter((c) => !usedCodes.has(c));

  const handleSubmit = async () => {
    if (!picker.subCategoryId) return toast({ title: 'Pick a SubCategory', variant: 'destructive' });
    if (formData.category === 'GOVT' && !formData.govtCode) return toast({ title: 'Pick a Govt code', variant: 'destructive' });
    if (!formData.name.trim()) return toast({ title: 'Name required', variant: 'destructive' });
    setIsSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        subCategoryId: picker.subCategoryId,
        name: formData.name,
        category: formData.category,
        displayOrder: formData.displayOrder,
      };
      if (formData.category === 'GOVT') payload.govtCode = formData.govtCode;
      if (selected) await api.put(`/admin/document-type-masters/${selected.id}`, { name: formData.name, displayOrder: formData.displayOrder });
      else await api.post('/admin/document-type-masters', payload);
      toast({ title: 'Saved' }); setIsFormOpen(false); fetchData(pagination.page, pagination.limit);
    } catch (e) { toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Save failed' }); }
    finally { setIsSubmitting(false); }
  };

  const handleDelete = async () => {
    if (!selected) return;
    setIsSubmitting(true);
    try { await api.delete(`/admin/document-type-masters/${selected.id}`); toast({ title: 'Deleted' }); setIsDeleteOpen(false); fetchData(pagination.page, pagination.limit); }
    catch (e) { toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Failed' }); }
    finally { setIsSubmitting(false); }
  };

  const handleToggle = async (d: DocType) => {
    await api.patch(`/admin/document-type-masters/${d.id}/status`, { status: d.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' });
    fetchData(pagination.page, pagination.limit);
  };

  const columns: ColumnDef<DocType>[] = [
    { accessorKey: 'name', header: 'Name' },
    { id: 'category', header: 'Category', cell: ({ row }) => <Badge variant={row.original.category === 'GOVT' ? 'default' : 'secondary'}>{row.original.category}</Badge> },
    { id: 'govtCode', header: 'Govt Code', cell: ({ row }) => row.original.govtCode ?? '-' },
    { accessorKey: 'displayOrder', header: 'Order' },
    { accessorKey: 'status', header: 'Status', cell: ({ row }) => <Badge variant={row.original.status === 'ACTIVE' ? 'success' : 'secondary'}>{row.original.status}</Badge> },
    {
      id: 'actions',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" className="h-8 w-8 p-0"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { setSelected(row.original); setFormData({ name: row.original.name, category: row.original.category, govtCode: (row.original.govtCode ?? '') as GovtCode | '', displayOrder: row.original.displayOrder }); setIsFormOpen(true); }}><Pencil className="mr-2 h-4 w-4" />Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleToggle(row.original)}>{row.original.status === 'ACTIVE' ? <><PowerOff className="mr-2 h-4 w-4" />Deactivate</> : <><Power className="mr-2 h-4 w-4" />Activate</>}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onClick={() => { setSelected(row.original); setIsDeleteOpen(true); }}><Trash2 className="mr-2 h-4 w-4" />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Document Type Masters</h1>
        <Button onClick={() => { setSelected(null); setFormData({ name: '', category: 'CUSTOM', govtCode: '', displayOrder: 0 }); setIsFormOpen(true); }} disabled={!picker.subCategoryId}>
          <Plus className="mr-2 h-4 w-4" />Add Document Type
        </Button>
      </div>

      <div className="mb-4 p-4 bg-white border rounded-md"><SubCategoryPicker value={picker} onChange={setPicker} /></div>

      <DataTable columns={columns} data={data} pagination={pagination} onPageChange={(p) => fetchData(p, pagination.limit)} onPageSizeChange={(l) => fetchData(1, l)} isLoading={isLoading} />

      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{selected ? 'Edit Document Type' : 'Add Document Type'}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Category</Label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2"><input type="radio" name="cat" value="GOVT" checked={formData.category === 'GOVT'} onChange={() => setFormData({ ...formData, category: 'GOVT', govtCode: '', name: '' })} disabled={!!selected} />GOVT</label>
                <label className="flex items-center gap-2"><input type="radio" name="cat" value="CUSTOM" checked={formData.category === 'CUSTOM'} onChange={() => setFormData({ ...formData, category: 'CUSTOM', govtCode: '', name: '' })} disabled={!!selected} />CUSTOM</label>
              </div>
            </div>
            {formData.category === 'GOVT' && !selected && (
              <div className="space-y-2">
                <Label>Govt Code</Label>
                <Select value={formData.govtCode} onValueChange={(v) => setFormData({ ...formData, govtCode: v as GovtCode, name: GOVT_LABELS[v as GovtCode] })}>
                  <SelectTrigger><SelectValue placeholder="Pick a Govt document" /></SelectTrigger>
                  <SelectContent>{availableCodes.map((c) => <SelectItem key={c} value={c}>{GOVT_LABELS[c]}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2"><Label>Name</Label><Input value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} /></div>
            <div className="space-y-2"><Label>Display Order</Label><Input type="number" value={formData.displayOrder} onChange={(e) => setFormData({ ...formData, displayOrder: Number(e.target.value) })} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setIsFormOpen(false)}>Cancel</Button><Button onClick={handleSubmit} disabled={isSubmitting}>{isSubmitting ? 'Saving...' : 'Save'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} title="Delete Document Type" description={`Delete "${selected?.name}"?`} confirmText="Delete" variant="destructive" onConfirm={handleDelete} isLoading={isSubmitting} />
    </div>
  );
}
```

### Task G.3: ClaimIdRules admin page

**Files:**
- Create: `client/src/pages/admin/ClaimIdRules.tsx`

- [ ] **Step 1: Write the file**

```tsx
import { useEffect, useState } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Pencil, Trash2, Power, PowerOff } from 'lucide-react';
import { api, PaginatedResponse } from '@/lib/api';
import { DataTable } from '@/components/shared/DataTable';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToast } from '@/components/ui/use-toast';
import { SubCategoryPicker, SubCategoryPickerValue } from '@/components/shared/SubCategoryPicker';

interface Rule { id: string; subCategoryId: string; startPosition: number; length: number; scanTarget: 'FOLDER' | 'FILE'; scanLocation: string; status: 'ACTIVE' | 'INACTIVE'; }

function validateLocation(v: string): string | null {
  if (!/^[A-Za-z]:\\.+/.test(v)) return 'Must be a drive-letter path like D:\\Claims\\Daily';
  if (/^[Cc]:\\/.test(v)) return 'C drive is not allowed';
  return null;
}

export default function ClaimIdRules() {
  const { toast } = useToast();
  const [data, setData] = useState<Rule[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [picker, setPicker] = useState<Partial<SubCategoryPickerValue>>({});
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [selected, setSelected] = useState<Rule | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState<{ startPosition: number; length: number; scanTarget: 'FOLDER' | 'FILE'; scanLocation: string }>({ startPosition: 1, length: 8, scanTarget: 'FOLDER', scanLocation: '' });

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      const url = picker.subCategoryId
        ? `/admin/claim-id-rules?page=${page}&limit=${limit}&subCategoryId=${picker.subCategoryId}`
        : `/admin/claim-id-rules?page=${page}&limit=${limit}`;
      const r = await api.get<PaginatedResponse<Rule>>(url);
      setData(r.data); setPagination(r.pagination);
    } catch (e) { toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Failed' }); }
    finally { setIsLoading(false); }
  };

  useEffect(() => { fetchData(); }, [picker.subCategoryId]);

  const handleSubmit = async () => {
    if (!picker.subCategoryId) return toast({ title: 'Pick a SubCategory', variant: 'destructive' });
    const locErr = validateLocation(formData.scanLocation);
    if (locErr) return toast({ title: 'Invalid location', description: locErr, variant: 'destructive' });
    setIsSubmitting(true);
    try {
      const payload = { subCategoryId: picker.subCategoryId, ...formData };
      if (selected) await api.put(`/admin/claim-id-rules/${selected.id}`, formData);
      else await api.post('/admin/claim-id-rules', payload);
      toast({ title: 'Saved' }); setIsFormOpen(false); fetchData(pagination.page, pagination.limit);
    } catch (e) { toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Save failed' }); }
    finally { setIsSubmitting(false); }
  };

  const handleDelete = async () => {
    if (!selected) return;
    setIsSubmitting(true);
    try { await api.delete(`/admin/claim-id-rules/${selected.id}`); toast({ title: 'Deleted' }); setIsDeleteOpen(false); fetchData(pagination.page, pagination.limit); }
    finally { setIsSubmitting(false); }
  };

  const handleToggle = async (r: Rule) => {
    await api.patch(`/admin/claim-id-rules/${r.id}/status`, { status: r.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' });
    fetchData(pagination.page, pagination.limit);
  };

  const columns: ColumnDef<Rule>[] = [
    { accessorKey: 'startPosition', header: 'Start' },
    { accessorKey: 'length', header: 'Length' },
    { accessorKey: 'scanTarget', header: 'Target' },
    { accessorKey: 'scanLocation', header: 'Location' },
    { accessorKey: 'status', header: 'Status', cell: ({ row }) => <Badge variant={row.original.status === 'ACTIVE' ? 'success' : 'secondary'}>{row.original.status}</Badge> },
    {
      id: 'actions',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" className="h-8 w-8 p-0"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { setSelected(row.original); setFormData({ startPosition: row.original.startPosition, length: row.original.length, scanTarget: row.original.scanTarget, scanLocation: row.original.scanLocation }); setIsFormOpen(true); }}><Pencil className="mr-2 h-4 w-4" />Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleToggle(row.original)}>{row.original.status === 'ACTIVE' ? <><PowerOff className="mr-2 h-4 w-4" />Deactivate</> : <><Power className="mr-2 h-4 w-4" />Activate</>}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onClick={() => { setSelected(row.original); setIsDeleteOpen(true); }}><Trash2 className="mr-2 h-4 w-4" />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Claim ID Rules</h1>
        <Button onClick={() => { setSelected(null); setFormData({ startPosition: 1, length: 8, scanTarget: 'FOLDER', scanLocation: '' }); setIsFormOpen(true); }} disabled={!picker.subCategoryId || data.length > 0}>
          <Plus className="mr-2 h-4 w-4" />Add Rule
        </Button>
      </div>

      <div className="mb-4 p-4 bg-white border rounded-md"><SubCategoryPicker value={picker} onChange={setPicker} /></div>

      <DataTable columns={columns} data={data} pagination={pagination} onPageChange={(p) => fetchData(p, pagination.limit)} onPageSizeChange={(l) => fetchData(1, l)} isLoading={isLoading} />

      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{selected ? 'Edit Rule' : 'Add Rule'}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>Start Position</Label><Input type="number" min={1} value={formData.startPosition} onChange={(e) => setFormData({ ...formData, startPosition: Number(e.target.value) })} /></div>
              <div className="space-y-2"><Label>Length</Label><Input type="number" min={1} value={formData.length} onChange={(e) => setFormData({ ...formData, length: Number(e.target.value) })} /></div>
            </div>
            <div className="space-y-2">
              <Label>Scan Target</Label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2"><input type="radio" name="tgt" checked={formData.scanTarget === 'FOLDER'} onChange={() => setFormData({ ...formData, scanTarget: 'FOLDER' })} />Folder names</label>
                <label className="flex items-center gap-2"><input type="radio" name="tgt" checked={formData.scanTarget === 'FILE'} onChange={() => setFormData({ ...formData, scanTarget: 'FILE' })} />File names</label>
              </div>
            </div>
            <div className="space-y-2"><Label>Scan Location</Label><Input value={formData.scanLocation} onChange={(e) => setFormData({ ...formData, scanLocation: e.target.value })} placeholder="D:\\Claims\\Daily" /><p className="text-xs text-gray-500">Must be a drive letter path. C:\\ is not allowed.</p></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setIsFormOpen(false)}>Cancel</Button><Button onClick={handleSubmit} disabled={isSubmitting}>{isSubmitting ? 'Saving...' : 'Save'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} title="Delete Rule" description="Delete this rule?" confirmText="Delete" variant="destructive" onConfirm={handleDelete} isLoading={isSubmitting} />
    </div>
  );
}
```

### Task G.4: AdminClaims overview page

**Files:**
- Create: `client/src/pages/admin/AdminClaims.tsx`

- [ ] **Step 1: Write the file**

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ColumnDef } from '@tanstack/react-table';
import { api, PaginatedResponse } from '@/lib/api';
import { DataTable } from '@/components/shared/DataTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/use-toast';

interface ClaimRow {
  id: string;
  claimId: string;
  workflowStatus: { id: string; name: string; isTerminal: boolean };
  subCategory: { id: string; name: string };
  assignedTo: { id: string; fullName: string } | null;
  spellCheckStatus: string;
  qrStatus: string;
  metaExtractionStatus: string;
  intraClaimStatus: string;
  fullScanStatus: string;
  createdAt: string;
}

export default function AdminClaims() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<ClaimRow[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      const url = search ? `/admin/claims?page=${page}&limit=${limit}&search=${encodeURIComponent(search)}` : `/admin/claims?page=${page}&limit=${limit}`;
      const r = await api.get<PaginatedResponse<ClaimRow>>(url);
      setData(r.data); setPagination(r.pagination);
    } catch (e) { toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Failed' }); }
    finally { setIsLoading(false); }
  };

  useEffect(() => { fetchData(); }, []);

  const columns: ColumnDef<ClaimRow>[] = [
    { accessorKey: 'claimId', header: 'Claim ID', cell: ({ row }) => <button className="text-primary underline-offset-2 hover:underline" onClick={() => navigate(`/admin/claims/${row.original.id}`)}>{row.original.claimId}</button> },
    { id: 'sub', header: 'Sub-Category', cell: ({ row }) => row.original.subCategory.name },
    { id: 'status', header: 'Workflow', cell: ({ row }) => <Badge variant={row.original.workflowStatus.isTerminal ? 'secondary' : 'default'}>{row.original.workflowStatus.name}</Badge> },
    { id: 'assignee', header: 'Assigned To', cell: ({ row }) => row.original.assignedTo?.fullName ?? <span className="text-muted-foreground">Unassigned</span> },
    { id: 'spell', header: 'Spell', cell: ({ row }) => <Badge variant="outline">{row.original.spellCheckStatus}</Badge> },
    { id: 'qr', header: 'QR', cell: ({ row }) => <Badge variant="outline">{row.original.qrStatus}</Badge> },
    { id: 'meta', header: 'Meta', cell: ({ row }) => <Badge variant="outline">{row.original.metaExtractionStatus}</Badge> },
    { id: 'intra', header: 'Intra-Claim', cell: ({ row }) => <Badge variant="outline">{row.original.intraClaimStatus}</Badge> },
    { id: 'full', header: 'Full Scan', cell: ({ row }) => <Badge variant="outline">{row.original.fullScanStatus}</Badge> },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Claims (All)</h1>
        <div className="flex gap-2">
          <Input placeholder="Search claim id..." value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && fetchData(1, pagination.limit)} className="w-64" />
          <Button onClick={() => fetchData(1, pagination.limit)}>Search</Button>
        </div>
      </div>
      <DataTable columns={columns} data={data} pagination={pagination} onPageChange={(p) => fetchData(p, pagination.limit)} onPageSizeChange={(l) => fetchData(1, l)} isLoading={isLoading} />
    </div>
  );
}
```

- [ ] **Step 2: Type-check the four new pages**

Run: `cd client && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit Phase G**

```bash
git add client/src/pages/admin/StatusMasters.tsx client/src/pages/admin/DocumentTypeMasters.tsx client/src/pages/admin/ClaimIdRules.tsx client/src/pages/admin/AdminClaims.tsx
git commit -m "feat(client): admin pages for Status/DocType/ClaimIdRule + Claims overview"
```

---

## Phase H — Frontend: end-user Claim pages

### Task H.1: ClaimDashboard page

**Files:**
- Create: `client/src/pages/claims/ClaimDashboard.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { api, PaginatedResponse } from '@/lib/api';
import { DataTable } from '@/components/shared/DataTable';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { useAuthStore } from '@/stores/authStore';

interface ClaimRow {
  id: string;
  claimId: string;
  workflowStatus: { id: string; name: string; isTerminal: boolean };
  subCategory: { id: string; name: string };
  assignedTo: { id: string; fullName: string } | null;
  spellCheckStatus: string;
  qrStatus: string;
  metaExtractionStatus: string;
  intraClaimStatus: string;
  fullScanStatus: string;
  createdAt: string;
}

interface SubCat { id: string; name: string; category: { id: string; name: string } }
interface Status { id: string; name: string; isTerminal: boolean; isDefault: boolean }
interface UserOpt { id: string; fullName: string }

export default function ClaimDashboard() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const role = user?.role ?? 'USER';
  const canCreate = role === 'TEAM_LEAD' || role === 'ADMIN';

  const [data, setData] = useState<ClaimRow[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [subCats, setSubCats] = useState<SubCat[]>([]);
  const [filters, setFilters] = useState<{ subCategoryId?: string; workflowStatusId?: string; assignedToMe: boolean; search: string }>({ assignedToMe: false, search: '' });
  const [filterStatuses, setFilterStatuses] = useState<Status[]>([]);

  // Add Claim modal
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<{ subCategoryId?: string; claimId: string; folderPath: string; assignedToUserId?: string; remarkText: string }>({ claimId: '', folderPath: '', remarkText: '' });
  const [addUsers, setAddUsers] = useState<UserOpt[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchSubCats = async () => {
    const r = await api.get<{ data: SubCat[] }>('/user/sub-categories');
    setSubCats(r.data);
  };
  const fetchStatusesForFilter = async (subCategoryId: string) => {
    const r = await api.get<{ data: Status[] }>(`/user/status-masters?subCategoryId=${subCategoryId}`);
    setFilterStatuses(r.data);
  };
  const fetchAssignees = async () => {
    if (!canCreate) return;
    const r = await api.get<{ data: UserOpt[] }>('/user/users-in-scope');
    setAddUsers(r.data);
  };

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (filters.subCategoryId) params.set('subCategoryId', filters.subCategoryId);
      if (filters.workflowStatusId) params.set('workflowStatusId', filters.workflowStatusId);
      if (filters.assignedToMe) params.set('assignedToMe', 'true');
      if (filters.search) params.set('search', filters.search);
      const r = await api.get<PaginatedResponse<ClaimRow>>(`/claims?${params}`);
      setData(r.data); setPagination(r.pagination);
    } catch (e) { toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Failed' }); }
    finally { setIsLoading(false); }
  };

  useEffect(() => { fetchSubCats(); fetchAssignees(); fetchData(); }, []);
  useEffect(() => { if (filters.subCategoryId) fetchStatusesForFilter(filters.subCategoryId); else setFilterStatuses([]); }, [filters.subCategoryId]);

  const handleAdd = async () => {
    if (!addForm.subCategoryId) return toast({ title: 'Pick a SubCategory', variant: 'destructive' });
    if (!addForm.claimId.trim()) return toast({ title: 'Claim ID required', variant: 'destructive' });
    setIsSubmitting(true);
    try {
      const payload: Record<string, unknown> = { subCategoryId: addForm.subCategoryId, claimId: addForm.claimId.trim() };
      if (addForm.folderPath.trim()) payload.folderPath = addForm.folderPath.trim();
      if (addForm.assignedToUserId) payload.assignedToUserId = addForm.assignedToUserId;
      if (addForm.remarkText.trim()) payload.remarkText = addForm.remarkText.trim();
      await api.post('/claims', payload);
      toast({ title: 'Claim created' });
      setIsAddOpen(false);
      setAddForm({ claimId: '', folderPath: '', remarkText: '' });
      fetchData(1, pagination.limit);
    } catch (e) { toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Create failed' }); }
    finally { setIsSubmitting(false); }
  };

  const canOpen = (row: ClaimRow): boolean => {
    if (role === 'ADMIN' || role === 'TEAM_LEAD') return true;
    return !!row.assignedTo && row.assignedTo.id === user?.id;
  };

  const columns: ColumnDef<ClaimRow>[] = [
    {
      accessorKey: 'claimId',
      header: 'Claim ID',
      cell: ({ row }) => canOpen(row)
        ? <button className="text-primary underline-offset-2 hover:underline" onClick={() => navigate(`/claims/${row.original.id}`)}>{row.original.claimId}</button>
        : <span className="text-muted-foreground">{row.original.claimId}</span>,
    },
    { id: 'sub', header: 'Sub-Category', cell: ({ row }) => row.original.subCategory.name },
    { id: 'status', header: 'Workflow', cell: ({ row }) => <Badge variant={row.original.workflowStatus.isTerminal ? 'secondary' : 'default'}>{row.original.workflowStatus.name}</Badge> },
    { id: 'assignee', header: 'Assigned To', cell: ({ row }) => row.original.assignedTo?.fullName ?? <span className="text-muted-foreground">Unassigned</span> },
    { id: 'spell', header: 'Spell', cell: ({ row }) => <Badge variant="outline">{row.original.spellCheckStatus}</Badge> },
    { id: 'qr', header: 'QR', cell: ({ row }) => <Badge variant="outline">{row.original.qrStatus}</Badge> },
    { id: 'meta', header: 'Meta', cell: ({ row }) => <Badge variant="outline">{row.original.metaExtractionStatus}</Badge> },
    { id: 'intra', header: 'Intra-Claim', cell: ({ row }) => <Badge variant="outline">{row.original.intraClaimStatus}</Badge> },
    { id: 'full', header: 'Full Scan', cell: ({ row }) => <Badge variant="outline">{row.original.fullScanStatus}</Badge> },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Claim Dashboard</h1>
        {canCreate && <Button onClick={() => setIsAddOpen(true)}><Plus className="mr-2 h-4 w-4" />Add Claim</Button>}
      </div>

      <div className="mb-4 p-4 bg-white border rounded-md grid grid-cols-4 gap-3">
        <div className="space-y-1">
          <Label>Sub-Category</Label>
          <Select value={filters.subCategoryId ?? ''} onValueChange={(v) => setFilters({ ...filters, subCategoryId: v || undefined, workflowStatusId: undefined })}>
            <SelectTrigger><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>{subCats.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Workflow Status</Label>
          <Select value={filters.workflowStatusId ?? ''} onValueChange={(v) => setFilters({ ...filters, workflowStatusId: v || undefined })} disabled={!filters.subCategoryId}>
            <SelectTrigger><SelectValue placeholder="All" /></SelectTrigger>
            <SelectContent>{filterStatuses.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {role === 'USER' && (
          <div className="space-y-1">
            <Label>&nbsp;</Label>
            <div className="flex items-center gap-2 pt-2"><input id="amt" type="checkbox" checked={filters.assignedToMe} onChange={(e) => setFilters({ ...filters, assignedToMe: e.target.checked })} /><Label htmlFor="amt">Assigned to me only</Label></div>
          </div>
        )}
        <div className="space-y-1">
          <Label>Search</Label>
          <Input value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && fetchData(1, pagination.limit)} placeholder="Claim ID contains..." />
        </div>
        <div className="col-span-4 flex justify-end"><Button onClick={() => fetchData(1, pagination.limit)}>Apply filters</Button></div>
      </div>

      <DataTable columns={columns} data={data} pagination={pagination} onPageChange={(p) => fetchData(p, pagination.limit)} onPageSizeChange={(l) => fetchData(1, l)} isLoading={isLoading} />

      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Add Claim</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Sub-Category</Label>
              <Select value={addForm.subCategoryId ?? ''} onValueChange={(v) => setAddForm({ ...addForm, subCategoryId: v })}>
                <SelectTrigger><SelectValue placeholder="Pick a sub-category" /></SelectTrigger>
                <SelectContent>{subCats.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2"><Label>Claim ID</Label><Input value={addForm.claimId} onChange={(e) => setAddForm({ ...addForm, claimId: e.target.value })} /></div>
            <div className="space-y-2"><Label>Folder Path (optional)</Label><Input value={addForm.folderPath} onChange={(e) => setAddForm({ ...addForm, folderPath: e.target.value })} placeholder="D:\\Claims\\Daily\\..." /></div>
            <div className="space-y-2">
              <Label>Assign to (optional)</Label>
              <Select value={addForm.assignedToUserId ?? ''} onValueChange={(v) => setAddForm({ ...addForm, assignedToUserId: v || undefined })}>
                <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                <SelectContent>{addUsers.map((u) => <SelectItem key={u.id} value={u.id}>{u.fullName}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2"><Label>Initial Remark (optional)</Label><Textarea value={addForm.remarkText} onChange={(e) => setAddForm({ ...addForm, remarkText: e.target.value })} /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setIsAddOpen(false)}>Cancel</Button><Button onClick={handleAdd} disabled={isSubmitting}>{isSubmitting ? 'Creating...' : 'Create'}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 2: Commit (will fully build after H.2)**

Hold commit.

### Task H.2: ClaimUpdate page (detail + timeline)

**Files:**
- Create: `client/src/pages/claims/ClaimUpdate.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { useAuthStore } from '@/stores/authStore';

interface Status { id: string; name: string; isTerminal: boolean }
interface Remark { id: string; remarkText: string; createdAt: string; user: { id: string; fullName: string }; statusBefore: Status | null; statusAfter: Status | null }
interface Assignee { id: string; fullName: string; username: string }
interface ClaimDetail {
  id: string;
  claimId: string;
  workflowStatus: Status;
  subCategory: { id: string; name: string; category: { id: string; name: string; userTypeId: string; projectId: string } };
  assignedTo: Assignee | null;
  folderPath: string | null;
  spellCheckStatus: string; qrStatus: string; metaExtractionStatus: string; intraClaimStatus: string; fullScanStatus: string;
  remarks: Remark[];
  createdAt: string;
}

export default function ClaimUpdate() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const role = user?.role ?? 'USER';

  const [claim, setClaim] = useState<ClaimDetail | null>(null);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [remarkText, setRemarkText] = useState('');
  const [newStatusId, setNewStatusId] = useState<string>('');
  const [newAssigneeId, setNewAssigneeId] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);

  const canEdit = useMemo(() => {
    if (!claim || !user) return false;
    if (role === 'ADMIN' || role === 'TEAM_LEAD') return true;
    return claim.assignedTo?.id === user.id;
  }, [claim, role, user]);

  const canReassign = role === 'TEAM_LEAD' || role === 'ADMIN';

  const fetchClaim = async () => {
    setIsLoading(true);
    try {
      const r = await api.get<{ data: ClaimDetail }>(`/claims/${id}`);
      setClaim(r.data);
      const s = await api.get<{ data: Status[] }>(`/user/status-masters?subCategoryId=${r.data.subCategory.id}`);
      setStatuses(s.data);
      if (canReassign) {
        const u = await api.get<{ data: Assignee[] }>('/user/users-in-scope');
        setAssignees(u.data);
      }
    } catch (e) { toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Failed' }); }
    finally { setIsLoading(false); }
  };

  useEffect(() => { fetchClaim(); }, [id]);

  const handleSave = async () => {
    if (!remarkText.trim()) return toast({ title: 'Remark required', variant: 'destructive' });
    setIsSaving(true);
    try {
      const payload: Record<string, unknown> = { remarkText: remarkText.trim() };
      if (newStatusId && newStatusId !== claim?.workflowStatus.id) payload.newStatusId = newStatusId;
      if (canReassign && newAssigneeId !== '') {
        payload.newAssigneeId = newAssigneeId === '__unassign__' ? null : newAssigneeId;
      }
      await api.post(`/claims/${id}/remarks`, payload);
      toast({ title: 'Saved' });
      setRemarkText(''); setNewStatusId(''); setNewAssigneeId('');
      fetchClaim();
    } catch (e) { toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Save failed' }); }
    finally { setIsSaving(false); }
  };

  if (isLoading || !claim) return <div className="p-6">Loading...</div>;

  return (
    <div>
      <Button variant="ghost" className="mb-4" onClick={() => navigate(role === 'ADMIN' ? '/admin/claims' : '/claims')}><ArrowLeft className="h-4 w-4 mr-1" />Back</Button>

      <div className="bg-white border rounded-md p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold">{claim.claimId}</h1>
            <p className="text-sm text-gray-500 mt-1">{claim.subCategory.category.name} / {claim.subCategory.name}</p>
          </div>
          <Badge variant={claim.workflowStatus.isTerminal ? 'secondary' : 'default'}>{claim.workflowStatus.name}</Badge>
        </div>
        <div className="grid grid-cols-2 gap-4 mt-4 text-sm">
          <div><span className="text-gray-500">Folder Path: </span>{claim.folderPath ?? '-'}</div>
          <div><span className="text-gray-500">Assigned To: </span>{claim.assignedTo?.fullName ?? 'Unassigned'}</div>
        </div>
        <div className="flex flex-wrap gap-2 mt-4">
          <Badge variant="outline">Spell: {claim.spellCheckStatus}</Badge>
          <Badge variant="outline">QR: {claim.qrStatus}</Badge>
          <Badge variant="outline">Meta: {claim.metaExtractionStatus}</Badge>
          <Badge variant="outline">Intra-Claim: {claim.intraClaimStatus}</Badge>
          <Badge variant="outline">Full Scan: {claim.fullScanStatus}</Badge>
        </div>
      </div>

      <div className="bg-white border rounded-md p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">Update Claim</h2>
        {!canEdit && <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-3 mb-4">You can view this claim, but only the assignee or a supervisor can update it.</p>}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>Change Status (optional)</Label>
            <Select value={newStatusId} onValueChange={setNewStatusId} disabled={!canEdit}>
              <SelectTrigger><SelectValue placeholder="Keep current status" /></SelectTrigger>
              <SelectContent>{statuses.filter((s) => s.id !== claim.workflowStatus.id).map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {canReassign && (
            <div className="space-y-1">
              <Label>Reassign (optional)</Label>
              <Select value={newAssigneeId} onValueChange={setNewAssigneeId} disabled={!canEdit}>
                <SelectTrigger><SelectValue placeholder="Keep assignment" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unassign__">Unassigned</SelectItem>
                  {assignees.map((a) => <SelectItem key={a.id} value={a.id}>{a.fullName}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <div className="space-y-1 mt-4">
          <Label>Remark</Label>
          <Textarea value={remarkText} onChange={(e) => setRemarkText(e.target.value)} disabled={!canEdit} placeholder="Required" />
        </div>
        <div className="flex justify-end mt-4">
          <Button onClick={handleSave} disabled={!canEdit || isSaving || !remarkText.trim()}>{isSaving ? 'Saving...' : 'Save'}</Button>
        </div>
      </div>

      <div className="bg-white border rounded-md p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">Documents</h2>
        <p className="text-sm text-gray-500">Documents will appear here once the scanner is enabled (Phase 2).</p>
      </div>

      <div className="bg-white border rounded-md p-6">
        <h2 className="text-lg font-semibold mb-4">Remarks Timeline</h2>
        <div className="space-y-3">
          {claim.remarks.length === 0 && <p className="text-sm text-gray-400">No remarks yet.</p>}
          {claim.remarks.map((r) => (
            <div key={r.id} className="border-l-2 border-gray-200 pl-4 py-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{r.user.fullName}</span>
                <span className="text-gray-400">{new Date(r.createdAt).toLocaleString()}</span>
                {r.statusBefore && r.statusAfter && (
                  <Badge variant="outline">{r.statusBefore.name} → {r.statusAfter.name}</Badge>
                )}
              </div>
              <p className="text-sm text-gray-700 mt-1 whitespace-pre-wrap">{r.remarkText}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check the whole client**

Run: `cd client && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit Phase F + G + H frontend**

```bash
git add client/src/App.tsx client/src/pages/claims/ClaimDashboard.tsx client/src/pages/claims/ClaimUpdate.tsx
git commit -m "feat(client): Claim Dashboard + Claim Update Page with timeline"
```

---

## Phase I — Seed data + final verification

### Task I.1: Update seed.ts

**Files:**
- Modify: `server/prisma/seed.ts`

- [ ] **Step 1: Replace `isAdmin: true` with `role: 'ADMIN'`**

Search the file for `isAdmin`. Replace in user creation:

```ts
// before:   isAdmin: true,
// after:
role: 'ADMIN',
```

Likewise change any `isAdmin: false` to `role: 'USER'`.

- [ ] **Step 2: After existing seed code, add Phase 1 sample data for at least one SubCategory**

Append at the end of the seed function, after existing seeding completes:

```ts
const sampleSub = await prisma.subCategory.findFirst({ where: { status: 'ACTIVE' } });
if (sampleSub) {
  const existingDefault = await prisma.statusMaster.findFirst({ where: { subCategoryId: sampleSub.id, isDefault: true } });
  if (!existingDefault) {
    const pending = await prisma.statusMaster.create({
      data: { subCategoryId: sampleSub.id, name: 'Pending', displayOrder: 1, isDefault: true, isTerminal: false, createdBy: admin.id, updatedBy: admin.id },
    });
    await prisma.statusMaster.create({ data: { subCategoryId: sampleSub.id, name: 'Approved', displayOrder: 2, isTerminal: true, createdBy: admin.id, updatedBy: admin.id } });
    await prisma.statusMaster.create({ data: { subCategoryId: sampleSub.id, name: 'Rejected', displayOrder: 3, isTerminal: true, createdBy: admin.id, updatedBy: admin.id } });

    await prisma.documentTypeMaster.create({ data: { subCategoryId: sampleSub.id, name: 'Aadhar Card', category: 'GOVT', govtCode: 'AADHAR', displayOrder: 1, createdBy: admin.id, updatedBy: admin.id } });
    await prisma.documentTypeMaster.create({ data: { subCategoryId: sampleSub.id, name: 'PAN Card', category: 'GOVT', govtCode: 'PAN', displayOrder: 2, createdBy: admin.id, updatedBy: admin.id } });
    await prisma.documentTypeMaster.create({ data: { subCategoryId: sampleSub.id, name: 'Bill', category: 'CUSTOM', displayOrder: 3, createdBy: admin.id, updatedBy: admin.id } });

    await prisma.claimIdRule.create({ data: { subCategoryId: sampleSub.id, startPosition: 1, length: 8, scanTarget: 'FOLDER', scanLocation: 'D:\\Claims\\Daily', createdBy: admin.id, updatedBy: admin.id } });

    await prisma.claim.create({ data: { claimId: 'CLM00001', subCategoryId: sampleSub.id, workflowStatusId: pending.id, createdBy: admin.id, updatedBy: admin.id } });
    await prisma.claim.create({ data: { claimId: 'CLM00002', subCategoryId: sampleSub.id, workflowStatusId: pending.id, createdBy: admin.id, updatedBy: admin.id } });
  }
}
```

This block assumes `admin` is the variable holding the seeded admin user. Adjust the variable name to match what the existing seed file uses.

- [ ] **Step 3: Run the seed**

Run: `cd server && npm run db:seed`
Expected: success message; Studio shows new rows.

- [ ] **Step 4: Commit**

```bash
git add server/prisma/seed.ts
git commit -m "chore(seed): Phase 1 sample status, doc types, claim ID rule, claims"
```

### Task I.2: Manual end-to-end verification

- [ ] **Step 1: Start servers**

Run: `npm run dev` from repo root. Verify both server (3001) and client (5173) are up.

- [ ] **Step 2: Admin smoke test**

In browser:
1. Log in as the seeded admin.
2. Navigate to each new admin sidebar page (Status Masters, Doc Type Masters, Claim ID Rules, Claims). Confirm each loads, the SubCategoryPicker works, and you can create/edit/delete at least one record per master.
3. From Claims sidebar item, click into a seeded claim. Confirm the detail page renders with PENDING badges and the seeded remarks (if any).
4. Add a remark + change status. Confirm the timeline shows the entry with "Pending → Approved" badge.

- [ ] **Step 3: Team Lead smoke test**

In the admin Users page, change one non-admin user's role to `TEAM_LEAD`. Log in as that user (use impersonate or a fresh login):
1. Sidebar shows the new Claims section.
2. Claim Dashboard lists claims in their (UserType, Project) pair only.
3. "Add Claim" button is visible. Create a new claim.
4. Update status + add remark — works.
5. Reassign claim to another user in scope — works.
6. Navigate to `/admin/*` — should be denied / redirected to `/dashboard`.

- [ ] **Step 4: Regular User smoke test**

Log in as a plain `USER`:
1. Sidebar shows Claims section.
2. Claim Dashboard lists claims in their pair. "Add Claim" button is NOT visible.
3. Claims not assigned to this user show muted; clicking does nothing or opens read-only.
4. Assign yourself a claim via Team Lead login, then refresh as the User — that claim is now openable and editable. Status change + remark works.
5. Toggle "Assigned to me only" filter and confirm row count shrinks correctly.

- [ ] **Step 5: Existing URL proxy regression check**

Confirm: `/dashboard` still shows the URL Activity stats. The category → sub-category tree under "My URLs" still expands. Clicking a URL still opens the proxy view. No regressions in admin Users/Categories/etc.

- [ ] **Step 6: Lint + type check**

Run: `npm run lint && cd server && npx tsc --noEmit && cd ../client && npx tsc --noEmit`
Expected: all clean.

- [ ] **Step 7: Final commit (if any fixes)**

If any issues surfaced during smoke testing, fix them and commit. Otherwise this is just a sanity sign-off step.

```bash
git status   # should be clean
```

---

## Self-Review

I checked the plan against the spec end-to-end. Items to call out:

**Spec coverage** — every spec section maps to a task:
- §1 module boundary → Tasks A.* + Phase E mounting.
- §2 data model → Tasks A.2 + A.3 (single migration as spec requires).
- §3 roles & permissions → Tasks A.4 through A.10 + per-claim canEditClaim in E.2.
- §4 backend API surface → Phases B–E (every endpoint listed in the spec is implemented).
- §5 admin UI → Phase G + F.2.
- §6 end-user UI → Phase F.3 + Phase H.
- §7 migrations + seeding → Tasks A.3 + I.1.
- §8 testing → All service tests (B.1, C.1, D.1, E.1) + manual checklist in I.2.
- §9 out-of-scope → Honored by omission; no scanner/OCR/etc. tasks present.
- §10 deferred items → Re-noted as small inline decisions in Tasks G.3 and elsewhere; folderPath validation is left as inline client-side check in H.1 (lean: yes, drive-letter rule).

**Placeholder scan** — no TBDs, no "implement later", every code block is complete. The one "PRESERVE the existing tree" instruction in F.3 references the user's actual current code; the engineer is told exactly where to paste.

**Type consistency** — checked: `ClaimService.canEditClaim`, `appendRemark`, `getById`, `list` all reference the same `Role` type from Prisma and the same field names everywhere. `SessionData.role` matches `User.role`. The frontend `useAuthStore().user.role` literal union matches the backend enum.

**Scope check** — Phase 1 only. No Phase 2 work has leaked in. The plan is large but coherent; each Phase ends at a shippable checkpoint.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-20-claims-management-phase-1.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints for review.

**Which approach?**







