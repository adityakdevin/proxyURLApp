-- global_status_master.sql — make StatusMaster, ClaimRule, and DocumentTypeMaster
-- GLOBAL (drop their per-SubCategory scope).
--
-- DESTRUCTIVE: wipes all claims + their documents/validation/remarks, plus all
-- status_masters, claim_rules, and document_type_masters rows. Run ONLY on a DB
-- whose claim data is disposable (dev / fresh start) — the "wipe + reseed" path.
-- To keep existing claims, do NOT run this; use a dedupe-and-repoint migration.
--
-- Why the wipe is needed: each of these masters replaces a per-SubCategory unique
-- (name, sub_category_id) with a global unique(name) (and unique(govt_code) for
-- doc types). `db push` can't add those global unique indexes while duplicate
-- names exist across SubCategories, and can't drop status/doc-type rows while
-- claims + documents reference them. Clearing all of it first lets db push run.
--
-- Order of operations:
--   1. mysql < server/prisma/global_status_master.sql   (this file)
--   2. npx prisma db push                                 (drops sub_category_id, adds unique(name))
--   3. npx prisma db seed                                 (recreates the global master sets)

SET FOREIGN_KEY_CHECKS = 0;

-- Claim graph (FK-checks off so order doesn't matter; children would otherwise
-- cascade from claims, but we clear them explicitly to leave no orphans).
DELETE FROM validation_findings;
DELETE FROM validation_results;
DELETE FROM validation_runs;
DELETE FROM documents;
DELETE FROM claim_remarks;
DELETE FROM claims;

-- The masters going global.
DELETE FROM status_masters;
DELETE FROM claim_rules;
DELETE FROM document_type_masters;

SET FOREIGN_KEY_CHECKS = 1;
