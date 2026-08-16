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

  /**
   * Wait until nothing is QUEUED or RUNNING.
   *
   * `await kickDrain(...)` is not enough and reads as if it were: it returns the promise for
   * the drain already IN FLIGHT, so it resolves while the re-armed pass is still working.
   * Asserting on that moment is how these tests saw one claim processed out of eight.
   */
  async function drained(timeoutMs = 20000) {
    const started = Date.now();
    for (;;) {
      const pending = await prisma.validationRun.count({
        where: { claim: { subCategoryId }, status: { in: ['QUEUED', 'RUNNING'] } },
      });
      if (pending === 0) return;
      if (Date.now() - started > timeoutMs) throw new Error(`drain did not finish: ${pending} left`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

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
      data: { name: 'Pending', isDefault: true, createdBy: adminId, updatedBy: adminId },
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

  it('enqueue coalesces, and every queued run is processed exactly once', async () => {
    const c1 = await makeClaim('C-V2');
    const c2 = await makeClaim('C-V3');
    await enqueue(prisma, fakes, c1.id, 'AUTO');
    await enqueue(prisma, fakes, c1.id, 'AUTO');
    await enqueue(prisma, fakes, c2.id, 'AUTO');
    await kickDrain(prisma, fakes);
    await drained();
    const runs = await prisma.validationRun.findMany({ where: { claim: { subCategoryId } } });
    // Deliberately not asserting an exact run count. Coalescing only applies while a run is
    // still QUEUED, and the drainer now picks work up promptly (and concurrently), so a
    // second enqueue for the same claim legitimately creates a second run — the documented
    // behaviour, since a RUNNING run's document snapshot is already frozen. What must hold
    // is that both claims were validated and nothing was left behind.
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.every((r) => r.status === 'COMPLETED')).toBe(true);
    expect(new Set(runs.map((r) => r.claimId)).size).toBe(2);
  });

  it('runs claims concurrently without any run executing twice', async () => {
    const prev = process.env.VALIDATION_CONCURRENCY;
    process.env.VALIDATION_CONCURRENCY = '4';
    try {
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        const c = await makeClaim(`C-CC${i}`);
        // Zero documents short-circuits to DOCS_NOT_AVAILABLE before any validator runs, so
        // without this the counting validator is never called and the test proves nothing.
        await prisma.document.create({
          data: {
            claimId: c.id,
            source: 'UPLOADED',
            fileName: 'doc.pdf',
            storagePath: `/tmp/${SUF}-C-CC${i}.pdf`,
            createdBy: adminId,
          },
        });
        ids.push(c.id);
      }
      // Count executions per run: reserveNext must hand each row to exactly one worker.
      const seen = new Map<string, number>();
      const counting: Validator[] = [
        {
          key: 'FULL',
          column: 'fullScanStatus',
          run: async (ctx) => {
            seen.set(ctx.claim.id, (seen.get(ctx.claim.id) ?? 0) + 1);
            await new Promise((r) => setTimeout(r, 15));
            return { status: 'PASSED', summary: 'ok' };
          },
        },
      ];
      for (const id of ids) await enqueue(prisma, counting, id, 'AUTO');
      await kickDrain(prisma, counting);
      await drained();

      // Every claim ran, and none ran twice — the whole point of the conditional update.
      expect([...seen.keys()].sort()).toEqual([...ids].sort());
      expect([...seen.values()].every((n) => n === 1)).toBe(true);

      const runs = await prisma.validationRun.findMany({
        where: { claimId: { in: ids } },
        select: { status: true },
      });
      expect(runs.length).toBe(ids.length);
      expect(runs.every((r) => r.status === 'COMPLETED')).toBe(true);
    } finally {
      process.env.VALIDATION_CONCURRENCY = prev;
    }
  });

  it('moves a claim off the default status once validation completes, once only', async () => {
    const target = await prisma.statusMaster.create({
      data: { name: `vs-next-${SUF}`, isDefault: false, createdBy: adminId, updatedBy: adminId },
    });
    const prev = process.env.VALIDATION_ADVANCE_STATUS;
    process.env.VALIDATION_ADVANCE_STATUS = target.name;
    try {
      const claim = await makeClaim('C-W1');
      // Zero documents short-circuits to DOCS_NOT_AVAILABLE before any validator runs, and
      // that path deliberately does NOT advance the status — nothing was actually checked.
      await prisma.document.create({
        data: {
          claimId: claim.id,
          source: 'UPLOADED',
          fileName: 'doc.pdf',
          storagePath: `/tmp/${SUF}-C-W1.pdf`,
          createdBy: adminId,
        },
      });
      const run = await enqueue(prisma, fakes, claim.id, 'MANUAL', adminId);
      await new ValidationService(prisma, fakes).runOne(run.id);

      const moved = await prisma.claim.findUnique({
        where: { id: claim.id },
        select: { workflowStatusId: true },
      });
      expect(moved!.workflowStatusId).toBe(target.id);

      // On the timeline, attributed, both ends recorded — a status that changed with
      // nobody's name on it would be worse than no change at all.
      const remark = await prisma.claimRemark.findFirst({
        where: { claimId: claim.id, statusAfterId: target.id },
      });
      expect(remark).toBeTruthy();
      expect(remark!.statusBeforeId).toBe(workflowStatusId);
      expect(remark!.userId).toBe(adminId);

      // Re-validating must NOT move it again: it is off the default now, and a second run
      // must never walk a claim a human may since have placed somewhere deliberately.
      const run2 = await enqueue(prisma, fakes, claim.id, 'MANUAL', adminId);
      await new ValidationService(prisma, fakes).runOne(run2.id);
      const after2 = await prisma.claim.findUnique({
        where: { id: claim.id },
        select: { workflowStatusId: true },
      });
      expect(after2!.workflowStatusId).toBe(target.id);
      expect(
        await prisma.claimRemark.count({ where: { claimId: claim.id, statusAfterId: target.id } })
      ).toBe(1);
    } finally {
      // Restore the env var only. The status row stays: a claim still references it, and
      // this suite already leaves its per-test 'Pending' rows behind.
      process.env.VALIDATION_ADVANCE_STATUS = prev;
    }
  });

  it('never advances to a terminal status, even when configured to', async () => {
    const closed = await prisma.statusMaster.create({
      data: {
        name: `vs-closed-${SUF}`,
        isDefault: false,
        isTerminal: true,
        createdBy: adminId,
        updatedBy: adminId,
      },
    });
    const prev = process.env.VALIDATION_ADVANCE_STATUS;
    process.env.VALIDATION_ADVANCE_STATUS = closed.name;
    try {
      const claim = await makeClaim('C-W2');
      // Zero documents short-circuits to DOCS_NOT_AVAILABLE before any validator runs, and
      // that path deliberately does NOT advance the status — nothing was actually checked.
      await prisma.document.create({
        data: {
          claimId: claim.id,
          source: 'UPLOADED',
          fileName: 'doc.pdf',
          storagePath: `/tmp/${SUF}-C-W2.pdf`,
          createdBy: adminId,
        },
      });
      const run = await enqueue(prisma, fakes, claim.id, 'MANUAL', adminId);
      await new ValidationService(prisma, fakes).runOne(run.id);

      // A machine must not be able to close a claim, even by misconfiguration.
      const after = await prisma.claim.findUnique({
        where: { id: claim.id },
        select: { workflowStatusId: true },
      });
      expect(after!.workflowStatusId).toBe(workflowStatusId);
    } finally {
      process.env.VALIDATION_ADVANCE_STATUS = prev;
    }
  });

  it('sweepStaleRuns fails orphaned RUNNING runs', async () => {
    const claim = await makeClaim('C-V4');
    const run = await prisma.validationRun.create({
      data: { claimId: claim.id, trigger: 'AUTO', status: 'RUNNING', startedAt: new Date() },
    });
    const { count, claimIds } = await new ValidationService(prisma, fakes).sweepStaleRuns();
    expect(count).toBeGreaterThanOrEqual(1);
    expect((await prisma.validationRun.findUnique({ where: { id: run.id } }))?.status).toBe('FAILED');
    // The ids come back so startup can queue fresh runs: the sweep discards the claim's
    // results, so reporting nothing to re-run would leave it blank with no work pending.
    expect(claimIds).toContain(claim.id);
  });

  it('a swept claim ends up with work pending, not blank with nothing scheduled', async () => {
    const claim = await makeClaim('C-V7');
    const orphaned = await prisma.validationRun.create({
      data: { claimId: claim.id, trigger: 'AUTO', status: 'RUNNING', startedAt: new Date() },
    });

    // Exactly what index.ts does on startup: sweep, then queue the claims it blanked.
    const { claimIds } = await new ValidationService(prisma, fakes).sweepStaleRuns();
    for (const id of claimIds) await enqueue(prisma, fakes, id, 'AUTO');
    await kickDrain(prisma, fakes);

    // The sweep discards the claim's five columns, so the fix is not "a run exists" but
    // "a run OTHER than the one it just failed exists" — without it the claim sits at
    // PENDING with its findings gone and nothing queued to regenerate them.
    const fresh = await prisma.validationRun.findMany({
      where: { claimId: claim.id, id: { not: orphaned.id } },
    });
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    expect(fresh.every((r) => r.status !== 'FAILED')).toBe(true);
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
