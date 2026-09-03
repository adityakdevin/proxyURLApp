import type { Express } from 'express';
import { PrismaClient } from '@prisma/client';
import { OBSERVATION_EXPORT_HEADERS, OBSERVATION_HEADERS } from '../../services/observationSheet.js';
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
import { buildObservationBuffer, readWorkbook } from './helpers/xlsx.js';

describe('E2E: Forged-Docs observation import/export', () => {
  let app: Express;
  let prisma: PrismaClient;
  let g: ScopeGraph;

  beforeAll(async () => {
    prisma = getTestPrisma();
    app = makeTestApp();
    g = await seedScopeGraph(prisma, 'obs');
  });

  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await cleanupScopeGraph(prisma, g);
    await disconnectTestPrisma();
  });

  // Importing creates claims, which need the sub-category's default status.
  beforeEach(async () => {
    await truncateClaimsTables(prisma);
    await seedStatuses(prisma, g.subCategoryId, g.admin.id);
  });

  function row(claimId: string, dealerName: string, remarks = ''): unknown[] {
    return [
      1,
      claimId,
      dealerName,
      'UP308',
      new Date('2025-08-30'),
      'VIN-' + claimId,
      'SUDARSHAN CHAUHAN',
      'Corporate',
      '', // Status (blank on upload)
      remarks,
    ];
  }

  it('imports the observation sheet (create), then re-imports the same claim (update)', async () => {
    const admin = await loginAs(app, g.admin.username);

    const created = await admin
      .post('/api/admin/claims/import-observations')
      .field('subCategoryId', g.subCategoryId)
      .attach('file', await buildObservationBuffer([row('OBS-1', 'Dealer Alpha')]), 'obs.xlsx');
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ parsed: 1, created: 1, updated: 0, failed: 0 });

    const persisted = await prisma.claim.findFirst({
      where: { claimId: 'OBS-1', subCategoryId: g.subCategoryId },
    });
    expect(persisted?.dealerName).toBe('Dealer Alpha');
    expect(persisted?.vinNo).toBe('VIN-OBS-1');

    // Same claimId again with a changed dealer -> update, not create.
    const updated = await admin
      .post('/api/admin/claims/import-observations')
      .field('subCategoryId', g.subCategoryId)
      .attach('file', await buildObservationBuffer([row('OBS-1', 'Dealer Beta')]), 'obs.xlsx');
    expect(updated.body.data).toMatchObject({ created: 0, updated: 1, failed: 0 });

    const after = await prisma.claim.findFirst({
      where: { claimId: 'OBS-1', subCategoryId: g.subCategoryId },
    });
    expect(after?.dealerName).toBe('Dealer Beta');
  });

  it('reports a row that is missing a Claim ID as failed', async () => {
    const admin = await loginAs(app, g.admin.username);
    const res = await admin
      .post('/api/admin/claims/import-observations')
      .field('subCategoryId', g.subCategoryId)
      .attach(
        'file',
        await buildObservationBuffer([
          row('OBS-OK', 'Dealer Alpha'),
          [2, '', 'Dealer Orphan', '', new Date('2025-01-01'), '', '', '', '', 'no id'],
        ]),
        'obs.xlsx'
      );
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.failed).toBeGreaterThanOrEqual(1);
  });

  it('exports the observation sheet with the canonical header and the claim row', async () => {
    const admin = await loginAs(app, g.admin.username);
    await admin
      .post('/api/admin/claims/import-observations')
      .field('subCategoryId', g.subCategoryId)
      .attach('file', await buildObservationBuffer([row('OBS-EXP', 'Dealer Export')]), 'obs.xlsx');

    const res = await admin
      .get('/api/admin/claims/export-observations')
      .query({ subCategoryId: g.subCategoryId })
      .responseType('blob');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');

    const grid = await readWorkbook(res.body as Buffer);
    // The 10 upload columns keep their positions — an exported file has to be re-uploadable,
    // and the importer reads S. No..Remarks by position — with the failure summary and the
    // five check outcomes appended after them.
    expect(grid[0].slice(0, OBSERVATION_HEADERS.length)).toEqual([...OBSERVATION_HEADERS]);
    expect(grid[0]).toEqual([...OBSERVATION_EXPORT_HEADERS]);
    const flat = grid.flat();
    expect(flat).toContain('OBS-EXP');
  });
});
