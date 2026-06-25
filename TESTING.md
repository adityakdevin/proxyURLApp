# Manual Testing Guide — Claims & Document Scanning Module

This guide walks through manually testing the **Claims & Document Validation** feature
(claim creation, document upload, folder scanning, and the OCR validation pipeline) as
both an **Admin** and a **Team Lead**.

> Status: Phase 1 is merged to `main` (incl. the `fix/claims-phase1-hardening` pass, PR #11).
> Phase 2 (the OCR / validation pipeline) is partially in place and exercised below.

---

## 1. What the module does

```
Admin sets up masters → Claims created (manual or by folder scan)
   → Documents attached (uploaded OR discovered from a folder)
   → Auto-validation runs (OCR + 5 validators)
   → Team Lead / User work the claim: remarks, status changes, reassignment
   → Reaches a terminal status (Approved / Rejected) → locked
```

### The 5 validators (`server/src/validators/`, run in this order)

| Key   | Validator        | What it checks                                            |
|-------|------------------|----------------------------------------------------------|
| META  | `metaValidator`  | OCR text extraction (Tesseract) from images / PDFs       |
| SPELL | `spellValidator` | Spell-check on the extracted text                        |
| INTRA | `intraValidator` | Intra-claim consistency                                  |
| QR    | `qrValidator`    | QR-code validation                                       |
| FULL  | `fullValidator`  | Aggregates results + checks all **required** doc types present |

Results land on the `Claim` (`spellCheckStatus`, `qrStatus`, `metaExtractionStatus`,
`intraClaimStatus`, `fullScanStatus`) and in `ValidationRun` / `ValidationResult` rows.
Validation runs **async** on a serial queue and is auto-triggered on every document
upload, sync, and delete.

### Roles & permissions (`enum Role`: USER, TEAM_LEAD, ADMIN)

| Action                          | USER                  | TEAM_LEAD              | ADMIN |
|---------------------------------|-----------------------|-----------------------|-------|
| View claims                     | own scope, if assignee| own scope (UType+PType)| all  |
| Create claim                    | ❌                    | ✅ (in scope)         | ✅    |
| Add remark / change status      | ✅ if assignee        | ✅ in scope           | ✅    |
| Reassign claim                  | ❌                    | ✅                    | ✅    |
| Exit a **terminal** status      | ❌                    | ❌                    | ✅ only|
| Upload / sync / delete docs     | ✅ if assignee        | ✅ in scope           | ✅    |
| Trigger a **folder scan job**   | ❌                    | ❌                    | ✅ only|
| Soft-delete / restore claim     | ❌                    | ❌                    | ✅ only|

**Scope:** every non-admin user has exactly one `(UserType, ProjectType)` assignment and
can only see/act on claims under that pair. Admin is unrestricted.

### Where things live (routes)

- **Admin UI:** `/admin/claims`, `/admin/claim-id-rules`, `/admin/status-masters`,
  `/admin/doc-type-masters`, `/admin/claim-rules`, `/admin/scans`
- **Team Lead / User UI:** `/claims` (dashboard) and `/claims/:id` (shared detail page)

---

## 2. Setup gotchas — read before testing

1. **The DB is PostgreSQL, not MySQL.** Despite `CLAUDE.md` / `.env.example` mentioning
   MySQL, the live `.env` uses `postgresql://...@127.0.0.1:5432/proxyapp_db`. Make sure
   **Postgres** is running and the `proxyapp_db` database exists.

2. **A fresh seed creates ZERO sample claims.** `seed.ts` only adds sample claim data
   *if an ACTIVE SubCategory already exists*. On a brand-new DB there is no
   UserType / ProjectType / Category / SubCategory, so the seed prints
   *"No active SubCategory found. Skipping..."*. You must **build the hierarchy in the
   admin UI first**, then **re-run the seed** (it is idempotent) to get the sample
   statuses, document types, scan rule, and claims.

3. **Folder scanning needs a macOS workaround.** Paths are stored Windows-style
   (`D:\Claims\Daily`) and `folderPath` must be a drive-letter path that is **not** `C:`.
   On macOS, set **`CLAIMS_SCAN_ROOT`** to a real local folder — the code strips the
   `D:\` prefix and re-roots scan/sync reads under it. Without it, folder scan/sync
   finds nothing.

### Extra `.env` entries for claims testing (add these)

```bash
# Claims module (not in .env.example yet)
CLAIMS_SCAN_ROOT=./dev-scan        # local stand-in for the Windows scan drive
OCR_CACHE_DIR=./.ocr-cache         # Tesseract language-data cache (first run downloads)
UPLOADS_ROOT=./uploads             # where uploaded documents are stored
```

> Use absolute paths if you run the server from a different working directory.

---

## 3. First-time setup (fresh environment)

```bash
# Ensure Postgres is running and proxyapp_db exists, then from the repo root:
npm install
npm run db:generate
npm run db:push        # NOT db:migrate — schema is managed with `prisma db push`
npm run db:seed        # creates the admin user (sample claims skipped for now — see §2.2)
npm run dev            # server on :3001, client on :5173
```

**Admin login:** `admin` / `Admin123!` → you will be **forced to change the password**
on first login (≥8 chars, with uppercase, lowercase, and a number).

---

## 4. Test as ADMIN (end-to-end)

Log in as admin, go to `http://localhost:5173/admin`.

### A. Build the hierarchy (required before any claim can exist)
1. **User Types** → create one (e.g. `Insurance`).
2. **Project Types** → create one (e.g. `Health`).
3. **Categories** → create one scoped to that UserType + ProjectType.
4. **Sub Categories** → create one under that Category. ← this unblocks the seed.

### B. Generate sample claim data
Re-run the seed; it now finds your ACTIVE SubCategory:
```bash
npm run db:seed
```
This creates: statuses (`Pending` default / `Approved` terminal / `Rejected` terminal),
document types (`Aadhar Card`, `PAN Card`, `Bill`), a ClaimIdRule
(`D:\Claims\Daily`, startPosition=1, length=8, target=FOLDER), and claims
`CLM00001`, `CLM00002`. Refresh **Admin → Claims** to see them.

### C. Review master data
- **Status Masters** — one is `isDefault`, two are `isTerminal`.
- **Document Type Masters** — note which are `isRequired` (drives the FULL validator).
- **Claim ID Rules** — confirm the rule; `scanLocation` should be a `D:\...` path that
  maps under your `CLAIMS_SCAN_ROOT`.

### D. Document upload + validation (no folder needed)
1. Admin → Claims → open `CLM00001`.
2. In **Documents**, click **Upload**. Name files so they auto-classify by token:
   - filename containing **`aadhar`** → Aadhar Card
   - **`pan`** → PAN Card
   - **`bill`** → Bill
   Allowed extensions: `pdf, png, jpg, jpeg, gif, tif, tiff, txt, doc, docx, xls, xlsx`
   (max 25 MB/file, 50 files).
3. Watch the validation columns update (META → SPELL → INTRA → QR → FULL).
   **The first run is slow** — Tesseract downloads language data into `OCR_CACHE_DIR`.
4. Upload an **image of real text** to see META/SPELL produce meaningful output.
5. Open the **Validation runs** section to see the run (trigger=AUTO) and per-validator
   results.

### E. Folder SCAN job (admin only)
1. On disk, mirror the rule's `scanLocation` under `CLAIMS_SCAN_ROOT`. With
   `scanLocation = D:\Claims\Daily` and `CLAIMS_SCAN_ROOT=./dev-scan`:
   ```
   dev-scan/Claims/Daily/CLM00003/aadhar.png
   dev-scan/Claims/Daily/CLM00003/pan.pdf
   dev-scan/Claims/Daily/CLM00004/bill.jpg
   ```
   Rule is `target=FOLDER`, start=1, len=8 → each **folder name's** first 8 characters
   become the claimId, so name the folders `CLM00003`, `CLM00004`.
2. Trigger a scan for that rule (Admin → Claim ID Rules / Scans → run scan;
   `POST /admin/api/scans`).
3. Admin → **Scans** → watch the job: QUEUED → RUNNING → COMPLETED, with
   `createdCount`, `skippedCount`, `docsCreated`. Re-running skips existing claims
   (idempotent).
4. New claims `CLM00003` / `CLM00004` appear with **SCANNED** documents and
   auto-validation triggered.

### F. Admin-only powers
- Soft-delete a claim, then restore it.
- Move a claim **out of a terminal status** (e.g. Approved → Pending) — allowed for
  admin only; blocked for everyone else.

---

## 5. Test as TEAM_LEAD (end-to-end)

### A. Create the Team Lead account (as admin)
Admin → **Users** → New user → **role = TEAM_LEAD**, assign the **same UserType +
ProjectType** from §4.A (a TL is confined to that pair). Save.
*(Optionally also create a plain USER on the same pair, to test the assignee path.)*

### B. Log in as the Team Lead
Use a **separate browser / private window** (sessions are single-per-user, so logging in
elsewhere would kill the admin session). The TL lands on `/claims` with **no** `/admin`
access.

### C. Scope check
The TL sees **only** claims under their UserType + ProjectType. Confirm claims outside
that scope are not visible.

### D. Create a claim (TL can; USER cannot)
- Claims dashboard → **New Claim**. Pick the SubCategory and enter a claimId.
- `folderPath` is optional, but if set it **must** be a `D:\...` path (never `C:\`, no
  `..`). The UI enforces the `^[A-Za-z]:\\.+` pattern.

### E. Work the claim
- Open it → **upload documents** → validation runs (same as admin).
- **Sync**: if the claim has a `folderPath`, this discovers files from that folder (uses
  the `CLAIMS_SCAN_ROOT` mapping).
- **Add remark** with a **status change** (e.g. Pending → Approved). Confirm the TL then
  **cannot** move it out of the terminal status (admin-only).
- **Reassign** the claim to the USER → confirm a TL can reassign.

### F. Negative checks (prove the guards)
- As the plain **USER**: no "New Claim" button; cannot reassign; can only edit a claim
  they are the assignee of; cannot trigger scans.
- As **TEAM_LEAD**: no Scans / soft-delete / restore (all admin-only).

---

## 6. Troubleshooting cheatsheet

| Symptom | Likely cause / fix |
|---------|--------------------|
| Validation stuck on `IN_PROGRESS` | First OCR run downloads Tesseract data — wait; check server logs and that `OCR_CACHE_DIR` is writable |
| Folder scan / sync finds nothing | `CLAIMS_SCAN_ROOT` not set, or on-disk path doesn't mirror `scanLocation` minus the drive letter |
| `INVALID_FOLDER_PATH` error | Used a non-`X:\` path, or `C:\`, or one containing `..` — use `D:\...` |
| No claims after seeding | No ACTIVE SubCategory existed — create one (§4.A), then re-seed |
| Can't log in / forced to change password | Expected on first admin login (`forcePasswordChange`) |
| Inspect data directly | `npm run db:studio` → check `ScanJob`, `ValidationRun`, `ValidationResult`, `Document` |

---

## 7. Key source references

| Area | File |
|------|------|
| Data models | `server/prisma/schema.prisma` |
| Claim CRUD + permissions | `server/src/services/claimService.ts` |
| Document ingestion / classify | `server/src/services/documentService.ts`, `documentClassifier.ts` |
| Folder scan orchestration | `server/src/services/scanService.ts`, `lib/directoryReader.ts` |
| Validation pipeline | `server/src/services/validationService.ts`, `validationQueue.ts`, `validators/registry.ts` |
| OCR | `server/src/lib/ocr.ts` |
| Allowed upload types | `server/src/lib/mimeTypes.ts` |
| Claim routes | `server/src/routes/claims.ts`, `claimDocuments.ts`, `claimValidation.ts` |
| Admin routes | `server/src/routes/admin/claims.ts`, `admin/scans.ts` |
| Frontend | `client/src/pages/claims/`, `client/src/pages/admin/AdminClaims.tsx` |
| Seed | `server/prisma/seed.ts` |
