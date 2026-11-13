CREATE TABLE `data_history_heads` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`year` integer NOT NULL,
	`revision_id` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `data_history_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`import_id` text NOT NULL,
	`year` integer NOT NULL,
	`parent_id` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'preparing' NOT NULL,
	`step` integer DEFAULT 0 NOT NULL,
	`metadata` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `data_history_versions_site_idx` ON `data_history_versions` (`site_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `import_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`configuration` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `import_profiles_site_idx` ON `import_profiles` (`site_id`);--> statement-breakpoint
CREATE TABLE `issue_event_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`event_key` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_event_reviews_event_idx` ON `issue_event_reviews` (`site_id`,`event_key`);--> statement-breakpoint
CREATE TABLE `issue_review_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`event_key` text NOT NULL,
	`run_id` text NOT NULL,
	`version` integer NOT NULL,
	`state` text NOT NULL,
	`note` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_review_changes_version_idx` ON `issue_review_changes` (`site_id`,`event_key`,`version`);--> statement-breakpoint
CREATE INDEX `issue_review_changes_event_idx` ON `issue_review_changes` (`site_id`,`event_key`,`created_at`);