CREATE TABLE `monthly_configuration` (
	`site_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`configuration_json` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `site_settings`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "monthly_revision" CHECK("monthly_configuration"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `monthly_rollups` (
	`site_id` text PRIMARY KEY NOT NULL,
	`source_revision` integer NOT NULL,
	`selection_key` text NOT NULL,
	`calculation_version` integer NOT NULL,
	`payload_json` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `site_settings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `monthly_utility` (
	`site_id` text NOT NULL,
	`month` text NOT NULL,
	`on_peak` text,
	`off_peak` text,
	`revenue` text,
	`energy_used` text,
	`invoice_cost` text,
	PRIMARY KEY(`site_id`, `month`),
	FOREIGN KEY (`site_id`) REFERENCES `site_settings`(`id`) ON UPDATE no action ON DELETE no action
);
