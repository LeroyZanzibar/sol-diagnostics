import { getDatabaseBinding, getBucketBinding, type SynchronousDatabaseReader } from "../../../db/binding";
import { getPerformanceStoreManager, type PerformancePreview, type SitePerformanceStore } from "../../../db/performance-store";
import { depotCleanupInProgress } from "../../../db/depot-performance-cleanup";
import { prepareJsonImport, prepareCsvImport, observationTimePredicate, PerformanceValidationError, type IngestEquipment, type IncomingReading, type CsvSignal } from "../../performance-ingest";
import type { TimestampConvention } from "../../telemetry-time";

export class PerformanceConflictError extends Error {
  readonly status = 409;
  constructor(message: string, readonly code = "conflict") { super(message); }
}
export const performanceJson = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
export function performanceError(error: unknown) {
  const detail = error as { status?: number; statusCode?: number; code?: string; message?: string };
  const status = detail?.code === "STAGE_NOT_FOUND" ? 400 : detail?.code === "STAGE_EXPIRED" ? 409 : detail?.status || detail?.statusCode || (error instanceof SyntaxError ? 400 : 500);
  return performanceJson({ error: detail?.message || "Unable to manage site performance data.", ...(detail?.code ? { code: detail.code } : {}) }, status);
}
export function requiredText(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new PerformanceValidationError(`A valid ${label} is required.`);
  return value;
}
type LegacyImport = { id: string; siteId: string; fileName: string; objectKey: string; fileSize: number; timezone: string;
  mapping: string; validation: string; createdAt: string; timestampStart: string | null; timestampEnd: string | null };
function jsonObject(text: unknown): Record<string, unknown> {
  try { const value = JSON.parse(String(text)); if (value && typeof value === "object" && !Array.isArray(value)) return value; } catch { /* Reject below, never silently invent a mapping. */ }
  throw new PerformanceValidationError("The retained source has invalid mapping metadata. Review it before migration.");
}
function canonicalObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalObject(item)]));
  return value;
}
function performanceModelSnapshot(site: Record<string, unknown>, equipment: Record<string, unknown>[]): string {
  // Include IDs, aliases, mapping fields and settings, not merely timestamps.
  return JSON.stringify(canonicalObject({ site, equipment: [...equipment].sort((a, b) => String(a.id).localeCompare(String(b.id))) }));
}
async function hashModelSnapshot(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function performanceModelRevision(site: Record<string, unknown>, equipment: Record<string, unknown>[]): Promise<string> {
  return hashModelSnapshot(performanceModelSnapshot(site, equipment));
}
function readPerformanceConfiguration(read: SynchronousDatabaseReader, siteId: string) {
  const site = read.first("SELECT * FROM site_settings WHERE id = ?", siteId);
  if (!site) throw new PerformanceValidationError("This site is not available.");
  const configured = read.all("SELECT * FROM equipment_assets WHERE site_id = ? ORDER BY id", siteId);
  const legacyImport = read.first<LegacyImport>(`SELECT id, site_id AS siteId, file_name AS fileName, object_key AS objectKey,
    file_size AS fileSize, timezone, mapping, validation, created_at AS createdAt,
    timestamp_start AS timestampStart, timestamp_end AS timestampEnd
    FROM telemetry_imports WHERE site_id = ? AND status = 'imported' ORDER BY created_at DESC, id DESC LIMIT 1`, siteId);
  return { site, configured, legacyImport };
}
function withPerformanceConfiguration<T>(siteId: string, operation: (configuration: ReturnType<typeof readPerformanceConfiguration>) => T): T {
  const db = getDatabaseBinding();
  // Never fall back to separately awaited reads when the local guard is absent.
  if (!db.withSynchronousRead) throw new Error("A synchronous site configuration guard is required for performance ingestion.");
  return db.withSynchronousRead((read: SynchronousDatabaseReader) => operation(readPerformanceConfiguration(read, siteId)));
}
export async function loadPerformanceContext(siteId: string) {
  requiredText(siteId, "site ID");
  const { site, configured, legacyImport } = withPerformanceConfiguration(siteId, configuration => configuration);
  const equipment: IngestEquipment[] = configured.map((item: Record<string, unknown>) => {
    let aliases: string[];
    try { aliases = JSON.parse(String(item.aliases || "[]")); if (!Array.isArray(aliases) || aliases.some(value => typeof value !== "string")) throw new Error(); }
    catch { throw new PerformanceValidationError("This site's equipment aliases are invalid. Review the array model."); }
    return { id: String(item.id), type: String(item.type || ""), name: String(item.name || ""), externalId: String(item.external_id || ""), aliases };
  });
  const modelSnapshot = performanceModelSnapshot(site, configured);
  const modelRevision = await hashModelSnapshot(modelSnapshot);
  const store = getPerformanceStoreManager().site(siteId), dataset = store.describe();
  return { siteId, site, equipment, modelSnapshot, modelRevision, store, dataset, legacyImport, requiresMigration: !!legacyImport && dataset.revision === 0 };
}
export type PerformanceContext = Awaited<ReturnType<typeof loadPerformanceContext>>;
export async function assertPerformanceWritable(context: PerformanceContext, migration = false) {
  if (await depotCleanupInProgress(getDatabaseBinding(), context.siteId)) throw new PerformanceConflictError("Depot performance data is being removed. Retry the upload after cleanup completes.", "maintenance");
  if (context.requiresMigration && !migration) throw new PerformanceConflictError("Migrate the retained CSV first, before uploading unrelated new readings.", "migration-required");
}
function existingCadence(context: PerformanceContext) {
  // A snow-only dataset may have no interval observations; do not anchor its
  // subsequent interval grid to the earliest snow event.
  const isObservation = observationTimePredicate(context.equipment);
  let gridTimestamp: string | undefined;
  if (context.dataset.revision) for (const reading of context.store.rows(context.dataset.revision)) {
    if (!isObservation(reading)) { gridTimestamp = reading.timestamp; break; }
  }
  return { knownIntervalMinutes: context.dataset.revision ? context.dataset.intervalMinutes : undefined, gridTimestamp };
}
async function verifyPreviewContext(context: PerformanceContext, preview: PerformancePreview) {
  const fresh = await loadPerformanceContext(context.siteId);
  if (preview.baseRevision !== context.dataset.revision || fresh.modelRevision !== context.modelRevision || fresh.dataset.revision !== preview.baseRevision) {
    context.store.cancel(preview.stageId);
    throw new PerformanceConflictError("The site model or saved data changed while validating. Create a fresh preview.", "stale-preview");
  }
  return preview;
}
export async function previewPerformanceJson(payload: Record<string, unknown>) {
  const siteId = requiredText(payload.siteId, "site ID"), context = await loadPerformanceContext(siteId);
  await assertPerformanceWritable(context);
  const timezone = requiredText(payload.timezone, "source timezone");
  const prepared = prepareJsonImport({ equipment: context.equipment, timezone, timestampConvention: payload.timestampConvention as TimestampConvention,
    intervalMinutes: payload.intervalMinutes as number | undefined, ...existingCadence(context), readings: payload.readings as IncomingReading[] });
  const fileName = payload.fileName === undefined ? "API readings" : requiredText(payload.fileName, "file name");
  const preview = await context.store.stage({ source: "api", fileName, timezone, intervalMinutes: prepared.intervalMinutes,
    sourceTimestampConvention: payload.timestampConvention as TimestampConvention, modelRevision: context.modelRevision }, prepared.readings, { expectedRevision: context.dataset.revision });
  return verifyPreviewContext(context, preview);
}
export type CsvPreviewInput = { siteId: string; fileName: string; timezone: string; mapping: Record<string, string>;
  equipmentMapping: { signals?: CsvSignal[] }; validation?: Record<string, unknown>; intervalMinutes?: number; timestampConvention?: TimestampConvention };
export async function previewPerformanceCsv(context: PerformanceContext, input: CsvPreviewInput, objectKey: string, source: "csv" | "migration" = "csv", sourceImportId?: string) {
  await assertPerformanceWritable(context, source === "migration");
  const convention = input.timestampConvention ?? input.validation?.timestampConvention ?? "start";
  const open = async () => {
    const object = await getBucketBinding().get(objectKey);
    if (!object) throw new PerformanceValidationError("The retained CSV source is unavailable.");
    return object.body;
  };
  const prepared = await prepareCsvImport(open, { equipment: context.equipment, timezone: input.timezone, timestampConvention: convention as TimestampConvention,
    mapping: input.mapping, signals: input.equipmentMapping.signals || [], intervalMinutes: input.intervalMinutes, ...existingCadence(context) });
  const fresh = await loadPerformanceContext(context.siteId);
  if (fresh.modelRevision !== context.modelRevision || fresh.dataset.revision !== context.dataset.revision) throw new PerformanceConflictError("The model or saved data changed while parsing. Create a fresh preview.", "stale-preview");
  const preview = await context.store.stage({ source, fileName: input.fileName, timezone: input.timezone, intervalMinutes: prepared.intervalMinutes,
    modelRevision: context.modelRevision, sourceTimestampConvention: convention as TimestampConvention, originalObjectKey: objectKey,
    ...(sourceImportId ? { sourceImportId } : {}) }, prepared.readings, { expectedRevision: context.dataset.revision });
  return verifyPreviewContext(context, preview);
}
const migrationPreviews = new WeakMap<SitePerformanceStore, Map<string, string>>();
const migrationInFlight = new WeakMap<SitePerformanceStore, Map<string, Promise<PerformancePreview>>>();
export async function previewLegacyPerformance(siteId: string) {
  const context = await loadPerformanceContext(siteId);
  await assertPerformanceWritable(context, true);
  const legacy = context.legacyImport;
  if (!legacy) throw new PerformanceValidationError("No retained legacy CSV is available for this site.");
  const committed = context.store.imports().find(item => item.metadata.source === "migration" && item.metadata.sourceImportId === legacy.id);
  if (committed) return context.store.preview(committed.stageId);
  if (context.dataset.revision) throw new PerformanceConflictError("This site already has a canonical dataset. Legacy migration is only available before new imports.", "migration-complete");
  let cached = migrationPreviews.get(context.store);
  if (!cached) { cached = new Map(); migrationPreviews.set(context.store, cached); }
  const key = JSON.stringify([legacy.id, legacy.objectKey, context.modelRevision, context.dataset.revision]), previousId = cached.get(key);
  if (previousId) {
    try { const previous = context.store.preview(previousId); if (previous.status === "preview" && Date.parse(previous.expiresAt) > Date.now()) return previous; } catch { /* Expired stage: parse the unchanged source again. */ }
    cached.delete(key);
  }
  let inFlight = migrationInFlight.get(context.store);
  if (!inFlight) { inFlight = new Map(); migrationInFlight.set(context.store, inFlight); }
  const running = inFlight.get(key);
  if (running) return running;
  const mapping = jsonObject(legacy.mapping), validation = jsonObject(legacy.validation);
  if (!mapping.roles || !mapping.equipment) throw new PerformanceValidationError("The retained source needs its original column and equipment mapping before migration.");
  const pending = previewPerformanceCsv(context, { siteId, fileName: legacy.fileName, timezone: legacy.timezone,
    mapping: mapping.roles as Record<string, string>, equipmentMapping: mapping.equipment as CsvPreviewInput["equipmentMapping"], validation,
    ...(typeof validation.intervalMinutes === "number" && validation.intervalMinutes > 0 ? { intervalMinutes: validation.intervalMinutes } : {}) }, legacy.objectKey, "migration", legacy.id);
  inFlight.set(key, pending);
  try {
    const preview = await pending;
    if (cached.size >= 20) cached.clear();
    cached.set(key, preview.stageId);
    return preview;
  } finally { inFlight.delete(key); }
}
export async function commitPerformancePreview(payload: Record<string, unknown>, actor: string) {
  const siteId = requiredText(payload.siteId, "site ID"), stageId = requiredText(payload.stageId, "stage ID"), previewToken = requiredText(payload.previewToken, "preview token", 512);
  if (typeof payload.approveOverlap !== "boolean") throw new PerformanceValidationError("approveOverlap must explicitly be true or false.");
  requiredText(actor, "authenticated actor");
  const context = await loadPerformanceContext(siteId), preview = context.store.preview(stageId);
  await assertPerformanceWritable(context, preview.metadata.source === "migration");
  // Hash outside the shared DB guard, then compare its EXACT input against a
  // consistent live snapshot inside the guard. No await is allowed from that
  // comparison through the site's synchronous canonical commit. Model/settings
  // writers share the DB lock; the per-site store still owns its own transaction.
  const fresh = await loadPerformanceContext(siteId);
  const approveOverlap = payload.approveOverlap;
  return withPerformanceConfiguration(siteId, live => {
    const current = fresh.store.preview(stageId);
    if (current.status !== "committed") {
      if (performanceModelSnapshot(live.site, live.configured) !== fresh.modelSnapshot) throw new PerformanceConflictError("The site model changed while validating approval. Create a fresh preview.", "stale-preview");
      if (live.legacyImport && fresh.store.describe().revision === 0 && current.metadata.source !== "migration") throw new PerformanceConflictError("Migrate the retained CSV before committing new readings.", "migration-required");
      if (current.metadata.source === "migration" &&
          (live.legacyImport?.id !== current.metadata.sourceImportId || live.legacyImport?.objectKey !== current.metadata.originalObjectKey)) {
        throw new PerformanceConflictError("The retained CSV changed after this migration preview. Create a fresh preview.", "stale-preview");
      }
    }
    const result = fresh.store.commit(stageId, { previewToken, approveOverlap, actor, modelRevision: fresh.modelRevision });
    return { committed: true, result, dataset: fresh.store.describe() };
  });
}
