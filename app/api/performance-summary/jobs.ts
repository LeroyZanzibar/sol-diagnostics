import { depotCleanupInProgress } from "../../../db/depot-performance-cleanup";
import { analysisFailureMessage } from "./database-errors";

export type AnalysisStage = "read" | "equipment" | "reconcile" | "save" | "finalize" | "complete";
export type AnalysisJob = {
  id: string; site_id: string; import_id: string; attempt_id: string;
  status: "processing" | "canceling" | "canceled" | "failed" | "interrupted" | "completed";
  stage: AnalysisStage; completed: number; total: number; percent: number;
  lease_token: string; lease_until: number; updated_at: number; error: string;
};
type JobStatement = {
  bind(...values: unknown[]): JobStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
};
export type JobDatabase = { prepare(sql: string): JobStatement; batch(statements: JobStatement[]): Promise<unknown> };
export const LEASE_MS = 60_000;
const stages: Record<AnalysisStage, [number, number, string]> = {
  read: [0, 25, "Reading telemetry"], equipment: [25, 40, "Analyzing equipment"],
  reconcile: [65, 10, "Reconciling findings"], save: [75, 20, "Saving issue records"],
  finalize: [95, 4, "Finalizing saved analysis"], complete: [100, 0, "Complete"],
};
export function jobProgress(job: AnalysisJob) {
  return { attemptId: job.attempt_id, status: job.status, stage: job.stage,
    label: stages[job.stage][2], completed: job.completed, total: job.total,
    percent: job.percent, updatedAt: job.updated_at, error: job.error };
}
export async function analysisJobKey(importId: string, parserVersion: number, revision: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${importId}|${parserVersion}|${revision}`));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function readJob(db: JobDatabase, id: string) {
  // A dead request cannot retain a lock indefinitely. No elapsed-time percentage is used.
  await db.prepare(`UPDATE analysis_jobs SET
    status = CASE WHEN status = 'canceling' THEN 'canceled' ELSE 'interrupted' END,
    error = CASE WHEN status = 'canceling' THEN '' ELSE 'Analysis was interrupted. Retry using the retained upload.' END,
    lease_token = '', lease_until = 0, updated_at = ?
    WHERE id = ? AND status IN ('processing', 'canceling') AND lease_token <> '' AND lease_until < ?`)
    .bind(Date.now(), id, Date.now()).run();
  const job = await db.prepare("SELECT * FROM analysis_jobs WHERE id = ?").bind(id).first<AnalysisJob>();
  if (job && ["canceled", "failed", "interrupted"].includes(job.status)) {
    await db.prepare("UPDATE analysis_runs SET status = ?, completed_at = ? WHERE id = ? AND status = 'processing'")
      .bind(job.status, new Date().toISOString(), job.attempt_id).run();
  }
  return job;
}
export async function getOrCreateJob(db: JobDatabase, id: string, siteId: string, importId: string) {
  await db.prepare(`INSERT INTO analysis_jobs (id, site_id, import_id, attempt_id, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
    .bind(id, siteId, importId, crypto.randomUUID(), Date.now()).run();
  return (await readJob(db, id))!;
}
export async function claimJob(db: JobDatabase, job: AnalysisJob) {
  if (await depotCleanupInProgress(db,job.site_id)) return null;
  const token = crypto.randomUUID();
  const result = await db.prepare(`UPDATE analysis_jobs SET lease_token = ?, lease_until = ?, updated_at = ?
    WHERE id = ? AND attempt_id = ? AND status = 'processing' AND lease_token = ''`)
    .bind(token, Date.now() + LEASE_MS, Date.now(), job.id, job.attempt_id).run();
  return result.meta.changes === 1 ? token : null;
}
export class AnalysisStopped extends Error {}
export async function reportProgress(db: JobDatabase, job: AnalysisJob, token: string,
  stage: AnalysisStage, completed = 0, total = 0, release = false) {
  const [base, weight] = stages[stage];
  const percent = base + Math.floor(weight * (total > 0 ? Math.min(1, completed / total) : 0));
  const result = await db.prepare(`UPDATE analysis_jobs SET stage = ?, completed = ?, total = ?, percent = ?,
    updated_at = ?, lease_token = ?, lease_until = ?
    WHERE id = ? AND attempt_id = ? AND lease_token = ? AND status = 'processing' AND lease_until >= ?`)
    .bind(stage, completed, total, percent, Date.now(), release ? "" : token,
      release ? 0 : Date.now() + LEASE_MS, job.id, job.attempt_id, token, Date.now()).run();
  if (result.meta.changes !== 1) throw new AnalysisStopped("Analysis stopped or its lease expired.");
}
export async function stopJob(db: JobDatabase, job: AnalysisJob, token: string, error: unknown) {
  await db.prepare(`UPDATE analysis_jobs SET status = CASE WHEN status = 'canceling' THEN 'canceled' ELSE 'failed' END,
    error = CASE WHEN status = 'canceling' THEN '' ELSE ? END, lease_token = '', lease_until = 0, updated_at = ?
    WHERE id = ? AND attempt_id = ? AND lease_token = ? AND status IN ('processing', 'canceling')`)
    .bind(error instanceof AnalysisStopped ? 'Analysis was interrupted. Retry using the retained upload.' :
      analysisFailureMessage(error), Date.now(), job.id, job.attempt_id, token).run();
}
export async function controlJob(db: JobDatabase, siteId: string, attemptId: string, action: "cancel" | "retry") {
  const row = await db.prepare("SELECT * FROM analysis_jobs WHERE site_id = ? AND attempt_id = ?")
    .bind(siteId, attemptId).first<AnalysisJob>();
  if (!row) return null;
  const current = await readJob(db, row.id);
  if (action === "cancel") {
    await db.prepare(`UPDATE analysis_jobs SET status = CASE WHEN lease_token = '' THEN 'canceled' ELSE 'canceling' END,
      updated_at = ? WHERE id = ? AND attempt_id = ? AND status = 'processing'`)
      .bind(Date.now(), row.id, attemptId).run();
  } else if (current && ["failed", "interrupted"].includes(current.status) && ["equipment", "reconcile", "save", "finalize"].includes(current.stage)) {
    // Reuse the retained analysis snapshot and deterministic occurrence IDs.
    // Clearing the old lease still fences off any abandoned request.
    await db.prepare(`UPDATE analysis_jobs SET status = 'processing', error = '',
      lease_token = '', lease_until = 0, updated_at = ?
      WHERE id = ? AND attempt_id = ? AND status IN ('failed', 'interrupted')
        AND stage IN ('equipment', 'reconcile', 'save', 'finalize')`)
      .bind(Date.now(), row.id, attemptId).run();
  } else {
    await db.prepare(`UPDATE analysis_jobs SET attempt_id = ?, status = 'processing', stage = 'read',
      completed = 0, total = 0, percent = 0, error = '', lease_token = '', lease_until = 0, updated_at = ?
      WHERE id = ? AND attempt_id = ? AND status IN ('canceled', 'failed', 'interrupted')`)
      .bind(crypto.randomUUID(), Date.now(), row.id, attemptId).run();
  }
  return readJob(db, row.id);
}

// The pointer is published atomically with completion. A cancellation that wins
// this race prevents every statement, leaving the private R2 object unreferenced.
export async function publishJob(db: JobDatabase, job: AnalysisJob, token: string,
  pointer: string, objectKey: string, issueCount: number) {
  const guard = `EXISTS (SELECT 1 FROM analysis_jobs WHERE id = ? AND attempt_id = ?
    AND lease_token = ? AND status = 'processing' AND lease_until >= ?)`;
  const committedAt = Date.now();
  const params = () => [job.id, job.attempt_id, token, committedAt];
  await db.batch([
    db.prepare(`DELETE FROM performance_summaries WHERE site_id = ? AND ${guard}`).bind(job.site_id, ...params()),
    db.prepare(`INSERT INTO performance_summaries (import_id, site_id, summary, processed_at)
      SELECT ?, ?, ?, ? WHERE ${guard}`)
      .bind(job.import_id, job.site_id, pointer, new Date().toISOString(), ...params()),
    db.prepare(`UPDATE analysis_runs SET status = 'completed', issue_count = ?, analysis_object_key = ?, completed_at = ?
      WHERE id = ? AND ${guard}`).bind(issueCount, objectKey, new Date().toISOString(), job.attempt_id, ...params()),
    db.prepare(`UPDATE analysis_jobs SET status = 'completed', stage = 'complete', percent = 100,
      completed = ?, total = ?, lease_token = '', lease_until = 0, updated_at = ?
      WHERE id = ? AND attempt_id = ? AND lease_token = ? AND status = 'processing' AND lease_until >= ?`)
      .bind(issueCount, issueCount, Date.now(), ...params()),
  ]);
  const current = await readJob(db, job.id);
  if (current?.attempt_id !== job.attempt_id || current.status !== "completed")
    throw new AnalysisStopped("Analysis was canceled before publication.");
}

// Explicit reanalysis keeps the previous published result until atomic publication.
export async function restartJob(db: JobDatabase, id: string, siteId: string, importId: string) {
  const job=await getOrCreateJob(db,id,siteId,importId);
  if (job.status==='processing'||job.status==='canceling') return job;
  await db.prepare(`UPDATE analysis_jobs SET attempt_id = ?, status = 'processing', stage = 'read',
    completed = 0, total = 0, percent = 0, error = '', lease_token = '', lease_until = 0, updated_at = ?
    WHERE id = ? AND attempt_id = ? AND status NOT IN ('processing', 'canceling')`)
    .bind(crypto.randomUUID(),Date.now(),id,job.attempt_id).run();
  return (await readJob(db,id))!;
}
