CREATE TABLE `maintenance_window_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`window_id` text NOT NULL,
	`site_id` text NOT NULL,
	`version` integer NOT NULL,
	`state` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `maintenance_window_changes_version_idx` ON `maintenance_window_changes` (`window_id`,`version`);--> statement-breakpoint
CREATE TABLE `maintenance_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`version` integer NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `maintenance_windows_site_dates_idx` ON `maintenance_windows` (`site_id`,`archived`,`start_at`,`end_at`);