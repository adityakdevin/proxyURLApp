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

  // Status matters: the validator loads `where: { status: 'ACTIVE' }`, so an INACTIVE row is
  // invisible to the spell check. Counting rows regardless of status made this script report
  // "0 missing / nothing to do" for a term that was present, inactive, and therefore doing
  // nothing — and because the insert dedups on `term`, the script could never repair it
  // either. A silent gap between "the word is in the table" and "the check can see it".
  const rows = await prisma.spellTerm.findMany({ select: { term: true, status: true } });
  const active = new Set(rows.filter((r) => r.status === 'ACTIVE').map((r) => r.term));
  const inactive = new Set(rows.filter((r) => r.status !== 'ACTIVE').map((r) => r.term));
  const missing = wanted.filter((t) => !active.has(t) && !inactive.has(t));
  // Present but switched off. Not insertable (the term already exists), so it needs a human
  // decision: reactivate in /admin/spell-terms, or accept that the word is not checked.
  const dormant = wanted.filter((t) => inactive.has(t));

  console.log(`spell_terms holds ${rows.length} row(s): ${active.size} ACTIVE, ${inactive.size} inactive.`);
  if (active.size === 0) {
    console.log('No ACTIVE rows — the validator is falling back to the built-in list.');
  }
  console.log(`Built-in list has ${wanted.length} usable term(s); ${missing.length} missing.`);

  if (dormant.length) {
    console.log(
      `\n${dormant.length} built-in term(s) exist but are INACTIVE, so the spell check ignores ` +
        `them. This script cannot fix that — reactivate them in /admin/spell-terms:\n  ${dormant.join(', ')}\n`
    );
  }

  // Terms an admin added by hand. Worth printing because this is where false positives come
  // from: the built-in list deliberately carries NO place or brand names (they are the worst
  // OCR class and produced the loudest reviewer complaints, e.g. "lucnow" against 'lucknow'),
  // so any such term in use was added here and can be switched off here.
  const extra = [...active].filter((t) => !wanted.includes(t)).sort();
  if (extra.length) {
    console.log(
      `\n${extra.length} ACTIVE term(s) are admin-added, not built-in. A false positive on a ` +
        `place or brand name will be one of these:\n  ${extra.join(', ')}\n`
    );
  }

  if (missing.length === 0) {
    console.log(dormant.length ? 'Nothing to insert.' : 'Nothing to do.');
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
