import fsSync, { promises as fs, type ReadStream } from 'fs';
import type { IncomingMessage } from 'http';
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

  it('answers 404 when the file cannot be read after stat, instead of crashing', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const created = await tl
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-UNREADABLE' });
    const id = created.body.data.id as string;

    // stat() succeeds on a directory but reading it fails with EISDIR, an error that comes
    // with no HTTP status. send stops before setting the file's headers here; the file that
    // cannot be opened, below, is the case that has them.
    const storagePath = path.join(process.env.UPLOADS_ROOT!, id, 'gone.pdf');
    await fs.mkdir(storagePath, { recursive: true });
    const doc = await prisma.document.create({
      data: { claimId: id, source: 'UPLOADED', fileName: 'gone.pdf', storagePath },
    });

    const res = await tl.get(`/api/claims/${id}/documents/${doc.id}/content`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'File not found', code: 'FILE_NOT_FOUND' });
    expect(res.headers['content-disposition']).toBeUndefined();
    // No ETag at all: res.json would add one of its own (the app's 'etag' setting).
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  // A file that stats but cannot be opened: a sharing lock (EBUSY) or an ACL on the scan share.
  // send has set the file's ETag and Content-Length by then; a POSIX mode of 000 gets the same
  // EACCES, except for root, which ignores it.
  const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0;
  (canDenyRead ? it : it.skip)('answers a file that cannot be opened with a complete, uncached JSON 500', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const created = await tl
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-LOCKED' });
    const id = created.body.data.id as string;

    const storagePath = path.join(process.env.UPLOADS_ROOT!, id, 'locked.pdf');
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, Buffer.alloc(4096, 1));
    await fs.chmod(storagePath, 0o000);
    try {
      const doc = await prisma.document.create({
        data: { claimId: id, source: 'UPLOADED', fileName: 'locked.pdf', storagePath, mimeType: 'application/pdf' },
      });
      const res = await tl.get(`/api/claims/${id}/documents/${doc.id}/content`).timeout(5000);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal Server Error', code: 'FILE_READ_FAILED' });
      // The file's own length would leave the client waiting for 4096 bytes.
      expect(res.headers['content-length']).toBe(String(Buffer.byteLength(JSON.stringify(res.body))));
      expect(res.headers.etag).toBeUndefined();
      expect(res.headers['cache-control']).toBe('no-store');
    } finally {
      await fs.chmod(storagePath, 0o644);
    }
  });

  it('keeps the status send gives a failed precondition, uncached', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const created = await tl
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-PRECONDITION' });
    const id = created.body.data.id as string;

    const storagePath = path.join(process.env.UPLOADS_ROOT!, id, 'policy.pdf');
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, '%PDF-1.4\n');
    const doc = await prisma.document.create({
      data: { claimId: id, source: 'UPLOADED', fileName: 'policy.pdf', storagePath, mimeType: 'application/pdf' },
    });

    const res = await tl
      .get(`/api/claims/${id}/documents/${doc.id}/content`)
      .set('If-Match', '"not-this-file"');
    expect(res.status).toBe(412);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({ error: 'Precondition Failed', code: 'FILE_READ_FAILED' });
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers 404 for a scanned document whose path is not absolute', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const created = await tl
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-RELATIVE' });
    const id = created.body.data.id as string;

    // With CLAIMS_SCAN_ROOT unset the stored path is served as-is, and sendFile throws a
    // TypeError for a relative one (or a Windows path on a non-Windows host).
    const prevRoot = process.env.CLAIMS_SCAN_ROOT;
    delete process.env.CLAIMS_SCAN_ROOT;
    try {
      const doc = await prisma.document.create({
        data: { claimId: id, source: 'SCANNED', fileName: 'scan.pdf', storagePath: 'scans/scan.pdf' },
      });
      const res = await tl.get(`/api/claims/${id}/documents/${doc.id}/content`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'File not found', code: 'FILE_NOT_FOUND' });
      expect(res.headers['content-disposition']).toBeUndefined();
    } finally {
      if (prevRoot !== undefined) process.env.CLAIMS_SCAN_ROOT = prevRoot;
    }
  });

  it('serves an empty document as an empty 200', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const created = await tl
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-EMPTYDOC' });
    const id = created.body.data.id as string;

    const storagePath = path.join(process.env.UPLOADS_ROOT!, id, 'empty.pdf');
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, '');
    const doc = await prisma.document.create({
      data: { claimId: id, source: 'UPLOADED', fileName: 'empty.pdf', storagePath, mimeType: 'application/pdf' },
    });

    const res = await tl.get(`/api/claims/${id}/documents/${doc.id}/content`).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe('0');
    expect(res.body.length).toBe(0);
  });

  it('serves the file bytes with its type and disposition, from a dot-segment path too', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const created = await tl
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-SERVED' });
    const id = created.body.data.id as string;

    // A dot segment, as scan-share paths can have: sendFile's default would 404 it.
    const storagePath = path.join(process.env.UPLOADS_ROOT!, id, '.scans', 'policy copy.pdf');
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    const bytes = Buffer.from('%PDF-1.4\n% not a real document\n');
    await fs.writeFile(storagePath, bytes);
    const doc = await prisma.document.create({
      data: { claimId: id, source: 'UPLOADED', fileName: 'policy copy.pdf', storagePath, mimeType: 'application/pdf' },
    });

    const res = await tl.get(`/api/claims/${id}/documents/${doc.id}/content`).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline; filename="policy%20copy.pdf"');
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(Buffer.from(res.body as Buffer).equals(bytes)).toBe(true);
    // No ranges and no cache lifetime: every view revalidates against Express's app-level ETag.
    expect(res.headers['accept-ranges']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers.etag).toBeDefined();
    expect(res.headers['last-modified']).toBeUndefined();
  });

  it('closes the file when the client aborts mid-download', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const created = await tl
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-ABORTED' });
    const id = created.body.data.id as string;

    // Big enough that the response is still streaming when the client hangs up.
    const storagePath = path.join(process.env.UPLOADS_ROOT!, id, 'big.pdf');
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, Buffer.alloc(16 * 1024 * 1024));
    const doc = await prisma.document.create({
      data: { claimId: id, source: 'UPLOADED', fileName: 'big.pdf', storagePath, mimeType: 'application/pdf' },
    });

    const opened: ReadStream[] = [];
    const real = fsSync.createReadStream;
    const spy = jest.spyOn(fsSync, 'createReadStream').mockImplementation(((...args: Parameters<typeof real>) => {
      const s = real(...args);
      opened.push(s);
      return s;
    }) as typeof real);
    try {
      await tl
        .get(`/api/claims/${id}/documents/${doc.id}/content`)
        .buffer(false)
        .parse((res, done) => {
          // superagent types this as its Response; at runtime it is the raw IncomingMessage.
          const raw = res as unknown as IncomingMessage;
          raw.once('data', () => {
            raw.destroy();
            done(null, null);
          });
        })
        .catch(() => undefined);

      // pipe() only unpipes on an aborted response; without an explicit destroy the
      // ReadStream stays paused with its fd open (a held handle on the scan share).
      expect(opened).toHaveLength(1);
      await waitUntil(() => opened[0].destroyed);
      expect(opened[0].destroyed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setImmediate(r));
  }
}
