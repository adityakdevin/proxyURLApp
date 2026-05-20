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
  afterAll(async () => { await disconnectTestPrisma(); });

  async function seedDefaultStatus(name = 'Pending') {
    return statusService.create({ subCategoryId, name, isDefault: true }, adminId);
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
      { subCategoryId, name: 'Approved', isTerminal: true },
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
    const c = await service.create(
      { subCategoryId, claimId: 'C-1', assignedToUserId: userId },
      adminId
    );
    await expect(
      service.appendRemark(c.id, { remarkText: 'r', newAssigneeId: null }, userId, 'USER')
    ).rejects.toMatchObject({ code: 'REASSIGN_FORBIDDEN' });
  });
});
