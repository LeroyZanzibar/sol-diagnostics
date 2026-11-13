DROP INDEX `analysis_runs_import_version_unique`;--> statement-breakpoint
CREATE INDEX `analysis_runs_import_version_idx` ON `analysis_runs` (`import_id`,`parser_version`,`model_revision`);