CREATE TABLE `telemetry_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`file_name` text NOT NULL,
	`object_key` text NOT NULL,
	`file_size` integer NOT NULL,
	`row_count` integer NOT NULL,
	`valid_rows` integer NOT NULL,
	`warning_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'imported' NOT NULL,
	`timezone` text NOT NULL,
	`mapping` text NOT NULL,
	`detected_types` text NOT NULL,
	`validation` text NOT NULL,
	`timestamp_start` text,
	`timestamp_end` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
