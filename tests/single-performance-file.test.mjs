import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {loadSource} from './source-module.mjs';
const fileService=loadSource('db/single-performance-file.ts');
function fixture(){
 const sqlite=new DatabaseSync(':memory:');for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(`drizzle/${f}`,'utf8'));
 const stmt=(sql,values=[])=>({bind(...v){return stmt(sql,v)},async first(){return sqlite.prepare(sql).get(...values)||null},async all(){return {results:sqlite.prepare(sql).all(...values)}},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}}}});
 const db={prepare:stmt,async batch(items){sqlite.exec('BEGIN');try{const out=[];for(const item of items)out.push(await item.run());sqlite.exec('COMMIT');return out}catch(e){sqlite.exec('ROLLBACK');throw e}}};
 const objects=new Map(),bucket={async put(key,body){objects.set(key,typeof body==='string'?body:await new Response(body).text())},async delete(keys){for(const k of Array.isArray(keys)?keys:[keys])objects.delete(k)},async list({prefix,limit}){const keys=[...objects.keys()].filter(k=>k.startsWith(prefix));return {objects:keys.slice(0,limit).map(key=>({key})),truncated:keys.length>limit}}};
 // These are regression tests for the retired legacy helper, not for the new
 // upload routes. Canonical staging/approval is covered in performance-data-api.
 const metadata={siteId:'site',fileName:'data.csv',fileSize:4,timezone:'UTC',mapping:'{}',detectedTypes:'[]',validation:'{}',rowCount:1,validRows:1,warningCount:0,errorCount:0,status:'imported',timestampStart:null,timestampEnd:null};
 const upload=async(patch={})=>{
  const record={...metadata,...patch,id:crypto.randomUUID(),createdAt:new Date().toISOString()},previous=await fileService.currentImportId(db,record.siteId);
  if(patch.replacesImportId!==undefined&&patch.replacesImportId!==previous)throw new fileService.UploadConflictError('The current file changed.');
  record.objectKey=`mapped/${record.siteId}/${record.id}.csv`;
  await fileService.stagePerformanceFile(db,record.siteId,record.objectKey);
  try{await bucket.put(record.objectKey,'legacy synthetic CSV');await fileService.commitPerformanceFile(db,record,previous)}catch(error){
   if(!sqlite.prepare('SELECT id FROM telemetry_imports WHERE id=?').get(record.id)){await fileService.retireFailedUpload(db,record.objectKey);throw error}
  }
  await fileService.drainPerformanceFileCleanup(db,bucket).catch(()=>undefined);return record;
 };
 return {sqlite,db,bucket,objects,metadata,upload};
}
test('legacy-only helper replaces its file and leaves other sites and saved results intact',async()=>{
 const f=fixture(),old=await f.upload(),other=await f.upload({siteId:'other'});
 f.sqlite.prepare('INSERT INTO analysis_runs(id,site_id,import_id,parser_version,model_revision,analysis_object_key) VALUES (?,?,?,?,?,?)').run('run','site',old.id,28,'model','analysis/site/result.json');
 f.objects.set('analysis/site/result.json','saved analysis');
 const current=await f.upload({replacesImportId:old.id,fileName:'replacement.csv'});
 assert.equal(current.status,'imported');assert.equal(await fileService.currentImportId(f.db,'site'),current.id);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM telemetry_imports WHERE site_id=?').get('site').n,1);
 assert.equal(f.objects.has(old.objectKey),false);assert.equal(f.objects.has(current.objectKey),true);assert.equal(f.objects.has(other.objectKey),true);assert.equal(f.objects.has('analysis/site/result.json'),true);
 assert.equal(f.sqlite.prepare('SELECT import_id FROM analysis_runs WHERE id=?').get('run').import_id,old.id);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM performance_file_cleanup').get().n,0);
});
test('storage failure and database rollback preserve the current file',async()=>{
 for(const scenario of ['storage','database']){
  const f=fixture(),old=await f.upload();
  if(scenario==='storage')f.bucket.put=async()=>{throw Error('storage unavailable')};
  else f.sqlite.exec("CREATE TRIGGER fail_replacement BEFORE DELETE ON telemetry_imports BEGIN SELECT RAISE(ABORT,'database unavailable'); END");
  await assert.rejects(f.upload({replacesImportId:old.id}),/unavailable/);
  assert.equal(await fileService.currentImportId(f.db,'site'),old.id);assert.equal(f.objects.has(old.objectKey),true);
  await fileService.drainPerformanceFileCleanup(f.db,f.bucket);assert.equal(f.objects.size,1);
 }
});
test('a lost commit acknowledgement does not delete the successfully saved replacement',async()=>{
 const f=fixture(),old=await f.upload(),batch=f.db.batch;let lost=true;
 f.db.batch=async items=>{const result=await batch(items);if(lost){lost=false;throw Error('lost response')}return result};
 const replacement=await f.upload({replacesImportId:old.id});
 assert.equal(await fileService.currentImportId(f.db,'site'),replacement.id);assert.equal(f.objects.has(replacement.objectKey),true);assert.equal(f.objects.has(old.objectKey),false);
});
test('concurrent and stale uploads cannot erase the winning replacement',async()=>{
 const f=fixture(),old=await f.upload();
 const a={...old,id:'candidate-a',objectKey:'mapped/site/a.csv',createdAt:'2026-10-29'},b={...a,id:'candidate-b',objectKey:'mapped/site/b.csv'};
 for(const r of [a,b]){f.objects.set(r.objectKey,'candidate');await fileService.stagePerformanceFile(f.db,'site',r.objectKey);}
 await fileService.commitPerformanceFile(f.db,a,old.id);await assert.rejects(fileService.commitPerformanceFile(f.db,b,old.id),/Another upload/);
 await assert.rejects(f.upload({replacesImportId:old.id}),/current file changed/);
 await fileService.retireFailedUpload(f.db,b.objectKey);await fileService.drainPerformanceFileCleanup(f.db,f.bucket);
 assert.equal(await fileService.currentImportId(f.db,'site'),a.id);assert.equal(f.objects.has(a.objectKey),true);assert.equal(f.objects.has(b.objectKey),false);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM telemetry_imports WHERE site_id=?').get('site').n,1);
});
test('retirement failures retry durably and never delete a referenced current file',async()=>{
 const f=fixture(),old=await f.upload(),remove=f.bucket.delete;f.bucket.delete=async()=>{throw Error('temporary storage failure')};
 const next=await f.upload({replacesImportId:old.id});assert.equal(await fileService.currentImportId(f.db,'site'),next.id);assert.ok(f.objects.has(old.objectKey));
 f.bucket.delete=remove;
 await f.db.prepare("INSERT INTO performance_file_cleanup VALUES (?,?,'file',0)").bind(next.objectKey,'site').run();
 assert.equal((await fileService.drainPerformanceFileCleanup(f.db,f.bucket)).pending,0);
 assert.ok(f.objects.has(next.objectKey));assert.equal(f.objects.has(old.objectKey),false);
});
test('adoption removes legacy imports and continuous history but preserves the selected source and analysis snapshots',async()=>{
 const f=fixture(),keep=await f.upload();
 f.sqlite.exec(`INSERT INTO telemetry_imports SELECT 'old',site_id,file_name,'mapped/site/old.csv',file_size,row_count,valid_rows,warning_count,error_count,'pending',timezone,mapping,detected_types,validation,timestamp_start,timestamp_end,'2026-01-01' FROM telemetry_imports`);
 f.sqlite.prepare("INSERT INTO data_history_versions(id,site_id,import_id,year,metadata,created_at) VALUES ('history','site',?,2026,'{}','now')").run(keep.id);
 f.sqlite.exec("INSERT INTO data_history_heads VALUES ('head','site',2026,'history')");
 for(const key of ['mapped/site/old.csv','history/site/history/manifest.json','history/site/history/jan.json','analysis/site/saved.json'])f.objects.set(key,'retained');
 await fileService.adoptSinglePerformanceFile(f.db,'site',keep.id);await fileService.drainPerformanceFileCleanup(f.db,f.bucket);
 assert.ok(f.objects.has(keep.objectKey));assert.ok(f.objects.has('analysis/site/saved.json'));assert.equal(f.objects.size,2);
 for(const table of ['data_history_heads','data_history_versions'])assert.equal(f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM telemetry_imports').get().n,1);
});
