CREATE TABLE `vcom_key_identity` (
	`id` text PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vcom_manual_chunks` (
	`job_id` text NOT NULL,
	`request_index` integer NOT NULL,
	`request_id` text NOT NULL,
	`plan_hash` text NOT NULL,
	`payload_hash` text NOT NULL,
	`raw` text NOT NULL,
	`bytes` integer NOT NULL,
	PRIMARY KEY(`job_id`, `request_index`),
	FOREIGN KEY (`job_id`) REFERENCES `vcom_manual_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vcom_chunk_identity` ON `vcom_manual_chunks` (`job_id`,`request_id`);--> statement-breakpoint
CREATE TABLE `vcom_manual_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`request_id` text NOT NULL,
	`generation` integer NOT NULL,
	`from_date` text NOT NULL,
	`through_date` text NOT NULL,
	`actor` text NOT NULL,
	`plan` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`next_attempt_at` integer,
	`completed_requests` integer DEFAULT 0 NOT NULL,
	`total_requests` integer NOT NULL,
	`raw_bytes` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`stage_attempts` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_until` integer,
	`message` text NOT NULL,
	`error_code` text,
	`stage_id` text,
	`preview` text,
	`result` text,
	`quality` text,
	`state` text DEFAULT '{}' NOT NULL,
	CONSTRAINT "vcom_job_status" CHECK("vcom_manual_jobs"."status" IN ('queued','downloading','staging','awaiting_approval','committed','failed','canceled')),
	CONSTRAINT "vcom_job_cursor" CHECK("vcom_manual_jobs"."completed_requests" >= 0 AND "vcom_manual_jobs"."completed_requests" <= "vcom_manual_jobs"."total_requests")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vcom_request_identity` ON `vcom_manual_jobs` (`site_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `vcom_one_unfinished` ON `vcom_manual_jobs` (`site_id`) WHERE "vcom_manual_jobs"."status" IN ('queued','downloading','staging','awaiting_approval');--> statement-breakpoint
CREATE INDEX `vcom_pending_work` ON `vcom_manual_jobs` (`status`,`next_attempt_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `vcom_site_settings` (
	`site_id` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`system_key` text NOT NULL,
	`auth_mode` text NOT NULL,
	`credentials` text,
	`discovery` text,
	`mappings` text NOT NULL,
	`selected_poa_source_id` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "vcom_settings_generation" CHECK("vcom_site_settings"."generation" >= 1)
);
