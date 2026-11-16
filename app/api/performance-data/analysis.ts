import { getPerformanceStoreManager, optionalPerformanceStoreManager, type PerformanceAnalysisProvenance, type PerformanceInputScope, type PerformanceReading } from "../../../db/performance-store";
import type { telemetryImports } from "../../../db/schema";
import { localDate } from "../../telemetry-time";

type InputRecord = typeof telemetryImports.$inferSelect;
type Asset = { id: string; type: string; name: string };
const measurements = ["Active power", "Energy", "Expected Production", "Irradiance", "POA irradiance", "GHI irradiance"];
const snowMeasurements = ["Other", "Snow code", "Status"];
const snowIds = (equipment: Asset[]) => equipment.filter(a => a.type === "weather_sensor" && a.name.trim().toLowerCase() === "snow sensor").map(a => a.id).sort();
// Storage may canonicalize object key order; compare contract values, not JSON
// property insertion order, when verifying a retained checkpoint.
const provenanceIdentity = (p: PerformanceAnalysisProvenance) => JSON.stringify([p.version,p.siteId,p.revision,p.revisionId,p.dependencyScope,
  p.scopes.map(scope=>[scope.start,scope.end,scope.equipmentIds,scope.measurements]),p.hashes]);

/** A revision ID, not an upload ID, is the cache/job identity after migration. */
export function performanceAnalysisInput(siteId: string, revision?: number): InputRecord | undefined {
  const store = optionalPerformanceStoreManager()?.site(siteId);
  if (!store) return undefined;
  const dataset = store.describe(revision);
  if (!dataset.revision) return undefined;
  return {
    id: dataset.revisionId, siteId, fileName: `Site performance data · revision ${dataset.revision}`,
    objectKey: "", fileSize: 0, rowCount: dataset.readingCount, validRows: dataset.readingCount,
    warningCount: 0, errorCount: 0, status: "imported", timezone: dataset.timezone,
    timestampStart: dataset.timestampStart, timestampEnd: dataset.timestampEnd, createdAt: dataset.updatedAt,
    mapping: JSON.stringify({ roles: { timestamp: "Timestamp", equipment: "Equipment", measurement: "Measurement", value: "Value", unit: "Unit", expectedProduction: "Expected Production" }, equipment: { signals: [] } }),
    detectedTypes: "{}", validation: JSON.stringify({ performanceStore: true, datasetRevision: dataset.revision, revisionId: dataset.revisionId, intervalMinutes: dataset.intervalMinutes, timestampConvention: "start" }),
  };
}

export function analysisInputRevision(record: Pick<InputRecord, "validation">): number | null {
  let metadata;
  try { metadata = JSON.parse(record.validation || "{}"); } catch { return null; }
  if (!metadata?.performanceStore) return null;
  if (!Number.isSafeInteger(metadata.datasetRevision) || metadata.datasetRevision < 1) throw new Error("Invalid saved performance dataset revision.");
  return metadata.datasetRevision;
}

function inputScopes(record: InputRecord, equipment: Asset[]): PerformanceInputScope[] {
  if (!record.timestampStart || !record.timestampEnd) throw new Error("The saved performance dataset has no input range.");
  const snow = snowIds(equipment), excluded = new Set(snow);
  const range = { start: record.timestampStart, end: record.timestampEnd };
  return [
    { ...range, equipmentIds: [...new Set(["@site", ...equipment.filter(a => !excluded.has(a.id)).map(a => a.id)])].sort(), measurements: [...measurements] },
    ...(snow.length ? [{ ...range, equipmentIds: snow, measurements: [...snowMeasurements] }] : []),
  ];
}
function consumes(row: PerformanceReading, scope: PerformanceInputScope) {
  return row.timestamp >= scope.start && row.timestamp <= scope.end && scope.equipmentIds!.includes(row.channel.equipmentId) && scope.measurements!.includes(row.channel.measurement);
}

/** Bounded pull adapter. The store already holds canonical units and UTC starts;
 * snow readings retain observation instants. No shift/conversion happens here. */
export function canonicalAnalysisCsv(record: InputRecord, equipment: Asset[]): ReadableStream<Uint8Array> {
  const revision = analysisInputRevision(record);
  if (revision === null) throw new Error("A canonical performance dataset revision is required.");
  const store = getPerformanceStoreManager().site(record.siteId);
  if (store.describe(revision).revisionId !== record.id) throw new Error("The saved performance dataset revision does not match this analysis.");
  const scopes = inputScopes(record, equipment), iterator = store.rows(revision), encoder = new TextEncoder();
  const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  let header = true;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      let chunk = header ? "Timestamp,Equipment,Measurement,Value,Unit,Expected Production\n" : "";
      header = false;
      try {
        // Bound both produced bytes and database work per pull, including skipped channels.
        for (let count = 0; count < 256; count++) {
          const next = iterator.next();
          if (next.done) { if (chunk) controller.enqueue(encoder.encode(chunk)); controller.close(); return; }
          const row = next.value;
          if (!scopes.some(scope => consumes(row, scope))) continue;
          const expected = row.channel.equipmentId === "@site" && row.channel.measurement === "Expected Production";
          chunk += [row.timestamp, row.channel.equipmentId, row.channel.measurement, expected ? "" : row.value, row.channel.unit, expected ? row.value : ""].map(escape).join(",") + "\n";
        }
        controller.enqueue(encoder.encode(chunk));
      } catch (error) { iterator.return?.(); controller.error(error); }
    },
    cancel() { iterator.return?.(); },
  });
}

/** Inclusive UTC bounds of a reporting-local day. Search instants rather than
 * assuming 24 hours or parsing midnight, which may be missing or repeated. */
function localDayEdge(moment: number, timezone: string, edge: "start" | "end"): string {
  const day = localDate(new Date(moment).toISOString(), timezone);
  if (!day) throw new Error("The saved reporting timezone or input range is invalid.");
  const margin = 48 * 3600000;
  let low = edge === "start" ? moment - margin : moment;
  let high = edge === "start" ? moment : moment + margin;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    const date = localDate(new Date(mid).toISOString(), timezone);
    if (edge === "start" ? date < day : date <= day) low = mid;
    else high = mid;
  }
  return new Date(edge === "start" ? high : high - 1).toISOString();
}

/** Fixed at the read checkpoint and immutable for the attempt, including retries. */
export function captureAnalysisProvenance(runId: string, record: InputRecord, equipment: Asset[]): PerformanceAnalysisProvenance | null {
  const revision = analysisInputRevision(record);
  if (revision === null) return null;
  const store = getPerformanceStoreManager().site(record.siteId), existing = store.analysis(runId);
  if (existing) {
    if (existing.siteId !== record.siteId || existing.revision !== revision || existing.revisionId !== record.id) throw new Error("This analysis attempt already belongs to another dataset revision.");
    return existing;
  }
  const dataset = store.describe(revision);
  if (dataset.revisionId !== record.id) throw new Error("The analysis input revision is unavailable.");
  const scopes = inputScopes(record, equipment), [intervals, snow] = scopes;
  // Only interval inputs establish the analysis domain. Asynchronous snow or
  // unrelated channels must not stretch baseline/peer/site dependency ranges.
  let start: string | null = null, end: string | null = null;
  for (const row of store.rows(revision, intervals)) {
    if (start === null || row.timestamp < start) start = row.timestamp;
    if (end === null || row.timestamp > end) end = row.timestamp;
  }
  if (start === null || end === null) throw new Error("The saved performance dataset has no configured analysis inputs.");
  intervals.start = start; intervals.end = end;
  if (snow) {
    // A code anywhere on a covered local date can classify/split findings.
    // Expand only snow dependencies, including a final interval that crosses
    // midnight; an interval ending exactly at midnight excludes the next day.
    snow.start = localDayEdge(Date.parse(start), record.timezone, "start");
    snow.end = localDayEdge(Date.parse(end) + dataset.intervalMinutes * 60000 - 1, record.timezone, "end");
  }
  const provenance: PerformanceAnalysisProvenance = { version: 1, siteId: record.siteId, revision, revisionId: record.id,
    scopes, hashes: scopes.map(scope => store.fingerprint(revision, scope)), dependencyScope: "analysis-range" };
  store.recordAnalysis(runId, provenance);
  const saved = store.analysis(runId);
  if (!saved || provenanceIdentity(saved) !== provenanceIdentity(provenance)) throw new Error("Analysis input provenance was not retained.");
  return saved;
}

export function resumeAnalysisProvenance(runId: string, record: InputRecord, checkpoint?: PerformanceAnalysisProvenance | null): PerformanceAnalysisProvenance | null {
  const revision = analysisInputRevision(record);
  if (revision === null) return null;
  const saved = getPerformanceStoreManager().site(record.siteId).analysis(runId);
  if (!saved || !checkpoint || saved.revision !== revision || saved.revisionId !== record.id || saved.siteId !== record.siteId || provenanceIdentity(saved) !== provenanceIdentity(checkpoint))
    throw new Error("The immutable analysis input checkpoint is unavailable or inconsistent.");
  return saved;
}

export function savedAnalysisProvenance(siteId: string, runId: string): PerformanceAnalysisProvenance | null {
  try { return optionalPerformanceStoreManager()?.site(siteId).analysis(runId) || null; }
  catch { return null; }
}

export type AnalysisFreshness = {
  runId: string; status: "current" | "older" | "unknown"; assessedAt: string;
  comparedRevision: number | null; reasons: string[]; dependencyScope: "analysis-range";
};
export function assessAnalysisFreshness(siteId: string, runId: string, provenance = savedAnalysisProvenance(siteId, runId), hashes = new Map<string, string>()): AnalysisFreshness {
  const result: AnalysisFreshness = { runId, status: "unknown", assessedAt: new Date().toISOString(), comparedRevision: null,
    reasons: [], dependencyScope: "analysis-range" };
  try {
    const store = optionalPerformanceStoreManager()?.site(siteId);
    if (!store) { result.reasons = ["The site performance database is unavailable."]; return result; }
    const current = store.describe();
    result.comparedRevision = current.revision || null;
    if (!current.revision) { result.reasons = ["The site has not migrated to revisioned performance data."]; return result; }
    if (!provenance || provenance.version !== 1 || provenance.siteId !== siteId || !Number.isSafeInteger(provenance.revision) || provenance.revision < 1 || !provenance.revisionId || provenance.dependencyScope !== "analysis-range" || !provenance.scopes?.length || provenance.hashes?.length !== provenance.scopes.length ||
        provenance.scopes.some(scope => !scope.start || !scope.end || scope.start > scope.end || !scope.equipmentIds?.length || !scope.measurements?.length) || provenance.hashes.some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
      result.reasons = ["This saved analysis has no usable immutable input provenance."]; return result;
    }
    const changed = provenance.scopes.some((scope, index) => {
      const key = JSON.stringify([siteId, current.revision, scope]);
      let hash = hashes.get(key);
      if (hash === undefined) { hash = store.fingerprint(current.revision, scope); hashes.set(key, hash); }
      return hash !== provenance.hashes[index];
    });
    result.status = changed ? "older" : "current";
    result.reasons = [changed ? "Consumed inputs changed within the saved analysis range, including baseline, peer, site and configured snow dependencies. This assessment applies to the whole analysis, not individual event windows."
      : "Consumed inputs are unchanged within the saved analysis range. New revisions or data outside that fixed input domain do not make this analysis older."];
  } catch { result.status = "unknown"; result.reasons = ["The saved input dependencies could not be compared with the current site data."]; }
  return result;
}

/** Single-server synchronous guard only; this is not a cross-database transaction. */
export function analysisRevisionIsCurrent(provenance: PerformanceAnalysisProvenance): boolean {
  try {
    const current = getPerformanceStoreManager().site(provenance.siteId).describe();
    return current.revision === provenance.revision && current.revisionId === provenance.revisionId;
  } catch { return false; }
}
export function legacyAnalysisInputIsCurrent(siteId: string, importId: string, latestImportId?: string): boolean {
  try { return importId === latestImportId && !optionalPerformanceStoreManager()?.site(siteId).describe().revision; }
  catch { return false; }
}
