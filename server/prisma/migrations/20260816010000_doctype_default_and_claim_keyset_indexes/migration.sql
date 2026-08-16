-- A document type is no longer required by default, plus keyset indexes for the claim list
-- and the validation queue.
--
-- Read server/prisma/migrations/README.md first: this project syncs with `prisma db push`,
-- so every object below may ALREADY exist. MySQL has no `CREATE INDEX IF NOT EXISTS`, so
-- each index statement is guarded against information_schema and skipped when present —
-- without that, running this file against a db-push'd database dies on ER_DUP_KEYNAME and
-- blocks every later migrate command.

-- The schema change landed as `@default(false)` on DocumentTypeMaster.isRequired, but the
-- only migration in this folder still declared `DEFAULT true`, so a database built from the
-- migration history kept creating required types — the behaviour that change removed.
-- MODIFY is idempotent: re-declaring the same column definition is a no-op.
--
-- This governs NEW rows only. Types created while the baseline's `DEFAULT true` was in force
-- still hold 1, and fullValidator reads `isRequired: true` — so changing the default does not
-- by itself undo the behaviour this branch is named for. Existing rows are backfilled
-- separately by `npm run db:backfill-doctype-required`, which is a script rather than a
-- statement here because nothing in this project executes this folder (see README.md).
ALTER TABLE `document_type_masters` MODIFY `is_required` BOOLEAN NOT NULL DEFAULT false;

-- Keyset index for the claim list.
--
-- The list orders by created_at with an id tiebreak, and the document viewer's prev/next
-- arrows range-scan that same order to find a claim's neighbours. Both run inside a fixed
-- `status`, so the composite covers the predicate and the sort together; without it each
-- neighbour lookup is a full scan plus filesort, on every viewer open.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'claims'
     AND index_name = 'claims_status_created_at_id_idx') = 0,
  'CREATE INDEX `claims_status_created_at_id_idx` ON `claims`(`status`, `created_at`, `id`)',
  'DO 0'
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- Queue drain order.
--
-- The validation drainer repeatedly picks the oldest QUEUED run. On `status` alone that
-- matches the whole queued set and sorts it to return one row — fine for one claim at a
-- time, quadratic once bulk validate can queue hundreds in a single request.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'validation_runs'
     AND index_name = 'validation_runs_status_created_at_idx') = 0,
  'CREATE INDEX `validation_runs_status_created_at_idx` ON `validation_runs`(`status`, `created_at`)',
  'DO 0'
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- The old single-column index is a strict left prefix of the composite above, so it can no
-- longer serve a query the composite cannot. Left in place it is pure write amplification:
-- every run transitions QUEUED -> RUNNING -> PASSED/FAILED, so it costs two or three
-- redundant index rewrites per run, on the exact path these indexes exist to speed up.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'validation_runs'
     AND index_name = 'validation_runs_status_idx') > 0,
  'DROP INDEX `validation_runs_status_idx` ON `validation_runs`',
  'DO 0'
);
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
