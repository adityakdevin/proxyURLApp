# Claims — "Failed Proof" + Document Highlighting

- **Date:** 2026-07-02
- **Status:** Proposed — awaiting Puneet/Vikas sign-off (no code written yet)
- **Scope decided with product:** full file + page + pixel-highlight fidelity, **all five checks**, an in-app document viewer **with highlight overlays**, **and** upgrading the Meta and Intra detectors so the proof reflects real fraud signals.
- **Builds on branch:** `feat/docs-not-available-status` (or a new feature branch off it).

---

## 1. Motivation

When a claim's validation check **FAILS**, the reviewer currently sees only a coarse badge
(`Spell: FAILED`) and a one-line summary (`"67% suspect (8/12 words)."`). There is no way to
see **which document** failed, **which page**, or **where on the page** the problem is. For a
fraud-screening tool, "proof" — the ability to open the offending document and see the exact
flagged region — is the difference between a signal a reviewer trusts and one they ignore.

**Goal:** on a failed check, show the failing file name + path, a page reference, and open the
document in-app with the offending area highlighted.

---

## 2. Current-state findings (why this is a real build, not a UI tweak)

A code investigation (all five detectors + result storage + document serving + the UI)
confirmed the evidence needed for highlighting is **not captured today**:

| Check | Evidence on FAILURE today | File? | Page? | Coords? |
|---|---|:--:|:--:|:--:|
| **Spell** | `details.suspect` = ≤50 offending **word strings** (no positions); all docs' text is **concatenated** before tokenizing | ❌ | ❌ | ❌ |
| **QR** | **nothing** — FAILED branch sets no details; `jsQR.location` corners discarded; images only | ❌ | ❌ | ❌ |
| **Meta** | **nothing** — and it is misnamed: it only OCRs/extracts text, it does **not** read EXIF/producer/"Gemini AI" | ❌ | ❌ | ❌ |
| **Intra** | **nothing** — only checks if the Claim ID substring appears in each doc; does **not** cross-check VIN/name/dates | ❌ | ❌ | ❌ |
| **Full** | `details.missing` = missing document-**type names** | ❌ | ❌ | ❌ |

Three hard blockers:
1. `ValidationResult` has **no `documentId`** — a result links only to the claim/run.
2. Validators concatenate all document text, so a finding can't be traced to a file.
3. No page tracking and no coordinates anywhere; OCR word-boxes and QR locations are thrown away.

**What already works:** a document-serving endpoint exists —
`GET /api/claims/:id/documents/:docId/content` (streams inline for PDF/image, auth+scope gated) —
so *viewing* a document in-browser is feasible; there is just no viewer component yet.

---

## 3. Implementation plan

> The section below is the synthesized technical plan. It resolves contradictions between the
> subsystem designs (see §3.6).

### 3.1 Architecture overview

The upgrade rests on three pillars: **(a)** a structured per-document extraction cache
(`ctx.shared: Map<string, ExtractedDoc>` with pages, word boxes, and file metadata) produced
once per run and shared by all five validators; **(b)** a new `ValidationFinding` row-per-occurrence
table FK'd to `Document`, carrying page + a **normalized `[0..1]` bbox**, so the viewer can query
"all evidence for this doc/page" without inflating a JSON column; and **(c)** an in-app viewer that
streams raw bytes from the existing `/content` endpoint and overlays absolutely-positioned,
normalized-coordinate highlight boxes on `<img>` (images) and `react-pdf` (PDFs). Normalized
coordinates are the load-bearing contract: they decouple stored evidence from render zoom/DPR/scale
so the overlay is pure CSS `%` math. The work is phased to retire the hardest risk — coordinate
correctness — on the easy medium (images) before PDFs, while every phase ships a visible increment.
`ValidationResult.details` stays as a backward-compatible summary layer during migration.

### 3.2 Data model (concrete Prisma)

Additive-only (`prisma db push`, per project convention — no migrations dir, MySQL@3307; ensure
InnoDB/DYNAMIC row format on the Windows box before push).

```prisma
enum FindingSeverity { INFO WARNING ERROR }

model ValidationFinding {
  id           String   @id @default(uuid()) @db.VarChar(36)
  resultId     String   @map("result_id")     @db.VarChar(36)
  claimId      String   @map("claim_id")       @db.VarChar(36) // denormalized for cheap filtering
  validatorKey String   @map("validator_key")  @db.VarChar(20)
  documentId   String?  @map("document_id")    @db.VarChar(36) // null = claim-level (FULL missing-type)
  code         String   @db.VarChar(40)  // SPELL_SUSPECT | QR_DECODED | META_AI_ORIGIN | META_NO_TEXT | INTRA_FIELD_MISMATCH | INTRA_CLAIMID_MISSING | FULL_MISSING_TYPE
  severity     FindingSeverity @default(WARNING)
  message      String   @db.VarChar(500)
  page         Int?     // 1-based; null = whole-file / claim-level
  bbox         Json?    // {x,y,w,h} normalized 0..1, top-left origin; null = no pixel anchor
  data         Json?    // small extras (<1KB): decoded value, {field,expected,actual}, EXIF map, {conf}
  createdAt    DateTime @default(now()) @map("created_at")

  result   ValidationResult @relation(fields: [resultId], references: [id], onDelete: Cascade)
  document Document?        @relation(fields: [documentId], references: [id], onDelete: SetNull)

  @@index([resultId])
  @@index([claimId])
  @@index([documentId, page])
  @@map("validation_findings")
}
```

Back-relations only on existing tables (no new columns → push is additive):
- `ValidationResult`: `findings ValidationFinding[]`
- `Document`: `findings ValidationFinding[]`

In-memory extraction cache (`server/src/validators/types.ts`) — `shared` changes from
`Map<string,string>` to `Map<string, ExtractedDoc>`:

```ts
export interface BBox { x: number; y: number; w: number; h: number; }         // normalized 0..1, top-left
export interface ExtractedWord { text: string; page: number; bbox: BBox; conf?: number; }
export interface ExtractedPage { page: number; width: number; height: number; rotation: number; text: string; words: ExtractedWord[]; }
export interface FileMeta { software?: string; make?: string; model?: string; createDate?: string; modifyDate?: string; hasCameraData: boolean; aiSignals: string[]; }
export interface ExtractedDoc {
  documentId: string;
  text: string;              // full concatenated text — keeps current SPELL/INTRA working during migration
  pages: ExtractedPage[];
  fileMeta?: FileMeta;
}

export interface FindingInput {
  documentId?: string | null;
  code: string;
  severity?: 'INFO' | 'WARNING' | 'ERROR';
  message: string;
  page?: number | null;
  bbox?: BBox | null;
  data?: Record<string, unknown>;
}
export interface ValidatorOutcome {
  status: 'PASSED' | 'FAILED';
  summary: string;
  details?: unknown;         // KEEP for back-compat
  findings?: FindingInput[]; // NEW
}
```

Extraction port replaces the text-only `OcrPort`:

```ts
export interface ExtractionPort {
  extractImage(absolutePath: string, documentId: string): Promise<ExtractedDoc>;
  extractPdf(absolutePath: string, documentId: string): Promise<ExtractedDoc>;
  close?(): Promise<void>;
}
```

Persistence (`validationService.ts` commit txn, currently `:111-123`): after each
`tx.validationResult.create(...)` capture the returned `id`, then
`tx.validationFinding.createMany({ data: r.findings.map(...) })`, capping rows per result (≤200)
to bound payload/latency. Same `$transaction` → all-or-nothing with the COMPLETED commit; the
zero-docs and sweep paths are untouched.

### 3.3 Phased roadmap

Ordering rationale: Phase 1 de-risks schema + plumbing + API + UI contract with zero hard
extraction. Phases 2→3 retire the top risk (coordinate correctness) on images first (precise,
cheap) then PDFs (bottom-left origin + rotation). Phase 4 is detector value-add that rides the
same rails and parallelizes with 2/3. Phase 5 hardens.

#### Phase 1 — Evidence model + per-document attribution (no coordinates) — 2–3 days
- **Goal:** every finding names its source document; UI lists findings grouped per document with an "Open" link to `/content`.
- **Files:** `schema.prisma` (add `ValidationFinding` + enum + back-relations, `db push`); `validators/types.ts` (`shared` → `Map<string,ExtractedDoc>`, add `FindingInput`, `findings` on outcome); `metaValidator.ts` (build `ExtractedDoc` with `text`+empty `pages`, populate `shared`); `spellValidator.ts` (tokenize **per document** instead of the concatenated join at `:35` so each suspect carries `documentId`); `qrValidator.ts`/`intraValidator.ts`/`fullValidator.ts` (emit doc-attributed findings, `bbox=null`); `validationService.ts` (persist findings in txn); `routes/claimValidation.ts` (`include: { findings: true }`); `client/pages/claims/ClaimUpdate.tsx` (extend `ValResult` at `:78-82`, render findings grouped by doc under summary at `:423-435`).
- **Exit:** `GET /claims/:id/validation` returns per-result `findings[]` with `documentId`; UI shows per-doc grouped findings with counts + link; `tsc --noEmit` clean; supertest asserts rows created.

#### Phase 2 — Image coordinates + image viewer with pixel highlights — 3–4 days (no new deps)
- **Goal:** OCR word boxes + QR corners captured and normalized; in-app modal draws highlight rectangles on images.
- **Files:** `lib/ocr.ts` → image extractor: `worker.recognize(path, {}, { blocks: true })`, walk `data.blocks[].paragraphs[].lines[].words[]` (`.text`, `.bbox{x0,y0,x1,y1}`, `.confidence`), normalize by image bitmap dims (reuse Jimp), populate `ExtractedPage.words`; `qrValidator.ts` (keep `res.location` 4 corners → enclosing bbox normalized by `img.bitmap.{width,height}`, emit `QR_DECODED`); `spellValidator.ts`/`intraValidator.ts` (map matched tokens → word bbox); `logic.ts` (bbox normalization helpers, `findClaimIdSpan`). Client: new `client/src/components/claims/viewer/` — `DocumentViewerModal` (Radix Dialog), `DocumentCanvas`, `ImageCanvas` (`<img onLoad>` → naturalW/H), `HighlightOverlay` (absolute divs, `left = bbox.x*renderW` …), `FindingRail`; `useDocumentViewer` hook; wire drill-down into `ClaimUpdate.tsx` (badges `:402-410`, summary `:423-435`, doc list `:565-572`).
- **Exit:** clicking a finding opens the viewer at the right image with a correctly-placed box; QR/SPELL on images show pixel highlights; overlay tracks zoom/resize via `ResizeObserver`.

#### Phase 3 — PDF coordinates + PDF viewer — 4–6 days (deps: `pdfjs-dist`, `react-pdf`)
- **Goal:** per-page PDF text with coordinates; PDF viewer overlays highlights on the correct page.
- **Files:** new `lib/pdfExtractor.ts` (dynamic `import('pdfjs-dist/legacy/build/pdf.mjs')`, worker disabled; per page `getViewport({scale:1})` + `getTextContent()`; convert user-space bottom-left → top-left normalized, honor `viewport.rotation`); new `lib/extractionPort.ts` (dispatch image vs pdf on mime); `metaValidator.ts` (use it; keep `pdf-parse` as text-only fallback; emit `META_NO_TEXT` for image-only PDFs); `validationService.ts` (construct composed `ExtractionPort` at `:62`, same lifecycle). Client: `PdfCanvas` (react-pdf `<Document file={{url, withCredentials:true}}>` + `<Page>`, capture rendered size in `onRenderSuccess`, gate overlay on size), `pdfWorker.ts` (`?url` + `.mjs` worker, `React.lazy` the PDF canvas).
- **Exit:** SPELL/INTRA/QR-context findings on PDFs highlight on the right page including a rotated-page fixture; scanned image-only PDFs degrade to `META_NO_TEXT` (no crash).

#### Phase 4 — Meta upgrade (real metadata + AI-origin) & Intra cross-document matching — 4–5 days (deps: `exifr`, `chrono-node`)
- **Goal:** META reports EXIF/software/C2PA + AI-origin signals; INTRA cross-compares VIN/name/date across documents with per-field evidence.
- **Files:** new `lib/fileMeta.ts` (`exifr` → `FileMeta`; AI heuristic: `software`/`producer`/`creatorTool` matches `/gemini|dall[- ]?e|midjourney|stable ?diffusion|firefly|openai|chatgpt|ideogram/i`, OR `image/jpeg` with no `make`/`model` → `META_AI_ORIGIN` **WARNING, advisory, never auto-FAIL**); `metaValidator.ts` (populate `fileMeta`, emit findings); `intraValidator.ts`+`logic.ts` (extract VIN `\b[A-HJ-NPR-Z0-9]{17}\b`, dates via `chrono-node`→ISO, label-anchored names; cross-doc compare; emit `INTRA_FIELD_MISMATCH` ERROR with matched-token bbox + `{field,expected,actual,conf}`).
- **Exit:** planted AI-origin sample + planted VIN-mismatch sample both surface findings; detector unit tests green.
- **Parallelizable** with Phases 2–3 (rides Phase-1 rails; bboxes need Phase 2/3 word coords).

#### Phase 5 — Hardening — 2–3 days
- **Goal:** bounded latency/payload, robust on missing/huge files.
- **Files:** `validationService.ts` (per-doc timeout around extraction; skip OCR on files > N MB / > P pages → `META_NO_TEXT`; verify `sweepStaleRuns` recovery at `:163`); enforce ≤200 findings/result cap; SCANNED path fixtures via `CLAIMS_SCAN_ROOT`.
- **Exit:** 50-file / multi-page-PDF claim completes within budget; missing scan-root degrades gracefully to a 404 "unavailable" state in the viewer.

### 3.4 New dependencies

| Dep | Where | Phase | Rationale |
|---|---|---|---|
| `pdfjs-dist` | server + client | 3 | Per-page PDF text **with coordinates** (transforms/viewport); `pdf-parse` yields no positions. Same family drives client rendering. Use `legacy/build/pdf.mjs` in Node, worker disabled. |
| `react-pdf` | client | 3 | React wrapper for browser PDF page rendering to layer the overlay; avoids a native `canvas` dep. Pin to react-pdf's expected `pdfjs-dist` major; worker via `?url` + `.mjs`. |
| `exifr` | server | 4 | EXIF/XMP/PDF-producer/C2PA metadata + AI-origin signals; pure-JS (no Perl/native binary — safe for the Windows scan-root deploy). |
| `chrono-node` | server | 4 | Robust date parsing for INTRA cross-document date comparison. |

No new dep for image bboxes (`tesseract.js` already present — only the `{blocks:true}` opt-in changes)
or QR (`jsqr` already returns `.location`). **No server-side rasterizer / native `canvas` / `sharp`** —
rendering is client-side, server extraction is text+coordinate only. (`sharp`-based ELA tamper detection
is explicitly deferred — heavy native build on the Windows box.)

### 3.5 Top 5 risks + mitigations

1. **PDF coordinate correctness** (bottom-left origin, page `/Rotate`, non-zero MediaBox). → Derive normalized coords from `getViewport` transform (not hand-rolled math); store `rotation` per page; dedicated rotated/offset fixtures; bake the Y-flip into the producer, not the client.
2. **OCR/PDF word-box accuracy & cost.** Word-level output is heavier and can be low-confidence. → Reuse the single per-run worker (already the pattern); store `conf`; only overlay high-confidence boxes; always keep the doc-attributed finding even when bbox is dropped (graceful degrade to Phase-1 behavior); per-doc timeout + page/size caps (Phase 5).
3. **MySQL payload / row volume.** Noisy OCR pages → hundreds of suspects. → Row-per-finding table (not fat JSON), ≤200 findings/result cap surfaced as "showing 200 of N", tiny `bbox`/`data` payloads, `details` kept to summary counts only.
4. **AI-origin false positives** ("no camera EXIF" fires on legit scrubbed scans/screenshots). → `WARNING` severity, advisory only — **never auto-FAIL META**; store a confidence in `data`; policy gate is a Puneet/Vikas decision.
5. **SCANNED paths + `db push` on Windows MySQL 5.7.** Windows `D:\Claims\...` unreachable in dev/CI; MyISAM 2144-byte key limit. → Extraction reads `readablePath` (scan-root remapped) and tolerates missing files; viewer reuses the confined `/content` endpoint (404 → "unavailable"); ensure `default_storage_engine=InnoDB` + `innodb_default_row_format=DYNAMIC` before pushing the new VarChar-key table.

### 3.6 Contradictions resolved (from merging the six subsystem designs)

- **Storage:** new `ValidationFinding` table (not `details` JSON) — needed for per-document joins, indexed viewer queries, referential integrity, and to sidestep MySQL JSON size on 50-file claims. `details` retained short-term for back-compat, deprecated later.
- **Table name:** `ValidationFinding`.
- **bbox:** single `bbox Json?` `{x,y,w,h}` (we never filter by bbox); `page` is a separate indexed `Int?` because we do query by it.
- **`documentId` onDelete:** `SetNull` — doc-delete triggers re-validation which produces fresh findings, so preserving historical run findings keeps the audit trail intact.
- **Page index:** 1-based.
- **Server-side pdfjs:** required in Phase 3 — no other installed lib gives glyph positions.
- **Enum design:** `severity` enum + free-form `code` string (extensible without schema pushes).

---

## 4. Phase 1 = do this first (exact starting changes)

No new deps, no hard extraction, unblocks everything else.

1. **`server/prisma/schema.prisma`** — add `FindingSeverity` enum + `ValidationFinding` model + the two back-relations. Run `npm run db:push` (confirm InnoDB/DYNAMIC first).
2. **`server/src/validators/types.ts`** — `shared: Map<string,string>` → `Map<string, ExtractedDoc>`; add `BBox`, `ExtractedDoc`/`ExtractedPage`/`ExtractedWord`/`FileMeta`, `FindingInput`; add `findings?: FindingInput[]` to `ValidatorOutcome`.
3. **`server/src/validators/metaValidator.ts`** — build an `ExtractedDoc` per doc (`text` as today, `pages: []`) and store in `ctx.shared`.
4. **`server/src/validators/spellValidator.ts`** — replace the concatenated `[...ctx.shared.values()].join(' ')` at `:35` with a per-document loop, so each suspect word emits `FindingInput{ documentId, code:'SPELL_SUSPECT', bbox:null }`. Keep `details.suspect` + ratio math for back-compat.
5. **`qrValidator.ts` / `intraValidator.ts` / `fullValidator.ts`** — emit doc-attributed findings with `bbox=null` (QR: `QR_DECODED` per image; INTRA: `INTRA_CLAIMID_MISSING`; FULL: `FULL_MISSING_TYPE` with `documentId:null`).
6. **`server/src/services/validationService.ts`** — in the commit `$transaction` (`:111-123`), capture the created result id and `tx.validationFinding.createMany(...)` mapping each finding (message sliced to 500, `bbox`/`data` → `Prisma.JsonNull` when absent).
7. **`server/src/routes/claimValidation.ts`** — add `include: { findings: true }` on both `/validation` and `/validation/:runId`.
8. **`client/src/pages/claims/ClaimUpdate.tsx`** — extend `ValResult` (`:78-82`) with `findings`; under each summary line (`:423-435`) render findings grouped by `documentId` with a per-doc count + an "Open" link to the existing `/content` URL (full modal/overlay in Phase 2).

Verify with `tsc --noEmit` (ESLint is broken repo-wide) and a supertest against `TEST_DATABASE_URL`
(**never** the dev DB — it truncates claim tables) asserting `ValidationFinding` rows are created and
surfaced by `GET /claims/:id/validation`.

---

## 5. Open questions for Puneet / Vikas

1. **AI-origin policy:** should `META_AI_ORIGIN` stay advisory (WARNING, never blocks a claim), or should it be allowed to FAIL the Meta check / gate progression? (Recommendation: advisory only — high false-positive risk on legit scans.)
2. **Scope confirmation:** is the full 5-phase build approved, or should we ship Phases 1–2 (per-doc attribution + image highlights) first and evaluate before committing to PDFs and detector upgrades?
3. **Intra field set:** which fields must cross-document matching cover — VIN, customer name, dates? Anything else (dealer code, policy number)?
4. **Finding cap:** is "showing 200 of N" acceptable for very noisy OCR pages, or do we need a different truncation/paging strategy?
