/**
 * ONE-OFF TEST HELPER — load the "spelling-checks" sample batch end-to-end so you
 * can verify the SPELL validator against real salary-slip PDFs.
 *
 * It:
 *   1. parses docs/samples/spelling-checks/Deatils for sw testing - Remarks.xlsx
 *      (reusing the production import parser — its header col B was renamed to
 *      "Claim ID" to match the canonical layout).
 *   2. upserts a Claim per VIN into the SubCategory (same code path as the UI import).
 *   3. points each claim's folderPath at its flat PDF
 *      (D:\spelling-checks\<VIN>.pdf → re-rooted under CLAIMS_SCAN_ROOT) and
 *      discovers it as a document.
 *   4. enqueues validation for all of them and drains the queue.
 *   5. prints each claim's resulting SPELL status so you can eyeball the result.
 *
 * Run (from the server workspace), pointing the scan root at the samples dir:
 *   CLAIMS_SCAN_ROOT="$(cd .. && pwd)/docs/samples" npx tsx prisma/setupSpellingChecks.ts
 *   # or: npm run db:setup:spelling
 *
 * Idempotent: re-running re-upserts, re-discovers (duplicates skipped) and re-validates.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { ClaimService } from '../src/services/claimService.js';
import { DocumentService } from '../src/services/documentService.js';
import { FsFileSystemPort } from '../src/services/fsFileSystemPort.js';
import { parseObservationWorkbook } from '../src/services/observationImportService.js';
import { enqueue, kickDrain } from '../src/services/validationQueue.js';
import { registry } from '../src/validators/registry.js';

const prisma = new PrismaClient();

/** SubCategory the batch lands in (default: the demo "Warranty Claims"). */
const SUBCATEGORY_NAME = process.env.SAMPLE_SUBCATEGORY ?? 'Warranty Claims';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHEET = path.resolve(
  here,
  '../../docs/samples/spelling-checks/Deatils for sw testing - Remarks.xlsx'
);

async function main() {
  if (!process.env.CLAIMS_SCAN_ROOT) {
    throw new Error(
      'CLAIMS_SCAN_ROOT is not set — point it at the repo docs/samples dir, e.g.\n' +
        '  CLAIMS_SCAN_ROOT="$(cd .. && pwd)/docs/samples" npx tsx prisma/setupSpellingChecks.ts'
    );
  }

  const sub = await prisma.subCategory.findFirst({
    where: { name: SUBCATEGORY_NAME },
    select: { id: true, name: true },
  });
  if (!sub) {
    throw new Error(
      `SubCategory "${SUBCATEGORY_NAME}" not found. Seed the demo data first, or set ` +
        `SAMPLE_SUBCATEGORY to an existing one.`
    );
  }

  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } });
  if (!admin) throw new Error('No ADMIN user found — run the seed first.');

  const claimSvc = new ClaimService(prisma);
  const docSvc = new DocumentService(prisma, new FsFileSystemPort());

  // 1 + 2. Parse the sheet and create/refresh the claims.
  const { rows, errors } = await parseObservationWorkbook(await readFile(SHEET));
  if (errors.length) {
    console.log(`\nParse notes:`);
    for (const e of errors) console.log(`  • row ${e.rowNumber}: ${e.message}`);
  }
  const imp = await claimSvc.importObservations(rows, sub.id, admin.id, 'ALL');
  console.log(
    `\nImported into "${sub.name}": ${imp.created} created, ${imp.updated} updated` +
      (imp.errors.length ? `, ${imp.errors.length} row error(s)` : '')
  );

  // 3. Point each claim at its flat PDF and discover it as a document.
  const toValidate: { id: string; vin: string }[] = [];
  console.log(`\nWiring documents:`);
  for (const row of rows) {
    const vin = row.claimId;
    const claim = await prisma.claim.findUnique({
      where: { claimId_subCategoryId: { claimId: vin, subCategoryId: sub.id } },
      select: { id: true, subCategoryId: true },
    });
    if (!claim) continue;
    // Single-file folderPath: discoverForClaim treats a file path as one document.
    const folderPath = `D:\\spelling-checks\\${vin}.pdf`;
    await prisma.claim.update({ where: { id: claim.id }, data: { folderPath } });
    const dr = await docSvc.discoverForClaim(
      { id: claim.id, folderPath, subCategoryId: claim.subCategoryId },
      admin.id
    );
    const note = dr.created ? `+${dr.created} doc` : dr.skipped ? 'already present' : 'NO FILE FOUND';
    console.log(`  ${dr.created || dr.skipped ? '✓' : '⚠'} ${vin}: ${note}`);
    toValidate.push({ id: claim.id, vin });
  }

  // 4. Validate everything, then drain once.
  console.log(`\nValidating ${toValidate.length} claim(s)…`);
  for (const c of toValidate) await enqueue(prisma, registry, c.id, 'MANUAL', admin.id);
  await kickDrain(prisma, registry);

  // 5. Report SPELL status so the result is verifiable at a glance.
  console.log(`\nSPELL results:`);
  for (const c of toValidate) {
    const claim = await prisma.claim.findUnique({
      where: { id: c.id },
      select: { spellCheckStatus: true },
    });
    console.log(`  ${c.vin}: ${claim?.spellCheckStatus}`);
  }
  console.log(`\nDone. Open the Claims dashboard to inspect findings.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
