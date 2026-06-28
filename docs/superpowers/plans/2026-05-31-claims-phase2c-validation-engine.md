# Claims Phase 2C — Validation Engine + Validators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an in-process validation engine that runs five real validators (META/OCR, SPELL, QR, INTRA, FULL) over a claim's documents and drives the five status columns `PENDING → IN_PROGRESS → PASSED/FAILED`, triggered automatically after ingestion and manually via re-validate.

**Architecture:** A pluggable `Validator` interface + ordered registry; an in-process DB-backed **serial drainer** (module singleton) processes `QUEUED` `ValidationRun`s one at a time; results persist to `ValidationResult` and the latest status mirrors onto the `Claim` columns. Validators are decoupled from heavy I/O (OCR/QR adapters) so the **decision logic is unit-testable without running OCR**.

**Tech Stack:** Node 18 / Express / TS (NodeNext ESM) · Prisma 5 / MySQL (`db push`, no migrations dir) · pure-JS/WASM deps: `tesseract.js`, `pdf-parse`, `jimp@0.22`, `jsqr`, `nspell`, `dictionary-en` · React 18 / Vite. Static gate: `npx tsc --noEmit` per workspace.

**Spec:** `docs/superpowers/specs/2026-05-31-claims-phase2c-validation-engine-design.md` (read first).

> **Library-version note:** `jimp` and `dictionary-en` have changed APIs across majors. Pin the versions in Task 6/7 exactly. When implementing the heavy-dep validators, if the installed package's API differs from the code below, verify the actual API (the package README in `node_modules`, or context7) and adapt — the engine, logic, FULL, and INTRA tasks do not depend on these libraries and must remain green regardless.

---

## File Structure (locked in advance)

**Server — created:**
- `server/src/validators/types.ts` — `Validator`, `ValidatorContext`, `ValidatorOutcome`, `OcrPort`, key/column unions
- `server/src/validators/logic.ts` — PURE decision helpers + text utils
- `server/src/validators/fullValidator.ts`, `intraValidator.ts`, `metaValidator.ts`, `spellValidator.ts`, `qrValidator.ts`
- `server/src/validators/registry.ts` — ordered [META, SPELL, INTRA, QR, FULL]
- `server/src/lib/ocr.ts` — `TesseractOcrPort` (tesseract.js wrapper)
- `server/src/services/validationService.ts` — `ValidationService` (runOne / sweepStaleRuns)
- `server/src/services/validationQueue.ts` — `enqueue` + singleton `kickDrain`
- `server/src/routes/claimValidation.ts` — POST /validate, GET /validation, GET /validation/:runId
- tests: `validators/__tests__/logic.test.ts`, `fullIntra.test.ts`, `spellValidator.test.ts`, `qrValidator.test.ts`, `metaValidator.test.ts`; `services/__tests__/validationService.test.ts`

**Server — modified:**
- `server/prisma/schema.prisma` — enums + `ValidationRun` + `ValidationResult` + relations
- `server/src/services/scanService.ts` — auto-enqueue validation per claim
- `server/src/routes/claimDocuments.ts` — auto-enqueue after upload + sync
- `server/src/routes/claims.ts` — mount `/:id/validation` + `/:id/validate`
- `server/src/index.ts` — boot `sweepStaleRuns()` + `kickDrain()`
- `server/package.json` — 6 deps

**Client — modified:**
- `client/src/pages/claims/ClaimUpdate.tsx` — live badges + Validate button + result detail

---

## Phase A — Engine foundation (no heavy deps)

### Task 1: Schema — `ValidationRun` + `ValidationResult`

**Files:** Modify `server/prisma/schema.prisma`

- [ ] **Step 1: Add enums** after the `DocumentSource` enum:

```prisma
enum ValidationRunStatus {
  QUEUED
  RUNNING
  COMPLETED
  FAILED
}

enum ValidationTrigger {
  AUTO
  MANUAL
}
```

- [ ] **Step 2: Add models** at the bottom of the file:

```prisma
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
  validatorKey String           @map("validator_key") @db.VarChar(20)
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

- [ ] **Step 3: Add relations** inside `model Claim { ... }` above its closing brace:

```prisma
  validationRuns    ValidationRun[]
  validationResults ValidationResult[]
```

- [ ] **Step 4: Validate + push + generate**

Run: `cd server && npx prisma validate && npm run db:push && npm run db:generate`
Expected: "valid", "in sync", client regenerated.

- [ ] **Step 5: Commit** — `git add server/prisma/schema.prisma && git commit -m "feat(claims): ValidationRun + ValidationResult schema"`

### Task 2: Validator types + pure logic

**Files:** Create `server/src/validators/types.ts`, `server/src/validators/logic.ts`, `server/src/validators/__tests__/logic.test.ts`

- [ ] **Step 1: Create `server/src/validators/types.ts`**

```ts
import { PrismaClient } from '@prisma/client';
import { FileSystemPort } from '../lib/fileSystemPort.js';

export type ValidatorKey = 'META' | 'SPELL' | 'QR' | 'INTRA' | 'FULL';
export type ClaimColumn =
  | 'metaExtractionStatus'
  | 'spellCheckStatus'
  | 'qrStatus'
  | 'intraClaimStatus'
  | 'fullScanStatus';

export interface OcrPort {
  /** Extract text from an image file. Returns '' on failure. */
  extractImageText(absolutePath: string): Promise<string>;
}

export interface ValidatorDoc {
  id: string;
  fileName: string;
  storagePath: string;
  readablePath: string; // resolved absolute path (scan-root remap applied for SCANNED)
  mimeType: string | null;
  source: 'SCANNED' | 'UPLOADED';
  documentTypeId: string | null;
}

export interface ValidatorContext {
  claim: { id: string; claimId: string; subCategoryId: string };
  documents: ValidatorDoc[];
  prisma: PrismaClient;
  fsPort: FileSystemPort;
  ocr: OcrPort;
  shared: Map<string, string>; // documentId → extracted text (META fills; SPELL/INTRA read)
}

export interface ValidatorOutcome {
  status: 'PASSED' | 'FAILED';
  summary: string;
  details?: unknown;
}

export interface Validator {
  key: ValidatorKey;
  column: ClaimColumn;
  run(ctx: ValidatorContext): Promise<ValidatorOutcome>;
}
```

- [ ] **Step 2: Write the failing test** `server/src/validators/__tests__/logic.test.ts`

```ts
import {
  metaOutcome,
  spellOutcome,
  qrOutcome,
  intraOutcome,
  completenessOutcome,
  normalizeText,
  tokenizeWords,
  SPELL_MAX_RATIO,
} from '../logic.js';

describe('validator logic', () => {
  it('metaOutcome', () => {
    expect(metaOutcome(0, 0).status).toBe('PASSED');
    expect(metaOutcome(0, 2).status).toBe('FAILED');
    expect(metaOutcome(1, 2).status).toBe('PASSED');
  });
  it('spellOutcome threshold', () => {
    expect(spellOutcome(0, 0, []).status).toBe('PASSED'); // nothing to check
    expect(spellOutcome(1, 100, []).status).toBe('PASSED'); // 1% <= 20%
    expect(spellOutcome(30, 100, []).status).toBe('FAILED'); // 30% > 20%
    expect(SPELL_MAX_RATIO).toBe(0.2);
  });
  it('qrOutcome', () => {
    expect(qrOutcome(0, 0, []).status).toBe('PASSED'); // no images
    expect(qrOutcome(0, 2, []).status).toBe('FAILED'); // images but no QR
    expect(qrOutcome(1, 2, ['x']).status).toBe('PASSED');
  });
  it('intraOutcome', () => {
    expect(intraOutcome(0, 0).status).toBe('PASSED'); // no text
    expect(intraOutcome(0, 2).status).toBe('FAILED');
    expect(intraOutcome(1, 2).status).toBe('PASSED');
  });
  it('completenessOutcome', () => {
    expect(completenessOutcome([], []).status).toBe('PASSED'); // none required
    expect(completenessOutcome(['A'], ['A', 'B']).status).toBe('FAILED');
    expect(completenessOutcome(['A', 'B'], ['A', 'B']).status).toBe('PASSED');
  });
  it('text utils', () => {
    expect(normalizeText('CLM-00001')).toBe('clm00001');
    expect(tokenizeWords('The qux cat')).toEqual(['the', 'qux', 'cat']);
  });
});
```

- [ ] **Step 2b: Run (expect fail)** — `cd server && npm test -- logic` → FAIL (module not found).

- [ ] **Step 3: Create `server/src/validators/logic.ts`**

```ts
import { ValidatorOutcome } from './types.js';

export const SPELL_MAX_RATIO = 0.2;

export function metaOutcome(docsWithText: number, totalDocs: number): ValidatorOutcome {
  if (totalDocs === 0) return { status: 'PASSED', summary: 'No documents to extract.' };
  if (docsWithText === 0)
    return { status: 'FAILED', summary: `No text extracted from ${totalDocs} document(s).` };
  return { status: 'PASSED', summary: `Extracted text from ${docsWithText} of ${totalDocs} documents.` };
}

export function spellOutcome(misspelled: number, total: number, sample: string[]): ValidatorOutcome {
  if (total === 0) return { status: 'PASSED', summary: 'No text to spell-check.' };
  const ratio = misspelled / total;
  const pct = Math.round(ratio * 100);
  const status = ratio <= SPELL_MAX_RATIO ? 'PASSED' : 'FAILED';
  return { status, summary: `${pct}% suspect (${misspelled}/${total} words).`, details: { suspect: sample } };
}

export function qrOutcome(found: number, imageCount: number, values: string[]): ValidatorOutcome {
  if (imageCount === 0) return { status: 'PASSED', summary: 'No image documents to scan.' };
  if (found === 0) return { status: 'FAILED', summary: `No QR code found across ${imageCount} image(s).` };
  return { status: 'PASSED', summary: `${found} QR code(s) found across ${imageCount} image(s).`, details: { values } };
}

export function intraOutcome(foundInDocs: number, textDocs: number): ValidatorOutcome {
  if (textDocs === 0) return { status: 'PASSED', summary: 'No document text to compare.' };
  if (foundInDocs === 0)
    return { status: 'FAILED', summary: `Claim ID not found in any of ${textDocs} document(s).` };
  return { status: 'PASSED', summary: `Claim ID found in ${foundInDocs} of ${textDocs} document(s).` };
}

export function completenessOutcome(
  presentTypeNames: string[],
  requiredTypeNames: string[]
): ValidatorOutcome {
  if (requiredTypeNames.length === 0)
    return { status: 'PASSED', summary: 'No required document types configured.' };
  const missing = requiredTypeNames.filter((t) => !presentTypeNames.includes(t));
  const present = requiredTypeNames.length - missing.length;
  if (missing.length === 0)
    return { status: 'PASSED', summary: `All ${requiredTypeNames.length} required document types present.` };
  return {
    status: 'FAILED',
    summary: `${present} of ${requiredTypeNames.length} required document types present.`,
    details: { missing },
  };
}

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function tokenizeWords(s: string): string[] {
  return s.toLowerCase().match(/[a-z]{3,}/g) ?? [];
}
```

- [ ] **Step 4: Run (expect pass)** — `cd server && npm test -- logic` → PASS.
- [ ] **Step 5: Commit** — `git add server/src/validators/types.ts server/src/validators/logic.ts server/src/validators/__tests__/logic.test.ts && git commit -m "feat(claims): validator types + pure logic"`

### Task 3: FULL + INTRA validators (no heavy deps)

**Files:** Create `server/src/validators/fullValidator.ts`, `intraValidator.ts`, `server/src/validators/__tests__/fullIntra.test.ts`

- [ ] **Step 1: Write the failing test** `server/src/validators/__tests__/fullIntra.test.ts` — self-contained fixtures + a hand-built `ValidatorContext`.

```ts
import { PrismaClient } from '@prisma/client';
import { fullValidator } from '../fullValidator.js';
import { intraValidator } from '../intraValidator.js';
import { ValidatorContext, ValidatorDoc } from '../types.js';
import { getTestPrisma, disconnectTestPrisma, truncateClaimsTables } from '../../__tests__/helpers/testDb.js';

function ctxFor(
  prisma: PrismaClient,
  claim: { id: string; claimId: string; subCategoryId: string },
  documents: ValidatorDoc[],
  shared: Map<string, string>
): ValidatorContext {
  return {
    claim,
    documents,
    prisma,
    fsPort: { stat: async () => ({ exists: false, isDirectory: false, isFile: false, sizeBytes: 0 }), listFiles: async () => [] },
    ocr: { extractImageText: async () => '' },
    shared,
  };
}

describe('FULL + INTRA validators', () => {
  let prisma: PrismaClient;
  let subCategoryId: string;
  let adminId: string;
  const SUF = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let utId: string;
  let ptId: string;
  let catId: string;
  let typeAId: string;
  let typeBId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    adminId = admin!.id;
    const ut = await prisma.userType.create({ data: { name: `val-ut-${SUF}` } });
    const pt = await prisma.projectType.create({ data: { name: `val-pt-${SUF}` } });
    utId = ut.id; ptId = pt.id;
    const cat = await prisma.category.create({ data: { name: `val-cat-${SUF}`, userTypeId: utId, projectTypeId: ptId } });
    catId = cat.id;
    const sc = await prisma.subCategory.create({ data: { name: `val-sc-${SUF}`, categoryId: catId } });
    subCategoryId = sc.id;
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    const a = await prisma.documentTypeMaster.create({ data: { subCategoryId, name: 'Aadhar Card', category: 'GOVT', govtCode: 'AADHAR', displayOrder: 1, createdBy: adminId, updatedBy: adminId } });
    const b = await prisma.documentTypeMaster.create({ data: { subCategoryId, name: 'PAN Card', category: 'GOVT', govtCode: 'PAN', displayOrder: 2, createdBy: adminId, updatedBy: adminId } });
    typeAId = a.id; typeBId = b.id;
  });

  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await prisma.subCategory.deleteMany({ where: { id: subCategoryId } });
    await prisma.category.deleteMany({ where: { id: catId } });
    await prisma.userType.deleteMany({ where: { id: utId } });
    await prisma.projectType.deleteMany({ where: { id: ptId } });
    await disconnectTestPrisma();
  });

  const doc = (over: Partial<ValidatorDoc>): ValidatorDoc => ({
    id: 'd', fileName: 'f', storagePath: 'p', readablePath: 'p', mimeType: 'image/png', source: 'SCANNED', documentTypeId: null, ...over,
  });

  it('FULL fails when a required type is missing, passes when all present', async () => {
    const claim = { id: 'c', claimId: 'CLM1', subCategoryId };
    const onlyA = [doc({ id: 'd1', documentTypeId: typeAId })];
    expect((await fullValidator.run(ctxFor(prisma, claim, onlyA, new Map()))).status).toBe('FAILED');
    const both = [doc({ id: 'd1', documentTypeId: typeAId }), doc({ id: 'd2', documentTypeId: typeBId })];
    expect((await fullValidator.run(ctxFor(prisma, claim, both, new Map()))).status).toBe('PASSED');
  });

  it('INTRA passes when claimId appears in document text', async () => {
    const claim = { id: 'c', claimId: 'CLM-00001', subCategoryId };
    const shared = new Map<string, string>([['d1', 'document for clm00001 here'], ['d2', 'unrelated']]);
    const out = await intraValidator.run(ctxFor(prisma, claim, [], shared));
    expect(out.status).toBe('PASSED');
    const shared2 = new Map<string, string>([['d1', 'nothing matching']]);
    expect((await intraValidator.run(ctxFor(prisma, claim, [], shared2))).status).toBe('FAILED');
  });
});
```

- [ ] **Step 2: Run (expect fail)** — `cd server && npm test -- fullIntra` → FAIL (modules not found).

- [ ] **Step 3: Create `server/src/validators/fullValidator.ts`**

```ts
import { Validator } from './types.js';
import { completenessOutcome } from './logic.js';

export const fullValidator: Validator = {
  key: 'FULL',
  column: 'fullScanStatus',
  async run(ctx) {
    const types = await ctx.prisma.documentTypeMaster.findMany({
      where: { subCategoryId: ctx.claim.subCategoryId, status: 'ACTIVE' },
      select: { id: true, name: true },
    });
    const presentIds = new Set(
      ctx.documents.map((d) => d.documentTypeId).filter((x): x is string => !!x)
    );
    const presentNames = types.filter((t) => presentIds.has(t.id)).map((t) => t.name);
    return completenessOutcome(presentNames, types.map((t) => t.name));
  },
};
```

- [ ] **Step 4: Create `server/src/validators/intraValidator.ts`**

```ts
import { Validator } from './types.js';
import { intraOutcome, normalizeText } from './logic.js';

export const intraValidator: Validator = {
  key: 'INTRA',
  column: 'intraClaimStatus',
  async run(ctx) {
    const target = normalizeText(ctx.claim.claimId);
    const texts = [...ctx.shared.values()];
    if (texts.length === 0 || target.length === 0) return intraOutcome(0, texts.length);
    const found = texts.filter((t) => normalizeText(t).includes(target)).length;
    return intraOutcome(found, texts.length);
  },
};
```

- [ ] **Step 5: Run (expect pass)** — `cd server && npm test -- fullIntra` → PASS.
- [ ] **Step 6: Commit** — `git add server/src/validators/fullValidator.ts server/src/validators/intraValidator.ts server/src/validators/__tests__/fullIntra.test.ts && git commit -m "feat(claims): FULL + INTRA validators"`

### Task 4: ValidationService + serial drainer (fake validators)

**Files:** Create `server/src/services/validationService.ts`, `server/src/services/validationQueue.ts`, `server/src/services/__tests__/validationService.test.ts`

- [ ] **Step 1: Write the failing test** `server/src/services/__tests__/validationService.test.ts`

```ts
import { PrismaClient } from '@prisma/client';
import { ValidationService } from '../validationService.js';
import { enqueue, kickDrain } from '../validationQueue.js';
import { Validator } from '../../validators/types.js';
import { getTestPrisma, disconnectTestPrisma, truncateClaimsTables } from '../../__tests__/helpers/testDb.js';

// Fake validators: one passes, one fails — both deterministic, no I/O.
const fakes: Validator[] = [
  { key: 'FULL', column: 'fullScanStatus', run: async () => ({ status: 'PASSED', summary: 'ok' }) },
  { key: 'SPELL', column: 'spellCheckStatus', run: async () => ({ status: 'FAILED', summary: 'bad' }) },
];

describe('ValidationService + drainer', () => {
  let prisma: PrismaClient;
  let subCategoryId: string;
  let adminId: string;
  let workflowStatusId: string;
  const SUF = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let utId: string; let ptId: string; let catId: string;

  async function makeClaim(claimId: string) {
    return prisma.claim.create({ data: { claimId, subCategoryId, workflowStatusId, createdBy: adminId, updatedBy: adminId } });
  }

  beforeAll(async () => {
    prisma = getTestPrisma();
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    adminId = admin!.id;
    const ut = await prisma.userType.create({ data: { name: `vs-ut-${SUF}` } });
    const pt = await prisma.projectType.create({ data: { name: `vs-pt-${SUF}` } });
    utId = ut.id; ptId = pt.id;
    const cat = await prisma.category.create({ data: { name: `vs-cat-${SUF}`, userTypeId: utId, projectTypeId: ptId } });
    catId = cat.id;
    const sc = await prisma.subCategory.create({ data: { name: `vs-sc-${SUF}`, categoryId: catId } });
    subCategoryId = sc.id;
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    await prisma.validationRun.deleteMany({ where: { claim: { subCategoryId } } });
    const st = await prisma.statusMaster.create({ data: { subCategoryId, name: 'Pending', isDefault: true, createdBy: adminId, updatedBy: adminId } });
    workflowStatusId = st.id;
  });

  afterAll(async () => {
    await prisma.validationRun.deleteMany({ where: { claim: { subCategoryId } } });
    await truncateClaimsTables(prisma);
    await prisma.subCategory.deleteMany({ where: { id: subCategoryId } });
    await prisma.category.deleteMany({ where: { id: catId } });
    await prisma.userType.deleteMany({ where: { id: utId } });
    await prisma.projectType.deleteMany({ where: { id: ptId } });
    await disconnectTestPrisma();
  });

  it('runOne executes validators, writes results, sets columns + COMPLETED', async () => {
    const claim = await makeClaim('C-V1');
    const run = await prisma.validationRun.create({ data: { claimId: claim.id, trigger: 'MANUAL', status: 'QUEUED' } });
    await new ValidationService(prisma, fakes).runOne(run.id);
    const done = await prisma.validationRun.findUnique({ where: { id: run.id } });
    expect(done?.status).toBe('COMPLETED');
    const reloaded = await prisma.claim.findUnique({ where: { id: claim.id } });
    expect(reloaded?.fullScanStatus).toBe('PASSED');
    expect(reloaded?.spellCheckStatus).toBe('FAILED');
    const results = await prisma.validationResult.findMany({ where: { runId: run.id } });
    expect(results.map((r) => r.validatorKey).sort()).toEqual(['FULL', 'SPELL']);
  });

  it('enqueue coalesces and the drainer processes QUEUED runs serially', async () => {
    const c1 = await makeClaim('C-V2');
    const c2 = await makeClaim('C-V3');
    await enqueue(prisma, fakes, c1.id, 'AUTO');
    await enqueue(prisma, fakes, c1.id, 'AUTO'); // coalesced — no second run for c1
    await enqueue(prisma, fakes, c2.id, 'AUTO');
    await kickDrain(prisma, fakes); // await the singleton drain to completion
    const runs = await prisma.validationRun.findMany({ where: { claim: { subCategoryId } } });
    expect(runs.length).toBe(2); // one per claim (coalesced)
    expect(runs.every((r) => r.status === 'COMPLETED')).toBe(true);
  });

  it('sweepStaleRuns fails orphaned RUNNING runs', async () => {
    const claim = await makeClaim('C-V4');
    const run = await prisma.validationRun.create({ data: { claimId: claim.id, trigger: 'AUTO', status: 'RUNNING', startedAt: new Date() } });
    const n = await new ValidationService(prisma, fakes).sweepStaleRuns();
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await prisma.validationRun.findUnique({ where: { id: run.id } }))?.status).toBe('FAILED');
  });
});
```

- [ ] **Step 2: Run (expect fail)** — `cd server && npm test -- validationService` → FAIL (modules not found).

- [ ] **Step 3: Create `server/src/services/validationService.ts`**

```ts
import { PrismaClient, Prisma } from '@prisma/client';
import path from 'path';
import { Validator, ValidatorContext, ValidatorDoc } from '../validators/types.js';
import { resolveScanRoot } from '../lib/directoryReader.js';
import { FsFileSystemPort } from './fsFileSystemPort.js';
import { TesseractOcrPort } from '../lib/ocr.js';

const COLUMNS = [
  'metaExtractionStatus',
  'spellCheckStatus',
  'qrStatus',
  'intraClaimStatus',
  'fullScanStatus',
] as const;

export class ValidationService {
  constructor(private prisma: PrismaClient, private validators: Validator[]) {}

  async runOne(runId: string): Promise<void> {
    const run = await this.prisma.validationRun.findUnique({ where: { id: runId } });
    if (!run) return;
    const claim = await this.prisma.claim.findUnique({
      where: { id: run.claimId },
      include: { documents: true },
    });
    if (!claim) {
      await this.prisma.validationRun.update({
        where: { id: runId },
        data: { status: 'FAILED', message: 'Claim no longer exists', finishedAt: new Date() },
      });
      return;
    }

    try {
      await this.prisma.validationRun.update({
        where: { id: runId },
        data: { status: 'RUNNING', startedAt: new Date() },
      });
      // Reset all five columns to IN_PROGRESS for this run.
      await this.prisma.claim.update({
        where: { id: claim.id },
        data: Object.fromEntries(COLUMNS.map((c) => [c, 'IN_PROGRESS'])),
      });

      const documents: ValidatorDoc[] = claim.documents.map((d) => ({
        id: d.id,
        fileName: d.fileName,
        storagePath: d.storagePath,
        readablePath: d.source === 'SCANNED' ? resolveScanRoot(d.storagePath) : path.resolve(d.storagePath),
        mimeType: d.mimeType,
        source: d.source,
        documentTypeId: d.documentTypeId,
      }));

      const ctx: ValidatorContext = {
        claim: { id: claim.id, claimId: claim.claimId, subCategoryId: claim.subCategoryId },
        documents,
        prisma: this.prisma,
        fsPort: new FsFileSystemPort(),
        ocr: new TesseractOcrPort(),
        shared: new Map<string, string>(),
      };

      for (const v of this.validators) {
        let outcome;
        try {
          outcome = await v.run(ctx);
        } catch (e) {
          outcome = { status: 'FAILED' as const, summary: e instanceof Error ? e.message : 'Validator error' };
        }
        await this.prisma.validationResult.create({
          data: {
            runId,
            claimId: claim.id,
            validatorKey: v.key,
            status: outcome.status,
            summary: outcome.summary.slice(0, 500),
            details: (outcome.details ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          },
        });
        await this.prisma.claim.update({ where: { id: claim.id }, data: { [v.column]: outcome.status } });
      }

      await this.prisma.validationRun.update({
        where: { id: runId },
        data: { status: 'COMPLETED', finishedAt: new Date() },
      });
    } catch (e) {
      await this.prisma.validationRun.update({
        where: { id: runId },
        data: { status: 'FAILED', message: e instanceof Error ? e.message : 'Run failed', finishedAt: new Date() },
      });
    }
  }

  async sweepStaleRuns(): Promise<number> {
    const res = await this.prisma.validationRun.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'FAILED', message: 'Interrupted by server restart', finishedAt: new Date() },
    });
    return res.count;
  }
}
```

- [ ] **Step 4: Create `server/src/services/validationQueue.ts`**

```ts
import { PrismaClient } from '@prisma/client';
import { Validator } from '../validators/types.js';
import { ValidationService } from './validationService.js';

let draining: Promise<void> | null = null;

/** Insert a QUEUED run for the claim (coalescing with any live run), then kick the drainer. */
export async function enqueue(
  prisma: PrismaClient,
  validators: Validator[],
  claimId: string,
  trigger: 'AUTO' | 'MANUAL',
  triggeredBy?: string
): Promise<{ id: string }> {
  const live = await prisma.validationRun.findFirst({
    where: { claimId, status: { in: ['QUEUED', 'RUNNING'] } },
  });
  const run = live
    ? live
    : await prisma.validationRun.create({ data: { claimId, trigger, triggeredBy: triggeredBy ?? null } });
  void kickDrain(prisma, validators);
  return { id: run.id };
}

/** Singleton serial drainer: process QUEUED runs one at a time. Returns when the queue is empty. */
export function kickDrain(prisma: PrismaClient, validators: Validator[]): Promise<void> {
  if (draining) return draining;
  draining = drainLoop(prisma, validators).finally(() => {
    draining = null;
  });
  return draining;
}

async function drainLoop(prisma: PrismaClient, validators: Validator[]): Promise<void> {
  const svc = new ValidationService(prisma, validators);
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const next = await prisma.validationRun.findFirst({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
    });
    if (!next) break;
    await svc.runOne(next.id);
  }
}
```

Note: `validationService.ts` imports `../lib/ocr.js` and validators; those are created in Tasks 5–7. To keep this task self-contained and green, **create a minimal stub `server/src/lib/ocr.ts` now** so the import resolves; Task 5 replaces its body.

- [ ] **Step 5: Create the temporary `server/src/lib/ocr.ts` stub** (Task 5 fills it in):

```ts
import { OcrPort } from '../validators/types.js';

export class TesseractOcrPort implements OcrPort {
  async extractImageText(_absolutePath: string): Promise<string> {
    return '';
  }
}
```

- [ ] **Step 6: Run (expect pass)** — `cd server && npm test -- validationService` → PASS (3/3).
- [ ] **Step 7: Commit** — `git add server/src/services/validationService.ts server/src/services/validationQueue.ts server/src/lib/ocr.ts server/src/services/__tests__/validationService.test.ts && git commit -m "feat(claims): validation engine + serial drainer"`

---

## Phase B — Real validators (heavy deps)

### Task 5: Install deps + OCR wrapper + META validator

**Files:** Modify `server/package.json`; replace `server/src/lib/ocr.ts`; create `server/src/validators/metaValidator.ts`, `server/src/validators/__tests__/metaValidator.test.ts`

- [ ] **Step 1: Install** — `cd server && npm install tesseract.js@5 pdf-parse@1.1.1 && npm install -D @types/pdf-parse`
Expected: added to `server/package.json`.

- [ ] **Step 2: Replace `server/src/lib/ocr.ts`** (verify the installed `tesseract.js` v5 `createWorker('eng')` signature; adapt if different):

```ts
import { createWorker } from 'tesseract.js';
import { OcrPort } from '../validators/types.js';

export class TesseractOcrPort implements OcrPort {
  async extractImageText(absolutePath: string): Promise<string> {
    const worker = await createWorker('eng');
    try {
      const { data } = await worker.recognize(absolutePath);
      return (data.text ?? '').trim();
    } catch {
      return '';
    } finally {
      await worker.terminate();
    }
  }
}
```

- [ ] **Step 3: Create `server/src/validators/metaValidator.ts`**

```ts
import { promises as fs } from 'fs';
// pdf-parse is CJS; default import works with esModuleInterop.
import pdfParse from 'pdf-parse';
import { Validator, ValidatorContext } from './types.js';
import { metaOutcome } from './logic.js';

async function extractText(ctx: ValidatorContext, doc: ValidatorContext['documents'][number]): Promise<string> {
  const mime = doc.mimeType ?? '';
  if (mime.startsWith('image/')) {
    return ctx.ocr.extractImageText(doc.readablePath);
  }
  if (mime === 'application/pdf') {
    try {
      const buf = await fs.readFile(doc.readablePath);
      const data = await pdfParse(buf);
      return (data.text ?? '').trim();
    } catch {
      return '';
    }
  }
  return '';
}

export const metaValidator: Validator = {
  key: 'META',
  column: 'metaExtractionStatus',
  async run(ctx) {
    let withText = 0;
    for (const doc of ctx.documents) {
      const text = await extractText(ctx, doc);
      if (text && text.replace(/\s/g, '').length >= 3) {
        ctx.shared.set(doc.id, text);
        withText++;
      }
    }
    return metaOutcome(withText, ctx.documents.length);
  },
};
```

- [ ] **Step 4: Write a minimal META test** `server/src/validators/__tests__/metaValidator.test.ts` (uses a fake `OcrPort` — fast, no real OCR; the real OCR path is exercised in the manual smoke):

```ts
import { metaValidator } from '../metaValidator.js';
import { ValidatorContext, ValidatorDoc } from '../types.js';

function ctx(documents: ValidatorDoc[], ocrText: string): ValidatorContext {
  return {
    claim: { id: 'c', claimId: 'C1', subCategoryId: 's' },
    documents,
    prisma: {} as never,
    fsPort: { stat: async () => ({ exists: false, isDirectory: false, isFile: false, sizeBytes: 0 }), listFiles: async () => [] },
    ocr: { extractImageText: async () => ocrText },
    shared: new Map(),
  };
}
const doc = (over: Partial<ValidatorDoc>): ValidatorDoc => ({
  id: 'd', fileName: 'f.png', storagePath: 'p', readablePath: 'p', mimeType: 'image/png', source: 'SCANNED', documentTypeId: null, ...over,
});

describe('metaValidator', () => {
  it('PASSES and stashes text when OCR yields text', async () => {
    const c = ctx([doc({ id: 'd1' })], 'hello world');
    const out = await metaValidator.run(c);
    expect(out.status).toBe('PASSED');
    expect(c.shared.get('d1')).toBe('hello world');
  });
  it('FAILS when documents exist but no text extracted', async () => {
    const out = await metaValidator.run(ctx([doc({ id: 'd1' })], '  '));
    expect(out.status).toBe('FAILED');
  });
  it('PASSES (N/A) when there are no documents', async () => {
    expect((await metaValidator.run(ctx([], ''))).status).toBe('PASSED');
  });
});
```

- [ ] **Step 5: Run** — `cd server && npm test -- metaValidator` → PASS (3/3). Then `npx tsc --noEmit` → clean.
- [ ] **Step 6: Commit** — `git add server/package.json server/package-lock.json package-lock.json server/src/lib/ocr.ts server/src/validators/metaValidator.ts server/src/validators/__tests__/metaValidator.test.ts && git commit -m "feat(claims): META validator (OCR + pdf-parse)"`

### Task 6: SPELL validator

**Files:** Modify `server/package.json`; create `server/src/validators/spellValidator.ts`, `server/src/validators/__tests__/spellValidator.test.ts`

- [ ] **Step 1: Install** — `cd server && npm install nspell@2.1.5 dictionary-en@3.2.0`

- [ ] **Step 2: Create `server/src/validators/spellValidator.ts`** (defensive dictionary load handles both callback- and promise-style `dictionary-en`; verify against the installed version and simplify if it exposes one form):

```ts
import nspell from 'nspell';
import enDictionary from 'dictionary-en';
import { Validator } from './types.js';
import { spellOutcome, tokenizeWords } from './logic.js';

type Spell = { correct(word: string): boolean };
let spellPromise: Promise<Spell> | null = null;

async function getSpell(): Promise<Spell> {
  if (!spellPromise) {
    spellPromise = new Promise<Spell>((resolve, reject) => {
      // dictionary-en historically: fn((err, {aff, dic}) => ...). Newer: returns a promise.
      const maybe = (enDictionary as unknown as (cb: (err: Error | null, dict: unknown) => void) => unknown)(
        (err, dict) => (err ? reject(err) : resolve(nspell(dict as never) as Spell))
      );
      if (maybe && typeof (maybe as { then?: unknown }).then === 'function') {
        (maybe as Promise<unknown>).then((dict) => resolve(nspell(dict as never) as Spell), reject);
      }
    });
  }
  return spellPromise;
}

export const spellValidator: Validator = {
  key: 'SPELL',
  column: 'spellCheckStatus',
  async run(ctx) {
    const text = [...ctx.shared.values()].join(' ');
    const words = tokenizeWords(text);
    if (words.length === 0) return spellOutcome(0, 0, []);
    const spell = await getSpell();
    const suspect: string[] = [];
    for (const w of words) {
      if (!spell.correct(w)) suspect.push(w);
    }
    return spellOutcome(suspect.length, words.length, suspect.slice(0, 50));
  },
};
```

- [ ] **Step 3: Write the test** `server/src/validators/__tests__/spellValidator.test.ts`

```ts
import { spellValidator } from '../spellValidator.js';
import { ValidatorContext } from '../types.js';

function ctx(text: string): ValidatorContext {
  return {
    claim: { id: 'c', claimId: 'C1', subCategoryId: 's' },
    documents: [],
    prisma: {} as never,
    fsPort: { stat: async () => ({ exists: false, isDirectory: false, isFile: false, sizeBytes: 0 }), listFiles: async () => [] },
    ocr: { extractImageText: async () => '' },
    shared: new Map(text ? [['d1', text]] : []),
  };
}

describe('spellValidator', () => {
  it('PASSES clean English text', async () => {
    expect((await spellValidator.run(ctx('the quick brown fox jumps over the lazy dog'))).status).toBe('PASSED');
  });
  it('FAILS text that is mostly gibberish', async () => {
    expect((await spellValidator.run(ctx('zzzqqq wwwxxx vvvbbb nnnmmm lkjhg fdsapo iuyt'))).status).toBe('FAILED');
  });
  it('PASSES (N/A) when there is no text', async () => {
    expect((await spellValidator.run(ctx(''))).status).toBe('PASSED');
  });
});
```

- [ ] **Step 4: Run** — `cd server && npm test -- spellValidator` → PASS (3/3). If the dictionary load form differs, adjust `getSpell()` to the installed API, then re-run. Then `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `git add server/package.json server/package-lock.json package-lock.json server/src/validators/spellValidator.ts server/src/validators/__tests__/spellValidator.test.ts && git commit -m "feat(claims): SPELL validator (nspell)"`

### Task 7: QR validator + assemble the registry

**Files:** Modify `server/package.json`; create `server/src/validators/qrValidator.ts`, `server/src/validators/registry.ts`, `server/src/validators/__tests__/qrValidator.test.ts`

- [ ] **Step 1: Install** — `cd server && npm install jimp@0.22.12 jsqr@1.4.0`
(Pin `jimp@0.22` — v1.x changed the import/API. v0.22 uses `import Jimp from 'jimp'` + `Jimp.read` + `.bitmap`.)

- [ ] **Step 2: Create `server/src/validators/qrValidator.ts`**

```ts
import Jimp from 'jimp';
import jsQR from 'jsqr';
import { Validator, ValidatorContext } from './types.js';
import { qrOutcome } from './logic.js';

async function decodeQr(absolutePath: string): Promise<string | null> {
  try {
    const img = await Jimp.read(absolutePath);
    const { data, width, height } = img.bitmap; // RGBA Buffer
    const res = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height);
    return res ? res.data : null;
  } catch {
    return null;
  }
}

export const qrValidator: Validator = {
  key: 'QR',
  column: 'qrStatus',
  async run(ctx: ValidatorContext) {
    const images = ctx.documents.filter((d) => (d.mimeType ?? '').startsWith('image/'));
    const values: string[] = [];
    for (const img of images) {
      const v = await decodeQr(img.readablePath);
      if (v) values.push(v);
    }
    return qrOutcome(values.length, images.length, values);
  },
};
```

- [ ] **Step 3: Create `server/src/validators/registry.ts`** (final ordered list, all five):

```ts
import { Validator } from './types.js';
import { metaValidator } from './metaValidator.js';
import { spellValidator } from './spellValidator.js';
import { intraValidator } from './intraValidator.js';
import { qrValidator } from './qrValidator.js';
import { fullValidator } from './fullValidator.js';

// Order matters: META extracts text first; SPELL + INTRA consume it; QR is independent; FULL aggregates.
export const registry: Validator[] = [metaValidator, spellValidator, intraValidator, qrValidator, fullValidator];
```

- [ ] **Step 4: Write the QR test** `server/src/validators/__tests__/qrValidator.test.ts` (generate a real QR PNG into a temp dir, decode it):

```ts
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import Jimp from 'jimp';
import QRCode from 'qrcode'; // dev-only generator (installed in Step 5)
import { qrValidator } from '../qrValidator.js';
import { ValidatorContext, ValidatorDoc } from '../types.js';

const doc = (over: Partial<ValidatorDoc>): ValidatorDoc => ({
  id: 'd', fileName: 'q.png', storagePath: 'p', readablePath: 'p', mimeType: 'image/png', source: 'UPLOADED', documentTypeId: null, ...over,
});
function ctx(documents: ValidatorDoc[]): ValidatorContext {
  return {
    claim: { id: 'c', claimId: 'C1', subCategoryId: 's' },
    documents,
    prisma: {} as never,
    fsPort: { stat: async () => ({ exists: false, isDirectory: false, isFile: false, sizeBytes: 0 }), listFiles: async () => [] },
    ocr: { extractImageText: async () => '' },
    shared: new Map(),
  };
}

describe('qrValidator', () => {
  let dir: string;
  let qrPath: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-'));
    qrPath = path.join(dir, 'q.png');
    await QRCode.toFile(qrPath, 'CLAIM-PAYLOAD', { width: 256 });
  });
  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('decodes a real QR png', async () => {
    const out = await qrValidator.run(ctx([doc({ readablePath: qrPath })]));
    expect(out.status).toBe('PASSED');
    expect((out.details as { values: string[] }).values).toContain('CLAIM-PAYLOAD');
  });
  it('PASSES (N/A) when there are no image documents', async () => {
    expect((await qrValidator.run(ctx([doc({ mimeType: 'application/pdf' })]))).status).toBe('PASSED');
  });
});
```

- [ ] **Step 5: Install the dev-only QR generator** — `cd server && npm install -D qrcode @types/qrcode`

- [ ] **Step 6: Run** — `cd server && npm test -- qrValidator` → PASS (2/2). Then `npx tsc --noEmit`.
(If `jimp@0.22` import differs, adjust to its README; if `data.buffer` slicing errors, use `new Uint8ClampedArray(data)`.)

- [ ] **Step 7: Commit** — `git add server/package.json server/package-lock.json package-lock.json server/src/validators/qrValidator.ts server/src/validators/registry.ts server/src/validators/__tests__/qrValidator.test.ts && git commit -m "feat(claims): QR validator + validator registry"`

---

## Phase C — Wire triggers + API

### Task 8: Validation routes + auto-triggers + boot

**Files:** Create `server/src/routes/claimValidation.ts`; modify `server/src/routes/claims.ts`, `server/src/routes/claimDocuments.ts`, `server/src/services/scanService.ts`, `server/src/index.ts`

- [ ] **Step 1: Create `server/src/routes/claimValidation.ts`**

```ts
import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { param, validationResult } from 'express-validator';
import { ClaimService } from '../services/claimService.js';
import { enqueue } from '../services/validationQueue.js';
import { registry } from '../validators/registry.js';

const router = Router({ mergeParams: true });

const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0]?.msg, code: 'VALIDATION_ERROR' });
  next();
};
const prismaOf = (req: Request) => req.app.get('prisma') as PrismaClient;
const claimSvc = (req: Request) => new ClaimService(prismaOf(req));

const requireView = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const claim = await claimSvc(req).getById(req.params.id, req.session!.userId, req.session!.role);
    if (!claim) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    next();
  } catch (err) { next(err); }
};

router.post('/validate', [param('id').isUUID()], validate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ok = await claimSvc(req).canEditClaim(req.params.id, req.session!.userId, req.session!.role);
    if (!ok) return res.status(403).json({ error: 'Cannot edit this claim', code: 'CLAIM_NOT_EDITABLE' });
    const run = await enqueue(prismaOf(req), registry, req.params.id, 'MANUAL', req.session!.userId);
    res.status(202).json({ data: { runId: run.id } });
  } catch (err) { next(err); }
});

router.get('/validation', [param('id').isUUID()], validate, requireView, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prisma = prismaOf(req);
    const run = await prisma.validationRun.findFirst({ where: { claimId: req.params.id }, orderBy: { createdAt: 'desc' } });
    const results = run ? await prisma.validationResult.findMany({ where: { runId: run.id } }) : [];
    res.json({ data: { run, results } });
  } catch (err) { next(err); }
});

router.get('/validation/:runId', [param('id').isUUID(), param('runId').isUUID()], validate, requireView, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prisma = prismaOf(req);
    const run = await prisma.validationRun.findFirst({ where: { id: req.params.runId, claimId: req.params.id } });
    if (!run) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    const results = await prisma.validationResult.findMany({ where: { runId: run.id } });
    res.json({ data: { run, results } });
  } catch (err) { next(err); }
});

export default router;
```

- [ ] **Step 2: Mount in `server/src/routes/claims.ts`.** Add import near the other route import:

```ts
import claimValidationRoutes from './claimValidation.js';
```

Add immediately before `export default router;` (next to the documents mount):

```ts
router.use('/:id', claimValidationRoutes);
```

(The `claimValidation` router declares full subpaths `/validate`, `/validation`, `/validation/:runId` and uses `mergeParams`, so mounting at `/:id` exposes `/api/claims/:id/validate` etc.)

- [ ] **Step 3: Auto-trigger after upload + sync in `server/src/routes/claimDocuments.ts`.** Add imports:

```ts
import { enqueue } from '../services/validationQueue.js';
import { registry } from '../validators/registry.js';
```

In the upload handler (`router.post('/', ...)`), after the `for (const f of files) { ... }` loop and before `res.status(201)`, add:

```ts
      void enqueue(prismaOf(req), registry, claim.id, 'AUTO', req.session!.userId);
```

In the sync handler (`router.post('/sync', ...)`), after `const result = await docSvc(req).discoverForClaim(...)` and before `res.json`, add:

```ts
      void enqueue(prismaOf(req), registry, claim.id, 'AUTO', req.session!.userId);
```

- [ ] **Step 4: Auto-trigger after each claim's docs in `server/src/services/scanService.ts`.** This enqueues (does not run inline — the drainer serializes). Add imports:

```ts
import { enqueue } from './validationQueue.js';
import { registry } from '../validators/registry.js';
```

In `run`, inside the `if (claimForDocs && this.documentService) { ... }` block, after the `discoverForClaim` try/catch completes, add (still inside the `if`):

```ts
              void enqueue(this.prisma, registry, claimForDocs.id, 'AUTO', actorId || undefined);
```

- [ ] **Step 5: Boot sweep + drain in `server/src/index.ts`.** Add imports with the others:

```ts
import { ValidationService } from './services/validationService.js';
import { kickDrain } from './services/validationQueue.js';
import { registry } from './validators/registry.js';
```

Inside the `app.listen(PORT, () => { ... })` callback, after the existing scan-sweep block, add:

```ts
  new ValidationService(prisma, registry)
    .sweepStaleRuns()
    .then((n) => {
      if (n > 0) console.log(`Swept ${n} stale validation run(s) to FAILED on startup.`);
      kickDrain(prisma, registry); // resume any QUEUED runs left from before restart
    })
    .catch((e) => console.error('Validation stale-run sweep failed:', e));
```

- [ ] **Step 6: Type-check + full tests + re-seed**

Run: `cd server && npx tsc --noEmit && npm test`
Then: `npm run db:seed` (repo root).
Expected: tsc clean; all suites pass; seed completes.

- [ ] **Step 7: Commit** — `git add server/src/routes/claimValidation.ts server/src/routes/claims.ts server/src/routes/claimDocuments.ts server/src/services/scanService.ts server/src/index.ts && git commit -m "feat(claims): validation routes + auto-triggers + boot drain"`

---

## Phase D — Frontend

### Task 9: Live validation badges + Validate button on Claim Update

**Files:** Modify `client/src/pages/claims/ClaimUpdate.tsx`

- [ ] **Step 1: Add types + a status-color helper** after the `DocItem` interface:

```tsx
interface ValResult {
  validatorKey: 'META' | 'SPELL' | 'QR' | 'INTRA' | 'FULL';
  status: 'PENDING' | 'IN_PROGRESS' | 'PASSED' | 'FAILED';
  summary: string | null;
}
interface ValRun {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  trigger: 'AUTO' | 'MANUAL';
  finishedAt: string | null;
}
function statusVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (s === 'PASSED') return 'default';
  if (s === 'FAILED') return 'destructive';
  if (s === 'IN_PROGRESS') return 'secondary';
  return 'outline';
}
const VALIDATORS: { key: ValResult['validatorKey']; label: string; column: keyof ClaimDetail }[] = [
  { key: 'SPELL', label: 'Spell', column: 'spellCheckStatus' },
  { key: 'QR', label: 'QR', column: 'qrStatus' },
  { key: 'META', label: 'Meta', column: 'metaExtractionStatus' },
  { key: 'INTRA', label: 'Intra-Claim', column: 'intraClaimStatus' },
  { key: 'FULL', label: 'Full Scan', column: 'fullScanStatus' },
];
```

- [ ] **Step 2: Add validation state + fetch + trigger + polling** after the document handlers (after `handleDeleteDoc`):

```tsx
  const [valRun, setValRun] = useState<ValRun | null>(null);
  const [valResults, setValResults] = useState<ValResult[]>([]);
  const [isValidating, setIsValidating] = useState(false);

  const fetchValidation = async () => {
    try {
      const r = await api.get<{ data: { run: ValRun | null; results: ValResult[] } }>(`/claims/${id}/validation`);
      setValRun(r.data.run);
      setValResults(r.data.results);
    } catch {
      /* none yet */
    }
  };

  useEffect(() => {
    if (claim) fetchValidation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim?.id]);

  useEffect(() => {
    if (!valRun || valRun.status === 'COMPLETED' || valRun.status === 'FAILED') return;
    const t = setInterval(fetchValidation, 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valRun?.status]);

  const handleValidate = async () => {
    setIsValidating(true);
    try {
      await api.post(`/claims/${id}/validate`, {});
      toast({ title: 'Validation started' });
      await fetchValidation();
      fetchClaim();
    } catch (err) {
      toast({ title: 'Could not start validation', variant: 'destructive', description: err instanceof Error ? err.message : '' });
    } finally {
      setIsValidating(false);
    }
  };

  const resultFor = (key: ValResult['validatorKey']) => valResults.find((r) => r.validatorKey === key);
```

- [ ] **Step 3: Replace the static validation badge row.** Replace this block (the five `<Badge variant="outline">…` lines in the metadata card):

```tsx
        <div className="flex flex-wrap gap-2 mt-4">
          <Badge variant="outline">Spell: {claim.spellCheckStatus}</Badge>
          <Badge variant="outline">QR: {claim.qrStatus}</Badge>
          <Badge variant="outline">Meta: {claim.metaExtractionStatus}</Badge>
          <Badge variant="outline">Intra-Claim: {claim.intraClaimStatus}</Badge>
          <Badge variant="outline">Full Scan: {claim.fullScanStatus}</Badge>
        </div>
```

with:

```tsx
        <div className="flex items-center justify-between mt-4">
          <div className="flex flex-wrap gap-2">
            {VALIDATORS.map((v) => {
              const colVal = String(claim[v.column]);
              const res = resultFor(v.key);
              return (
                <Badge key={v.key} variant={statusVariant(colVal)} title={res?.summary ?? ''}>
                  {v.label}: {colVal}
                </Badge>
              );
            })}
          </div>
          {canEdit && (
            <Button size="sm" variant="outline" onClick={handleValidate} disabled={isValidating || valRun?.status === 'RUNNING' || valRun?.status === 'QUEUED'}>
              {valRun?.status === 'RUNNING' || valRun?.status === 'QUEUED' ? 'Validating…' : 'Validate'}
            </Button>
          )}
        </div>
        {valResults.length > 0 && (
          <div className="mt-3 space-y-1 text-sm text-gray-600">
            {VALIDATORS.map((v) => {
              const res = resultFor(v.key);
              if (!res) return null;
              return (
                <div key={v.key}>
                  <span className="font-medium">{v.label}:</span> {res.summary}
                </div>
              );
            })}
          </div>
        )}
```

- [ ] **Step 4: Type-check** — `cd client && npx tsc --noEmit` → clean. (When the run completes, `fetchClaim()` refreshes the column values the badges read.)

- [ ] **Step 5: Commit** — `git add client/src/pages/claims/ClaimUpdate.tsx && git commit -m "feat(claims): live validation badges + Validate button"`

---

## Phase E — Verification

### Task 10: End-to-end verification

- [ ] **Step 1: Backend green + re-seed**

Run: `cd server && npx tsc --noEmit && npm test`
Then: `npm run db:seed` (repo root).
Expected: all suites pass (existing 63 + logic + fullIntra + validationService + metaValidator + spellValidator + qrValidator); seed completes.

- [ ] **Step 2: Frontend green** — `cd client && npx tsc --noEmit` → clean.

- [ ] **Step 3: Manual smoke (macOS via fixtures)**

```bash
mkdir -p /tmp/claimroot/Claims/Daily/CLM00061_x
# A QR image, a text image, and the required doc-type names in filenames:
node -e "require('/Users/adityakdevin/Projects/exceledunet/proxyURLApp/server/node_modules/qrcode').toFile('/tmp/claimroot/Claims/Daily/CLM00061_x/aadhar_qr.png','CLM00061',{width:256})"
# (notes.txt etc. optional)
CLAIMS_SCAN_ROOT=/tmp/claimroot UPLOADS_ROOT=/tmp/uploads PORT=3010 npx tsx server/src/index.ts
```
As admin: Claim ID Rules → **Scan now** (ingests CLM00061 + its docs, auto-enqueues validation). Open the claim → badges go `IN_PROGRESS` then settle (QR `PASSED` from the QR png; FULL likely `FAILED` if not all required doc types present; etc.). Click **Validate** to re-run. Confirm summaries show ("1 QR code found", "P of R required document types present").

- [ ] **Step 4: Final status** — `git status` (clean if committing per task).

---

## Self-Review (completed during plan writing)

- **Spec coverage:** models + enums + relations (T1) ✓ · Validator interface + pure logic + thresholds (T2) ✓ · FULL completeness + INTRA claimId-presence (T3) ✓ · engine runOne lifecycle (IN_PROGRESS→result→COMPLETED) + serial drainer + coalesce + sweep (T4) ✓ · META OCR+pdf-parse stashing text (T5) ✓ · SPELL ratio threshold (T6) ✓ · QR jimp+jsqr + registry order META→SPELL→INTRA→QR→FULL (T7) ✓ · validate/get API + auto-triggers (scan/upload/sync) + manual + boot drain/sweep (T8) ✓ · live badges + Validate + polling + summaries (T9) ✓ · pure-logic + engine tests fast/macOS-runnable, adapters with tiny real fixtures (T2–T7, T10) ✓.
- **Placeholder scan:** none — every code step is complete. The two library-API caveats (jimp@0.22 import, dictionary-en load form) are pinned + handled defensively with explicit "verify installed API" instructions; not placeholders.
- **Type consistency:** `Validator`/`ValidatorContext`/`ValidatorOutcome`/`OcrPort`/`ValidatorDoc` (incl. `readablePath`, `documentTypeId`), `ValidationService(prisma, validators)`, `enqueue(prisma, validators, claimId, trigger, triggeredBy?)`, `kickDrain(prisma, validators)`, `registry` order, and the client `ValResult`/`ValRun`/`VALIDATORS` shapes are consistent across tasks.
- **Notes:** (1) Task 4 creates a temporary `lib/ocr.ts` stub so the engine compiles before Task 5 fills it — flagged explicitly. (2) Columns are set to `IN_PROGRESS` at run start and to each validator's result as it finishes; a fatal run error leaves columns at their last value (documented). (3) Auto-validation on a bulk scan builds a serial drain backlog — the spec's documented scalability limit.
