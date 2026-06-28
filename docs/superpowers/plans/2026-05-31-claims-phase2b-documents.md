# Claims Phase 2B — Document Association Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Associate document files with claims from two sources — disk discovery (files in a claim's `folderPath`) and browser upload — auto-classified to a `DocumentTypeMaster` by filename token, listed and streamed (inline/download) on the Claim Update page.

**Architecture:** A `Document` model with a `source` enum; a **pure** `documentClassifier`; a `DocumentService` (discover / registerUpload / resolveServingPath / delete) over a `FileSystemPort` abstraction (real `fs` in prod, fake in tests — macOS-runnable). Disk discovery runs both inside the 2A scan and via a per-claim sync endpoint. Uploads use `multer` disk storage into `UPLOADS_ROOT/<claimId>/`. Serving streams through an access-gated, path-contained endpoint (SCANNED paths run through the 2A `CLAIMS_SCAN_ROOT` dev-remap).

**Tech Stack:** Node 18 / Express 4 / TypeScript (NodeNext ESM) · Prisma 5 / MySQL (`prisma db push`, no migrations dir) · `multer` (new dep) · React 18 / Vite. Static gate is `npx tsc --noEmit` per workspace (`npm run lint` is not wired in this repo).

**Spec:** `docs/superpowers/specs/2026-05-31-claims-phase2b-documents-design.md` (read first).

---

## File Structure (locked in advance)

**Server — created:**
- `server/src/lib/mimeTypes.ts` — `mimeTypeFor(name)`, `isInline(mime)` (pure)
- `server/src/lib/fileSystemPort.ts` — `FileSystemPort` interface + `FileEntry`/`PathStat` types
- `server/src/lib/uploadPaths.ts` — `uploadsRoot()`, `claimUploadDir(claimId)`
- `server/src/services/fsFileSystemPort.ts` — production `fs` implementation
- `server/src/services/documentClassifier.ts` — pure `classify(fileName, docTypes)`
- `server/src/services/documentService.ts` — `DocumentService`
- `server/src/routes/claimDocuments.ts` — list/upload/sync/content/delete (mergeParams sub-router)
- `server/src/services/__tests__/documentClassifier.test.ts`
- `server/src/services/__tests__/fsFileSystemPort.test.ts`
- `server/src/services/__tests__/documentService.test.ts`

**Server — modified:**
- `server/prisma/schema.prisma` — `DocumentSource` enum, `Document` model, relations, `ScanJob.docsCreated/docsSkipped`
- `server/src/services/scanService.ts` — optional `DocumentService`; discover per claim; accumulate doc counts
- `server/src/services/__tests__/scanService.test.ts` — assert doc discovery during scan
- `server/src/routes/claims.ts` — mount `/:id/documents`
- `server/src/routes/admin/scans.ts` — construct `ScanService` with a `DocumentService`
- `server/src/index.ts` — construct the boot-sweep `ScanService` with a `DocumentService` (sweep doesn't scan, but keep one constructor path)
- `server/package.json` — add `multer` + `@types/multer`

**Client — modified:**
- `client/src/pages/claims/ClaimUpdate.tsx` — replace Documents placeholder with a real section

---

## Phase A — Backend

### Task 1: Schema — `Document` model + `ScanJob` doc counters

**Files:**
- Modify: `server/prisma/schema.prisma`

- [ ] **Step 1: Add the `DocumentSource` enum** after the `ScanJobStatus` enum:

```prisma
enum DocumentSource {
  SCANNED
  UPLOADED
}
```

- [ ] **Step 2: Add the `Document` model** at the bottom of the file (after `ScanJob`):

```prisma
model Document {
  id             String         @id @default(uuid()) @db.VarChar(36)
  claimId        String         @map("claim_id") @db.VarChar(36)
  documentTypeId String?        @map("document_type_id") @db.VarChar(36)
  source         DocumentSource
  fileName       String         @map("file_name") @db.VarChar(500)
  storagePath    String         @map("storage_path") @db.VarChar(500)
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

- [ ] **Step 3: Add relations.** Inside `model Claim { ... }` above its closing brace add:

```prisma
  documents Document[]
```

Inside `model DocumentTypeMaster { ... }` above its closing brace add:

```prisma
  documents Document[]
```

- [ ] **Step 4: Add doc counters to `ScanJob`.** Inside `model ScanJob { ... }`, after the `errorCount` line, add:

```prisma
  docsCreated   Int           @default(0) @map("docs_created")
  docsSkipped   Int           @default(0) @map("docs_skipped")
```

- [ ] **Step 5: Validate, push, regenerate**

Run: `cd server && npx prisma validate && npm run db:push && npm run db:generate`
Expected: "valid", "in sync", client regenerated.

- [ ] **Step 6: Commit**

```bash
git add server/prisma/schema.prisma
git commit -m "feat(claims): Document model + ScanJob doc counters"
```

### Task 2: `mimeTypes` helper (pure)

**Files:**
- Create: `server/src/lib/mimeTypes.ts`
- Test: `server/src/services/__tests__/documentClassifier.test.ts` is separate; create a small inline test here too:
- Test: `server/src/lib/__tests__/mimeTypes.test.ts`

- [ ] **Step 1: Write the failing test** `server/src/lib/__tests__/mimeTypes.test.ts`

```ts
import { mimeTypeFor, isInline } from '../mimeTypes.js';

describe('mimeTypes', () => {
  it('maps known extensions', () => {
    expect(mimeTypeFor('a.PDF')).toBe('application/pdf');
    expect(mimeTypeFor('scan.jpeg')).toBe('image/jpeg');
    expect(mimeTypeFor('x.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  });
  it('falls back to octet-stream', () => {
    expect(mimeTypeFor('weird.xyz')).toBe('application/octet-stream');
    expect(mimeTypeFor('noext')).toBe('application/octet-stream');
  });
  it('marks pdf and images inline', () => {
    expect(isInline('application/pdf')).toBe(true);
    expect(isInline('image/png')).toBe(true);
    expect(isInline('text/plain')).toBe(false);
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `cd server && npm test -- mimeTypes`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/src/lib/mimeTypes.ts`**

```ts
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function mimeTypeFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME[fileName.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

export function isInline(mime: string): boolean {
  return mime === 'application/pdf' || mime.startsWith('image/');
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `cd server && npm test -- mimeTypes`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/mimeTypes.ts server/src/lib/__tests__/mimeTypes.test.ts
git commit -m "feat(claims): mimeTypes helper"
```

### Task 3: `documentClassifier` (pure token matcher)

**Files:**
- Create: `server/src/services/documentClassifier.ts`
- Test: `server/src/services/__tests__/documentClassifier.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { classify, ClassifiableType } from '../documentClassifier.js';

const types: ClassifiableType[] = [
  { id: 'aadhar', name: 'Aadhar Card', category: 'GOVT', govtCode: 'AADHAR', displayOrder: 2 },
  { id: 'pan', name: 'PAN Card', category: 'GOVT', govtCode: 'PAN', displayOrder: 3 },
  { id: 'card', name: 'Card', category: 'CUSTOM', govtCode: null, displayOrder: 1 },
  { id: 'bill', name: 'Bill', category: 'CUSTOM', govtCode: null, displayOrder: 4 },
];

describe('documentClassifier.classify', () => {
  it('matches a GOVT govtCode token', () => {
    expect(classify('aadhar_front.pdf', [types[0], types[1]])).toBe('aadhar');
  });
  it('matches a CUSTOM name token (case-insensitive)', () => {
    expect(classify('BILL_jan.PDF', [types[3]])).toBe('bill');
  });
  it('breaks multiple matches by lowest displayOrder', () => {
    // "aadhar_card.pdf" matches both AADHAR (do 2) and "Card" (do 1) → Card wins
    expect(classify('aadhar_card.pdf', types)).toBe('card');
  });
  it('returns null when nothing matches', () => {
    expect(classify('random_scan.pdf', types)).toBeNull();
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `cd server && npm test -- documentClassifier`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/src/services/documentClassifier.ts`**

```ts
export interface ClassifiableType {
  id: string;
  name: string;
  category: string; // 'GOVT' | 'CUSTOM'
  govtCode: string | null;
  displayOrder: number;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function classify(fileName: string, docTypes: ClassifiableType[]): string | null {
  const f = norm(fileName);
  const matches = docTypes.filter((t) => {
    const tokens = t.category === 'GOVT' ? [t.govtCode ?? '', t.name] : [t.name];
    return tokens.some((tok) => tok !== '' && f.includes(norm(tok)));
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
  return matches[0].id;
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `cd server && npm test -- documentClassifier`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/documentClassifier.ts server/src/services/__tests__/documentClassifier.test.ts
git commit -m "feat(claims): pure documentClassifier (token match)"
```

### Task 4: `FileSystemPort` + `FsFileSystemPort` + upload paths

**Files:**
- Create: `server/src/lib/fileSystemPort.ts`
- Create: `server/src/lib/uploadPaths.ts`
- Create: `server/src/services/fsFileSystemPort.ts`
- Test: `server/src/services/__tests__/fsFileSystemPort.test.ts`

- [ ] **Step 1: Create `server/src/lib/fileSystemPort.ts`**

```ts
export interface FileEntry {
  name: string;
  sizeBytes: number;
}

export interface PathStat {
  exists: boolean;
  isDirectory: boolean;
  isFile: boolean;
  sizeBytes: number;
}

export interface FileSystemPort {
  stat(absolutePath: string): Promise<PathStat>;
  /** Immediate child files only (no directories, no recursion). */
  listFiles(absolutePath: string): Promise<FileEntry[]>;
}
```

- [ ] **Step 2: Create `server/src/lib/uploadPaths.ts`**

```ts
import path from 'path';

export function uploadsRoot(): string {
  return process.env.UPLOADS_ROOT || path.join(process.cwd(), 'uploads');
}

export function claimUploadDir(claimId: string): string {
  return path.join(uploadsRoot(), claimId);
}
```

- [ ] **Step 3: Write the failing test** `server/src/services/__tests__/fsFileSystemPort.test.ts`

```ts
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { FsFileSystemPort } from '../fsFileSystemPort.js';

describe('FsFileSystemPort', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-'));
    await fs.writeFile(path.join(dir, 'a.pdf'), 'abc');
    await fs.writeFile(path.join(dir, 'b.png'), 'de');
    await fs.mkdir(path.join(dir, 'sub'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('stat reports a directory', async () => {
    const s = await new FsFileSystemPort().stat(dir);
    expect(s).toMatchObject({ exists: true, isDirectory: true, isFile: false });
  });

  it('stat reports a missing path as not existing', async () => {
    const s = await new FsFileSystemPort().stat(path.join(dir, 'nope'));
    expect(s.exists).toBe(false);
  });

  it('listFiles returns only files with sizes (no subdirs)', async () => {
    const files = (await new FsFileSystemPort().listFiles(dir)).sort((x, y) =>
      x.name.localeCompare(y.name)
    );
    expect(files.map((f) => f.name)).toEqual(['a.pdf', 'b.png']);
    expect(files[0].sizeBytes).toBe(3);
    expect(files[1].sizeBytes).toBe(2);
  });
});
```

- [ ] **Step 4: Run (expect fail)**

Run: `cd server && npm test -- fsFileSystemPort`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `server/src/services/fsFileSystemPort.ts`**

```ts
import { promises as fs } from 'fs';
import path from 'path';
import { FileSystemPort, FileEntry, PathStat } from '../lib/fileSystemPort.js';

export class FsFileSystemPort implements FileSystemPort {
  async stat(absolutePath: string): Promise<PathStat> {
    try {
      const s = await fs.stat(absolutePath);
      return { exists: true, isDirectory: s.isDirectory(), isFile: s.isFile(), sizeBytes: s.size };
    } catch {
      return { exists: false, isDirectory: false, isFile: false, sizeBytes: 0 };
    }
  }

  async listFiles(absolutePath: string): Promise<FileEntry[]> {
    const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
    const files = dirents.filter((d) => d.isFile());
    return Promise.all(
      files.map(async (d) => ({
        name: d.name,
        sizeBytes: (await fs.stat(path.join(absolutePath, d.name))).size,
      }))
    );
  }
}
```

- [ ] **Step 6: Run (expect pass)**

Run: `cd server && npm test -- fsFileSystemPort`
Expected: PASS (3/3).

- [ ] **Step 7: Commit**

```bash
git add server/src/lib/fileSystemPort.ts server/src/lib/uploadPaths.ts server/src/services/fsFileSystemPort.ts server/src/services/__tests__/fsFileSystemPort.test.ts
git commit -m "feat(claims): FileSystemPort + FsFileSystemPort + upload paths"
```

### Task 5: `DocumentService` — discover, register, resolve, delete (+ tests)

**Files:**
- Create: `server/src/services/documentService.ts`
- Test: `server/src/services/__tests__/documentService.test.ts`

- [ ] **Step 1: Write the failing test** `server/src/services/__tests__/documentService.test.ts`. Self-contained fixtures (UserType/ProjectType/Category/SubCategory + doc types + claim), fake `FileSystemPort`.

```ts
import { PrismaClient } from '@prisma/client';
import path from 'path';
import { DocumentService } from '../documentService.js';
import { FileSystemPort, FileEntry, PathStat } from '../../lib/fileSystemPort.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

class FakeFs implements FileSystemPort {
  constructor(private stats: Record<string, PathStat>, private files: Record<string, FileEntry[]>) {}
  async stat(p: string): Promise<PathStat> {
    return this.stats[p] ?? { exists: false, isDirectory: false, isFile: false, sizeBytes: 0 };
  }
  async listFiles(p: string): Promise<FileEntry[]> {
    return this.files[p] ?? [];
  }
}

describe('DocumentService', () => {
  let prisma: PrismaClient;
  let subCategoryId: string;
  let adminId: string;
  const SUF = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let utId: string;
  let ptId: string;
  let catId: string;
  let workflowStatusId: string;

  async function makeClaim(claimId: string, folderPath: string | null) {
    return prisma.claim.create({
      data: { claimId, subCategoryId, workflowStatusId, folderPath, createdBy: adminId, updatedBy: adminId },
    });
  }

  beforeAll(async () => {
    prisma = getTestPrisma();
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    if (!admin) throw new Error('Need an ADMIN user seeded');
    adminId = admin.id;
    const ut = await prisma.userType.create({ data: { name: `doc-ut-${SUF}` } });
    const pt = await prisma.projectType.create({ data: { name: `doc-pt-${SUF}` } });
    utId = ut.id; ptId = pt.id;
    const cat = await prisma.category.create({ data: { name: `doc-cat-${SUF}`, userTypeId: utId, projectTypeId: ptId } });
    catId = cat.id;
    const sc = await prisma.subCategory.create({ data: { name: `doc-sc-${SUF}`, categoryId: catId } });
    subCategoryId = sc.id;
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    const pending = await prisma.statusMaster.create({
      data: { subCategoryId, name: 'Pending', isDefault: true, createdBy: adminId, updatedBy: adminId },
    });
    workflowStatusId = pending.id;
    await prisma.documentTypeMaster.create({
      data: { subCategoryId, name: 'Aadhar Card', category: 'GOVT', govtCode: 'AADHAR', displayOrder: 1, createdBy: adminId, updatedBy: adminId },
    });
  });

  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await prisma.subCategory.deleteMany({ where: { id: subCategoryId } });
    await prisma.category.deleteMany({ where: { id: catId } });
    await prisma.userType.deleteMany({ where: { id: utId } });
    await prisma.projectType.deleteMany({ where: { id: ptId } });
    await disconnectTestPrisma();
  });

  it('discovers files in a FOLDER claim, classifies, and is idempotent', async () => {
    const claim = await makeClaim('C-DOC1', 'D:\\Claims\\Daily\\C-DOC1');
    const folder = claim.folderPath as string;
    const fake = new FakeFs(
      { [folder]: { exists: true, isDirectory: true, isFile: false, sizeBytes: 0 } },
      { [folder]: [{ name: 'aadhar_front.pdf', sizeBytes: 10 }, { name: 'misc.txt', sizeBytes: 3 }] }
    );
    const svc = new DocumentService(prisma, fake);

    const r1 = await svc.discoverForClaim(claim, adminId);
    expect(r1).toEqual({ created: 2, skipped: 0 });

    const docs = await prisma.document.findMany({ where: { claimId: claim.id }, orderBy: { fileName: 'asc' } });
    expect(docs.map((d) => d.fileName)).toEqual(['aadhar_front.pdf', 'misc.txt']);
    const aadhar = docs.find((d) => d.fileName === 'aadhar_front.pdf')!;
    expect(aadhar.documentTypeId).not.toBeNull(); // classified to Aadhar Card
    expect(aadhar.source).toBe('SCANNED');
    expect(aadhar.storagePath).toBe(path.win32.join(folder, 'aadhar_front.pdf'));
    expect(docs.find((d) => d.fileName === 'misc.txt')!.documentTypeId).toBeNull();

    const r2 = await svc.discoverForClaim(claim, adminId); // re-run
    expect(r2).toEqual({ created: 0, skipped: 2 });
    expect(await prisma.document.count({ where: { claimId: claim.id } })).toBe(2);
  });

  it('treats a FILE claim folderPath as its single document', async () => {
    const claim = await makeClaim('C-DOC2', 'D:\\Claims\\Files\\C-DOC2_scan.pdf');
    const fp = claim.folderPath as string;
    const fake = new FakeFs(
      { [fp]: { exists: true, isDirectory: false, isFile: true, sizeBytes: 99 } },
      {}
    );
    const svc = new DocumentService(prisma, fake);
    const r = await svc.discoverForClaim(claim, adminId);
    expect(r).toEqual({ created: 1, skipped: 0 });
    const doc = await prisma.document.findFirst({ where: { claimId: claim.id } });
    expect(doc?.fileName).toBe('C-DOC2_scan.pdf');
    expect(doc?.storagePath).toBe(fp);
    expect(doc?.sizeBytes).toBe(99);
  });

  it('no-ops a claim with no folderPath', async () => {
    const claim = await makeClaim('C-DOC3', null);
    const svc = new DocumentService(prisma, new FakeFs({}, {}));
    expect(await svc.discoverForClaim(claim, adminId)).toEqual({ created: 0, skipped: 0 });
  });
});
```

- [ ] **Step 2: Run (expect fail)**

Run: `cd server && npm test -- documentService`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/src/services/documentService.ts`**

```ts
import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'fs';
import path from 'path';
import { FileSystemPort } from '../lib/fileSystemPort.js';
import { resolveScanRoot } from '../lib/directoryReader.js';
import { classify } from './documentClassifier.js';
import { mimeTypeFor } from '../lib/mimeTypes.js';
import { uploadsRoot } from '../lib/uploadPaths.js';

export class DocumentService {
  constructor(private prisma: PrismaClient, private fsPort: FileSystemPort) {}

  private async docTypesFor(subCategoryId: string) {
    return this.prisma.documentTypeMaster.findMany({
      where: { subCategoryId, status: 'ACTIVE' },
      select: { id: true, name: true, category: true, govtCode: true, displayOrder: true },
    });
  }

  async discoverForClaim(
    claim: { id: string; folderPath: string | null; subCategoryId: string },
    actorId?: string
  ): Promise<{ created: number; skipped: number }> {
    if (!claim.folderPath || !claim.folderPath.trim()) return { created: 0, skipped: 0 };
    const readPath = resolveScanRoot(claim.folderPath);
    const st = await this.fsPort.stat(readPath);
    if (!st.exists) return { created: 0, skipped: 0 };

    let items: { fileName: string; storagePath: string; sizeBytes: number }[] = [];
    if (st.isDirectory) {
      const files = await this.fsPort.listFiles(readPath);
      items = files.map((f) => ({
        fileName: f.name,
        storagePath: path.win32.join(claim.folderPath as string, f.name),
        sizeBytes: f.sizeBytes,
      }));
    } else if (st.isFile) {
      items = [
        {
          fileName: path.win32.basename(claim.folderPath),
          storagePath: claim.folderPath,
          sizeBytes: st.sizeBytes,
        },
      ];
    }
    if (items.length === 0) return { created: 0, skipped: 0 };

    const docTypes = await this.docTypesFor(claim.subCategoryId);
    let created = 0;
    let skipped = 0;
    for (const it of items) {
      try {
        await this.prisma.document.create({
          data: {
            claimId: claim.id,
            documentTypeId: classify(it.fileName, docTypes),
            source: 'SCANNED',
            fileName: it.fileName,
            storagePath: it.storagePath,
            sizeBytes: it.sizeBytes,
            mimeType: mimeTypeFor(it.fileName),
            createdBy: actorId ?? null,
          },
        });
        created++;
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') skipped++;
        else throw e;
      }
    }
    return { created, skipped };
  }

  async registerUpload(
    claimId: string,
    subCategoryId: string,
    file: { originalName: string; storedPath: string; sizeBytes: number },
    actorId: string
  ) {
    const docTypes = await this.docTypesFor(subCategoryId);
    return this.prisma.document.create({
      data: {
        claimId,
        documentTypeId: classify(file.originalName, docTypes),
        source: 'UPLOADED',
        fileName: file.originalName,
        storagePath: file.storedPath,
        sizeBytes: file.sizeBytes,
        mimeType: mimeTypeFor(file.originalName),
        createdBy: actorId,
      },
    });
  }

  async list(claimId: string) {
    return this.prisma.document.findMany({
      where: { claimId },
      include: { documentType: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Returns the absolute path to stream + display name + mime, or null if missing/out-of-bounds. */
  async resolveServingPath(
    docId: string
  ): Promise<{ absolutePath: string; fileName: string; mimeType: string } | null> {
    const doc = await this.prisma.document.findUnique({ where: { id: docId } });
    if (!doc) return null;
    let absolutePath: string;
    if (doc.source === 'UPLOADED') {
      absolutePath = path.resolve(doc.storagePath);
      const root = path.resolve(uploadsRoot(), doc.claimId);
      if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) return null;
    } else {
      const remapped = resolveScanRoot(doc.storagePath);
      const override = process.env.CLAIMS_SCAN_ROOT;
      if (override) {
        absolutePath = path.resolve(remapped);
        const root = path.resolve(override);
        if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) return null;
      } else {
        // Production: trust the DB-stored Windows path as-is.
        absolutePath = remapped;
      }
    }
    return {
      absolutePath,
      fileName: doc.fileName,
      mimeType: doc.mimeType ?? 'application/octet-stream',
    };
  }

  async delete(docId: string): Promise<void> {
    const doc = await this.prisma.document.findUnique({ where: { id: docId } });
    if (!doc) return;
    await this.prisma.document.delete({ where: { id: docId } });
    if (doc.source === 'UPLOADED') {
      try {
        await fs.unlink(doc.storagePath);
      } catch {
        /* file already gone — ignore */
      }
    }
  }
}
```

- [ ] **Step 4: Run (expect pass)**

Run: `cd server && npm test -- documentService`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/documentService.ts server/src/services/__tests__/documentService.test.ts
git commit -m "feat(claims): DocumentService (discover/upload/serve/delete)"
```

### Task 6: Install `multer` + claim document routes + mount

**Files:**
- Modify: `server/package.json`
- Create: `server/src/routes/claimDocuments.ts`
- Modify: `server/src/routes/claims.ts`

- [ ] **Step 1: Install multer**

Run: `cd server && npm install multer@^1.4.5-lts.1 && npm install -D @types/multer`
Expected: both added to `server/package.json`.

- [ ] **Step 2: Create `server/src/routes/claimDocuments.ts`**

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import fsSync from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { param, validationResult } from 'express-validator';
import { ClaimService } from '../services/claimService.js';
import { DocumentService } from '../services/documentService.js';
import { FsFileSystemPort } from '../services/fsFileSystemPort.js';
import { claimUploadDir } from '../lib/uploadPaths.js';
import { isInline } from '../lib/mimeTypes.js';

// mergeParams so :id from the parent /claims/:id mount is available here.
const router = Router({ mergeParams: true });

const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0]?.msg, code: 'VALIDATION_ERROR' });
  }
  next();
};

const prismaOf = (req: Request) => req.app.get('prisma') as PrismaClient;
const claimSvc = (req: Request) => new ClaimService(prismaOf(req));
const docSvc = (req: Request) => new DocumentService(prismaOf(req), new FsFileSystemPort());

// View-scope gate: caller must be able to see the claim.
const requireView = async (req: Request, res: Response, next: NextFunction) => {
  const claim = await claimSvc(req).getById(req.params.id, req.session!.userId, req.session!.role);
  if (!claim) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  next();
};

// Edit gate for mutations.
const requireEdit = async (req: Request, res: Response, next: NextFunction) => {
  const ok = await claimSvc(req).canEditClaim(req.params.id, req.session!.userId, req.session!.role);
  if (!ok) return res.status(403).json({ error: 'Cannot edit this claim', code: 'CLAIM_NOT_EDITABLE' });
  next();
};

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = claimUploadDir(req.params.id);
      fsSync.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${path.basename(file.originalname)}`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

router.get('/', [param('id').isUUID()], validate, requireView, async (req, res, next) => {
  try {
    res.json({ data: await docSvc(req).list(req.params.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/', [param('id').isUUID()], validate, requireEdit, upload.array('files'), async (req, res, next) => {
  try {
    const prisma = prismaOf(req);
    const claim = await prisma.claim.findUnique({ where: { id: req.params.id } });
    if (!claim) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    const files = (req.files as Express.Multer.File[]) || [];
    const svc = docSvc(req);
    const created = [];
    for (const f of files) {
      created.push(
        await svc.registerUpload(
          claim.id,
          claim.subCategoryId,
          { originalName: f.originalname, storedPath: f.path, sizeBytes: f.size },
          req.session!.userId
        )
      );
    }
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

router.post('/sync', [param('id').isUUID()], validate, requireEdit, async (req, res, next) => {
  try {
    const prisma = prismaOf(req);
    const claim = await prisma.claim.findUnique({ where: { id: req.params.id } });
    if (!claim) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    const result = await docSvc(req).discoverForClaim(claim, req.session!.userId);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

router.get('/:docId/content', [param('id').isUUID(), param('docId').isUUID()], validate, requireView, async (req, res, next) => {
  try {
    const prisma = prismaOf(req);
    const doc = await prisma.document.findFirst({ where: { id: req.params.docId, claimId: req.params.id } });
    if (!doc) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    const resolved = await docSvc(req).resolveServingPath(doc.id);
    if (!resolved) return res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND' });
    const stat = await fs.stat(resolved.absolutePath).catch(() => null);
    if (!stat) return res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND' });
    res.setHeader('Content-Type', resolved.mimeType);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader(
      'Content-Disposition',
      `${isInline(resolved.mimeType) ? 'inline' : 'attachment'}; filename="${encodeURIComponent(resolved.fileName)}"`
    );
    fsSync.createReadStream(resolved.absolutePath).pipe(res);
  } catch (err) {
    next(err);
  }
});

router.delete('/:docId', [param('id').isUUID(), param('docId').isUUID()], validate, requireEdit, async (req, res, next) => {
  try {
    const prisma = prismaOf(req);
    const doc = await prisma.document.findFirst({ where: { id: req.params.docId, claimId: req.params.id } });
    if (!doc) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    await docSvc(req).delete(doc.id);
    res.json({ message: 'Deleted' });
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 3: Mount in `server/src/routes/claims.ts`.** Add the import near the top:

```ts
import claimDocumentsRoutes from './claimDocuments.js';
```

Then, immediately before `export default router;` at the bottom, add:

```ts
router.use('/:id/documents', claimDocumentsRoutes);
```

(The parent router already applies `authMiddleware`, `passwordChangedMiddleware`, and `scopedMiddleware`, so the sub-router inherits them.)

- [ ] **Step 4: Type-check**

Run: `cd server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add server/package.json server/package-lock.json package-lock.json server/src/routes/claimDocuments.ts server/src/routes/claims.ts
git commit -m "feat(claims): document routes (list/upload/sync/content/delete) + multer"
```

### Task 7: Integrate document discovery into the 2A scan

**Files:**
- Modify: `server/src/services/scanService.ts`
- Modify: `server/src/routes/admin/scans.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/services/__tests__/scanService.test.ts`

- [ ] **Step 1: Add a failing test** to `server/src/services/__tests__/scanService.test.ts`. First extend the imports at the top:

```ts
import { DocumentService } from '../documentService.js';
import { FileSystemPort, FileEntry, PathStat } from '../../lib/fileSystemPort.js';
```

Add a fake filesystem class after the existing `FakeReader` class:

```ts
class FakeFs implements FileSystemPort {
  constructor(private files: Record<string, FileEntry[]>) {}
  async stat(p: string): Promise<PathStat> {
    return { exists: true, isDirectory: true, isFile: false, sizeBytes: 0 };
  }
  async listFiles(p: string): Promise<FileEntry[]> {
    return this.files[p] ?? [{ name: 'doc.pdf', sizeBytes: 5 }];
  }
}
```

Add this test inside the `describe`:

```ts
  it('run ingests documents per claim when a DocumentService is provided', async () => {
    await statusService.create({ subCategoryId, name: 'Pending', isDefault: true }, adminId);
    const reader = new FakeReader(['CLM00031']);
    const docService = new DocumentService(prisma, new FakeFs({}));
    const svc = new ScanService(prisma, reader, docService);
    const job = await svc.enqueue(ruleId, adminId);
    await svc.run(job.id);
    const done = await prisma.scanJob.findUnique({ where: { id: job.id } });
    expect(done?.createdCount).toBe(1);
    expect(done?.docsCreated).toBe(1); // one doc.pdf discovered for the claim folder
    const claim = await prisma.claim.findFirst({ where: { subCategoryId, claimId: 'CLM00031' } });
    expect(await prisma.document.count({ where: { claimId: claim!.id } })).toBe(1);
  });
```

- [ ] **Step 2: Run (expect fail)**

Run: `cd server && npm test -- scanService`
Expected: FAIL — `ScanService` constructor takes 2 args / `docsCreated` stays 0.

- [ ] **Step 3: Modify `ScanService`** in `server/src/services/scanService.ts`.

Add the import at the top:

```ts
import { DocumentService } from './documentService.js';
```

Change the constructor:

```ts
  constructor(
    private prisma: PrismaClient,
    private reader: DirectoryReader,
    private documentService?: DocumentService
  ) {}
```

Add two accumulators near the other counters in `run` (after `let errored = 0;`):

```ts
    let docsCreated = 0;
    let docsSkipped = 0;
```

Replace the per-entry claim-creation block. The current block is:

```ts
            const folderPath = path.win32.join(job.scanLocation, name);
            try {
              await claimService.create(
                { subCategoryId: job.subCategoryId, claimId, folderPath },
                actorId,
                'ALL',
                { trustedFolderPath: true }
              );
              created++;
            } catch (e) {
              if (e instanceof ClaimServiceError && e.code === 'DUPLICATE_CLAIM_ID') {
                skipped++;
              } else {
                pushError(name, e instanceof Error ? e.message : 'CREATE_FAILED');
              }
            }
```

Replace it with (captures the claim — created or existing — and discovers its documents):

```ts
            const folderPath = path.win32.join(job.scanLocation, name);
            let claimForDocs: { id: string; folderPath: string | null; subCategoryId: string } | null = null;
            try {
              const newClaim = await claimService.create(
                { subCategoryId: job.subCategoryId, claimId, folderPath },
                actorId,
                'ALL',
                { trustedFolderPath: true }
              );
              created++;
              claimForDocs = { id: newClaim.id, folderPath: newClaim.folderPath, subCategoryId: newClaim.subCategoryId };
            } catch (e) {
              if (e instanceof ClaimServiceError && e.code === 'DUPLICATE_CLAIM_ID') {
                skipped++;
                const existing = await this.prisma.claim.findUnique({
                  where: { claimId_subCategoryId: { claimId, subCategoryId: job.subCategoryId } },
                  select: { id: true, folderPath: true, subCategoryId: true },
                });
                claimForDocs = existing;
              } else {
                pushError(name, e instanceof Error ? e.message : 'CREATE_FAILED');
              }
            }
            if (claimForDocs && this.documentService) {
              try {
                const dr = await this.documentService.discoverForClaim(claimForDocs, actorId);
                docsCreated += dr.created;
                docsSkipped += dr.skipped;
              } catch (e) {
                pushError(name, e instanceof Error ? `DOC_DISCOVERY_FAILED: ${e.message}` : 'DOC_DISCOVERY_FAILED');
              }
            }
```

Add `docsCreated`/`docsSkipped` to the periodic flush update (inside the `if ((i + 1) % FLUSH_EVERY === 0)` block's `data`):

```ts
              docsCreated,
              docsSkipped,
```

Add the same two fields to the final `COMPLETED` update's `data`:

```ts
          docsCreated,
          docsSkipped,
```

- [ ] **Step 4: Wire a `DocumentService` into the production `ScanService` construction.** In `server/src/routes/admin/scans.ts`, add imports:

```ts
import { DocumentService } from '../../services/documentService.js';
import { FsFileSystemPort } from '../../services/fsFileSystemPort.js';
```

Change `getService`:

```ts
const getService = (req: Request) => {
  const prisma = req.app.get('prisma') as PrismaClient;
  return new ScanService(prisma, new FsDirectoryReader(), new DocumentService(prisma, new FsFileSystemPort()));
};
```

In `server/src/index.ts`, the boot sweep constructs a `ScanService`; leave it as-is (it only calls `sweepStaleJobs`, which doesn't need a `DocumentService`). No change required.

- [ ] **Step 5: Run tests + type-check**

Run: `cd server && npx tsc --noEmit && npm test -- scanService`
Expected: tsc clean; scanService suite passes (existing 6 + the new doc-ingest test).

- [ ] **Step 6: Run the full suite + re-seed**

Run: `cd server && npm test`
Then: `npm run db:seed` (from repo root) to restore sample data.
Expected: all suites pass; seed completes.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/scanService.ts server/src/routes/admin/scans.ts server/src/services/__tests__/scanService.test.ts
git commit -m "feat(claims): scan ingests documents per claim (doc counters on ScanJob)"
```

---

## Phase B — Frontend

### Task 8: Documents section on Claim Update page

**Files:**
- Modify: `client/src/pages/claims/ClaimUpdate.tsx`

- [ ] **Step 1: Add a `DocItem` interface** after the `ClaimDetail` interface (around line 55):

```tsx
interface DocItem {
  id: string;
  fileName: string;
  source: 'SCANNED' | 'UPLOADED';
  sizeBytes: number | null;
  createdAt: string;
  documentType: { id: string; name: string } | null;
}

function humanSize(bytes: number | null): string {
  if (!bytes && bytes !== 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

- [ ] **Step 2: Add document state + fetch + handlers** inside the component, after the `handleSave` function (after line 136):

```tsx
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const fetchDocs = async () => {
    try {
      const r = await api.get<{ data: DocItem[] }>(`/claims/${id}/documents`);
      setDocs(r.data);
    } catch {
      /* surfaced on the page as an empty list */
    }
  };

  useEffect(() => {
    if (claim) fetchDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim?.id]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setIsUploading(true);
    try {
      const form = new FormData();
      Array.from(files).forEach((f) => form.append('files', f));
      await api.postForm(`/claims/${id}/documents`, form);
      toast({ title: 'Uploaded' });
      fetchDocs();
    } catch (err) {
      toast({ title: 'Upload failed', variant: 'destructive', description: err instanceof Error ? err.message : '' });
    } finally {
      setIsUploading(false);
      e.target.value = '';
    }
  };

  const handleSync = async () => {
    try {
      const r = await api.post<{ data: { created: number; skipped: number } }>(`/claims/${id}/documents/sync`, {});
      toast({ title: 'Sync complete', description: `Added ${r.data.created}, skipped ${r.data.skipped}` });
      fetchDocs();
    } catch (err) {
      toast({ title: 'Sync failed', variant: 'destructive', description: err instanceof Error ? err.message : '' });
    }
  };

  const handleDeleteDoc = async (docId: string) => {
    try {
      await api.delete(`/claims/${id}/documents/${docId}`);
      fetchDocs();
    } catch (err) {
      toast({ title: 'Delete failed', variant: 'destructive', description: err instanceof Error ? err.message : '' });
    }
  };
```

- [ ] **Step 3: Verify `api.postForm` exists; if not, add it.** Open `client/src/lib/api.ts` and check for a multipart helper. If there is no `postForm`, add this method to the `api` object (do not set `Content-Type` — the browser sets the multipart boundary):

```ts
  postForm: async <T>(path: string, form: FormData): Promise<T> => {
    const res = await fetch(`${API_BASE}${path}`, { method: 'POST', body: form, credentials: 'include' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data as T;
  },
```

Match the existing file's `API_BASE` constant name and error-handling style (read the file first; reuse its exact base-URL variable and throw shape).

- [ ] **Step 4: Replace the placeholder Documents card.** Replace this block (lines ~246-251):

```tsx
      <div className="bg-white border rounded-md p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">Documents</h2>
        <p className="text-sm text-gray-500">
          Documents will appear here once the scanner is enabled (Phase 2).
        </p>
      </div>
```

with:

```tsx
      <div className="bg-white border rounded-md p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Documents</h2>
          {canEdit && (
            <div className="flex items-center gap-2">
              {claim.folderPath && (
                <Button variant="outline" size="sm" onClick={handleSync}>
                  Sync from folder
                </Button>
              )}
              <label className="inline-flex items-center px-3 py-1.5 text-sm border rounded-md cursor-pointer hover:bg-gray-50">
                {isUploading ? 'Uploading...' : 'Upload'}
                <input type="file" multiple className="hidden" onChange={handleUpload} disabled={isUploading} />
              </label>
            </div>
          )}
        </div>
        {docs.length === 0 ? (
          <p className="text-sm text-gray-400">No documents yet.</p>
        ) : (
          <div className="space-y-2">
            {docs.map((d) => (
              <div key={d.id} className="flex items-center justify-between text-sm border rounded px-3 py-2">
                <div className="flex items-center gap-3 min-w-0">
                  <a
                    href={`/api/claims/${id}/documents/${d.id}/content`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline-offset-2 hover:underline truncate"
                  >
                    {d.fileName}
                  </a>
                  <Badge variant={d.documentType ? 'default' : 'outline'}>
                    {d.documentType?.name ?? 'Unclassified'}
                  </Badge>
                  <Badge variant="secondary">{d.source === 'SCANNED' ? 'Scanned' : 'Uploaded'}</Badge>
                </div>
                <div className="flex items-center gap-3 text-gray-500 shrink-0">
                  <span>{humanSize(d.sizeBytes)}</span>
                  <span>{new Date(d.createdAt).toLocaleDateString()}</span>
                  {canEdit && (
                    <button className="text-destructive hover:underline" onClick={() => handleDeleteDoc(d.id)}>
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
```

(The `/content` link uses the absolute `/api/...` path so the browser opens it directly with the session cookie.)

- [ ] **Step 5: Type-check**

Run: `cd client && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/claims/ClaimUpdate.tsx client/src/lib/api.ts
git commit -m "feat(claims): Documents section on Claim Update (list/upload/sync/delete/stream)"
```

---

## Phase C — Verification

### Task 9: End-to-end verification

- [ ] **Step 1: Backend green + re-seed**

Run: `cd server && npx tsc --noEmit && npm test`
Then: `npm run db:seed` (repo root).
Expected: all suites pass (existing 49 + mimeTypes 3 + documentClassifier 4 + fsFileSystemPort 3 + documentService 3 + the scan doc-ingest test); seed completes.

- [ ] **Step 2: Frontend green**

Run: `cd client && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Manual smoke (macOS via fixtures)**

```bash
mkdir -p /tmp/claimroot/Claims/Daily/CLM00041_x
printf '%%PDF-1.4 test' > "/tmp/claimroot/Claims/Daily/CLM00041_x/aadhar_front.pdf"
printf 'hello' > "/tmp/claimroot/Claims/Daily/CLM00041_x/notes.txt"
CLAIMS_SCAN_ROOT=/tmp/claimroot UPLOADS_ROOT=/tmp/uploads PORT=3010 npx tsx server/src/index.ts
```
As admin: Claim ID Rules → **Scan now** (ingests `CLM00041` + its 2 docs). Open `CLM00041` → **Documents** shows `aadhar_front.pdf` (typed "Aadhar Card") and `notes.txt` (Unclassified); click each to view inline/download. **Upload** a file → appears as "Uploaded". **Sync from folder** → adds nothing new (idempotent). **Delete** the uploaded one → file removed from `/tmp/uploads/<claimId>/`.

- [ ] **Step 4: Final status**

Run: `git status`
Expected: clean if committing per-task; otherwise the working tree holds all 2B changes.

---

## Self-Review (completed during plan writing)

- **Spec coverage:** Document model + ScanJob counters (T1) ✓ · mime helper (T2) ✓ · classifier token rule incl. multi-match displayOrder + no-match null (T3) ✓ · FileSystemPort/FsFileSystemPort + upload paths (T4) ✓ · DocumentService discover (FOLDER + FILE + idempotency), registerUpload, resolveServingPath (remap + containment), delete (UPLOADED unlink) (T5) ✓ · routes list/upload(multer)/sync/content(stream inline-vs-attachment)/delete with view vs edit gates (T6) ✓ · scan integration + doc counters (T7) ✓ · UI list/upload/sync/delete/stream-link + permissions (T8) ✓ · macOS-runnable tests throughout (T2–T7) ✓.
- **Placeholder scan:** none — every code step is complete. The `api.postForm`/`API_BASE` step instructs reading `api.ts` to match its exact constant; that's an existing-file adaptation, not a placeholder.
- **Type consistency:** `DocumentService(prisma, fsPort)`, `discoverForClaim(claim, actorId?)`, `classify(fileName, docTypes)`, `ClassifiableType`, `FileSystemPort.stat/listFiles`, `ScanService(prisma, reader, documentService?)`, and `DocItem` fields line up across tasks. SCANNED `storagePath` is the Windows `path.win32.join`/basename form everywhere; serving remaps via `resolveScanRoot`.
- **Note:** `@@unique([claimId, storagePath])` gives idempotency. Uploaded files get a `Date.now()`-prefixed stored name, so the same original uploaded twice yields two distinct documents (intended — uploads aren't deduped; only disk-discovery is idempotent).
