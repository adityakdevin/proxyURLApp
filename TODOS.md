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

### Existing document types stay required until the backfill is run
**Priority:** P0 — operational, not code
`npm run db:backfill-doctype-required` exists and is safe to dry-run, but it has NOT been
run against any deployed database. Until it is, every type created under the old
`DEFAULT true` still gates Full Scan and the symptom the `isRequired` flip was meant to
remove persists. It deliberately skips rows edited since creation, so a type an admin
genuinely ticked must be cleared by hand.
Fix: run the dry run, eyeball the skip list, re-run with `--apply`, then `npm run db:revalidate`.
Found by: /review adversarial pass, 2026-08-16.

### Bulk delete counts an already-deleted claim as a success
**Priority:** P3
`softDelete` returns early when the claim is already INACTIVE, so re-deleting a stale
selection reports "Deleted: 50 of 50" having changed nothing. Left as-is deliberately: the
obvious fix (gate on `canEditClaim`, which is false for a non-ACTIVE claim) would report a
whole batch as failures when a reviewer retries after the 504 this file's own P1 says to
expect, and would replace the specific `NOT_FOUND` a missing claim reports with a vaguer
`CLAIM_NOT_EDITABLE`. Retry-safety is worth more than the count.
Fix, if it ever matters: report `alreadyInactive` as its own field on the bulk report.
Found by: /review, 2026-08-16.

## Validators — client QA 2026-10 follow-ups

### Re-validate every claim, and review "Doubtful" claim rules, after deploying PR #114
**Priority:** P0 — operational, not code
Findings stored before this branch with severity WARNING ("Missing docs - X", claim ID not
found, QR missing) stay hidden until the claim is re-validated, so those claims show a
FAILED card with no reasons. DOUBTFUL also changed meaning, from "passed with warnings" to
"check did not run": any ClaimRule or saved filter on DOUBTFUL or PASSED for a check field
now matches a different set of claims.
Fix: `npm run db:revalidate` after deploy; list `ClaimRule` rows whose value is DOUBTFUL or
PASSED on a check field and have an admin confirm each.
Found by: /ship review passes 3-4, 2026-10-13.

### Parsing edge cases the red team found, each confidence 4-5
**Priority:** P1
Each touches extraction used by real claims, so each needs a 570-claim re-run to check:
- `logic.ts` PAN presence marker accepts a PAN-shaped token plus "father"/"dob"/"signature"
  on booking forms, Form 60 and KYC declarations, so FULL counts a missing PAN card present.
- `redFlagLogic.ts` `vidRead` takes the first four groups, so a 20-digit VID passes as 16.
- `redFlagLogic.ts` `checkPan` prefers any well-shaped PAN on the page over the labelled one.
- `crossDocLogic.ts` ACCOUNT_NO lookahead swallows an integer next column, missing a DUP.
- `crossDocLogic.ts` guardian-prefix strip eats a comma-less Aadhaar address and its PIN.
- `crossDocLogic.ts` `sectionHeadingBefore` drops a bare "Name :" when the other OCR column
  says agent/dealer/employer/hypothecated, so a name mismatch passes clean.
- Data Compare's CHASSIS/ENGINE field match (`idMatches`) still allows one edit in the
  serial, so a next-in-batch chassis on two papers agrees. QR and Intra already require an
  exact serial; this one predates the branch.
Found by: /ship red team pass 4, 2026-10-13.

### QR image retries run on the request thread
**Priority:** P1
`decodeQrImage`'s retry passes (Jimp scale, greyscale, four quadrant crops, zxing tryHarder)
are synchronous on the Express process, up to 12 images per claim times
`VALIDATION_CONCURRENCY` workers; a bundle of unreadable card photos can stall login and the
claim list for seconds. Each quadrant also clones the full bitmap before cropping.
Fix: crop from one shared clone, yield between passes, then move decode to `worker_threads`.
The retry path has no automated test either (zxing loads through a dynamic `import()` that
Jest cannot run): add a tsx script over three card photos (small, over 25 MP, past budget).
Found by: /ship performance + testing specialists, 2026-10-13.

### Duplicate-partner re-queue reads every historical DUP result
**Priority:** P2
`requeueDuplicatePartners` loads partners with nested `validationResults {take: 1}`, which
Prisma resolves in memory, and `ValidationResult` has only a `claimId` index. Add
`@@index([claimId, validatorKey, createdAt])` (needs `db:push`). Separately, while a
re-queued partner's run is QUEUED, `GET /claims/:id/validation` returns that empty run and
the claim's cards go blank; fall back to the latest COMPLETED run's results.
Found by: /ship performance + API contract specialists, 2026-10-13.

### Smaller review leftovers
**Priority:** P2
- "Not run / Doubtful" is spelled in `checkFilters.ts` and twice in `ClaimRules.tsx`, next to
  upper-case PASSED/FAILED; derive every status label from one helper.
- The QR card shows "View QR Data" on every document row when it has no red flags.
- `ValidationBadge` is `whitespace-nowrap`; check the claims table at 1280px.
- FieldPanes still colours a WARNING chip that can no longer arrive.
- Tests still missing: the GET /validation WARNING filter (route test), QR page truncation,
  redFlagValidator date de-duplication, and a re-queue of a RUNNING partner.
- Wheel zoom does not re-centre on the cursor; docFields reports NOT_A_MODEL twice.
Found by: /ship review passes 2-4, 2026-10-13.

### New false reds from the round-2 OCR changes
**Priority:** P1
Reading small cards larger and thresholding patterned ones finds more text, and some of it is
junk. On the 570 QA claims: SPELL 22 pass→red (about half real typos, the rest OCR junk),
COMPARE 7, QR 8, REDFLAG 4 (junk names, impossible dates, Aadhaar mismatches from misreads).
QR DOB compare is format-sensitive (QR "1985-07-15" vs printed "15/07/1985") and is now
reached on more card pages. The QR holder-name page rescue was removed in review; redo it so
it rescues only junk-name misreads (612342, 631650 flag again). Also open: 627998 PAN read
with a space, 045360 name misread, cardText's pdf-parse fallback.
Fix: classify each new red on the 570-claim diff, then fix by cause.
Found by: 570-claim comparison, 2026-10-16.

### OCR and SPELL re-read leftovers
**Priority:** P2
- `TesseractOcrPort.close()` does not settle a recognize already in flight (tesseract.js
  5.1.1 `terminate` leaves its jobs pending), so a timed-out SPELL keeps one temp PNG and its
  render buffer. Race recognize against a closed promise, or pass the buffer, not a file.
- META's high-res retry is invisible to SPELL, which compares against the first look only.
- SPELL renders a page before measuring its image; per-claim (not per-doc) re-read budget.
- The Sauvola pass starts its own worker; dense pages take every pass.
- No Jest test for the getPool close race or the image-size Map/null contract (ESM dynamic
  imports); add a tsx check over a few real PDFs.
Found by: /ship review passes 1-3, 2026-10-16/17.

### Red flag rules still open
**Priority:** P2
- GSTIN check char is only folded for OCR misreads; a clean print and text layers need it too.
- A single-sided voter card (front only, back never scanned) still reads "Back side NA".
- `qrPresentUnread` is decided per page; the bundled "No QR" line can disagree with it.
Found by: /ship review passes 1-3, 2026-10-16/17.

## Completed

- **Bulk actions on a filter set could target claims the reviewer never selected** — `allMatching`
  survived the bulk bar rendering `null`, so unticking every row and ticking a different one
  came back still aimed at every matching claim. Reset on an empty selection. (2026-08-16)
- **The `isRequired` flip did not change existing rows** — the migration set only the column
  DEFAULT. Added `npm run db:backfill-doctype-required`. (2026-08-16)
- **Viewer step arrows carried the previous claim's neighbours** — `neighbours` is now cleared
  before each fetch, so Back no longer skips a claim and Next is no longer a no-op. (2026-08-16)
- **Type-ahead Enter could commit a suggestion from an earlier prefix** — hits are now tagged
  with the term they were fetched for. (2026-08-16)
- **A fully-refused batch read as success** — `describeBulkReport` is shared by the dialog and
  the bulk bar, so neither can drift on the `succeeded === 0` case again. (2026-08-16)
- **Non-JSON error responses surfaced as a JSON parse error** — `api.ts` checks `response.ok`
  before parsing. (2026-08-16)
- **Bulk filter values skipped the validation the read path enforces** — `filters.*` now gets the
  same `isUUID`/`isLength` chain as `GET /claims`. (2026-08-16)
