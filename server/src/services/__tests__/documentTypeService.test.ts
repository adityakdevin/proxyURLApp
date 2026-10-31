import { Prisma, PrismaClient } from '@prisma/client';
import { DocumentTypeService } from '../documentTypeService.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

describe('DocumentTypeService', () => {
  let prisma: PrismaClient;
  let service: DocumentTypeService;
  let actorId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    service = new DocumentTypeService(prisma);
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    actorId = admin!.id;
  });

  beforeEach(async () => { await truncateClaimsTables(prisma); });
  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await disconnectTestPrisma();
  });

  it('creates a GOVT doc type with code', async () => {
    const d = await service.create(
      { name: 'Aadhar Card', category: 'GOVT', govtCode: 'AADHAR' },
      actorId
    );
    expect(d.category).toBe('GOVT');
    expect(d.govtCode).toBe('AADHAR');
  });

  it('rejects GOVT without code', async () => {
    await expect(
      service.create({ name: 'Aadhar', category: 'GOVT' }, actorId)
    ).rejects.toMatchObject({ code: 'GOVT_CODE_REQUIRED' });
  });

  it('rejects CUSTOM with code', async () => {
    await expect(
      service.create(
        { name: 'X', category: 'CUSTOM', govtCode: 'PAN' },
        actorId
      )
    ).rejects.toMatchObject({ code: 'GOVT_CODE_NOT_ALLOWED' });
  });

  // The regression this guards: isRequired defaulted to true, so every type ever
  // added silently became mandatory for EVERY claim and Full Scan failed claims
  // carrying exactly the documents they should. A type is required only when asked for.
  it('does not make a new type required unless asked', async () => {
    const implicit = await service.create({ name: 'Optional Form', category: 'CUSTOM' }, actorId);
    expect(implicit.isRequired).toBe(false);

    const explicit = await service.create(
      { name: 'Mandatory Form', category: 'CUSTOM', isRequired: true },
      actorId
    );
    expect(explicit.isRequired).toBe(true);

    // Only the explicitly-ticked type gates FULL completeness.
    const gating = await prisma.documentTypeMaster.findMany({
      where: { status: 'ACTIVE', isRequired: true },
      select: { name: true },
    });
    expect(gating).toEqual([{ name: 'Mandatory Form' }]);
  });

  it('rejects duplicate GOVT code within same SubCategory', async () => {
    await service.create(
      { name: 'PAN', category: 'GOVT', govtCode: 'PAN' },
      actorId
    );
    await expect(
      service.create(
        { name: 'PAN-2', category: 'GOVT', govtCode: 'PAN' },
        actorId
      )
    ).rejects.toMatchObject({ code: 'DUPLICATE_GOVT_CODE' });
  });
});

describe('DocumentTypeService create race', () => {
  // Shape captured from Prisma 7 + @prisma/adapter-mariadb on MySQL: the adapter's P2002
  // carries the index in driverAdapterError and the message, and no meta.target.
  const adapterP2002 = (index: string) =>
    new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the constraint: \`${index}\``, {
      code: 'P2002',
      clientVersion: Prisma.prismaVersion.client,
      meta: {
        modelName: 'DocumentTypeMaster',
        driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { index } } },
      },
    });
  const raceLoser = (err: Error) =>
    new DocumentTypeService({
      documentTypeMaster: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(err),
      },
    } as unknown as PrismaClient);

  it('maps a govt_code collision that slips past the pre-check to DUPLICATE_GOVT_CODE', async () => {
    await expect(
      raceLoser(adapterP2002('document_type_masters_govt_code_key')).create(
        { name: 'PAN 2', category: 'GOVT', govtCode: 'PAN' },
        'actor'
      )
    ).rejects.toMatchObject({ code: 'DUPLICATE_GOVT_CODE' });
  });

  it('maps a name collision to DUPLICATE_NAME', async () => {
    await expect(
      raceLoser(adapterP2002('document_type_masters_name_key')).create(
        { name: 'PAN', category: 'GOVT', govtCode: 'PAN' },
        'actor'
      )
    ).rejects.toMatchObject({ code: 'DUPLICATE_NAME' });
  });
});
