-- Legacy cleanup may already have created this table. Preserve its task records.
CREATE TABLE IF NOT EXISTS `maintenance_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`completed_at` text NOT NULL
);
