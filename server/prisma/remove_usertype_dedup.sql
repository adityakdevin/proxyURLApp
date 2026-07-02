-- ============================================================================
-- PROD PRE-MIGRATION: remove the UserType dimension safely.
--
-- Run this ONCE on each populated database (e.g. the Windows/MySQL box) BEFORE
-- running `prisma db push --accept-data-loss` with the new schema.
--
-- Why: dropping user_type_id collapses the Category uniqueness from
-- (name, user_type_id, project_id) to (name, project_id). Any categories that
-- differed ONLY by user type now collide. This script merges each colliding
-- group into a single survivor (lowest id) and repoints its children, so the
-- new unique index can be created.
--
-- SAFETY: wrapped in a transaction. If merging two categories would in turn
-- collide their sub_categories (which keep their own UNIQUE(name, category_id)),
-- the repoint UPDATE fails on that existing constraint and the whole
-- transaction ROLLS BACK — nothing is lost. If that happens, resolve the
-- duplicate sub-categories by hand and re-run.
--
-- BACK UP THE DATABASE FIRST.
-- ============================================================================

START TRANSACTION;

-- 1) Repoint sub_categories from loser categories to the survivor.
UPDATE sub_categories sc
JOIN categories c ON sc.category_id = c.id
JOIN (
  SELECT name, project_id, MIN(id) AS survivor_id
  FROM categories
  GROUP BY name, project_id
) s ON s.name = c.name AND s.project_id = c.project_id
SET sc.category_id = s.survivor_id
WHERE c.id <> s.survivor_id;

-- 2) Repoint url_configurations from loser categories to the survivor.
UPDATE url_configurations u
JOIN categories c ON u.category_id = c.id
JOIN (
  SELECT name, project_id, MIN(id) AS survivor_id
  FROM categories
  GROUP BY name, project_id
) s ON s.name = c.name AND s.project_id = c.project_id
SET u.category_id = s.survivor_id
WHERE c.id <> s.survivor_id;

-- 3) Delete the now-orphaned loser categories.
DELETE c FROM categories c
JOIN (
  SELECT name, project_id, MIN(id) AS survivor_id
  FROM categories
  GROUP BY name, project_id
) s ON s.name = c.name AND s.project_id = c.project_id
WHERE c.id <> s.survivor_id;

COMMIT;

-- After this completes without error, run:
--   npx prisma db push --accept-data-loss
-- which drops the user_type_id columns + FKs, drops the user_types table,
-- and creates the new UNIQUE(name, project_id) index on categories.
