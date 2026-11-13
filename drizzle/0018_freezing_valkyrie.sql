CREATE TABLE `maintenance_calendar_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`date` text NOT NULL,
	`task` text NOT NULL,
	`source_site` text NOT NULL,
	`source_row` integer NOT NULL,
	`details` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `maintenance_calendar_site_date_idx` ON `maintenance_calendar_entries` (`site_id`,`date`);--> statement-breakpoint
CREATE TABLE `maintenance_calendar_state` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`file_name` text NOT NULL,
	`file_size` integer NOT NULL,
	`imported_at` text NOT NULL,
	`row_count` integer NOT NULL,
	`site_count` integer NOT NULL,
	`mappings` text NOT NULL,
	`content_hash` text NOT NULL
);
