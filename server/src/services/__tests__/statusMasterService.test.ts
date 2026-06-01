import { PrismaClient } from '@prisma/client';
import { StatusMasterService } from '../statusMasterService.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

describe('StatusMasterService', () => {
  let prisma: PrismaClient;
  let service: StatusMasterService;
  let subCategoryId: string;
  let actorId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    service = new StatusMasterService(prisma);
    const sc = await prisma.subCategory.findFirst({ where: { status: 'ACTIVE' } });
    if (!sc) throw new Error('Need at least one ACTIVE SubCategory seeded to run tests');
    subCategoryId = sc.id;
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    if (!admin) throw new Error('Need at least one ADMIN user seeded to run tests');
    actorId = admin.id;
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
  });

  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await disconnectTestPrisma();
  });

  it('creates a StatusMaster with defaults', async () => {
    const s = await service.create(
      { subCategoryId, name: 'Pending', displayOrder: 1, isDefault: true, isTerminal: false },
      actorId
    );
    expect(s.name).toBe('Pending');
    expect(s.isDefault).toBe(true);
    expect(s.status).toBe('ACTIVE');
  });

  it('clears prior default when a new default is created', async () => {
    const a = await service.create({ subCategoryId, name: 'A', isDefault: true }, actorId);
    const b = await service.create({ subCategoryId, name: 'B', isDefault: true }, actorId);
    const refreshedA = await prisma.statusMaster.findUnique({ where: { id: a.id } });
    expect(refreshedA?.isDefault).toBe(false);
    expect(b.isDefault).toBe(true);
  });

  it('rejects duplicate name within a SubCategory', async () => {
    await service.create({ subCategoryId, name: 'Approved' }, actorId);
    await expect(
      service.create({ subCategoryId, name: 'Approved' }, actorId)
    ).rejects.toThrow();
  });

  it('refuses to delete a StatusMaster referenced by a Claim', async () => {
    // Non-default so the in-use guard (not the default guard) is what fires.
    const s = await service.create({ subCategoryId, name: 'InUse', isDefault: false }, actorId);
    await prisma.claim.create({
      data: {
        claimId: 'C-1',
        subCategoryId,
        workflowStatusId: s.id,
        createdBy: actorId,
        updatedBy: actorId,
      },
    });
    await expect(service.delete(s.id)).rejects.toMatchObject({ code: 'STATUS_IN_USE' });
  });

  it('refuses to delete a StatusMaster referenced only by a ClaimRemark (audit history)', async () => {
    // Both non-default so the audit-reference guard is what fires (not the default guard).
    const pending = await service.create(
      { subCategoryId, name: 'Pending', isDefault: false },
      actorId
    );
    const approved = await service.create({ subCategoryId, name: 'Approved' }, actorId);
    // Claim now sits at "Approved"; "Pending" is only referenced by the remark's history.
    const claim = await prisma.claim.create({
      data: {
        claimId: 'C-HIST',
        subCategoryId,
        workflowStatusId: approved.id,
        createdBy: actorId,
        updatedBy: actorId,
      },
    });
    await prisma.claimRemark.create({
      data: {
        claimId: claim.id,
        userId: actorId,
        remarkText: 'moved to approved',
        statusBeforeId: pending.id,
        statusAfterId: approved.id,
      },
    });
    await expect(service.delete(pending.id)).rejects.toMatchObject({ code: 'STATUS_IN_USE' });
  });

  it('list orders by displayOrder then name', async () => {
    await service.create({ subCategoryId, name: 'Zebra', displayOrder: 1 }, actorId);
    await service.create({ subCategoryId, name: 'Alpha', displayOrder: 1 }, actorId);
    await service.create({ subCategoryId, name: 'Middle', displayOrder: 0 }, actorId);
    const list = await service.list({ subCategoryId });
    expect(list.data.map((s) => s.name)).toEqual(['Middle', 'Alpha', 'Zebra']);
  });

  describe('default-status protection', () => {
    it('refuses to deactivate the default status via setStatus', async () => {
      const def = await service.create({ subCategoryId, name: 'Pending', isDefault: true }, actorId);
      await expect(service.setStatus(def.id, 'INACTIVE', actorId)).rejects.toMatchObject({
        code: 'STATUS_IS_DEFAULT',
      });
    });
    it('refuses to deactivate the default status via update', async () => {
      const def = await service.create({ subCategoryId, name: 'Pending', isDefault: true }, actorId);
      await expect(
        service.update(def.id, { status: 'INACTIVE' }, actorId)
      ).rejects.toMatchObject({ code: 'STATUS_IS_DEFAULT' });
    });
    it('refuses to delete the default status', async () => {
      const def = await service.create({ subCategoryId, name: 'Pending', isDefault: true }, actorId);
      await expect(service.delete(def.id)).rejects.toMatchObject({ code: 'STATUS_IS_DEFAULT' });
    });
  });

  it('rejects create for a non-existent SubCategory with SUBCATEGORY_NOT_FOUND', async () => {
    await expect(
      service.create({ subCategoryId: '00000000-0000-0000-0000-000000000000', name: 'X' }, actorId)
    ).rejects.toMatchObject({ code: 'SUBCATEGORY_NOT_FOUND' });
  });
});
