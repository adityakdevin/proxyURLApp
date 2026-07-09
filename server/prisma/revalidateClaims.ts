/**
 * Re-run validation for existing claims — use after changing validator logic so
 * stored ValidationResults (and the claim's status columns) reflect the new code.
 *
 * By default it re-validates every claim that has at least one document. Pass VIN/
 * claimId args to limit it to those claims.
 *
 * Documents are read from disk during META/SPELL, so point CLAIMS_SCAN_ROOT at the
 * samples dir just like the setup scripts:
 *   CLAIMS_SCAN_ROOT="$(cd .. && pwd)/docs/samples" npm run db:revalidate
 *   CLAIMS_SCAN_ROOT=... npx tsx prisma/revalidateClaims.ts MZBFB812 CLM10001
 *
 * Idempotent: each run appends a fresh ValidationRun and overwrites the columns.
 */
import { PrismaClient } from '@prisma/client';
import { enqueue, kickDrain } from '../src/services/validationQueue.js';
import { registry } from '../src/validators/registry.js';

const prisma = new PrismaClient();

async function main() {
  if (!process.env.CLAIMS_SCAN_ROOT) {
    throw new Error(
      'CLAIMS_SCAN_ROOT is not set — point it at the repo docs/samples dir so document ' +
        'text can be read, e.g.\n  CLAIMS_SCAN_ROOT="$(cd .. && pwd)/docs/samples" npm run db:revalidate'
    );
  }

  const only = process.argv.slice(2); // optional claimId filter
  const claims = await prisma.claim.findMany({
    where: {
      documents: { some: {} }, // only claims that actually have documents to check
      ...(only.length ? { claimId: { in: only } } : {}),
    },
    select: { id: true, claimId: true },
  });
  if (claims.length === 0) {
    console.log('No matching claims with documents found.');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } });

  console.log(`Re-validating ${claims.length} claim(s): ${claims.map((c) => c.claimId).join(', ')}`);
  for (const c of claims) await enqueue(prisma, registry, c.id, 'MANUAL', admin?.id);
  await kickDrain(prisma, registry);

  console.log('\nSPELL results:');
  for (const c of claims) {
    const claim = await prisma.claim.findUnique({
      where: { id: c.id },
      select: { spellCheckStatus: true },
    });
    console.log(`  ${c.claimId}: ${claim?.spellCheckStatus}`);
  }
  console.log('\nDone.');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
