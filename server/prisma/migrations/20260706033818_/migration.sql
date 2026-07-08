-- CreateTable
CREATE TABLE `projects` (
    `id` VARCHAR(36) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `description` VARCHAR(500) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(36) NULL,
    `updated_by` VARCHAR(36) NULL,

    UNIQUE INDEX `projects_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` VARCHAR(36) NOT NULL,
    `username` VARCHAR(100) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `full_name` VARCHAR(200) NOT NULL,
    `role` ENUM('USER', 'TEAM_LEAD', 'ADMIN') NOT NULL DEFAULT 'USER',
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `force_password_change` BOOLEAN NOT NULL DEFAULT true,
    `failed_attempts` INTEGER NOT NULL DEFAULT 0,
    `locked_until` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(36) NULL,
    `updated_by` VARCHAR(36) NULL,

    UNIQUE INDEX `users_username_key`(`username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_assignments` (
    `id` VARCHAR(36) NOT NULL,
    `user_id` VARCHAR(36) NOT NULL,
    `project_id` VARCHAR(36) NOT NULL,

    UNIQUE INDEX `user_assignments_user_id_key`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_sub_categories` (
    `id` VARCHAR(36) NOT NULL,
    `user_id` VARCHAR(36) NOT NULL,
    `sub_category_id` VARCHAR(36) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `user_sub_categories_sub_category_id_idx`(`sub_category_id`),
    UNIQUE INDEX `user_sub_categories_user_id_sub_category_id_key`(`user_id`, `sub_category_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `categories` (
    `id` VARCHAR(36) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `project_id` VARCHAR(36) NOT NULL,
    `description` VARCHAR(500) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(36) NULL,
    `updated_by` VARCHAR(36) NULL,

    UNIQUE INDEX `categories_name_project_id_key`(`name`, `project_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sub_categories` (
    `id` VARCHAR(36) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `category_id` VARCHAR(36) NOT NULL,
    `description` VARCHAR(500) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(36) NULL,
    `updated_by` VARCHAR(36) NULL,

    UNIQUE INDEX `sub_categories_name_category_id_key`(`name`, `category_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `url_configurations` (
    `id` VARCHAR(36) NOT NULL,
    `label` VARCHAR(200) NOT NULL,
    `description` VARCHAR(500) NULL,
    `target_url` VARCHAR(2000) NOT NULL,
    `opaque_id` VARCHAR(36) NOT NULL,
    `project_id` VARCHAR(36) NOT NULL,
    `category_id` VARCHAR(36) NOT NULL,
    `sub_category_id` VARCHAR(36) NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(36) NULL,
    `updated_by` VARCHAR(36) NULL,
    `proxy_mode` ENUM('DIRECT', 'HEADLESS', 'NEW_WINDOW') NOT NULL DEFAULT 'DIRECT',
    `headless_timeout` INTEGER NOT NULL DEFAULT 60000,
    `session_ttl` INTEGER NOT NULL DEFAULT 30000,
    `audit_level` ENUM('STANDARD', 'NAVIGATION', 'FULL') NOT NULL DEFAULT 'STANDARD',

    UNIQUE INDEX `url_configurations_opaque_id_key`(`opaque_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` VARCHAR(36) NOT NULL,
    `user_id` VARCHAR(36) NOT NULL,
    `session_token` VARCHAR(64) NOT NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_activity` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `impersonated_by` VARCHAR(36) NULL,

    UNIQUE INDEX `sessions_session_token_key`(`session_token`),
    INDEX `sessions_session_token_idx`(`session_token`),
    INDEX `sessions_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` VARCHAR(36) NOT NULL,
    `user_id` VARCHAR(36) NOT NULL,
    `project_id` VARCHAR(36) NOT NULL,
    `url_config_id` VARCHAR(36) NOT NULL,
    `target_url` VARCHAR(2000) NOT NULL,
    `request_method` VARCHAR(10) NOT NULL,
    `response_status` INTEGER NOT NULL,
    `duration_ms` INTEGER NOT NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(500) NULL,
    `accessed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_user_id_idx`(`user_id`),
    INDEX `audit_logs_accessed_at_idx`(`accessed_at`),
    INDEX `audit_logs_project_id_idx`(`project_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `settings` (
    `id` VARCHAR(36) NOT NULL,
    `key` VARCHAR(100) NOT NULL,
    `value` VARCHAR(1000) NOT NULL,

    UNIQUE INDEX `settings_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `proxy_metrics` (
    `id` VARCHAR(36) NOT NULL,
    `url_config_id` VARCHAR(36) NOT NULL,
    `user_id` VARCHAR(36) NOT NULL,
    `session_id` VARCHAR(64) NOT NULL,
    `proxy_mode` ENUM('DIRECT', 'HEADLESS', 'NEW_WINDOW') NOT NULL,
    `start_time` DATETIME(3) NOT NULL,
    `end_time` DATETIME(3) NULL,
    `duration_ms` INTEGER NULL,
    `ttfb_ms` INTEGER NULL,
    `dom_load_ms` INTEGER NULL,
    `success` BOOLEAN NOT NULL DEFAULT true,
    `error_code` VARCHAR(50) NULL,
    `error_message` TEXT NULL,
    `target_url` VARCHAR(2000) NOT NULL,
    `http_status` INTEGER NULL,
    `bytes_transferred` INTEGER NULL,
    `browser_spawn_ms` INTEGER NULL,
    `queue_wait_ms` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `proxy_metrics_url_config_id_idx`(`url_config_id`),
    INDEX `proxy_metrics_user_id_idx`(`user_id`),
    INDEX `proxy_metrics_start_time_idx`(`start_time`),
    INDEX `proxy_metrics_proxy_mode_idx`(`proxy_mode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `status_masters` (
    `id` VARCHAR(36) NOT NULL,
    `sub_category_id` VARCHAR(36) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `display_order` INTEGER NOT NULL DEFAULT 0,
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `is_terminal` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(36) NULL,
    `updated_by` VARCHAR(36) NULL,

    INDEX `status_masters_sub_category_id_idx`(`sub_category_id`),
    UNIQUE INDEX `status_masters_name_sub_category_id_key`(`name`, `sub_category_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_type_masters` (
    `id` VARCHAR(36) NOT NULL,
    `sub_category_id` VARCHAR(36) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `category` ENUM('GOVT', 'CUSTOM') NOT NULL,
    `govt_code` ENUM('AADHAR', 'PAN', 'DL', 'PASSPORT', 'VOTER_ID', 'RATION_CARD') NULL,
    `display_order` INTEGER NOT NULL DEFAULT 0,
    `is_required` BOOLEAN NOT NULL DEFAULT true,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(36) NULL,
    `updated_by` VARCHAR(36) NULL,

    INDEX `document_type_masters_sub_category_id_idx`(`sub_category_id`),
    UNIQUE INDEX `document_type_masters_name_sub_category_id_key`(`name`, `sub_category_id`),
    UNIQUE INDEX `document_type_masters_govt_code_sub_category_id_key`(`govt_code`, `sub_category_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `claim_id_rules` (
    `id` VARCHAR(36) NOT NULL,
    `sub_category_id` VARCHAR(36) NOT NULL,
    `start_position` INTEGER NOT NULL,
    `length` INTEGER NOT NULL,
    `scan_target` ENUM('FOLDER', 'FILE') NOT NULL,
    `scan_location` VARCHAR(500) NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(36) NULL,
    `updated_by` VARCHAR(36) NULL,

    UNIQUE INDEX `claim_id_rules_sub_category_id_key`(`sub_category_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `claims` (
    `id` VARCHAR(36) NOT NULL,
    `claim_id` VARCHAR(100) NOT NULL,
    `sub_category_id` VARCHAR(36) NOT NULL,
    `workflow_status_id` VARCHAR(36) NOT NULL,
    `assigned_to_user_id` VARCHAR(36) NULL,
    `folder_path` VARCHAR(500) NULL,
    `dealer_name` VARCHAR(255) NULL,
    `dealer_code` VARCHAR(50) NULL,
    `invoice_date` DATETIME(3) NULL,
    `vin_no` VARCHAR(100) NULL,
    `customer_name` VARCHAR(255) NULL,
    `scheme_type` VARCHAR(100) NULL,
    `observation_remarks` TEXT NULL,
    `spell_check_status` ENUM('PENDING', 'IN_PROGRESS', 'PASSED', 'FAILED', 'DOCS_NOT_AVAILABLE') NOT NULL DEFAULT 'PENDING',
    `qr_status` ENUM('PENDING', 'IN_PROGRESS', 'PASSED', 'FAILED', 'DOCS_NOT_AVAILABLE') NOT NULL DEFAULT 'PENDING',
    `meta_extraction_status` ENUM('PENDING', 'IN_PROGRESS', 'PASSED', 'FAILED', 'DOCS_NOT_AVAILABLE') NOT NULL DEFAULT 'PENDING',
    `intra_claim_status` ENUM('PENDING', 'IN_PROGRESS', 'PASSED', 'FAILED', 'DOCS_NOT_AVAILABLE') NOT NULL DEFAULT 'PENDING',
    `full_scan_status` ENUM('PENDING', 'IN_PROGRESS', 'PASSED', 'FAILED', 'DOCS_NOT_AVAILABLE') NOT NULL DEFAULT 'PENDING',
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(36) NULL,
    `updated_by` VARCHAR(36) NULL,

    INDEX `claims_sub_category_id_idx`(`sub_category_id`),
    INDEX `claims_workflow_status_id_idx`(`workflow_status_id`),
    INDEX `claims_assigned_to_user_id_idx`(`assigned_to_user_id`),
    INDEX `claims_created_by_idx`(`created_by`),
    UNIQUE INDEX `claims_claim_id_sub_category_id_key`(`claim_id`, `sub_category_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `claim_remarks` (
    `id` VARCHAR(36) NOT NULL,
    `claim_id` VARCHAR(36) NOT NULL,
    `user_id` VARCHAR(36) NOT NULL,
    `remark_text` TEXT NOT NULL,
    `status_before_id` VARCHAR(36) NULL,
    `status_after_id` VARCHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `claim_remarks_claim_id_idx`(`claim_id`),
    INDEX `claim_remarks_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `scan_jobs` (
    `id` VARCHAR(36) NOT NULL,
    `claim_id_rule_id` VARCHAR(36) NOT NULL,
    `sub_category_id` VARCHAR(36) NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `scan_location` VARCHAR(500) NOT NULL,
    `scan_target` ENUM('FOLDER', 'FILE') NOT NULL,
    `total_entries` INTEGER NOT NULL DEFAULT 0,
    `created_count` INTEGER NOT NULL DEFAULT 0,
    `skipped_count` INTEGER NOT NULL DEFAULT 0,
    `error_count` INTEGER NOT NULL DEFAULT 0,
    `docs_created` INTEGER NOT NULL DEFAULT 0,
    `docs_skipped` INTEGER NOT NULL DEFAULT 0,
    `errors` JSON NULL,
    `message` VARCHAR(500) NULL,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `triggered_by` VARCHAR(36) NULL,

    INDEX `scan_jobs_sub_category_id_idx`(`sub_category_id`),
    INDEX `scan_jobs_claim_id_rule_id_idx`(`claim_id_rule_id`),
    INDEX `scan_jobs_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `documents` (
    `id` VARCHAR(36) NOT NULL,
    `claim_id` VARCHAR(36) NOT NULL,
    `document_type_id` VARCHAR(36) NULL,
    `source` ENUM('SCANNED', 'UPLOADED') NOT NULL,
    `file_name` VARCHAR(500) NOT NULL,
    `storage_path` VARCHAR(500) NOT NULL,
    `size_bytes` INTEGER NULL,
    `mime_type` VARCHAR(150) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` VARCHAR(36) NULL,

    INDEX `documents_claim_id_idx`(`claim_id`),
    INDEX `documents_document_type_id_idx`(`document_type_id`),
    UNIQUE INDEX `documents_claim_id_storage_path_key`(`claim_id`, `storage_path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `validation_runs` (
    `id` VARCHAR(36) NOT NULL,
    `claim_id` VARCHAR(36) NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `trigger` ENUM('AUTO', 'MANUAL') NOT NULL,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `triggered_by` VARCHAR(36) NULL,
    `message` VARCHAR(500) NULL,

    INDEX `validation_runs_claim_id_idx`(`claim_id`),
    INDEX `validation_runs_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `validation_results` (
    `id` VARCHAR(36) NOT NULL,
    `run_id` VARCHAR(36) NOT NULL,
    `claim_id` VARCHAR(36) NOT NULL,
    `validator_key` VARCHAR(20) NOT NULL,
    `status` ENUM('PENDING', 'IN_PROGRESS', 'PASSED', 'FAILED', 'DOCS_NOT_AVAILABLE') NOT NULL,
    `summary` VARCHAR(500) NULL,
    `details` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `validation_results_claim_id_idx`(`claim_id`),
    INDEX `validation_results_run_id_idx`(`run_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `validation_findings` (
    `id` VARCHAR(36) NOT NULL,
    `result_id` VARCHAR(36) NOT NULL,
    `claim_id` VARCHAR(36) NOT NULL,
    `validator_key` VARCHAR(20) NOT NULL,
    `document_id` VARCHAR(36) NULL,
    `code` VARCHAR(40) NOT NULL,
    `severity` ENUM('INFO', 'WARNING', 'ERROR') NOT NULL DEFAULT 'WARNING',
    `message` VARCHAR(500) NOT NULL,
    `page` INTEGER NULL,
    `bbox` JSON NULL,
    `data` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `validation_findings_result_id_idx`(`result_id`),
    INDEX `validation_findings_claim_id_idx`(`claim_id`),
    INDEX `validation_findings_document_id_page_idx`(`document_id`, `page`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `claim_rules` (
    `id` VARCHAR(36) NOT NULL,
    `sub_category_id` VARCHAR(36) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `field` ENUM('DOCUMENT_COUNT', 'REMARK_COUNT', 'ASSIGNED', 'HAS_DOCUMENT_TYPE', 'WORKFLOW_STATUS', 'SPELL_STATUS', 'QR_STATUS', 'META_STATUS', 'INTRA_STATUS', 'FULL_STATUS') NOT NULL,
    `operator` ENUM('EQ', 'NEQ', 'GTE', 'LTE', 'GT', 'LT') NOT NULL,
    `value` VARCHAR(150) NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `display_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` VARCHAR(36) NULL,
    `updated_by` VARCHAR(36) NULL,

    INDEX `claim_rules_sub_category_id_idx`(`sub_category_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `user_assignments` ADD CONSTRAINT `user_assignments_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_assignments` ADD CONSTRAINT `user_assignments_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_sub_categories` ADD CONSTRAINT `user_sub_categories_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_sub_categories` ADD CONSTRAINT `user_sub_categories_sub_category_id_fkey` FOREIGN KEY (`sub_category_id`) REFERENCES `sub_categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `categories` ADD CONSTRAINT `categories_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sub_categories` ADD CONSTRAINT `sub_categories_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `url_configurations` ADD CONSTRAINT `url_configurations_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `url_configurations` ADD CONSTRAINT `url_configurations_category_id_fkey` FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `url_configurations` ADD CONSTRAINT `url_configurations_sub_category_id_fkey` FOREIGN KEY (`sub_category_id`) REFERENCES `sub_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_project_id_fkey` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_url_config_id_fkey` FOREIGN KEY (`url_config_id`) REFERENCES `url_configurations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proxy_metrics` ADD CONSTRAINT `proxy_metrics_url_config_id_fkey` FOREIGN KEY (`url_config_id`) REFERENCES `url_configurations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `proxy_metrics` ADD CONSTRAINT `proxy_metrics_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `status_masters` ADD CONSTRAINT `status_masters_sub_category_id_fkey` FOREIGN KEY (`sub_category_id`) REFERENCES `sub_categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_type_masters` ADD CONSTRAINT `document_type_masters_sub_category_id_fkey` FOREIGN KEY (`sub_category_id`) REFERENCES `sub_categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `claim_id_rules` ADD CONSTRAINT `claim_id_rules_sub_category_id_fkey` FOREIGN KEY (`sub_category_id`) REFERENCES `sub_categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `claims` ADD CONSTRAINT `claims_sub_category_id_fkey` FOREIGN KEY (`sub_category_id`) REFERENCES `sub_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `claims` ADD CONSTRAINT `claims_workflow_status_id_fkey` FOREIGN KEY (`workflow_status_id`) REFERENCES `status_masters`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `claims` ADD CONSTRAINT `claims_assigned_to_user_id_fkey` FOREIGN KEY (`assigned_to_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `claim_remarks` ADD CONSTRAINT `claim_remarks_claim_id_fkey` FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `claim_remarks` ADD CONSTRAINT `claim_remarks_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `claim_remarks` ADD CONSTRAINT `claim_remarks_status_before_id_fkey` FOREIGN KEY (`status_before_id`) REFERENCES `status_masters`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `claim_remarks` ADD CONSTRAINT `claim_remarks_status_after_id_fkey` FOREIGN KEY (`status_after_id`) REFERENCES `status_masters`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `scan_jobs` ADD CONSTRAINT `scan_jobs_claim_id_rule_id_fkey` FOREIGN KEY (`claim_id_rule_id`) REFERENCES `claim_id_rules`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `scan_jobs` ADD CONSTRAINT `scan_jobs_sub_category_id_fkey` FOREIGN KEY (`sub_category_id`) REFERENCES `sub_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `documents` ADD CONSTRAINT `documents_claim_id_fkey` FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `documents` ADD CONSTRAINT `documents_document_type_id_fkey` FOREIGN KEY (`document_type_id`) REFERENCES `document_type_masters`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `validation_runs` ADD CONSTRAINT `validation_runs_claim_id_fkey` FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `validation_results` ADD CONSTRAINT `validation_results_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `validation_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `validation_results` ADD CONSTRAINT `validation_results_claim_id_fkey` FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `validation_findings` ADD CONSTRAINT `validation_findings_result_id_fkey` FOREIGN KEY (`result_id`) REFERENCES `validation_results`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `validation_findings` ADD CONSTRAINT `validation_findings_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `claim_rules` ADD CONSTRAINT `claim_rules_sub_category_id_fkey` FOREIGN KEY (`sub_category_id`) REFERENCES `sub_categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
