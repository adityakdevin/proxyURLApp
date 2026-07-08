import { PrismaClient } from '@prisma/client';
import { ClaimService } from '../claimService.js';
import { StatusMasterService } from '../statusMasterService.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

describe('ClaimService.exportRows', () => {
  let prisma: PrismaClient;
  let service: ClaimService;
  let statusService: StatusMasterService;
  let adminId: string;
  const SUF = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let ptA: string;
  let scA: string;
  let ptB: string;
  let scB: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    service = new ClaimService(prisma);
    statusService = new StatusMasterService(prisma);
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    adminId = admin!.id;
    const [pa, pb] = await Promise.all([
      prisma.project.create({ data: { name: `ex-ptA-${SUF}` } }),
      prisma.project.create({ data: { name: `ex-ptB-${SUF}` } }),
    ]);
    ptA = pa.id;
    ptB = pb.id;
    const catA = await prisma.category.create({ data: { name: `ex-catA-${SUF}`, projectId: ptA } });
    const catB = await prisma.category.create({ data: { name: `ex-catB-${SUF}`, projectId: ptB } });
    scA = (await prisma.subCategory.create({ data: { name: `ex-scA-${SUF}`, categoryId: catA.id } })).id;
    scB = (await prisma.subCategory.create({ data: { name: `ex-scB-${SUF}`, categoryId: catB.id } })).id;
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    // Status masters are global now — one shared default serves claims in both subcategories.
    const def = await statusService.create({ name: 'Pending', isDefault: true }, adminId);
    await prisma.claim.create({ data: { claimId: 'EX-A1', subCategoryId: scA, workflowStatusId: def.id, createdBy: adminId, updatedBy: adminId } });
    await prisma.claim.create({ data: { claimId: 'EX-B1', subCategoryId: scB, workflowStatusId: def.id, createdBy: adminId, updatedBy: adminId } });
  });

  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await prisma.subCategory.deleteMany({ where: { id: { in: [scA, scB] } } });
    await prisma.category.deleteMany({ where: { projectId: { in: [ptA, ptB] } } });
    await prisma.project.deleteMany({ where: { id: { in: [ptA, ptB] } } });
    await disconnectTestPrisma();
  });

  it('ADMIN scope ALL exports both claims with resolved fields', async () => {
    const rows = await service.exportRows({ scope: 'ALL' });
    const ours = rows.filter((r) => r.claimId === 'EX-A1' || r.claimId === 'EX-B1');
    expect(ours.length).toBe(2);
    const a = ours.find((r) => r.claimId === 'EX-A1')!;
    expect(a.workflowStatus).toBe('Pending');
    expect(a.assignedTo).toBe('Unassigned');
    expect(a.documents).toBe(0);
    // Export shows binary status: a default PENDING check reads as PASSED (only FAILED → FAILED).
    expect(a.spell).toBe('PASSED');
    expect(typeof a.created).toBe('string');
  });

  it('TEAM_LEAD scope returns only in-scope claims', async () => {
    const rows = await service.exportRows({ scope: { subCategoryIds: [scA] } });
    const ids = rows.map((r) => r.claimId);
    expect(ids).toContain('EX-A1');
    expect(ids).not.toContain('EX-B1');
  });

  it('applies the search filter', async () => {
    const rows = await service.exportRows({ scope: 'ALL', search: 'EX-A' });
    expect(rows.some((r) => r.claimId === 'EX-A1')).toBe(true);
    expect(rows.some((r) => r.claimId === 'EX-B1')).toBe(false);
  });
});
