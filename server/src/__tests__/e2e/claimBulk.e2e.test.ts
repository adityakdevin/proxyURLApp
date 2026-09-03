import { randomUUID } from 'crypto';
import type { Express } from 'express';
import { PrismaClient } from '@prisma/client';
import { makeTestApp } from './helpers/app.js';
import { getTestPrisma, disconnectTestPrisma, truncateClaimsTables } from '../helpers/testDb.js';
import {
  seedScopeGraph,
  seedStatuses,
  cleanupScopeGraph,
  type ScopeGraph,
} from './helpers/factories.js';
import { loginAs, type Agent } from './helpers/auth.js';
import { BULK_MAX } from '../../lib/bulkClaims.js';

/**
 * The bulk endpoints at the HTTP layer. bulkClaims.test.ts already covers
 * resolveTargets/runBulk in isolation; what is NOT covered there is the wiring —
 * that a refusal reaches the client with its own status code, that the admin-only
 * guard on /bulk/delete fires before anything is resolved, and above all that a
 * claim the caller may not touch fails on its own instead of riding along with
 * the batch.
 */
describe('E2E: bulk claim actions', () => {
  let app: Express;
  let prisma: PrismaClient;
  let g: ScopeGraph;
  let defaultStatusId: string;
  let terminalStatusId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    app = makeTestApp();
    g = await seedScopeGraph(prisma, 'bulk');
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
    terminalStatusId = s.terminalId;
  });

  /** Create a claim through the API as the given agent and return its id. */
  async function createClaim(
    agent: Agent,
    claimId: string,
    subCategoryId: string,
    body: Record<string, unknown> = {}
  ): Promise<string> {
    const res = await agent.post('/api/claims').send({ subCategoryId, claimId, ...body });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  it('refuses a non-admin outright on /bulk/delete, before any target is resolved', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const res = await tl.post('/api/claims/bulk/delete').send({ ids: ['whatever'] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');

    const user = await loginAs(app, g.user.username);
    expect((await user.post('/api/claims/bulk/delete').send({ ids: [] })).status).toBe(403);
  });

  it('surfaces each target-resolution refusal with its own status code', async () => {
    const tl = await loginAs(app, g.teamLead.username);

    const noTargets = await tl.post('/api/claims/bulk/validate').send({});
    expect(noTargets.status).toBe(400);
    expect(noTargets.body.code).toBe('NO_TARGETS');

    const badFilter = await tl
      .post('/api/claims/bulk/validate')
      .send({ filters: { qrStatus: 'NOT_A_STATUS' } });
    expect(badFilter.status).toBe(400);
    expect(badFilter.body.code).toBe('INVALID_FILTER');

    const tooMany = await tl
      .post('/api/claims/bulk/validate')
      // Real UUIDs: the route validates the shape of each id first, so `id-0` would be
      // refused as malformed before the cap is ever reached.
      .send({ ids: Array.from({ length: BULK_MAX + 1 }, () => randomUUID()) });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.code).toBe('BULK_TOO_LARGE');
    // Refused, not trimmed — the message has to name the number the caller sent.
    expect(tooMany.body.error).toContain(String(BULK_MAX + 1));

    // The body gate still runs first on /bulk/remarks: an empty remark never
    // reaches target resolution. A REAL uuid, so remarkText is the only invalid field —
    // with `ids: ['x']` this passed on the isUUID error instead and would have kept passing
    // with the remark validator deleted.
    const emptyRemark = await tl
      .post('/api/claims/bulk/remarks')
      .send({ ids: [randomUUID()], remarkText: '  ' });
    expect(emptyRemark.status).toBe(400);
    expect(emptyRemark.body.code).toBe('VALIDATION_ERROR');

    // A malformed id is its own 400, so the two gates are pinned independently.
    const badId = await tl
      .post('/api/claims/bulk/remarks')
      .send({ ids: ['x'], remarkText: 'fine' });
    expect(badId.status).toBe(400);
    expect(badId.body.code).toBe('VALIDATION_ERROR');

    // The 2000-char cap, and that the refusal names the limit rather than "Invalid value".
    const tooLong = await tl
      .post('/api/claims/bulk/remarks')
      .send({ ids: [randomUUID()], remarkText: 'a'.repeat(2001) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toContain('2000');
  });

  it('fails an out-of-scope claim on its own and still applies the rest of the batch', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const otherTl = await loginAs(app, g.otherTeamLead.username);
    const mine = await createClaim(tl, 'BULK-MINE', g.subCategoryId);
    const theirs = await createClaim(otherTl, 'BULK-THEIRS', g.otherSubCategoryId);

    const res = await tl
      .post('/api/claims/bulk/remarks')
      .send({ ids: [mine, theirs], remarkText: 'batch remark', newStatusId: terminalStatusId });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      requested: 2,
      succeeded: 1,
      failed: [{ id: theirs, code: 'CLAIM_NOT_EDITABLE' }],
    });

    const [a, b] = await Promise.all([
      prisma.claim.findUnique({ where: { id: mine } }),
      prisma.claim.findUnique({ where: { id: theirs } }),
    ]);
    expect(a!.workflowStatusId).toBe(terminalStatusId);
    // The refused claim is untouched — no status move, no remark.
    expect(b!.workflowStatusId).toBe(defaultStatusId);
    expect(await prisma.claimRemark.count({ where: { claimId: theirs } })).toBe(0);
  });

  it('queues nothing for a USER who is not the assignee', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const mine = await createClaim(tl, 'BULK-ASSIGNED', g.subCategoryId, {
      assignedToUserId: g.user.id,
    });
    const notMine = await createClaim(tl, 'BULK-UNASSIGNED', g.subCategoryId);

    const user = await loginAs(app, g.user.username);
    const res = await user.post('/api/claims/bulk/validate').send({ ids: [notMine] });

    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({
      requested: 1,
      succeeded: 0,
      failed: [{ id: notMine, code: 'CLAIM_NOT_EDITABLE' }],
    });
    // The refusal happens BEFORE enqueue, so no validation run exists for either claim.
    expect(
      await prisma.validationRun.count({ where: { claimId: { in: [mine, notMine] } } })
    ).toBe(0);
  });

  it('resolves "all matching" through the filters and never steps outside the caller scope', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const otherTl = await loginAs(app, g.otherTeamLead.username);
    const a = await createClaim(tl, 'MATCH-1', g.subCategoryId);
    const b = await createClaim(tl, 'MATCH-2', g.subCategoryId);
    const skipped = await createClaim(tl, 'OTHER-1', g.subCategoryId);
    const theirs = await createClaim(otherTl, 'MATCH-3', g.otherSubCategoryId);

    const res = await tl
      .post('/api/claims/bulk/remarks')
      .send({ filters: { search: 'MATCH-' }, remarkText: 'all matching', newStatusId: terminalStatusId });

    expect(res.status).toBe(200);
    // MATCH-3 belongs to the disjoint scope: it never becomes a target at all,
    // so it is not even reported as a failure.
    expect(res.body.data).toEqual({ requested: 2, succeeded: 2, failed: [] });

    const moved = await prisma.claim.findMany({
      where: { workflowStatusId: terminalStatusId },
      select: { id: true },
    });
    expect(moved.map((m) => m.id).sort()).toEqual([a, b].sort());
    expect((await prisma.claim.findUnique({ where: { id: skipped } }))!.workflowStatusId).toBe(
      defaultStatusId
    );
    expect((await prisma.claim.findUnique({ where: { id: theirs } }))!.workflowStatusId).toBe(
      defaultStatusId
    );
  });

  it('admin soft-deletes a selection, and repeating the call is idempotent', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const admin = await loginAs(app, g.admin.username);
    const a = await createClaim(tl, 'DEL-1', g.subCategoryId);
    const b = await createClaim(tl, 'DEL-2', g.subCategoryId);

    const res = await admin.post('/api/claims/bulk/delete').send({ ids: [a, b] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requested: 2, succeeded: 2, failed: [] });
    const rows = await prisma.claim.findMany({ where: { id: { in: [a, b] } } });
    expect(rows.every((r) => r.status === 'INACTIVE')).toBe(true);
    // Hidden from the team lead afterwards.
    expect((await tl.get(`/api/claims/${a}`)).status).toBe(404);

    const again = await admin.post('/api/claims/bulk/delete').send({ ids: [a, b] });
    expect(again.body.data).toEqual({ requested: 2, succeeded: 2, failed: [] });

    // A claim that does not exist is reported per-id, not as a 500.
    const missing = await admin
      .post('/api/claims/bulk/delete')
      .send({ ids: ['00000000-0000-4000-8000-000000000000'] });
    expect(missing.status).toBe(200);
    expect(missing.body.data.failed).toEqual([
      { id: '00000000-0000-4000-8000-000000000000', code: 'NOT_FOUND' },
    ]);
  });

  it('admin restores a deleted selection, and a non-admin cannot', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const admin = await loginAs(app, g.admin.username);
    const a = await createClaim(tl, 'RES-1', g.subCategoryId);
    const b = await createClaim(tl, 'RES-2', g.subCategoryId);
    await admin.post('/api/claims/bulk/delete').send({ ids: [a, b] });

    expect((await tl.post('/api/claims/bulk/restore').send({ ids: [a] })).status).toBe(403);

    const res = await admin.post('/api/claims/bulk/restore').send({ ids: [a, b] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requested: 2, succeeded: 2, failed: [] });
    const rows = await prisma.claim.findMany({ where: { id: { in: [a, b] } } });
    expect(rows.every((r) => r.status === 'ACTIVE')).toBe(true);
    // Back in the team lead's list.
    expect((await tl.get(`/api/claims/${a}`)).status).toBe(200);
  });

  it('pins a filters-aimed restore to the deleted set, not the list the client sent', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const admin = await loginAs(app, g.admin.username);
    const kept = await createClaim(tl, 'PIN-KEEP', g.subCategoryId);
    const gone = await createClaim(tl, 'PIN-GONE', g.subCategoryId);
    await admin.post('/api/claims/bulk/delete').send({ ids: [gone] });

    // The bulk bar forwards the list's own filters; a client that has not set the lifecycle
    // would otherwise resolve the ACTIVE claim and report a success that changed nothing.
    const res = await admin.post('/api/claims/bulk/restore').send({ filters: {} });
    expect(res.status).toBe(200);
    expect(res.body.data.requested).toBe(1);
    expect((await prisma.claim.findUnique({ where: { id: gone } }))!.status).toBe('ACTIVE');
    expect((await prisma.claim.findUnique({ where: { id: kept } }))!.status).toBe('ACTIVE');

    const log = await prisma.claimAuditLog.findFirst({
      where: { action: 'BULK_RESTORE' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log!.filters).toEqual({ status: 'INACTIVE' });
  });

  it('restoring an already-active claim is a no-op success, not an error', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const admin = await loginAs(app, g.admin.username);
    const a = await createClaim(tl, 'RES-IDEM', g.subCategoryId);

    // Never deleted. restore() short-circuits on an ACTIVE claim, so this must report a
    // success rather than a failure — the same retry-safety contract /bulk/delete has.
    const res = await admin.post('/api/claims/bulk/restore').send({ ids: [a] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ requested: 1, succeeded: 1, failed: [] });
    expect((await prisma.claim.findUnique({ where: { id: a } }))!.status).toBe('ACTIVE');
    // A no-op restore must not invent a remark on the claim's timeline.
    const remarks = await prisma.claimRemark.count({
      where: { claimId: a, remarkText: 'Claim restored from soft-delete' },
    });
    expect(remarks).toBe(0);
  });

  it('filters the audit log by action and by actor', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const admin = await loginAs(app, g.admin.username);
    const a = await createClaim(tl, 'AUD-F1', g.subCategoryId);
    await admin.post('/api/claims/bulk/delete').send({ ids: [a] });
    await admin.post('/api/claims/bulk/restore').send({ ids: [a] });

    const byAction = await admin.get('/api/admin/claim-audit-logs?action=BULK_RESTORE');
    expect(byAction.status).toBe(200);
    expect(byAction.body.data).toHaveLength(1);
    expect(byAction.body.data[0].action).toBe('BULK_RESTORE');

    const byUser = await admin.get(`/api/admin/claim-audit-logs?userId=${g.admin.id}`);
    expect(byUser.body.data.length).toBeGreaterThanOrEqual(2);

    // An actor who ran nothing has an empty trail, not everyone else's.
    const byOther = await admin.get(`/api/admin/claim-audit-logs?userId=${g.teamLead.id}`);
    expect(byOther.body.data).toHaveLength(0);

    // An unknown action is refused by the validator rather than silently ignored,
    // which would return every row and read as "these all match".
    const bogus = await admin.get('/api/admin/claim-audit-logs?action=NOT_AN_ACTION');
    expect(bogus.status).toBe(400);
  });

  it('records every bulk action against the admin who ran it', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const admin = await loginAs(app, g.admin.username);
    const a = await createClaim(tl, 'AUD-1', g.subCategoryId);

    await admin.post('/api/claims/bulk/delete').send({ ids: [a] });

    const log = await prisma.claimAuditLog.findFirst({ where: { action: 'BULK_DELETE' } });
    expect(log).toMatchObject({
      userId: g.admin.id,
      targeting: 'IDS',
      requested: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(log!.claimIds).toEqual([a]);
    expect(log!.filters).toBeNull();

    // Reachable without SQL — the whole point of the table.
    const listed = await admin.get(`/api/admin/claim-audit-logs?claimId=${a}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].user.id).toBe(g.admin.id);
    // Admin-only, like every other /admin route.
    expect((await tl.get('/api/admin/claim-audit-logs')).status).toBe(403);
  });

  it('finds a SINGLE-claim audit row by claim id, whatever case the caller spelled it in', async () => {
    // The gap the casing bug lived in. `param('id').isUUID()` accepts uppercase and MySQL's
    // utf8mb4_unicode_ci matches the claim either way, so the delete succeeds — but the
    // JSON claim_ids column is searched with array_contains, an EXACT string match. Writing
    // the uppercase spelling made the row unfindable by the claim it described, and every
    // existing assertion passed because Prisma's uuid() is lowercase on both sides.
    const tl = await loginAs(app, g.teamLead.username);
    const admin = await loginAs(app, g.admin.username);
    const id = await createClaim(tl, 'AUD-CASE-1', g.subCategoryId);

    const del = await admin.delete(`/api/admin/claims/${id.toUpperCase()}`);
    expect(del.status).toBe(200);

    const listed = await admin.get(`/api/admin/claim-audit-logs?claimId=${id}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].action).toBe('DELETE');
    expect(listed.body.data[0].targeting).toBe('SINGLE');
  });

  it('includes rows from the end date itself, not everything before midnight', async () => {
    // `new Date('2026-09-03')` is midnight UTC, so an lte against a date-only endDate used
    // to exclude the whole of that day — "up to today" answered as if nobody had done
    // anything.
    const tl = await loginAs(app, g.teamLead.username);
    const admin = await loginAs(app, g.admin.username);
    const id = await createClaim(tl, 'AUD-DATE-1', g.subCategoryId);
    await admin.post('/api/claims/bulk/delete').send({ ids: [id] });

    const today = new Date().toISOString().slice(0, 10);
    const listed = await admin.get(`/api/admin/claim-audit-logs?endDate=${today}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.length).toBeGreaterThan(0);
  });

  it('refuses to delete a user who has recorded claim actions, and deletes one who has not', async () => {
    // ClaimAuditLog is the one relation off User that does NOT cascade, so the hard delete
    // at DELETE /api/admin/users/:id hit the foreign key and surfaced as a 500 with a
    // constraint name. An admin should be told to deactivate instead.
    const admin = await loginAs(app, g.admin.username);
    const tl = await loginAs(app, g.teamLead.username);
    const id = await createClaim(tl, 'AUD-USERDEL-1', g.subCategoryId);

    // A single bulk remark is enough to make the team lead an actor.
    await tl.post('/api/claims/bulk/remarks').send({ ids: [id], remarkText: 'looked at it' });
    expect(await prisma.claimAuditLog.count({ where: { userId: g.teamLead.id } })).toBe(1);

    const refused = await admin.delete(`/api/admin/users/${g.teamLead.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('USER_HAS_AUDIT_HISTORY');
    // Refused means untouched — the account is still there to deactivate.
    expect(await prisma.user.findUnique({ where: { id: g.teamLead.id } })).not.toBeNull();

    // The guard is the audit history, not the role: a user who never acted still deletes.
    const bystander = await prisma.user.create({
      data: {
        username: `bystander-${randomUUID().slice(0, 8)}`,
        passwordHash: 'x',
        fullName: 'Bystander',
        role: 'USER',
        status: 'ACTIVE',
        forcePasswordChange: false,
      },
    });
    expect((await admin.delete(`/api/admin/users/${bystander.id}`)).status).toBe(200);
  });

  it('queues a MANUAL run per claim on the success path of /bulk/validate', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const a = await createClaim(tl, 'BV-1', g.subCategoryId);
    const b = await createClaim(tl, 'BV-2', g.subCategoryId);

    const res = await tl.post('/api/claims/bulk/validate').send({ ids: [a, b] });
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ requested: 2, succeeded: 2, failed: [] });

    // The report alone proved nothing: every other /bulk/validate case in this file asserts
    // a refusal or a zero-claim batch, so deleting the enqueue() call left the suite green.
    const runs = await prisma.validationRun.findMany({ where: { claimId: { in: [a, b] } } });
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.trigger === 'MANUAL')).toBe(true);
    expect(runs.every((r) => r.triggeredBy === g.teamLead.id)).toBe(true);
  });

  it('reassigns only when newAssigneeId is sent, and never unassigns otherwise', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const a = await createClaim(tl, 'RA-1', g.subCategoryId, { assignedToUserId: g.user.id });
    const b = await createClaim(tl, 'RA-2', g.subCategoryId, { assignedToUserId: g.user.id });

    // A status-only bulk remark must leave the assignee alone. appendRemark reads the KEY's
    // presence as "reassign" and a falsy value as disconnect, so dropping the hasOwnProperty
    // guard in the route would silently unassign every claim in the batch.
    const statusOnly = await tl
      .post('/api/claims/bulk/remarks')
      .send({ ids: [a, b], remarkText: 'status only', newStatusId: terminalStatusId });
    expect(statusOnly.body.data.succeeded).toBe(2);
    let rows = await prisma.claim.findMany({ where: { id: { in: [a, b] } } });
    expect(rows.every((r) => r.assignedToUserId === g.user.id)).toBe(true);

    // An explicit null is the documented way to clear it.
    const cleared = await tl
      .post('/api/claims/bulk/remarks')
      .send({ ids: [a, b], remarkText: 'unassign', newAssigneeId: null });
    expect(cleared.body.data.succeeded).toBe(2);
    rows = await prisma.claim.findMany({ where: { id: { in: [a, b] } } });
    expect(rows.every((r) => r.assignedToUserId === null)).toBe(true);
  });

  it('serves the claim neighbours and is not shadowed by the /:id route', async () => {
    const tl = await loginAs(app, g.teamLead.username);
    const first = await createClaim(tl, 'ADJ-1', g.subCategoryId);
    const second = await createClaim(tl, 'ADJ-2', g.subCategoryId);

    // Pin the timestamps. createdAt is DATETIME(3), so two claims created in the same
    // millisecond fall through to the id-desc tiebreak and "ADJ-2 is the top row" becomes a
    // coin toss on random UUIDs. claimService.test.ts guards the same way.
    await prisma.claim.update({
      where: { id: first },
      data: { createdAt: new Date(Date.UTC(2026, 0, 1)) },
    });
    await prisma.claim.update({
      where: { id: second },
      data: { createdAt: new Date(Date.UTC(2026, 0, 2)) },
    });

    const res = await tl.get(`/api/claims/${second}/adjacent`);
    expect(res.status).toBe(200);
    // Newest-first list: ADJ-2 is the top row, so it has no prev and ADJ-1 below it.
    expect(res.body.data.prev).toBeNull();
    expect(res.body.data.next).toMatchObject({ id: first, claimId: 'ADJ-1', documentId: null });

    const unknown = await tl.get('/api/claims/00000000-0000-4000-8000-000000000000/adjacent');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('NOT_FOUND');

    const malformed = await tl.get('/api/claims/not-a-uuid/adjacent');
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('VALIDATION_ERROR');
  });
});
