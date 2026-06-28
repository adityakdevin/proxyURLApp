# Claims Management Phase 2B — Document Association Design

**Status:** Draft for review
**Date:** 2026-05-31
**Author:** Aditya Kumar (with Claude)
**Scope:** Associate document files with claims — from disk discovery (claim folders) and from browser upload — auto-classified to a `DocumentTypeMaster`, listed and streamed on the Claim Update page. Second sub-project of Phase 2 (follows 2A scanner).

---

## 0. Executive Summary

Phase 1 left a "Documents" placeholder on the Claim Update page; Phase 2A ingests claims from folders and records each claim's `folderPath`. Phase 2B makes documents real: a unified `Document` entity with two sources —

- **SCANNED** — files found inside a claim's `folderPath` on the server's Windows drive (read-only reference, no copy).
- **UPLOADED** — files uploaded through the browser, stored in a per-claim uploads directory.

Each document is **auto-classified** to a `DocumentTypeMaster` by a filename-token match, listed on the Claim Update page, and **streamed** (inline preview / download) through an access-controlled endpoint.

### Decisions locked during brainstorming (2026-05-31)

| Topic | Decision |
|-------|----------|
| Document sources | **Both** — disk discovery *and* browser upload, unified in one `Document` model with a `source` enum. |
| Classification | **Auto by filename token** from existing master data (no new pattern field): GOVT → `govtCode` or `name`; CUSTOM → `name`. One match → assign; multiple → lowest `displayOrder`; none → untyped (`null`). |
| Upload storage | **Dedicated per-claim uploads dir**: `UPLOADS_ROOT/<claimId>/<sanitized-name>` (configurable via env). |
| Serving | **Authenticated stream** — inline preview (PDF/image) or download, gated by claim **view** scope, restricted to the document's recorded path (no traversal). Serves both sources. |
| Disk-discovery trigger | **Both** — the 2A "Scan now" ingests documents in bulk per claim, **and** a per-claim "Sync documents" action re-reads one claim's folder on demand. |
| Upload mechanism | `multer` (disk storage), added as a route-level dependency only. |

### Out of scope (Phase 2B boundary)

- No **content** processing — OCR, spell-check, QR, metadata extraction, intra-claim/full scan. The 5 validation columns stay `PENDING` (that's 2C/2D).
- No document versioning, thumbnails/previews-generation, zip extraction, or virus scanning.
- No editing of file bytes; SCANNED files are referenced read-only (deleting a SCANNED `Document` removes only the DB row, never the source file).
- No filename-pattern configuration UI (uses existing master data tokens).

---

## 1. Architecture

A new document module beside the Phase 1/2A claims code. It reuses `ClaimService` scope checks and the 2A filesystem abstraction. New units:

```
server/src/
├── lib/
│   └── fileSystemPort.ts        (new — stat + listFiles abstraction; extends the 2A reader idea)
├── services/
│   ├── documentClassifier.ts    (new — PURE token matcher: classify(fileName, docTypes))
│   ├── fsFileSystemPort.ts       (new — production fs implementation of FileSystemPort)
│   └── documentService.ts        (new — discoverForClaim / registerUpload / list / resolveServingPath / delete)
├── routes/
│   └── claims.ts                 (modify — mount /:id/documents sub-routes)
│   └── claimDocuments.ts         (new — list/upload/sync/content/delete handlers)
└── services/scanService.ts       (modify — after each claim, call documentService.discoverForClaim; add doc counts to ScanJob)

client/src/
└── pages/claims/ClaimUpdate.tsx  (modify — replace Documents placeholder with real section)
```

### Filesystem abstraction (testability seam)

```ts
export interface FileEntry { name: string; sizeBytes: number; }
export interface PathStat { exists: boolean; isDirectory: boolean; isFile: boolean; sizeBytes: number; }

export interface FileSystemPort {
  stat(absolutePath: string): Promise<PathStat>;
  listFiles(absolutePath: string): Promise<FileEntry[]>; // immediate child files only
}
```
- `FsFileSystemPort` uses `fs.promises` (`stat`, `readdir withFileTypes` + per-entry size).
- Tests inject a fake — **no real filesystem**, so discovery is unit-testable on macOS.
- SCANNED reads run through the same `CLAIMS_SCAN_ROOT` dev-remap (`resolveScanRoot` from 2A) so a Windows `folderPath` resolves to a local fixture in dev.

---

## 2. Data model (Prisma — `npm run db:push`)

```prisma
enum DocumentSource {
  SCANNED
  UPLOADED
}

model Document {
  id             String         @id @default(uuid()) @db.VarChar(36)
  claimId        String         @map("claim_id") @db.VarChar(36)
  documentTypeId String?        @map("document_type_id") @db.VarChar(36)
  source         DocumentSource
  fileName       String         @map("file_name") @db.VarChar(500)
  storagePath    String         @map("storage_path") @db.VarChar(500)  // 500 keeps the composite unique index within MySQL's 3072-byte limit
  sizeBytes      Int?           @map("size_bytes")
  mimeType       String?        @map("mime_type") @db.VarChar(150)
  createdAt      DateTime       @default(now()) @map("created_at")
  createdBy      String?        @map("created_by") @db.VarChar(36)

  claim        Claim               @relation(fields: [claimId], references: [id], onDelete: Cascade)
  documentType DocumentTypeMaster? @relation(fields: [documentTypeId], references: [id])

  @@unique([claimId, storagePath])
  @@index([claimId])
  @@index([documentTypeId])
  @@map("documents")
}
```
+ `documents Document[]` on `Claim` and `DocumentTypeMaster`.

- `storagePath` is the absolute path used to read the file when serving:
  - SCANNED, FOLDER claim → `path.win32.join(claim.folderPath, fileName)`
  - SCANNED, FILE claim → `claim.folderPath` itself (`fileName = basename`)
  - UPLOADED → `path.join(UPLOADS_ROOT, claimId, storedName)`
- `@@unique([claimId, storagePath])` gives idempotency: re-scan / re-sync skip files already recorded (P2002 → skip).
- `mimeType` inferred from file extension via a small built-in lookup (no new dependency); unknown → `application/octet-stream`.

---

## 3. Classifier (`documentClassifier.ts`, pure)

```ts
// docTypes: ACTIVE DocumentTypeMaster rows for the claim's SubCategory.
export function classify(
  fileName: string,
  docTypes: { id: string; name: string; category: 'GOVT' | 'CUSTOM'; govtCode: string | null; displayOrder: number }[]
): string | null
```
- Normalize the filename: lowercase, strip non-alphanumerics.
- For each type, build tokens: GOVT → `[govtCode, name]`; CUSTOM → `[name]` (each normalized the same way).
- A type matches if any token is a substring of the normalized filename.
- Resolve: exactly one matching type → its `id`; multiple → the one with the lowest `displayOrder` (tie → first by `name`); none → `null`.
- Pure, deterministic, no DB — directly unit-testable.

---

## 4. DocumentService

```ts
class DocumentService {
  constructor(prisma: PrismaClient, fs: FileSystemPort) {}

  // Disk discovery for one claim. Returns { created, skipped }.
  // FOLDER claim (folderPath is a dir): each immediate child file → SCANNED document.
  // FILE claim (folderPath is a file): that file → the claim's single SCANNED document.
  // Classifies each by name; idempotent insert on @@unique collision (skip).
  async discoverForClaim(claim: { id; folderPath; subCategoryId }): Promise<{ created: number; skipped: number }>;

  // Records an UPLOADED document already written to disk by multer. Classifies by name.
  async registerUpload(claimId, subCategoryId, file: { originalName; storedPath; sizeBytes; mimeType }, actorId): Promise<Document>;

  async list(claimId): Promise<Document[]>; // includes documentType {id,name}

  // Returns { storagePath, fileName, mimeType } after resolving SCANNED paths through the
  // dev-remap and verifying the resolved path stays within its allowed root.
  async resolveServingPath(docId): Promise<{ absolutePath; fileName; mimeType } | null>;

  async delete(docId): Promise<void>; // removes row; if UPLOADED, also unlinks the stored file
}
```
- `discoverForClaim`: if `folderPath` is empty/missing → no-op (claim has no disk location). `stat` decides dir-vs-file. Files only (no recursion).
- Classification needs the SubCategory's ACTIVE doc types — one query, passed to the pure `classify`.

---

## 5. API surface (under `/api/claims/:id`, behind `authMiddleware + scoped`)

```
GET    /api/claims/:id/documents                  List (any in-scope viewer).
POST   /api/claims/:id/documents      (multipart) Upload one+ files (field "files"). Requires canEditClaim.
POST   /api/claims/:id/documents/sync             Disk-discover this claim's folder. Requires canEditClaim.
GET    /api/claims/:id/documents/:docId/content   Stream (inline/attachment). View-scope gated.
DELETE /api/claims/:id/documents/:docId           Requires canEditClaim.
```
- `multer` is applied **only** on the upload route (disk storage → `UPLOADS_ROOT/<claimId>/`, dir auto-created; stored name sanitized via `path.basename` + a uuid prefix to avoid collisions). Configurable max size (default 25 MB); any content type accepted (tunable).
- All routes first re-check claim access: list/content/`:docId` use the existing `getById` scope check (any in-scope viewer); mutations call `canEditClaim` and 403 `CLAIM_NOT_EDITABLE` otherwise.
- Error mapping uses the central Prisma handler (P2002 idempotency is caught in the service, not surfaced).

---

## 6. Serving (security)

`/content` → `resolveServingPath(docId)`:
1. Load the `Document`; resolve `storagePath`. For SCANNED, apply the `CLAIMS_SCAN_ROOT` remap (so dev serves from fixtures; prod uses the real Windows path). For UPLOADED, use the `UPLOADS_ROOT/<claimId>` path.
2. **Containment check**: the normalized resolved path must stay within its allowed root (the remapped scan root, or `UPLOADS_ROOT/<claimId>`). Reject otherwise (defense-in-depth; paths come from our own DB rows).
3. `stat` to confirm the file exists → else 404 `FILE_NOT_FOUND`.
4. Set `Content-Type` from `mimeType`; `Content-Disposition` `inline` for `application/pdf` and `image/*`, else `attachment`. Stream with `fs.createReadStream`.

Access: the caller must pass the claim **view** scope check (same as `GET /claims/:id`) — a USER may view documents of any in-scope claim (read), consistent with the dashboard's read model.

---

## 7. Scan integration (2A extension)

`ScanService.run` — after a claim is created **or** found-existing for a folder, call `documentService.discoverForClaim(claim)` and accumulate into two new `ScanJob` counters: `docsCreated`, `docsSkipped` (added to the model). Document-discovery errors for one claim are recorded in the job's `errors` list (reason `DOC_DISCOVERY_FAILED`) and do not abort the scan. The scan remains admin-only.

`ScanJob` additions:
```prisma
  docsCreated Int @default(0) @map("docs_created")
  docsSkipped Int @default(0) @map("docs_skipped")
```

---

## 8. Permissions

| Action | Who |
|--------|-----|
| List documents / stream content | Any in-scope viewer (USER/TL/ADMIN in the claim's pair; ADMIN all) |
| Upload / Sync / Delete | `canEditClaim` (USER if assigned, TL in scope, ADMIN) |
| Bulk discovery via scan | Inherits the admin-only "Scan now" |

---

## 9. UI (`ClaimUpdate.tsx`)

Replace the placeholder "Documents" card with a real section:
- **List**: each document row → filename as a link to `/content` (opens inline in a new tab), a **Type** badge (the `DocumentTypeMaster.name`, or muted "Unclassified"), a **Source** badge (Scanned / Uploaded), size (human-readable), and created date.
- **Upload** control (file input, multi-file) — shown when `canEdit`. Posts multipart, then refreshes the list.
- **Sync from folder** button — shown when `canEdit` and the claim has a `folderPath`; posts `/sync`, then refreshes (toast: "Added N, skipped M").
- **Delete** per row — shown when `canEdit`; confirm, then `DELETE`.
- Empty state: "No documents yet."

---

## 10. Testing

- **`documentClassifier`** — pure unit tests: GOVT govtCode token (`aadhar_front.pdf` → AADHAR), GOVT name token, CUSTOM name (`bill_jan.pdf` → Bill), multiple matches → lowest `displayOrder`, no match → `null`, case-insensitivity.
- **`DocumentService.discoverForClaim`** — fake `FileSystemPort` + self-contained fixtures (SubCategory + doc types + a claim with `folderPath`): asserts created/skipped counts, classification assignments, FOLDER (multi-file) vs FILE (single-file) behaviour, and **idempotency** on re-run (all skipped). macOS-runnable.
- **`registerUpload` + `resolveServingPath`** — path construction, the `CLAIMS_SCAN_ROOT` remap for SCANNED, the containment/traversal rejection, and UPLOADED delete unlinking the file (against a temp `UPLOADS_ROOT`).
- **Type-check** — `npx tsc --noEmit` clean in both workspaces (the static gate; `npm run lint` is not wired in this repo).
- **Manual** — on macOS via fixtures (`CLAIMS_SCAN_ROOT` + `UPLOADS_ROOT` pointed at temp dirs): scan a claim folder → documents appear classified; upload a file → appears; open inline; delete; re-sync → skipped.

---

## 11. Open items for the implementation plan

- Max upload size value and whether to restrict content types (default: 25 MB, any type).
- The mime-type extension lookup table's coverage (pdf, png, jpg/jpeg, tiff, gif, txt, doc/docx, xls/xlsx → else octet-stream).
- Whether the per-claim "Sync documents" button appears for FILE-target claims (folderPath is a single file) — lean yes (ingests that one file).
- Inline-preview content-type set (start: `application/pdf`, `image/*`).

These are small enough to settle during plan-writing without changing the design.
