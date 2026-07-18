# Document Red-Flag Rules + Per-Page Provenance (Phase 1 High)

## Context

The validation pipeline detects *which document types are present* but throws away
where each was found and never checks the *format* of the numbers on them (PAN,
Aadhaar, GST, DL, Passport, Udyam). For a fraud-review tool that's the core signal:
a PAN that isn't 10 chars, a GST missing its mandatory `Z`, an Aadhaar that differs
front vs back. Reviewers currently eyeball every bundle by hand. This adds a rules
engine that flags those violations automatically and tells the reviewer exactly
which file and page to look at.

## Current State (verified)

- `fullValidator.ts:19-26` — `FULL` reports required types as present/missing
  **names only**. `typePresent(name, govtCode, texts)` (`logic.ts:98`) takes a flat
  `[...ctx.shared.values()]` array, so file identity and page boundaries are
  discarded before the check.
- `metaValidator.ts:118-119` — per-doc text goes to `ctx.shared`; per-word boxes
  (with 1-based `page`, `types.ts:14`) go to `ctx.wordBoxes`. Page-level text is
  reconstructable by grouping a doc's word boxes by page.
- `types.ts:70-71` + `schema.prisma:589-590` — `Finding.page` (Int?) and
  `Finding.bbox` (Json?) already exist and are unused, indexed by
  `@@index([documentId, page])`. Storing file+page per red flag needs NO schema
  change.
- `pdfExtractor.ts:readPdfInfo` exposes the PDF `Producer`/`Creator` — reused for
  the editor/AI-watermark rule.
- No format rules, no per-page classification, no provenance exist today.

## Proposed Change

### 1. Shared segmentation + classification helper (`server/src/validators/segment.ts`, new)

- `pagesFor(doc, ctx)` — reconstruct per-page text from `ctx.wordBoxes`
  (fallback: whole-doc text from `ctx.shared` as a single page-null unit when no
  boxes exist, e.g. the pdf-parse path).
- `classifyPage(text)` — document type via the existing `GOVT_TYPE_MARKERS` +
  `typeInText` (`logic.ts:74-116`), extended with `GST` and `UDYAM` markers.
- Produces `DocInstance[] = { documentId, fileName, page: number|null, govtCode, text }`.
- Merged vs individual rule: if one file classifies to multiple types across pages
  -> each instance keeps its `page` (store file + page). If a file yields a single
  type -> `page = null` (store filename alone).

### 2. Full Scan card — add provenance (`fullValidator.ts`)

Keep Full Scan as the completeness authority ("everything"), but enrich its output:
each required type shows Found in `file.pdf` p.3 (from the classifier) or Not found.
Missing-type findings stay as-is.

### 3. New `REDFLAG` validator + card (Phase 1 High rules)

- New `ValidatorKey 'REDFLAG'`, Claim column
  `redFlagStatus ValidationStatus @default(PENDING)` (`db push` — one column, the
  schema.prisma:393-397 pattern).
- Card behaves like QR/SPELL: PASSED when no red flags, FAILED when any fire; every
  finding carries a plain-English reason and its file + page.
- Rule catalog (per classified instance unless noted):

| Type | Rule | Check | Reason on fail |
|---|---|---|---|
| PAN | 10-char format | `^[A-Z]{5}[0-9]{4}[A-Z]$` | "PAN not a valid 10-char format" (+count) |
| PAN | 4th-letter category | map P/C/H/A/T/B/L/J/G | reports holder category; flag if 4th char invalid |
| Aadhaar | 12-digit | `\b\d{4}\s?\d{4}\s?\d{4}\b` | "Aadhaar not 12 digits" (+count) |
| Aadhaar | VID 14-digit | `\b\d{4}\s?\d{4}\s?\d{4}\s?\d{2}\b` | "VID not 14 digits" |
| Aadhaar | front=back | same number across pages of one file | "Aadhaar differs front vs back" |
| GST | 15-digit + `Z` at pos 14 | GSTIN regex, 2nd-from-end = `Z` | "GST invalid / missing Z" (+count) |
| DL | 16 chars | length/format | "DL not 16 digits" (+count) |
| Voter ID | number same on back | cross-page match; else "Back side NA" | "Voter ID differs on back" |
| Udyam | 19-char `UDYAM-XX-XX-NNNNNNN` | regex | "Udyam reg. no. malformed" (+count) |
| Passport | file no 12 or 15 digits | length check | "File no. outside 12-15 digits" (+count) |
| Passport | 8-digit passport no twice | appears on p.1 and near barcode | "Passport no. mismatch across pages" |
| Every doc | signature keyword | `authorised|signatory|signature` present | "No signature/authorised-signatory found" |
| Every doc | editor/AI watermark | `readPdfInfo` Producer/Creator matches editor list | "Document produced/edited by <tool>" |
| Every doc | calendar-valid dates | reject 31 in Apr/Jun/Sep/Nov, 29 in non-leap Feb | "Impossible date: <date>" |

- All rule logic is pure functions in `redFlagLogic.ts` (unit-testable like
  `logic.ts`); the validator just wires text -> rules -> findings.

### 4. Frontend card (`ClaimUpdate.tsx`)

New card in the `VALIDATORS` list, same pattern as QR/SPELL. Each red flag row:
reason + `file.pdf p.3`, clickable into the existing highlight viewer (findings
already carry `page`).

## Acceptance Criteria

1. A merged PDF containing PAN(p1)+Aadhaar(p2/3)+GST(p4) yields, in Full Scan, each
   type marked Found with its file + page.
2. Individual files (one type each) show filename only, no page.
3. A PAN string `ABCD1234E` (9 chars) -> REDFLAG FAILED, reason "PAN not a valid
   10-char format", tagged to its file+page.
4. A valid PAN `ABCPD1234E` -> 4th-letter category "P - Individual" surfaced, no
   red flag.
5. A GST without `Z` at the 2nd-last position -> FAILED with reason + count.
6. Aadhaar number differing between page 2 and page 3 of the same file -> FAILED
   "differs front vs back".
7. A date `31/04/2025` anywhere -> FAILED "Impossible date".
8. A PDF whose Producer is `iText` -> FAILED "produced/edited by iText"
   (advisory-tunable, see Out of Scope note).
9. Zero red flags -> card PASSED.
10. `redFlagLogic` unit tests cover each rule's pass + fail; `tsc --noEmit` and
    existing jest suites stay green.

## Testing Plan

| Layer | What | Count |
|---|---|---|
| Unit | each rule in `redFlagLogic` (pass+fail+count) | ~28 |
| Unit | `segment.pagesFor` / `classifyPage` (merged, single, no-boxes) | +5 |
| Integration | `redFlagValidator.run` over a synthetic multi-type bundle | +3 |
| Integration | `fullValidator` provenance (file+page) | +2 |

## Files Reference

| File | Change |
|---|---|
| `server/prisma/schema.prisma:393` | add `redFlagStatus` column |
| `server/src/validators/segment.ts` | NEW — per-page classification |
| `server/src/validators/redFlagLogic.ts` | NEW — pure rule functions |
| `server/src/validators/redFlagValidator.ts` | NEW — validator |
| `server/src/validators/logic.ts:74` | add GST + UDYAM markers |
| `server/src/validators/fullValidator.ts` | add file+page provenance |
| `server/src/validators/registry.ts` | register REDFLAG |
| `server/src/validators/types.ts:4` | add `'REDFLAG'` key + column |
| `client/src/pages/claims/ClaimUpdate.tsx` | new card + finding rows |

## Out of Scope (deferred)

- Phase 2 Normal rules (birth-date cross-checks, salary/deduction calc, gender
  recording, State/RTO code masters, RC decomposition) — separate spec.
- Image-vision checks — hologram presence, handwritten-signature-image detection.
  Phase 1 uses keyword/QR-decode only.
- Editor-watermark tuning: flagging any editor Producer (iText/iLovePDF are
  extremely common) may be noisy. Recommend an admin-editable editor allowlist as
  a fast follow — flagging as a known tuning knob, not building it now.

## Effort

~3h segment/classify + 4h rule functions + 2h validator wiring + 1h schema/registry
+ 2h Full Scan provenance + 3h frontend card + 4h tests ~= 19h.

## Engineering Review — Locked Decisions (2026-07-18)

Refinements from `/plan-eng-review`, binding on implementation:

1. **Per-page text source.** Do NOT reconstruct page text by re-joining
   `ctx.wordBoxes` (fragile: pdf-parse fallback has no boxes; token order is
   approximate). Instead, change `extractPdf` (`pdfExtractor.ts:97-121`) to also
   return a per-page text array, and have `metaValidator` store it on the context
   (new `ctx.pageTexts: Map<documentId, string[]>`). `segment` reads that.
2. **No extraction inside `segment` / `redFlagLogic`.** Both consume already-
   populated `ctx` data only. Never call `extractPdf`/`rasterizePdf` from them —
   pdfjs dynamic import can't run under jest, and this keeps every rule unit test
   injectable with plain fixtures.
3. **Rule granularity.** Type-specific format rules (PAN/Aadhaar/GST/DL/Udyam/
   Passport) run per classified page/instance. The three "Every Doc" rules
   (signature keyword, editor/AI watermark, calendar-date validity) run at the
   FILE level — a keyword present anywhere in the file satisfies it — to avoid a
   false-positive flood on merged bundles.
4. **Classifier vs `documentTypeId`.** Content classification decides WHERE a
   format rule runs (page-level). Filename `documentTypeId` stays authoritative
   for FULL completeness. A disagreement is a LOW-severity finding, not a silent
   override.
5. **DRY the classifier.** `segment` is the single classification path; both
   `fullValidator` (provenance) and `redFlagValidator` call it. Neither
   re-classifies independently.
6. **Registry order.** REDFLAG registers AFTER META (needs `ctx.shared` +
   `ctx.pageTexts`). FULL stays last.
7. **Wording fixes.** DL is 16 *characters* (`[A-Z]{2}[0-9]{2}` + 11 digits), not
   "16 digits" — fix the reason text. Recheck Udyam (19 chars including hyphens).
8. **Watermark severity = FAILED** (user decision, overriding the WARNING
   recommendation). Accepted tradeoff: editor Producers (iText/iLovePDF) are
   common on re-saved PDFs, so expect a high initial FAILED rate. STRONGLY
   recommended fast-follow: admin-editable editor allowlist so common tools don't
   fire. Tracked in Out of Scope; prioritize it right after Phase 1 High lands.

## GSTACK REVIEW REPORT

| Run | Status | Findings |
|-----|--------|----------|
| plan-eng-review (claude) | complete | 7 architecture/correctness findings, 1 decision resolved |

VERDICT: APPROVED WITH LOCKED REFINEMENTS. Spec is buildable once decisions 1-8
above are folded in. Highest risks addressed: per-page text fragility (→ extractPdf
per-page), Every-Doc FP flood (→ file-level), testability under jest (→ no
extraction in segment). Watermark-FAILED accepted by user with allowlist fast-follow.

**UNRESOLVED DECISIONS:**
- Editor allowlist for the watermark rule: build in this PR or as immediate
  fast-follow? (Recommendation: fast-follow, keeps Phase 1 High shippable.)
