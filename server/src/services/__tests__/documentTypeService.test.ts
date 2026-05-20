import { PrismaClient } from '@prisma/client';
import { DocumentTypeService } from '../documentTypeService.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

describe('DocumentTypeService', () => {
  let prisma: PrismaClient;
  let service: DocumentTypeService;
  let subCategoryId: string;
  let actorId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    service = new DocumentTypeService(prisma);
    const sc = await prisma.subCategory.findFirst({ where: { status: 'ACTIVE' } });
    subCategoryId = sc!.id;
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    actorId = admin!.id;
  });

  beforeEach(async () => { await truncateClaimsTables(prisma); });
  afterAll(async () => { await disconnectTestPrisma(); });

  it('creates a GOVT doc type with code', async () => {
    const d = await service.create(
      { subCategoryId, name: 'Aadhar Card', category: 'GOVT', govtCode: 'AADHAR' },
      actorId
    );
    expect(d.category).toBe('GOVT');
    expect(d.govtCode).toBe('AADHAR');
  });

  it('rejects GOVT without code', async () => {
    await expect(
      service.create({ subCategoryId, name: 'Aadhar', category: 'GOVT' }, actorId)
    ).rejects.toMatchObject({ code: 'GOVT_CODE_REQUIRED' });
  });

  it('rejects CUSTOM with code', async () => {
    await expect(
      service.create(
        { subCategoryId, name: 'X', category: 'CUSTOM', govtCode: 'PAN' },
        actorId
      )
    ).rejects.toMatchObject({ code: 'GOVT_CODE_NOT_ALLOWED' });
  });

  it('rejects duplicate GOVT code within same SubCategory', async () => {
    await service.create(
      { subCategoryId, name: 'PAN', category: 'GOVT', govtCode: 'PAN' },
      actorId
    );
    await expect(
      service.create(
        { subCategoryId, name: 'PAN-2', category: 'GOVT', govtCode: 'PAN' },
        actorId
      )
    ).rejects.toMatchObject({ code: 'DUPLICATE_GOVT_CODE' });
  });
});
