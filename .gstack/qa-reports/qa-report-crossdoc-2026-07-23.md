# QA Report — Cross-Document Field Comparison (backend logic)

Date: 2026-07-23 · Branch: feat/claim-crossdoc-field-comparison · Mode: fixture pressure test
(No browser QA: feature is server-side validation logic with no standalone UI; surfaces as
redFlagStatus findings only after a real claim scan. Pressure-tested the pure engine instead.)

## Result: 12 scenarios, 11 passed on first run, 1 false-positive found + fixed.

### Passing
- Happy paths: consistent claim; name variance (RAJESH KUMAR/RAJESH K/R KUMAR) no-flag;
  OCR chassis O-vs-0 no-flag; new-car insurance APPLIED-FOR no vehicle-no flag; staff+payslip clean.
- True positives (ERROR): name mismatch, chassis mismatch, emp-code mismatch.
- Bundled PDF (one documentId, invoice page vs RC page) correctly compares across page types.
- Unclassifiable page → WARNING + type-blind fallback + CROSS_UNCLASSIFIED. DMS classified. Shared-surname-different-people → ERROR.

### ISSUE-001 (fixed) — Relation/nominee KYC name false-flagged as hard red flag
- Symptom: a KYC doc whose own name is a relative's (e.g. father "MOHAN KUMAR") fired
  CROSS_NAME_MISMATCH ERROR against the invoice customer.
- Fix: KYC-involved NAME disagreements downgrade to WARNING; agreement across
  Invoice/RC/Insurance/Payslip/Staff-ID/DMS stays hard ERROR. (crossDocLogic.ts)
- Decision: user-approved (downgrade to WARNING).
- Verified: A1 → WARNING; T1/A2/A5 still ERROR; tsc clean; 21/21 cross-doc unit tests pass.

## Ship-readiness: GREEN for the logic. Real end-to-end (app + uploaded claim bundle) still
recommended before production, to validate classifier marker quality on genuine OCR output.
