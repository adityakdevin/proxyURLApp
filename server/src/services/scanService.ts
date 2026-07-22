import { PrismaClient, Prisma, ScanJob } from '@prisma/client';
import path from 'path';
import { ClaimService, ClaimServiceError } from './claimService.js';
import { DocumentService } from './documentService.js';
import { DirectoryReader, resolveScanRoot } from '../lib/directoryReader.js';

export class ScanServiceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const MAX_ERRORS = 100;
const FLUSH_EVERY = 50;
// Max levels below the scan root a FOLDER scan descends. ponytail: constant, not a
// per-rule setting — lift to the ClaimIdRule if callers ever need different depths.
const MAX_SCAN_DEPTH = 5;

export class ScanService {
  /**
   * Rules with an enqueue in flight — closes the check-then-create race for a
   * single instance (multi-instance would need a DB sentinel).
   */
  private static enqueuing = new Set<string>();

  constructor(
    private prisma: PrismaClient,
    private reader: DirectoryReader,
    private documentService?: DocumentService,
    /** Optional hook fired (fire-and-forget) after a claim's documents are ingested. */
    private onClaimIngested?: (claimId: string, actorId?: string) => void
  ) {}

  async enqueue(claimIdRuleId: string, triggeredBy: string): Promise<ScanJob> {
    if (ScanService.enqueuing.has(claimIdRuleId)) {
      throw new ScanServiceError('SCAN_IN_PROGRESS', 'A scan is already running for this rule');
    }
    ScanService.enqueuing.add(claimIdRuleId);
    try {
      return await this.enqueueInner(claimIdRuleId, triggeredBy);
    } finally {
      ScanService.enqueuing.delete(claimIdRuleId);
    }
  }

  private async enqueueInner(claimIdRuleId: string, triggeredBy: string): Promise<ScanJob> {
    const rule = await this.prisma.claimIdRule.findUnique({
      where: { id: claimIdRuleId },
      include: { subCategory: true },
    });
    if (!rule) throw new ScanServiceError('RULE_NOT_FOUND', 'Claim ID Rule not found');
    if (rule.status !== 'ACTIVE') {
      throw new ScanServiceError('RULE_INACTIVE', 'Claim ID Rule is inactive');
    }
    if (rule.subCategory.status !== 'ACTIVE') {
      throw new ScanServiceError('RULE_INACTIVE', 'SubCategory is inactive');
    }

    // Status masters are global now (no per-SubCategory scope) — match the same
    // default-status lookup ClaimService.create uses, else scan enqueue throws a
    // PrismaClientValidationError on the removed `subCategoryId` column.
    const def = await this.prisma.statusMaster.findFirst({
      where: { isDefault: true, status: 'ACTIVE' },
    });
    if (!def) {
      throw new ScanServiceError('NO_DEFAULT_STATUS', 'No active default status is configured');
    }

    const live = await this.prisma.scanJob.findFirst({
      where: { claimIdRuleId, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (live) {
      throw new ScanServiceError('SCAN_IN_PROGRESS', 'A scan is already running for this rule');
    }

    return this.prisma.scanJob.create({
      data: {
        claimIdRuleId,
        subCategoryId: rule.subCategoryId,
        status: 'QUEUED',
        scanLocation: rule.scanLocation,
        scanTarget: rule.scanTarget,
        triggeredBy,
      },
    });
  }

  async run(jobId: string): Promise<void> {
    const job = await this.prisma.scanJob.findUnique({ where: { id: jobId } });
    if (!job) return;
    const rule = await this.prisma.claimIdRule.findUnique({ where: { id: job.claimIdRuleId } });
    if (!rule) {
      await this.prisma.scanJob.update({
        where: { id: jobId },
        data: { status: 'FAILED', message: 'Rule no longer exists', finishedAt: new Date() },
      });
      return;
    }

    const claimService = new ClaimService(this.prisma);
    const errors: { entry: string; reason: string }[] = [];
    let created = 0;
    let skipped = 0;
    let errored = 0;
    let docsCreated = 0;
    let docsSkipped = 0;
    const actorId = job.triggeredBy ?? '';
    const pushError = (entry: string, reason: string) => {
      errored++;
      if (errors.length < MAX_ERRORS) errors.push({ entry, reason });
    };
    // Records a detail WITHOUT incrementing the entry error count (keeps
    // created + skipped + errored == totalEntries). Used for doc-level failures.
    const pushErrorDetail = (entry: string, reason: string) => {
      if (errors.length < MAX_ERRORS) errors.push({ entry, reason });
    };

    try {
      await this.prisma.scanJob.update({
        where: { id: jobId },
        data: { status: 'RUNNING', startedAt: new Date() },
      });

      const root = resolveScanRoot(job.scanLocation);
      const entries = await this.reader.list(root, job.scanTarget, {
        startPosition: rule.startPosition,
        length: rule.length,
        maxDepth: MAX_SCAN_DEPTH,
      });
      await this.prisma.scanJob.update({
        where: { id: jobId },
        data: { totalEntries: entries.length },
      });

      const start = rule.startPosition - 1;
      for (let i = 0; i < entries.length; i++) {
        const name = entries[i].name;
        if (name.length < start + rule.length) {
          pushError(name, 'NAME_TOO_SHORT');
        } else {
          const claimId = name.substring(start, start + rule.length).trim();
          if (!claimId) {
            pushError(name, 'EMPTY_CLAIM_ID');
          } else {
            // Rebuild the stored Windows path from the entry's segments (may be nested).
            const folderPath = path.win32.join(job.scanLocation, ...entries[i].relSegments);
            let claimForDocs: { id: string; folderPath: string | null; subCategoryId: string } | null =
              null;
            try {
              const newClaim = await claimService.create(
                { subCategoryId: job.subCategoryId, claimId, folderPath },
                actorId,
                'ALL',
                { trustedFolderPath: true }
              );
              created++;
              claimForDocs = {
                id: newClaim.id,
                folderPath: newClaim.folderPath,
                subCategoryId: newClaim.subCategoryId,
              };
            } catch (e) {
              if (e instanceof ClaimServiceError && e.code === 'DUPLICATE_CLAIM_ID') {
                skipped++;
                const existing = await this.prisma.claim.findUnique({
                  where: {
                    claimId_subCategoryId: { claimId, subCategoryId: job.subCategoryId },
                  },
                  select: { id: true, folderPath: true, subCategoryId: true },
                });
                // Claim pre-created without a folderPath (e.g. from the observation-sheet
                // import) — backfill it from this scan so discovery has a path to read.
                if (existing && !existing.folderPath?.trim()) {
                  await this.prisma.claim.update({
                    where: { id: existing.id },
                    data: { folderPath },
                  });
                  existing.folderPath = folderPath;
                }
                claimForDocs = existing;
              } else {
                pushError(name, e instanceof Error ? e.message : 'CREATE_FAILED');
              }
            }
            if (claimForDocs && this.documentService) {
              try {
                const dr = await this.documentService.discoverForClaim(claimForDocs, actorId);
                docsCreated += dr.created;
                docsSkipped += dr.skipped;
                // Auto-validate whenever docs were newly discovered for this claim.
                // A doc-less re-scan creates nothing → no redundant re-validation.
                if (dr.created > 0 && this.onClaimIngested) {
                  this.onClaimIngested(claimForDocs.id, actorId || undefined);
                }
              } catch (e) {
                pushErrorDetail(
                  name,
                  e instanceof Error ? `DOC_DISCOVERY_FAILED: ${e.message}` : 'DOC_DISCOVERY_FAILED'
                );
              }
            }
          }
        }
        if ((i + 1) % FLUSH_EVERY === 0) {
          await this.prisma.scanJob.update({
            where: { id: jobId },
            data: {
              createdCount: created,
              skippedCount: skipped,
              errorCount: errored,
              docsCreated,
              docsSkipped,
              errors: errors as unknown as Prisma.InputJsonValue,
            },
          });
        }
      }

      await this.prisma.scanJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          createdCount: created,
          skippedCount: skipped,
          errorCount: errored,
          docsCreated,
          docsSkipped,
          errors: errors as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      });
    } catch (e) {
      await this.prisma.scanJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          createdCount: created,
          skippedCount: skipped,
          errorCount: errored,
          docsCreated,
          docsSkipped,
          errors: errors as unknown as Prisma.InputJsonValue,
          message: e instanceof Error ? e.message : 'Scan failed',
          finishedAt: new Date(),
        },
      });
    }
  }

  // Single-instance assumption: fails ALL non-terminal jobs on startup. A
  // multi-instance deployment would need a process/grace-window guard.
  async sweepStaleJobs(): Promise<number> {
    const res = await this.prisma.scanJob.updateMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'FAILED', message: 'Interrupted by server restart', finishedAt: new Date() },
    });
    return res.count;
  }
}
