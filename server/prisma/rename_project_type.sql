-- Data-preserving rename: ProjectType -> Project
-- Renames the physical table `project_types` -> `projects` and every
-- `project_type_id` FK column -> `project_id`, keeping all existing rows/relations.
-- Run once per database (dev + each deployment, incl. the Windows/MySQL box).
SET FOREIGN_KEY_CHECKS = 0;

RENAME TABLE `project_types` TO `projects`;

ALTER TABLE `categories`         CHANGE COLUMN `project_type_id` `project_id` VARCHAR(36) NOT NULL;
ALTER TABLE `url_configurations` CHANGE COLUMN `project_type_id` `project_id` VARCHAR(36) NOT NULL;
ALTER TABLE `user_assignments`   CHANGE COLUMN `project_type_id` `project_id` VARCHAR(36) NOT NULL;
ALTER TABLE `audit_logs`         CHANGE COLUMN `project_type_id` `project_id` VARCHAR(36) NOT NULL;

SET FOREIGN_KEY_CHECKS = 1;
