import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

/**
 * Seed (idempotently) a dedicated admin for the Playwright UI E2E suite.
 *
 * The normal `db:seed` admin is created with `forcePasswordChange: true`, which
 * makes ProtectedRoute bounce every login to /change-password — so it can never
 * reach a claim screen. This admin has `forcePasswordChange: false` and fixed
 * credentials the UI global-setup logs in with.
 *
 * Targets E2E_DATABASE_URL / TEST_DATABASE_URL (NEVER the dev DB — this writes a
 * user row). Run: `E2E_DATABASE_URL=... npm run db:seed:e2e`.
 */
const DB_URL =
  process.env.E2E_DATABASE_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const ADMIN_USER = process.env.E2E_ADMIN_USERNAME || 'e2e_admin';
const ADMIN_PASS = process.env.E2E_ADMIN_PASSWORD || 'E2eAdmin#2026';
const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

async function main(): Promise<void> {
  if (!DB_URL) {
    throw new Error(
      'seedE2e: set E2E_DATABASE_URL (or TEST_DATABASE_URL) to a disposable test schema. Refusing to guess.'
    );
  }
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  try {
    const passwordHash = await bcrypt.hash(ADMIN_PASS, ROUNDS);
    const admin = await prisma.user.upsert({
      where: { username: ADMIN_USER },
      update: {
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
        forcePasswordChange: false,
        failedAttempts: 0,
        lockedUntil: null,
      },
      create: {
        username: ADMIN_USER,
        passwordHash,
        fullName: 'E2E Admin',
        role: 'ADMIN',
        status: 'ACTIVE',
        forcePasswordChange: false,
      },
    });
    const dbName = DB_URL.split('/').pop();
    console.log(`[seedE2e] admin "${admin.username}" ready (forcePasswordChange=false) on ${dbName}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('[seedE2e] failed:', e);
  process.exit(1);
});
