import { PrismaClient } from '@prisma/client';
import { Validator } from '../validators/types.js';
import { ValidationService } from './validationService.js';

let draining: Promise<void> | null = null;
let settle: (() => void) | null = null;
let rearm = false;
let active = 0;

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
  //
  // Guard the cast, do not just clamp it. Number('two') is NaN, Math.max(1, NaN) is NaN,
  // and Array.from({ length: NaN }) is an EMPTY array — so a typo'd env var spawned ZERO
  // workers, drainLoop's Promise.all resolved on nothing, and every queued run sat
  // untouched with not one line logged. The silent-total-failure case has to fall back to
  // the default, not to whatever the arithmetic happens to produce.
  const raw = Number(process.env.VALIDATION_CONCURRENCY ?? 2);
  return Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 2;
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
  triggeredBy?: string,
  /** Checks the operator ticked. Undefined or empty = all of them. */
  checks?: string[]
): Promise<{ id: string }> {
  const selected = checks && checks.length > 0 ? [...new Set(checks)].join(',') : null;
  const queued = await prisma.validationRun.findFirst({
    where: { claimId, status: 'QUEUED' },
  });
  let run = queued
    ? queued
    : await prisma.validationRun.create({
        data: { claimId, trigger, triggeredBy: triggeredBy ?? null, checks: selected },
      });
  // Coalescing onto a queued run WIDENS the selection, never narrows it: two enqueues asking
  // for different checks must both get what they asked for, and "all" wins outright.
  if (queued && queued.checks !== null) {
    const widened = selected === null ? null : [...new Set([...queued.checks.split(','), ...selected.split(',')])].join(',');
    if (widened !== queued.checks) {
      run = await prisma.validationRun.update({ where: { id: queued.id }, data: { checks: widened } });
    }
  }
  void kickDrain(prisma, validators);
  return { id: run.id };
}

/** Singleton drainer: processes QUEUED runs, up to CONCURRENCY at a time. Resolves when the
 *  queue is empty.
 *
 *  A kick mid-drain tops the pool back up to CONCURRENCY. Workers exit as soon as they find
 *  the queue empty, and a bulk validate enqueues one claim at a time: the first enqueue
 *  started five workers, four found nothing and left, and the remaining one then drained the
 *  whole batch alone — 224 claims at a fifth of the speed (client QA re-run, 2026-10-13). */
export function kickDrain(prisma: PrismaClient, validators: Validator[]): Promise<void> {
  if (!draining) {
    rearm = false;
    draining = new Promise<void>((resolve) => {
      settle = resolve;
    });
  }
  const done = draining;
  // Every worker busy: one may be past its empty-queue check and about to leave, so poll
  // again once the pool empties rather than strand this run.
  if (active >= concurrency()) rearm = true;
  const svc = new ValidationService(prisma, validators);
  while (active < concurrency()) {
    active++;
    void worker(prisma, svc)
      // Log a transient drain error so it neither wedges the queue nor escapes as unhandledRejection.
      .catch((e) => {
        console.error('[validationQueue] drain loop error:', e);
      })
      .finally(() => {
        if (--active > 0) return;
        const resolve = settle;
        draining = null;
        settle = null;
        if (rearm) {
          // Chain the waiting callers onto the follow-up drain.
          void kickDrain(prisma, validators).then(() => resolve?.());
        } else {
          resolve?.();
        }
      });
  }
  return done;
}

/** Resolves once no drain is running in this process; starts none. Test cleanup awaits it so
 *  a claim is never deleted under a worker that is still writing its run. Loops because a
 *  re-armed pass can replace `draining` while the caller waits. */
export async function idle(): Promise<void> {
  while (draining) await draining;
}

async function worker(prisma: PrismaClient, svc: ValidationService): Promise<void> {
  for (;;) {
    // No reservation here: runOne claims the row atomically and returns immediately if
    // another worker got there first, so the worst case is a wasted lookup.
    // Never a claim that is already running: a duplicate partner re-queued mid-run gets a
    // fresh QUEUED run behind it, and two workers on one claim would double its OCR memory
    // and let the older snapshot commit last (review, 2026-10-13). The worker that finishes
    // the running one picks this up on its next pass.
    const next = await prisma.validationRun.findFirst({
      where: { status: 'QUEUED', claim: { validationRuns: { none: { status: 'RUNNING' } } } },
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
      // A run left RUNNING would block every later run for its claim (the RUNNING exclusion
      // above) until a restart sweeps it.
      await prisma.validationRun
        .updateMany({
          where: { id: next.id, status: 'RUNNING' },
          data: { status: 'FAILED', message: 'Validation error', finishedAt: new Date() },
        })
        .catch((err) => console.error(`[validationQueue] could not fail run ${next.id}:`, err));
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
}
