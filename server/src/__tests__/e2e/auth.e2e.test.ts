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
import { loginAs, type Agent } from './helpers/auth.js';
import { SESSION_MAX_PER_USER } from '../../services/sessionService.js';

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

  it('keeps earlier sessions alive when the same account logs in again', async () => {
    // The single-session rule this replaces deleted every other session on each login, so a
    // second device silently signed the first one out and two people sharing an account
    // experienced it as being logged out at random.
    const first = await loginAs(app, g.teamLead.username);
    const second = await loginAs(app, g.teamLead.username);
    expect((await first.get('/api/auth/me')).status).toBe(200);
    expect((await second.get('/api/auth/me')).status).toBe(200);
    expect(await prisma.session.count({ where: { userId: g.teamLead.id } })).toBe(2);
  });

  it('evicts the least recently active session past the per-account cap', async () => {
    const agents: Agent[] = [];
    for (let i = 0; i < SESSION_MAX_PER_USER; i++) {
      agents.push(await loginAs(app, g.user.username));
      // Keep lastActivity strictly ordered so "least recently active" is unambiguous.
      await agents[i].get('/api/auth/me');
    }
    expect(await prisma.session.count({ where: { userId: g.user.id } })).toBe(SESSION_MAX_PER_USER);

    // Touch every session but the first, so the first is the stalest.
    for (const a of agents.slice(1)) await a.get('/api/auth/me');
    const extra = await loginAs(app, g.user.username);

    expect(await prisma.session.count({ where: { userId: g.user.id } })).toBe(SESSION_MAX_PER_USER);
    expect((await agents[0].get('/api/auth/me')).status).toBe(401);
    expect((await extra.get('/api/auth/me')).status).toBe(200);
    expect((await agents[agents.length - 1].get('/api/auth/me')).status).toBe(200);
  });

  it('holds the cap when several logins land at once', async () => {
    // Checking for room and then creating is two statements with a gap: concurrent logins
    // both saw room and both created, leaving the account over the cap. Trimming after the
    // create closes that gap whichever way the racers interleave.
    // allSettled, not all: the login route applies a progressive delay, so some of a rapid
    // burst may be throttled. Whether every request got through is not the invariant under
    // test — the invariant is that however many DID, the account never ends up over the cap.
    await Promise.allSettled(
      Array.from({ length: SESSION_MAX_PER_USER + 3 }, () => loginAs(app, g.otherTeamLead.username))
    );
    expect(await prisma.session.count({ where: { userId: g.otherTeamLead.id } })).toBeGreaterThan(0);
    expect(await prisma.session.count({ where: { userId: g.otherTeamLead.id } })).toBeLessThanOrEqual(
      SESSION_MAX_PER_USER
    );
  });

  it('logout invalidates the session', async () => {
    const agent = await loginAs(app, g.teamLead.username);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    const out = await agent.post('/api/auth/logout');
    expect(out.status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
});
