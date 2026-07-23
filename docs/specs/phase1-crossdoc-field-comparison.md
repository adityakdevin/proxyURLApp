# Phase 1 — Cross-Document Field-Comparison Red-Flag Rules

Status: **IMPLEMENTED** on branch `feat/claim-crossdoc-field-comparison` (2026-07-23).
Reviewed via `/plan-ceo-review` (HOLD SCOPE), built as `server/src/validators/crossDocLogic.ts`,
folded into the REDFLAG validator. tsc clean; 15-case unit suite green (`__tests__/crossDoc.test.ts`).
Sibling: date-comparison rules live in [phase2-crossdoc-redflag-rules.md](./phase2-crossdoc-redflag-rules.md).

**What shipped vs the model below:** the 14 pairwise rules were built as field-consistency
checks scoped to doc-type sets (a field must agree across the docs in its scope). New-vs-old
insurance needs no classification — a new-car policy carries no vehicle number, so it drops
out of that check on its own. 7 doc-type buckets classified (INVOICE/RC/INSURANCE/KYC/PAYSLIP/
STAFF_ID/DMS); Exchange Declaration stays Phase 2. Findings use codes `CROSS_<FIELD>_MISMATCH`
(ERROR) and `CROSS_UNCLASSIFIED` (WARNING), emitted through the existing `redFlagStatus` column.

## The rules (Priority: High, 14 rules)

Compare the SAME field value across a SPECIFIC document-type pair; red-flag when they differ.

| # | Doc 1 | Doc 2 | Fields compared |
|---|-------|-------|-----------------|
| 1 | DMS Upload File | Invoice | Customer Name |
| 2 | Invoice | New car Insurance | Customer Name, Chassis No, Engine No, Model |
| 3 | Old car Insurance | RC | Customer Name, Chassis No, Engine No, Vehicle No, Model |
| 4 | Old car Insurance | Relation KYC | Name |
| 5 | RC | Relation KYC | Name |
| 6 | New car Insurance | New car customer KYC | Name |
| 7 | Invoice | Payslip | Customer Name = Employee Name |
| 8 | Invoice | Staff ID card | Customer Name = Employee Name |
| 9 | Staff ID card | Payslip | Employee Code/Id |
| 10 | Staff ID card | Payslip | Employee Name |
| 11 | Invoice | Old car Insurance | Customer Name |
| 12 | Invoice | Old car RC | Customer Name (note: "Same Name / Diff Name" nuance) |
| 13 | Invoice | Every Doc & KYC | Name **other than** Father/Mother/Agent name |
| 14 | KYC | Every Doc | Father/Mother/Husband name |

Phase 2 (Normal) adds Exchange Declaration comparisons + Invoice date/number, plus a
highlight-and-resave output with a copyable mismatch comment. Deferred.

## Current status

A thin, doc-type-BLIND version exists; the doc-pair matrix does not.

- `crossDocMismatches` (`server/src/validators/logic.ts:321`) — compares 2 fields only:
  NAME (`extractLabeledNames`, "Customer Name:"/"Name:") and VIN (`extractVins`, bare
  17-char scan). Collects every value across ALL docs; 2+ distinct → `INTRA_FIELD_MISMATCH`
  → claim FAILED. Exact normalized-string equality. Wired via `intraValidator.ts:40`.
- `segment.ts` classifies pages, but `GOVT_TYPE_MARKERS` (`logic.ts:74`) knows govt IDs
  ONLY (AADHAR/PAN/DL/VOTER/PASSPORT/GST/UDYAM) — none of the business doc types above.
- `ValidatorDoc.documentTypeId` (`types.ts:48`) already carries the type for UPLOADED docs.

**Field coverage:** Name ⚠️partial (doc-blind, lumps customer+employee), VIN/Chassis
⚠️partial (bare scan), Engine/Vehicle No/Model/Emp Code ❌, Relation name ❌ (and the
generic `Name:` grab risks false-flagging it). **0 of 14 doc-pair rules implemented.**

The flat model is also partly WRONG for this spec: it false-flags KYC father/mother name
vs customer name — exactly what rule 13 carves out.

## Reviewed implementation plan (Approach B, HOLD SCOPE)

Decisions from `/plan-ceo-review` + independent outside-voice review (cross-model
consensus reversed two initial picks):

1. **Doc-type-aware pairwise engine**, not an extension of the flat comparator.
2. **Classification:** trust `documentTypeId` when present; content-classify only
   null-type (scanned) pages. Business-doc markers must be **priority-scored** (count
   distinctive tokens, pick max, require a minimum margin) — Invoice/Exchange-Decl/DMS/
   Payslip share vocabulary, so first-match classification mis-attributes.
3. **Per-page attribution:** run the field extractors inside `segment()`'s page loop,
   keyed by the page's classified type — NOT on whole-doc `ctx.shared` (else a bundled
   PDF can never compare "RC-page vs Invoice-page").
4. **Field extractors:** label-anchored for chassis/engine/vehicleNo/model/empCode/
   relationName, reusing the `labeledCandidate` pattern (`redFlagLogic.ts:71`).
5. **Name matching:** token-set + initial-aware match (handles "Rajesh Kumar" / "Rajesh K"
   / "R. Kumar" / surname-first), flag only when zero meaningful tokens overlap. NOT
   Damerau edit-distance (too tight for multi-token Indian names). Exclude Father/Mother/
   Husband/Agent-labeled names from the customer-name comparison (rules 13/14).
6. **Placement:** fold cross-doc logic into the existing `redFlagValidator` (already
   segments + classifies), **retire** `logic.ts` `crossDocMismatches`, add **no new
   schema column**. Avoids three overlapping cross-doc mechanisms.
7. **Shadow paths:**
   - Required doc type absent → silent (no false flag on incomplete claims).
   - Present but unclassifiable → WARNING **and** fall back to type-blind comparison so
     the check still runs (a bare WARNING that changes nothing is theater).
   - Vehicle Number `NEW`/`APPLIED FOR`/`TBA`/blank → treat as absent, not a mismatch
     (new-car invoice has no registration yet).
   - Engine/Chassis have no reliable format → bounded fuzzy compare or WARNING-only,
     never a hard FAIL on an OCR-corrupted ID.

## Reusable primitives

- `segment.ts` — per-(doc,page) classification framework (extend the vocabulary).
- `labeledCandidate()` (`redFlagLogic.ts:71`) — label-anchored field extraction.
- `redFlagLogic.ts` three-outcome discipline (absent→silent / garble→WARNING / clean-but-invalid→ERROR).
- `findValueBox` + `FindingInput` bbox/page (`intraValidator.ts:4`) — highlight anchoring.

## Implementation tasks (from the review)

- **T1 (P1)** Business doc-type classifier — reuse `documentTypeId`; content-classify only
  null-type pages; priority-scored markers with min margin. `segment.ts`, `logic.ts`.
- **T2 (P1)** Label-anchored extractors for the 6 new fields. `redFlagLogic.ts`.
- **T3 (P1)** Token-set + initial-aware name matcher with relation-name exclusion. `redFlagLogic.ts`.
- **T4 (P1)** Doc-pair × field rule matrix + per-page attribution; fold into
  `redFlagValidator`; retire `crossDocMismatches`. `redFlagValidator.ts`, `intraValidator.ts`, `logic.ts`.
- **T5 (P1)** Shadow paths (placeholders, unclassifiable fallback, engine/chassis fuzzy). `redFlagLogic.ts`.
- **T6 (P2)** String-fixture unit tests per rule + multi-doc fixtures. `__tests__/redFlag.test.ts`.

## NOT in scope (deferred)

- Phase 2 date-comparison rules — see the sibling Phase 2 file.
- Phase 2 Exchange Declaration comparisons + highlight/resave/copyable-comment output.
- Config-driven (admin-editable) rule matrix — the natural Phase-2 trajectory once
  business-doc classification is proven reliable.
