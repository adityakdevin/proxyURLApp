import type { Express } from 'express';
import { PrismaClient } from '@prisma/client';
import { makeTestApp } from './helpers/app.js';
import { getTestPrisma, disconnectTestPrisma, truncateClaimsTables } from '../helpers/testDb.js';
import { seedScopeGraph, seedStatuses, cleanupScopeGraph, type ScopeGraph } from './helpers/factories.js';
import { loginAs } from './helpers/auth.js';

/**
 * The claim list must report validation work that is queued but not yet started.
 *
 * Nothing else can. The five status columns hold their PREVIOUS values until a validator
 * begins writing, so a claim queued behind a hundred others is byte-identical in the list
 * response to one nobody touched. That is the whole of the reported bug: re-validate queued
 * the work correctly and every row still read as idle, so the action looked like a no-op and
 * the list stopped polling while its own work was still pending.
 *
 * These pin the field the UI keys its spinner off. The QUEUED case is the one that matters —
 * RUNNING was always inferable from the columns, QUEUED never was.
 */
describe('E2E: claim list reports outstanding validation work', () => {
  let app: Express;
  let prisma: PrismaClient;
  let g: ScopeGraph;
  let defaultStatusId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    app = makeTestApp();
    g = await seedScopeGraph(prisma, 'vstate');
  });

  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await cleanupScopeGraph(prisma, g);
    await disconnectTestPrisma();
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    const s = await seedStatuses(prisma, g.subCategoryId, g.admin.id);
    defaultStatusId = s.defaultId;
  });

  async function createClaim(claimId: string): Promise<string> {
    const admin = await loginAs(app, g.admin.username);
    const res = await admin
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId, workflowStatusId: defaultStatusId });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  /** The list row for a claim, as the API actually returns it. */
  async function rowFor(id: string) {
    const admin = await loginAs(app, g.admin.username);
    const res = await admin.get('/api/claims?limit=50');
    expect(res.status).toBe(200);
    return (res.body.data as { id: string; validationState: string | null }[]).find(
      (r) => r.id === id
    );
  }

  it('reports null when the claim has no outstanding run', async () => {
    const id = await createClaim('VS-IDLE-1');
    expect((await rowFor(id))?.validationState).toBeNull();
  });

  it('reports QUEUED for work that has not started — the case the columns cannot express', async () => {
    const id = await createClaim('VS-QUEUED-1');
    await prisma.validationRun.create({
      data: { claimId: id, status: 'QUEUED', trigger: 'MANUAL' },
    });

    const row = await rowFor(id);
    expect(row?.validationState).toBe('QUEUED');
    // The point of the field: every status column still reads exactly as it did before the
    // run was queued. Anything deriving "is something happening" from these alone sees
    // nothing — which is precisely the bug.
    const cols = row as unknown as Record<string, string>;
    for (const c of [
      'spellCheckStatus',
      'qrStatus',
      'metaExtractionStatus',
      'intraClaimStatus',
      'fullScanStatus',
    ]) {
      expect(cols[c]).not.toBe('IN_PROGRESS');
    }
  });

  it('reports RUNNING once a validator has picked the claim up', async () => {
    const id = await createClaim('VS-RUNNING-1');
    await prisma.validationRun.create({
      data: { claimId: id, status: 'RUNNING', trigger: 'MANUAL', startedAt: new Date() },
    });
    expect((await rowFor(id))?.validationState).toBe('RUNNING');
  });

  it('prefers RUNNING over QUEUED when a claim was re-queued mid-run', async () => {
    // Legal and expected: the row action stays clickable while work is outstanding, so a
    // reviewer can re-queue a claim that looks wedged. Both runs are then outstanding and
    // "running" is the more specific of the two — reporting QUEUED here would tell the
    // reviewer their claim is waiting when a validator already has it.
    const id = await createClaim('VS-BOTH-1');
    await prisma.validationRun.create({
      data: { claimId: id, status: 'RUNNING', trigger: 'MANUAL', startedAt: new Date() },
    });
    await prisma.validationRun.create({
      data: { claimId: id, status: 'QUEUED', trigger: 'MANUAL' },
    });
    expect((await rowFor(id))?.validationState).toBe('RUNNING');
  });

  it('ignores finished runs, so a completed claim does not spin forever', async () => {
    const id = await createClaim('VS-DONE-1');
    await prisma.validationRun.create({
      data: {
        claimId: id,
        status: 'COMPLETED',
        trigger: 'MANUAL',
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });
    await prisma.validationRun.create({
      data: { claimId: id, status: 'FAILED', trigger: 'MANUAL', finishedAt: new Date() },
    });
    expect((await rowFor(id))?.validationState).toBeNull();
  });

  it('does not leak one claim’s queued run onto its neighbours', async () => {
    const queued = await createClaim('VS-NEIGHBOUR-A');
    const idle = await createClaim('VS-NEIGHBOUR-B');
    await prisma.validationRun.create({
      data: { claimId: queued, status: 'QUEUED', trigger: 'MANUAL' },
    });
    expect((await rowFor(queued))?.validationState).toBe('QUEUED');
    expect((await rowFor(idle))?.validationState).toBeNull();
  });
});
