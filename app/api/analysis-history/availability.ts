import { getDatabaseBinding } from "../../../db/binding";

type Database = Pick<ReturnType<typeof getDatabaseBinding>, "prepare">;
type Pointer = { objectKey?: string; analysisRunId?: string };

/** No payload/cache may make a hidden or foreign run publicly available. */
export async function isCompletedAnalysisRun(db: Database, siteId: string, runId: string, objectKey?: string): Promise<boolean> {
  if (!siteId || !runId || (objectKey !== undefined && !objectKey)) return false;
  return !!await db.prepare(`SELECT id FROM analysis_runs WHERE site_id = ? AND id = ? AND status = 'completed'
    ${objectKey === undefined ? "" : "AND analysis_object_key = ?"}`)
    .bind(siteId, runId, ...(objectKey === undefined ? [] : [objectKey])).first();
}

/** Legacy keys must have exactly one owner, including hidden/other-import aliases. */
export async function publishedAnalysisAvailable(db: Database, siteId: string, importId: string, pointer: Pointer | null): Promise<boolean> {
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer) || typeof pointer.objectKey !== "string" || !pointer.objectKey || !siteId || !importId) return false;
  if (Object.prototype.hasOwnProperty.call(pointer, "analysisRunId")) {
    if (typeof pointer.analysisRunId !== "string" || !pointer.analysisRunId) return false;
    return !!await db.prepare(`SELECT id FROM analysis_runs WHERE site_id = ? AND import_id = ? AND id = ?
      AND analysis_object_key = ? AND status = 'completed'`).bind(siteId, importId, pointer.analysisRunId, pointer.objectKey).first();
  }
  const rows = await db.prepare("SELECT site_id, import_id, status FROM analysis_runs WHERE analysis_object_key = ? LIMIT 2")
    .bind(pointer.objectKey).all<{ site_id: string; import_id: string; status: string }>();
  return rows.results.length === 1 && rows.results[0].site_id === siteId && rows.results[0].import_id === importId && rows.results[0].status === "completed";
}
