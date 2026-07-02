import { PrismaClient } from '@prisma/client';
import { ScanService } from '../scanService.js';
import { StatusMasterService } from '../statusMasterService.js';
import { DirectoryReader, DirectoryEntry } from '../../lib/directoryReader.js';
import { DocumentService } from '../documentService.js';
import { FileSystemPort, FileEntry, PathStat } from '../../lib/fileSystemPort.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

class FakeReader implements DirectoryReader {
  constructor(private names: string[]) {}
  async list(): Promise<DirectoryEntry[]> {
    return this.names.map((name) => ({ name }));
  }
}

class FakeFs implements FileSystemPort {
  constructor(private files: Record<string, FileEntry[]>) {}
  async stat(): Promise<PathStat> {
    return { exists: true, isDirectory: true, isFile: false, sizeBytes: 0 };
  }
  async listFiles(p: string): Promise<FileEntry[]> {
    return this.files[p] ?? [{ name: 'doc.pdf', sizeBytes: 5 }];
  }
}

describe('ScanService', () => {
  let prisma: PrismaClient;
  let statusService: StatusMasterService;
  let subCategoryId: string;
  let ruleId: string;
  let adminId: string;
  const SUF = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let ptId: string;
  let catId: string;

  async function makeRule() {
    const rule = await prisma.claimIdRule.create({
      data: {
        subCategoryId,
        startPosition: 1,
        length: 8,
        scanTarget: 'FOLDER',
        scanLocation: 'D:\\Claims\\Daily',
        createdBy: adminId,
        updatedBy: adminId,
      },
    });
    return rule.id;
  }

  beforeAll(async () => {
    prisma = getTestPrisma();
    statusService = new StatusMasterService(prisma);
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    if (!admin) throw new Error('Need an ADMIN user seeded');
    adminId = admin.id;
    const pt = await prisma.project.create({ data: { name: `scan-pt-${SUF}` } });
    ptId = pt.id;
    const cat = await prisma.category.create({
      data: { name: `scan-cat-${SUF}`, projectId: ptId },
    });
    catId = cat.id;
    const sc = await prisma.subCategory.create({
      data: { name: `scan-sc-${SUF}`, categoryId: catId },
    });
    subCategoryId = sc.id;
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    await prisma.scanJob.deleteMany({ where: { subCategoryId } });
    ruleId = await makeRule();
  });

  afterAll(async () => {
    await prisma.scanJob.deleteMany({ where: { subCategoryId } });
    await truncateClaimsTables(prisma);
    await prisma.subCategory.deleteMany({ where: { id: subCategoryId } });
    await prisma.category.deleteMany({ where: { id: catId } });
    await prisma.project.deleteMany({ where: { id: ptId } });
    await disconnectTestPrisma();
  });

  it('enqueue rejects when SubCategory has no active default status', async () => {
    const svc = new ScanService(prisma, new FakeReader([]));
    await expect(svc.enqueue(ruleId, adminId)).rejects.toMatchObject({ code: 'NO_DEFAULT_STATUS' });
  });

  it('enqueue creates a QUEUED job when a default status exists', async () => {
    await statusService.create({ subCategoryId, name: 'Pending', isDefault: true }, adminId);
    const svc = new ScanService(prisma, new FakeReader([]));
    const job = await svc.enqueue(ruleId, adminId);
    expect(job.status).toBe('QUEUED');
    expect(job.scanLocation).toBe('D:\\Claims\\Daily');
  });

  it('enqueue rejects a second concurrent scan for the same rule', async () => {
    await statusService.create({ subCategoryId, name: 'Pending', isDefault: true }, adminId);
    const svc = new ScanService(prisma, new FakeReader([]));
    await svc.enqueue(ruleId, adminId);
    await expect(svc.enqueue(ruleId, adminId)).rejects.toMatchObject({ code: 'SCAN_IN_PROGRESS' });
  });

  it('run ingests new claims, counts skips and errors, and is idempotent', async () => {
    await statusService.create({ subCategoryId, name: 'Pending', isDefault: true }, adminId);
    // 3 valid (>=8 chars), 1 too-short → 3 creatable, 1 error.
    const reader = new FakeReader(['CLM00001', 'CLM00002', 'SHORT', 'CLM00003']);
    const svc = new ScanService(prisma, reader);

    const job1 = await svc.enqueue(ruleId, adminId);
    await svc.run(job1.id);
    const done1 = await prisma.scanJob.findUnique({ where: { id: job1.id } });
    expect(done1?.status).toBe('COMPLETED');
    expect(done1?.totalEntries).toBe(4);
    expect(done1?.createdCount).toBe(3);
    expect(done1?.skippedCount).toBe(0);
    expect(done1?.errorCount).toBe(1);
    expect(await prisma.claim.count({ where: { subCategoryId } })).toBe(3);

    // Re-scan: everything already exists → all skipped, no new claims.
    const job2 = await svc.enqueue(ruleId, adminId);
    await svc.run(job2.id);
    const done2 = await prisma.scanJob.findUnique({ where: { id: job2.id } });
    expect(done2?.createdCount).toBe(0);
    expect(done2?.skippedCount).toBe(3);
    expect(await prisma.claim.count({ where: { subCategoryId } })).toBe(3);
  });

  it('run stores the Windows folderPath on created claims', async () => {
    await statusService.create({ subCategoryId, name: 'Pending', isDefault: true }, adminId);
    const svc = new ScanService(prisma, new FakeReader(['CLM00009']));
    const job = await svc.enqueue(ruleId, adminId);
    await svc.run(job.id);
    const claim = await prisma.claim.findFirst({ where: { subCategoryId, claimId: 'CLM00009' } });
    expect(claim?.folderPath).toBe('D:\\Claims\\Daily\\CLM00009');
  });

  it('sweepStaleJobs marks QUEUED/RUNNING jobs as FAILED', async () => {
    await statusService.create({ subCategoryId, name: 'Pending', isDefault: true }, adminId);
    const svc = new ScanService(prisma, new FakeReader([]));
    const job = await svc.enqueue(ruleId, adminId); // QUEUED
    const n = await svc.sweepStaleJobs();
    expect(n).toBeGreaterThanOrEqual(1);
    const swept = await prisma.scanJob.findUnique({ where: { id: job.id } });
    expect(swept?.status).toBe('FAILED');
    expect(swept?.message).toBe('Interrupted by server restart');
  });

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

  it('fires onClaimIngested only when documents were created, not on doc-less re-scans', async () => {
    await statusService.create({ subCategoryId, name: 'Pending', isDefault: true }, adminId);
    const reader = new FakeReader(['CLM00041']);
    const docService = new DocumentService(prisma, new FakeFs({}));
    const ingested: string[] = [];
    const svc = new ScanService(prisma, reader, docService, (claimId) => {
      ingested.push(claimId);
    });

    const job1 = await svc.enqueue(ruleId, adminId);
    await svc.run(job1.id);
    const claim = await prisma.claim.findFirst({ where: { subCategoryId, claimId: 'CLM00041' } });
    expect(ingested).toEqual([claim!.id]); // one doc created → hook fires once

    // Re-scan: claim and its document already exist → nothing created → no re-validate.
    ingested.length = 0;
    const job2 = await svc.enqueue(ruleId, adminId);
    await svc.run(job2.id);
    expect(ingested).toEqual([]);
  });
});
