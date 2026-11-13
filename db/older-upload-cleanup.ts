import { OLDER_UPLOADS } from "./older-upload-manifest";
export const OLDER_UPLOAD_CLEANUP = "retain-latest-upload-per-site-2026-10-28";
type Statement = {
  bind(...values:unknown[]):Statement;
  first<T = Record<string,unknown>>():Promise<T|null>;
  all<T = Record<string,unknown>>():Promise<{results:T[]}>;
  run():Promise<{meta:{changes:number}}>;
};
type Database = {prepare(sql:string):Statement};
type Bucket = {
  head(key:string):Promise<{size:number;etag:string}|null>;
  delete(key:string):Promise<void>;
  list(options:{prefix:string;limit:number;cursor?:string}):Promise<{objects:{key:string;size:number;etag:string}[];truncated:boolean;cursor?:string}>;
};
type Upload = {id:string;site_id:string;file_name:string;object_key:string;file_size:number;created_at:string;status:string};
const COLUMNS = "id,site_id,file_name,object_key,file_size,created_at,status";
const PRESERVED_TABLES = ["site_settings","equipment_assets","performance_summaries","analysis_runs","analysis_jobs","performance_issues","performance_issue_occurrences","data_history_heads","data_history_versions","import_profiles","issue_event_reviews","issue_review_changes","maintenance_windows","maintenance_window_changes","user_settings"];
export async function olderUploadInventory(db:Database,bucket:Bucket) {
  const uploads=(await db.prepare(`SELECT ${COLUMNS} FROM telemetry_imports ORDER BY site_id,created_at DESC,id DESC LIMIT 1001`).all<Upload>()).results;
  if(uploads.length>1000)throw new Error("Use a paged inventory for more than 1000 uploads.");
  const groups=new Map<string,{siteId:string;keep:Upload;older:Upload[]}>();
  for(const upload of uploads){const group=groups.get(upload.site_id);if(group)group.older.push(upload);else groups.set(upload.site_id,{siteId:upload.site_id,keep:upload,older:[]});}
  const objects:{key:string;size:number;etag:string}[]=[];
  let cursor:string|undefined;
  do{const page=await bucket.list({prefix:"mapped/",limit:1000,...(cursor?{cursor}:{})});objects.push(...page.objects.map(({key,size,etag})=>({key,size,etag})));cursor=page.truncated?page.cursor:undefined;}while(cursor);
  const preserved:Record<string,number>={};
  for(const table of PRESERVED_TABLES)preserved[table]=Number((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{n:number}>())?.n||0);
  return {groups:[...groups.values()],objects,preserved,approvedIds:OLDER_UPLOADS.map(row=>row.id)};
}
export async function removeOlderUpload(db:Database,bucket:Bucket,importId:string) {
  const approved=OLDER_UPLOADS.find(row=>row.id===importId);
  if(!approved)throw new Error("This upload is outside the approved cleanup.");
  const row=await db.prepare(`SELECT ${COLUMNS} FROM telemetry_imports WHERE id = ?`).bind(importId).first<Upload>();
  if(!row)return {status:"already_deleted",importId};
  if(row.site_id!==approved.siteId||row.object_key!==approved.objectKey||!row.object_key.startsWith(`mapped/${row.site_id}/`))throw new Error("Upload identity changed; no file was deleted.");
  const latest=await db.prepare(`SELECT ${COLUMNS} FROM telemetry_imports WHERE site_id = ? ORDER BY created_at DESC,id DESC LIMIT 1`).bind(row.site_id).first<Upload>();
  if(!latest||latest.id!==approved.keepId||latest.id===row.id||latest.created_at<=row.created_at||latest.status!=="imported")throw new Error("The latest upload changed or is not ready; no file was deleted.");
  // Retain source files needed by a history build or an in-flight analysis.
  const history=await db.prepare("SELECT id FROM data_history_versions WHERE site_id = ? LIMIT 1").bind(row.site_id).first();
  if(history)throw new Error("This site has retained continuous history; review its source dependencies first.");
  const job=await db.prepare("SELECT id FROM analysis_jobs WHERE site_id = ? AND import_id = ? AND status IN ('processing','canceling') LIMIT 1").bind(row.site_id,row.id).first();
  if(job)throw new Error("An analysis still uses this upload; finish or cancel it before deleting the file.");
  const shared=await db.prepare("SELECT id FROM telemetry_imports WHERE object_key = ? AND id <> ? LIMIT 1").bind(row.object_key,row.id).first();
  if(shared)throw new Error("Another import references this file; no file was deleted.");
  if(!await bucket.head(latest.object_key))throw new Error("The latest upload's file is unavailable; the older file was preserved.");
  // Delete only the exact approved CSV key. Existing analyses are self-contained snapshots.
  // R2 deletion is idempotent; if the database write fails, a retry finishes safely.
  await bucket.delete(row.object_key);
  const result=await db.prepare("DELETE FROM telemetry_imports WHERE id = ? AND site_id = ? AND object_key = ?").bind(row.id,row.site_id,row.object_key).run();
  return {status:"deleted",importId:row.id,siteId:row.site_id,fileName:row.file_name,bytes:row.file_size,deletedRows:result.meta.changes,keptImportId:latest.id};
}
