import { PrismaClient } from '@prisma/client';
import { Validator } from '../validators/types.js';
import { ValidationService } from './validationService.js';

let draining: Promise<void> | null = null;
let rearm = false;

/**
 * How many validation runs execute at once.
 *
 * Was strictly one. A bulk re-validate of 116 claims therefore ran 116 x 5 validators of
 * OCR and PDF rasterisation end to end, which took hours — long enough that the queue was
 * repeatedly reported as stuck, and long enough that the claims list itself crawled while
 * the box was saturated.
 *
 * Default 2 rather than "number of cores" because the ceiling here is MEMORY, not CPU. The
 * QR high-resolution retry rasterises pages at scale 8: a single A4 page at that scale is
 * ~4760x6736, and several are held at once. Two of those in flight is already a lot for a
 * modest Windows box, and an OOM mid-drain is far worse than a slow drain. Raise it
 * deliberately, with the box's RAM in view.
 */
function concurrency(): number {
  // Read per call, not once at import: a module-level const is fixed before any config is
  // loaded and cannot be exercised by a test.
  return Math.max(1, Number(process.env.VALIDATION_CONCURRENCY ?? 2));
}

/**
 * Enqueue a validation run, then kick the drainer. Coalesce onto an existing
 * QUEUED run, but if the live run is already RUNNING its document snapshot is
 * frozen — create a NEW QUEUED run so a mid-run upload still gets validated.
 */
export async function enqueue(
  prisma: PrismaClient,
  validators: Validator[],
  claimId: string,
  trigger: 'AUTO' | 'MANUAL',
  triggeredBy?: string
): Promise<{ id: string }> {
  const queued = await prisma.validationRun.findFirst({
    where: { claimId, status: 'QUEUED' },
  });
  const run = queued
    ? queued
    : await prisma.validationRun.create({
        data: { claimId, trigger, triggeredBy: triggeredBy ?? null },
      });
  void kickDrain(prisma, validators);
  return { id: run.id };
}

/** Singleton drainer: processes QUEUED runs, up to CONCURRENCY at a time. Resolves when the
 *  queue is empty. */
export function kickDrain(prisma: PrismaClient, validators: Validator[]): Promise<void> {
  // Re-arm if a kick arrives mid-drain, so a run queued during it is re-polled.
  if (draining) {
    rearm = true;
    return draining;
  }
  return startDrain(prisma, validators);
}

function startDrain(prisma: PrismaClient, validators: Validator[]): Promise<void> {
  rearm = false;
  draining = drainLoop(prisma, validators)
    // Log a transient drain error so it neither wedges the queue nor escapes as unhandledRejection.
    .catch((e) => {
      console.error('[validationQueue] drain loop error:', e);
    })
    .finally(() => {
      draining = null;
      if (rearm) void startDrain(prisma, validators);
    });
  return draining;
}

async function drainLoop(prisma: PrismaClient, validators: Validator[]): Promise<void> {
  const svc = new ValidationService(prisma, validators);
  const worker = async (): Promise<void> => {
    for (;;) {
      // No reservation here: runOne claims the row atomically and returns immediately if
      // another worker got there first, so the worst case is a wasted lookup.
      const next = await prisma.validationRun.findFirst({
        where: { status: 'QUEUED' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, claimId: true },
      });
      if (!next) return;
      const startedAt = Date.now();
      let ran = false;
      try {
        ran = await svc.runOne(next.id);
      } catch (e) {
        // One bad claim must not take the worker down and strand the rest of the queue.
        // runOne already marks its own run FAILED; this is the belt for anything it missed.
        // A throw means this worker DID have the run, so it still counts as executed.
        ran = true;
        console.error(`[validationQueue] run ${next.id} threw:`, e);
      }
      // Nothing to report when another worker claimed it first. Logging that as a completion
      // is how a 114-claim production drain printed `done in 0s` lines beside the real ones
      // for the same claim id — phantom work, in the one line whose job is to tell a slow
      // queue from a wedged one. Skipping is right rather than logging a skip: with two
      // workers the losing side collides on the head of the queue constantly, and a line per
      // collision would bury the progress it sits next to.
      if (!ran) continue;
      // Progress, because a queue with no output cannot be told apart from a wedged one —
      // which cost real time diagnosing exactly that.
      const remaining = await prisma.validationRun.count({ where: { status: 'QUEUED' } });
      console.log(
        `[validationQueue] claim ${next.claimId} done in ${Math.round((Date.now() - startedAt) / 1000)}s, ` +
          `${remaining} queued`
      );
    }
  };
  await Promise.all(Array.from({ length: concurrency() }, () => worker()));
}
