# Claims Management Phase 2C — Validation Engine + Validators Design

**Status:** Draft for review
**Date:** 2026-05-31
**Author:** Aditya Kumar (with Claude)
**Scope:** An in-process validation engine that runs five real validators over a claim's documents and drives the five status columns through `PENDING → IN_PROGRESS → PASSED/FAILED`. Merges the originally-separate 2C (engine) and 2D (validators) at the user's direction.

---

## 0. Executive Summary

Phase 1 created five placeholder validation columns on `Claim` (`spellCheckStatus`, `qrStatus`, `metaExtractionStatus`, `intraClaimStatus`, `fullScanStatus`), all hard-coded `PENDING`. Phase 2B made documents real. Phase 2C builds the engine that **actually computes** those five statuses:

- A pluggable **`Validator`** interface + ordered **registry** of five real validators.
- An in-process, **DB-backed serial queue** (`ValidationRun`) with a singleton drainer — so auto-triggered bulk validation runs one-at-a-time without thrashing the single-threaded server.
- Results persisted to a **`ValidationResult`** table (per run × validator, with detail), and the latest status mirrored onto the five `Claim` columns (the badges).
- **Auto** trigger after document ingestion (scan / sync / upload) **and** a **manual** re-validate action.

### Decisions locked during brainstorming (2026-05-31)

| Topic | Decision |
|-------|----------|
| Scope | Engine **+ all five real validators** in one cycle. |
| Execution | **In-process** `ValidationRun` jobs (like 2A's `ScanJob`) — no Redis/worker process. A module-singleton **serial drainer** processes QUEUED runs one at a time. |
| Trigger | **Both** — auto after ingestion (scan/sync/upload) **and** a manual "Validate / Re-validate" button. |
| Libraries | Pure-JS / WASM only (no native builds — Windows-prod / macOS-dev): `tesseract.js`, `pdf-parse`, `jimp`, `jsqr`, `nspell`, `dictionary-en`. |
| Pass/fail rules | v1 rules defined per validator in §4 (approved in design review). |

### Out of scope (Phase 2C boundary)

- No PDF **rendering** for OCR — `pdf-parse` extracts *embedded* text only; image documents go through OCR. (Scanned image-only PDFs won't OCR in v1.)
- No structured field extraction (named entities, addresses, ID parsing) — META stores raw OCR text; INTRA does a token-presence check, not field-matching.
- No separate worker process / Redis — bulk auto-validation runs serially in-process (documented scalability limit; worker-process upgrade is the future path).
- No per-page results, no watermark/hologram/signature detection, no Excel-rules engine (2E), no reports (2F).
- No human review/override workflow for results.

---

## 1. Architecture

```
server/src/
├── validators/
│   ├── types.ts             (Validator interface, ValidatorContext, ValidatorOutcome)
│   ├── metaValidator.ts      (OCR images via tesseract.js + pdf-parse; stashes text in ctx.shared)
│   ├── spellValidator.ts     (nspell over ctx.shared text; ratio threshold)
│   ├── qrValidator.ts        (jimp + jsqr over image docs)
│   ├── intraValidator.ts     (claimId presence across ctx.shared text)
│   ├── fullValidator.ts      (document-type completeness; DB only)
│   ├── registry.ts           (ordered list: META, SPELL, INTRA, QR, FULL)
│   └── logic.ts              (PURE decision helpers: spellOutcome, completenessOutcome, etc.)
├── services/
│   ├── validationService.ts  (enqueue / runOne / sweepStaleRuns)
│   └── validationQueue.ts    (module-singleton serial drainer: kickDrain(prisma))
├── routes/
│   └── claimValidation.ts    (POST /validate, GET /validation, GET /validation/:runId)
├── lib/ocr.ts                (thin tesseract.js wrapper — injectable for tests)
└── (modify) scanService.ts, claimDocuments.ts, index.ts, routes/claims.ts

client/src/pages/claims/ClaimUpdate.tsx (modify — live badges + Validate button + result detail)
```

The engine is **decoupled** from the validators via the `Validator` interface; validators are decoupled from heavy I/O via injectable adapters (`lib/ocr.ts`, the `FileSystemPort` from 2B) so the **decision logic is unit-testable without running OCR**.

---

## 2. Data model (Prisma — `npm run db:push`)

```prisma
enum ValidationRunStatus { QUEUED  RUNNING  COMPLETED  FAILED }
enum ValidationTrigger   { AUTO  MANUAL }

model ValidationRun {
  id          String              @id @default(uuid()) @db.VarChar(36)
  claimId     String              @map("claim_id") @db.VarChar(36)
  status      ValidationRunStatus @default(QUEUED)
  trigger     ValidationTrigger
  startedAt   DateTime?           @map("started_at")
  finishedAt  DateTime?           @map("finished_at")
  createdAt   DateTime            @default(now()) @map("created_at")
  triggeredBy String?             @map("triggered_by") @db.VarChar(36)
  message     String?             @db.VarChar(500)

  claim   Claim              @relation(fields: [claimId], references: [id], onDelete: Cascade)
  results ValidationResult[]

  @@index([claimId])
  @@index([status])
  @@map("validation_runs")
}

model ValidationResult {
  id           String           @id @default(uuid()) @db.VarChar(36)
  runId        String           @map("run_id") @db.VarChar(36)
  claimId      String           @map("claim_id") @db.VarChar(36)
  validatorKey String           @map("validator_key") @db.VarChar(20) // META|SPELL|QR|INTRA|FULL
  status       ValidationStatus
  summary      String?          @db.VarChar(500)
  details      Json?
  createdAt    DateTime         @default(now()) @map("created_at")

  run   ValidationRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  claim Claim         @relation(fields: [claimId], references: [id], onDelete: Cascade)

  @@index([claimId])
  @@index([runId])
  @@map("validation_results")
}
```
+ `validationRuns ValidationRun[]` and `validationResults ValidationResult[]` on `Claim`. The five `Claim` columns reuse the existing `ValidationStatus` enum and hold the **latest** per-validator status.

---

## 3. Validator interface + context

```ts
// validators/types.ts
export type ValidatorKey = 'META' | 'SPELL' | 'QR' | 'INTRA' | 'FULL';
export type ClaimColumn =
  | 'metaExtractionStatus' | 'spellCheckStatus' | 'qrStatus' | 'intraClaimStatus' | 'fullScanStatus';

export interface ValidatorOutcome {
  status: 'PASSED' | 'FAILED';
  summary: string;
  details?: unknown;
}

export interface ValidatorContext {
  claim: { id: string; claimId: string; subCategoryId: string };
  documents: { id: string; fileName: string; storagePath: string; mimeType: string | null }[];
  prisma: PrismaClient;
  fsPort: FileSystemPort;     // from 2B — read files (with CLAIMS_SCAN_ROOT remap for SCANNED)
  ocr: OcrPort;               // lib/ocr.ts wrapper (injectable)
  shared: Map<string, string>; // documentId → extracted text (META fills; SPELL/INTRA read)
}

export interface Validator {
  key: ValidatorKey;
  column: ClaimColumn;
  run(ctx: ValidatorContext): Promise<ValidatorOutcome>;
}
```
Registry order (dependency-driven): **META → SPELL → INTRA → QR → FULL**.

---

## 4. The five validators (v1 rules)

**META — `metaExtractionStatus`** (tesseract.js + pdf-parse)
For each document: images (`image/*`) → `ocr.extract(absolutePath)`; PDFs → `pdf-parse` embedded text; others → skipped. Store text in `ctx.shared[documentId]`. **PASS** if text (≥ a few non-whitespace chars) extracted from ≥1 document; **FAIL** if there are documents but none yielded text. `summary`: "Extracted text from N of M documents."

**SPELL — `spellCheckStatus`** (nspell + dictionary-en)
Tokenize all of META's text (`ctx.shared`), lowercase, words `[a-z]{3,}`. Misspelled = not in dictionary. `ratio = misspelled / totalWords`. **PASS** if `totalWords === 0` (nothing to check, N/A) or `ratio ≤ 0.20`; else **FAIL**. `details`: up to 50 suspect words; `summary`: "X% suspect (N words)."

**INTRA — `intraClaimStatus`** (uses META text)
Normalize the claim's `claimId` and each document's text (alphanumeric, lowercase). **PASS** if the normalized `claimId` appears in ≥1 document's text (cross-document consistency anchor) **or** there is no text (N/A); else **FAIL**. `summary`: "Claim ID found in K of M documents."

**QR — `qrStatus`** (jimp + jsqr)
For each `image/*` document: decode pixels via `jimp`, run `jsqr`. **PASS** if ≥1 QR decoded, **or** if there are **no** image documents (N/A); **FAIL** if image documents exist but none contained a decodable QR. `details`: decoded values; `summary`: "K QR code(s) found across N images."

**FULL — `fullScanStatus`** (DB only, no OCR)
Load the SubCategory's ACTIVE `DocumentTypeMaster`s and the claim's documents (with `documentTypeId`). **PASS** if every active doc type has ≥1 document of that type; **FAIL** if any required type has none. `details`: missing type names; `summary`: "P of R required document types present."

Each validator that throws is caught by the engine → that column set `FAILED`, a `ValidationResult` recorded with the error, run continues.

---

## 5. Engine + serial drainer

- **`ValidationService.enqueue(claimId, trigger, triggeredBy?)`** → insert `ValidationRun` (`QUEUED`); if a `QUEUED`/`RUNNING` run already exists for the claim, return it (coalesce — don't stack). Then `kickDrain(prisma)`.
- **`validationQueue.kickDrain(prisma)`** (module singleton): if a drain loop is already running, no-op. Else start one: repeatedly pick the oldest `QUEUED` run, `await validationService.runOne(runId)`, until none remain; then stop. This bounds OCR to **one run at a time** process-wide, regardless of how many the scan enqueues.
- **`runOne(runId)`**: set `RUNNING` + `startedAt`; set the claim's five columns to `IN_PROGRESS`; build `ValidatorContext` (load claim + documents); for each validator in registry order: run it (try/catch), upsert its `ValidationResult` for this run, set its `Claim` column to the outcome; after all, set the run `COMPLETED` + `finishedAt`. A fatal error → run `FAILED` + `message`; columns left at their last value.
- **Boot** (`index.ts`): `sweepStaleRuns()` flips orphaned `RUNNING` runs → `FAILED` ("interrupted by restart"), then `kickDrain(prisma)` resumes any `QUEUED` runs left over from before the restart.

## 6. Triggers

- **Auto** — after a claim's documents are ingested: `scanService` (per claim, after `discoverForClaim`), the `/documents` upload route, and the `/documents/sync` route each call `validationService.enqueue(claimId, 'AUTO')`. The scan enqueues many QUEUED runs; the serial drainer works through them one at a time. ⚠️ **Scalability limit:** a large bulk scan implies a long serial OCR backlog on the single server — acceptable for v1; the documented upgrade is a dedicated worker process.
- **Manual** — `POST /api/claims/:id/validate` enqueues `MANUAL` (re-validate). `canEditClaim`-gated.

## 7. API (under `/api/claims/:id`, scoped)

```
POST /api/claims/:id/validate            → 202 { runId }            (canEditClaim)
GET  /api/claims/:id/validation          → { run, results[] } latest run (view scope)
GET  /api/claims/:id/validation/:runId   → { run, results[] }       (view scope)
```
The claim `getById` already returns the five columns; the validation endpoints add per-validator detail + run status.

## 8. UI (`ClaimUpdate.tsx`)

The five badges become **live** — colored by status (`PASSED` green, `FAILED` red, `IN_PROGRESS` amber/spinner, `PENDING` grey) and each shows the latest `summary` on hover/below. A **Validate / Re-validate** button (canEdit) posts `/validate` and polls `GET /validation` (~1.5 s) until the run is `COMPLETED`/`FAILED`, refreshing badges + summaries live. An expandable detail per validator shows `details` (suspect words, decoded QR values, missing doc types).

## 9. New dependencies (all pure-JS / WASM)

`tesseract.js`, `pdf-parse`, `jimp`, `jsqr`, `nspell`, `dictionary-en` (+ `@types/*` where needed; several ship their own types).

## 10. Testing

- **Pure logic** (`validators/logic.ts`) — `spellOutcome(ratio)`, `completenessOutcome(present, required)`, `qrOutcome(found, imageCount)`, `intraOutcome(found, textCount)`, `metaOutcome(extracted, docCount)` unit-tested directly (fast, no deps).
- **Engine** (`validationService` + drainer) — fake validators (deterministic) + self-contained fixtures: asserts lifecycle (columns IN_PROGRESS→result), `ValidationResult` rows, run COMPLETED, coalescing, serial drain (enqueue 3 → all processed once), `sweepStaleRuns`. macOS-runnable, no heavy deps.
- **Validator adapters** (slower, real, tiny fixtures, runnable on macOS): QR via a generated QR png (jimp+jsqr), SPELL on a known string, FULL/INTRA deterministic. META/OCR gets one minimal smoke test (a high-contrast text png) — tagged so it can be skipped in fast runs if tesseract.js download/runtime is an issue in CI.
- **Type-check** — `npx tsc --noEmit` both workspaces (the static gate; lint isn't wired here).
- **Manual** — scan/upload a claim with a text image + a QR image + the required doc types → watch badges go IN_PROGRESS then PASSED/FAILED with summaries.

## 11. Open items for the implementation plan

- Spell-check misspelled-word threshold (start 20%) and the dictionary package's exact API (`nspell` + `dictionary-en` async load).
- tesseract.js worker lifecycle (create/terminate per run vs reuse) and language data caching location.
- Whether AUTO validation should be gated by a setting/flag to disable the bulk-scan backlog in environments that don't want it (lean: add a `VALIDATION_AUTORUN` env, default on).
- Exact `jimp` + `jsqr` bit-depth/format handling for non-PNG images.

These are settled during plan-writing without changing the design.
