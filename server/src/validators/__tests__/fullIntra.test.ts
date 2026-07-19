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
      data: { name: 'Aadhar Card', category: 'GOVT', govtCode: 'AADHAR', displayOrder: 1, createdBy: adminId, updatedBy: adminId },
    });
    const b = await prisma.documentTypeMaster.create({
      data: { name: 'PAN Card', category: 'GOVT', govtCode: 'PAN', displayOrder: 2, createdBy: adminId, updatedBy: adminId },
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
