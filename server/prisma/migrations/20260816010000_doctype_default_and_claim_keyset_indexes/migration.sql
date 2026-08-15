-- A document type is no longer required by default.
--
-- The schema change landed as `@default(false)` on DocumentTypeMaster.isRequired, but the
-- only migration in this folder still declares `DEFAULT true`, so a database built from the
-- migration history kept creating required types — the exact behaviour that change removed.
-- This repo deploys with `prisma db push`, so this statement is belt-and-braces rather than
-- the live path; it exists so the two sources stop disagreeing.
ALTER TABLE `document_type_masters` MODIFY `is_required` BOOLEAN NOT NULL DEFAULT false;

-- Keyset index for the claim list.
--
-- The list orders by created_at with an id tiebreak, and the document viewer's prev/next
-- arrows range-scan that same order to find a claim's neighbours. Both run inside a fixed
-- `status`, so the composite covers the predicate and the sort together; without it each
-- neighbour lookup is a full scan plus filesort, on every viewer open.
CREATE INDEX `claims_status_created_at_id_idx` ON `claims`(`status`, `created_at`, `id`);

-- Queue drain order.
--
-- The validation drainer repeatedly picks the oldest QUEUED run. On `status` alone that
-- matches the whole queued set and sorts it to return one row — fine for one claim at a
-- time, quadratic once bulk validate can queue hundreds in a single request.
CREATE INDEX `validation_runs_status_created_at_idx` ON `validation_runs`(`status`, `created_at`);
