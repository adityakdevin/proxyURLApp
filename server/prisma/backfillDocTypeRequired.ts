/**
 * Backfill for the `isRequired` default flip.
 *
 * The schema change (`@default(false)`) and the migration's `MODIFY ... DEFAULT false` both
 * only govern rows created AFTER them. Every document type created while the July baseline's
 * `is_required BOOLEAN NOT NULL DEFAULT true` was in force still holds 1, and
 * `fullValidator.ts` reads `where: { status: 'ACTIVE', isRequired: true }` — so without this
 * script the symptom the flip existed to remove survives untouched: a claim reads
 * "3 of 9 required document types present" and fails Full Scan while carrying exactly the
 * documents it should.
 *
 * WHICH ROWS: only those never edited since creation (`updatedAt` equal to `createdAt`).
 * A row an admin has opened and saved may carry a DELIBERATE tick, and there is no column
 * recording which of the two put the 1 there. Skipping edited rows errs toward leaving a
 * genuine choice alone rather than silently clearing it — the conservative direction, since
 * a type wrongly left required is visible (a claim fails Full Scan and says which type is
 * missing) while a type wrongly cleared is silent (a claim passes that should not have).
 *
 * Prints what it would touch and takes --apply to commit, because this rewrites master data.
 *
 *   npm run db:backfill-doctype-required           # dry run
 *   npm run db:backfill-doctype-required -- --apply
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const apply = process.argv.includes('--apply');

  const stillRequired = await prisma.documentTypeMaster.findMany({
    where: { isRequired: true },
    select: { id: true, name: true, status: true, createdAt: true, updatedAt: true },
    orderBy: { name: 'asc' },
  });

  // Prisma cannot compare two columns in a where clause, so split in JS. getTime() rather
  // than === because these are distinct Date objects.
  const untouched = stillRequired.filter((t) => t.updatedAt.getTime() === t.createdAt.getTime());
  const edited = stillRequired.filter((t) => t.updatedAt.getTime() !== t.createdAt.getTime());

  console.log(`${stillRequired.length} document type(s) currently required.`);

  if (edited.length) {
    console.log(`\n  SKIPPING ${edited.length} edited since creation (may be a deliberate tick):`);
    for (const t of edited) console.log(`    - ${t.name} (${t.status})`);
  }

  if (!untouched.length) {
    console.log('\nNothing to backfill.');
    return;
  }

  console.log(`\n  ${apply ? 'CLEARING' : 'WOULD CLEAR'} ${untouched.length} never edited:`);
  for (const t of untouched) console.log(`    - ${t.name} (${t.status})`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to commit.');
    return;
  }

  const { count } = await prisma.documentTypeMaster.updateMany({
    where: { id: { in: untouched.map((t) => t.id) } },
    data: { isRequired: false },
  });
  console.log(`\nCleared ${count}. Re-run Full Scan on affected claims: npm run db:revalidate`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
