-- deactivate_spell_gazetteer.sql — retire the proper-noun entries from the SPELL
-- dictionary (place and brand names).
--
-- NON-DESTRUCTIVE: flips status to INACTIVE, keeps the rows. Re-activate from the
-- Spell Dictionary admin screen if a reviewer wants any of them back.
--
-- Why this file has to exist: the SPELL validator prefers the admin-managed
-- `spell_terms` table and only falls back to the built-in EXPECTED_TERMS list when
-- that table is empty. `prisma db seed` uses createMany({skipDuplicates:true}), so it
-- is ADDITIVE ONLY — deleting a term from EXPECTED_TERMS in code has NO effect on a
-- database that has already been seeded. Removals need this script.
--
-- Why these five: proper nouns are the worst OCR class (no language model backs them)
-- and legitimately vary in spelling, so they produced the reviewers' loudest false
-- positives — "Lucnow" flagged against "lucknow" on a correctly printed branch header.
--
-- Order of operations after deploying the UAT spell-check fixes:
--   1. npm run db:seed                                     (adds the new terms)
--   2. mysql <db> < server/prisma/deactivate_spell_gazetteer.sql   (this file)
--   3. re-run validation for affected claims (npm run db:revalidate)

UPDATE spell_terms
SET status = 'INACTIVE',
    updated_at = NOW()
WHERE term IN ('lucknow', 'bajaj', 'jindal', 'prudential', 'flipkart')
  AND status = 'ACTIVE';

SELECT term, status FROM spell_terms
WHERE term IN ('lucknow', 'bajaj', 'jindal', 'prudential', 'flipkart');
