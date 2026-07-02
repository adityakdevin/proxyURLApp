/**
 * ONE-OFF TEST HELPER — finish wiring the client's forged-document sample claims
 * after the observation sheet has been imported, so you don't have to Sync +
 * Validate each claim by hand in the UI.
 *
 * For every sample claim it:
 *   1. sets folderPath = D:\Claims\Daily\<VIN>  (the import doesn't set it, and the
 *      claim-edit UI shows it read-only). resolveScanRoot() re-roots that under
 *      CLAIMS_SCAN_ROOT at read time.
 *   2. discovers the documents in that folder (same code path as "Sync from folder").
 *   3. enqueues a validation run and waits for the whole queue to drain.
 *
 * Prereqs:
 *   • Import "docs/samples/Forged Documents Observations.xlsx" into the SubCategory
 *     first (Admin -> Claims -> Import Observations). Default target: "Warranty Claims".
 *   • The docs/samples/Claims/Daily/<VIN>/ folders must exist with their files.
 *
 * Run (from the server workspace):
 *   npm run db:setup:samples
 *   # or explicitly:
 *   CLAIMS_SCAN_ROOT=<repo>/docs/samples npx tsx prisma/setupSampleClaims.ts
 *
 * Idempotent: re-running re-discovers (duplicates are skipped) and re-validates.
 * MZBFB812LSN564344 and MZBB1811LSN014084 have no folder on purpose, so they stay
 * document-less and validate to DOCS_NOT_AVAILABLE.
 */
import { PrismaClient } from '@prisma/client';
import { DocumentService } from '../src/services/documentService.js';
import { FsFileSystemPort } from '../src/services/fsFileSystemPort.js';
import { enqueue, kickDrain } from '../src/services/validationQueue.js';
import { registry } from '../src/validators/registry.js';

const prisma = new PrismaClient();

/** SubCategory the sheet was imported into (default: the demo "Warranty Claims"). */
const SUBCATEGORY_NAME = process.env.SAMPLE_SUBCATEGORY ?? 'Warranty Claims';

/** VINs with a docs/samples/Claims/Daily/<VIN>/ folder of real files. */
const VINS_WITH_FOLDERS = [
  'MZBFB812LSN538764',
  'MZBFB812LSN555495',
  'MZBFB812LSN552928',
  'MZBFB812LSN534536',
  'MZBB6814LSN024292',
  'MZBB6814MSN022501',
  'MZBEP812LSN709538',
  'MZBEP812LSN709192',
];

/** VINs deliberately left with no documents (exercise DOCS_NOT_AVAILABLE). */
const VINS_NO_DOCS = ['MZBFB812LSN564344', 'MZBB1811LSN014084'];

async function main() {
  const sub = await prisma.subCategory.findFirst({
    where: { name: SUBCATEGORY_NAME },
    select: { id: true, name: true },
  });
  if (!sub) {
    throw new Error(
      `SubCategory "${SUBCATEGORY_NAME}" not found. Import the sheet into it first, ` +
        `or set SAMPLE_SUBCATEGORY to the right name.`
    );
  }

  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } });
  const actorId = admin?.id;
  const docSvc = new DocumentService(prisma, new FsFileSystemPort());

  const findClaim = (vin: string) =>
    prisma.claim.findUnique({
      where: { claimId_subCategoryId: { claimId: vin, subCategoryId: sub.id } },
      select: { id: true, subCategoryId: true },
    });

  const toValidate: string[] = [];
  const missing: string[] = [];

  console.log(`\nWiring sample claims in "${sub.name}":`);
  for (const vin of VINS_WITH_FOLDERS) {
    const claim = await findClaim(vin);
    if (!claim) {
      missing.push(vin);
      continue;
    }
    const folderPath = `D:\\Claims\\Daily\\${vin}`;
    await prisma.claim.update({ where: { id: claim.id }, data: { folderPath } });
    const dr = await docSvc.discoverForClaim(
      { id: claim.id, folderPath, subCategoryId: claim.subCategoryId },
      actorId
    );
    console.log(`  ✓ ${vin}: folderPath set, +${dr.created} doc(s) (${dr.skipped} already present)`);
    toValidate.push(claim.id);
  }

  for (const vin of VINS_NO_DOCS) {
    const claim = await findClaim(vin);
    if (!claim) {
      missing.push(vin);
      continue;
    }
    console.log(`  • ${vin}: no folder (expect DOCS_NOT_AVAILABLE)`);
    toValidate.push(claim.id);
  }

  if (missing.length) {
    console.log(`\n⚠ Claims not found (import the sheet first?): ${missing.join(', ')}`);
  }

  // Enqueue every run FIRST, then drain once — no rearm races, and the drain loop
  // processes all QUEUED runs before its promise resolves.
  console.log(`\nQueuing validation for ${toValidate.length} claim(s)…`);
  for (const claimId of toValidate) {
    await enqueue(prisma, registry, claimId, 'MANUAL', actorId);
  }
  await kickDrain(prisma, registry);

  console.log(`\nDone. Refresh the Claims dashboard to see the badges and Status.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
