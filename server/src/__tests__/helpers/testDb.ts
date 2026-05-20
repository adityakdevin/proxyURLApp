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
  await client.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  await client.$executeRawUnsafe('TRUNCATE TABLE claim_remarks');
  await client.$executeRawUnsafe('TRUNCATE TABLE claims');
  await client.$executeRawUnsafe('TRUNCATE TABLE claim_id_rules');
  await client.$executeRawUnsafe('TRUNCATE TABLE document_type_masters');
  await client.$executeRawUnsafe('TRUNCATE TABLE status_masters');
  await client.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
}
