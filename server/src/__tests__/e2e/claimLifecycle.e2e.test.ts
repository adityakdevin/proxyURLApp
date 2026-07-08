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
import { loginAs } from './helpers/auth.js';

describe('E2E: claim lifecycle + RBAC', () => {
  let app: Express;
  let prisma: PrismaClient;
  let g: ScopeGraph;
  let defaultStatusId: string;
  let terminalStatusId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    app = makeTestApp();
    g = await seedScopeGraph(prisma, 'life');
  });

  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await cleanupScopeGraph(prisma, g);
    await disconnectTestPrisma();
  });

  // Claim tables (incl. status masters) are truncated between tests, so re-seed
  // the in-scope workflow statuses each time.
  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    const s = await seedStatuses(prisma, g.subCategoryId, g.admin.id);
    defaultStatusId = s.defaultId;
    terminalStatusId = s.terminalId;
  });

  it('TEAM_LEAD creates a claim seeded with the default status; USER is forbidden', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const res = await tl
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-CREATE' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      claimId: 'C-CREATE',
      workflowStatusId: defaultStatusId,
      spellCheckStatus: 'PENDING',
    });

    const user = await loginAs(app, g.user.username);
    const forbidden = await user
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-NOPE' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('TEAM_LEAD_OR_ADMIN_REQUIRED');
  });

  it('adds a remark with a status change and records the transition', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const created = await tl
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-REMARK' });
    const id = created.body.data.id as string;

    const res = await tl
      .post(`/api/claims/${id}/remarks`)
      .send({ remarkText: 'Looks complete', newStatusId: terminalStatusId });
    expect(res.status).toBe(200);
    expect(res.body.data.workflowStatusId).toBe(terminalStatusId);

    const remarks = await tl.get(`/api/claims/${id}/remarks`);
    expect(remarks.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('blocks a non-admin from moving a claim OUT of a terminal status; admin may override', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const created = await tl
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-TERM' });
    const id = created.body.data.id as string;

    // Into terminal (allowed)
    await tl.post(`/api/claims/${id}/remarks`).send({ remarkText: 'close', newStatusId: terminalStatusId });

    // Out of terminal as TEAM_LEAD -> 409
    const blocked = await tl
      .post(`/api/claims/${id}/remarks`)
      .send({ remarkText: 'reopen', newStatusId: defaultStatusId });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('TERMINAL_STATUS');

    // Admin override -> 200
    const admin = await loginAs(app, g.admin.username);
    const override = await admin
      .post(`/api/claims/${id}/remarks`)
      .send({ remarkText: 'reopen', newStatusId: defaultStatusId });
    expect(override.status).toBe(200);
    expect(override.body.data.workflowStatusId).toBe(defaultStatusId);
  });

  it('forbids a USER (even the assignee) from reassigning a claim', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const created = await tl
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-ASSIGN', assignedToUserId: g.user.id });
    const id = created.body.data.id as string;

    const user = await loginAs(app, g.user.username);
    const res = await user
      .post(`/api/claims/${id}/remarks`)
      .send({ remarkText: 'mine', newAssigneeId: null });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('REASSIGN_FORBIDDEN');
  });

  it('enforces scope: a TEAM_LEAD cannot create a claim in another scope', async () => {
    // Statuses are global, so the default seeded in beforeEach already applies to
    // the out-of-scope sub-category — OUT_OF_SCOPE (not NO_DEFAULT_STATUS) is what
    // refuses creation here.
    const tl = await loginAs(app, g.teamLead.username);
    const res = await tl
      .post('/api/claims')
      .send({ subCategoryId: g.otherSubCategoryId, claimId: 'C-OOS' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUT_OF_SCOPE');
  });

  it('admin soft-deletes a claim (hidden from TL), then restores it', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const admin = await loginAs(app, g.admin.username);
    const created = await tl
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-DEL' });
    const id = created.body.data.id as string;

    const del = await admin.delete(`/api/admin/claims/${id}`);
    expect(del.status).toBe(200);

    // Hidden from the team lead while INACTIVE
    expect((await tl.get(`/api/claims/${id}`)).status).toBe(404);
    // Admin can still read it
    expect((await admin.get(`/api/admin/claims/${id}`)).status).toBe(200);

    const restore = await admin.post(`/api/admin/claims/${id}/restore`);
    expect(restore.status).toBe(200);
    expect((await tl.get(`/api/claims/${id}`)).status).toBe(200);
  });
});
