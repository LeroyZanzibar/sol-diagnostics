// One-time, explicitly scoped cleanup requested by the site owner. Never run on startup.
export const DEPOT_SITE_ID = "depot-solar-center";
export const DEPOT_CLEANUP_ID = "delete-depot-performance-2026-10-28";
const IMPORT_IDS = ["0f239bcf-2c22-4862-b696-e9725186a32e", "d652b8e8-95d9-4b88-aff1-951ee8b9e0fb", "7357611d-ed5a-4846-8858-fcc8933b27ef", "0516863f-cb5a-4d37-a895-41b8bb662a8f", "27a03239-8a23-4fb4-83fb-ed252882c231"];
const PREFIXES = ["mapped/", "analysis/", "history/"].map(prefix => `${prefix}${DEPOT_SITE_ID}/`);
const TABLES = ["performance_issue_occurrences", "performance_issues", "performance_summaries", "analysis_runs", "analysis_jobs", "data_history_heads", "data_history_versions", "telemetry_imports"];
const PRESERVED = ["equipment_assets", "import_profiles", "issue_event_reviews", "issue_review_changes", "maintenance_windows", "maintenance_window_changes"];
type ReadDatabase = { prepare(sql: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null> } } };
export async function depotCleanupInProgress(db: ReadDatabase, siteId: string) {
  if (siteId !== DEPOT_SITE_ID) return false;
  const task = await db.prepare("SELECT status FROM maintenance_tasks WHERE id = ?").bind(DEPOT_CLEANUP_ID).first<{status:string}>();
  return task?.status === "deleting";
}
type CleanupStatement = {
  bind(...values: unknown[]): CleanupStatement;
  first<T = Record<string,unknown>>(): Promise<T | null>;
  all<T = Record<string,unknown>>(): Promise<{results:T[]}>;
  run(): Promise<{meta:{changes:number}}>;
};
type CleanupDatabase = {prepare(sql:string):CleanupStatement;batch(statements:CleanupStatement[]):Promise<unknown>};
type CleanupBucket = {
  list(options:{prefix:string;limit:number;cursor?:string}):Promise<{objects:{key:string;size:number}[];truncated:boolean;cursor?:string}>;
  delete(keys:string[]):Promise<void>;
};
async function countRows(db: CleanupDatabase, tables: string[], otherSites = false) {
  const counts: Record<string, number> = {};
  for (const table of tables) counts[table] = Number((await db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE site_id ${otherSites ? "<>" : "="} ?`).bind(DEPOT_SITE_ID).first<{n:number}>())?.n || 0);
  return counts;
}
export async function depotCleanupPreview(db: CleanupDatabase, bucket: CleanupBucket) {
  const task = await db.prepare("SELECT status, completed_at FROM maintenance_tasks WHERE id = ?").bind(DEPOT_CLEANUP_ID).first();
  const imports = (await db.prepare("SELECT id, file_name, object_key, file_size FROM telemetry_imports WHERE site_id = ? ORDER BY id").bind(DEPOT_SITE_ID).all()).results;
  const objects: {key:string;size:number}[] = [];
  // Metadata only. Never download or parse the large analysis snapshots.
  for (const prefix of PREFIXES) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({prefix, limit:1000, ...(cursor ? {cursor} : {})});
      objects.push(...page.objects.map(object => ({key:object.key,size:object.size})));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return {siteId:DEPOT_SITE_ID,task,imports,objects,generated:await countRows(db,TABLES),
    preserved:await countRows(db,PRESERVED),otherSites:await countRows(db,TABLES,true),
    site:await db.prepare("SELECT * FROM site_settings WHERE id = ?").bind(DEPOT_SITE_ID).first()};
}
export async function deleteDepotPerformanceStep(db: CleanupDatabase, bucket: CleanupBucket, now = Date.now()) {
  let task = await db.prepare("SELECT status, completed_at FROM maintenance_tasks WHERE id = ?").bind(DEPOT_CLEANUP_ID).first<{status:string;completed_at:string}>();
  // Sealed after completion: retrying this operation must never remove future uploads.
  if (task?.status === "completed") return {status:"completed", deletedRows:0, deletedObjects:0};
  if (!task) {
    const imports = (await db.prepare("SELECT id, object_key FROM telemetry_imports WHERE site_id = ?").bind(DEPOT_SITE_ID).all<{id:string;object_key:string}>()).results;
    if (imports.length !== IMPORT_IDS.length || imports.some(row => !IMPORT_IDS.includes(row.id) || !row.object_key.startsWith(PREFIXES[0])))
      throw new Error("Depot uploads changed since this cleanup was prepared. No files were deleted.");
    await db.batch([
      db.prepare("INSERT INTO maintenance_tasks (id,status,completed_at) VALUES (?,'deleting',?) ON CONFLICT(id) DO NOTHING").bind(DEPOT_CLEANUP_ID,new Date(now).toISOString()),
      db.prepare("UPDATE analysis_jobs SET status = 'canceled', lease_token = '', lease_until = 0, updated_at = ? WHERE site_id = ?").bind(now,DEPOT_SITE_ID),
    ]);
    task = await db.prepare("SELECT status, completed_at FROM maintenance_tasks WHERE id = ?").bind(DEPOT_CLEANUP_ID).first<{status:string;completed_at:string}>();
  }
  // Allow existing requests to reach their revoked lease checkpoint before removing objects.
  const waitMs = Math.max(0, 65000 - (now - Date.parse(task!.completed_at)));
  if (waitMs) return {status:"waiting",waitMs,deletedRows:0,deletedObjects:0};
  for (const prefix of PREFIXES) {
    const page = await bucket.list({prefix,limit:100});
    if (page.objects.length) {
      const keys = page.objects.map(object => object.key);
      if (keys.some(key => !key.startsWith(prefix))) throw new Error("Unexpected storage key; cleanup stopped.");
      await bucket.delete(keys);
      return {status:"deleting",deletedObjects:keys.length,deletedRows:0};
    }
  }
  for (const table of TABLES) {
    const pk = table === "performance_summaries" ? "import_id" : "id";
    const result = await db.prepare(`DELETE FROM ${table} WHERE site_id = ? AND ${pk} IN (SELECT ${pk} FROM ${table} WHERE site_id = ? LIMIT 5000)`).bind(DEPOT_SITE_ID,DEPOT_SITE_ID).run();
    if (result.meta.changes) return {status:"deleting",table,deletedRows:result.meta.changes,deletedObjects:0};
  }
  await db.prepare("UPDATE maintenance_tasks SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'deleting'").bind(new Date(now).toISOString(),DEPOT_CLEANUP_ID).run();
  return {status:"completed",deletedRows:0,deletedObjects:0};
}
