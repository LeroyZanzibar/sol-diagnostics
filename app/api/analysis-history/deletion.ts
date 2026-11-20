import { getDatabaseBinding, type SynchronousDatabaseWriter } from "../../../db/binding";

export class AnalysisDeletionError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
const conflict = () => new AnalysisDeletionError("ANALYSIS_POINTER_CONFLICT", "The published analysis cannot be attributed safely. Refresh or publish a new analysis before deleting this run.", 409);
const inUse = () => new AnalysisDeletionError("ANALYSIS_IN_USE", "This analysis still has active, resumable, or inconsistent work. Finish or cancel that attempt before deleting it.", 409);
export function validAnalysisId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
type Run = { id: string; site_id: string; import_id: string; status: string; analysis_object_key: string };
type Publication = { site_id: string; import_id: string; summary: string };
type Job = { id: string; site_id: string; import_id: string; attempt_id: string; status: string; stage: string; lease_until: number };

function publicationOwner(tx: SynchronousDatabaseWriter, row: Publication): Run {
  let pointer: { objectKey?: string; analysisRunId?: string };
  try { pointer = JSON.parse(row.summary); } catch { throw conflict(); }
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer) || typeof pointer.objectKey !== "string" || !pointer.objectKey) throw conflict();
  let owner: Run | null;
  if (Object.prototype.hasOwnProperty.call(pointer, "analysisRunId")) {
    if (typeof pointer.analysisRunId !== "string" || !pointer.analysisRunId) throw conflict();
    owner = tx.first<Run>("SELECT id,site_id,import_id,status,analysis_object_key FROM analysis_runs WHERE id = ?", pointer.analysisRunId);
  } else {
    // Do not let hiding a run make an overwritten/shared legacy key appear unique.
    const aliases = tx.all<Run>("SELECT id,site_id,import_id,status,analysis_object_key FROM analysis_runs WHERE analysis_object_key = ? LIMIT 2", pointer.objectKey);
    if (aliases.length !== 1) throw conflict();
    owner = aliases[0];
  }
  if (!owner || owner.status !== "completed" || owner.site_id !== row.site_id || owner.import_id !== row.import_id || owner.analysis_object_key !== pointer.objectKey) throw conflict();
  return owner;
}

/** Application-level removal only: retain object bytes and internal review baselines. */
export async function deleteSavedAnalysis(siteId: string, runId: string) {
  if (!validAnalysisId(siteId) || !validAnalysisId(runId)) throw new AnalysisDeletionError("INVALID_ANALYSIS_ID", "Choose a valid site and saved analysis.", 400);
  const db = getDatabaseBinding();
  if (!db.withSynchronousWrite) throw new Error("Atomic analysis deletion is unavailable.");
  const receipt = db.withSynchronousWrite((tx:SynchronousDatabaseWriter) => {
    const run = tx.first<Run>("SELECT id,site_id,import_id,status,analysis_object_key FROM analysis_runs WHERE id = ? AND site_id = ?", runId, siteId);
    if (!run) throw new AnalysisDeletionError("ANALYSIS_NOT_FOUND", "Saved analysis not found.", 404);
    if (run.status === "deleted") return { repeated: true, pointers: [] as Publication[] };
    if (run.status !== "completed") throw new AnalysisDeletionError("ANALYSIS_NOT_COMPLETED", "Only completed analyses can be deleted.", 409);
    const jobs = tx.all<Job>("SELECT id,site_id,import_id,attempt_id,status,stage,lease_until FROM analysis_jobs WHERE attempt_id = ?", runId);
    const now = Date.now();
    for (const job of jobs) {
      const terminal = ["completed", "canceled", "failed", "interrupted"].includes(job.status);
      const resumable = ["failed", "interrupted"].includes(job.status) && ["equipment", "reconcile", "save", "finalize"].includes(job.stage);
      if (job.site_id !== siteId || job.import_id !== run.import_id || !terminal || resumable || !Number.isFinite(job.lease_until) || job.lease_until < 0 || job.lease_until >= now ||
          !["read", "equipment", "reconcile", "save", "finalize", "complete"].includes(job.stage) || (job.status === "completed" && job.stage !== "complete")) throw inUse();
    }
    if (tx.first(`SELECT o.id FROM performance_issue_occurrences o LEFT JOIN performance_issues i ON i.id=o.issue_id
      WHERE o.analysis_run_id = ? AND (o.site_id <> ? OR o.import_id <> ? OR i.id IS NULL OR i.site_id <> ?) LIMIT 1`, runId, siteId, run.import_id, siteId)) throw inUse();
    const affected = tx.all<{ issue_id: string }>("SELECT DISTINCT issue_id FROM performance_issue_occurrences WHERE analysis_run_id = ? AND site_id = ?", runId, siteId);
    for (const { issue_id } of affected) if (tx.first("SELECT id FROM performance_issue_occurrences WHERE issue_id = ? AND site_id <> ? LIMIT 1", issue_id, siteId)) throw inUse();

    // Validate site pointers and any foreign pointer claiming this import/run/key.
    // JSON functions are gated for malformed legacy rows; never parse result bytes.
    const publications = tx.all<Publication>(`SELECT site_id,import_id,summary FROM performance_summaries
      WHERE site_id = ? OR import_id = ? OR CASE WHEN json_valid(summary) THEN
        json_extract(summary,'$.analysisRunId') = ? OR json_extract(summary,'$.objectKey') = ? ELSE 0 END`, siteId, run.import_id, runId, run.analysis_object_key);
    const pointers = publications.filter(row => publicationOwner(tx, row).id === runId);
    if (pointers.length && publications.filter(row => row.site_id === siteId).length !== 1) throw conflict();
    for (const pointer of pointers) {
      if (tx.run("DELETE FROM performance_summaries WHERE site_id = ? AND import_id = ? AND summary = ?", pointer.site_id, pointer.import_id, pointer.summary).changes !== 1) throw conflict();
    }
    tx.run("DELETE FROM performance_issue_occurrences WHERE site_id = ? AND analysis_run_id = ?", siteId, runId);
    for (const { issue_id } of affected) {
      tx.run(`UPDATE performance_issues SET
        first_detected_at = COALESCE((SELECT MIN(start_date_time) FROM performance_issue_occurrences WHERE issue_id = ?), first_detected_at),
        last_detected_at = COALESCE((SELECT MAX(end_date_time) FROM performance_issue_occurrences WHERE issue_id = ?), last_detected_at),
        occurrence_count = (SELECT COUNT(*) FROM performance_issue_occurrences WHERE issue_id = ?),
        latest_estimated_loss_kwh = (SELECT estimated_loss_kwh FROM performance_issue_occurrences WHERE issue_id = ? ORDER BY end_date_time DESC,updated_at DESC,id DESC LIMIT 1),
        latest_site_impact_percent = COALESCE((SELECT site_impact_percent FROM performance_issue_occurrences WHERE issue_id = ? ORDER BY end_date_time DESC,updated_at DESC,id DESC LIMIT 1), 0)
        WHERE id = ? AND site_id = ?`, issue_id, issue_id, issue_id, issue_id, issue_id, issue_id, siteId);
    }
    for (const job of jobs) {
      if (tx.run("DELETE FROM analysis_jobs WHERE id = ? AND site_id = ? AND attempt_id = ?", job.id, siteId, runId).changes !== 1) throw inUse();
    }
    if (tx.run("UPDATE analysis_runs SET status = 'deleted' WHERE id = ? AND site_id = ? AND status = 'completed'", runId, siteId).changes !== 1) throw conflict();
    if (!tx.first("SELECT id FROM analysis_runs WHERE id = ? AND site_id = ? AND status = 'deleted'", runId, siteId) ||
        tx.first("SELECT id FROM performance_issue_occurrences WHERE analysis_run_id = ? LIMIT 1", runId) ||
        tx.first("SELECT id FROM analysis_jobs WHERE attempt_id = ? LIMIT 1", runId)) throw new Error("Analysis deletion verification failed.");
    for (const pointer of pointers) if (tx.first("SELECT import_id FROM performance_summaries WHERE site_id = ? AND import_id = ? AND summary = ?", pointer.site_id, pointer.import_id, pointer.summary)) throw conflict();
    return { repeated: false, pointers };
  });
  // Read the committed exact target, not an inferred newest/history selection.
  const hidden = await db.prepare("SELECT id FROM analysis_runs WHERE id = ? AND site_id = ? AND status = 'deleted'").bind(runId, siteId).first();
  if (!hidden) throw new Error("Analysis deletion could not be verified.");
  if (!receipt.repeated) {
    const occurrences = await db.prepare("SELECT id FROM performance_issue_occurrences WHERE analysis_run_id = ? LIMIT 1").bind(runId).first();
    const job = await db.prepare("SELECT id FROM analysis_jobs WHERE attempt_id = ? LIMIT 1").bind(runId).first();
    if (occurrences || job) throw new Error("Analysis deletion could not be verified.");
    for (const pointer of receipt.pointers) {
      if (await db.prepare("SELECT import_id FROM performance_summaries WHERE site_id = ? AND import_id = ? AND summary = ?").bind(pointer.site_id, pointer.import_id, pointer.summary).first()) throw new Error("Analysis pointer removal could not be verified.");
    }
  }
  return { deleted: true, siteId, runId, currentCleared: receipt.pointers.length > 0 };
}
