import { PrismaClient, Prisma } from '@prisma/client';
import path from 'path';
import {
  Validator,
  ValidatorContext,
  ValidatorDoc,
  FindingInput,
  CheckStatus,
} from '../validators/types.js';
import { deriveCheckStatus } from '../validators/logic.js';

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
  'redFlagStatus',
] as const;

/**
 * The status a claim moves to when validation first completes.
 *
 * Configurable because StatusMaster is admin-managed per deployment — the names here are
 * data, not code. Matched case-insensitively (MySQL collation) against an ACTIVE,
 * non-terminal status; if no such status exists the transition is skipped rather than
 * guessed at.
 */
function advanceTargetName(): string {
  // Read per call, not once at import: a module-level const is fixed before any config is
  // in place, and it makes the behaviour untestable — a test setting the variable after
  // import changes nothing, so it passes or fails for reasons unrelated to the code.
  return process.env.VALIDATION_ADVANCE_STATUS ?? 'In Progress';
}

export class ValidationService {
  constructor(private prisma: PrismaClient, private validators: Validator[]) {}

  /**
   * Move a claim out of the DEFAULT status once it has actually been checked.
   *
   * A claim sat at "New" forever, so a reviewer could not tell which claims had been
   * machine-checked and were waiting on a person. This says only that: work happened.
   *
   * Deliberately narrow. It fires ONLY when the claim is still on the default status, so it
   * can never move a claim a human has already placed, never walks it backwards, and is
   * idempotent on re-validation. It never advances to Verified or any terminal status —
   * a machine re-running a scan must not assert that a claim is acceptable, which is a
   * judgement only a person makes and an insurer's audit trail has to be able to prove.
   *
   * Writes a ClaimRemark with statusBefore/statusAfter like every other status change, so
   * the timeline shows the move and who it is attributed to. No attributable actor means no
   * transition: a status that changed with nobody's name on it is worse than one that did
   * not change.
   */
  private async advanceOffDefaultStatus(
    tx: Prisma.TransactionClient,
    claimId: string,
    currentStatusId: string,
    triggeredBy: string | null
  ): Promise<void> {
    const current = await tx.statusMaster.findUnique({
      where: { id: currentStatusId },
      select: { isDefault: true },
    });
    if (!current?.isDefault) return;

    const target = await tx.statusMaster.findFirst({
      where: { name: advanceTargetName(), status: 'ACTIVE', isTerminal: false },
      select: { id: true },
    });
    if (!target || target.id === currentStatusId) return;

    const actor =
      triggeredBy ??
      (await tx.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } }))?.id;
    if (!actor) return;

    await tx.claim.update({
      where: { id: claimId },
      data: { workflowStatusId: target.id, updatedBy: actor },
    });
    await tx.claimRemark.create({
      data: {
        claimId,
        userId: actor,
        remarkText:
          'Validation completed, so this claim moved off the default status and now shows ' +
          'as picked up. This says the checks have run — it does not say they passed.',
        statusBeforeId: currentStatusId,
        statusAfterId: target.id,
      },
    });
  }

  /**
   * Execute one queued run. Returns false when this call did NOT execute it, because another
   * worker had already claimed it.
   *
   * The return value exists so callers can tell the two apart. It used to return void, and
   * the drainer logged a completion after every call — so the worker that LOST the race
   * printed `claim <id> done in 0s` for work it never touched. In a 114-claim production run
   * that put phantom entries in the log beside the real ones:
   *
   *     [validationQueue] claim 06282dfc... done in 0s,  95 queued   <- lost the race
   *     [validationQueue] claim 06282dfc... done in 48s, 94 queued   <- actually ran it
   *
   * The guard below was working correctly the whole time; only the log was wrong. That is
   * worse than it sounds for a line whose entire purpose is telling a slow queue from a
   * wedged one — it reported work that did not happen, which is the failure this logging was
   * added to catch.
   */
  async runOne(runId: string): Promise<boolean> {
    // Claim the run before doing anything with it. The WHERE still carries
    // `status: 'QUEUED'`, so when several drain workers (or a worker and a direct caller)
    // reach for the same row, exactly one update matches and everyone else returns here.
    // Guarding inside runOne rather than in the drainer means no caller can execute a run
    // twice, whoever they are — a double execution writes the results twice and, since
    // validation now advances a claim off its default status, would move it twice too.
    const claimed = await this.prisma.validationRun.updateMany({
      where: { id: runId, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (claimed.count !== 1) return false;
    const run = await this.prisma.validationRun.findUnique({ where: { id: runId } });
    if (!run) return false;
    const claim = await this.prisma.claim.findUnique({
      where: { id: run.claimId },
      include: { documents: true },
    });
    if (!claim) {
      await this.prisma.validationRun.update({
        where: { id: runId },
        data: { status: 'FAILED', message: 'Claim no longer exists', finishedAt: new Date() },
      });
      return true;
    }

    if (claim.documents.length === 0) {
      await this.prisma.$transaction(async (tx) => {
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
      return true;
    }

    // One OCR worker for the whole run (META OCRs every image/PDF); closed in finally.
    const ocr = new TesseractOcrPort();
    try {
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
        pageTexts: new Map<string, string[]>(),
      };

      // Run all validators first (failures captured as FAILED, never thrown).
      type Ran = {
        v: Validator;
        status: CheckStatus;
        summary: string;
        details?: unknown;
        findings?: FindingInput[];
      };

      // Timed so the log can say WHICH check is slow. Before this a claim reported only its
      // total ("done in 47s") and the expensive one had to be guessed at.
      const runOneValidator = async (v: Validator): Promise<Ran> => {
        const startedAt = Date.now();
        let ran: Ran;
        try {
          const outcome = await v.run(ctx);
          // DOUBTFUL is decided here, not per validator: a check that passed but raised
          // warning-level findings must not show the reviewer a green badge.
          ran = { ...outcome, v, status: deriveCheckStatus(outcome.status, outcome.findings) };
        } catch (e) {
          ran = {
            v,
            status: 'FAILED',
            summary: e instanceof Error ? e.message : 'Validator error',
          };
        }
        // The claim ID is operator-supplied and only length-checked, so a newline in it
        // would forge log lines in the one place that reports how long a check took.
        console.log(
          `[validation] claim ${claim.claimId.replace(/[\p{C}]/gu, '?')} ${v.key} ${Date.now() - startedAt}ms`
        );
        await persist(ran);
        return ran;
      };

      /**
       * Write ONE check's result the moment it finishes, rather than holding all five to the
       * end. GET /claims/:id/validation serves the latest run whatever its status, so the
       * reviewer's page fills in as each check lands instead of showing nothing at all for
       * the length of the slowest one — which on a scanned bundle is the QR rasterisation,
       * and is why the screen looked frozen.
       *
       * The result row, its findings and that check's column move together, so a column can
       * never read PASSED with no result behind it. What is deliberately GIVEN UP is
       * all-five atomicity: an interrupted run now leaves some results written. That is
       * recoverable and visible — the catch below and sweepStaleRuns both reset every column
       * to PENDING and mark the run FAILED, so the partial rows sit under a run the page
       * shows as failed, and re-queueing writes a fresh runId.
       */
      // Writes are SERIALISED even though the checks are not. Every persist inserts a
      // validation_results row — which takes a shared lock on the claim row through its
      // foreign key — and then updates that same claim row, which needs an exclusive one.
      // Four of those in flight together each hold a shared lock and wait for the others to
      // release theirs: MySQL returns "Transaction failed due to a write conflict or a
      // deadlock" and the whole run fails. Chaining them costs nothing worth measuring (the
      // expensive part is the checks, which still overlap) and removes the lock upgrade.
      let writeChain: Promise<void> = Promise.resolve();
      const persist = (r: Ran): Promise<void> => {
        writeChain = writeChain.then(() => writeResult(r));
        return writeChain;
      };
      const writeResult = async (r: Ran): Promise<void> => {
        await this.prisma.$transaction(async (tx) => {
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
          await tx.claim.update({
            where: { id: claim.id },
            data: { [r.v.column]: r.status },
          });
        });
      };

      // META first, ALONE: it performs the OCR and PDF text extraction, and fills
      // ctx.shared / ctx.wordBoxes / ctx.pageTexts that every other check reads. Nothing
      // else can start before it finishes.
      //
      // The rest then run TOGETHER. They depend on META's output, not on one another, and
      // running them end to end meant INTRA and FULL — which do no I/O of their own, just a
      // string search and a doc-type query — sat behind the QR page rasterisation for the
      // whole of it. Only QR rasterises, so overlapping them costs no extra memory, which
      // matters on an 8 GB box.
      // REDFLAG is deliberately NOT in the parallel group. It reads each PDF's metadata
      // through readPdfInfo, which pulls the whole file into a Uint8Array and opens its own
      // pdfjs document — so running it beside QR puts two PDF loaders in memory at once, on
      // top of QR's scale-8 canvases. With two claim workers on an 8 GB box that is the
      // margin this change was supposed to respect. It runs after, alone.
      const PARALLEL_SAFE = (v: Validator) => v.key !== 'META' && v.key !== 'REDFLAG';
      const meta = this.validators.filter((v) => v.key === 'META');
      const parallel = this.validators.filter(PARALLEL_SAFE);
      const tail = this.validators.filter((v) => v.key === 'REDFLAG');
      const results: Ran[] = [];
      for (const v of meta) results.push(await runOneValidator(v));
      results.push(...(await Promise.all(parallel.map(runOneValidator))));
      for (const v of tail) results.push(await runOneValidator(v));

      // Results and columns are already written, each as its check finished. What is left is
      // the once-per-run part, and it stays atomic: the claim must not be advanced off its
      // default status by a run that is not recorded as COMPLETED, or vice versa.
      await this.prisma.$transaction(async (tx) => {
        await this.advanceOffDefaultStatus(
          tx,
          claim.id,
          claim.workflowStatusId,
          run.triggeredBy ?? null
        );
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
    // Reached whether the run completed or was caught and marked FAILED above: either way
    // THIS call did the work, which is the only question the return value answers.
    return true;
  }

  /**
   * Fail runs left RUNNING by a crash AND reset their claims' five columns to
   * PENDING — otherwise a crashed-mid-run claim is stranded IN_PROGRESS forever.
   *
   * Returns the affected claim ids so the caller can queue fresh runs for them. Resetting a
   * claim's five columns THROWS AWAY its previous results, so a sweep that schedules nothing
   * leaves the claim worse off than not sweeping at all: findings gone, every check back to
   * PENDING, and no work pending to regenerate them. Observed on a live box — a claim that
   * was mid-validation during a `pm2 restart` came back with empty check tabs and stayed
   * that way until someone re-validated it by hand.
   *
   * The caller re-queues rather than this method, because `enqueue` lives in
   * validationQueue, which imports this service — calling it from here would be a cycle.
   */
  async sweepStaleRuns(): Promise<{ count: number; claimIds: string[] }> {
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
      return { count: res.count, claimIds };
    });
  }
}
