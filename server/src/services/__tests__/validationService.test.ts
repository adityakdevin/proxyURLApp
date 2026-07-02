import { PrismaClient } from '@prisma/client';
import { ValidationService } from '../validationService.js';
import { enqueue, kickDrain } from '../validationQueue.js';
import { Validator } from '../../validators/types.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

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
  let ptId: string;
  let catId: string;

  async function makeClaim(claimId: string) {
    return prisma.claim.create({
      data: { claimId, subCategoryId, workflowStatusId, createdBy: adminId, updatedBy: adminId },
    });
  }

  beforeAll(async () => {
    prisma = getTestPrisma();
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    adminId = admin!.id;
    const pt = await prisma.project.create({ data: { name: `vs-pt-${SUF}` } });
    ptId = pt.id;
    const cat = await prisma.category.create({
      data: { name: `vs-cat-${SUF}`, projectId: ptId },
    });
    catId = cat.id;
    const sc = await prisma.subCategory.create({ data: { name: `vs-sc-${SUF}`, categoryId: catId } });
    subCategoryId = sc.id;
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    await prisma.validationRun.deleteMany({ where: { claim: { subCategoryId } } });
    const st = await prisma.statusMaster.create({
      data: { subCategoryId, name: 'Pending', isDefault: true, createdBy: adminId, updatedBy: adminId },
    });
    workflowStatusId = st.id;
  });

  afterAll(async () => {
    await prisma.validationRun.deleteMany({ where: { claim: { subCategoryId } } });
    await truncateClaimsTables(prisma);
    await prisma.subCategory.deleteMany({ where: { id: subCategoryId } });
    await prisma.category.deleteMany({ where: { id: catId } });
    await prisma.project.deleteMany({ where: { id: ptId } });
    await disconnectTestPrisma();
  });

  it('runOne executes validators, writes results, sets columns + COMPLETED', async () => {
    const claim = await makeClaim('C-V1');
    // A claim with zero documents short-circuits to DOCS_NOT_AVAILABLE before any
    // validator runs (see runOne), so attach one document so the validators fire.
    await prisma.document.create({
      data: {
        claimId: claim.id,
        source: 'UPLOADED',
        fileName: 'doc.pdf',
        storagePath: `/tmp/${SUF}-C-V1.pdf`,
        createdBy: adminId,
      },
    });
    const run = await prisma.validationRun.create({
      data: { claimId: claim.id, trigger: 'MANUAL', status: 'QUEUED' },
    });
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
    await enqueue(prisma, fakes, c1.id, 'AUTO');
    await enqueue(prisma, fakes, c2.id, 'AUTO');
    await kickDrain(prisma, fakes);
    const runs = await prisma.validationRun.findMany({ where: { claim: { subCategoryId } } });
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.status === 'COMPLETED')).toBe(true);
  });

  it('sweepStaleRuns fails orphaned RUNNING runs', async () => {
    const claim = await makeClaim('C-V4');
    const run = await prisma.validationRun.create({
      data: { claimId: claim.id, trigger: 'AUTO', status: 'RUNNING', startedAt: new Date() },
    });
    const n = await new ValidationService(prisma, fakes).sweepStaleRuns();
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await prisma.validationRun.findUnique({ where: { id: run.id } }))?.status).toBe('FAILED');
  });

  it('sweepStaleRuns resets the crashed claim columns to PENDING (not stranded IN_PROGRESS)', async () => {
    const claim = await makeClaim('C-V5');
    await prisma.claim.update({
      where: { id: claim.id },
      data: {
        spellCheckStatus: 'IN_PROGRESS',
        qrStatus: 'IN_PROGRESS',
        metaExtractionStatus: 'IN_PROGRESS',
        intraClaimStatus: 'IN_PROGRESS',
        fullScanStatus: 'IN_PROGRESS',
      },
    });
    await prisma.validationRun.create({
      data: { claimId: claim.id, trigger: 'AUTO', status: 'RUNNING', startedAt: new Date() },
    });
    await new ValidationService(prisma, fakes).sweepStaleRuns();
    const reloaded = await prisma.claim.findUnique({ where: { id: claim.id } });
    expect(reloaded?.spellCheckStatus).toBe('PENDING');
    expect(reloaded?.qrStatus).toBe('PENDING');
    expect(reloaded?.metaExtractionStatus).toBe('PENDING');
    expect(reloaded?.intraClaimStatus).toBe('PENDING');
    expect(reloaded?.fullScanStatus).toBe('PENDING');
  });

  it('enqueue creates a NEW run when one is already RUNNING (snapshot is frozen)', async () => {
    const claim = await makeClaim('C-V6');
    // A run is mid-flight with a frozen document snapshot.
    await prisma.validationRun.create({
      data: { claimId: claim.id, trigger: 'MANUAL', status: 'RUNNING', startedAt: new Date() },
    });
    // A document upload arrives → must NOT coalesce into the RUNNING run.
    await enqueue(prisma, fakes, claim.id, 'AUTO');
    await kickDrain(prisma, fakes); // let the drainer settle the new QUEUED run
    const runs = await prisma.validationRun.findMany({ where: { claimId: claim.id } });
    expect(runs.length).toBe(2); // coalescing would have left just 1
  });
});
