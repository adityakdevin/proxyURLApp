import { PrismaClient } from '@prisma/client';
import { fullValidator } from '../fullValidator.js';
import { intraValidator } from '../intraValidator.js';
import { ValidatorContext, ValidatorDoc } from '../types.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

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
    ocr: { extractImageText: async () => '' },
    shared,
    wordBoxes: new Map(),
    pageTexts: new Map(),
  };
}

describe('FULL + INTRA validators', () => {
  let prisma: PrismaClient;
  let subCategoryId: string;
  let adminId: string;
  const SUF = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let ptId: string;
  let catId: string;
  let typeAId: string;
  let typeBId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    adminId = admin!.id;
    const pt = await prisma.project.create({ data: { name: `val-pt-${SUF}` } });
    ptId = pt.id;
    const cat = await prisma.category.create({
      data: { name: `val-cat-${SUF}`, projectId: ptId },
    });
    catId = cat.id;
    const sc = await prisma.subCategory.create({ data: { name: `val-sc-${SUF}`, categoryId: catId } });
    subCategoryId = sc.id;
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    const a = await prisma.documentTypeMaster.create({
      // isRequired is explicit: it defaults to FALSE (a type is required only when someone
      // ticks it), and this test is about what happens when a REQUIRED type is missing.
      // Without it the validator finds zero required types and correctly passes, so the
      // case the test names was never actually exercised.
      data: { name: 'Aadhar Card', category: 'GOVT', govtCode: 'AADHAR', isRequired: true, displayOrder: 1, createdBy: adminId, updatedBy: adminId },
    });
    const b = await prisma.documentTypeMaster.create({
      data: { name: 'PAN Card', category: 'GOVT', govtCode: 'PAN', isRequired: true, displayOrder: 2, createdBy: adminId, updatedBy: adminId },
    });
    typeAId = a.id;
    typeBId = b.id;
  });

  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await prisma.subCategory.deleteMany({ where: { id: subCategoryId } });
    await prisma.category.deleteMany({ where: { id: catId } });
    await prisma.project.deleteMany({ where: { id: ptId } });
    await disconnectTestPrisma();
  });

  const doc = (over: Partial<ValidatorDoc>): ValidatorDoc => ({
    id: 'd',
    fileName: 'f',
    storagePath: 'p',
    readablePath: 'p',
    mimeType: 'image/png',
    source: 'SCANNED',
    documentTypeId: null,
    ...over,
  });

  it('FULL fails when a required type is missing, passes when all present', async () => {
    const claim = { id: 'c', claimId: 'CLM1', subCategoryId };
    const onlyA = [doc({ id: 'd1', documentTypeId: typeAId })];
    expect((await fullValidator.run(ctxFor(prisma, claim, onlyA, new Map()))).status).toBe('FAILED');
    const both = [doc({ id: 'd1', documentTypeId: typeAId }), doc({ id: 'd2', documentTypeId: typeBId })];
    expect((await fullValidator.run(ctxFor(prisma, claim, both, new Map()))).status).toBe('PASSED');
  });

  it('reports a cross-document mismatch, and fails on it even when the documents are all there', async () => {
    // The comparison used to run under REDFLAG, so the tab named after comparing documents
    // did not compare them. Red Flags keeps the format rules; a value that disagrees
    // BETWEEN documents belongs here, next to the question of which documents are present.
    const claim = { id: 'c', claimId: 'CLM1', subCategoryId };
    const docs = [doc({ id: 'd1', documentTypeId: typeAId }), doc({ id: 'd2', documentTypeId: typeBId })];
    const shared = new Map([
      ['d1', 'TAX INVOICE Invoice No 1\nChassis No: MAT1234567890'],
      ['d2', 'Policy No 9 Insured X Premium 1 Sum Insured 2\nChassis Number: MAT9999999999'],
    ]);
    const out = await fullValidator.run(ctxFor(prisma, claim, docs, shared));

    expect(out.status).toBe('FAILED');
    expect(out.summary).toContain('cross-document mismatch');
    const mm = out.findings!.find((f) => f.code === 'CROSS_CHASSIS_MISMATCH');
    expect(mm).toBeDefined();
    // The finding names the document it came from, unlike a missing-type finding which is
    // claim-level and carries no document at all.
    expect(mm!.documentId).toBeTruthy();
    expect(out.findings!.some((f) => f.code === 'FULL_MISSING_TYPE')).toBe(false);
  });

  it('INTRA passes when claimId appears in document text', async () => {
    const claim = { id: 'c', claimId: 'CLM-00001', subCategoryId };
    const shared = new Map<string, string>([
      ['d1', 'document for clm00001 here'],
      ['d2', 'unrelated'],
    ]);
    expect((await intraValidator.run(ctxFor(prisma, claim, [], shared))).status).toBe('PASSED');
    const shared2 = new Map<string, string>([['d1', 'nothing matching']]);
    expect((await intraValidator.run(ctxFor(prisma, claim, [], shared2))).status).toBe('FAILED');
  });
});
