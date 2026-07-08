/* One-off accuracy harness: real scan → ingest → validation over the samples. Throwaway DB. */
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { ScanService } from './src/services/scanService.js';
import { DocumentService } from './src/services/documentService.js';
import { FsDirectoryReader } from './src/services/fsDirectoryReader.js';
import { FsFileSystemPort } from './src/services/fsFileSystemPort.js';
import { enqueue, kickDrain } from './src/services/validationQueue.js';
import { registry } from './src/validators/registry.js';

const TEST_URL = 'mysql://root@127.0.0.1:3399/proxyapp_spellcheck_test';
process.env.CLAIMS_SCAN_ROOT = path.resolve(__dirname, '../docs/samples');
process.env.OCR_CACHE_DIR = path.resolve(__dirname, '../.ocr-cache');
const prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });

async function main() {
  const actorId = 'harness';
  await prisma.validationFinding.deleteMany({});
  await prisma.validationResult.deleteMany({});
  await prisma.validationRun.deleteMany({});
  await prisma.document.deleteMany({});
  await prisma.claim.deleteMany({});
  await prisma.scanJob.deleteMany({});
  await prisma.claimIdRule.deleteMany({});
  await prisma.statusMaster.deleteMany({});
  await prisma.subCategory.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.project.deleteMany({});

  const project = await prisma.project.create({ data: { name: 'SpellTest' } });
  const category = await prisma.category.create({ data: { name: 'Cat', projectId: project.id } });
  const sub = await prisma.subCategory.create({ data: { name: 'Sub', categoryId: category.id } });
  await prisma.statusMaster.create({
    data: { name: 'Pending', isDefault: true, displayOrder: 0, createdBy: actorId },
  });
  const rule = await prisma.claimIdRule.create({
    data: {
      subCategoryId: sub.id,
      startPosition: 1,
      length: 17,
      scanTarget: 'FILE',
      scanLocation: 'D:\\spelling-checks',
      status: 'ACTIVE',
      createdBy: actorId,
    } as never,
  });

  const scan = new ScanService(
    prisma,
    new FsDirectoryReader(),
    new DocumentService(prisma, new FsFileSystemPort()),
    (claimId, aId) => {
      void enqueue(prisma, registry, claimId, 'AUTO', aId).catch((e) =>
        console.error('enqueue error', e)
      );
    }
  );

  // NOTE: scan.enqueue() is broken against the global-masters schema (it still
  // queries statusMaster by the removed `subCategoryId`). Create the ScanJob row
  // directly so scan.run() — the real ingest+validate path — still executes.
  const job = await prisma.scanJob.create({
    data: {
      claimIdRuleId: rule.id,
      subCategoryId: sub.id,
      status: 'QUEUED',
      scanLocation: rule.scanLocation,
      scanTarget: rule.scanTarget,
      triggeredBy: actorId,
    },
  });
  await scan.run(job.id);
  const j = await prisma.scanJob.findUnique({ where: { id: job.id } });
  console.log(
    `SCAN: status=${j?.status} created=${j?.createdCount} docs=${j?.docsCreated} errors=${j?.errorCount}`
  );

  await kickDrain(prisma, registry);
  for (;;) {
    const pending = await prisma.validationRun.count({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (pending === 0) break;
    await new Promise((r) => setTimeout(r, 500));
    await kickDrain(prisma, registry);
  }

  const claims = await prisma.claim.findMany({
    where: { subCategoryId: sub.id },
    include: { documents: true },
    orderBy: { claimId: 'asc' },
  });
  const rows: unknown[] = [];
  for (const c of claims) {
    if (c.claimId.length !== 17) continue;
    const results = await prisma.validationResult.findMany({ where: { claimId: c.id } });
    const spell = results.find((r) => r.validatorKey === 'SPELL');
    const findings = await prisma.validationFinding.findMany({
      where: { claimId: c.id, validatorKey: 'SPELL' },
    });
    const suspects = findings
      .map((f) => (f.data as { word?: string } | null)?.word)
      .filter(Boolean);
    rows.push({
      vin: c.claimId,
      docs: c.documents.length,
      meta: c.metaExtractionStatus,
      spell: c.spellCheckStatus,
      qr: c.qrStatus,
      intra: c.intraClaimStatus,
      full: c.fullScanStatus,
      spellSummary: spell?.summary ?? '',
      suspectCount: suspects.length,
      suspects: suspects.slice(0, 40),
    });
  }
  console.log('\n===RESULTS_JSON===\n' + JSON.stringify(rows, null, 2) + '\n===END_JSON===');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
