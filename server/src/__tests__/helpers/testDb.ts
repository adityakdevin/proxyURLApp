import { PrismaClient } from '@prisma/client';
import { createPrisma } from '../../lib/prisma.js';
import { idle } from '../../services/validationQueue.js';

let prisma: PrismaClient | null = null;

export function getTestPrisma(): PrismaClient {
  if (!prisma) {
    // Allow pointing tests at a dedicated database (recommended) without
    // changing default behaviour: set TEST_DATABASE_URL to isolate test data
    // from the dev DB referenced by DATABASE_URL.
    prisma = createPrisma(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
  }
  return prisma;
}

export async function disconnectTestPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

export async function truncateClaimsTables(client: PrismaClient): Promise<void> {
  // DELETE in dependency order (children first) — safer than TRUNCATE+FK toggle, which
  // doesn't persist across Prisma's pooled connections.
  // A validate call earlier in the file leaves the drainer writing runs; deleting their claims
  // under it deadlocked claim.deleteMany in CI.
  await idle();
  await client.claimRemark.deleteMany({});
  // Cleared here rather than left to cleanupScopeGraph: the row references a user with no
  // cascade (an audit trail must outlive the actor), so a leftover row blocks the user
  // delete at the end of the suite.
  await client.claimAuditLog.deleteMany({});
  await client.claim.deleteMany({});
  await client.claimIdRule.deleteMany({});
  // Global masters — cleared so each test starts from a known-empty set.
  await client.claimRule.deleteMany({});
  await client.documentTypeMaster.deleteMany({});
  await client.statusMaster.deleteMany({});
}
