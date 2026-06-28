import request from 'supertest';
import type { Express } from 'express';
import { TEST_PASSWORD } from './factories.js';

/** A cookie-carrying supertest client (named indirectly to survive @types churn). */
export type Agent = ReturnType<typeof request.agent>;

/**
 * Log in through the real `/api/auth/login` endpoint and return a supertest
 * agent that carries the resulting `proxy_session` cookie on every subsequent
 * request — i.e. an authenticated client, exactly as the browser behaves.
 */
export async function loginAs(
  app: Express,
  username: string,
  password: string = TEST_PASSWORD
): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password });
  if (res.status !== 200) {
    throw new Error(
      `login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`
    );
  }
  return agent;
}

/** Poll a claim's latest validation run until it leaves the queue. */
export async function waitForValidation(
  agent: Agent,
  claimId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<{ status: string; results: unknown[] }> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const intervalMs = opts.intervalMs ?? 150;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await agent.get(`/api/claims/${claimId}/validation`);
    const run = res.body?.data?.run;
    const status = run?.status as string | undefined;
    if (status === 'COMPLETED' || status === 'FAILED') {
      return { status, results: res.body?.data?.results ?? [] };
    }
    if (Date.now() > deadline) {
      throw new Error(`validation run did not settle within ${timeoutMs}ms (last status: ${status})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
