/**
 * Wipe the Claims module back to empty — a HARD delete, unlike the dashboard's soft delete.
 *
 * Removes: every claim (and, by cascade, its documents rows, validation runs/results/
 * findings, field values and remarks), the claim audit log, every Claim ID Rule (and, by
 * cascade, its scan jobs), and the app's own uploaded copies under UPLOADS_ROOT/<claim id>.
 *
 * Keeps: users, projects, categories, URLs, and the claim masters (Status Master, Document
 * Types, Spell Terms, Claim Rules) — those are configuration, not data. Pass --all to wipe
 * the masters too; `npm run db:seed` puts the defaults back (claims cannot be created
 * without a default Status Master).
 * Never touches scanned source folders: those files belong to the client, not to us.
 *
 * Dry run by default (prints counts only). Stop the server first so the validation queue
 * is not mid-run, take a backup, then:
 *   npm run db:backup
 *   npm run db:clear-claims -- --yes
 *   npm run db:clear-claims -- --yes --all
 */
import path from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';

// Load server/.env explicitly — the repo-root .env is stale (see CLAUDE.md).
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { PrismaClient } from '@prisma/client';
import { claimUploadDir } from '../src/lib/uploadPaths.js';

const prisma = new PrismaClient();

async function main() {
  const confirmed = process.argv.includes('--yes');
  const all = process.argv.includes('--all');

  const claimIds = (await prisma.claim.findMany({ select: { id: true } })).map((c) => c.id);
  const counts = {
    claims: claimIds.length,
    documents: await prisma.document.count(),
    validationRuns: await prisma.validationRun.count(),
    claimAuditLogs: await prisma.claimAuditLog.count(),
    claimIdRules: await prisma.claimIdRule.count(),
    scanJobs: await prisma.scanJob.count(),
    ...(all && {
      statusMasters: await prisma.statusMaster.count(),
      documentTypes: await prisma.documentTypeMaster.count(),
      spellTerms: await prisma.spellTerm.count(),
      claimRules: await prisma.claimRule.count(),
    }),
  };
  console.table(counts);

  if (!confirmed) {
    console.log('\nDry run — nothing deleted. Re-run with --yes to delete the above.');
    return;
  }

  await prisma.$transaction([
    prisma.claimAuditLog.deleteMany(),
    prisma.claim.deleteMany(), // cascades documents, runs, results, findings, values, remarks
    prisma.claimIdRule.deleteMany(), // cascades scan jobs
    // Masters last: claims, remarks and documents reference them, and are gone by now.
    ...(all
      ? [
          prisma.statusMaster.deleteMany(),
          prisma.documentTypeMaster.deleteMany(),
          prisma.spellTerm.deleteMany(),
          prisma.claimRule.deleteMany(),
        ]
      : []),
  ]);

  // ponytail: per-claim dirs only, never the whole UPLOADS_ROOT — a mis-set root must not
  // turn this into "delete a drive".
  for (const id of claimIds) {
    await fs.rm(claimUploadDir(id), { recursive: true, force: true });
  }

  console.log(`\nDeleted ${counts.claims} claims and ${counts.claimIdRules} Claim ID Rules.`);
  if (all) console.log('Masters wiped too — run `npm run db:seed` to restore the defaults.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
