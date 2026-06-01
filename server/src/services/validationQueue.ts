import { PrismaClient } from '@prisma/client';
import { Validator } from '../validators/types.js';
import { ValidationService } from './validationService.js';

let draining: Promise<void> | null = null;
let rearm = false;

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

/** Singleton serial drainer: process QUEUED runs one at a time. Resolves when the queue is empty. */
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
  for (;;) {
    const next = await prisma.validationRun.findFirst({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
    });
    if (!next) break;
    await svc.runOne(next.id);
  }
}
