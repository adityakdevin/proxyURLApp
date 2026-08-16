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

/**
 * Block until the runs just queued for these claims have actually finished.
 *
 * `await kickDrain(...)` is NOT enough and reads as if it were. kickDrain returns the
 * promise for the drain already IN FLIGHT when a drain is running (validationQueue.ts:35-38),
 * and `enqueue` kicks one itself (line 28) — so the first claim in the loop starts a drain,
 * and the await at the end resolves as soon as THAT pass ends, with the re-armed pass still
 * working through the rest. The script then printed whatever statuses happened to be stored
 * at that moment: the pre-run values, for most of the batch.
 *
 * That is worse than slow. It reported 20 claims as PASSED while the runs behind them were
 * still going, and the real results — misspellings correctly caught — landed minutes later.
 * A verification tool that reports the state it was asked to change is actively misleading.
 *
 * Polls the rows rather than the queue's internals, so it is correct no matter who else is
 * draining (the API server shares this database).
 */
async function waitForRuns(prisma: PrismaClient, claimIds: string[], timeoutMs = 30 * 60_000) {
  const startedAt = Date.now();
  let lastReported = -1;
  for (;;) {
    const pending = await prisma.validationRun.count({
      where: { claimId: { in: claimIds }, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (pending === 0) return;
    if (Date.now() - startedAt > timeoutMs) {
      console.warn(
        `\nStill ${pending} run(s) in flight after ${Math.round(timeoutMs / 60_000)} minutes. ` +
          'Reporting anyway — the statuses below may be stale for those claims.'
      );
      return;
    }
    // Progress, because a large batch on a serial drainer is otherwise a silent wait.
    if (pending !== lastReported) {
      process.stdout.write(`\r  waiting on ${pending} run(s)…          `);
      lastReported = pending;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

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
  await waitForRuns(
    prisma,
    claims.map((c) => c.id)
  );

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
