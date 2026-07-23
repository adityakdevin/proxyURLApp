# Phase 2 — Cross-Document Red-Flag Rules (NOT YET IMPLEMENTED)

Status: **deferred to Phase 2**. Captured 2026-07-23 from a requirements review.
These are date-comparison rules that span two documents. None exist in the code today.
Sibling: field-comparison rules live in [phase1-crossdoc-field-comparison.md](./phase1-crossdoc-field-comparison.md).

## What exists today (Phase 1)

The committed REDFLAG validator (`server/src/validators/redFlagLogic.ts`,
`redFlagValidator.ts`, commit `e4bc5d7`) does **single-document** work only:

- ID format checks: PAN, GST, DL, Udyam, Passport, Aadhaar, Voter ID
- Aadhaar / Voter ID consistency *within one file's pages*
- Editor / AI watermark detection (PDF Producer/Creator)
- `checkDates()` — flags **calendar-impossible** dates (e.g. 31/02) only

The `INTRA` validator (`intraValidator.ts`) does cross-document work but only
**Claim-ID presence matching** — no dates.

**Date compare status:** parsing exists (`checkDates` parses `dd/mm/yy(yy)` +
normalizes 2-digit years), but there is NO date *comparison* anywhere — no
`getTime`/`isBefore`/`isAfter`, no building of a comparable Date. The primitive
is half-built; the comparison layer is missing.

## The rules to build (Phase 2)

| # | Source Doc 1 | Date 1 | Source Doc 2 | Date 2 | Red-flag condition |
|---|--------------|--------|--------------|--------|--------------------|
| 1 | Invoice | Invoice date | RC | RC Date | RC date **prior to** Invoice date |
| 2 | Invoice | Invoice date | Old car insurance | Period of insurance (start) | Insurance validity starts after (last day of invoice month + 21 days) |
| 3 | Invoice | Invoice date | KYC | Birth date | Customer **not adult** (< 18 yr) as of invoice date |
| 4 | Payslip | DOJ (Date of Joining) | Payslip | DOB (Date of Birth) | DOJ **less than** DOB |

Note rule 4 is intra-document (both dates on the Payslip), but still a
date-comparison rule not currently implemented.

## What to reuse when building

- `segment.ts` — per-page document classification (identifies Invoice / RC /
  KYC / Payslip pages). The hard part, already done.
- `labeledCandidate()` (`redFlagLogic.ts:71`) — label-anchored field extraction
  (`"Invoice Date: ..."`). Reusable to pull each labeled date.
- Date-parse block inside `checkDates` (`redFlagLogic.ts:224`) — lift into a
  `parseDate(): number | null` helper for comparisons.

## Gap to close

1. A labeled-date extractor per document type (invoice date, RC date, insurance
   period start, KYC DOB, payslip DOJ/DOB).
2. A cross-doc rule module that parses the dates and applies the 4 conditions.

Both are small on top of the existing classification + extraction primitives.
