# TODOS

Deferred work, grouped by area then priority (P0 highest). Completed items move to the
bottom. Created 2026-08-16 from the `/ship` review of `fix/doc-type-not-required-by-default`.

## Claims — bulk actions

### Bulk actions are a serial per-claim loop
**Priority:** P1
`runBulk` (`server/src/lib/bulkClaims.ts`) awaits one operation per claim, up to
`BULK_MAX` = 500. Each `/bulk/remarks` iteration costs ~5 sequential round-trips
(`canEditClaim` findUnique + a scope lookup + `appendRemark`'s transaction), so a full
batch is ~1000-2500 serialized queries inside one Express request — past typical proxy
timeouts. The client then sees a 504 while the loop keeps running, and a retry writes a
second set of remarks (`appendRemark` is not idempotent).
Fix: bounded-concurrency chunks via `Promise.allSettled`, hoist the permission check out
of the loop into one `claim.findMany` + one `userSubCategory.findMany`, and for
`/bulk/validate` replace the per-claim `enqueue` with a single `createMany` + one drain.
Found by: /ship performance specialist, 2026-08-16.

### No rate limiting on queue-amplifying endpoints
**Priority:** P1
There is no `express-rate-limit` anywhere. One authenticated user can `POST
/claims/bulk/validate` repeatedly and monopolise the single serial validation drainer for
every other user; `BULK_MAX` caps one request, not the rate.
Fix: per-session rate limit on `/claims/bulk/*`, and/or a cap on in-flight MANUAL runs
per user.
Found by: /ship security + adversarial passes, 2026-08-16.

### Bulk actions leave no aggregate audit record
**Priority:** P2
The repo has an `AuditLog` table, but a bulk delete/reassign/status change leaves only N
individual `ClaimRemark` rows. "Who mass-reassigned 400 claims" is only answerable by
correlating 400 rows. Likely a compliance gap for a claims-review product.
Found by: /ship adversarial pass, 2026-08-16.

### Failed claim ids are fetched and then discarded
**Priority:** P2
`runBulk` returns `failed: [{id, code}]` but the client renders only the distinct codes in
an auto-dismissing toast, and clears the selection afterwards — so "retry the ones that
failed" is impossible. Keep the failed ids and offer to re-select them.
Found by: /ship adversarial pass, 2026-08-16.

### Concurrent bulk status changes can corrupt the transition trail
**Priority:** P2
`appendRemark` reads the claim and updates it inside a transaction with no row lock, so
two overlapping bulk runs can both record the same `statusBeforeId`. Pre-existing in the
single-claim path; bulk makes overlapping runs normal.
Found by: /ship adversarial pass, 2026-08-16.

### `bulkFilters` is a hand-maintained copy of the list query
**Priority:** P3
`AdminClaims.tsx` and `ClaimDashboard.tsx` each rebuild the filter object for "select all
matching" separately from the object used to fetch the list. They agree today only because
the admin list exposes no `status` filter; add one and forget the copy, and "select all 12
matching" targets 12 different claims.
Fix: derive both from one object.
Found by: /ship adversarial pass, 2026-08-16.

## Claims — client testing

### ~900 lines of new claims UI have no automated coverage
**Priority:** P1
`ClaimBulkBar`, `ClaimActionDialog`, `ClaimRowActions`, `ClaimJumpBox` and the selection
logic in `DataTable` have no unit runner (the client workspace has none) and
`e2e/claims.smoke.spec.ts` is 21 lines asserting two screens render. The risky semantics
are the ids-vs-filters switch in the bulk bar and the role gates on the row menu.
Fix: Playwright specs covering tick-rows → bulk bar count → "select all N matching" →
Clear, plus non-admin storage states (only an ADMIN state exists today) to drive the
`isSelectable` and role-gated paths.
Found by: /ship coverage audit + testing specialist, 2026-08-16.

### Flaky: "enqueue coalesces and the drainer processes QUEUED runs serially"
**Priority:** P2
`server/src/services/__tests__/validationService.test.ts:89` failed once in three full-suite
runs (expected 2 runs, got 3) and passes 3/3 in isolation. `enqueue` coalesces by looking for
an existing QUEUED row, so if a drain starts between the two `enqueue(c1)` calls the first row
is no longer QUEUED and a second run is created. The test depends on that timing.
Fix: await the drain deterministically, or assert on coalescing directly rather than on the
row count.
Found by: /review, 2026-08-16.

## Database

### Migration history cannot rebuild the current schema
**Priority:** P1
`prisma/migrations/` holds one migration from 2026-07-06; everything since has been
applied with `prisma db push`. `prisma migrate diff` against the schema produces 71 lines
including `DROP COLUMN sub_category_id` on three master tables, a new `red_flag_status`
column and the `spell_terms` table. Deploys use `db push`, so nothing is broken today, but
the folder is misleading and a fresh database cannot be built from it.
Fix: decide whether to keep migrations at all. If yes, baseline the current schema as a
squashed initial migration and mark it applied everywhere.
Found by: /ship, 2026-08-16.

### Claim list ordering has no index below the new composite
**Priority:** P3
`claims_status_created_at_id_idx` covers the default `createdAt` order. The list also
sorts by `claimId`, `spellCheckStatus`, `qrStatus`, `metaExtractionStatus`,
`intraClaimStatus` and `fullScanStatus` — each of those is still a filesort.
Found by: /ship performance specialist, 2026-08-16.

## Claims — document viewer

### QR tab count contradicts the QR pane
**Priority:** P2
On some claims the check tab reads "QR 1" while Document details shows "No QR code found"
for the same document — the badge counts `details.decoded`, the pane matches decoded pages
against field groups. One of the two is wrong. Predates this branch (came with the QR pane
work in PRs #43/#44); needs a domain call on which count is right.
Found by: /qa, 2026-08-16.

### Type-ahead search hits the full paginated list endpoint
**Priority:** P3
`ClaimJumpBox` calls `GET /claims?search=` per keystroke burst; that endpoint runs three
joins plus a `claim.count` the jump box discards, over a leading-wildcard LIKE. Add a
search-only endpoint or a `skipTotal` flag, and abort superseded requests with an
`AbortController` (cancellation is flag-only today).
Found by: /ship performance specialist, 2026-08-16.

### `adjacent` ignores the list's filters
**Priority:** P3
The viewer's ⟨/⟩ arrows step through claims in default list order, not the filtered order
the reviewer was looking at, so a reviewer who filtered to "spell FAILED" steps into an
unrelated claim. Documented as a `ponytail:` limitation in `claimService.ts`.
Found by: /ship adversarial pass, 2026-08-16.

## Completed

_(nothing yet)_
