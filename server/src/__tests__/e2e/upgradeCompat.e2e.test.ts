import request from 'supertest';
import type { Express } from 'express';
import { PrismaClient } from '@prisma/client';
import { makeTestApp } from './helpers/app.js';
import { getTestPrisma, disconnectTestPrisma } from '../helpers/testDb.js';
import { seedScopeGraph, cleanupScopeGraph, type ScopeGraph } from './helpers/factories.js';
import { loginAs } from './helpers/auth.js';

// Behaviour the Express 5 / helmet 8 upgrade must not change. Written and passing on
// Express 4 first, so a failure after the bump is a regression, not a wrong test.
describe('E2E: upgrade compatibility', () => {
  let app: Express;
  let prisma: PrismaClient;
  let g: ScopeGraph;

  beforeAll(async () => {
    prisma = getTestPrisma();
    app = makeTestApp();
    g = await seedScopeGraph(prisma, 'upgcompat');
  });

  afterAll(async () => {
    await cleanupScopeGraph(prisma, g);
    await disconnectTestPrisma();
  });

  it('accepts a PUT with no JSON body (handlers destructure req.body)', async () => {
    const agent = await loginAs(app, g.admin.username);
    const res = await agent.put('/api/admin/settings');
    expect(res.status).toBe(200);
  });

  it('passes sanitized query values (express-validator toInt) through to the handler', async () => {
    const agent = await loginAs(app, g.admin.username);
    const res = await agent.get('/api/claims?page=1&limit=2');
    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 2 });
  });

  it('keeps the helmet headers on non-proxy routes', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('sends no x-frame-options on proxy routes, so the target can load in an iframe', async () => {
    const res = await request(app).get('/proxy/00000000-0000-0000-0000-000000000000/x');
    expect(res.headers['x-frame-options']).toBeUndefined();
  });
});
