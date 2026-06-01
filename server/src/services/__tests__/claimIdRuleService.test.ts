import { PrismaClient } from '@prisma/client';
import {
  ClaimIdRuleService,
  ClaimIdRuleServiceError,
  validateScanLocation,
} from '../claimIdRuleService.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../../__tests__/helpers/testDb.js';

describe('validateScanLocation', () => {
  it('accepts D:\\Claims\\Daily', () => {
    expect(() => validateScanLocation('D:\\Claims\\Daily')).not.toThrow();
  });
  it('accepts e:\\anything', () => {
    expect(() => validateScanLocation('e:\\anything')).not.toThrow();
  });
  it('rejects C:\\anything', () => {
    expect(() => validateScanLocation('C:\\anything')).toThrow(ClaimIdRuleServiceError);
  });
  it('rejects c:\\anything (lower)', () => {
    expect(() => validateScanLocation('c:\\anything')).toThrow();
  });
  it('rejects UNC \\\\server\\share', () => {
    expect(() => validateScanLocation('\\\\server\\share')).toThrow();
  });
  it('rejects unix path /tmp/x', () => {
    expect(() => validateScanLocation('/tmp/x')).toThrow();
  });
  it('rejects a path containing a .. segment', () => {
    expect(() => validateScanLocation('D:\\Claims\\..\\Secret')).toThrow(ClaimIdRuleServiceError);
  });
});

describe('ClaimIdRuleService', () => {
  let prisma: PrismaClient;
  let service: ClaimIdRuleService;
  let subCategoryId: string;
  let actorId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    service = new ClaimIdRuleService(prisma);
    const sc = await prisma.subCategory.findFirst({ where: { status: 'ACTIVE' } });
    subCategoryId = sc!.id;
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    actorId = admin!.id;
  });
  beforeEach(async () => { await truncateClaimsTables(prisma); });
  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await disconnectTestPrisma();
  });

  it('creates a rule', async () => {
    const r = await service.create(
      {
        subCategoryId,
        startPosition: 1,
        length: 8,
        scanTarget: 'FOLDER',
        scanLocation: 'D:\\Claims',
      },
      actorId
    );
    expect(r.scanTarget).toBe('FOLDER');
  });

  it('rejects second rule on same SubCategory', async () => {
    await service.create(
      {
        subCategoryId,
        startPosition: 1,
        length: 8,
        scanTarget: 'FOLDER',
        scanLocation: 'D:\\Claims',
      },
      actorId
    );
    await expect(
      service.create(
        {
          subCategoryId,
          startPosition: 5,
          length: 4,
          scanTarget: 'FILE',
          scanLocation: 'E:\\X',
        },
        actorId
      )
    ).rejects.toMatchObject({ code: 'RULE_EXISTS' });
  });

  it('rejects start+length > 200', async () => {
    await expect(
      service.create(
        {
          subCategoryId,
          startPosition: 195,
          length: 10,
          scanTarget: 'FOLDER',
          scanLocation: 'D:\\X',
        },
        actorId
      )
    ).rejects.toMatchObject({ code: 'INVALID_RANGE' });
  });

  it('rejects C-drive scanLocation', async () => {
    await expect(
      service.create(
        {
          subCategoryId,
          startPosition: 1,
          length: 8,
          scanTarget: 'FOLDER',
          scanLocation: 'C:\\X',
        },
        actorId
      )
    ).rejects.toMatchObject({ code: 'INVALID_SCAN_LOCATION' });
  });

  it('rejects create for a non-existent SubCategory', async () => {
    await expect(
      service.create(
        {
          subCategoryId: '00000000-0000-0000-0000-000000000000',
          startPosition: 1,
          length: 8,
          scanTarget: 'FOLDER',
          scanLocation: 'D:\\X',
        },
        actorId
      )
    ).rejects.toMatchObject({ code: 'SUBCATEGORY_NOT_FOUND' });
  });

  it('refuses to delete a rule that still has a live scan job', async () => {
    const rule = await service.create(
      { subCategoryId, startPosition: 1, length: 8, scanTarget: 'FOLDER', scanLocation: 'D:\\Claims' },
      actorId
    );
    await prisma.scanJob.create({
      data: {
        claimIdRuleId: rule.id,
        subCategoryId,
        status: 'RUNNING',
        scanLocation: 'D:\\Claims',
        scanTarget: 'FOLDER',
      },
    });
    await expect(service.delete(rule.id)).rejects.toMatchObject({ code: 'SCAN_IN_PROGRESS' });
    // The truncate in beforeEach cascade-deletes the scan job via the rule.
  });
});
