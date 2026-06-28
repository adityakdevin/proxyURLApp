import request from 'supertest';
import type { Express } from 'express';
import { PrismaClient } from '@prisma/client';
import { makeTestApp } from './helpers/app.js';
import {
  getTestPrisma,
  disconnectTestPrisma,
  truncateClaimsTables,
} from '../helpers/testDb.js';
import { seedScopeGraph, cleanupScopeGraph, type ScopeGraph } from './helpers/factories.js';
import { loginAs } from './helpers/auth.js';

describe('E2E: auth + session', () => {
  let app: Express;
  let prisma: PrismaClient;
  let g: ScopeGraph;

  beforeAll(async () => {
    prisma = getTestPrisma();
    app = makeTestApp();
    g = await seedScopeGraph(prisma, 'auth');
  });

  afterAll(async () => {
    await truncateClaimsTables(prisma);
    await cleanupScopeGraph(prisma, g);
    await disconnectTestPrisma();
  });

  it('logs in with valid credentials, sets a session cookie, and resolves /me', async () => {
    const agent = await loginAs(app, g.admin.username);
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ username: g.admin.username, role: 'ADMIN' });
  });

  it('throttles a wrong password for an existing user (429 RATE_LIMITED, progressive delay)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: g.user.username, password: 'definitely-wrong' });
    // A failed attempt increments failedAttempts, so retryAfter is always > 0 →
    // the route returns 429 RATE_LIMITED (never 401) for an existing user.
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.body.retryAfter).toBeGreaterThan(0);
  });

  it('rejects an unknown username with 401 LOGIN_FAILED', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: `no-such-user-${g.suffix}`, password: 'whatever' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('LOGIN_FAILED');
  });

  it('refuses a protected route without a session (401 AUTH_REQUIRED)', async () => {
    const res = await request(app).get('/api/claims');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('logout invalidates the session', async () => {
    const agent = await loginAs(app, g.teamLead.username);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    const out = await agent.post('/api/auth/logout');
    expect(out.status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
});
