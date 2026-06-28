import type { Express } from 'express';
import { createApp } from '../../../app.js';
import { getTestPrisma } from '../../helpers/testDb.js';

/**
 * Build an Express app wired to the shared test Prisma client (TEST_DATABASE_URL).
 * No port is bound — supertest drives the returned app in-process.
 */
export function makeTestApp(): Express {
  return createApp(getTestPrisma());
}
