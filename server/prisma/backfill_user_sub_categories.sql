-- ============================================================================
-- Backfill granular sub-category access for EXISTING users.
--
-- Before this change a user was assigned only a Project and could see everything
-- in it. The new model grants access per SubCategory. To preserve behaviour, we
-- grant every existing user ALL sub-categories that live under their assigned
-- Project (via category.project_id).
--
-- Idempotent: safe to run more than once (NOT EXISTS guard). Run once on each DB
-- (dev + prod) AFTER `prisma db push` has created the user_sub_categories table.
-- ============================================================================

INSERT INTO user_sub_categories (id, user_id, sub_category_id, created_at)
SELECT UUID(), ua.user_id, sc.id, NOW()
FROM user_assignments ua
JOIN categories c ON c.project_id = ua.project_id
JOIN sub_categories sc ON sc.category_id = c.id
WHERE NOT EXISTS (
  SELECT 1 FROM user_sub_categories usc
  WHERE usc.user_id = ua.user_id AND usc.sub_category_id = sc.id
);
