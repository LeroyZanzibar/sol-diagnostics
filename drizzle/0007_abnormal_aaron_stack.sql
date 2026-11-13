CREATE TABLE `analysis_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`import_id` text NOT NULL,
	`parser_version` integer NOT NULL,
	`model_revision` text NOT NULL,
	`status` text DEFAULT 'completed' NOT NULL,
	`issue_count` integer DEFAULT 0 NOT NULL,
	`analysis_object_key` text NOT NULL,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_runs_import_version_unique` ON `analysis_runs` (`import_id`,`parser_version`,`model_revision`);--> statement-breakpoint
CREATE INDEX `analysis_runs_site_completed_idx` ON `analysis_runs` (`site_id`,`completed_at`);--> statement-breakpoint
CREATE TABLE `performance_issue_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`analysis_run_id` text NOT NULL,
	`import_id` text NOT NULL,
	`site_id` text NOT NULL,
	`source_issue_id` text NOT NULL,
	`start_date_time` text NOT NULL,
	`end_date_time` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`actual_energy_kwh` real NOT NULL,
	`expected_energy_kwh` real NOT NULL,
	`estimated_loss_kwh` real,
	`loss_percent` real,
	`site_impact_percent` real NOT NULL,
	`evidence` text DEFAULT '{}' NOT NULL,
	`parser_version` integer NOT NULL,
	`model_revision` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `performance_issue_occurrence_source_unique` ON `performance_issue_occurrences` (`analysis_run_id`,`source_issue_id`);--> statement-breakpoint
CREATE INDEX `performance_issue_occurrences_issue_start_idx` ON `performance_issue_occurrences` (`issue_id`,`start_date_time`);--> statement-breakpoint
CREATE INDEX `performance_issue_occurrences_run_idx` ON `performance_issue_occurrences` (`analysis_run_id`);--> statement-breakpoint
CREATE INDEX `performance_issue_occurrences_site_start_idx` ON `performance_issue_occurrences` (`site_id`,`start_date_time`);--> statement-breakpoint
CREATE TABLE `performance_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`site_id` text NOT NULL,
	`equipment_id` text NOT NULL,
	`equipment_name` text NOT NULL,
	`equipment_external_id` text NOT NULL,
	`equipment_type` text NOT NULL,
	`name` text NOT NULL,
	`issue_type` text NOT NULL,
	`category` text NOT NULL,
	`confidence` text NOT NULL,
	`severity` text NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`first_detected_at` text NOT NULL,
	`last_detected_at` text NOT NULL,
	`occurrence_count` integer DEFAULT 0 NOT NULL,
	`latest_estimated_loss_kwh` real,
	`latest_site_impact_percent` real DEFAULT 0 NOT NULL,
	`assigned_to` text,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `performance_issues_fingerprint_unique` ON `performance_issues` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `performance_issues_site_status_idx` ON `performance_issues` (`site_id`,`status`);--> statement-breakpoint
CREATE INDEX `performance_issues_site_equipment_idx` ON `performance_issues` (`site_id`,`equipment_id`);--> statement-breakpoint
CREATE INDEX `performance_issues_site_category_idx` ON `performance_issues` (`site_id`,`category`);