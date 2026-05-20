import { PrismaClient } from '@prisma/client';

let prisma: PrismaClient | null = null;

export function getTestPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient();
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
  await client.claimRemark.deleteMany({});
  await client.claim.deleteMany({});
  await client.claimIdRule.deleteMany({});
  await client.documentTypeMaster.deleteMany({});
  await client.statusMaster.deleteMany({});
}
