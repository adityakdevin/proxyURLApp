import os from 'os';
import path from 'path';
import type { Express } from 'express';
import { PrismaClient } from '@prisma/client';
import { makeTestApp } from './helpers/app.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../helpers/testDb.js';
import {
  seedScopeGraph,
  seedStatuses,
  cleanupScopeGraph,
  type ScopeGraph,
} from './helpers/factories.js';
import { loginAs, waitForValidation } from './helpers/auth.js';

// 1x1 transparent PNG — a valid, tiny upload payload.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// Heavy doc-upload validation runs OCR (tesseract) in the background — opt in
// with E2E_HEAVY=1 to keep the default suite fast and offline-friendly.
const heavy = process.env.E2E_HEAVY === '1';
const itHeavy = heavy ? it : it.skip;

describe('E2E: documents + validation', () => {
  let app: Express;
  let prisma: PrismaClient;
  let g: ScopeGraph;

  beforeAll(async () => {
    prisma = getTestPrisma();
    app = makeTestApp();
    // Keep uploaded test files out of the repo tree.
    process.env.UPLOADS_ROOT = path.join(os.tmpdir(), `proxyapp-e2e-uploads-${Date.now()}`);
    g = await seedScopeGraph(prisma, 'docs');
  });

  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await cleanupScopeGraph(prisma, g);
    await disconnectTestPrisma();
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    await seedStatuses(prisma, g.subCategoryId, g.admin.id);
  });

  it('marks a zero-document claim DOCS_NOT_AVAILABLE after validation', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const created = await tl
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-NODOCS' });
    const id = created.body.data.id as string;

    const triggered = await tl.post(`/api/claims/${id}/validate`);
    expect(triggered.status).toBe(202);
    expect(triggered.body.data.runId).toBeDefined();

    const { status } = await waitForValidation(tl, id);
    expect(status).toBe('COMPLETED');

    const reloaded = await tl.get(`/api/claims/${id}`);
    const claim = reloaded.body.data;
    for (const col of [
      'spellCheckStatus',
      'qrStatus',
      'metaExtractionStatus',
      'intraClaimStatus',
      'fullScanStatus',
    ]) {
      expect(claim[col]).toBe('DOCS_NOT_AVAILABLE');
    }
  });

  itHeavy('uploads a document, lists it, and deletes it (E2E_HEAVY)', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const created = await tl
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-UPLOAD' });
    const id = created.body.data.id as string;

    const upload = await tl
      .post(`/api/claims/${id}/documents`)
      .attach('files', PNG_1x1, 'evidence.png');
    expect(upload.status).toBe(201);
    expect(upload.body.data).toHaveLength(1);

    const list = await tl.get(`/api/claims/${id}/documents`);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBe(1);

    const docId = list.body.data[0].id as string;
    const del = await tl.delete(`/api/claims/${id}/documents/${docId}`);
    expect(del.status).toBe(200);

    // Let the fire-and-forget AUTO validation drain before teardown.
    await waitForValidation(tl, id, { timeoutMs: 25000 }).catch(() => undefined);
  });
});
