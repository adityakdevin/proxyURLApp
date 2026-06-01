import { PrismaClient } from '@prisma/client';
import { ClaimRuleService } from '../claimRuleService.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

describe('ClaimRuleService', () => {
  let prisma: PrismaClient;
  let service: ClaimRuleService;
  let subCategoryId: string;
  let adminId: string;
  let workflowStatusId: string;
  const SUF = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let utId: string;
  let ptId: string;
  let catId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    service = new ClaimRuleService(prisma);
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    adminId = admin!.id;
    const ut = await prisma.userType.create({ data: { name: `cr-ut-${SUF}` } });
    const pt = await prisma.projectType.create({ data: { name: `cr-pt-${SUF}` } });
    utId = ut.id;
    ptId = pt.id;
    const cat = await prisma.category.create({ data: { name: `cr-cat-${SUF}`, userTypeId: utId, projectTypeId: ptId } });
    catId = cat.id;
    const sc = await prisma.subCategory.create({ data: { name: `cr-sc-${SUF}`, categoryId: catId } });
    subCategoryId = sc.id;
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    await prisma.claimRule.deleteMany({ where: { subCategoryId } });
    const st = await prisma.statusMaster.create({ data: { subCategoryId, name: 'Pending', isDefault: true, createdBy: adminId, updatedBy: adminId } });
    workflowStatusId = st.id;
    await prisma.documentTypeMaster.create({ data: { subCategoryId, name: 'Aadhar Card', category: 'GOVT', govtCode: 'AADHAR', displayOrder: 1, createdBy: adminId, updatedBy: adminId } });
  });

  afterAll(async () => {
    await prisma.claimRule.deleteMany({ where: { subCategoryId } });
    await truncateClaimsTables(prisma);
    await prisma.subCategory.deleteMany({ where: { id: subCategoryId } });
    await prisma.category.deleteMany({ where: { id: catId } });
    await prisma.userType.deleteMany({ where: { id: utId } });
    await prisma.projectType.deleteMany({ where: { id: ptId } });
    await disconnectTestPrisma();
  });

  it('create rejects an operator invalid for the field', async () => {
    await expect(
      service.create({ subCategoryId, name: 'bad', field: 'QR_STATUS', operator: 'GTE', value: 'PASSED' }, adminId)
    ).rejects.toMatchObject({ code: 'INVALID_RULE' });
  });

  it('create rejects a non-integer value for a numeric field', async () => {
    await expect(
      service.create({ subCategoryId, name: 'bad', field: 'DOCUMENT_COUNT', operator: 'GTE', value: 'three' }, adminId)
    ).rejects.toMatchObject({ code: 'INVALID_RULE' });
  });

  it('create rejects a non-boolean value for ASSIGNED', async () => {
    await expect(
      service.create({ subCategoryId, name: 'bad', field: 'ASSIGNED', operator: 'EQ', value: 'yes' }, adminId)
    ).rejects.toMatchObject({ code: 'INVALID_RULE' });
  });

  it('create accepts ASSIGNED with a boolean value', async () => {
    const r = await service.create(
      { subCategoryId, name: 'is assigned', field: 'ASSIGNED', operator: 'EQ', value: 'true' },
      adminId
    );
    expect(r.value).toBe('true');
  });

  it('create rejects a non-existent SubCategory', async () => {
    await expect(
      service.create(
        { subCategoryId: '00000000-0000-0000-0000-000000000000', name: 'x', field: 'DOCUMENT_COUNT', operator: 'GTE', value: '1' },
        adminId
      )
    ).rejects.toMatchObject({ code: 'SUBCATEGORY_NOT_FOUND' });
  });

  it('evaluateForClaim gathers facts and evaluates active rules', async () => {
    await service.create({ subCategoryId, name: 'min docs', field: 'DOCUMENT_COUNT', operator: 'GTE', value: '1' }, adminId);
    await service.create({ subCategoryId, name: 'has aadhar', field: 'HAS_DOCUMENT_TYPE', operator: 'EQ', value: 'Aadhar Card' }, adminId);
    const aadharType = await prisma.documentTypeMaster.findFirst({ where: { subCategoryId, name: 'Aadhar Card' } });
    const claim = await prisma.claim.create({ data: { claimId: 'C-RULE', subCategoryId, workflowStatusId, createdBy: adminId, updatedBy: adminId } });
    await prisma.document.create({ data: { claimId: claim.id, source: 'UPLOADED', fileName: 'a.png', storagePath: `/x/${claim.id}/a.png`, documentTypeId: aadharType!.id } });

    const res = await service.evaluateForClaim(claim.id, adminId, 'ADMIN');
    expect(res).not.toBeNull();
    expect(res!.total).toBe(2);
    expect(res!.passedCount).toBe(2);
    const aadharRule = res!.rules.find((r) => r.name === 'has aadhar')!;
    expect(aadharRule.passed).toBe(true);
    expect(aadharRule.actual).toBe('present');
  });
});
