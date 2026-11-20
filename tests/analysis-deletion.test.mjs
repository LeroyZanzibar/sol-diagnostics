import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {LocalDatabase, LocalBucket} from '../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../selfhost/performance-store.mjs';
import {loadSource} from './source-module.mjs';

// Real production-migrated SQLite + durable objects. Only runtime binding lookup
// and the irrelevant freshness assessment are supplied by this controller harness.
const load=(path,bindings={})=>loadSource(path,[],{Error,TypeError,...bindings});

const review=load('app/issue-review.ts');
const checkpoint=load('app/api/performance-summary/checkpoint-storage.ts');
const plain=value=>JSON.parse(JSON.stringify(value));
const issue=(id='finding',patch={})=>({id,eventKey:`event-${id}`,evidenceSignature:`signature-${id}`,equipmentId:'inverter',equipmentName:'Inverter',equipmentType:'inverter',type:'Equipment outage',category:'Availability',name:'Inverter outage',startDateTime:'2026-06-01T12:00:00.000Z',endDateTime:'2026-06-01T13:00:00.000Z',durationMinutes:60,estimatedLossKwh:10,actualEnergyKwh:0,expectedEnergyKwh:10,intervalMinutes:60,intervalLosses:[{timestamp:'2026-06-01T12:00:00.000Z',lossKwh:10,countedLossKwh:10,actualKwh:0,expectedKwh:10}],...patch});
const code=expected=>error=>error.code===expected;

async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'sol-delete-')),filename=join(root,'shared.sqlite');
 const db=new LocalDatabase(filename,resolve('drizzle')),bucket=new LocalBucket(db,join(root,'objects'));
 const manager=new PerformanceStoreManager(join(root,'performance')),site=manager.site('site');
 t.after(()=>{manager.close();db.close();rmSync(root,{recursive:true,force:true});});
 const staged=await site.stage({source:'csv',fileName:'synthetic.csv',timezone:'UTC',intervalMinutes:60,modelRevision:'model',sourceTimestampConvention:'start'},[{timestamp:'2026-06-01T12:00:00.000Z',channel:{id:'energy',equipmentId:'meter',measurement:'Energy',unit:'kWh'},value:7}]);
 site.commit(staged.stageId,{previewToken:staged.previewToken,approveOverlap:true,modelRevision:'model',actor:'test'});
 const data={savedAnalysisProvenance:(siteId,runId)=>siteId==='site'?site.analysis(runId):null,assessAnalysisFreshness:()=>({status:'unknown'})};
 const availability=load('app/api/analysis-history/availability.ts');
 const bindings={...review,...checkpoint,...data,...availability,getDatabaseBinding:()=>db,getBucketBinding:()=>bucket};
 const history=load('app/api/analysis-history/service.ts',bindings);
 const deletion=load('app/api/analysis-history/deletion.ts',bindings);
 const service=load('app/api/issue-reviews/service.ts',{...bindings,...history});
 const api=load('app/api/analysis-history/route.ts',{...bindings,...history,...deletion});
 const reviews=load('app/api/issue-reviews/route.ts',{...bindings,...history,...service,blankReview:review.blankReview});
 const bulk=load('app/api/issue-reviews/bulk/route.ts',{...bindings,...history,...service,blankReview:review.blankReview});
 const freshness=load('app/api/analysis-freshness/route.ts',bindings);
 async function run(id,{siteId='site',importId='input',status='completed',objectKey=`analysis/${siteId}/jobs/${id}/result.json`,issues=[issue()],recurringIssues=[],job=true}={}){
  db.sqlite.prepare('INSERT INTO analysis_runs (id,site_id,import_id,parser_version,model_revision,status,issue_count,analysis_object_key,completed_at) VALUES (?,?,?,28,?,?,?,?,?)').run(id,siteId,importId,'model',status,issues.length,objectKey,'2026-06-01T14:00:00.000Z');
  const payload={siteId,issueDatabase:{analysisRunId:id},analysis:{issues,recurringIssues,analysisIntervalMinutes:60}};
  await checkpoint.writeCheckpoint(bucket,objectKey,payload);
  await checkpoint.writeCheckpoint(bucket,objectKey.replace(/result\.json$/,'review-index.json'),{...payload,analysis:{...payload.analysis,issues:issues.map(({intervalLosses,...item})=>item)}});
  if(job)db.sqlite.prepare("INSERT INTO analysis_jobs (id,site_id,import_id,attempt_id,status,stage,updated_at) VALUES (?,?,?,?,'completed','complete',0)").run(`slot-${id}`,siteId,importId,id);
  if(siteId==='site'){const d=site.describe();site.recordAnalysis(id,{version:1,siteId,revision:d.revision,revisionId:d.revisionId,scopes:[],hashes:[],dependencyScope:'analysis-range'});}
  return payload;
 }
 function pointer(id,patch={}){const r=db.sqlite.prepare('SELECT * FROM analysis_runs WHERE id=?').get(id);db.sqlite.prepare('INSERT OR REPLACE INTO performance_summaries(import_id,site_id,summary,processed_at) VALUES (?,?,?,?)').run(r.import_id,r.site_id,JSON.stringify({analysisRunId:id,objectKey:r.analysis_object_key,...patch}),'published');}
 const request=(id,siteId='site')=>new Request(`https://test/api/analysis-history?siteId=${encodeURIComponent(siteId)}&runId=${encodeURIComponent(id)}`,{method:'DELETE'});
 return {root,filename,db,bucket,site,run,pointer,history,deletion,availability,service,api,reviews,bulk,freshness,request,bindings};
}

function snapshot(db){const tables=db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();return Object.fromEntries(tables.map(({name})=>[name,plain(db.sqlite.prepare(`SELECT * FROM "${name}"`).all()).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]));}
function siteSnapshot(f){const db=new DatabaseSync(join(f.root,'performance',`${createHash('sha256').update('site').digest('hex')}.sqlite`),{readOnly:true});try{return snapshot({sqlite:db});}finally{db.close();}}
function objectHashes(f){return f.db.sqlite.prepare('SELECT key,path FROM __sol_objects ORDER BY key').all().map(({key,path})=>[key,createHash('sha256').update(readFileSync(join(f.root,'objects',path))).digest('hex')]);}
const callPost=(api,body)=>api.POST(new Request('https://test/api/issue-reviews',{method:'POST',body:JSON.stringify(body)}));

test('DELETE current analysis tombstones identity, clears exact pointer and blocks public history/freshness/review access',async t=>{
 const f=await fixture(t);await f.run('older');await f.run('current');f.pointer('current');
 await f.bucket.put('analysis/site/current.json',JSON.stringify({issueDatabase:{analysisRunId:'current'}}));
 await f.bucket.put('analysis/site/display.json','retained display bytes');
 const before=snapshot(f.db),objects=objectHashes(f),source=plain([...f.site.rows()]),provenance=f.site.analysis('current');
 assert.equal(typeof f.api.DELETE,'function','real history controller must implement DELETE');
 const response=await f.api.DELETE(f.request('current'));assert.equal(response.status,200,await response.clone().text());
 assert.deepEqual(await response.json(),{deleted:true,siteId:'site',runId:'current',currentCleared:true});assert.match(response.headers.get('cache-control'),/private, no-store/);
 assert.equal(f.db.sqlite.prepare("SELECT status FROM analysis_runs WHERE id='current'").get().status,'deleted');
 assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM performance_summaries').get().n,0);
 assert.equal(f.db.sqlite.prepare("SELECT count(*) n FROM analysis_jobs WHERE attempt_id='current'").get().n,0);
 assert.deepEqual((await f.history.listAnalysisHistory('site')).runs.map(r=>r.id),['older']);
 for(const api of [f.api,f.freshness,f.reviews])assert.equal((await api.GET(new Request('https://test/api?siteId=site&runId=current'))).status,404);
 assert.equal((await f.history.savedAnalysis('site','older')).issueDatabase.analysisRunId,'older');
 assert.equal(await f.availability.isCompletedAnalysisRun(f.db,'site','current'),false);
 assert.equal(await f.availability.publishedAnalysisAvailable(f.db,'site','input',null),false);
 assert.deepEqual(objectHashes(f),objects);assert.deepEqual(plain([...f.site.rows()]),source);assert.deepEqual(f.site.analysis('current'),provenance);
 const after=snapshot(f.db);for(const table of Object.keys(before).filter(n=>!['analysis_runs','analysis_jobs','performance_summaries'].includes(n)))assert.deepEqual(after[table],before[table],table);
 const repeat=await f.api.DELETE(f.request('current'));assert.equal(repeat.status,200);assert.equal((await repeat.json()).currentCleared,false);assert.deepEqual(snapshot(f.db),after);
});

test('review save rechecks completed target inside writer transaction, rejecting delayed delete-first writes',async t=>{
 const f=await fixture(t);await f.run('target');const state={...review.blankReview(issue(),'signature-finding'),status:'Confirmed',evidenceRunId:'target'};
 // This is exactly the state a real request can hold after its awaited context
 // read. Delete commits before saveReview reaches its write transaction.
 await f.service.reviewContext('site','target','finding');
 f.db.sqlite.prepare("UPDATE analysis_runs SET status='deleted' WHERE id='target'").run();
 await assert.rejects(f.service.saveReview(f.db,'site','event-finding','target',0,state,'delayed note','tester'),/analysis.*(available|completed|deleted|found)/i);
 assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM issue_event_reviews').get().n,0);
 assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM issue_review_changes').get().n,0);
});

test('review-first deletion preserves internal direct baseline assessment without publicly exposing the deleted run',async t=>{
 const f=await fixture(t);await f.run('baseline');await f.run('retained');
 await f.service.saveReview(f.db,'site','event-finding','baseline',0,{...review.blankReview(issue(),'signature-finding'),status:'Dismissed',dismissalReason:'Duplicate finding'},'keep note','tester');
 const payload=await f.history.savedAnalysis('site','retained',true),before=plain(await f.service.effectiveReviews(f.db,'site','retained',payload,['event-finding']));
 assert.equal(typeof f.api.DELETE,'function');assert.equal((await f.api.DELETE(f.request('baseline'))).status,200);
 const after=plain(await f.service.effectiveReviews(f.db,'site','retained',payload,['event-finding']));assert.deepEqual(after,before);assert.equal(after[0].needsReview,false);
 await assert.rejects(f.history.savedAnalysis('site','baseline',true),/not found/);
});

function identity(db,id,siteId='site'){
 db.sqlite.prepare(`INSERT INTO performance_issues(id,fingerprint,site_id,equipment_id,equipment_name,equipment_external_id,equipment_type,name,issue_type,category,confidence,severity,description,status,first_detected_at,last_detected_at,occurrence_count,latest_estimated_loss_kwh,latest_site_impact_percent,assigned_to,resolved_at,created_at,updated_at)
 VALUES (?,?,?,'inv','Original equipment','external','inverter','Retained name','Equipment outage','Availability','confirmed','high','Retain description','resolved','2000-first','2099-last',42,99,88,'Analyst','resolved date','creation date','lifecycle update')`).run(id,`fingerprint-${id}`,siteId);
}
function occurrence(db,id,shared,run,loss=10,end='2026-06-01T13:00:00Z'){
 const owner=db.sqlite.prepare('SELECT site_id,import_id FROM analysis_runs WHERE id=?').get(run);
 db.sqlite.prepare(`INSERT INTO performance_issue_occurrences(id,issue_id,analysis_run_id,import_id,site_id,source_issue_id,start_date_time,end_date_time,duration_minutes,actual_energy_kwh,expected_energy_kwh,estimated_loss_kwh,loss_percent,site_impact_percent,evidence,parser_version,model_revision,updated_at)
 VALUES (?,?,?,?,?,?,'2026-06-01T12:00:00Z',?,60,0,10,?,100,3,'{"retained":true}',28,'model','updated')`).run(id,shared,run,owner.import_id,owner.site_id,id,end,loss);
}

test('older deletion preserves exact shared identity/lifecycle, other runs, reused job slot, inputs, objects and site provenance',async t=>{
 const f=await fixture(t);await f.run('old');await f.run('latest');await f.run('foreign',{siteId:'elsewhere',importId:'foreign-input'});f.pointer('latest');f.pointer('foreign');
 f.db.sqlite.prepare("UPDATE analysis_jobs SET attempt_id='new-attempt',status='processing',stage='read' WHERE id='slot-old'").run();
 for(const id of ['shared','empty','untouched'])identity(f.db,id);
 occurrence(f.db,'old-one','shared','old',15);occurrence(f.db,'new-one','shared','latest',null,'2026-07-01T13:00:00Z');occurrence(f.db,'old-only','empty','old');occurrence(f.db,'unaffected','untouched','latest');
 f.db.sqlite.prepare("INSERT INTO telemetry_imports(id,site_id,file_name,object_key,file_size,row_count,valid_rows,timezone,mapping,detected_types,validation) VALUES ('source','site','source.csv','source/raw',17,1,1,'UTC','{}','{}','{}')").run();
 await f.bucket.put('source/raw','original readings');
 const before=snapshot(f.db),objects=objectHashes(f),siteTables=siteSnapshot(f),siteBefore={describe:f.site.describe(),rows:plain([...f.site.rows()]),imports:f.site.imports(),old:f.site.analysis('old'),latest:f.site.analysis('latest')};
 const result=await f.api.DELETE(f.request('old'));assert.equal(result.status,200);assert.equal((await result.json()).currentCleared,false);
 const after=snapshot(f.db);
 const aggregateFields=new Set(['first_detected_at','last_detected_at','occurrence_count','latest_estimated_loss_kwh','latest_site_impact_percent']);
 for(const id of ['shared','empty']){
  const old=before.performance_issues.find(r=>r.id===id),next=after.performance_issues.find(r=>r.id===id);
  for(const key of Object.keys(old).filter(k=>!aggregateFields.has(k)))assert.deepEqual(next[key],old[key],`${id}.${key}`);
 }
 const shared=after.performance_issues.find(r=>r.id==='shared'),empty=after.performance_issues.find(r=>r.id==='empty');
 assert.equal(shared.occurrence_count,1);assert.equal(shared.first_detected_at,'2026-06-01T12:00:00Z');assert.equal(shared.last_detected_at,'2026-07-01T13:00:00Z');assert.equal(shared.latest_estimated_loss_kwh,null);assert.equal(shared.latest_site_impact_percent,3);
 assert.equal(empty.occurrence_count,0);assert.equal(empty.latest_estimated_loss_kwh,null);assert.equal(empty.latest_site_impact_percent,0);assert.equal(empty.first_detected_at,'2000-first');assert.equal(empty.last_detected_at,'2099-last');
 assert.deepEqual(after.performance_issues.find(r=>r.id==='untouched'),before.performance_issues.find(r=>r.id==='untouched'));
 assert.deepEqual(after.performance_issue_occurrences,before.performance_issue_occurrences.filter(r=>r.analysis_run_id!=='old'));
 assert.deepEqual(after.analysis_runs,before.analysis_runs.map(r=>r.id==='old'?{...r,status:'deleted'}:r));
 for(const table of Object.keys(before).filter(n=>!['analysis_runs','performance_issue_occurrences','performance_issues'].includes(n)))assert.deepEqual(after[table],before[table],table);
 assert.deepEqual(objectHashes(f),objects);assert.deepEqual(siteSnapshot(f),siteTables);assert.deepEqual({describe:f.site.describe(),rows:plain([...f.site.rows()]),imports:f.site.imports(),old:f.site.analysis('old'),latest:f.site.analysis('latest')},siteBefore);
 const reopened=new LocalDatabase(f.filename,resolve('drizzle'));try{assert.deepEqual(snapshot(reopened),after);}finally{reopened.close();}
});

test('API validates bounded exact legacy identifiers and stable status/error envelopes without mutation',async t=>{
 const f=await fixture(t);await f.run('legacy /α:run');await f.run('unfinished',{status:'processing'});const before=snapshot(f.db);
 for(const [query,status,expected] of [
  ['',400,'INVALID_ANALYSIS_ID'],['siteId=site',400,'INVALID_ANALYSIS_ID'],['siteId=site&runId=',400,'INVALID_ANALYSIS_ID'],
  ['siteId=site&runId=%00bad',400,'INVALID_ANALYSIS_ID'],[`siteId=site&runId=${'x'.repeat(513)}`,400,'INVALID_ANALYSIS_ID'],['siteId=site&runId=%20bad',400,'INVALID_ANALYSIS_ID'],
  ['siteId=site&runId=missing',404,'ANALYSIS_NOT_FOUND'],['siteId=wrong&runId=legacy%20%2F%CE%B1%3Arun',404,'ANALYSIS_NOT_FOUND'],
  ['siteId=site&siteId=wrong&runId=unfinished',400,'INVALID_ANALYSIS_ID'],['siteId=site&runId=unfinished',409,'ANALYSIS_NOT_COMPLETED'],
 ]){const response=await f.api.DELETE(new Request(`https://test/api?${query}`,{method:'DELETE'}));assert.equal(response.status,status,query);const body=await response.json();assert.equal(body.code,expected,query);assert.equal(typeof body.error,'string');assert.match(response.headers.get('cache-control'),/private, no-store/);assert.deepEqual(snapshot(f.db),before);}
 assert.equal((await f.api.DELETE(f.request('legacy /α:run'))).status,200);
 assert.equal((await f.api.DELETE(f.request('legacy /α:run','wrong'))).status,404);
});

test('same-attempt active work, resumable states, live leases and inconsistent ownership all refuse atomically',async t=>{
 const f=await fixture(t);await f.run('target');f.pointer('target');
 const states=[['processing','read',0,'site','input'],['canceling','save',0,'site','input'],['interrupted','equipment',0,'site','input'],['failed','save',0,'site','input'],['completed','complete',Date.now()+600000,'site','input'],['completed','finalize',0,'site','input'],['completed','complete',0,'wrong','input'],['completed','complete',0,'site','wrong'],['mystery','complete',0,'site','input']];
 for(const [status,stage,lease,siteId,importId] of states){
  f.db.sqlite.prepare('UPDATE analysis_jobs SET status=?,stage=?,lease_until=?,site_id=?,import_id=?').run(status,stage,lease,siteId,importId);const before=snapshot(f.db);
  const response=await f.api.DELETE(f.request('target'));assert.equal(response.status,409,status);assert.equal((await response.json()).code,'ANALYSIS_IN_USE');assert.deepEqual(snapshot(f.db),before);
 }
 f.db.sqlite.prepare("UPDATE analysis_jobs SET status='completed',stage='complete',lease_token='expired',lease_until=1,site_id='site',import_id='input'").run();
 assert.equal((await f.api.DELETE(f.request('target'))).status,200,'expired terminal lease is not live work');
});

test('ambiguous or malformed pointer aliases fail closed; explicit matching identity can share retained object bytes',async t=>{
 const f=await fixture(t);await f.run('target');await f.run('other');f.pointer('other');
 const target=f.db.sqlite.prepare("SELECT * FROM analysis_runs WHERE id='target'").get(),other=f.db.sqlite.prepare("SELECT * FROM analysis_runs WHERE id='other'").get();
 const bad=['not json','null','[]','{}',JSON.stringify({analysisRunId:'target',objectKey:other.analysis_object_key}),JSON.stringify({analysisRunId:'missing',objectKey:target.analysis_object_key}),JSON.stringify({analysisRunId:'',objectKey:target.analysis_object_key}),JSON.stringify({objectKey:42})];
 for(const summary of bad){f.db.sqlite.prepare('UPDATE performance_summaries SET summary=?').run(summary);const before=snapshot(f.db);const response=await f.api.DELETE(f.request('target'));assert.equal(response.status,409,summary);assert.equal((await response.json()).code,'ANALYSIS_POINTER_CONFLICT');assert.deepEqual(snapshot(f.db),before);}
 f.db.sqlite.prepare('UPDATE analysis_runs SET analysis_object_key=? WHERE id=?').run(target.analysis_object_key,'other');
 for(const status of ['completed','deleted']){
  f.db.sqlite.prepare("UPDATE analysis_runs SET status=? WHERE id='other'").run(status);f.pointer('target',{analysisRunId:undefined});const before=snapshot(f.db);
  assert.equal(await f.availability.publishedAnalysisAvailable(f.db,'site','input',{objectKey:target.analysis_object_key}),false);
  assert.equal((await f.api.DELETE(f.request('target'))).status,409);assert.deepEqual(snapshot(f.db),before);
 }
 f.pointer('target');const objects=objectHashes(f);assert.equal(await f.availability.publishedAnalysisAvailable(f.db,'site','input',{analysisRunId:'target',objectKey:target.analysis_object_key}),true);
 assert.equal((await f.api.DELETE(f.request('target'))).status,200);assert.deepEqual(objectHashes(f),objects);
});

test('unambiguous legacy pointer deletes exactly; other-import aliases and multiple-current fallback are rejected',async t=>{
 const f=await fixture(t);await f.run('target');f.pointer('target',{analysisRunId:undefined});
 const key=f.db.sqlite.prepare("SELECT analysis_object_key FROM analysis_runs WHERE id='target'").get().analysis_object_key;
 assert.equal(await f.availability.publishedAnalysisAvailable(f.db,'site','input',{objectKey:key}),true);
 await f.run('alias',{importId:'other-input'});f.db.sqlite.prepare("UPDATE analysis_runs SET analysis_object_key=? WHERE id='alias'").run(key);
 assert.equal((await f.api.DELETE(f.request('target'))).status,409);
 f.db.sqlite.prepare("UPDATE analysis_runs SET analysis_object_key='unshared' WHERE id='alias'").run();f.pointer('alias');
 let before=snapshot(f.db);assert.equal((await f.api.DELETE(f.request('target'))).status,409);assert.deepEqual(snapshot(f.db),before);
 f.db.sqlite.prepare("DELETE FROM performance_summaries WHERE import_id='other-input'").run();
 assert.equal((await f.api.DELETE(f.request('target'))).status,200);assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM performance_summaries').get().n,0);
 assert.equal(f.db.sqlite.prepare("SELECT status FROM analysis_runs WHERE id='alias'").get().status,'completed');
});

test('shared metadata rollback covers pointer, occurrence, aggregate, attempt and tombstone writes',async t=>{
 const f=await fixture(t);await f.run('target');f.pointer('target');identity(f.db,'shared');occurrence(f.db,'one','shared','target');
 const objects=objectHashes(f),before=snapshot(f.db);
 for(const [action,table] of [['DELETE','performance_issue_occurrences'],['UPDATE','performance_issues'],['DELETE','analysis_jobs'],['UPDATE','analysis_runs']]){
  f.db.sqlite.exec(`CREATE TRIGGER injection BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'private injected storage failure'); END`);
  const response=await f.api.DELETE(f.request('target'));assert.equal(response.status,500);const body=await response.json();assert.equal(body.code,'ANALYSIS_STORAGE_ERROR');assert.doesNotMatch(body.error,/private injected/);assert.deepEqual(snapshot(f.db),before,table);assert.deepEqual(objectHashes(f),objects);f.db.sqlite.exec('DROP TRIGGER injection');
 }
 assert.equal((await f.api.DELETE(f.request('target'))).status,200);
});

test('deleted baseline retains modern recurring membership, direct exceptions, toleranced ledgers and note-only bulk baseline references',async t=>{
 const f=await fixture(t),a=issue('a'),b=issue('b'),c=issue('new'),h=issue('inherited'),direct=issue('direct');
 const episode={...issue('episode'),isRecurring:true,members:[a,b,h].map(i=>({id:i.id,eventKey:i.eventKey,evidenceSignature:i.evidenceSignature})),dates:['2026-06-01'],activeMinutes:120,sequenceStatus:'Observed'};
 const adjusted={...direct,evidenceSignature:'new-direct',estimatedLossKwh:10.005,expectedEnergyKwh:10.005,intervalLosses:direct.intervalLosses.map(p=>({...p,lossKwh:10.005,countedLossKwh:10.005,expectedKwh:10.005}))};
 await f.run('baseline',{issues:[a,b,h,direct],recurringIssues:[episode]});
 await f.run('retained',{issues:[a,b,c,h,adjusted],recurringIssues:[{...episode,evidenceSignature:'expanded',members:[...episode.members,{id:c.id,eventKey:c.eventKey,evidenceSignature:c.evidenceSignature}]}]});
 const baseline=await f.history.savedAnalysis('site','baseline',true);
 await f.service.saveReview(f.db,'site',episode.eventKey,'baseline',0,{...review.blankReview(episode,episode.evidenceSignature),status:'Dismissed',dismissalReason:'Duplicate finding',recurringId:episode.id,recurringBasis:baseline.reviewCalculationBasis,evidenceRunId:'baseline'},'parent decision','analyst');
 await f.service.saveReview(f.db,'site',b.eventKey,'baseline',0,{...review.blankReview(b,b.evidenceSignature),status:'Confirmed',evidenceRunId:'baseline'},'explicit exception','analyst');
 await f.service.saveReview(f.db,'site',direct.eventKey,'baseline',0,{...review.blankReview(direct,direct.evidenceSignature),status:'Confirmed',evidenceRunId:'baseline'},'retained numerical baseline','analyst');
 const note=await callPost(f.bulk,{siteId:'site',runId:'retained',operationId:crypto.randomUUID(),patch:{confirm:false,classification:'',note:'Additional context only'},items:[{issueId:a.id,evidenceSignature:a.evidenceSignature,baseVersion:0}]});assert.equal(note.status,200,await note.clone().text());
 const keys=[a,b,c,h,direct,episode].map(i=>i.eventKey),payload=await f.history.savedAnalysis('site','retained',true),before=plain(await f.service.effectiveReviews(f.db,'site','retained',payload,keys)),records=snapshot(f.db);
 assert.equal(before.find(r=>r.eventKey===h.eventKey).inheritedFrom.id,episode.id);assert.equal(before.find(r=>r.eventKey===h.eventKey).needsReview,false);assert.equal(before.find(r=>r.eventKey===h.eventKey).state.status,'Dismissed');
 assert.equal(before.find(r=>r.eventKey===a.eventKey).state.evidenceRunId,'baseline');assert.equal(before.find(r=>r.eventKey===b.eventKey).state.status,'Confirmed');assert.equal(before.find(r=>r.eventKey===c.eventKey),undefined);assert.equal(before.find(r=>r.eventKey===direct.eventKey).assessment.retained,true);
 assert.equal((await f.api.DELETE(f.request('baseline'))).status,200);
 assert.deepEqual(plain(await f.service.effectiveReviews(f.db,'site','retained',payload,keys)),before);
 assert.deepEqual(snapshot(f.db).issue_event_reviews,records.issue_event_reviews);assert.deepEqual(snapshot(f.db).issue_review_changes,records.issue_review_changes);
 const response=await f.reviews.GET(new Request('https://test/api?siteId=site&runId=baseline&issueId=episode&allowDeleted=true'));assert.equal(response.status,404);
 const future=await callPost(f.reviews,{siteId:'site',runId:'retained',issueId:c.id,baseVersion:0,state:{...review.blankReview(c,c.evidenceSignature),status:'Confirmed'},note:'Future reviews still work'});assert.equal(future.status,200);
});

function gate(){let enter,release;const reached=new Promise(r=>enter=r),wait=new Promise(r=>release=r);return {enter,release,reached,wait};}
test('actual single and bulk controllers fence delete-first requests held after real context load on a second connection',async t=>{
 for(const bulk of [false,true]){
  const f=await fixture(t);await f.run('target');const other=new LocalDatabase(f.filename,resolve('drizzle'));t.after(()=>other.close());
  const deletion=load('app/api/analysis-history/deletion.ts',{getDatabaseBinding:()=>other});
  const held=gate();t.after(()=>held.release());let contextLoaded=false;
  const name=bulk?'savedAnalysis':'reviewContext',original=bulk?f.history.savedAnalysis:f.service.reviewContext;
  const api=load(`app/api/issue-reviews/${bulk?'bulk/':''}route.ts`,{...f.bindings,...f.history,...f.service,blankReview:review.blankReview,[name]:async(...args)=>{const value=await original(...args);contextLoaded=true;held.enter();await held.wait;return value;}});
  const body=bulk?{siteId:'site',runId:'target',operationId:crypto.randomUUID(),items:[{issueId:'finding',evidenceSignature:'signature-finding',baseVersion:0}],patch:{confirm:true,classification:'',note:'late bulk'}}:{siteId:'site',runId:'target',issueId:'finding',baseVersion:0,state:{...review.blankReview(issue(),'signature-finding'),status:'Confirmed'},note:'late single'};
  const pending=callPost(api,body);await held.reached;assert.equal(contextLoaded,true);assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM issue_review_changes').get().n,0);
  await deletion.deleteSavedAnalysis('site','target');held.release();const response=await pending;assert.equal(response.status,409,await response.clone().text());assert.match((await response.json()).error,/analysis.*available/i);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM issue_event_reviews').get().n,0);assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM issue_review_changes').get().n,0);
 }
});

test('actual single and bulk review-first writes block another writer and survive subsequent reviewed-run deletion',async t=>{
 for(const bulk of [false,true]){
  const f=await fixture(t);await f.run('target');await f.run('retained');const other=new LocalDatabase(f.filename,resolve('drizzle'));t.after(()=>other.close());other.sqlite.exec('PRAGMA busy_timeout=1');
  const original=f.db.withSynchronousWrite.bind(f.db);let guarded=false;
  f.db.withSynchronousWrite=operation=>original(tx=>{assert.throws(()=>other.sqlite.exec('BEGIN IMMEDIATE'),/locked/);guarded=true;return operation(tx);});
  const body=bulk?{siteId:'site',runId:'target',operationId:crypto.randomUUID(),items:[{issueId:'finding',evidenceSignature:'signature-finding',baseVersion:0}],patch:{confirm:true,classification:'',note:'bulk first'}}:{siteId:'site',runId:'target',issueId:'finding',baseVersion:0,state:{...review.blankReview(issue(),'signature-finding'),status:'Confirmed'},note:'single first'};
  const response=await callPost(bulk?f.bulk:f.reviews,body);assert.equal(response.status,200,await response.clone().text());assert.equal(guarded,true);f.db.withSynchronousWrite=original;
  const before=snapshot(f.db);await f.deletion.deleteSavedAnalysis('site','target');assert.deepEqual(snapshot(f.db).issue_review_changes,before.issue_review_changes);
  const result=await f.service.effectiveReviews(f.db,'site','retained',await f.history.savedAnalysis('site','retained',true),['event-finding']);assert.equal(result[0].needsReview,false);assert.equal(result[0].state.status,'Confirmed');
 }
});

test('real publishJob and deletion serialize in both orders and stale same-attempt publication cannot resurrect a tombstone',async t=>{
 for(const publishFirst of [false,true]){
  const f=await fixture(t);await f.run('old');f.pointer('old');await f.run('new',{status:'processing',importId:'new-input'});
  const other=new LocalDatabase(f.filename,resolve('drizzle'));t.after(()=>other.close());
  other.sqlite.prepare("UPDATE analysis_jobs SET status='processing',stage='finalize',lease_token='live',lease_until=? WHERE attempt_id='new'").run(Date.now()+600000);
  const jobs=load('app/api/performance-summary/jobs.ts',{depotCleanupInProgress:async()=>false,analysisFailureMessage:String});
  const job=other.sqlite.prepare("SELECT * FROM analysis_jobs WHERE attempt_id='new'").get(),key='analysis/site/jobs/new/result.json',pointer=JSON.stringify({analysisRunId:'new',objectKey:key});
  if(publishFirst){await jobs.publishJob(other,job,'live',pointer,key,1);const response=await f.api.DELETE(f.request('old'));assert.equal(response.status,200);assert.equal((await response.json()).currentCleared,false);}
  else{
   const held=gate(),batch=other.batch.bind(other);t.after(()=>held.release());let waiting=false;
   other.batch=async statements=>{waiting=true;held.enter();await held.wait;return batch(statements);};
   const publication=jobs.publishJob(other,job,'live',pointer,key,1);await held.reached;assert.equal(waiting,true);
   const response=await f.api.DELETE(f.request('old'));assert.equal((await response.json()).currentCleared,true);held.release();await publication;other.batch=batch;
  }
  assert.equal(f.db.sqlite.prepare('SELECT summary FROM performance_summaries').get().summary,pointer);assert.equal(await f.availability.publishedAnalysisAvailable(f.db,'site','new-input',JSON.parse(pointer)),true);
  const before=snapshot(f.db);await assert.rejects(jobs.publishJob(other,{...job,id:'slot-old',attempt_id:'old',import_id:'input'},'expired',JSON.stringify({analysisRunId:'old',objectKey:'analysis/site/jobs/old/result.json'}),'analysis/site/jobs/old/result.json',1),/canceled/);assert.deepEqual(snapshot(f.db),before);
 }
});

test('public evidence loads recheck tombstones after awaited bucket I/O; internal baseline still reads retained bytes',async t=>{
 const f=await fixture(t);await f.run('target');const get=f.bucket.get.bind(f.bucket),held=gate();t.after(()=>held.release());let reached=false;
 f.bucket.get=async key=>{const object=await get(key);reached=true;held.enter();await held.wait;return object;};
 const request=f.history.savedAnalysis('site','target');await held.reached;assert.equal(reached,true);await f.deletion.deleteSavedAnalysis('site','target');held.release();await assert.rejects(request,/not found/);
 f.bucket.get=get;assert.equal((await f.history.reviewedAnalysisBaseline('site','target',true)).issueDatabase.analysisRunId,'target');
});

test('availability and history current markers require exact identity, not the newest key alias or an empty explicit ID',async t=>{
 const f=await fixture(t);await f.run('old');await f.run('new');
 const key='analysis/site/jobs/old/result.json';f.db.sqlite.prepare("UPDATE analysis_runs SET analysis_object_key=?,completed_at='2027' WHERE id='new'").run(key);
 f.pointer('old');
 assert.deepEqual((await f.history.listAnalysisHistory('site')).runs.filter(r=>r.is_current).map(r=>r.id),['old']);
 for(const [site,run,objectKey,expected] of [['site','old',key,true],['wrong','old',key,false],['site','missing',key,false],['site','old','other-key',false],['site','old','',false]])assert.equal(await f.availability.isCompletedAnalysisRun(f.db,site,run,objectKey),expected);
 for(const [site,importId,pointer] of [['wrong','input',{analysisRunId:'old',objectKey:key}],['site','wrong',{analysisRunId:'old',objectKey:key}],['site','input',{analysisRunId:'old',objectKey:'wrong'}],['site','input',{analysisRunId:'',objectKey:key}],['site','input',{analysisRunId:null,objectKey:key}],['site','input',{objectKey:key}]])assert.equal(await f.availability.publishedAnalysisAvailable(f.db,site,importId,pointer),false);
 f.pointer('old',{analysisRunId:undefined});f.db.sqlite.prepare("UPDATE analysis_runs SET status='deleted' WHERE id='new'").run();
 assert.equal((await f.history.listAnalysisHistory('site')).runs.some(r=>r.is_current),false,'A hidden alias must not make the legacy key uniquely current');
});

test('occurrence ownership inconsistencies refuse before changing any shared rows',async t=>{
 const f=await fixture(t);await f.run('target');f.pointer('target');identity(f.db,'shared');occurrence(f.db,'one','shared','target');
 for(const [sql,reset] of [
  ["UPDATE performance_issue_occurrences SET site_id='foreign'","UPDATE performance_issue_occurrences SET site_id='site'"],
  ["UPDATE performance_issue_occurrences SET import_id='foreign'","UPDATE performance_issue_occurrences SET import_id='input'"],
  ["UPDATE performance_issues SET site_id='foreign'","UPDATE performance_issues SET site_id='site'"],
  ["UPDATE performance_issue_occurrences SET issue_id='missing'","UPDATE performance_issue_occurrences SET issue_id='shared'"],
 ]){f.db.sqlite.exec(sql);const before=snapshot(f.db);const response=await f.api.DELETE(f.request('target'));assert.equal(response.status,409);assert.equal((await response.json()).code,'ANALYSIS_IN_USE');assert.deepEqual(snapshot(f.db),before);f.db.sqlite.exec(reset);}
});

test('deletion needs no result decoding, per-site writes or bucket reads, even when a retained result is unavailable',async t=>{
 const f=await fixture(t);await f.run('target');f.pointer('target');
 f.db.sqlite.prepare("UPDATE analysis_runs SET analysis_object_key='missing-result' WHERE id='target'").run();f.pointer('target');
 f.bucket.get=async()=>{throw Error('Deletion must not read result bytes');};f.site.recordAnalysis=()=>{throw Error('Deletion must not write site provenance');};
 const before=siteSnapshot(f),objects=objectHashes(f);assert.equal((await f.api.DELETE(f.request('target'))).status,200);assert.deepEqual(siteSnapshot(f),before);assert.deepEqual(objectHashes(f),objects);
});

test('public review list/detail recheck the target after assessment yields to deletion',async t=>{
 for(const detail of [false,true]){
  const f=await fixture(t);await f.run('target');const held=gate();t.after(()=>held.release());
  const api=load('app/api/issue-reviews/route.ts',{...f.bindings,...f.history,...f.service,blankReview:review.blankReview,effectiveReviews:async(...args)=>{const result=await f.service.effectiveReviews(...args);held.enter();await held.wait;return result;}});
  const pending=api.GET(new Request(`https://test/api?siteId=site&runId=target${detail?'&issueId=finding':''}`));await held.reached;await f.deletion.deleteSavedAnalysis('site','target');held.release();const response=await pending;assert.equal(response.status,404);assert.match(response.headers.get('cache-control'),/no-store/);
 }
});
