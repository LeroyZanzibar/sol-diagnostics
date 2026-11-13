CREATE TABLE `analysis_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`import_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`stage` text DEFAULT 'read' NOT NULL,
	`completed` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`percent` integer DEFAULT 0 NOT NULL,
	`lease_token` text DEFAULT '' NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	`error` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `analysis_jobs_site_attempt_idx` ON `analysis_jobs` (`site_id`,`attempt_id`);