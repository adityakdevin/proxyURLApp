# Claims Management Phase 2E — Configurable Claim Rules Design

**Status:** Draft for review
**Date:** 2026-05-31
**Author:** Aditya Kumar (with Claude)
**Scope:** A configurable rules layer. Admins define simple per-SubCategory checks ("Field · Operator · Value") in the admin UI, and each claim is evaluated against them live (✅/❌). Replaces the originally-named "Excel-rules engine" — **no spreadsheet upload**; rules are entered through the web UI.

---

## 0. Executive Summary

The five validators (Phase 2C) are fixed in code. Phase 2E adds **admin-configurable** checks per SubCategory, evaluated against a claim's already-available facts (no new data capture). A rule is a declarative predicate — e.g. `Document Count ≥ 3`, `Has Document Type = Aadhar Card`, `QR Check = PASSED`, `Workflow Status = Approved`. Rules are created/edited on a new admin master-data page (same pattern as Status Masters / Doc Type Masters / Claim ID Rules), and a claim's rules are **evaluated live on demand** and shown on the Claim Update page.

### Decisions locked during brainstorming (2026-05-31)

| Topic | Decision |
|-------|----------|
| What 2E is | A **rules-only** layer over existing data (no new data-point capture). |
| Rule input | **Admin UI form** per SubCategory (no Excel / no file upload). |
| Rule shape | **Field · Operator · Value** declarative predicate (one row = one rule). |
| Evaluation | **Live on demand** (`GET /api/claims/:id/rules`) — no stored results table (always reflects current validation statuses). |

### Out of scope (Phase 2E boundary)

- No Excel/CSV upload or parsing.
- No new data-point capture / OCR field extraction (rules reference only facts already available).
- No free-form expression language, AND/OR composition, or decision tables — each rule is one Field·Operator·Value predicate (a claim's overall result is "N of M rules passed").
- No stored historical rule-result snapshots (live evaluation only; a `RuleResult` table can be added later if history is needed).
- No automatic blocking of workflow transitions based on rules (results are informational in v1).

---

## 1. Data model (Prisma — `npm run db:push`)

```prisma
enum RuleField {
  DOCUMENT_COUNT     // numeric
  REMARK_COUNT       // numeric
  ASSIGNED           // boolean (value 'true' | 'false')
  HAS_DOCUMENT_TYPE  // presence: value = a DocumentTypeMaster name
  WORKFLOW_STATUS    // value = a StatusMaster name
  SPELL_STATUS       // value ∈ PENDING|IN_PROGRESS|PASSED|FAILED
  QR_STATUS
  META_STATUS
  INTRA_STATUS
  FULL_STATUS
}

enum RuleOperator { EQ  NEQ  GTE  LTE  GT  LT }

model ClaimRule {
  id            String       @id @default(uuid()) @db.VarChar(36)
  subCategoryId String       @map("sub_category_id") @db.VarChar(36)
  name          String       @db.VarChar(150)
  field         RuleField
  operator      RuleOperator
  value         String       @db.VarChar(150)
  status        Status       @default(ACTIVE)
  displayOrder  Int          @default(0) @map("display_order")
  createdAt     DateTime     @default(now()) @map("created_at")
  updatedAt     DateTime     @updatedAt @map("updated_at")
  createdBy     String?      @map("created_by") @db.VarChar(36)
  updatedBy     String?      @map("updated_by") @db.VarChar(36)

  subCategory SubCategory @relation(fields: [subCategoryId], references: [id], onDelete: Cascade)

  @@index([subCategoryId])
  @@map("claim_rules")
}
```
+ `claimRules ClaimRule[]` on `SubCategory`.

---

## 2. Field vocabulary & operator validity

| Field | Type | Valid operators | `value` meaning | `actual` shown |
|-------|------|-----------------|-----------------|----------------|
| DOCUMENT_COUNT | number | EQ/NEQ/GTE/LTE/GT/LT | integer | the count |
| REMARK_COUNT | number | EQ/NEQ/GTE/LTE/GT/LT | integer | the count |
| ASSIGNED | boolean | EQ/NEQ | `true`/`false` | `true`/`false` |
| HAS_DOCUMENT_TYPE | presence | EQ/NEQ | a DocumentTypeMaster name | `present`/`absent` (EQ → pass when present; NEQ → pass when absent) |
| WORKFLOW_STATUS | enum-ish | EQ/NEQ | a StatusMaster name | the current workflow status name |
| SPELL_STATUS … FULL_STATUS | enum | EQ/NEQ | PENDING/IN_PROGRESS/PASSED/FAILED | the column value |

The admin UI filters the Operator dropdown to the chosen field's valid set, and turns Value into a dropdown for enum-ish fields (doc-type names, status names, validation-status values, true/false). The engine is also defensive: a numeric operator on a non-numeric field → `passed = false`.

---

## 3. Engine

```ts
// validators/ruleLogic.ts (pure)
export interface ClaimFacts {
  documentCount: number;
  remarkCount: number;
  assigned: boolean;
  presentDocTypeNames: string[];
  workflowStatusName: string;
  spellCheckStatus: string;
  qrStatus: string;
  metaExtractionStatus: string;
  intraClaimStatus: string;
  fullScanStatus: string;
}
export interface RuleEvaluation { passed: boolean; actual: string; }
export function evaluateRule(
  rule: { field: RuleField; operator: RuleOperator; value: string },
  facts: ClaimFacts
): RuleEvaluation;
```
- Pure, deterministic, no I/O → fully unit-testable.
- A **fact-gatherer** in `claimRuleService.ts` builds `ClaimFacts` for a claim with one set of queries (claim row for the 5 statuses + assignee + workflow status name; `document` count + present doc-type names; `claimRemark` count).

`ClaimRuleService`:
- CRUD for `ClaimRule` (create/update/delete/setStatus/list by SubCategory) — mirrors `ClaimIdRuleService`/`StatusMasterService`.
- `evaluateForClaim(claimId, callerId, callerRole)` → resolves the claim (scoped via the existing `getById` check), gathers facts, evaluates the SubCategory's ACTIVE rules in `displayOrder`, returns `{ rules: [{ id, name, field, operator, value, passed, actual }], passedCount, total }`.

---

## 4. API

```
# Admin master-data CRUD (adminMiddleware) — same shape as /admin/claim-id-rules
GET    /api/admin/claim-rules?subCategoryId=&status=&page=&limit=
POST   /api/admin/claim-rules
GET    /api/admin/claim-rules/:id
PUT    /api/admin/claim-rules/:id
PATCH  /api/admin/claim-rules/:id/status
DELETE /api/admin/claim-rules/:id

# Live evaluation (authMiddleware + scoped), any in-scope claim viewer
GET    /api/claims/:id/rules   → { data: { rules: [...], passedCount, total } }
```
Validation: `field` ∈ RuleField, `operator` ∈ RuleOperator, `value` non-empty (≤150); on create/update the route checks the operator is valid for the field's type and (for numeric fields) that `value` parses as an integer → else 400 `INVALID_RULE`.

---

## 5. Admin UI — new "Claim Rules" master-data page

`client/src/pages/admin/ClaimRules.tsx`, mounted at `/admin/claim-rules`, re-added to the AdminLayout "Claims Config" sidebar group. Same DataTable + form-dialog + ConfirmDialog pattern as `ClaimIdRules.tsx`:
- SubCategory picker (existing `SubCategoryPicker`) → lists that SubCategory's rules.
- Add/Edit dialog: **Name** · **Field** (dropdown of the 10 fields) · **Operator** (dropdown filtered to the field's valid operators) · **Value** (free number for numeric fields; dropdown of doc-type names / status names / `PASSED…` / `true`-`false` for the enum-ish fields). Fetches doc-type and status names for the picked SubCategory to populate Value dropdowns.
- Row actions: Edit, Activate/Deactivate, Delete.

## 6. Claim Update page — "Claim Rules" section

`ClaimUpdate.tsx` gains a section below the validation badges: fetches `GET /claims/:id/rules`, renders each rule as `Name` — `Field Operator Value` → ✅/❌ with the `actual` value (e.g., "Document Count ≥ 3 → ✅ (3)", "QR Check = PASSED → ❌ (FAILED)"), and a header "Rules passed: N of M." Empty state when the SubCategory has no active rules.

## 7. Permissions

Admin-only CRUD of rules (adminMiddleware). Live evaluation readable by any in-scope claim viewer (same scope as `GET /claims/:id`).

## 8. Dependencies

**None.** Pure TypeScript + Prisma + existing UI components.

## 9. Testing

- **`evaluateRule`** (pure) — unit tests across each field × valid operator (numeric comparisons, enum EQ/NEQ, HAS_DOCUMENT_TYPE presence both directions, ASSIGNED bool, numeric-operator-on-non-numeric → false).
- **`ClaimRuleService`** — fact-gatherer + `evaluateForClaim` with self-contained fixtures (a claim with N documents of certain types, a remark, given validation statuses) asserting `passedCount`/`actual`; CRUD invariants (create/list/setStatus/delete) like the other master services.
- **Admin routes** — mirror the tested `claim-id-rules` route shape; `INVALID_RULE` on bad field/operator/value.
- **Type-check** both workspaces; live smoke (create a rule, view a claim, see ✅/❌).

## 10. Open items for the implementation plan

- Exact operator-validity map per field (numeric vs enum) — encoded as a small table used by both the route validator and the UI.
- Whether HAS_DOCUMENT_TYPE / WORKFLOW_STATUS values are stored by **name** (simpler, matches what admins pick) — lean: by name, resolved against the SubCategory's masters at evaluation time.
- Empty/“no rules configured” copy on the Claim Update section.

These are small and settled during plan-writing.
