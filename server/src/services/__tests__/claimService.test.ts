import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { ClaimService } from '../claimService.js';
import { StatusMasterService } from '../statusMasterService.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

describe('ClaimService', () => {
  let prisma: PrismaClient;
  let service: ClaimService;
  let statusService: StatusMasterService;
  let subCategoryId: string;
  let adminId: string;
  let userId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    service = new ClaimService(prisma);
    statusService = new StatusMasterService(prisma);
    const sc = await prisma.subCategory.findFirst({ where: { status: 'ACTIVE' } });
    subCategoryId = sc!.id;
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    adminId = admin!.id;
    const u = await prisma.user.findFirst({ where: { role: 'USER' } });
    userId = u ? u.id : adminId;
  });
  beforeEach(async () => { await truncateClaimsTables(prisma); });
  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await disconnectTestPrisma();
  });

  async function seedDefaultStatus(name = 'Pending') {
    return statusService.create({ name, isDefault: true }, adminId);
  }

  it('creates a claim and uses the SubCategory default status', async () => {
    const def = await seedDefaultStatus();
    const c = await service.create({ subCategoryId, claimId: 'C-1' }, adminId);
    expect(c.workflowStatusId).toBe(def.id);
    expect(c.spellCheckStatus).toBe('PENDING');
  });

  it('refuses creation if SubCategory has no active default status', async () => {
    await expect(
      service.create({ subCategoryId, claimId: 'C-1' }, adminId)
    ).rejects.toMatchObject({ code: 'NO_DEFAULT_STATUS' });
  });

  it('writes ClaimRemark when remarkText supplied on create', async () => {
    await seedDefaultStatus();
    const c = await service.create(
      { subCategoryId, claimId: 'C-1', remarkText: 'Imported' },
      adminId
    );
    const remarks = await prisma.claimRemark.findMany({ where: { claimId: c.id } });
    expect(remarks).toHaveLength(1);
    expect(remarks[0].remarkText).toBe('Imported');
  });

  it('appendRemark with status change writes status before/after', async () => {
    const def = await seedDefaultStatus();
    const approved = await statusService.create(
      { name: 'Approved', isTerminal: true },
      adminId
    );
    const c = await service.create({ subCategoryId, claimId: 'C-1' }, adminId);
    await service.appendRemark(c.id, { remarkText: 'Done', newStatusId: approved.id }, adminId);
    const reloaded = await prisma.claim.findUnique({ where: { id: c.id } });
    expect(reloaded?.workflowStatusId).toBe(approved.id);
    const remarks = await prisma.claimRemark.findMany({
      where: { claimId: c.id },
      orderBy: { createdAt: 'asc' },
    });
    const last = remarks[remarks.length - 1];
    expect(last.statusBeforeId).toBe(def.id);
    expect(last.statusAfterId).toBe(approved.id);
  });

  it('canEditClaim: ADMIN always true', async () => {
    await seedDefaultStatus();
    const c = await service.create({ subCategoryId, claimId: 'C-1' }, adminId);
    expect(await service.canEditClaim(c.id, adminId, 'ADMIN')).toBe(true);
  });

  it('rejects assignee reassignment by USER', async () => {
    await seedDefaultStatus();
    const c = await service.create({ subCategoryId, claimId: 'C-1' }, adminId);
    await expect(
      service.appendRemark(c.id, { remarkText: 'r', newAssigneeId: null }, userId, 'USER')
    ).rejects.toMatchObject({ code: 'REASSIGN_FORBIDDEN' });
  });

  describe('soft-delete / restore', () => {
    it('blocks editing a soft-deleted claim and refuses appendRemark, then restore re-enables it', async () => {
      await seedDefaultStatus();
      const c = await service.create({ subCategoryId, claimId: 'C-DEL' }, adminId);
      expect(await service.canEditClaim(c.id, adminId, 'ADMIN')).toBe(true);

      await service.softDelete(c.id, adminId);
      // Not editable by anyone (incl. admin) while INACTIVE.
      expect(await service.canEditClaim(c.id, adminId, 'ADMIN')).toBe(false);
      // appendRemark on an inactive claim is refused as if not found.
      await expect(
        service.appendRemark(c.id, { remarkText: 'x' }, adminId, 'ADMIN')
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // Admin can still READ it (for audit / restore).
      expect(await service.getById(c.id, adminId, 'ADMIN')).not.toBeNull();

      await service.restore(c.id, adminId);
      expect(await service.canEditClaim(c.id, adminId, 'ADMIN')).toBe(true);
    });

    it('admin list honours an explicit INACTIVE status filter (default hides it)', async () => {
      await seedDefaultStatus();
      const c = await service.create({ subCategoryId, claimId: 'C-HIDE' }, adminId);
      await service.softDelete(c.id, adminId);
      const active = await service.list({ scope: 'ALL', callerId: adminId });
      expect(active.data.find((x) => x.id === c.id)).toBeUndefined();
      const inactive = await service.list({ scope: 'ALL', callerId: adminId, status: 'INACTIVE' });
      expect(inactive.data.find((x) => x.id === c.id)).toBeDefined();
    });
  });

  describe('adjacent', () => {
    it('walks the claims either side in list order, and stops at the ends', async () => {
      await seedDefaultStatus();
      for (const [i, claimId] of ['C-A', 'C-B', 'C-C'].entries()) {
        const c = await service.create({ subCategoryId, claimId }, adminId);
        // Distinct timestamps: created in the same millisecond, list order is a coin toss
        // and there is no fixed "either side" to assert.
        await prisma.claim.update({
          where: { id: c.id },
          data: { createdAt: new Date(Date.UTC(2026, 0, 1 + i)) },
        });
      }
      // Newest first, so the list reads C-C, C-B, C-A.
      const [newest, middle, oldest] = (await service.list({ scope: 'ALL', callerId: adminId }))
        .data;
      expect([newest.claimId, middle.claimId, oldest.claimId]).toEqual(['C-C', 'C-B', 'C-A']);

      const mid = await service.adjacent(middle.id, { scope: 'ALL', callerId: adminId });
      expect(mid!.prev?.id).toBe(newest.id);
      expect(mid!.next?.id).toBe(oldest.id);
      expect(mid!.prev?.documentId).toBeNull(); // no documents uploaded in this test

      expect((await service.adjacent(newest.id, { scope: 'ALL', callerId: adminId }))!.prev).toBeNull();
      expect((await service.adjacent(oldest.id, { scope: 'ALL', callerId: adminId }))!.next).toBeNull();
    });

    it('refuses an anchor claim the caller may not see', async () => {
      await seedDefaultStatus();
      const c = await service.create({ subCategoryId, claimId: 'C-OOS' }, adminId);
      // Out-of-scope anchor: same answer as a claim that does not exist, or the endpoint
      // becomes an oracle for "does this id exist, and where does it sit in my timeline".
      expect(
        await service.adjacent(c.id, { scope: { subCategoryIds: [] }, callerId: userId })
      ).toBeNull();
      expect(
        await service.adjacent(randomUUID(), { scope: 'ALL', callerId: adminId })
      ).toBeNull();
    });

    it('steps deterministically when neighbours share a createdAt (scan import)', async () => {
      await seedDefaultStatus();
      const sameMoment = new Date(Date.UTC(2026, 1, 2));
      const made: string[] = [];
      for (const claimId of ['S-1', 'S-2', 'S-3']) {
        const c = await service.create({ subCategoryId, claimId }, adminId);
        await prisma.claim.update({ where: { id: c.id }, data: { createdAt: sameMoment } });
        made.push(c.id);
      }
      // A scan creates every claim in one moment, so createdAt alone cannot order them; the
      // id tiebreak has to give the same sequence the list walks.
      const listed = (await service.list({ scope: 'ALL', callerId: adminId })).data.map((c) => c.id);
      const middle = await service.adjacent(listed[1], { scope: 'ALL', callerId: adminId });
      expect(middle!.prev?.id).toBe(listed[0]);
      expect(middle!.next?.id).toBe(listed[2]);
      expect(new Set(listed)).toEqual(new Set(made));
    });

    it('never steps outside the caller scope', async () => {
      await seedDefaultStatus();
      const a = await service.create({ subCategoryId, claimId: 'C-IN' }, adminId);
      const b = await service.create({ subCategoryId, claimId: 'C-OUT' }, adminId);
      // In scope for the anchor, but the neighbour lives in a sub-category the caller has
      // no access to, so there is nothing to step to.
      const scoped = await service.adjacent(a.id, {
        scope: { subCategoryIds: [subCategoryId] },
        callerId: userId,
      });
      expect(scoped!.prev?.id ?? null).not.toBe(undefined);
      expect([scoped!.prev?.id, scoped!.next?.id].filter(Boolean)).toEqual([b.id]);
    });
  });

  describe('idsMatching', () => {
    it('stays inside scope and refuses over the cap without returning ids', async () => {
      await seedDefaultStatus();
      const a = await service.create({ subCategoryId, claimId: 'IM-1' }, adminId);
      await service.create({ subCategoryId, claimId: 'IM-2' }, adminId);

      const scoped = await service.idsMatching(
        { scope: { subCategoryIds: [subCategoryId] }, callerId: userId },
        10
      );
      expect(scoped.ids).toContain(a.id);
      expect(scoped.ids).toHaveLength(2);
      expect(scoped.total).toBe(2);

      const none = await service.idsMatching(
        { scope: { subCategoryIds: [] }, callerId: userId },
        10
      );
      expect(none).toEqual({ ids: [], total: 0 });

      // Over the cap the caller gets the true total and NO ids — the refusal must not be
      // silently downgraded to acting on an arbitrary slice.
      const capped = await service.idsMatching({ scope: 'ALL', callerId: adminId }, 1);
      expect(capped.ids).toEqual([]);
      expect(capped.total).toBe(2);
    });

    it('does not let a scoped caller widen past their own sub-category filter', async () => {
      await seedDefaultStatus();
      await service.create({ subCategoryId, claimId: 'IM-3' }, adminId);
      // Naming a sub-category the caller has no access to must match nothing, not fall back
      // to every sub-category they DO have — bulk mutates through this where.
      const outside = await service.idsMatching(
        {
          subCategoryId: randomUUID(),
          scope: { subCategoryIds: [subCategoryId] },
          callerId: userId,
        },
        10
      );
      expect(outside).toEqual({ ids: [], total: 0 });
    });
  });

  describe('terminal status enforcement', () => {
    it('blocks a non-admin from moving a claim out of a terminal status; admin may override', async () => {
      const def = await seedDefaultStatus();
      const closed = await statusService.create(
        { name: 'Closed', isTerminal: true },
        adminId
      );
      const c = await service.create({ subCategoryId, claimId: 'C-TERM' }, adminId);
      // Move INTO terminal (allowed — current status is the non-terminal default).
      await service.appendRemark(c.id, { remarkText: 'close', newStatusId: closed.id }, adminId, 'TEAM_LEAD');

      // Move OUT of terminal as TEAM_LEAD → blocked.
      await expect(
        service.appendRemark(c.id, { remarkText: 'reopen', newStatusId: def.id }, adminId, 'TEAM_LEAD')
      ).rejects.toMatchObject({ code: 'TERMINAL_STATUS' });

      // Admin override is allowed.
      const reopened = await service.appendRemark(
        c.id,
        { remarkText: 'reopen', newStatusId: def.id },
        adminId,
        'ADMIN'
      );
      expect(reopened.workflowStatusId).toBe(def.id);
    });
  });

  it('concurrent create of the same claimId: exactly one wins, the other gets DUPLICATE_CLAIM_ID', async () => {
    await seedDefaultStatus();
    const results = await Promise.allSettled([
      service.create({ subCategoryId, claimId: 'C-RACE' }, adminId),
      service.create({ subCategoryId, claimId: 'C-RACE' }, adminId),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'DUPLICATE_CLAIM_ID' });
  });
});
