ALTER TABLE `equipment_assets` ADD `nameplate_kva` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `equipment_assets` ADD `pv_ceiling_override_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `equipment_assets` ADD `pv_ceiling_override_kw` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `equipment_assets` ADD `notes` text DEFAULT '' NOT NULL;