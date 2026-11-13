import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Imported calendar annotations are independent of timed maintenance windows and losses.
export const maintenanceCalendarState = sqliteTable('maintenance_calendar_state', {
  id:text('id').primaryKey(), revision:text('revision').notNull(),
  fileName:text('file_name').notNull(),fileSize:integer('file_size').notNull(),
  importedAt:text('imported_at').notNull(),rowCount:integer('row_count').notNull(),
  siteCount:integer('site_count').notNull(),mappings:text('mappings').notNull(),contentHash:text('content_hash').notNull(),
});
export const maintenanceCalendarEntries = sqliteTable('maintenance_calendar_entries', {
  id:text('id').primaryKey(),siteId:text('site_id').notNull(),date:text('date').notNull(),
  task:text('task').notNull(),sourceSite:text('source_site').notNull(),sourceRow:integer('source_row').notNull(),
  details:text('details').notNull(),
},table=>[index('maintenance_calendar_site_date_idx').on(table.siteId,table.date)]);

export const siteSettings = sqliteTable("site_settings", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  address: text("address").notNull().default(""),
  city: text("city").notNull().default(""),
  state: text("state").notNull().default(""),
  zip: text("zip").notNull().default(""),
  country: text("country").notNull().default("US"),
  latitude: text("latitude").notNull().default(""),
  longitude: text("longitude").notNull().default(""),
  expectedShading: text("expected_shading").notNull().default("not_included"),
  expectedSnow: text("expected_snow").notNull().default("not_included"),
  expectedProductionNotes: text("expected_production_notes").notNull().default(""),
  arrayModelVerified: integer("array_model_verified", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const telemetryImports = sqliteTable("telemetry_imports", {
  id: text("id").primaryKey(),
  siteId: text("site_id").notNull(),
  fileName: text("file_name").notNull(),
  objectKey: text("object_key").notNull(),
  fileSize: integer("file_size").notNull(),
  rowCount: integer("row_count").notNull(),
  validRows: integer("valid_rows").notNull(),
  warningCount: integer("warning_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  status: text("status").notNull().default("imported"),
  timezone: text("timezone").notNull(),
  mapping: text("mapping").notNull(),
  detectedTypes: text("detected_types").notNull(),
  validation: text("validation").notNull(),
  timestampStart: text("timestamp_start"),
  timestampEnd: text("timestamp_end"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const performanceSummaries = sqliteTable("performance_summaries", {
  importId: text("import_id").primaryKey(),
  siteId: text("site_id").notNull(),
  summary: text("summary").notNull(),
  processedAt: text("processed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const analysisRuns = sqliteTable("analysis_runs", {
  id: text("id").primaryKey(),
  siteId: text("site_id").notNull(),
  importId: text("import_id").notNull(),
  parserVersion: integer("parser_version").notNull(),
  modelRevision: text("model_revision").notNull(),
  status: text("status").notNull().default("completed"),
  issueCount: integer("issue_count").notNull().default(0),
  analysisObjectKey: text("analysis_object_key").notNull(),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [
  index("analysis_runs_import_version_idx").on(table.importId, table.parserVersion, table.modelRevision),
  index("analysis_runs_site_completed_idx").on(table.siteId, table.completedAt),
]);

export const performanceIssues = sqliteTable("performance_issues", {
  id: text("id").primaryKey(),
  fingerprint: text("fingerprint").notNull(),
  siteId: text("site_id").notNull(),
  equipmentId: text("equipment_id").notNull(),
  equipmentName: text("equipment_name").notNull(),
  equipmentExternalId: text("equipment_external_id").notNull(),
  equipmentType: text("equipment_type").notNull(),
  name: text("name").notNull(),
  issueType: text("issue_type").notNull(),
  category: text("category").notNull(),
  confidence: text("confidence").notNull(),
  severity: text("severity").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull().default("open"),
  firstDetectedAt: text("first_detected_at").notNull(),
  lastDetectedAt: text("last_detected_at").notNull(),
  occurrenceCount: integer("occurrence_count").notNull().default(0),
  latestEstimatedLossKwh: real("latest_estimated_loss_kwh"),
  latestSiteImpactPercent: real("latest_site_impact_percent").notNull().default(0),
  assignedTo: text("assigned_to"),
  resolvedAt: text("resolved_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [
  uniqueIndex("performance_issues_fingerprint_unique").on(table.fingerprint),
  index("performance_issues_site_status_idx").on(table.siteId, table.status),
  index("performance_issues_site_equipment_idx").on(table.siteId, table.equipmentId),
  index("performance_issues_site_category_idx").on(table.siteId, table.category),
]);

export const performanceIssueOccurrences = sqliteTable("performance_issue_occurrences", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull(),
  analysisRunId: text("analysis_run_id").notNull(),
  importId: text("import_id").notNull(),
  siteId: text("site_id").notNull(),
  sourceIssueId: text("source_issue_id").notNull(),
  startDateTime: text("start_date_time").notNull(),
  endDateTime: text("end_date_time").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  actualEnergyKwh: real("actual_energy_kwh").notNull(),
  expectedEnergyKwh: real("expected_energy_kwh").notNull(),
  estimatedLossKwh: real("estimated_loss_kwh"),
  lossPercent: real("loss_percent"),
  siteImpactPercent: real("site_impact_percent").notNull(),
  evidence: text("evidence").notNull().default("{}"),
  parserVersion: integer("parser_version").notNull(),
  modelRevision: text("model_revision").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [
  uniqueIndex("performance_issue_occurrence_source_unique").on(table.analysisRunId, table.sourceIssueId),
  index("performance_issue_occurrences_issue_start_idx").on(table.issueId, table.startDateTime),
  index("performance_issue_occurrences_run_idx").on(table.analysisRunId),
  index("performance_issue_occurrences_site_start_idx").on(table.siteId, table.startDateTime),
]);

export const userSettings = sqliteTable("user_settings", {
  id: text("id").primaryKey(),
  firstName: text("first_name").notNull().default(""),
  lastName: text("last_name").notNull().default(""),
  title: text("title").notNull().default(""),
  minimumIssueLossKwh: text("minimum_issue_loss_kwh").notNull().default(""),
  theme: text("theme").notNull().default("jade"),
  issueVisibility: text("issue_visibility").notNull().default("{}"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const equipmentAssets = sqliteTable("equipment_assets", {
  id: text("id").primaryKey(),
  siteId: text("site_id").notNull(),
  parentId: text("parent_id"),
  type: text("type").notNull(),
  name: text("name").notNull(),
  externalId: text("external_id").notNull(),
  manufacturer: text("manufacturer").notNull().default(""),
  model: text("model").notNull().default(""),
  capacityKw: text("capacity_kw").notNull().default(""),
  acRatedCapacityKw: text("ac_rated_capacity_kw").notNull().default(""),
  maxDcCapacityKw: text("max_dc_capacity_kw").notNull().default(""),
  moduleRatedCapacityW: text("module_rated_capacity_w").notNull().default(""),
  acLineLossPercent: text("ac_line_loss_percent").notNull().default(""),
  transformerLossPercent: text("transformer_loss_percent").notNull().default(""),
  nameplateKva: text("nameplate_kva").notNull().default(""),
  pvCeilingOverrideEnabled: integer("pv_ceiling_override_enabled", { mode: "boolean" }).notNull().default(false),
  pvCeilingOverrideKw: text("pv_ceiling_override_kw").notNull().default(""),
  notes: text("notes").notNull().default(""),
  quantity: integer("quantity").notNull().default(1),
  aliases: text("aliases").notNull().default("[]"),
  channels: text("channels").notNull().default("[]"),
  position: integer("position").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// Durable progress and per-attempt leases; telemetry and intermediate results live in R2.
export const analysisJobs = sqliteTable("analysis_jobs", {
  id: text("id").primaryKey(),
  siteId: text("site_id").notNull(),
  importId: text("import_id").notNull(),
  attemptId: text("attempt_id").notNull(),
  status: text("status").notNull().default("processing"),
  stage: text("stage").notNull().default("read"),
  completed: integer("completed").notNull().default(0),
  total: integer("total").notNull().default(0),
  percent: integer("percent").notNull().default(0),
  leaseToken: text("lease_token").notNull().default(""),
  leaseUntil: integer("lease_until").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
  error: text("error").notNull().default(""),
}, table => [index("analysis_jobs_site_attempt_idx").on(table.siteId, table.attemptId)]);

export const dataHistoryHeads = sqliteTable("data_history_heads", {
  id: text("id").primaryKey(), siteId: text("site_id").notNull(), year: integer("year").notNull(),
  revisionId: text("revision_id").notNull().default(""),
});
export const dataHistoryVersions = sqliteTable("data_history_versions", {
  id: text("id").primaryKey(), siteId: text("site_id").notNull(), importId: text("import_id").notNull(),
  year: integer("year").notNull(), parentId: text("parent_id").notNull().default(""),
  state: text("state").notNull().default("preparing"), step: integer("step").notNull().default(0),
  metadata: text("metadata").notNull(), createdAt: text("created_at").notNull(),
}, table => [index("data_history_versions_site_idx").on(table.siteId, table.createdAt)]);
export const importProfiles = sqliteTable("import_profiles", {
  id: text("id").primaryKey(), siteId: text("site_id").notNull(), name: text("name").notNull(),
  configuration: text("configuration").notNull(), updatedAt: text("updated_at").notNull(),
}, table => [index("import_profiles_site_idx").on(table.siteId)]);
export const issueEventReviews = sqliteTable("issue_event_reviews", {
  id: text("id").primaryKey(), siteId: text("site_id").notNull(), eventKey: text("event_key").notNull(),
  version: integer("version").notNull().default(0), state: text("state").notNull(), updatedAt: text("updated_at").notNull(),
}, table => [uniqueIndex("issue_event_reviews_event_idx").on(table.siteId, table.eventKey)]);
export const issueReviewChanges = sqliteTable("issue_review_changes", {
  id: text("id").primaryKey(), siteId: text("site_id").notNull(), eventKey: text("event_key").notNull(),
  runId: text("run_id").notNull(), version: integer("version").notNull(), state: text("state").notNull(),
  note: text("note").notNull(), actor: text("actor").notNull(), createdAt: text("created_at").notNull(),
}, table => [uniqueIndex("issue_review_changes_version_idx").on(table.siteId, table.eventKey, table.version), index("issue_review_changes_event_idx").on(table.siteId, table.eventKey, table.createdAt)]);

export const maintenanceWindows = sqliteTable("maintenance_windows", {
  id: text("id").primaryKey(), siteId: text("site_id").notNull(), version: integer("version").notNull(),
  startAt: text("start_at").notNull(), endAt: text("end_at").notNull(), archived: integer("archived").notNull().default(0),
  state: text("state").notNull(), updatedAt: text("updated_at").notNull(),
}, table => [index("maintenance_windows_site_dates_idx").on(table.siteId, table.archived, table.startAt, table.endAt)]);
export const maintenanceWindowChanges = sqliteTable("maintenance_window_changes", {
  id: text("id").primaryKey(), windowId: text("window_id").notNull(), siteId: text("site_id").notNull(),
  version: integer("version").notNull(), state: text("state").notNull(), actor: text("actor").notNull(), createdAt: text("created_at").notNull(),
}, table => [uniqueIndex("maintenance_window_changes_version_idx").on(table.windowId, table.version)]);

// Durable cleanup of superseded files; never delete a current import on a failed upload.
export const performanceFileCleanup = sqliteTable("performance_file_cleanup", {
  objectKey: text("object_key").primaryKey(),
  siteId: text("site_id").notNull(),
  kind: text("kind").notNull().default("file"),
  notBefore: integer("not_before").notNull().default(0),
});
