/**
 * Insert any built-in EXPECTED_TERMS missing from the SpellTerm table — and nothing else.
 *
 * WHY THIS EXISTS RATHER THAN `db:seed`
 *
 * The SPELL validator prefers the admin-managed `SpellTerm` table and only falls back to the
 * built-in EXPECTED_TERMS when that table is empty. So on any environment whose table is
 * already populated, adding terms in code has NO effect until they reach the database.
 *
 * `db:seed` does propagate them, but it also creates sample claims (CLM00001, CLM00002) and a
 * `D:\Claims\Daily` ClaimIdRule under the first active SubCategory. That is fine on a dev box
 * and NOT fine on production. This script touches the spell_terms table only.
 *
 * Idempotent and additive: `skipDuplicates` means re-running changes nothing, and terms an
 * admin added by hand are never modified or removed. Safe to run on a live database.
 *
 *   npm run db:sync-spell-terms            # from the repo root or server/
 *   npm run db:sync-spell-terms -- --dry   # report what WOULD be inserted, write nothing
 */
import path from 'path';
import dotenv from 'dotenv';

// Load server/.env explicitly — a repo-root .env is read by nothing, and one carrying a stale
// value has caused confusion before. See CLAUDE.md.
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { PrismaClient } from '@prisma/client';
import { EXPECTED_TERMS, MIN_TERM_LEN } from '../src/validators/logic.js';

const prisma = new PrismaClient();
const DRY = process.argv.includes('--dry');

async function main() {
  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
    select: { id: true, username: true },
  });
  if (!admin) throw new Error('No ADMIN user found — cannot attribute createdBy/updatedBy.');

  // Only terms the matcher can actually act on. A term with a space or under MIN_TERM_LEN
  // never matches a candidate, so inserting one would be dead weight.
  const wanted = [
    ...new Set(
      EXPECTED_TERMS.map((t) => t.toLowerCase().trim()).filter(
        (t) => t.length >= MIN_TERM_LEN && !/\s/.test(t)
      )
    ),
  ];

  const existing = new Set((await prisma.spellTerm.findMany({ select: { term: true } })).map((r) => r.term));
  const missing = wanted.filter((t) => !existing.has(t));

  console.log(`spell_terms currently holds ${existing.size} term(s).`);
  if (existing.size === 0) {
    console.log('Table is EMPTY — the validator is already falling back to the built-in list.');
  }
  console.log(`Built-in list has ${wanted.length} usable term(s); ${missing.length} missing.`);

  if (missing.length === 0) {
    console.log('Nothing to do.');
    return;
  }
  console.log(`\nWould insert:\n  ${missing.join(', ')}\n`);

  if (DRY) {
    console.log('--dry given: nothing written.');
    return;
  }

  const res = await prisma.spellTerm.createMany({
    skipDuplicates: true,
    data: missing.map((term) => ({ term, createdBy: admin.id, updatedBy: admin.id })),
  });
  console.log(`Inserted ${res.count} term(s) as ACTIVE, attributed to "${admin.username}".`);
  console.log(
    '\nExisting claims keep their stored statuses — the new terms only take effect when a ' +
      'claim is re-validated.'
  );
}

main()
  .catch((e) => {
    console.error('sync failed:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
