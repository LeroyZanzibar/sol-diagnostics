CREATE TABLE `performance_file_cleanup` (
	`object_key` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`kind` text DEFAULT 'file' NOT NULL,
	`not_before` integer DEFAULT 0 NOT NULL
);
