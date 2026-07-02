import { PrismaClient, Prisma } from '@prisma/client';
import path from 'path';
import { Validator, ValidatorContext, ValidatorDoc, FindingInput } from '../validators/types.js';

/** Bound the rows written per check so a noisy OCR page can't flood the table. */
const MAX_FINDINGS_PER_RESULT = 200;
import { resolveScanRoot } from '../lib/directoryReader.js';
import { TesseractOcrPort } from '../lib/ocr.js';

const COLUMNS = [
  'metaExtractionStatus',
  'spellCheckStatus',
  'qrStatus',
  'intraClaimStatus',
  'fullScanStatus',
] as const;

export class ValidationService {
  constructor(private prisma: PrismaClient, private validators: Validator[]) {}

  async runOne(runId: string): Promise<void> {
    const run = await this.prisma.validationRun.findUnique({ where: { id: runId } });
    if (!run) return;
    const claim = await this.prisma.claim.findUnique({
      where: { id: run.claimId },
      include: { documents: true },
    });
    if (!claim) {
      await this.prisma.validationRun.update({
        where: { id: runId },
        data: { status: 'FAILED', message: 'Claim no longer exists', finishedAt: new Date() },
      });
      return;
    }

    if (claim.documents.length === 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.validationRun.update({
          where: { id: runId },
          data: { status: 'RUNNING', startedAt: new Date() },
        });
        await tx.validationResult.createMany({
          data: this.validators.map((v): Prisma.ValidationResultCreateManyInput => ({
            runId,
            claimId: claim.id,
            validatorKey: v.key,
            status: 'DOCS_NOT_AVAILABLE',
            summary: 'No documents available to validate.',
          })),
        });
        await tx.claim.update({
          where: { id: claim.id },
          data: Object.fromEntries(COLUMNS.map((c) => [c, 'DOCS_NOT_AVAILABLE'])),
        });
        await tx.validationRun.update({
          where: { id: runId },
          data: { status: 'COMPLETED', finishedAt: new Date() },
        });
      });
      return;
    }

    // One OCR worker for the whole run (META OCRs every image/PDF); closed in finally.
    const ocr = new TesseractOcrPort();
    try {
      await this.prisma.validationRun.update({
        where: { id: runId },
        data: { status: 'RUNNING', startedAt: new Date() },
      });
      // Reset all five columns to IN_PROGRESS for this run.
      await this.prisma.claim.update({
        where: { id: claim.id },
        data: Object.fromEntries(COLUMNS.map((c) => [c, 'IN_PROGRESS'])),
      });

      const documents: ValidatorDoc[] = claim.documents.map((d) => ({
        id: d.id,
        fileName: d.fileName,
        storagePath: d.storagePath,
        readablePath:
          d.source === 'SCANNED' ? resolveScanRoot(d.storagePath) : path.resolve(d.storagePath),
        mimeType: d.mimeType,
        source: d.source,
        documentTypeId: d.documentTypeId,
      }));

      const ctx: ValidatorContext = {
        claim: { id: claim.id, claimId: claim.claimId, subCategoryId: claim.subCategoryId },
        documents,
        prisma: this.prisma,
        ocr,
        shared: new Map<string, string>(),
        wordBoxes: new Map(),
      };

      // Run all validators first (failures captured as FAILED, never thrown).
      const results: {
        v: Validator;
        status: 'PASSED' | 'FAILED';
        summary: string;
        details?: unknown;
        findings?: FindingInput[];
      }[] = [];
      for (const v of this.validators) {
        try {
          const outcome = await v.run(ctx);
          results.push({ v, ...outcome });
        } catch (e) {
          results.push({
            v,
            status: 'FAILED',
            summary: e instanceof Error ? e.message : 'Validator error',
          });
        }
      }

      // Commit results + columns + COMPLETED atomically, so a crash mid-run
      // leaves no partial state (sweepStaleRuns recovers it).
      await this.prisma.$transaction(async (tx) => {
        for (const r of results) {
          const created = await tx.validationResult.create({
            data: {
              runId,
              claimId: claim.id,
              validatorKey: r.v.key,
              status: r.status,
              summary: r.summary.slice(0, 500),
              details: (r.details ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            },
            select: { id: true },
          });
          if (r.findings && r.findings.length > MAX_FINDINGS_PER_RESULT) {
            console.warn(
              `[validation] ${r.v.key} on claim ${claim.id}: capping ${r.findings.length} findings to ${MAX_FINDINGS_PER_RESULT}`
            );
          }
          if (r.findings && r.findings.length > 0) {
            await tx.validationFinding.createMany({
              data: r.findings.slice(0, MAX_FINDINGS_PER_RESULT).map((f) => ({
                resultId: created.id,
                claimId: claim.id,
                validatorKey: r.v.key,
                documentId: f.documentId ?? null,
                code: f.code,
                severity: f.severity ?? 'WARNING',
                message: f.message.slice(0, 500),
                page: f.page ?? null,
                // Prisma's InputJsonValue rejects named interfaces (no index signature); cast via unknown.
                bbox: f.bbox ? (f.bbox as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
                data: f.data ? (f.data as Prisma.InputJsonValue) : Prisma.JsonNull,
              })),
            });
          }
        }
        await tx.claim.update({
          where: { id: claim.id },
          data: Object.fromEntries(results.map((r) => [r.v.column, r.status])),
        });
        await tx.validationRun.update({
          where: { id: runId },
          data: { status: 'COMPLETED', finishedAt: new Date() },
        });
      });
    } catch (e) {
      try {
        // The COMPLETED commit never ran, so columns are still IN_PROGRESS:
        // fail the run and reset them to PENDING (re-queueable).
        await this.prisma.$transaction(async (tx) => {
          await tx.validationRun.update({
            where: { id: runId },
            data: {
              status: 'FAILED',
              message: e instanceof Error ? e.message : 'Run failed',
              finishedAt: new Date(),
            },
          });
          await tx.claim.updateMany({
            where: { id: run.claimId },
            data: Object.fromEntries(COLUMNS.map((c) => [c, 'PENDING'])),
          });
        });
      } catch {
        // The run (or its claim) was deleted mid-flight — nothing left to record.
      }
    } finally {
      await ocr.close();
    }
  }

  /**
   * Fail runs left RUNNING by a crash AND reset their claims' five columns to
   * PENDING — otherwise a crashed-mid-run claim is stranded IN_PROGRESS forever.
   */
  async sweepStaleRuns(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const stale = await tx.validationRun.findMany({
        where: { status: 'RUNNING' },
        select: { claimId: true },
      });
      const res = await tx.validationRun.updateMany({
        where: { status: 'RUNNING' },
        data: { status: 'FAILED', message: 'Interrupted by server restart', finishedAt: new Date() },
      });
      const claimIds = [...new Set(stale.map((r) => r.claimId))];
      if (claimIds.length > 0) {
        await tx.claim.updateMany({
          where: { id: { in: claimIds } },
          data: Object.fromEntries(COLUMNS.map((c) => [c, 'PENDING'])),
        });
      }
      return res.count;
    });
  }
}
