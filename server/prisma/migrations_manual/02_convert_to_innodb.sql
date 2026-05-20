-- Convert pre-existing MyISAM tables to InnoDB so foreign keys can be created.
-- MyISAM does not support foreign keys; all new claim tables are InnoDB and need to
-- reference these tables.

ALTER TABLE `users`              ENGINE=InnoDB;
ALTER TABLE `user_types`         ENGINE=InnoDB;
ALTER TABLE `project_types`      ENGINE=InnoDB;
ALTER TABLE `categories`         ENGINE=InnoDB;
ALTER TABLE `sub_categories`     ENGINE=InnoDB;
ALTER TABLE `url_configurations` ENGINE=InnoDB;
ALTER TABLE `user_assignments`   ENGINE=InnoDB;
ALTER TABLE `sessions`           ENGINE=InnoDB;
ALTER TABLE `audit_logs`         ENGINE=InnoDB;
ALTER TABLE `settings`           ENGINE=InnoDB;
