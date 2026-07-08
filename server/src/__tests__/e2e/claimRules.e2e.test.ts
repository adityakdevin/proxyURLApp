import type { Express } from 'express';
import { PrismaClient } from '@prisma/client';
import { makeTestApp } from './helpers/app.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../helpers/testDb.js';
import {
  seedScopeGraph,
  seedStatuses,
  cleanupScopeGraph,
  type ScopeGraph,
} from './helpers/factories.js';
import { loginAs } from './helpers/auth.js';

describe('E2E: claim rules + claim-id rules', () => {
  let app: Express;
  let prisma: PrismaClient;
  let g: ScopeGraph;

  beforeAll(async () => {
    prisma = getTestPrisma();
    app = makeTestApp();
    g = await seedScopeGraph(prisma, 'rules');
  });

  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await cleanupScopeGraph(prisma, g);
    await disconnectTestPrisma();
  });

  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    await seedStatuses(prisma, g.subCategoryId, g.admin.id);
  });

  it('creates a claim rule and evaluates it against a zero-document claim', async () => {
    const admin = await loginAs(app, g.admin.username);

    const created = await admin
      .post('/api/claims')
      .send({ subCategoryId: g.subCategoryId, claimId: 'C-RULES' });
    const claimId = created.body.data.id as string;

    const rule = await admin.post('/api/admin/claim-rules').send({
      name: 'At least one document',
      field: 'DOCUMENT_COUNT',
      operator: 'GTE',
      value: '1',
    });
    expect(rule.status).toBe(201);

    const evalRes = await admin.get(`/api/claims/${claimId}/rules`);
    expect(evalRes.status).toBe(200);
    expect(evalRes.body.data.total).toBe(1);
    expect(evalRes.body.data.passedCount).toBe(0);
    expect(evalRes.body.data.rules[0]).toMatchObject({
      field: 'DOCUMENT_COUNT',
      operator: 'GTE',
      passed: false,
    });
  });

  it('creates a claim-id extraction rule and rejects a duplicate (one per sub-category)', async () => {
    const admin = await loginAs(app, g.admin.username);

    // scanLocation must be an absolute, non-C drive-letter path (Windows form).
    const create = await admin.post('/api/admin/claim-id-rules').send({
      subCategoryId: g.subCategoryId,
      startPosition: 1,
      length: 5,
      scanTarget: 'FOLDER',
      scanLocation: 'D:\\Scans',
    });
    expect(create.status).toBe(201);

    const dup = await admin.post('/api/admin/claim-id-rules').send({
      subCategoryId: g.subCategoryId,
      startPosition: 2,
      length: 4,
      scanTarget: 'FILE',
      scanLocation: 'D:\\Other',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('RULE_EXISTS');
  });
});
