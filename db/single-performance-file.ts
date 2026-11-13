type Statement = {
  bind(...values:unknown[]):Statement;
  first<T=Record<string,unknown>>():Promise<T|null>;
  all<T=Record<string,unknown>>():Promise<{results:T[]}>;
  run():Promise<{meta:{changes:number}}>;
};
export type FileDatabase={prepare(sql:string):Statement;batch(statements:Statement[]):Promise<{meta:{changes:number}}[]>};
type FileBucket={delete(key:string|string[]):Promise<void>;list(options:{prefix:string;limit:number}):Promise<{objects:{key:string}[];truncated:boolean}>};
export type RetainedImport={id:string;siteId:string;fileName:string;objectKey:string;fileSize:number;rowCount:number;validRows:number;warningCount:number;errorCount:number;status:string;timezone:string;mapping:string;detectedTypes:string;validation:string;timestampStart:string|null;timestampEnd:string|null;createdAt:string};
export class UploadConflictError extends Error {}
export async function currentImportId(db:FileDatabase,siteId:string){return (await db.prepare("SELECT id FROM telemetry_imports WHERE site_id = ? AND status = 'imported' ORDER BY created_at DESC,id DESC LIMIT 1").bind(siteId).first<{id:string}>())?.id||"";}
export async function stagePerformanceFile(db:FileDatabase,siteId:string,key:string){
  await db.prepare("INSERT INTO performance_file_cleanup (object_key,site_id,kind,not_before) VALUES (?,?,'file',?)").bind(key,siteId,Date.now()+3600000).run();
}
export async function retireFailedUpload(db:FileDatabase,key:string){
  await db.prepare("UPDATE performance_file_cleanup SET not_before = 0 WHERE object_key = ?").bind(key).run();
}
function retirePrevious(db:FileDatabase,siteId:string,keepId:string){
  const guard="EXISTS (SELECT 1 FROM telemetry_imports WHERE id = ? AND site_id = ? AND status = 'imported')";
  const bindGuard=(sql:string,...values:unknown[])=>db.prepare(sql).bind(...values,keepId,siteId);
  return [
    bindGuard(`INSERT OR IGNORE INTO performance_file_cleanup (object_key,site_id,kind,not_before) SELECT object_key,site_id,'file',0 FROM telemetry_imports WHERE site_id = ? AND id <> ? AND ${guard}`,siteId,keepId),
    bindGuard(`INSERT OR IGNORE INTO performance_file_cleanup (object_key,site_id,kind,not_before) SELECT ?,?,'prefix',0 WHERE EXISTS (SELECT 1 FROM data_history_versions WHERE site_id = ?) AND ${guard}`,`history/${siteId}/`,siteId,siteId),
    bindGuard(`DELETE FROM data_history_heads WHERE site_id = ? AND ${guard}`,siteId),
    bindGuard(`DELETE FROM data_history_versions WHERE site_id = ? AND ${guard}`,siteId),
    bindGuard(`UPDATE analysis_jobs SET status = 'canceled',lease_token = '',lease_until = 0,updated_at = ? WHERE site_id = ? AND import_id <> ? AND status IN ('processing','canceling') AND ${guard}`,Date.now(),siteId,keepId),
    bindGuard(`UPDATE analysis_runs SET status = 'canceled',completed_at = ? WHERE site_id = ? AND import_id <> ? AND status = 'processing' AND ${guard}`,new Date().toISOString(),siteId,keepId),
    bindGuard(`DELETE FROM telemetry_imports WHERE site_id = ? AND id <> ? AND ${guard}`,siteId,keepId),
  ];
}
export async function commitPerformanceFile(db:FileDatabase,record:RetainedImport,expectedImportId:string){
  const columns=['id','site_id','file_name','object_key','file_size','row_count','valid_rows','warning_count','error_count','status','timezone','mapping','detected_types','validation','timestamp_start','timestamp_end','created_at'];
  const values=[record.id,record.siteId,record.fileName,record.objectKey,record.fileSize,record.rowCount,record.validRows,record.warningCount,record.errorCount,'imported',record.timezone,record.mapping,record.detectedTypes,record.validation,record.timestampStart,record.timestampEnd,record.createdAt];
  const guard="COALESCE((SELECT id FROM telemetry_imports WHERE site_id = ? AND status = 'imported' ORDER BY created_at DESC,id DESC LIMIT 1),'') = ?";
  const results=await db.batch([
    db.prepare(`INSERT INTO telemetry_imports (${columns.join(',')}) SELECT ${columns.map(()=>'?').join(',')} WHERE ${guard}`).bind(...values,record.siteId,expectedImportId),
    ...retirePrevious(db,record.siteId,record.id),
    db.prepare("DELETE FROM performance_file_cleanup WHERE object_key = ? AND EXISTS (SELECT 1 FROM telemetry_imports WHERE id = ? AND site_id = ?)").bind(record.objectKey,record.id,record.siteId),
  ]);
  if(results[0].meta.changes!==1)throw new UploadConflictError("Another upload changed this site's file. Refresh the current file before trying again.");
}
export async function adoptSinglePerformanceFile(db:FileDatabase,siteId:string,keepId:string){
  if(await currentImportId(db,siteId)!==keepId)throw new UploadConflictError("The current file changed. Refresh before continuing.");
  // All changes are conditional on the retained row still existing. Replacement
  // transactions delete their predecessor, so a racing upload cannot be removed.
  await db.batch(retirePrevious(db,siteId,keepId));
  return {siteId,keptImportId:await currentImportId(db,siteId)};
}
export async function drainPerformanceFileCleanup(db:FileDatabase,bucket:FileBucket){
  const rows=(await db.prepare("SELECT object_key,site_id,kind FROM performance_file_cleanup WHERE not_before <= ? LIMIT 20").bind(Date.now()).all<{object_key:string;site_id:string;kind:string}>()).results;
  let deleted=0;
  for(const row of rows){
    try{
      if(row.kind==='file'){
        if(!row.object_key.startsWith(`mapped/${row.site_id}/`))continue;
        const current=await db.prepare("SELECT id FROM telemetry_imports WHERE object_key = ? LIMIT 1").bind(row.object_key).first();
        if(!current){await bucket.delete(row.object_key);deleted++;}
      }else if(row.kind==='prefix'){
        if(row.object_key!==`history/${row.site_id}/`)continue;
        if(await db.prepare("SELECT id FROM data_history_versions WHERE site_id = ? LIMIT 1").bind(row.site_id).first())continue;
        const page=await bucket.list({prefix:row.object_key,limit:100});
        if(page.objects.some(item=>!item.key.startsWith(row.object_key)))continue;
        if(page.objects.length){await bucket.delete(page.objects.map(item=>item.key));deleted+=page.objects.length;}
        if(page.truncated)continue;
      }else continue;
      await db.prepare("DELETE FROM performance_file_cleanup WHERE object_key = ?").bind(row.object_key).run();
    }catch(error){console.error("Superseded file cleanup will retry.",error instanceof Error?error.message:"Storage unavailable");}
  }
  const pending=Number((await db.prepare("SELECT COUNT(*) n FROM performance_file_cleanup").first<{n:number}>())?.n||0);
  return {deleted,pending};
}
