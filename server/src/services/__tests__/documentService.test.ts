import { PrismaClient } from '@prisma/client';
import path from 'path';
import { DocumentService } from '../documentService.js';
import { FileSystemPort, FileEntry, PathStat } from '../../lib/fileSystemPort.js';
import { uploadsRoot } from '../../lib/uploadPaths.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

class FakeFs implements FileSystemPort {
  constructor(
    private stats: Record<string, PathStat>,
    private files: Record<string, FileEntry[]>
  ) {}
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
    const pt = await prisma.project.create({ data: { name: `doc-pt-${SUF}` } });
    ptId = pt.id;
    const cat = await prisma.category.create({
      data: { name: `doc-cat-${SUF}`, projectId: ptId },
    });
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
      data: {
        subCategoryId,
        name: 'Aadhar Card',
        category: 'GOVT',
        govtCode: 'AADHAR',
        displayOrder: 1,
        createdBy: adminId,
        updatedBy: adminId,
      },
    });
  });

  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await prisma.subCategory.deleteMany({ where: { id: subCategoryId } });
    await prisma.category.deleteMany({ where: { id: catId } });
    await prisma.project.deleteMany({ where: { id: ptId } });
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
    expect(aadhar.documentTypeId).not.toBeNull();
    expect(aadhar.source).toBe('SCANNED');
    expect(aadhar.storagePath).toBe(path.win32.join(folder, 'aadhar_front.pdf'));
    expect(docs.find((d) => d.fileName === 'misc.txt')!.documentTypeId).toBeNull();

    const r2 = await svc.discoverForClaim(claim, adminId);
    expect(r2).toEqual({ created: 0, skipped: 2 });
    expect(await prisma.document.count({ where: { claimId: claim.id } })).toBe(2);
  });

  it('treats a FILE claim folderPath as its single document', async () => {
    const claim = await makeClaim('C-DOC2', 'D:\\Claims\\Files\\C-DOC2_scan.pdf');
    const fp = claim.folderPath as string;
    const fake = new FakeFs({ [fp]: { exists: true, isDirectory: false, isFile: true, sizeBytes: 99 } }, {});
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

  describe('resolveServingPath containment (UPLOADED)', () => {
    it('returns the path for an in-root doc and null for a traversal escape', async () => {
      const claim = await makeClaim('C-SERVE', null);
      const inRoot = path.join(uploadsRoot(), claim.id, 'ok.pdf');
      const good = await prisma.document.create({
        data: { claimId: claim.id, source: 'UPLOADED', fileName: 'ok.pdf', storagePath: inRoot },
      });
      const escape = path.join(uploadsRoot(), claim.id, '..', '..', 'etc', 'passwd');
      const bad = await prisma.document.create({
        data: { claimId: claim.id, source: 'UPLOADED', fileName: 'passwd', storagePath: escape },
      });
      const svc = new DocumentService(prisma, new FakeFs({}, {}));
      const okResolved = await svc.resolveServingPath(good.id);
      expect(okResolved?.absolutePath).toBe(path.resolve(inRoot));
      expect(await svc.resolveServingPath(bad.id)).toBeNull();
    });
  });

  it('delete removes the row for an UPLOADED doc and is a no-op when already gone', async () => {
    const claim = await makeClaim('C-DELDOC', null);
    const doc = await prisma.document.create({
      data: {
        claimId: claim.id,
        source: 'UPLOADED',
        fileName: 'x.pdf',
        storagePath: path.join(uploadsRoot(), claim.id, 'x.pdf'),
      },
    });
    const svc = new DocumentService(prisma, new FakeFs({}, {}));
    // File never existed on disk → ENOENT is swallowed and the row is removed.
    await svc.delete(doc.id);
    expect(await prisma.document.findUnique({ where: { id: doc.id } })).toBeNull();
    // Deleting an already-removed doc must not throw.
    await expect(svc.delete(doc.id)).resolves.toBeUndefined();
  });
});
