CREATE TABLE `performance_summaries` (
	`import_id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`summary` text NOT NULL,
	`processed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
