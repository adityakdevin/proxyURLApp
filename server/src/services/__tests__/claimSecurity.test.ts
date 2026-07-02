import { PrismaClient } from '@prisma/client';
import { ClaimService } from '../claimService.js';
import { StatusMasterService } from '../statusMasterService.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

/**
 * Self-contained security tests for ClaimService. Builds its own
 * Project / Category / SubCategory / User / UserAssignment graph (none of
 * which is touched by truncateClaimsTables) and tears it all down in afterAll,
 * so the suite does not depend on ambient seed data and leaves no residue.
 */
describe('ClaimService — scope & assignee security', () => {
  let prisma: PrismaClient;
  let service: ClaimService;
  let statusService: StatusMasterService;

  // Scope A
  let ptA: string;
  let scA: string; // SubCategory in scope A
  // Scope B
  let ptB: string;
  let scB: string; // SubCategory in scope B

  let adminId: string;
  let inScopeUser: string; // ACTIVE USER assigned to (ptA)
  let outScopeUser: string; // ACTIVE USER assigned to (ptB)
  let inactiveUser: string; // INACTIVE USER assigned to (ptA)
  let teamLeadA: string; // TEAM_LEAD assigned to (ptA)
  let teamLeadB: string; // TEAM_LEAD assigned to (ptB)

  const SUF = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    prisma = getTestPrisma();
    service = new ClaimService(prisma);
    statusService = new StatusMasterService(prisma);

    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    if (!admin) throw new Error('Need an ADMIN user seeded to run these tests');
    adminId = admin.id;

    const [projectA, projectB] = await Promise.all([
      prisma.project.create({ data: { name: `csec-ptA-${SUF}` } }),
      prisma.project.create({ data: { name: `csec-ptB-${SUF}` } }),
    ]);
    ptA = projectA.id;
    ptB = projectB.id;

    const catA = await prisma.category.create({
      data: { name: `csec-catA-${SUF}`, projectId: ptA },
    });
    const catB = await prisma.category.create({
      data: { name: `csec-catB-${SUF}`, projectId: ptB },
    });
    const subA = await prisma.subCategory.create({
      data: { name: `csec-scA-${SUF}`, categoryId: catA.id },
    });
    const subB = await prisma.subCategory.create({
      data: { name: `csec-scB-${SUF}`, categoryId: catB.id },
    });
    scA = subA.id;
    scB = subB.id;

    async function mkUser(
      tag: string,
      role: 'USER' | 'TEAM_LEAD',
      status: 'ACTIVE' | 'INACTIVE',
      projectId: string,
      subCategoryId: string
    ) {
      const u = await prisma.user.create({
        data: {
          username: `csec-${tag}-${SUF}`,
          passwordHash: 'x',
          fullName: `csec ${tag}`,
          role,
          status,
        },
      });
      await prisma.userAssignment.create({
        data: { userId: u.id, projectId },
      });
      // Access is restricted to specific sub-categories.
      await prisma.userSubCategory.create({
        data: { userId: u.id, subCategoryId },
      });
      createdUserIds.push(u.id);
      return u.id;
    }

    inScopeUser = await mkUser('inScope', 'USER', 'ACTIVE', ptA, scA);
    outScopeUser = await mkUser('outScope', 'USER', 'ACTIVE', ptB, scB);
    inactiveUser = await mkUser('inactive', 'USER', 'INACTIVE', ptA, scA);
    teamLeadA = await mkUser('tlA', 'TEAM_LEAD', 'ACTIVE', ptA, scA);
    teamLeadB = await mkUser('tlB', 'TEAM_LEAD', 'ACTIVE', ptB, scB);
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
  });

  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await prisma.userSubCategory.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.userAssignment.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.subCategory.deleteMany({ where: { id: { in: [scA, scB] } } });
    await prisma.category.deleteMany({ where: { projectId: { in: [ptA, ptB] } } });
    await prisma.project.deleteMany({ where: { id: { in: [ptA, ptB] } } });
    await disconnectTestPrisma();
  });

  async function defaultStatus(subCategoryId: string) {
    return statusService.create(
      { subCategoryId, name: 'Pending', isDefault: true },
      adminId
    );
  }

  // ---- create() scope enforcement -------------------------------------------

  it('create rejects a SubCategory outside the caller TEAM_LEAD scope', async () => {
    await defaultStatus(scA);
    await expect(
      service.create(
        { subCategoryId: scA, claimId: 'C-OOS' },
        teamLeadB,
        { subCategoryIds: [scB] }
      )
    ).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
  });

  it('create allows a SubCategory inside the caller scope', async () => {
    await defaultStatus(scA);
    const c = await service.create(
      { subCategoryId: scA, claimId: 'C-INS' },
      teamLeadA,
      { subCategoryIds: [scA] }
    );
    expect(c.claimId).toBe('C-INS');
  });

  it('create allows ADMIN (scope=ALL) on any SubCategory', async () => {
    await defaultStatus(scB);
    const c = await service.create(
      { subCategoryId: scB, claimId: 'C-ADM' },
      adminId,
      'ALL'
    );
    expect(c.claimId).toBe('C-ADM');
  });

  // ---- create() assignee validation -----------------------------------------

  it('create accepts an active, in-scope, non-admin assignee', async () => {
    await defaultStatus(scA);
    const c = await service.create(
      { subCategoryId: scA, claimId: 'C-A1', assignedToUserId: inScopeUser },
      adminId,
      'ALL'
    );
    expect(c.assignedToUserId).toBe(inScopeUser);
  });

  it('create rejects an assignee from a different scope', async () => {
    await defaultStatus(scA);
    await expect(
      service.create(
        { subCategoryId: scA, claimId: 'C-A2', assignedToUserId: outScopeUser },
        adminId,
        'ALL'
      )
    ).rejects.toMatchObject({ code: 'INVALID_ASSIGNEE' });
  });

  it('create rejects an inactive assignee', async () => {
    await defaultStatus(scA);
    await expect(
      service.create(
        { subCategoryId: scA, claimId: 'C-A3', assignedToUserId: inactiveUser },
        adminId,
        'ALL'
      )
    ).rejects.toMatchObject({ code: 'INVALID_ASSIGNEE' });
  });

  it('create rejects an admin assignee', async () => {
    await defaultStatus(scA);
    await expect(
      service.create(
        { subCategoryId: scA, claimId: 'C-A4', assignedToUserId: adminId },
        adminId,
        'ALL'
      )
    ).rejects.toMatchObject({ code: 'INVALID_ASSIGNEE' });
  });

  it('create rejects a non-existent assignee', async () => {
    await defaultStatus(scA);
    await expect(
      service.create(
        {
          subCategoryId: scA,
          claimId: 'C-A5',
          assignedToUserId: '00000000-0000-0000-0000-000000000000',
        },
        adminId,
        'ALL'
      )
    ).rejects.toMatchObject({ code: 'INVALID_ASSIGNEE' });
  });

  // ---- create() folderPath validation ---------------------------------------

  it('create rejects a C:\\ folderPath', async () => {
    await defaultStatus(scA);
    await expect(
      service.create(
        { subCategoryId: scA, claimId: 'C-FP1', folderPath: 'C:\\secret' },
        adminId,
        'ALL'
      )
    ).rejects.toMatchObject({ code: 'INVALID_FOLDER_PATH' });
  });

  it('create accepts a valid drive-letter folderPath', async () => {
    await defaultStatus(scA);
    const c = await service.create(
      { subCategoryId: scA, claimId: 'C-FP2', folderPath: 'D:\\Claims\\X' },
      adminId,
      'ALL'
    );
    expect(c.folderPath).toBe('D:\\Claims\\X');
  });

  it('create accepts a non-drive folderPath when trustedFolderPath is set (scanner)', async () => {
    await defaultStatus(scA);
    const c = await service.create(
      { subCategoryId: scA, claimId: 'C-TRUST', folderPath: '/tmp/scan/CLM' },
      adminId,
      'ALL',
      { trustedFolderPath: true }
    );
    expect(c.folderPath).toBe('/tmp/scan/CLM');
  });

  // ---- appendRemark() reassign validation -----------------------------------

  it('appendRemark reassign rejects an out-of-scope assignee', async () => {
    await defaultStatus(scA);
    const c = await service.create({ subCategoryId: scA, claimId: 'C-R1' }, adminId, 'ALL');
    await expect(
      service.appendRemark(
        c.id,
        { remarkText: 'reassign', newAssigneeId: outScopeUser },
        teamLeadA,
        'TEAM_LEAD'
      )
    ).rejects.toMatchObject({ code: 'INVALID_ASSIGNEE' });
  });

  it('appendRemark reassign accepts an in-scope assignee', async () => {
    await defaultStatus(scA);
    const c = await service.create({ subCategoryId: scA, claimId: 'C-R2' }, adminId, 'ALL');
    const updated = await service.appendRemark(
      c.id,
      { remarkText: 'reassign', newAssigneeId: inScopeUser },
      teamLeadA,
      'TEAM_LEAD'
    );
    expect(updated.assignedToUserId).toBe(inScopeUser);
  });

  // ---- canEditClaim matrix ---------------------------------------------------

  it('canEditClaim matrix across role × ownership × scope', async () => {
    await defaultStatus(scA);
    const c = await service.create(
      { subCategoryId: scA, claimId: 'C-EDIT', assignedToUserId: inScopeUser },
      adminId,
      'ALL'
    );
    expect(await service.canEditClaim(c.id, adminId, 'ADMIN')).toBe(true);
    expect(await service.canEditClaim(c.id, inScopeUser, 'USER')).toBe(true);
    expect(await service.canEditClaim(c.id, outScopeUser, 'USER')).toBe(false);
    expect(await service.canEditClaim(c.id, teamLeadA, 'TEAM_LEAD')).toBe(true);
    expect(await service.canEditClaim(c.id, teamLeadB, 'TEAM_LEAD')).toBe(false);
  });

  // ---- softDelete ------------------------------------------------------------

  it('softDelete sets INACTIVE and does not cascade remarks', async () => {
    await defaultStatus(scA);
    const c = await service.create(
      { subCategoryId: scA, claimId: 'C-DEL', remarkText: 'first' },
      adminId,
      'ALL'
    );
    const deleted = await service.softDelete(c.id, adminId);
    expect(deleted.status).toBe('INACTIVE');
    const remarks = await prisma.claimRemark.findMany({ where: { claimId: c.id } });
    expect(remarks.length).toBeGreaterThan(0);
  });
});
