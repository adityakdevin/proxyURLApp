-- Manual role backfill, run via `prisma db execute` before `prisma db push`.
-- Adds the `role` column on `users`, then copies `is_admin = TRUE` rows to ADMIN role.
-- The subsequent `prisma db push` will drop the now-unused `is_admin` column.

ALTER TABLE `users`
  ADD COLUMN `role` ENUM('USER','TEAM_LEAD','ADMIN') NOT NULL DEFAULT 'USER';

UPDATE `users` SET `role` = 'ADMIN' WHERE `is_admin` = 1;
