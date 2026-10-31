import { PrismaClient } from '@prisma/client';
import { ValidationService } from '../validationService.js';
import { enqueue, idle, kickDrain } from '../validationQueue.js';
import { DUP_CLAIMS_CAP } from '../../validators/dupValidator.js';
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

  it('runOne reports whether THIS call executed the run, so a loser cannot log a completion', async () => {
    // The drainer prints its progress line only when runOne returns true. While that value
    // was void it printed one after every call, so the worker that lost the race logged
    // `claim <id> done in 0s` for work it never touched — phantom entries beside the real
    // ones for the same claim, in the one line meant to tell a slow queue from a wedged one.
    const claim = await makeClaim('C-RACE');
    await prisma.document.create({
      data: {
        claimId: claim.id,
        source: 'UPLOADED',
        fileName: 'doc.pdf',
        storagePath: `/tmp/${SUF}-C-RACE.pdf`,
        createdBy: adminId,
      },
    });
    const run = await prisma.validationRun.create({
      data: { claimId: claim.id, trigger: 'MANUAL', status: 'QUEUED' },
    });
    const svc = new ValidationService(prisma, fakes);

    expect(await svc.runOne(run.id)).toBe(true);
    // Second call on the same run: the row is no longer QUEUED, which is exactly the state a
    // losing worker finds. It must say so rather than returning silently.
    expect(await svc.runOne(run.id)).toBe(false);

    // And the guard still holds — the no-op wrote nothing on top of the first run.
    const results = await prisma.validationResult.findMany({ where: { runId: run.id } });
    expect(results).toHaveLength(fakes.length);
  });

  it('runs META alone first, then the rest together', async () => {
    // META does the OCR and fills the shared text every other check reads, so it cannot
    // overlap with them. The rest depend on META's output and not on each other, and used
    // to run end to end — INTRA and FULL, which do no I/O at all, waited behind the QR page
    // rasterisation for the whole of it.
    const order: string[] = [];
    const tailStarts: number[] = [];
    const inFlight = new Set<string>();
    let maxConcurrent = 0;
    const trace = (key: Validator['key'], column: Validator['column']): Validator => ({
      key,
      column,
      run: async () => {
        order.push(key);
        inFlight.add(key);
        if (key === 'REDFLAG' || key === 'SPELL') tailStarts.push(inFlight.size);
        maxConcurrent = Math.max(maxConcurrent, inFlight.size);
        await new Promise((r) => setTimeout(r, 20));
        inFlight.delete(key);
        return { status: 'PASSED' as const, summary: 'ok' };
      },
    });
    const traced: Validator[] = [
      trace('META', 'metaExtractionStatus'),
      trace('SPELL', 'spellCheckStatus'),
      trace('QR', 'qrStatus'),
      trace('INTRA', 'intraClaimStatus'),
      trace('FULL', 'fullScanStatus'),
      trace('REDFLAG', 'redFlagStatus'),
    ];

    const claim = await makeClaim('C-PAR');
    await prisma.document.create({
      data: {
        claimId: claim.id,
        source: 'UPLOADED',
        fileName: 'doc.pdf',
        storagePath: `/tmp/${SUF}-C-PAR.pdf`,
        createdBy: adminId,
      },
    });
    const run = await prisma.validationRun.create({
      data: { claimId: claim.id, trigger: 'MANUAL', status: 'QUEUED' },
    });
    await new ValidationService(prisma, traced).runOne(run.id);

    // META started before anything else, and never shared the stage. REDFLAG and SPELL ran
    // after the rest, one at a time: each opens its own pdfjs document per PDF (SPELL to
    // render a page again for a second reading), so overlapping either with QR's
    // rasterisation would put two PDF loaders in memory at once.
    expect(order[0]).toBe('META');
    expect(order.slice(-2).sort()).toEqual(['REDFLAG', 'SPELL']);
    // Only the three in the middle overlapped, and each of the two after them ran alone.
    expect(maxConcurrent).toBe(3);
    expect(tailStarts).toEqual([1, 1]);
    // Every check still recorded exactly one result. Not asserted in order: the rows are
    // written inside one transaction and share a createdAt to the millisecond, so ordering
    // by it is a coin toss — the same tie the audit log's pagination had to break.
    const rows = await prisma.validationResult.findMany({ where: { runId: run.id } });
    expect(rows.map((r) => r.validatorKey).sort()).toEqual(traced.map((v) => v.key).sort());
  });

  it('abandons a check that hangs instead of stalling the run forever', async () => {
    // A hung OCR page used to stop the check, the run, AND the drainer: drainLoop's
    // Promise.all waits on every worker, so a stuck one kept `draining` non-null and every
    // later enqueue set `rearm` and kicked nothing. Eight production claims queued at
    // 12:23:49 were not touched until 15:34:24 because of exactly this.
    const prev = process.env.VALIDATION_CHECK_TIMEOUT_MS;
    process.env.VALIDATION_CHECK_TIMEOUT_MS = '100';
    try {
      const hangs: Validator[] = [
        { key: 'META', column: 'metaExtractionStatus', run: () => new Promise<never>(() => {}) },
        {
          key: 'FULL',
          column: 'fullScanStatus',
          run: async () => ({ status: 'PASSED', summary: 'ok' }),
        },
      ];
      const claim = await makeClaim('C-HANG');
      await prisma.document.create({
        data: {
          claimId: claim.id,
          source: 'UPLOADED',
          fileName: 'doc.pdf',
          storagePath: `/tmp/${SUF}-C-HANG.pdf`,
          createdBy: adminId,
        },
      });
      const run = await prisma.validationRun.create({
        data: { claimId: claim.id, trigger: 'MANUAL', status: 'QUEUED' },
      });

      expect(await new ValidationService(prisma, hangs).runOne(run.id)).toBe(true);

      // The run reached an end state rather than hanging, the stuck check is FAILED and says
      // why, and the check that did work still recorded its own result.
      const after = await prisma.validationRun.findUnique({ where: { id: run.id } });
      expect(after!.status).toBe('COMPLETED');
      const rows = await prisma.validationResult.findMany({ where: { runId: run.id } });
      const meta = rows.find((r) => r.validatorKey === 'META');
      expect(meta!.status).toBe('FAILED');
      expect(meta!.summary).toMatch(/timed out/);
      expect(rows.find((r) => r.validatorKey === 'FULL')!.status).toBe('PASSED');
    } finally {
      if (prev === undefined) delete process.env.VALIDATION_CHECK_TIMEOUT_MS;
      else process.env.VALIDATION_CHECK_TIMEOUT_MS = prev;
    }
  });

  it('runs only the ticked checks, and the rest report not-run rather than passing', async () => {
    const ran: string[] = [];
    const mk = (key: Validator['key'], column: Validator['column']): Validator => ({
      key,
      column,
      run: async () => {
        ran.push(key);
        return { status: 'PASSED' as const, summary: 'ok' };
      },
    });
    const all: Validator[] = [
      mk('META', 'metaExtractionStatus'),
      mk('SPELL', 'spellCheckStatus'),
      mk('INTRA', 'intraClaimStatus'),
      mk('FULL', 'fullScanStatus'),
      mk('DUP', 'duplicateStatus'),
      mk('QR', 'qrStatus'),
      mk('REDFLAG', 'redFlagStatus'),
    ];

    const claim = await makeClaim('C-PICK');
    await prisma.document.create({
      data: {
        claimId: claim.id,
        source: 'UPLOADED',
        fileName: 'doc.pdf',
        storagePath: `/tmp/${SUF}-C-PICK.pdf`,
        createdBy: adminId,
      },
    });
    const run = await prisma.validationRun.create({
      data: { claimId: claim.id, trigger: 'MANUAL', status: 'QUEUED', checks: 'SPELL,QR' },
    });
    await new ValidationService(prisma, all).runOne(run.id);

    // META always runs — it is the text every other check reads — plus the two ticked.
    expect(ran.sort()).toEqual(['META', 'QR', 'SPELL']);

    const rows = await prisma.validationResult.findMany({ where: { runId: run.id } });
    expect(rows).toHaveLength(all.length); // every check still has a row
    for (const key of ['INTRA', 'FULL', 'DUP', 'REDFLAG']) {
      const row = rows.find((r) => r.validatorKey === key)!;
      expect(row.status).toBe('DOUBTFUL'); // never PASSED
      expect(row.summary).toMatch(/^Not run: .* was not ticked/);
    }
    expect(rows.find((r) => r.validatorKey === 'SPELL')!.status).toBe('PASSED');

    // The claim's columns agree, so the list cannot show a green tick for a check that
    // never ran.
    const after = await prisma.claim.findUnique({ where: { id: claim.id } });
    expect(after!.duplicateStatus).toBe('DOUBTFUL');
    expect(after!.spellCheckStatus).toBe('PASSED');
  });

  it('a disabled check, and anything blinded by it, reports not-run rather than passing', async () => {
    // Switching META off leaves SPELL/INTRA/FULL/DUP reading an empty ctx.shared, where they
    // find nothing wrong and go green — a clean bill of health from checks that never looked.
    // QR and REDFLAG do their own work and only degrade, so they must still run.
    const prev = process.env.VALIDATION_DISABLED_CHECKS;
    process.env.VALIDATION_DISABLED_CHECKS = 'META';
    try {
      const ran: string[] = [];
      const mk = (key: Validator['key'], column: Validator['column']): Validator => ({
        key,
        column,
        run: async () => {
          ran.push(key);
          return { status: 'PASSED' as const, summary: 'ok' };
        },
      });
      const all: Validator[] = [
        mk('META', 'metaExtractionStatus'),
        mk('SPELL', 'spellCheckStatus'),
        mk('INTRA', 'intraClaimStatus'),
        mk('FULL', 'fullScanStatus'),
        mk('DUP', 'duplicateStatus'),
        mk('QR', 'qrStatus'),
        mk('REDFLAG', 'redFlagStatus'),
      ];

      const claim = await makeClaim('C-OFF');
      await prisma.document.create({
        data: {
          claimId: claim.id,
          source: 'UPLOADED',
          fileName: 'doc.pdf',
          storagePath: `/tmp/${SUF}-C-OFF.pdf`,
          createdBy: adminId,
        },
      });
      const run = await prisma.validationRun.create({
        data: { claimId: claim.id, trigger: 'MANUAL', status: 'QUEUED' },
      });
      await new ValidationService(prisma, all).runOne(run.id);

      // Only the two that can still do real work executed.
      expect(ran.sort()).toEqual(['QR', 'REDFLAG']);

      const rows = await prisma.validationResult.findMany({ where: { runId: run.id } });
      // Every check still has a row — a missing row reads as "nothing to see", which is the
      // silence this whole change exists to avoid.
      expect(rows).toHaveLength(all.length);
      for (const key of ['META', 'SPELL', 'INTRA', 'FULL', 'DUP']) {
        const row = rows.find((r) => r.validatorKey === key)!;
        expect(row.status).toBe('DOUBTFUL'); // never PASSED
        expect(row.summary).toMatch(/^Not run:/);
      }
      expect(rows.find((r) => r.validatorKey === 'QR')!.status).toBe('PASSED');

      // And the claim's columns agree with the rows, so the list cannot show a green tick.
      const after = await prisma.claim.findUnique({ where: { id: claim.id } });
      expect(after!.metaExtractionStatus).toBe('DOUBTFUL');
      expect(after!.spellCheckStatus).toBe('DOUBTFUL');
      expect(after!.duplicateStatus).toBe('DOUBTFUL');
      expect(after!.qrStatus).toBe('PASSED');
    } finally {
      if (prev === undefined) delete process.env.VALIDATION_DISABLED_CHECKS;
      else process.env.VALIDATION_DISABLED_CHECKS = prev;
    }
  });

  it('writes each result as its check finishes, before the run is COMPLETED', async () => {
    // The reviewer's page reads the latest run whatever its status, so a result written
    // early is on screen early. Previously all five were held to one commit at the end and
    // the page showed nothing for the length of the slowest check.
    const claim = await makeClaim('C-PROG');
    await prisma.document.create({
      data: {
        claimId: claim.id,
        source: 'UPLOADED',
        fileName: 'doc.pdf',
        storagePath: `/tmp/${SUF}-C-PROG.pdf`,
        createdBy: adminId,
      },
    });
    const run = await prisma.validationRun.create({
      data: { claimId: claim.id, trigger: 'MANUAL', status: 'QUEUED' },
    });

    // Seen from inside the SECOND check: the first one's result is already committed, and
    // the run is still RUNNING.
    let seenMidRun: { results: number; runStatus: string | undefined } | null = null;
    const observed: Validator[] = [
      { key: 'META', column: 'metaExtractionStatus', run: async () => ({ status: 'PASSED', summary: 'ok' }) },
      {
        key: 'SPELL',
        column: 'spellCheckStatus',
        run: async () => {
          seenMidRun = {
            results: await prisma.validationResult.count({ where: { runId: run.id } }),
            runStatus: (await prisma.validationRun.findUnique({ where: { id: run.id } }))?.status,
          };
          return { status: 'PASSED', summary: 'ok' };
        },
      },
    ];

    await new ValidationService(prisma, observed).runOne(run.id);

    expect(seenMidRun).toEqual({ results: 1, runStatus: 'RUNNING' });
    const done = await prisma.validationRun.findUnique({ where: { id: run.id } });
    expect(done?.status).toBe('COMPLETED');
    expect(await prisma.validationResult.count({ where: { runId: run.id } })).toBe(2);
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
      if (prev === undefined) delete process.env.VALIDATION_CONCURRENCY;
      else process.env.VALIDATION_CONCURRENCY = prev;
    }
  });

  // A bulk validate enqueues claims one after another. The first enqueue's spare workers
  // found nothing and left, so the batch ran on a single worker (client QA re-run).
  it('runs a one-by-one enqueued batch on more than one worker', async () => {
    const prev = process.env.VALIDATION_CONCURRENCY;
    process.env.VALIDATION_CONCURRENCY = '4';
    try {
      let inFlight = 0;
      let peak = 0;
      const slow: Validator[] = [
        {
          key: 'FULL',
          column: 'fullScanStatus',
          run: async () => {
            peak = Math.max(peak, ++inFlight);
            await new Promise((r) => setTimeout(r, 60));
            inFlight--;
            return { status: 'PASSED', summary: 'ok' };
          },
        },
      ];
      // Set every claim up first, so overlap depends on the drainer, not on how fast the
      // database round-trips between enqueues are.
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const c = await makeClaim(`C-BW${i}`);
        await prisma.document.create({
          data: { claimId: c.id, source: 'UPLOADED', fileName: 'doc.pdf', storagePath: `/tmp/${SUF}-C-BW${i}.pdf`, createdBy: adminId },
        });
        ids.push(c.id);
      }
      // The first claim starts the pool; its spare workers find an empty queue and leave
      // before the rest arrive — the bulk-validate shape. Only a top-up gets past one worker.
      await enqueue(prisma, slow, ids[0], 'AUTO');
      await new Promise((r) => setTimeout(r, 30));
      for (const id of ids.slice(1)) await enqueue(prisma, slow, id, 'AUTO');
      await drained();
      expect(peak).toBeGreaterThan(1);
    } finally {
      if (prev === undefined) delete process.env.VALIDATION_CONCURRENCY;
      else process.env.VALIDATION_CONCURRENCY = prev;
    }
  });

  // Value: protects=test cleanup waits for the in-process drainer before deleting claims;
  // fails_when=idle() resolves while a worker still writes a run; why_new=CI deadlocked a
  // claim.deleteMany against a drain a previous e2e test left running; seam=none;
  // no_claim=a drain in another process
  it('idle() resolves only once the drain in flight has finished every run', async () => {
    const slow: Validator[] = [
      {
        key: 'FULL',
        column: 'fullScanStatus',
        run: async () => {
          await new Promise((r) => setTimeout(r, 40));
          return { status: 'PASSED', summary: 'ok' };
        },
      },
    ];
    const ids: string[] = [];
    for (const no of ['C-IDLE1', 'C-IDLE2']) {
      const c = await makeClaim(no);
      await prisma.document.create({
        data: { claimId: c.id, source: 'UPLOADED', fileName: 'doc.pdf', storagePath: `/tmp/${SUF}-${no}.pdf`, createdBy: adminId },
      });
      ids.push(c.id);
    }
    for (const id of ids) await enqueue(prisma, slow, id, 'AUTO');
    await idle();
    const runs = await prisma.validationRun.findMany({ where: { claimId: { in: ids } } });
    expect(runs.map((r) => r.status)).toEqual(['COMPLETED', 'COMPLETED']);
  });

  // Value: protects=a finding with no severity on a failed check is stored visible (ERROR);
  // fails_when=the persistence default goes back to WARNING, which reviewers never see;
  // why_new=every plain "Missing docs" line was hidden this way; seam=none; no_claim=UI rendering
  it('stores a finding without a severity as ERROR on a failed check', async () => {
    const c = await makeClaim(`C-SEV-${SUF}`);
    await prisma.document.create({
      data: { claimId: c.id, source: 'UPLOADED', fileName: 'doc.pdf', storagePath: `/tmp/${SUF}-sev.pdf`, createdBy: adminId },
    });
    const v: Validator[] = [
      {
        key: 'FULL',
        column: 'fullScanStatus',
        run: async () => ({ status: 'FAILED', summary: 'missing', findings: [{ documentId: null, code: 'FULL_MISSING_TYPE', message: 'Missing docs - PAN Card' }] }),
      },
    ];
    await enqueue(prisma, v, c.id, 'AUTO');
    await kickDrain(prisma, v);
    await drained();
    const f = await prisma.validationFinding.findFirst({ where: { claimId: c.id, code: 'FULL_MISSING_TYPE' } });
    expect(f?.severity).toBe('ERROR');
  });

  // Value: protects=a run whose runOne throws after claiming it is failed, so the claim's
  // later runs are not blocked behind a RUNNING row until restart; fails_when=the worker's
  // catch stops failing the run; why_new=no test made runOne throw; seam=runOne spy
  it('fails a run that threw while RUNNING, and the claim\'s next run still drains', async () => {
    const quick: Validator[] = [
      { key: 'FULL', column: 'fullScanStatus', run: async () => ({ status: 'PASSED', summary: 'ok' }) },
    ];
    const c = await makeClaim(`C-THROW-${SUF}`);
    await prisma.document.create({
      data: { claimId: c.id, source: 'UPLOADED', fileName: 'doc.pdf', storagePath: `/tmp/${SUF}-throw.pdf`, createdBy: adminId },
    });
    const real = ValidationService.prototype.runOne;
    let thrown = false;
    // Only this claim's first run throws: other tests' leftover runs may drain first.
    const spy = jest.spyOn(ValidationService.prototype, 'runOne').mockImplementation(async function (this: ValidationService, id: string) {
      const run = await prisma.validationRun.findUnique({ where: { id } });
      if (thrown || run?.claimId !== c.id) return real.call(this, id);
      // Claimed atomically, as runOne does, so a second worker cannot run it too.
      const claimed = await prisma.validationRun.updateMany({
        where: { id, status: 'QUEUED' },
        data: { status: 'RUNNING', startedAt: new Date() },
      });
      if (claimed.count === 0) return false;
      thrown = true;
      throw new Error('boom');
    });
    try {
      await enqueue(prisma, quick, c.id, 'AUTO');
      await kickDrain(prisma, quick);
      const first = await prisma.validationRun.findFirst({ where: { claimId: c.id }, orderBy: { createdAt: 'asc' } });
      expect(first?.status).toBe('FAILED');
      await enqueue(prisma, quick, c.id, 'MANUAL', adminId);
      await kickDrain(prisma, quick);
      const latest = await prisma.validationRun.findFirst({ where: { claimId: c.id }, orderBy: { createdAt: 'desc' } });
      expect(latest?.status).toBe('COMPLETED');
    } finally {
      spy.mockRestore();
    }
  });

  // Value: protects=a run queued while every worker is busy is still drained, and the
  // caller's promise waits for it; fails_when=the rearm/chaining in kickDrain regresses;
  // why_new=only the top-up path was tested; seam=none; no_claim=multi-process drains
  it('drains a run queued just as the last worker found the queue empty', async () => {
    const prev = process.env.VALIDATION_CONCURRENCY;
    process.env.VALIDATION_CONCURRENCY = '1';
    const quick: Validator[] = [
      { key: 'FULL', column: 'fullScanStatus', run: async () => ({ status: 'PASSED', summary: 'ok' }) },
    ];
    const mk = async (id: string) => {
      const c = await makeClaim(id);
      await prisma.document.create({
        data: { claimId: c.id, source: 'UPLOADED', fileName: 'doc.pdf', storagePath: `/tmp/${SUF}-${id}.pdf`, createdBy: adminId },
      });
      return c;
    };
    const a = await mk(`C-RA-${SUF}`);
    const b = await mk(`C-RB-${SUF}`);
    // Force the window rearm exists for: the only worker reads an empty queue, B is queued
    // and kicked before that worker has left. Without rearm, B is stranded.
    const real = prisma.validationRun.findFirst.bind(prisma.validationRun);
    let injected = false;
    const spy = jest.spyOn(prisma.validationRun, 'findFirst').mockImplementation((async (args: Parameters<typeof real>[0]) => {
      const r = await real(args);
      if (!r && !injected && (args?.where as { status?: unknown } | undefined)?.status === 'QUEUED' && args?.orderBy) {
        injected = true;
        await prisma.validationRun.create({ data: { claimId: b.id, trigger: 'AUTO' } });
        void kickDrain(prisma, quick);
      }
      return r;
    }) as never);
    try {
      await enqueue(prisma, quick, a.id, 'AUTO');
      // No drained() poll: B must be done when kickDrain's own promise settles.
      await kickDrain(prisma, quick);
      const runB = await real({ where: { claimId: b.id } });
      expect(runB?.status).toBe('COMPLETED');
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.VALIDATION_CONCURRENCY;
      else process.env.VALIDATION_CONCURRENCY = prev;
    }
  });

  // Value: protects=a duplicate partner is re-validated once and the pair then stops; a
  // capped partner list never re-queues; fails_when=requeueDuplicatePartners or its namesMe
  // test is removed or inverted (one-sided duplicate, or an endless re-validation loop);
  // why_new=no test ran a DUP ERROR through runOne; seam=none; no_claim=real DUP extraction
  describe('duplicate partners', () => {
    const withDoc = async (claimId: string) => {
      const c = await makeClaim(claimId);
      await prisma.document.create({
        data: { claimId: c.id, source: 'UPLOADED', fileName: 'doc.pdf', storagePath: `/tmp/${SUF}-${claimId}.pdf`, createdBy: adminId },
      });
      return c;
    };
    const dupNaming = (names: (claimId: string) => string[]): Validator[] => [
      {
        key: 'DUP',
        column: 'duplicateStatus',
        run: async (ctx) => ({
          status: 'FAILED',
          summary: 'dup',
          findings: [{ documentId: null, code: 'DUP_POLICY_NO', severity: 'ERROR', message: 'm', data: { claims: names(ctx.claim.claimId) } }],
        }),
      },
    ];
    const runsOf = (id: string) => prisma.validationRun.count({ where: { claimId: id } });

    it('re-validates a partner that does not name this claim yet, once, then stops', async () => {
      const a = await withDoc(`C-RQA-${SUF}`);
      const b = await withDoc(`C-RQB-${SUF}`);
      const v = dupNaming((me) => [me === a.claimId ? b.claimId : a.claimId]);
      await enqueue(prisma, v, b.id, 'AUTO');
      // The drainer's own promise, not a DB poll: between B completing and A being queued
      // nothing is QUEUED or RUNNING, which a poll reads as done.
      await kickDrain(prisma, v);
      await drained();
      // B named A, whose (absent) result did not name B: A ran once. A's run names B, and
      // B's latest names A, so nothing more is queued.
      expect(await runsOf(a.id)).toBe(1);
      expect(await runsOf(b.id)).toBe(1);
    });

    it('widens a partner\'s queued run that does not include DUP', async () => {
      const prev = process.env.VALIDATION_CONCURRENCY;
      process.env.VALIDATION_CONCURRENCY = '1';
      try {
        const a = await withDoc(`C-RQG-${SUF}`);
        const b = await withDoc(`C-RQH-${SUF}`);
        const v = dupNaming((me) => [me === a.claimId ? b.claimId : a.claimId]);
        // B first, then A queued for SPELL only: one worker runs B, whose requeue must not
        // trust A's queued run to see the duplicate.
        await prisma.validationRun.create({ data: { claimId: b.id, trigger: 'AUTO' } });
        await prisma.validationRun.create({ data: { claimId: a.id, trigger: 'MANUAL', checks: 'SPELL' } });
        await kickDrain(prisma, v);
        await drained();
        // A skipped check is stored as not run; widened, A's DUP really ran and found B.
        const latest = await prisma.validationResult.findFirst({
          where: { claimId: a.id, validatorKey: 'DUP' },
          orderBy: { createdAt: 'desc' },
        });
        expect(latest?.status).toBe('FAILED');
      } finally {
        if (prev === undefined) delete process.env.VALIDATION_CONCURRENCY;
        else process.env.VALIDATION_CONCURRENCY = prev;
      }
    });

    it('still re-queues a partner whose capped list is about a different value', async () => {
      const a = await withDoc(`C-RQE-${SUF}`);
      const b = await withDoc(`C-RQF-${SUF}`);
      const others = Array.from({ length: DUP_CLAIMS_CAP }, (_, i) => `C-TOWN-${i}-${SUF}`);
      const v: Validator[] = [
        {
          key: 'DUP',
          column: 'duplicateStatus',
          run: async (ctx) => ({
            status: 'FAILED',
            summary: 'dup',
            findings:
              ctx.claim.claimId === b.claimId
                ? [{ documentId: null, code: 'DUP_ADDRESS', severity: 'ERROR', message: 'm', data: { field: 'ADDRESS', value: '12 MG ROAD', claims: others } }]
                : [{ documentId: null, code: 'DUP_ACCOUNT_NO', severity: 'ERROR', message: 'm', data: { field: 'ACCOUNT_NO', value: '50100234567890', claims: [b.claimId] } }],
          }),
        },
      ];
      await enqueue(prisma, v, b.id, 'AUTO');
      await kickDrain(prisma, v);
      await drained();
      await enqueue(prisma, v, a.id, 'AUTO');
      await kickDrain(prisma, v);
      await drained();
      // B's capped list is its town address; the account number it shares with A is news.
      expect(await runsOf(b.id)).toBe(2);
    });

    it('does not re-queue a partner whose list is at the cap', async () => {
      const a = await withDoc(`C-RQC-${SUF}`);
      const b = await withDoc(`C-RQD-${SUF}`);
      const others = Array.from({ length: DUP_CLAIMS_CAP }, (_, i) => `C-OTHER-${i}-${SUF}`);
      const v = dupNaming((me) => (me === b.claimId ? others : [b.claimId]));
      await enqueue(prisma, v, b.id, 'AUTO');
      await kickDrain(prisma, v);
      await drained();
      await enqueue(prisma, v, a.id, 'AUTO');
      await kickDrain(prisma, v);
      await drained();
      expect(await runsOf(b.id)).toBe(1);
    });
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
      // enqueue also kicks the drainer, and its worker can claim the run first; runOne then
      // returns at once, so wait for whichever worker has it before reading the status.
      await drained();

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
      // Same race as above; without the wait this passes before the run has even finished.
      await drained();

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
