import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { drizzle } from "drizzle-orm/d1";
import { eq, desc, asc, inArray, sql } from "drizzle-orm";
import { webcrypto } from "node:crypto";
import * as sqliteCore from "drizzle-orm/sqlite-core";
import { LocalDatabase, LocalBucket } from "../selfhost/storage.mjs";
import { PerformanceStoreManager } from "../selfhost/performance-store.mjs";
import { loadSource , modelCapacityBindings} from "./source-module.mjs";
import { versionedStore, performanceBindings } from './performance-analysis-fixture.mjs';

const checkpointStorage = loadSource("app/api/performance-summary/checkpoint-storage.ts");
const storedData = async object => JSON.parse(JSON.stringify(await checkpointStorage.readCheckpoint({...object,body:new Response(object.text).body,json:async()=>JSON.parse(object.text)})));
const time = loadSource("app/telemetry-time.ts");
const causes = { ...time, ...loadSource("app/api/performance-summary/causes.ts", [], time) };
Object.assign(causes, loadSource("app/api/performance-summary/peer-comparison.ts", [], {...modelCapacityBindings(),...time}));
Object.assign(causes, loadSource("app/api/performance-summary/telemetry-events.ts", [], {...modelCapacityBindings(),...(causes)}), loadSource("app/meter-mapping.ts"));
const errors = loadSource("app/api/performance-summary/database-errors.ts");
const cleanup = loadSource("db/depot-performance-cleanup.ts");
const jobs = loadSource("app/api/performance-summary/jobs.ts", [], {...errors,...cleanup});
function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("drizzle").filter(f => f.endsWith(".sql")).sort())
    sqlite.exec(readFileSync(`drizzle/${file}`, "utf8"));
  const statement = (sql, values = []) => ({ sql, values,
    bind(...next) { return statement(sql, next); },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
    async first() { return sqlite.prepare(sql).get(...values) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...values) }; },
  });
  return { sqlite, prepare: statement, withSynchronousWrite(operation) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result=operation({first:(sql,...args)=>sqlite.prepare(sql).get(...args)||null,all:(sql,...args)=>sqlite.prepare(sql).all(...args),run:(sql,...args)=>sqlite.prepare(sql).run(...args)});sqlite.exec('COMMIT');return result; }
    catch(error){sqlite.exec('ROLLBACK');throw error;}
  }, async batch(items) {
    sqlite.exec("BEGIN");
    try { const results = []; for (const item of items) results.push(await item.run()); sqlite.exec("COMMIT"); return results; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  } };
}
async function start(db, id = "job") {
  const job = await jobs.getOrCreateJob(db, id, "site", "import");
  return { job, token: await jobs.claimJob(db, job) };
}

test("progress persists exact work counts and excludes concurrent workers", async () => {
  const db = database(); const { job, token } = await start(db);
  assert.equal(await jobs.claimJob(db, job), null);
  await jobs.reportProgress(db, job, token, "read", 250, 1000);
  const restored = await jobs.readJob(db, job.id);
  assert.equal(restored.percent, 6);
  assert.equal(restored.completed, 250);
  assert.equal(restored.attempt_id, job.attempt_id);
  await jobs.reportProgress(db, job, token, "equipment", 0, 76, true);
  const next = await jobs.readJob(db, job.id);
  assert.equal(next.percent, 25);
  assert.ok(await jobs.claimJob(db, next));
  await assert.rejects(jobs.reportProgress(db, job, token, "read", 999, 1000));
});

test("cancel during work is acknowledged at checkpoint; retry fences the old attempt", async () => {
  const db = database(); const { job, token } = await start(db);
  const canceling = await jobs.controlJob(db, "site", job.attempt_id, "cancel");
  assert.equal(canceling.status, "canceling");
  await assert.rejects(jobs.reportProgress(db, job, token, "equipment", 42, 76));
  await jobs.stopJob(db, job, token, new jobs.AnalysisStopped());
  assert.equal((await jobs.readJob(db, job.id)).status, "canceled");
  const retry = await jobs.controlJob(db, "site", job.attempt_id, "retry");
  assert.equal(retry.status, "processing");
  assert.notEqual(retry.attempt_id, job.attempt_id);
  assert.equal(await jobs.controlJob(db, "site", job.attempt_id, "cancel"), null);
  await assert.rejects(jobs.reportProgress(db, job, token, "save", 999, 1000));
  assert.equal(await jobs.controlJob(db, "other-site", retry.attempt_id, "cancel"), null);
});

test("expired requests release locks and acknowledge abandoned cancellation", async () => {
  for (const canceled of [false, true]) {
    const db = database(); const { job } = await start(db);
    if (canceled) await jobs.controlJob(db, "site", job.attempt_id, "cancel");
    db.sqlite.prepare("UPDATE analysis_jobs SET lease_until = 1 WHERE id = ?").run(job.id);
    const recovered = await jobs.readJob(db, job.id);
    assert.equal(recovered.status, canceled ? "canceled" : "interrupted");
    assert.equal(recovered.lease_token, "");
  }
});

test("publication and cancellation are atomic; partial results never replace saved results", async () => {
  for (const cancelFirst of [false, true]) {
    const db = database(); const { job, token } = await start(db);
    db.sqlite.prepare("INSERT INTO performance_summaries VALUES (?, ?, ?, ?)").run("old", "site", "old-pointer", "today");
    if (cancelFirst) {
      await jobs.controlJob(db, "site", job.attempt_id, "cancel");
      await assert.rejects(jobs.publishJob(db, job, token, "new-pointer", "new-object", 123));
      assert.equal(db.sqlite.prepare("SELECT summary FROM performance_summaries").get().summary, "old-pointer");
      assert.notEqual((await jobs.readJob(db, job.id)).percent, 100);
    } else {
      await jobs.publishJob(db, job, token, "new-pointer", "new-object", 123);
      const finished = await jobs.controlJob(db, "site", job.attempt_id, "cancel");
      assert.equal(finished.status, "completed");
      assert.equal(finished.percent, 100);
      assert.equal(db.sqlite.prepare("SELECT summary FROM performance_summaries").get().summary, "new-pointer");
    }
  }
});

test('revision publication guard runs synchronously at transaction entry and retains a completed stale run', async()=>{
  const db=database(),{job,token}=await start(db);
  db.sqlite.prepare("INSERT INTO performance_summaries VALUES (?, ?, ?, ?)").run('newer','site','newer-pointer','today');
  db.sqlite.prepare("INSERT INTO analysis_runs (id,site_id,import_id,parser_version,model_revision,status,analysis_object_key) VALUES (?, 'site','import',28,'model','processing','')").run(job.attempt_id);
  let revision=1,checks=0,atBatch=false;
  const batch=db.batch.bind(db);
  db.batch=items=>{atBatch=true;assert.equal(checks,1);assert.equal(revision,2);return batch(items);};
  revision=2;
  const result=await jobs.publishJob(db,job,token,'old-pointer','immutable-result',7,()=>{assert.equal(atBatch,false);checks++;queueMicrotask(()=>{assert.equal(atBatch,true,'no await may separate revision guard from transaction start');});return revision===1;});
  assert.equal(result.published,false);
  assert.equal(db.sqlite.prepare('SELECT summary FROM performance_summaries').get().summary,'newer-pointer');
  assert.equal(db.sqlite.prepare('SELECT status FROM analysis_runs WHERE id=?').get(job.attempt_id).status,'completed');
  assert.equal((await jobs.readJob(db,job.id)).status,'completed');
});

// Integration: use the real CSV parser, detector, persistence, leases and result
// publication across multiple HTTP requests, with SQLite/R2 test adapters.
export async function analysisApi(csvText, equipment, record, manifest = null, store = null, adapters = {}) {
  const db = adapters.db || database(); const objects = new Map([[record.objectKey, { text: csvText }]]);
  const io = { gets: [], puts: [], deletes: [] };
  const bucket = adapters.bucket || {
    async head(key) { const o = objects.get(key); return o ? { ...o, etag: key } : null; },
    async get(key) { io.gets.push(key); const o = objects.get(key); return o ? { ...o, etag: key, body: new Response(o.text).body,
      text: async () => o.text, json: async () => JSON.parse(o.text) } : null; },
    async put(key, text, options = {}) { io.puts.push(key); objects.set(key, { text, ...options }); return { etag: key }; },
    async delete(key) { for(const item of Array.isArray(key)?key:[key]){io.deletes.push(item);objects.delete(item);} },
  };
  const tables = { sites: [{ id: record.siteId }], imports: [record], equipment };
  const orm = { select() { return { from(table) {
    const rows = table === "pointers" ? db.sqlite.prepare("SELECT import_id AS importId, site_id AS siteId, summary FROM performance_summaries").all() : tables[table];
    return { where: () => Object.assign(Promise.resolve(rows), { orderBy: () => ({ limit: async () => rows }), limit: async () => rows }) };
  } }; } };
  const persistence = loadSource("app/api/performance-summary/persistence.ts", [], errors);
  const history = loadSource("app/data-history.ts", [], {...time,...loadSource("app/csv-stream.ts")});
  const performanceData = loadSource('app/api/performance-data/analysis.ts',[],performanceBindings(store));
  const api = loadSource("app/api/performance-summary/route.ts", ["buildSummary", "buildAnalysis", "alignWithArrayModel"], {...modelCapacityBindings(),...({
    ...performanceData, ...loadSource("app/api/performance-summary/checkpoint-storage.ts"), ...history, readManifest:async()=>manifest, ...errors, ...jobs, ...persistence, ...loadSource("app/issue-review.ts"), ...loadSource("app/api/performance-summary/analysis-storage.ts"), currentAnalysisInput:async()=>store ? performanceData.performanceAnalysisInput(record.siteId) : record, getDatabaseBinding: () => db, getBucketBinding: () => bucket, getDb: () => orm,
    ...causes, monthlyLosses: loadSource("app/issue-periods.ts", [], time).monthlyLosses,
    siteSettings: "sites", equipmentAssets: "equipment", telemetryImports: "imports", performanceSummaries: "pointers", eq() {}, desc() {}, ...adapters.bindings,
  })});
  let requested = false;
  const request = () => {
    if (!requested) { requested=true; return api.POST(new Request('https://test/api/performance-summary',{method:'POST',body:JSON.stringify({siteId:record.siteId,action:'reanalyze'})})); }
    return api.GET(new Request(`https://test/api/performance-summary?siteId=${record.siteId}`));
  };
  return { db, objects, api, request, io, bucket, performanceData };
}

async function canonicalFixture(t) {
  const equipment=[{id:'meter',name:'Meter',type:'revenue_meter',externalId:'meter',aliases:'[]'},
    {id:'inv',name:'Inverter',type:'inverter',parentId:'meter',externalId:'inv',acRatedCapacityKw:'100',aliases:'[]'},
    {id:'modules',name:'Modules',type:'module_group',parentId:'inv',externalId:'modules',moduleRatedCapacityW:'400',quantity:250,aliases:'[]'}];
  const rows=[];
  for(const hour of [10,11,12,13])for(const [id,measurement,value,unit] of [['meter','Energy',hour===11?0:40,'kWh'],['inv','Energy',hour===11?0:40,'kWh'],['meter','POA irradiance',600,'W/m2'],['@site','Expected Production',40,'kWh']])rows.push({timestamp:`2026-06-01T${hour}:00:00.000Z`,channel:{id:JSON.stringify([id,measurement]),equipmentId:id,measurement,unit},value});
  let store=versionedStore(rows),adapters={},commit,reopen;
  if(t) {
    const root=mkdtempSync(join(tmpdir(),'publication-'));
    const schema=loadSource('db/schema.ts',[],{sql,...sqliteCore});
    let db,bucket,manager,orm;
    const open=()=>{
      db=new LocalDatabase(join(root,'shared.sqlite'),'drizzle');bucket=new LocalBucket(db,join(root,'objects'));
      manager=new PerformanceStoreManager(join(root,'performance'));store=manager.site('site');orm=drizzle(db);
      adapters={db,bucket,bindings:{...schema,eq,desc,getDb:()=>orm}};
    };
    const close=()=>{manager.close();db.close();};
    open();
    t.after(()=>{close();rmSync(root,{recursive:true,force:true});});
    await orm.insert(schema.siteSettings).values({id:'site',name:'Synthetic publication test'});
    await orm.insert(schema.equipmentAssets).values(equipment.map(asset=>({...asset,siteId:'site'})));
    commit=async readings=>{
      const preview=await store.stage({source:'csv',fileName:'synthetic.csv',timezone:'UTC',intervalMinutes:60,modelRevision:'fixture'},readings);
      return store.commit(preview.stageId,{previewToken:preview.previewToken,approveOverlap:true,modelRevision:'fixture',actor:'test'});
    };
    await commit(rows);
    reopen=async()=>{
      close();open();
      const assets=await orm.select().from(schema.equipmentAssets).where(eq(schema.equipmentAssets.siteId,'site'));
      const data=loadSource('app/api/performance-data/analysis.ts',[],performanceBindings(store)),record=data.performanceAnalysisInput('site');
      return {...await analysisApi('',assets,record,null,store,adapters),store,data,record,equipment:assets,rows,commit,reopen};
    };
  }
  const data=loadSource('app/api/performance-data/analysis.ts',[],performanceBindings(store)),record=data.performanceAnalysisInput('site');
  return {...await analysisApi('',equipment,record,null,store,adapters),store,data,record,equipment,rows,commit,reopen};
}
async function finish(f) {
  let result;
  for(let i=0;i<16;i++){const response=await f.request();result=await response.json();assert.ok(response.ok,JSON.stringify(result));if(response.status!==202)return result;}
  assert.fail(`Analysis did not settle: ${JSON.stringify(result)}`);
}

const browse = (f,query='') => f.api.GET(new Request(`https://test/api/performance-summary?siteId=site${query}`));
const control = (f,action,attemptId) => f.api.POST(new Request('https://test/api/performance-summary',{
  method:'POST',body:JSON.stringify({siteId:'site',action,attemptId}),
}));
async function terminalize(f,attemptId,status) {
  const active=await browse(f),progress=await active.json();
  assert.equal(active.status,202,JSON.stringify(progress));
  assert.equal(progress.progress.attemptId,attemptId);
  assert.equal(progress.progress.stage,'equipment');
  if(status==='canceled') return control(f,'cancel',attemptId);
  if(status==='failed') {
    const get=f.bucket.get.bind(f.bucket);
    f.bucket.get=async key=>{if(key.endsWith(`/${attemptId}/summary.json`))throw new Error('Injected retained checkpoint read failure');return get(key);};
    try{return await browse(f);}finally{f.bucket.get=get;}
  }
  const job=f.db.sqlite.prepare('SELECT * FROM analysis_jobs WHERE attempt_id=?').get(attemptId);
  assert.ok(await jobs.claimJob(f.db,job));
  f.db.sqlite.prepare('UPDATE analysis_jobs SET lease_until=1 WHERE attempt_id=?').run(attemptId);
  return browse(f);
}
function publicationClients(f) {
  const review=loadSource('app/issue-review.ts');
  const bindings={...modelCapacityBindings(),...f.data,...review,...checkpointStorage,getDatabaseBinding:()=>f.db,getBucketBinding:()=>f.bucket};
  const saved=loadSource('app/api/analysis-history/service.ts',[],bindings);
  const service=loadSource('app/api/issue-reviews/service.ts',[],{...bindings,...saved});
  const reviews=loadSource('app/api/issue-reviews/route.ts',[],{...bindings,...saved,...service,blankReview:review.blankReview});
  return {saved,reviews};
}
async function retainedSnapshot(f,runId) {
  const bytes=async name=>Buffer.from(await(await f.bucket.get(`analysis/site/jobs/${runId}/${name}.json`)).arrayBuffer());
  return {
    result:await bytes('result'),index:await bytes('review-index'),
    pointer:f.db.sqlite.prepare('SELECT * FROM performance_summaries').all(),
    run:f.db.sqlite.prepare('SELECT * FROM analysis_runs WHERE id=?').get(runId),
    occurrences:f.db.sqlite.prepare('SELECT * FROM performance_issue_occurrences WHERE analysis_run_id=? ORDER BY id').all(runId),
    reviews:f.db.sqlite.prepare('SELECT * FROM issue_event_reviews ORDER BY id').all(),
    audit:f.db.sqlite.prepare('SELECT * FROM issue_review_changes ORDER BY id').all(),
  };
}

for(const status of ['canceled','failed','interrupted'])test(`published current result survives a ${status} same-input rerun with editable reviews and retry controls`,async t=>{
  const f=await canonicalFixture(t),first=await finish(f),runId=first.issueDatabase.analysisRunId;
  assert.equal(first.hasData,true);const issue=first.analysis.issues[0];assert.ok(issue);
  const {saved,reviews}=publicationClients(f);
  const reviewPath=`https://test/api/issue-reviews?siteId=site&runId=${runId}&issueId=${encodeURIComponent(issue.id)}`;
  const initialResponse=await reviews.GET(new Request(reviewPath)),initialReview=await initialResponse.json();
  assert.equal(initialResponse.status,200,JSON.stringify(initialReview));
  const save=async(version,state,note)=>{
    const response=await reviews.POST(new Request('https://test/api/issue-reviews',{method:'POST',body:JSON.stringify({siteId:'site',runId,issueId:issue.id,baseVersion:version,state,note})}));
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
  };
  await save(0,{...initialReview.review.state,status:'Confirmed'},'Keep the published decision.');
  const before=await retainedSnapshot(f,runId);
  const started=await control(f,'reanalyze'),start=await started.json();assert.equal(started.status,202);
  const attemptId=start.progress.attemptId;assert.notEqual(attemptId,runId);
  const stopped=await terminalize(f,attemptId,status),stoppedData=await stopped.json();
  assert.equal(stopped.status,200,JSON.stringify(stoppedData));
  // A failed/expired GET itself restores the published view; cancellation POST
  // remains an attempt-control response, and the next browse restores it.
  if(status!=='canceled')assert.equal(stoppedData.hasData,true,JSON.stringify(stoppedData));
  const job=await jobs.readJob(f.db,f.db.sqlite.prepare('SELECT id FROM analysis_jobs WHERE attempt_id=?').get(attemptId).id);
  assert.equal(job.status,status);
  const jobRows=f.db.sqlite.prepare('SELECT * FROM analysis_jobs ORDER BY id').all();
  for(let count=0;count<2;count++) {
    const response=await browse(f),current=await response.json();
    assert.equal(response.status,200);assert.equal(current.hasData,true,JSON.stringify(current));
    assert.equal(current.processing,false);assert.equal(current.progress,undefined);assert.equal(current.analysisRequired,undefined);
    assert.equal(current.issueDatabase.analysisRunId,runId);
    assert.equal(current.dataFreshness.status,'current');
    assert.deepEqual(current.analysis,first.analysis);
    assert.deepEqual(current.lastAttempt,JSON.parse(JSON.stringify(jobs.jobProgress(job))));
    assert.match(response.headers.get('cache-control'),/no-store/);
  }
  assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM analysis_jobs ORDER BY id').all(),jobRows,'browsing must not create or restart work');
  assert.deepEqual(await retainedSnapshot(f,runId),before,'browsing and terminal attempts must not rewrite publication/evidence/reviews');
  const history=await saved.listAnalysisHistory('site');assert.equal(history.runs.find(r=>r.id===runId).is_current,true);
  const detail=await(await browse(f,`&issueId=${encodeURIComponent(issue.id)}`)).json();assert.equal(detail.issue.eventKey,issue.eventKey);assert.ok(detail.issue.evidence);
  for(const query of [`&progressOnly=1&attemptId=${attemptId}`,`&attemptId=${attemptId}`]) {
    const progress=await(await browse(f,query)).json();assert.equal(progress.hasData,false);assert.equal(progress.progress.status,status);assert.equal(progress.progress.attemptId,attemptId);
  }
  const editable=await(await reviews.GET(new Request(reviewPath))).json();assert.equal(editable.review.state.status,'Confirmed');
  await save(editable.review.version,{...editable.review.state,classification:'Fuse Failure'},'Still editable as the current result.');
  const updated=await(await reviews.GET(new Request(reviewPath))).json();assert.equal(updated.review.version,2);assert.equal(updated.review.state.classification,'Fuse Failure');
  const updatedSnapshot=await retainedSnapshot(f,runId);
  const retry=await control(f,'retry',attemptId),retryData=await retry.json();assert.equal(retry.status,202);
  if(status==='canceled')assert.notEqual(retryData.progress.attemptId,attemptId);
  else {assert.equal(retryData.progress.attemptId,attemptId);assert.equal(retryData.progress.stage,'equipment');}
  const resumed=await browse(f);assert.equal(resumed.status,202);assert.equal((await resumed.json()).processing,true);
  const replacement=await finish(f);assert.equal(replacement.hasData,true);assert.equal(replacement.issueDatabase.analysisRunId,retryData.progress.attemptId);assert.equal(replacement.lastAttempt,undefined);
  const after=await retainedSnapshot(f,runId);
  for(const key of ['result','index','run','occurrences','reviews','audit'])assert.deepEqual(after[key],updatedSnapshot[key]);
  const finalHistory=await saved.listAnalysisHistory('site');assert.equal(finalHistory.runs.find(r=>r.id===runId).is_current,false);assert.equal(finalHistory.runs.find(r=>r.id===replacement.issueDatabase.analysisRunId).is_current,true);
});

for(const change of ['revision','model'])test(`published snapshot remains current after a failed ${change} rerun until successful publication`,async t=>{
  const f=await canonicalFixture(t),first=await finish(f),runId=first.issueDatabase.analysisRunId,before=await retainedSnapshot(f,runId);
  if(change==='revision')await f.commit(f.rows.map(r=>r.channel.measurement==='Energy'&&r.value===40?{...r,value:30}:r));
  else f.db.sqlite.prepare("UPDATE equipment_assets SET ac_rated_capacity_kw='110' WHERE id='inv'").run();
  const start=await(await control(f,'reanalyze')).json(),attemptId=start.progress.attemptId;
  await terminalize(f,attemptId,'failed');
  const current=await(await browse(f)).json();assert.equal(current.hasData,true,JSON.stringify(current));assert.equal(current.issueDatabase.analysisRunId,runId);assert.equal(current.lastAttempt.attemptId,attemptId);assert.equal(current.lastAttempt.status,'failed');
  assert.equal(current.dataFreshness.status,change==='revision'?'older':'current');assert.deepEqual(await retainedSnapshot(f,runId),before);
  assert.equal((await publicationClients(f).saved.listAnalysisHistory('site')).runs.find(r=>r.id===runId).is_current,true);
  const retry=await(await control(f,'retry',attemptId)).json();assert.equal(retry.progress.attemptId,attemptId);
  const replacement=await finish(f);assert.equal(replacement.issueDatabase.analysisRunId,attemptId);assert.equal(replacement.lastAttempt,undefined);assert.equal(replacement.dataFreshness.status,'current');
  assert.notEqual(f.db.sqlite.prepare('SELECT summary FROM performance_summaries').get().summary,before.pointer[0].summary);
  const after=await retainedSnapshot(f,runId);for(const key of ['result','index','run','occurrences','reviews','audit'])assert.deepEqual(after[key],before[key]);
});

test('canceling work keeps polling; expired cancellation restores publication without requiring the stopped input checkpoint',async t=>{
  const f=await canonicalFixture(t),first=await finish(f),runId=first.issueDatabase.analysisRunId;
  const started=await(await control(f,'reanalyze')).json(),attemptId=started.progress.attemptId;
  const job=f.db.sqlite.prepare('SELECT * FROM analysis_jobs WHERE attempt_id=?').get(attemptId);
  assert.ok(await jobs.claimJob(f.db,job));
  const cancel=await control(f,'cancel',attemptId),cancelData=await cancel.json();assert.equal(cancel.status,202);assert.equal(cancelData.progress.status,'canceling');
  const waiting=await browse(f),waitingData=await waiting.json();assert.equal(waiting.status,202);assert.equal(waitingData.hasData,false);assert.equal(waitingData.progress.status,'canceling');assert.equal(waitingData.lastAttempt,undefined);
  f.db.sqlite.prepare('UPDATE analysis_jobs SET lease_until=1 WHERE attempt_id=?').run(attemptId);
  await f.bucket.delete(`analysis/site/jobs/${attemptId}/input.json`);
  const restored=await(await browse(f)).json();assert.equal(restored.hasData,true);assert.equal(restored.issueDatabase.analysisRunId,runId);assert.equal(restored.lastAttempt.status,'canceled');assert.equal(restored.lastAttempt.stage,'read');
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n,1);
});

test('a completed but unpublished rerun never displaces the published browse identity',async t=>{
  const f=await canonicalFixture(t),first=await finish(f),runId=first.issueDatabase.analysisRunId,before=await retainedSnapshot(f,runId);
  const started=await(await control(f,'reanalyze')).json(),attemptId=started.progress.attemptId;
  const put=f.bucket.put.bind(f.bucket);
  f.bucket.put=async(key,...args)=>{
    const result=await put(key,...args);
    if(key===`analysis/site/jobs/${attemptId}/result.json`)await f.commit(f.rows.map(r=>r.channel.measurement==='Energy'&&r.value===40?{...r,value:30}:r));
    return result;
  };
  const completed=await finish(f);assert.equal(completed.publicationSkipped,true);assert.equal(completed.progress.status,'completed');
  const current=await(await browse(f)).json();assert.equal(current.hasData,true);assert.equal(current.issueDatabase.analysisRunId,runId);assert.equal(current.lastAttempt,undefined);assert.equal(current.dataFreshness.status,'older');
  assert.deepEqual(await retainedSnapshot(f,runId),before);
  const historical=await(await browse(f,`&attemptId=${attemptId}`)).json();assert.equal(historical.issueDatabase.analysisRunId,attemptId);
  const history=await publicationClients(f).saved.listAnalysisHistory('site');assert.equal(history.runs.find(r=>r.id===runId).is_current,true);assert.equal(history.runs.find(r=>r.id===attemptId).is_current,false);
});

for(const status of ['canceled','failed','interrupted'])test(`no published snapshot keeps ${status} attempt progress and offers explicit current-input analysis without creating jobs`,async t=>{
  const f=await canonicalFixture(t),started=await(await f.request()).json(),attemptId=started.progress.attemptId;
  await terminalize(f,attemptId,status);
  const rows=f.db.sqlite.prepare('SELECT * FROM analysis_jobs ORDER BY id').all();
  for(let count=0;count<2;count++) {
    const response=await browse(f),result=await response.json();assert.equal(response.status,200);assert.equal(result.hasData,false);assert.equal(result.processing,false);assert.equal(result.progress.status,status);assert.equal(result.progress.attemptId,attemptId);assert.equal(result.lastAttempt,undefined);
    assert.equal(result.analysisRequired,true);assert.match(response.headers.get('cache-control'),/no-store/);
  }
  for(const query of [`&attemptId=${attemptId}`,`&progressOnly=1&attemptId=${attemptId}`]) {
    const result=await(await browse(f,query)).json();assert.equal(result.progress.attemptId,attemptId);assert.equal(result.progress.status,status);assert.equal(result.analysisRequired,undefined,'Explicit checkpoint/progress reads must not offer analysis of different current inputs');
  }
  assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM analysis_jobs ORDER BY id').all(),rows);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM performance_summaries').get().n,0);
});

for(const status of ['canceled','failed','interrupted'])test(`a ${status} first attempt cannot advertise fresh analysis when the current input is unavailable`,async t=>{
  const f=await canonicalFixture(t),started=await(await f.request()).json();
  await terminalize(f,started.progress.attemptId,status);
  const before=f.db.sqlite.prepare('SELECT * FROM analysis_jobs ORDER BY id').all();
  // Simulate current-input discovery finding no available source. The stopped
  // attempt and its checkpoint remain intact in the real shared DB/bucket.
  const missing=await analysisApi('',f.equipment,f.record,null,f.store,{db:f.db,bucket:f.bucket,bindings:{currentAnalysisInput:async()=>undefined}});
  const response=await browse(missing),result=await response.json();assert.equal(response.status,200);assert.equal(result.hasData,false);assert.equal(result.analysisRequired,undefined);assert.match(result.reason,/No telemetry import/);
  assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM analysis_jobs ORDER BY id').all(),before);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM performance_summaries').get().n,0);
});

for(const status of ['processing','canceling'])test(`active first ${status} analysis does not advertise a competing fresh start`,async t=>{
  const f=await canonicalFixture(t),started=await(await f.request()).json();
  if(status==='canceling'){
    const job=f.db.sqlite.prepare('SELECT * FROM analysis_jobs WHERE attempt_id=?').get(started.progress.attemptId);assert.ok(await jobs.claimJob(f.db,job));
    await control(f,'cancel',started.progress.attemptId);
  }
  const response=await browse(f),result=await response.json();assert.equal(response.status,202);assert.equal(result.hasData,false);assert.equal(result.progress.status,status);assert.equal(result.analysisRequired,undefined);assert.equal(result.progress.attemptId,started.progress.attemptId);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n,1);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM performance_summaries').get().n,0);
});

test('explicit start persists the pinned input before a worker can claim the new attempt',async()=>{
  const f=await canonicalFixture(),put=f.bucket.put.bind(f.bucket);let checked=false;
  f.bucket.put=async(key,...args)=>{
    if(key.endsWith('/input.json')&&!checked){
      checked=true;
      assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM analysis_jobs WHERE status='processing'").get().n,0,'an incomplete input checkpoint must not be published as runnable');
      const browse=await(await f.api.GET(new Request('https://test/api/performance-summary?siteId=site'))).json();assert.equal(browse.analysisRequired,true);
    }
    return put(key,...args);
  };
  const response=await f.request();assert.equal(response.status,202);assert.equal(checked,true);
});

test('retry of a canceled read pins the original dataset before publishing its replacement attempt',async()=>{
  const f=await canonicalFixture(),started=await(await f.request()).json(),original=started.progress.attemptId;
  await f.api.POST(new Request('https://test/api/performance-summary',{method:'POST',body:JSON.stringify({siteId:'site',attemptId:original,action:'cancel'})}));
  f.store.replace(f.rows.map(r=>({...r,value:r.value===40?80:r.value})));
  const put=f.bucket.put.bind(f.bucket);
  f.bucket.put=async(key,...args)=>{if(key.endsWith('/input.json'))assert.equal(f.db.sqlite.prepare('SELECT attempt_id FROM analysis_jobs').get().attempt_id,original);return put(key,...args);};
  const retried=await(await f.api.POST(new Request('https://test/api/performance-summary',{method:'POST',body:JSON.stringify({siteId:'site',attemptId:original,action:'retry'})}))).json();
  const replacement=retried.progress.attemptId;assert.notEqual(replacement,original);f.bucket.put=put;
  const input=await storedData(f.objects.get(`analysis/site/jobs/${replacement}/input.json`));assert.equal(input.record.id,f.record.id);assert.equal(input.provenance,null);
  await f.request();assert.equal(f.store.analysis(replacement).revision,1);
  assert.equal((await finish(f)).publicationSkipped,true);
});

test('browsing never creates a run; read and retry retain their revision/model checkpoint through new imports',async()=>{
  const f=await canonicalFixture();
  const browse=await(await f.api.GET(new Request('https://test/api/performance-summary?siteId=site'))).json();
  assert.equal(browse.analysisRequired,true);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n,0);
  const requested=await(await f.request()).json(),attempt=requested.progress.attemptId;
  // A new import lands even before the first read request. POST already pinned the input.
  f.store.replace(f.rows.map(r=>({...r,value:r.channel.measurement==='Energy'?999:r.value})));
  f.equipment[1].acRatedCapacityKw='900';
  assert.equal((await f.request()).status,202);
  const root=`analysis/site/jobs/${attempt}`,input=await storedData(f.objects.get(`${root}/input.json`));
  assert.equal(input.provenance.revision,1);assert.equal(input.equipment[1].acRatedCapacityKw,'100');
  const summary=loadSource('app/api/performance-summary/analysis-storage.ts').unpackSummary(await storedData(f.objects.get(`${root}/summary.json`)));
  assert.equal(summary.totalEnergyKwh,120);
  f.db.sqlite.prepare("UPDATE analysis_jobs SET status='failed',error='simulated interruption'").run();
  const retry=await(await f.api.POST(new Request('https://test/api/performance-summary',{method:'POST',body:JSON.stringify({siteId:'site',attemptId:attempt,action:'retry'})}))).json();
  assert.equal(retry.progress.attemptId,attempt);
  const completed=await finish(f);assert.equal(completed.publicationSkipped,true);assert.equal(completed.processing,false);
  const saved=await storedData(f.objects.get(`${root}/result.json`)),index=await storedData(f.objects.get(`${root}/review-index.json`));
  assert.deepEqual(saved.provenance,input.provenance);assert.deepEqual(index.provenance,input.provenance);assert.deepEqual(saved.methodology.inputProvenance,input.provenance);
  assert.equal(saved.importId,f.record.id);assert.equal(saved.methodology.datasetRevision,1);assert.equal(saved.summary.totalEnergyKwh,120);
  assert.equal(f.db.sqlite.prepare('SELECT status FROM analysis_runs WHERE id=?').get(attempt).status,'completed');
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM performance_summaries').get().n,0);
  const current=await(await f.request()).json();assert.equal(current.analysisRequired,true);assert.equal(current.processing,undefined);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n,1);
  const historical=await(await f.api.GET(new Request(`https://test/api/performance-summary?siteId=site&attemptId=${attempt}`))).json();
  assert.equal(historical.issueDatabase.analysisRunId,attempt);assert.equal(historical.dataFreshness.status,'older');
});

test('late import during final result write keeps newer pointer while completing immutable history',async()=>{
  const f=await canonicalFixture();
  await f.request();await f.request();
  f.db.sqlite.prepare('INSERT INTO performance_summaries VALUES (?,?,?,?)').run('newer','site','newer-pointer','now');
  const put=f.bucket.put.bind(f.bucket);
  f.bucket.put=async(key,...args)=>{const result=await put(key,...args);if(key.endsWith('/result.json'))f.store.replace(f.rows.map(r=>({...r,value:r.value===40?50:r.value})));return result;};
  const completed=await finish(f);
  assert.equal(completed.publicationSkipped,true);assert.equal(f.db.sqlite.prepare('SELECT summary FROM performance_summaries').get().summary,'newer-pointer');
  assert.equal(f.db.sqlite.prepare('SELECT status FROM analysis_runs').get().status,'completed');
  assert.equal((await storedData([...f.objects].find(([k])=>k.endsWith('/result.json'))[1])).provenance.revision,1);
});

test('freshness, history browsing and reanalysis never rewrite completed evidence, event identities, or analyst reviews',async()=>{
  const f=await canonicalFixture(),first=await finish(f),runId=first.issueDatabase.analysisRunId,root=`analysis/site/jobs/${runId}`;
  assert.equal(first.dataFreshness.status,'current');
  const result=await storedData(f.objects.get(`${root}/result.json`)),issue=result.analysis.issues[0];assert.ok(issue);
  const review=loadSource('app/issue-review.ts'),reviews=loadSource('app/api/issue-reviews/service.ts',[],review);
  await reviews.saveReview(f.db,'site',issue.eventKey,runId,0,{...review.blankReview(issue,issue.evidenceSignature),status:'Confirmed'},'Retained analyst note','analyst');
  const beforeResult=f.objects.get(`${root}/result.json`).text,beforeIndex=f.objects.get(`${root}/review-index.json`).text;
  const beforeReview=JSON.stringify(f.db.sqlite.prepare('SELECT * FROM issue_event_reviews').all()),beforeAudit=JSON.stringify(f.db.sqlite.prepare('SELECT * FROM issue_review_changes').all());
  f.store.replace(f.rows.map(r=>r.channel.equipmentId==='inv'&&r.timestamp.includes('13:00')?{...r,value:30}:r));
  const freshness=loadSource('app/api/analysis-freshness/route.ts',[],{...f.data,getDatabaseBinding:()=>f.db});
  assert.equal((await(await freshness.GET(new Request(`https://test/api/analysis-freshness?siteId=site&runId=${runId}`))).json()).status,'older');
  const saved=loadSource('app/api/analysis-history/service.ts',[],{...modelCapacityBindings(),...f.data,...review,...checkpointStorage,getDatabaseBinding:()=>f.db,getBucketBinding:()=>f.bucket});
  const history=loadSource('app/api/analysis-history/route.ts',[],{...f.data,...saved,...checkpointStorage});
  const loaded=await(await history.GET(new Request(`https://test/api/analysis-history?siteId=site&runId=${runId}`))).json();
  assert.equal(loaded.dataFreshness.status,'older');assert.equal(loaded.analysis.issues[0].eventKey,issue.eventKey);assert.equal(loaded.analysis.issues[0].evidenceSignature,issue.evidenceSignature);
  const current=await(await f.request()).json();assert.equal(current.issueDatabase.analysisRunId,runId);assert.equal(current.dataFreshness.status,'older');
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n,1);
  await f.api.POST(new Request('https://test/api/performance-summary',{method:'POST',body:JSON.stringify({siteId:'site',action:'reanalyze'})}));
  const second=await finish(f);assert.notEqual(second.issueDatabase.analysisRunId,runId);assert.equal(second.dataFreshness.status,'current');
  assert.deepEqual(f.objects.get(`${root}/result.json`).text,beforeResult);assert.deepEqual(f.objects.get(`${root}/review-index.json`).text,beforeIndex);
  assert.equal(JSON.stringify(f.db.sqlite.prepare('SELECT * FROM issue_event_reviews').all()),beforeReview);assert.equal(JSON.stringify(f.db.sqlite.prepare('SELECT * FROM issue_review_changes').all()),beforeAudit);
  assert.deepEqual(f.store.analysis(runId),result.provenance);
});

test("staged analysis resumes across requests and serves only the completed saved JSON", async () => {
  const equipment = [
    { id: "meter", name: "Meter", type: "revenue_meter", parentId: null, externalId: "meter", aliases: "[]" },
    { id: "inv", name: "Inverter", type: "inverter", parentId: "meter", externalId: "inv", acRatedCapacityKw: "100", aliases: "[]" },
  ];
  const rows = ["time,meter,inv,sun"];
  for (let i = 0; i < 48; i++) rows.push(`2026-01-${i < 24 ? "01" : "02"}T${String(i % 24).padStart(2,"0")}:00:00,${i % 3 ? 40 : 0},${i % 3 ? 40 : 0},600`);
  const record = { id: "import", siteId: "site", objectKey: "upload.csv", rowCount: 48, timezone: "UTC", validation: JSON.stringify({ interval: "Hourly" }),
    mapping: JSON.stringify({ roles: { timestamp: "time" }, equipment: { signals: [
      { column: "meter", equipmentId: "meter", measurement: "Energy" }, { column: "inv", equipmentId: "inv", measurement: "Energy" },
      { column: "sun", equipmentId: "meter", measurement: "POA irradiance" }] } }) };
  const fixture = await analysisApi(rows.join("\n"), equipment, record);
  const seen = []; let result;
  for (let i = 0; i < 20; i++) {
    const response = await fixture.request(); result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    if (response.status !== 202) break;
    seen.push(result.progress.stage);
    assert.equal(fixture.db.sqlite.prepare("SELECT COUNT(*) AS count FROM performance_summaries").get().count, result.progress.status === "completed" ? 1 : 0);
  }
  assert.ok(result.hasData, JSON.stringify(result));
  assert.deepEqual(seen, ["read", "equipment", "reconcile", "save", "finalize", "complete"]);
  const stored = await (await fixture.request()).json();
  assert.equal(stored.cacheStatus, "stored");
  assert.equal(stored.analysis.totalLossKwh, result.analysis.totalLossKwh);
  assert.ok([...fixture.objects.keys()].some(key => key.endsWith("result.json")));
  assert.ok(![...fixture.objects.keys()].some(key => key.endsWith("/summary.json")));
});

 test("retry keeps a failed save checkpoint and fences the expired lease", async () => {
  const db = database(); const { job, token } = await start(db);
  await jobs.reportProgress(db, job, token, "save", 4500, 7112);
  await jobs.stopJob(db, job, token, new errors.DatabaseWriteError("batch", new Error("D1_ERROR: unavailable")));
  const retry = await jobs.controlJob(db, "site", job.attempt_id, "retry");
  assert.equal(retry.attempt_id, job.attempt_id);
  assert.equal(retry.stage, "save");
  assert.equal(retry.completed, 4500);
  assert.equal(retry.status, "processing");
  assert.equal(retry.error, "");
  await assert.rejects(jobs.reportProgress(db, job, token, "save", 5400, 7112));
  assert.ok(await jobs.claimJob(db, retry));
});

test("separate attempts for one upload persist safely and replay without duplicate occurrences", async () => {
  const db = database();
  const persistence = loadSource("app/api/performance-summary/persistence.ts", [], errors);
  const issue = { id: "finding", equipmentId: "inverter", equipmentName: "Inverter", equipmentType: "inverter",
    equipmentExternalId: "inverter", name: "Inverter offline", type: "offline", category: "outage", confidence: "high",
    severity: "high", description: "Offline", startDateTime: "2026-01-01T10:00:00", endDateTime: "2026-01-01T11:00:00",
    durationMinutes: 60, durationDays: 1, estimatedLossKwh: 40, lossPercent: 100, siteImpactPercent: 10,
    actualEnergyKwh: 0, expectedEnergyKwh: 40 };
  const args = { database: db, siteId: "site", importId: "import", parserVersion: 20, modelRevision: "model",
    analysisObjectKey: "result", issues: [issue], append: true };
  await persistence.persistPerformanceIssues({ ...args, runIdOverride: "first" });
  const originalBatch = db.batch.bind(db);
  let failAfterCommit = true;
  db.batch = async items => {
    const result = await originalBatch(items);
    if (failAfterCommit) { failAfterCommit = false; throw new Error("D1_ERROR: connection reset"); }
    return result;
  };
  await persistence.persistPerformanceIssues({ ...args, runIdOverride: "retry" });
  await persistence.persistPerformanceIssues({ ...args, runIdOverride: "retry" });
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_runs").get().n, 2);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM performance_issue_occurrences").get().n, 2);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM performance_issues").get().n, 1);
});

test("snow imports retain source context but produce no causal or positive-output deficit findings", async () => {
  const equipment = [
    {id:'meter',name:'Meter',type:'revenue_meter',parentId:null,externalId:'meter',aliases:'[]'},
    {id:'inv',name:'Inverter',type:'inverter',parentId:'meter',externalId:'inv',acRatedCapacityKw:'100',aliases:'[]'},
    {id:'snow',name:'Snow sensor',type:'weather_sensor',externalId:'snow',aliases:'[]'},
    {id:'modules',name:'Modules',type:'module_group',parentId:'inv',externalId:'modules',moduleRatedCapacityW:'400',quantity:250,aliases:'[]'},
  ];
  const csv='time,meter,inv,sun,expected,snow\n2026-01-01T00:00:00,0,0,0,0,60\n2026-01-01T10:00:00,40,40,600,40,60\n2026-01-02T10:00:00,20,20,600,40,60\n2026-01-02T23:59:00,,,,,70\n2026-01-03T10:00:00,20,20,600,40,60\n2026-01-03T23:00:00,0,0,0,0,60';
  const record={id:'snow-import',siteId:'site',objectKey:'upload.csv',rowCount:6,timezone:'America/New_York',validation:JSON.stringify({interval:'60 minutes'}),mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[
    {column:'meter',equipmentId:'meter',measurement:'Energy'},{column:'inv',equipmentId:'inv',measurement:'Energy'},
    {column:'sun',equipmentId:'meter',measurement:'POA irradiance'},{column:'snow',equipmentId:'snow',measurement:'Snow code'},
  ]}})};
  const fixture=await analysisApi(csv,equipment,record);
  let result;
  for(let i=0;i<12;i++) {const response=await fixture.request();result=await response.json();assert.ok(response.ok,JSON.stringify(result));if(response.status!==202)break;}
  assert.ok(result.hasData);
  assert.equal(result.analysis.causeAnalysis,undefined);
  assert.equal(result.analysis.issues.some(i=>i.suspectedCause==='Snow'||i.type==='Underperformance'),false);
  assert.equal(result.analysis.totalLossKwh,0);
  const stored=await(await fixture.request()).json();assert.equal(stored.cacheStatus,'stored');
  assert.deepEqual(stored.analysis,result.analysis);
  const persistence=loadSource('app/api/performance-summary/persistence.ts',[],errors);
  const run=fixture.db.sqlite.prepare('SELECT id FROM analysis_runs').get();
  const rows=await persistence.readPersistedPerformanceIssues(fixture.db,run.id);
  assert.ok(rows.every(i=>!i.suspectedCause));assert.equal(fixture.objects.get(record.objectKey).text,csv);
  const retained=await storedData(fixture.objects.get(`analysis/site/jobs/${run.id}/input.json`));
  assert.equal(retained.record.timezone,'America/New_York');assert.ok(retained.equipment.some(a=>a.id==='snow'));

});

test('all-blank analysis persists unknown loss, remains visible above thresholds, and survives reload', async()=>{
  const equipment=[{id:'meter',name:'Meter',type:'revenue_meter',externalId:'meter',aliases:'[]'}, {id:'inv',name:'Inv',type:'inverter',parentId:'meter',externalId:'inv',acRatedCapacityKw:'100',aliases:'[]'}];
  const record={id:'unknown-import',siteId:'site',objectKey:'upload.csv',rowCount:3,timezone:'America/New_York',validation:JSON.stringify({interval:'1 hour'}),mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[{column:'meter',equipmentId:'meter',measurement:'Energy'},{column:'inv',equipmentId:'inv',measurement:'Energy'},{column:'sun',equipmentId:'meter',measurement:'POA irradiance'}]}})};
  const fixture=await analysisApi('time,meter,inv,sun,expected\n2026-06-01T10:00:00,,,600,50\n2026-06-01T11:00:00,,,600,50\n2026-06-01T12:00:00,,,600,50',equipment,record);
  let result;
  for(let i=0;i<12;i++){const r=await fixture.request();result=await r.json();assert.ok(r.ok,JSON.stringify(result));if(r.status!==202)break;}
  assert.ok(result.hasData);assert.equal(result.analysis.issues.length,1);assert.equal(result.analysis.issues[0].name,'Site telemetry outage');assert.equal(result.analysis.issues[0].estimatedLossKwh,null);assert.equal(result.analysis.issues[0].actualEnergyKwh,null);assert.equal(result.analysis.totalLossKwh,0);
  assert.equal(fixture.db.sqlite.prepare('SELECT estimated_loss_kwh FROM performance_issue_occurrences').get().estimated_loss_kwh,null);
  const stored=await(await fixture.request()).json();assert.equal(stored.analysis.issues[0].estimatedLossKwh,null);assert.equal(stored.analysis.issues[0].summaryPeriods[0].estimatedLossKwh,null);
  const oldPointer=fixture.db.sqlite.prepare('SELECT summary FROM performance_summaries').get().summary;
  const started=await fixture.api.POST(new Request('https://test/api/performance-summary',{method:'POST',body:JSON.stringify({siteId:'site',action:'reanalyze'})}));assert.equal(started.status,202);
  assert.equal(fixture.db.sqlite.prepare('SELECT summary FROM performance_summaries').get().summary,oldPointer);
  assert.equal((await fixture.request()).status,202);
  for(let i=0;i<12;i++){const r=await fixture.request();if(r.status!==202)break;}
  assert.notEqual(fixture.db.sqlite.prepare('SELECT summary FROM performance_summaries').get().summary,oldPointer);
  const latest=await(await fixture.request()).json();assert.equal(latest.analysis.issues[0].estimatedLossKwh,null);
});

test('staged transformer analysis retains branch settings without capping site expected energy',async()=>{
  const equipment=[
    {id:'meter',type:'revenue_meter'},
    {id:'tx',type:'transformer',parentId:'meter',nameplateKva:'150',pvCeilingOverrideEnabled:true,pvCeilingOverrideKw:'175'},
    ...[0,1].flatMap(i=>[{id:`i${i}`,type:'inverter',parentId:'tx',acRatedCapacityKw:'100'},{id:`m${i}`,type:'module_group',parentId:`i${i}`,moduleRatedCapacityW:'500',quantity:250}]),
  ].map(a=>({name:a.id,externalId:a.id,aliases:'[]',...a}));
  const record={id:'transformer-import',siteId:'site',objectKey:'transformer.csv',rowCount:4,timezone:'UTC',validation:JSON.stringify({interval:'1 hour'}),
    mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[
      {column:'meter',equipmentId:'meter',measurement:'Energy'},
      {column:'i0',equipmentId:'i0',measurement:'Energy'},
      {column:'i1',equipmentId:'i1',measurement:'Energy'},
      {column:'sun',equipmentId:'meter',measurement:'POA irradiance'},
    ]}})};
  const csv=['time,meter,i0,i1,sun,expected',...[10,11,12,13].map(h=>`2026-06-01T${h}:00:00Z,0,0,0,600,200`)].join('\n');
  const f=await analysisApi(csv,equipment,record);let result;
  for(let i=0;i<12;i++){const r=await f.request();result=await r.json();assert.ok(r.ok,JSON.stringify(result));if(r.status!==202)break;}
  assert.equal(result.analysis.totalLossKwh,800);
  assert.equal(result.methodology.calculationVersion,29);
  assert.equal(result.methodology.transformerLimits.gridExportCeilingKw,175);
  assert.equal(result.methodology.transformerLimits.capacityConflictIntervals,4);
  assert.equal(result.methodology.transformerLimits.excludedExpectedKwh,undefined);
  assert.equal(result.methodology.equipmentModel.find(a=>a.id==='tx').nameplateKva,'150');
  const saved=await (await f.request()).json();assert.equal(saved.cacheStatus,'stored');
  assert.equal(saved.methodology.transformerLimits.branches[0].overrideEnabled,true);
  assert.equal(f.objects.get(record.objectKey).text,csv);
});

// Seed the real save checkpoint with many distinct findings so this checks the
// storage pipeline independently of how many anomalies a small CSV generates.
async function saveFixture(count, legacy = false) {
  const record = { id: "save-import", siteId: "site", objectKey: "upload.csv", rowCount: 4,
    timezone: "UTC", validation: JSON.stringify({ interval: "1 hour" }),
    mapping: JSON.stringify({ roles: { timestamp: "time", expectedProduction: "expected" }, equipment: { signals: [
      { column: "meter", equipmentId: "meter", measurement: "Energy" },
      { column: "inv", equipmentId: "inv", measurement: "Energy" },
      { column: "sun", equipmentId: "meter", measurement: "POA irradiance" },
    ] } }) };
  const equipment = [
    {id:"meter",name:"Meter",type:"revenue_meter",externalId:"meter",aliases:"[]"},
    {id:"inv",name:"Inverter",type:"inverter",parentId:"meter",externalId:"inv",acRatedCapacityKw:"100",aliases:"[]"},
  ];
  const fixture = await analysisApi("time,meter,inv,sun,expected\n2026-01-01T09:00:00,40,40,600,40\n2026-01-01T10:00:00,0,0,600,40\n2026-01-01T11:00:00,40,40,600,40\n2026-01-01T12:00:00,40,40,600,40", equipment, record);
  for (let i = 0; i < 4; i++) assert.equal((await fixture.request()).status, 202);
  const job = fixture.db.sqlite.prepare("SELECT * FROM analysis_jobs").get();
  assert.equal(job.stage, "save");
  const root = `analysis/site/jobs/${job.attempt_id}`;
  const source = await storedData(fixture.objects.get(`${root}/analysis.json`));
  assert.ok(source.analysis.issues.length);
  const template = source.analysis.issues[0];
  source.analysis.issues = Array.from({ length: count }, (_, i) => {
    const start = Date.UTC(2026, 0, 1) + i * 3600000;
    return { ...template, id: `finding-${i}`, equipmentId: `inv-${i % 48}`,
      startDateTime: new Date(start).toISOString(), endDateTime: new Date(start + 3600000).toISOString(),
      evidence: { ...template.evidence, intervalLosses: Array.from({ length: 12 }, (_, j) => ({
        timestamp: new Date(start + j * 300000).toISOString(), intervalMinutes: 5,
        lossKwh: 3, countedLossKwh: 3, actualKwh: 0, expectedKwh: 3,
      })) } };
  });
  const expected = source.analysis.issues;
  fixture.objects.set(`${root}/analysis.json`, { text: JSON.stringify(source) });
  fixture.objects.delete(`${root}/save-manifest.json`);
  if (legacy) fixture.objects.delete(`${root}/save.json`);
  else fixture.objects.set(`${root}/save.json`, { text: JSON.stringify(
    {parserVersion:source.parserVersion,methodId:source.methodId,issues:loadSource("app/api/performance-summary/analysis-storage.ts").issueSaveIndex(expected, `${root}/result.json`)}) });
  fixture.db.sqlite.prepare("UPDATE analysis_jobs SET total = ?").run(count);
  fixture.io.gets.length = 0; fixture.io.puts.length = 0;
  return { ...fixture, root, job, source, expected };
}

test("2,850 findings save in ten bounded requests with no per-issue evidence writes", async t => {
  const fixture = await saveFixture(2850);
  const started = performance.now();
  const batch = fixture.db.batch.bind(fixture.db), sizes = [];
  fixture.db.batch = items => { sizes.push(items.length); return batch(items); };
  let saves = 0;
  while (fixture.db.sqlite.prepare("SELECT stage FROM analysis_jobs").get().stage === "save") {
    const response = await fixture.request();
    const data = await response.json();
    assert.equal(response.status, 202, JSON.stringify(data));
    assert.equal(data.progress.status, "processing", JSON.stringify(data));
    saves++;
    assert.ok(saves <= 10);
    assert.equal(fixture.db.sqlite.prepare("SELECT COUNT(*) n FROM performance_summaries").get().n, 0);
  }
  assert.equal(saves, 10);
  assert.ok(sizes.every(n => n <= 60));
  assert.equal(fixture.io.puts.length, 0, "save stage must not write evidence objects");
  assert.equal(fixture.io.gets.filter(k => k.endsWith("/analysis.json")).length, 0, "save stage must not reload full evidence");
  assert.equal(fixture.io.gets.filter(k => k.endsWith("/save.json")).length, 10);
  const rows = fixture.db.sqlite.prepare("SELECT evidence FROM performance_issue_occurrences").all();
  assert.equal(rows.length, 2850);
  for (const row of rows) {
    const evidence = JSON.parse(row.evidence);
    assert.equal(evidence.evidenceKey, `${fixture.root}/result.json`);
    assert.equal(evidence.intervalLosses, undefined);
  }
  assert.equal((await fixture.request()).status, 202);
  const response = await fixture.request();
  assert.equal(response.status, 200);
  const display = await response.json();
  assert.equal(display.analysis.issues.length, 2850);
  const stored = await storedData(fixture.objects.get(`${fixture.root}/result.json`));
  assert.equal(stored.analysis.issues[2849].evidence.intervalLosses, undefined);
  assert.deepEqual(stored.analysis.issues[2849].intervalLosses, fixture.expected[2849].evidence.intervalLosses);
  const expectedSignature = await loadSource("app/issue-review.ts").issueEvidenceSignature(fixture.expected[2849]);
  assert.equal(stored.analysis.issues[2849].evidenceSignature, expectedSignature);
  fixture.io.gets.length = 0;
  const detail = await (await fixture.api.GET(new Request("https://test/api/performance-summary?siteId=site&issueId=finding-2849"))).json();
  assert.deepEqual(detail.issue.evidence.intervalLosses, fixture.expected[2849].evidence.intervalLosses);
  assert.equal(fixture.io.gets.filter(k => k === `${fixture.root}/result.json`).length, 1);
  assert.ok(!fixture.io.gets.some(k => k.includes("/evidence/")));
  assert.ok(!fixture.objects.has(`${fixture.root}/save.json`));
  assert.ok(!fixture.objects.has(`${fixture.root}/analysis.json`));
  t.diagnostic(`2,850 synthetic findings: ${saves} save requests; zero per-issue R2 writes; local save/finalize/detail ${(performance.now() - started).toFixed(0)} ms (in-memory storage, not production latency).`);
});

test("older 40-issue checkpoints and partially committed batches resume without losing evidence", async () => {
  const fixture = await saveFixture(650, true);
  const persistence = loadSource("app/api/performance-summary/persistence.ts", [], errors);
  const oldIssues = fixture.expected.slice(0, 40).map((issue, i) => {
    const evidenceKey = `${fixture.root}/evidence/${i}.json`;
    fixture.objects.set(evidenceKey, { text: JSON.stringify(issue.evidence) });
    return { ...issue, evidence: { ...issue.evidence, evidenceKey } };
  });
  await persistence.persistPerformanceIssues({ database: fixture.db, siteId: "site", importId: "save-import",
    parserVersion: fixture.source.parserVersion, modelRevision: fixture.source.modelRevision,
    analysisObjectKey: `${fixture.root}/result.json`, issues: oldIssues, runIdOverride: fixture.job.attempt_id, append: true });
  fixture.db.sqlite.prepare("UPDATE analysis_jobs SET completed = 40").run();
  const batch = fixture.db.batch.bind(fixture.db);
  let batches = 0;
  fixture.db.batch = async items => {
    const result = await batch(items);
    if (++batches === 2) throw new Error("D1_ERROR: simulated lost response after commit");
    return result;
  };
  const failed = await (await fixture.request()).json();
  assert.equal(failed.progress.status, "failed");
  assert.equal(failed.progress.completed, 40);
  assert.ok(fixture.db.sqlite.prepare("SELECT COUNT(*) n FROM performance_issue_occurrences").get().n > 40);
  fixture.db.batch = batch;
  const retry = await jobs.controlJob(fixture.db, "site", fixture.job.attempt_id, "retry");
  assert.equal(retry.attempt_id, fixture.job.attempt_id);
  let saves = 0;
  while (fixture.db.sqlite.prepare("SELECT stage FROM analysis_jobs").get().stage === "save") {
    const response = await fixture.request();
    assert.equal(response.status, 202);
    assert.equal((await response.json()).progress.status, "processing");
    assert.ok(++saves <= 3);
  }
  assert.equal(saves, 3);
  assert.equal(fixture.io.gets.filter(k => k.endsWith("/analysis.json")).length, 1);
  assert.equal(fixture.io.puts.filter(k => k.endsWith("/save.json")).length, 1);
  assert.ok(!fixture.io.puts.some(k => k.includes("/evidence/")));
  assert.equal(fixture.db.sqlite.prepare("SELECT COUNT(*) n FROM performance_issue_occurrences").get().n, 650);
  assert.equal((await fixture.request()).status, 202);
  assert.equal((await fixture.request()).status, 200);
  for (const i of [0, 39, 40, 649]) {
    const detail = await (await fixture.api.GET(new Request(`https://test/api/performance-summary?siteId=site&issueId=finding-${i}`))).json();
    assert.deepEqual(detail.issue.evidence.intervalLosses, fixture.expected[i].evidence.intervalLosses);
  }
});

test("previously completed analyses still load their separate evidence files", async () => {
  const fixture = await saveFixture(1);
  assert.equal((await fixture.request()).status, 202);
  assert.equal((await fixture.request()).status, 202);
  assert.equal((await fixture.request()).status, 200);
  const result = fixture.objects.get(`${fixture.root}/result.json`);
  const stored = await storedData(result), key = `${fixture.root}/evidence/0.json`;
  delete stored.analysis.issues[0].evidence.evidenceFormat;
  stored.analysis.issues[0].evidence.evidenceKey = key;
  fixture.objects.set(`${fixture.root}/result.json`, { ...result, customMetadata:{...result.customMetadata,checkpointFormat:undefined}, text: JSON.stringify(stored) });
  fixture.objects.set(key, { text: JSON.stringify({ ...fixture.expected[0].evidence, legacyMarker: true }) });
  const detail = await (await fixture.api.GET(new Request("https://test/api/performance-summary?siteId=site&issueId=finding-0"))).json();
  assert.equal(detail.issue.evidence.legacyMarker, true);
  assert.deepEqual(detail.issue.evidence.intervalLosses, fixture.expected[0].evidence.intervalLosses);
});

test('positive inverter deficits create no peer or recurring findings in staged saved analysis', async () => {
  const equipment=[{id:'meter',name:'Meter',type:'revenue_meter',externalId:'meter',aliases:'[]'}];
  for(let i=0;i<4;i++)equipment.push({id:`inv${i}`,name:`Inv ${i}`,type:'inverter',parentId:'meter',externalId:`inv${i}`,acRatedCapacityKw:'100',aliases:'[]'},
    {id:`modules${i}`,name:'Modules',type:'module_group',parentId:`inv${i}`,externalId:`modules${i}`,moduleRatedCapacityW:'500',quantity:250,aliases:'[]'});
  const rows=['time,meter,inv0,inv1,inv2,inv3,sun,expected'];
  for(let d=1;d<=6;d++)for(let h=8;h<=16;h++)rows.push(`2026-06-${String(d).padStart(2,'0')}T${String(h).padStart(2,'0')}:00:00,${h===9?228:240},${h===9?48:60},60,60,60,600,240`);
  const record={id:'peer-import',siteId:'site',objectKey:'upload.csv',rowCount:54,timezone:'UTC',validation:JSON.stringify({interval:'1 hour'}),mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[
    ...['meter','inv0','inv1','inv2','inv3'].map(id=>({column:id,equipmentId:id,measurement:'Energy'})),{column:'sun',equipmentId:'meter',measurement:'POA irradiance'}]}})};
  const fixture=await analysisApi(rows.join('\n'),equipment,record);
  fixture.db.sqlite.prepare("INSERT INTO user_settings (id,minimum_issue_loss_kwh) VALUES ('primary-user','50')").run();
  let result;
  for(let i=0;i<12;i++){const response=await fixture.request();result=await response.json();assert.ok(response.ok,JSON.stringify(result));if(response.status!==202)break;}
  assert.equal(result.analysis.issues.filter(i=>i.category==='Performance').length,0);
  assert.equal(result.analysis.totalLossKwh,0);assert.deepEqual(result.analysis.recurringIssues,[]);
  assert.equal(result.methodology.calculationVersion,29);assert.equal(result.methodology.peerComparison,undefined);
  assert.equal(result.methodology.inverterExpectation.version,2);assert.equal(result.methodology.inverterExpectation.coverage,undefined);
  const index=await storedData([...fixture.objects].find(([key])=>key.endsWith('/review-index.json'))[1]);
  assert.deepEqual(index.analysis.recurringIssues,[]);assert.equal(fixture.db.sqlite.prepare('SELECT count(*) n FROM performance_issue_occurrences').get().n,result.analysis.issues.length);
  const cached=await(await fixture.request()).json();assert.equal(cached.cacheStatus,'stored');assert.equal(cached.analysis.totalLossKwh,0);

});

test('shared positive deficits create no site underperformance or shared evidence during publication',async()=>{
 const equipment=[{id:'meter',name:'Meter',type:'revenue_meter',externalId:'meter',aliases:'[]'}];
 for(let i=0;i<4;i++)equipment.push({id:`inv${i}`,name:`Inv ${i}`,type:'inverter',parentId:'meter',externalId:`inv${i}`,acRatedCapacityKw:'100',aliases:'[]'},
  {id:`modules${i}`,name:'Modules',externalId:`modules${i}`,type:'module_group',parentId:`inv${i}`,moduleRatedCapacityW:'500',quantity:250,aliases:'[]'});
 const rows=['time,meter,inv0,inv1,inv2,inv3,sun,expected'];
 for(let d=1;d<=3;d++)for(let h=8;h<=16;h++)rows.push(`2026-06-0${d}T${String(h).padStart(2,'0')}:00:00,174,30,48,48,48,600,240`);
 const record={id:'shared-import',siteId:'site',objectKey:'upload.csv',rowCount:27,timezone:'UTC',validation:JSON.stringify({interval:'1 hour'}),mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[
  ...['meter','inv0','inv1','inv2','inv3'].map(id=>({column:id,equipmentId:id,measurement:'Energy'})),{column:'sun',equipmentId:'meter',measurement:'POA irradiance'}]}})};
 const f=await analysisApi(rows.join('\n'),equipment,record);let result;
 for(let i=0;i<12;i++){const response=await f.request();result=await response.json();assert.ok(response.ok,JSON.stringify(result));if(response.status!==202)break;}
 assert.equal(result.analysis.totalLossKwh,0);assert.equal(result.analysis.issues.filter(i=>i.category==='Performance').length,0);
 assert.equal(result.methodology.sharedReduction,undefined);
 const stored=await storedData([...f.objects].find(([key])=>key.endsWith('/result.json'))[1]);
 assert.equal(stored.analysis.issues.some(i=>i.evidence.rule==='shared_site_reduction_v1'),false);
 const index=await storedData([...f.objects].find(([key])=>key.endsWith('/review-index.json'))[1]);
 assert.ok(index.analysis.issues.every(i=>!i.intervalLosses&&!i.sharedSourceEvents&&!i.hasSharedReduction));
 for(const row of f.db.sqlite.prepare('SELECT evidence FROM performance_issue_occurrences').all()){
  assert.ok(!row.evidence.includes('sharedContributors'));assert.ok(!row.evidence.includes('sharedSourceEvents'));
 }

});

test('indexed history feeds the existing analysis with identical production, expected values and blank readings',async()=>{
 const history=loadSource('app/data-history.ts',[],{...time,...loadSource('app/csv-stream.ts')});
 const equipment=[{id:'meter',name:'Meter',type:'revenue_meter',parentId:null,externalId:'meter',aliases:'[]'},
  {id:'inv',name:'Inverter',type:'inverter',parentId:'meter',externalId:'inv',acRatedCapacityKw:'100',aliases:'[]'},
  {id:'sun',name:'Irradiance',type:'weather_sensor',externalId:'sun',aliases:'[]'}];
 const csv='time,meter,inv,sun,expected\n2026-01-01T12:00Z,20,21,600,25\n2026-01-01T13:00Z,0,0,500,25\n2026-01-01T14:00Z,,,600,\n';
 const record={id:'source',siteId:'site',objectKey:'upload.csv',fileName:'upload.csv',createdAt:'now',rowCount:3,timezone:'UTC',validation:JSON.stringify({intervalMinutes:60,timestampConvention:'start'}),
  mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[{column:'meter',equipmentId:'meter',measurement:'Energy'},{column:'inv',equipmentId:'inv',measurement:'Energy'},{column:'sun',equipmentId:'sun',measurement:'Irradiance'}]}})};
 const month=await history.normalizeHistoryMonth(new Response(csv).body,record,equipment,'2026-01','UTC');
 const manifest={parts:{'2026-01':{key:'jan'}}};
 const retained={...record,id:'history',rowCount:month.cells.length,validation:JSON.stringify({datasetManifest:true,intervalMinutes:60,timestampConvention:'start'}),mapping:JSON.stringify({roles:{timestamp:'Timestamp',equipment:'Equipment',measurement:'Measurement',value:'Value',unit:'Unit',expectedProduction:'Expected Production'},equipment:{signals:[]}})};
 const raw=await analysisApi(csv,equipment,record),indexed=await analysisApi('',equipment,retained,manifest);
 indexed.objects.set('jan',{text:JSON.stringify(history.encodeHistoryCells(month.cells))});
 const original=await raw.api.buildSummary(record,equipment),roundtrip=await indexed.api.buildSummary(retained,equipment);
 for(const summary of [original,roundtrip])summary.equipmentProduction.sort((a,b)=>a.equipmentId.localeCompare(b.equipmentId));
 assert.deepEqual(JSON.parse(JSON.stringify(roundtrip)),JSON.parse(JSON.stringify(original)));
});

test('equipment batches resume an interrupted attempt and preserve the full calculation and interval losses',async()=>{
 const equipment=[{id:'meter',name:'Meter',type:'revenue_meter',externalId:'meter',aliases:'[]'}];
 for(let i=0;i<20;i++)equipment.push({id:`inv${i}`,name:`Inv ${i}`,type:'inverter',parentId:'meter',externalId:`inv${i}`,acRatedCapacityKw:'100',aliases:'[]'},
 {id:`mod${i}`,name:`Modules ${i}`,externalId:`mod${i}`,type:'module_group',parentId:`inv${i}`,moduleRatedCapacityW:'500',quantity:250,aliases:'[]'});
 const ids=Array.from({length:20},(_,i)=>`inv${i}`),rows=[['time','meter',...ids,'sun','expected'].join(',')];
 for(let day=1;day<=4;day++)for(let hour=8;hour<=16;hour++){
  const values=ids.map((_,i)=>i===0?0:60);rows.push([`2026-06-0${day}T${hour.toString().padStart(2,'0')}:00:00`,values.reduce((a,b)=>a+b,0),...values,600,1200].join(','));
 }
 const record={id:'batch-import',siteId:'site',objectKey:'upload.csv',rowCount:36,timezone:'UTC',validation:JSON.stringify({intervalMinutes:60}),mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[...['meter',...ids].map(id=>({column:id,equipmentId:id,measurement:'Energy'})),{column:'sun',equipmentId:'meter',measurement:'POA irradiance'}]}})};
 const f=await analysisApi(rows.join('\n'),equipment,record);
 const summary=f.api.alignWithArrayModel(await f.api.buildSummary(record,equipment),equipment);summary.causeContext={latitude:'',longitude:'',timeZone:'UTC',assumptions:causes.expectedAssumptions({})};
 const expected=JSON.parse(JSON.stringify(f.api.buildAnalysis(summary,equipment)));assert.ok(expected.issues.some(i=>i.type==='Equipment outage'&&i.equipmentId==='inv0'));
 for(let i=0;i<3;i++)assert.equal((await f.request()).status,202);
 const job=f.db.sqlite.prepare('SELECT * FROM analysis_jobs').get();assert.equal(job.stage,'equipment');assert.equal(job.completed,16);
 f.db.sqlite.prepare("UPDATE analysis_jobs SET status='interrupted',completed=19").run();
 const resumed=await jobs.controlJob(f.db,'site',job.attempt_id,'retry');assert.equal(resumed.attempt_id,job.attempt_id);assert.equal(resumed.completed,19);
 assert.equal((await f.request()).status,202);assert.equal(f.db.sqlite.prepare('SELECT stage FROM analysis_jobs').get().stage,'reconcile');
 await f.request();const root=`analysis/site/jobs/${job.attempt_id}`;
 const actual=await storedData(f.objects.get(`${root}/analysis.json`));assert.deepEqual(actual.analysis,expected);
 const before=f.io.gets.length;await f.request();const reads=f.io.gets.slice(before);
 assert.ok(reads.includes(`${root}/save-0.json`));assert.ok(!reads.includes(`${root}/analysis.json`));assert.ok(!reads.includes(`${root}/save.json`));
});

test('streamed checkpoint storage round-trips nested ledgers and legacy JSON',async()=>{
 const input={meta:{name:'Shared text',empty:[],missing:undefined},analysis:{issues:Array.from({length:90},(_,i)=>({id:`issue-${i}`,name:'Shared text',loss:i===0?0:i/3,intervalLosses:[{timestamp:'2026-01-01T00:00:00Z',loss:i}]}))}};
 let stored;await checkpointStorage.writeCheckpoint({async put(key,bytes,options){stored={...options,text:bytes};}},'checkpoint',input);
 assert.ok(stored.text.length<JSON.stringify(input).length);assert.deepEqual(await storedData(stored),JSON.parse(JSON.stringify(input)));
 assert.deepEqual(await storedData({text:JSON.stringify(input)}),JSON.parse(JSON.stringify(input)));
 assert.deepEqual(await checkpointStorage.analysisJsonResponse(input).json(),JSON.parse(JSON.stringify(input)));
});


for(const checkpoint of ['input','summary','equipment','save','save-page','finalize'])test(`outage-only rejects incompatible ${checkpoint} checkpoint before analytical writes`,async()=>{
 const equipment=[{id:'meter',name:'Meter',type:'revenue_meter',externalId:'meter',aliases:'[]'},
  {id:'inv',name:'Inverter',type:'inverter',parentId:'meter',externalId:'inv',acRatedCapacityKw:'100',aliases:'[]'},
  {id:'modules',name:'Modules',externalId:'modules',type:'module_group',parentId:'inv',moduleRatedCapacityW:'500',quantity:200,aliases:'[]'}];
 const record={id:'incompatible',siteId:'site',objectKey:'upload.csv',rowCount:4,timezone:'UTC',validation:JSON.stringify({intervalMinutes:60}),mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[
  ...['meter','inv'].map(id=>({column:id,equipmentId:id,measurement:'Energy'})),{column:'sun',equipmentId:'meter',measurement:'POA irradiance'}]}})};
 const f=await analysisApi('time,meter,inv,sun,expected\n2026-06-01T10:00Z,50,50,600,50\n2026-06-01T11:00Z,0,0,600,50\n2026-06-01T12:00Z,0,0,600,50\n2026-06-01T13:00Z,50,50,600,50',equipment,record);
 await f.request();
 const job=f.db.sqlite.prepare('SELECT * FROM analysis_jobs').get(),root=`analysis/site/jobs/${job.attempt_id}`;
 if(checkpoint!=='input')await f.request();
 if(['equipment','save','save-page','finalize'].includes(checkpoint))await f.request();
 if(['save','save-page','finalize'].includes(checkpoint))await f.request();
 if(checkpoint==='finalize')await f.request();
 const name={input:'input',summary:'summary',equipment:'equipment-final',save:'save-manifest','save-page':'save-0',finalize:'analysis'}[checkpoint];
 const value=await storedData(f.objects.get(`${root}/${name}.json`));value.parserVersion=28;value.methodId='historical-underperformance';
 f.objects.set(`${root}/${name}.json`,{text:JSON.stringify(value)});
 const before=f.db.sqlite.prepare('SELECT * FROM performance_issue_occurrences').all(),puts=f.io.puts.length;
 const response=await f.api.GET(new Request(`https://test/api/performance-summary?siteId=site&attemptId=${job.attempt_id}`)),data=await response.json();
 assert.equal(response.status,409,JSON.stringify(data));assert.equal(data.analysisRequired,true);assert.equal(data.code,'incompatible_analysis_checkpoint');
 assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM performance_issue_occurrences').all(),before);
 assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM performance_summaries').get().n,0);
 assert.equal(f.io.puts.length,puts);
 const retry=await f.api.POST(new Request('https://test/api/performance-summary',{method:'POST',body:JSON.stringify({siteId:'site',attemptId:job.attempt_id,action:'retry'})}));
 if(checkpoint==='input')assert.equal(retry.status,409);
});


test('deleted publication cannot be resurrected through summary/display/ETag/status/explicit-attempt caches',async t=>{
 const f=await canonicalFixture(t),result=await finish(f),runId=result.issueDatabase.analysisRunId;
 const initial=await browse(f),etag=initial.headers.get('etag');await initial.json();
 const before=await retainedSnapshot(f,runId);
 // Reproduce retained payloads and a stale completed job after authoritative soft deletion.
 f.db.sqlite.prepare("UPDATE analysis_runs SET status='deleted' WHERE id=?").run(runId);
 for(const query of ['', '&statusOnly=1', `&attemptId=${runId}`, `&progressOnly=1&attemptId=${runId}`,`&issueId=${encodeURIComponent(result.analysis.issues[0].id)}`]){
  const response=await f.api.GET(new Request(`https://test/api/performance-summary?siteId=site${query}`,{headers:etag?{'if-none-match':etag}:{}}));
  assert.notEqual(response.status,304);const data=await response.json();assert.notEqual(data.hasData,true,JSON.stringify(data));
  if(query.includes('attemptId='))assert.equal(response.status,404,JSON.stringify(data));
  else assert.equal(data.analysisRequired,true,JSON.stringify(data));
 }
 f.db.sqlite.prepare('DELETE FROM performance_summaries WHERE site_id=?').run('site');
 // An orphan current.json is not an authoritative publication either.
 const saved=await f.bucket.get(`analysis/site/jobs/${runId}/result.json`);
 await f.bucket.put('analysis/site/current.json',await saved.arrayBuffer(),{customMetadata:{siteId:'site',importId:result.import.id,parserVersion:'29',modelRevision:result.methodology.modelRevision}});
 assert.equal((await(await browse(f)).json()).analysisRequired,true);
 const after=await retainedSnapshot(f,runId);assert.deepEqual(after.result,before.result);assert.deepEqual(after.occurrences,before.occurrences);
});


test('outage-only manual analysis completes actual durable save/publication and reopens every stage without retired work',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'outage-manual-'));
 let db,bucket,manager,store,orm,fixture;
 const schema=loadSource('db/schema.ts',[],{sql,...sqliteCore});
 const equipment=[{id:'meter',name:'Meter',externalId:'meter',type:'revenue_meter',siteId:'site',aliases:'[]',acLineLossPercent:'2',transformerLossPercent:'1'},
  ...[0,1].map(i=>({id:`tx${i}`,name:`Transformer ${i+1}`,externalId:`tx${i}`,type:'transformer',siteId:'site',parentId:'meter',nameplateKva:'900',aliases:'[]'})),
  ...Array.from({length:20},(_,i)=>[{id:`inv${i}`,name:`Inverter ${i+1}`,externalId:`inv${i}`,type:'inverter',siteId:'site',parentId:`tx${Math.floor(i/10)}`,acRatedCapacityKw:'100',aliases:'[]'},
    {id:`modules${i}`,name:`Modules ${i+1}`,externalId:`modules${i}`,type:'module_group',siteId:'site',parentId:`inv${i}`,moduleRatedCapacityW:'500',quantity:200,aliases:'[]'}]).flat()];
 const retired=['compareCapacityPeers','sharedReductionIntervals','allocateSharedReductions','attributeCauses','splitRecurringGaps','buildRecurringIssues','transformerPeerExclusions'];
 const calls=Object.fromEntries(retired.map(name=>[name,0]));
 const traps=Object.fromEntries(retired.map(name=>[name,()=>{calls[name]++;throw Error(`Retired work called: ${name}`);} ]));
 const close=()=>{manager?.close();db?.close();manager=db=null;};
 t.after(()=>{close();rmSync(directory,{recursive:true,force:true});});
 const open=async()=>{
  db=new LocalDatabase(join(directory,'shared.sqlite'),'drizzle');bucket=new LocalBucket(db,join(directory,'objects'));
  manager=new PerformanceStoreManager(join(directory,'performance'));store=manager.site('site');orm=drizzle(db);
  const data=loadSource('app/api/performance-data/analysis.ts',[],performanceBindings(store));
  const assets=await orm.select().from(schema.equipmentAssets).where(eq(schema.equipmentAssets.siteId,'site'));
  fixture=await analysisApi('',assets,data.performanceAnalysisInput('site'),null,store,{db,bucket,bindings:{...schema,eq,desc,getDb:()=>orm,...traps}});
  return {data,assets};
 };
 // Initialize only through the production migrations and ordinary canonical stage/commit.
 db=new LocalDatabase(join(directory,'shared.sqlite'),'drizzle');bucket=new LocalBucket(db,join(directory,'objects'));orm=drizzle(db);
 await orm.insert(schema.siteSettings).values({id:'site',name:'Outage manual fixture'});
 await orm.insert(schema.equipmentAssets).values(equipment);
 manager=new PerformanceStoreManager(join(directory,'performance'));store=manager.site('site');
 const readings=[];
 for(let h=10;h<=16;h++){
  const timestamp=`2026-06-01T${h}:00:00.000Z`,values=Array.from({length:20},(_,i)=>[14,15].includes(h)||(i===0&&h>=11&&h<=13)||(i===1&&[11,12].includes(h))?0:(i===2&&h===16?30:60));
  const actual=values.reduce((s,v)=>s+v,0)*.9702;
  const add=(id,measurement,value,unit='kWh')=>readings.push({timestamp,channel:{id:JSON.stringify([id,measurement]),equipmentId:id,measurement,unit},value});
  add('meter','Energy',actual);values.forEach((v,i)=>add(`inv${i}`,'Energy',h===13&&i===3?null:v));
  add('meter','POA irradiance',600,'W/m2');add('@site','Expected Production',h===12?-1:h===15?null:h===14?1400:1200*.9702);
 }
 const staged=await store.stage({source:'csv',fileName:'populated-outage.csv',timezone:'UTC',intervalMinutes:60,modelRevision:'manual-model'},readings);
 const receipt=store.commit(staged.stageId,{previewToken:staged.previewToken,approveOverlap:true,modelRevision:'manual-model',actor:'test'});
 close();let {data,assets}=await open();const record=data.performanceAnalysisInput('site');
 const summary=fixture.api.alignWithArrayModel(await fixture.api.buildSummary(record,assets),assets);
 summary.causeContext={latitude:'',longitude:'',timeZone:'UTC',assumptions:causes.expectedAssumptions({})};
 const expected=JSON.parse(JSON.stringify(fixture.api.buildAnalysis(summary,assets)));
 const started=await fixture.api.POST(new Request('https://test/api/performance-summary',{method:'POST',body:JSON.stringify({siteId:'site',action:'reanalyze'})}));
 assert.equal(started.status,202);const runId=(await started.json()).progress.attemptId;
 let result,completed=false,reopens=0;const stages=[];
 for(let i=0;i<16;i++){
  close();await open();reopens++;
  const job=db.sqlite.prepare('SELECT stage,completed FROM analysis_jobs WHERE attempt_id=?').get(runId);stages.push([job.stage,job.completed]);
  const response=await fixture.api.GET(new Request('https://test/api/performance-summary?siteId=site'));result=await response.json();
  assert.ok(response.ok,JSON.stringify(result));assert.notEqual(result.progress?.status,'failed',JSON.stringify(result));
  if(response.status!==202){completed=true;break;}
 }
 assert.equal(completed,true,JSON.stringify(stages));assert.equal(result.hasData,true);assert.equal(result.issueDatabase.analysisRunId,runId);
 assert.ok(stages.some(([stage,offset])=>stage==='equipment'&&offset===16));assert.ok(stages.some(([stage])=>stage==='save'));assert.ok(stages.some(([stage])=>stage==='finalize'));
 assert.deepEqual(Object.values(calls),retired.map(()=>0));
 const pointer=JSON.parse(db.sqlite.prepare('SELECT summary FROM performance_summaries WHERE site_id=?').get('site').summary);
 assert.equal(pointer.analysisRunId,runId);assert.equal(db.sqlite.prepare('SELECT status FROM analysis_runs WHERE id=?').get(runId).status,'completed');
 const raw=Buffer.from(await(await bucket.get(pointer.objectKey)).arrayBuffer());
 const saved=await checkpointStorage.readCheckpoint(await bucket.get(pointer.objectKey));
 const projection=issues=>issues.map(i=>({id:i.id,type:i.type,equipmentId:i.equipmentId,start:i.startDateTime,end:i.endDateTime,
  loss:i.estimatedLossKwh,actual:i.actualEnergyKwh,expected:i.expectedEnergyKwh,lossUnknown:i.lossUnknown,expectedUnknown:i.expectedUnknown,
  ledger:i.intervalLosses||i.evidence.intervalLosses}));
 assert.deepEqual(JSON.parse(JSON.stringify(projection(saved.analysis.issues))),projection(expected.issues));
 assert.equal(saved.analysis.totalLossKwh,expected.totalLossKwh);assert.equal(saved.parserVersion,29);assert.equal(saved.methodId,'outage-only-v2');
 assert.equal(saved.methodology.inputProvenance.revision,receipt.revision);
 const persistence=loadSource('app/api/performance-summary/persistence.ts',[],errors);
 const persisted=await persistence.readPersistedPerformanceIssues(db,runId);
 assert.equal(persisted.length,saved.analysis.issues.length);
 for(const issue of persisted.filter(i=>i.lossUnknown)){
  assert.equal(issue.evidence.lossUnknown,true);
  assert.equal(db.sqlite.prepare('SELECT estimated_loss_kwh FROM performance_issue_occurrences WHERE analysis_run_id=? AND source_issue_id=?').get(runId,issue.id).estimated_loss_kwh,null);
 }
 db.sqlite.prepare("INSERT INTO user_settings(id,minimum_issue_loss_kwh) VALUES('primary-user','99999') ON CONFLICT(id) DO UPDATE SET minimum_issue_loss_kwh=excluded.minimum_issue_loss_kwh").run();
 close();await open();reopens++;
 const reopened=await(await fixture.api.GET(new Request('https://test/api/performance-summary?siteId=site'))).json();
 assert.ok(reopened.analysis.issues.some(i=>i.type==='Site outage'&&i.lossUnknown&&i.actualEnergyKwh===0));
 assert.ok(reopened.analysis.issues.some(i=>i.type==='Equipment outage'&&i.lossUnknown));
 assert.ok(reopened.analysis.issues.every(i=>i.lossUnknown||i.category==='Communications'));
 for(const issue of reopened.analysis.issues.filter(i=>i.lossUnknown)){
  assert.equal(issue.estimatedLossKwh,null);assert.equal(issue.lossPercent,null);
  if(issue.expectedUnknown)assert.equal(issue.expectedEnergyKwh,null);
  const detail=await(await fixture.api.GET(new Request(`https://test/api/performance-summary?siteId=site&issueId=${encodeURIComponent(issue.id)}`))).json();
  assert.equal(detail.issue.evidence.lossUnknown,true);assert.equal(detail.issue.estimatedLossKwh,null);
 }
 assert.deepEqual(Buffer.from(await(await bucket.get(pointer.objectKey)).arrayBuffer()),raw);
 assert.equal([...store.rows()].length,readings.length);assert.equal(store.describe().revision,receipt.revision);
 t.diagnostic(JSON.stringify({manualSavedAndReopened:true,reopens,stages,readings:readings.length,issues:saved.analysis.issues.length,
  unknownIssues:saved.analysis.issues.filter(i=>i.lossUnknown).length,quantifiedLossKwh:saved.analysis.totalLossKwh,retiredWorkCalls:calls}));
});

for(const missingSibling of [false,true])test(`inverter delivery survives manual save/reopen with ${missingSibling?'missing':'known'} sibling actual`,async t=>{
  let f=await canonicalFixture(t);
  const schema=loadSource('db/schema.ts',[],{sql,...sqliteCore}),capacity=modelCapacityBindings();
  const equipmentApi=loadSource('app/api/equipment/route.ts',[],{...schema,...capacity,eq,asc,inArray,getDb:()=>drizzle(f.db),getDatabaseBinding:()=>f.db,Error,TypeError});
  const assets=[{id:'meter',name:'Meter',externalId:'meter',type:'revenue_meter',acLineLossPercent:'2',transformerLossPercent:'1'},
    {id:'tx',name:'Transformer',externalId:'tx',type:'transformer',parentId:'meter',nameplateKva:'200'},
    ...['inv','invB'].flatMap((id,index)=>[{id,name:`Inverter ${index+1}`,externalId:id,type:'inverter',parentId:'tx',acRatedCapacityKw:'100'},
      {id:`modules-${id}`,name:`Modules ${index+1}`,externalId:`modules-${id}`,type:'module_group',parentId:id,moduleRatedCapacityW:'400',quantity:250}])];
  const save=await equipmentApi.PUT(new Request('https://test/api/equipment',{method:'PUT',body:JSON.stringify({siteId:'site',equipment:assets,verified:true})}));
  const saved=await save.json();assert.equal(save.status,200,JSON.stringify(saved));assert.equal(saved.verified,true);
  f=await f.reopen();
  const readback=await equipmentApi.GET(new Request('https://test/api/equipment?siteId=site'));
  const modelReadback=await readback.json();assert.equal(readback.status,200);assert.equal(modelReadback.verified,true);assert.deepEqual(modelReadback.equipment,saved.equipment);
  const model=capacity.inverterExpectationModel(f.equipment);
  assert.equal(model.ready,true);assert.equal(capacity.arrayCapacityModel(f.equipment).complete,true);assert.equal(model.deliveryFactor,.9702);
  const rows=[];
  for(const hour of [10,11,12,13])for(const [id,measurement,value,unit] of [
    ['meter','Energy',(hour===11?40:80)*.9702,'kWh'],['inv','Energy',hour===11?0:40,'kWh'],
    ['invB','Energy',hour===11&&missingSibling?null:40,'kWh'],['meter','POA irradiance',600,'W/m2'],['@site','Expected Production',80,'kWh'],
  ])rows.push({timestamp:`2026-06-01T${hour}:00:00.000Z`,channel:{id:JSON.stringify([id,measurement]),equipmentId:id,measurement,unit},value});
  await f.commit(rows);f=await f.reopen();
  const canonicalBefore=JSON.stringify([...f.store.rows()]);
  const started=await control(f,'reanalyze'),start=await started.json();assert.equal(started.status,202,JSON.stringify(start));
  const runId=start.progress.attemptId,stages=[];let result;
  for(let i=0;i<16;i++){
    f=await f.reopen();stages.push(f.db.sqlite.prepare('SELECT stage FROM analysis_jobs WHERE attempt_id=?').get(runId).stage);
    const response=await browse(f);result=await response.json();assert.ok(response.ok,JSON.stringify(result));
    assert.notEqual(result.progress?.status,'failed',JSON.stringify(result));if(response.status!==202)break;
  }
  assert.equal(result.hasData,true,JSON.stringify(result));assert.equal(result.issueDatabase.analysisRunId,runId);
  for(const stage of ['read','equipment','reconcile','save','finalize'])assert.ok(stages.includes(stage),JSON.stringify(stages));
  assert.equal(f.db.sqlite.prepare('SELECT status FROM analysis_runs WHERE id=?').get(runId).status,'completed');
  const pointer=JSON.parse(f.db.sqlite.prepare("SELECT summary FROM performance_summaries WHERE site_id='site'").get().summary);
  assert.equal(pointer.analysisRunId,runId);
  const raw=Buffer.from(await(await f.bucket.get(pointer.objectKey)).arrayBuffer());
  f=await f.reopen();
  const currentResponse=await browse(f),current=await currentResponse.json();assert.equal(currentResponse.status,200);assert.deepEqual(current.analysis,result.analysis);
  const stored=await checkpointStorage.readCheckpoint(await f.bucket.get(pointer.objectKey));
  const {saved:historyService}=publicationClients(f);
  const historyApi=loadSource('app/api/analysis-history/route.ts',[],{...modelCapacityBindings(),...f.data,...historyService,...checkpointStorage});
  const historyResponse=await historyApi.GET(new Request(`https://test/api/analysis-history?siteId=site&runId=${runId}`));
  const historical=await historyResponse.json();assert.equal(historyResponse.status,200,JSON.stringify(historical));
  const target=payload=>payload.analysis.issues.find(i=>i.equipmentId==='inv'&&i.type==='Equipment outage');
  const issue=target(current),retained=target(stored),past=target(historical);assert.ok(issue);assert.ok(retained);assert.ok(past);
  // This is a delivered allocation of the supplied 80 kWh, not the terminal
  // 40 / .9702 value, regardless of whether branch loss can be quantified.
  for(const projection of [issue,retained,past]){
    assert.equal(projection.id,issue.id);assert.equal(projection.expectedUnknown,false);assert.equal(projection.productionUnknown,false);
    assert.equal(projection.lossUnknown,missingSibling);assert.equal(projection.actualEnergyKwh,0);
    assert.ok(Math.abs(projection.expectedEnergyKwh-40)<1e-8,`expected 40 delivered kWh, got ${projection.expectedEnergyKwh}`);
  }
  for(const projection of [issue,past]){
    assert.equal(projection.estimatedLossKwh,missingSibling?null:40);assert.equal(projection.lossPercent,missingSibling?null:100);
  }
  assert.equal(retained.estimatedLossKwh,missingSibling?0:40);assert.equal(current.analysis.totalLossKwh,missingSibling?0:40);
  const interval=retained.intervalLosses[0];
  assert.equal(interval.actualKwh,0);assert.ok(Math.abs(interval.expectedKwh-40)<1e-8);
  assert.ok(Math.abs(interval.derivedInverterExpectedKwh-40/.9702)<1e-8,'terminal allocation evidence is retained');
  assert.equal(retained.evidence.siteDeliveryFactor,.9702);
  if(missingSibling){assert.equal(interval.lossUnknown,true);assert.equal(interval.lossKwh,0);assert.equal(interval.lossUnavailableReason,'branch_actual_coverage');}
  else {assert.equal(interval.lossBoundary,'meter_poi');assert.ok(Math.abs(interval.inverterTerminalLossKwh-40/.9702)<1e-8);}
  assert.equal(f.db.sqlite.prepare('SELECT estimated_loss_kwh FROM performance_issue_occurrences WHERE analysis_run_id=? AND source_issue_id=?').get(runId,issue.id).estimated_loss_kwh,missingSibling?null:40);
  const summary=await f.api.buildSummary(f.record,f.equipment);
  assert.deepEqual(JSON.parse(JSON.stringify(summary.expectedProduction)),[10,11,12,13].map(hour=>({timestamp:`2026-06-01T${hour}:00:00.000Z`,energyKwh:80})));
  assert.equal(JSON.stringify([...f.store.rows()]),canonicalBefore,'analysis and reads never rewrite the supplied site reference');
  assert.deepEqual(Buffer.from(await(await f.bucket.get(pointer.objectKey)).arrayBuffer()),raw,'reads preserve completed result bytes');
  t.diagnostic(JSON.stringify({missingSibling,stages,expectedKwh:issue.expectedEnergyKwh,actualKwh:issue.actualEnergyKwh,lossKwh:issue.estimatedLossKwh,storedExpectedKwh:retained.expectedEnergyKwh,historicalExpectedKwh:past.expectedEnergyKwh}));
});

for(const scenario of ['complete-transformer','missing-module-dc','missing-transformer-rating','legacy-missing-module-dc'])test(`accepted allocation draft: ${scenario} saves and reopens measured outages`,async t=>{
  let f=await canonicalFixture(t);
  const schema=loadSource('db/schema.ts',[],{sql,...sqliteCore}),capacity=modelCapacityBindings();
  const equipmentApi=loadSource('app/api/equipment/route.ts',[],{...schema,...capacity,eq,asc,inArray,getDb:()=>drizzle(f.db),getDatabaseBinding:()=>f.db,Error,TypeError});
  const assets=[{id:'meter',name:'Meter',externalId:'meter',type:'revenue_meter'},
    {id:'tx',name:'Transformer',externalId:'tx',type:'transformer',parentId:'meter',nameplateKva:'200'},
    ...['inv','invB'].flatMap((id,index)=>[{id,name:`Inverter ${index+1}`,externalId:id,type:'inverter',parentId:'tx',acRatedCapacityKw:'100'},
      {id:`modules-${id}`,name:`Modules ${index+1}`,externalId:`modules-${id}`,type:'module_group',parentId:id,moduleRatedCapacityW:'400',quantity:250}])];
  if(scenario.includes('missing-module-dc'))assets.find(a=>a.id==='modules-inv').moduleRatedCapacityW='';
  if(scenario==='missing-transformer-rating')assets.find(a=>a.id==='tx').nameplateKva='';
  if(scenario.startsWith('legacy')){
    assets.splice(assets.findIndex(a=>a.id==='tx'),1);
    assets.filter(a=>a.type==='inverter').forEach(a=>{a.parentId='meter';});
  }
  const save=await equipmentApi.PUT(new Request('https://test/api/equipment',{method:'PUT',body:JSON.stringify({siteId:'site',equipment:assets,verified:false})}));
  const saved=await save.json();assert.equal(save.status,200,JSON.stringify(saved));assert.equal(saved.verified,false);
  f=await f.reopen();
  const readback=await equipmentApi.GET(new Request('https://test/api/equipment?siteId=site'));
  assert.equal(readback.status,200);assert.deepEqual((await readback.json()).equipment,saved.equipment);
  const quantified=scenario==='complete-transformer';
  assert.equal(capacity.inverterExpectationModel(f.equipment).ready,quantified);
  const rows=[];
  // The separate full-site outage proves that a known site reference is not
  // lost merely because the preceding inverter outage cannot be allocated.
  for(const hour of [10,11,12,13,14])for(const [id,measurement,value,unit] of [
    ['meter','Energy',hour===14?0:hour===11?40:80,'kWh'],['inv','Energy',[11,14].includes(hour)?0:40,'kWh'],
    ['invB','Energy',hour===14?0:40,'kWh'],['meter','POA irradiance',600,'W/m2'],['@site','Expected Production',80,'kWh'],
  ])rows.push({timestamp:`2026-06-01T${hour}:00:00.000Z`,channel:{id:JSON.stringify([id,measurement]),equipmentId:id,measurement,unit},value});
  await f.commit(rows);f=await f.reopen();
  const started=await control(f,'reanalyze'),start=await started.json();assert.equal(started.status,202,JSON.stringify(start));
  const runId=start.progress.attemptId,stages=[];let result;
  for(let i=0;i<16;i++){
    f=await f.reopen();
    stages.push(f.db.sqlite.prepare('SELECT stage FROM analysis_jobs WHERE attempt_id=?').get(runId).stage);
    const response=await browse(f);result=await response.json();assert.ok(response.ok,JSON.stringify(result));
    assert.notEqual(result.progress?.status,'failed',JSON.stringify(result));
    if(response.status!==202)break;
  }
  assert.equal(result.hasData,true,JSON.stringify(result));assert.equal(result.issueDatabase.analysisRunId,runId);
  for(const stage of ['read','equipment','reconcile','save','finalize'])assert.ok(stages.includes(stage),JSON.stringify(stages));
  const before=await retainedSnapshot(f,runId);
  assert.equal(before.run.status,'completed');assert.equal(JSON.parse(before.pointer[0].summary).analysisRunId,runId);
  f=await f.reopen();
  const reopened=await(await browse(f)).json();assert.deepEqual(reopened.analysis,result.analysis);
  const inverter=reopened.analysis.issues.find(i=>i.equipmentId==='inv'&&i.type==='Equipment outage');
  const site=reopened.analysis.issues.find(i=>i.type==='Site outage');assert.ok(inverter);assert.ok(site);
  assert.equal(inverter.actualEnergyKwh,0);assert.equal(inverter.productionUnknown,false);
  assert.equal(inverter.expectedUnknown,!quantified);assert.equal(inverter.lossUnknown,!quantified);
  assert.equal(inverter.expectedEnergyKwh,quantified?40:null);assert.equal(inverter.estimatedLossKwh,quantified?40:null);
  assert.equal(site.actualEnergyKwh,0);assert.equal(site.productionUnknown,false);assert.equal(site.expectedUnknown,false);
  assert.equal(site.expectedEnergyKwh,80);assert.equal(site.estimatedLossKwh,80);assert.equal(site.lossUnknown,false);
  assert.equal(reopened.analysis.totalLossKwh,quantified?120:80,'site/child loss is counted once');
  assert.equal(reopened.analysis.issues.length,2);
  const detail=await(await browse(f,`&issueId=${encodeURIComponent(inverter.id)}`)).json();
  assert.equal(detail.issue.actualEnergyKwh,0);assert.equal(detail.issue.expectedEnergyKwh,quantified?40:null);
  assert.equal(detail.issue.estimatedLossKwh,quantified?40:null);assert.equal(detail.issue.evidence.lossUnknown,!quantified);
  assert.equal(f.db.sqlite.prepare('SELECT estimated_loss_kwh FROM performance_issue_occurrences WHERE analysis_run_id=? AND source_issue_id=?').get(runId,inverter.id).estimated_loss_kwh,quantified?40:null);
  assert.deepEqual(await retainedSnapshot(f,runId),before,'reopening and details preserve saved evidence and publication');
  assert.equal([...f.store.rows()].length,rows.length);
  t.diagnostic(JSON.stringify({scenario,equipmentSaveStatus:save.status,stages,inverterLoss:inverter.estimatedLossKwh,inverterActual:inverter.actualEnergyKwh,siteExpected:site.expectedEnergyKwh}));
});

async function retainedCsvFixture(t,bindings={}) {
  const root=mkdtempSync(join(tmpdir(),'retained-csv-'));
  const db=new LocalDatabase(join(root,'shared.sqlite'),'drizzle'),bucket=new LocalBucket(db,join(root,'objects'));
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  const equipment=[{id:'meter',name:'Meter',type:'revenue_meter',externalId:'meter',aliases:'[]'},
    {id:'inv',name:'Inverter',type:'inverter',parentId:'meter',externalId:'inv',acRatedCapacityKw:'100',aliases:'[]'},
    {id:'modules',name:'Modules',type:'module_group',parentId:'inv',externalId:'modules',moduleRatedCapacityW:'500',quantity:200,aliases:'[]'}];
  const csv='time,meter,inv,sun,expected\n2026-06-01T10:00Z,50,50,600,50\n2026-06-01T11:00Z,0,0,600,50\n2026-06-01T12:00Z,0,0,600,50\n2026-06-01T13:00Z,50,50,600,50';
  const record={id:'csv-response-race',siteId:'site',objectKey:'upload.csv',fileName:'synthetic.csv',fileSize:Buffer.byteLength(csv),rowCount:4,validRows:4,detectedTypes:'[]',timezone:'UTC',
    validation:JSON.stringify({intervalMinutes:60}),mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[
      ...['meter','inv'].map(id=>({column:id,equipmentId:id,measurement:'Energy'})),{column:'sun',equipmentId:'meter',measurement:'POA irradiance'}]}})};
  const schema=loadSource('db/schema.ts',[],{sql,...sqliteCore}),orm=drizzle(db);
  await orm.insert(schema.siteSettings).values({id:'site',name:'Retained CSV response fixture'});
  await orm.insert(schema.equipmentAssets).values(equipment.map(a=>({...a,siteId:'site'})));
  await orm.insert(schema.telemetryImports).values(record);await bucket.put(record.objectKey,csv);
  return analysisApi(csv,equipment,record,null,null,{db,bucket,bindings:{...schema,eq,desc,getDb:()=>orm,...bindings}});
}

function responseGate() {
  let enter,release;
  const reached=new Promise(resolve=>{enter=resolve;}),wait=new Promise(resolve=>{release=resolve;});
  return {reached,release,async hold(){enter();await wait;}};
}
async function awaitResponseGate(gate,pending) {
  let timer;
  try {
    await Promise.race([gate.reached,pending.then(response=>assert.fail(`Request returned ${response.status} before the response-preparation hold`)),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Response-preparation hold was not reached')),5000);})]);
  } finally {clearTimeout(timer);}
}
async function deleteCompletedPublication(f,runId) {
  const deletion=loadSource('app/api/analysis-history/deletion.ts',[],{Error,TypeError,getDatabaseBinding:()=>f.db});
  const receipt=await deletion.deleteSavedAnalysis('site',runId);
  assert.deepEqual(JSON.parse(JSON.stringify(receipt)),{deleted:true,siteId:'site',runId,currentCleared:true});
  assert.equal(f.db.sqlite.prepare('SELECT status FROM analysis_runs WHERE id=?').get(runId).status,'deleted');
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM performance_summaries WHERE site_id=?').get('site').n,0);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM analysis_jobs WHERE attempt_id=?').get(runId).n,0);
  return receipt;
}
async function assertDeletedResponse(response,explicit) {
  assert.equal(response.status,explicit?404:200);
  assert.match(response.headers.get('cache-control'),/private, no-store/);
  assert.equal(response.headers.get('etag'),null,'a deleted run must not authorize cached reuse');
  const data=await response.json();assert.notEqual(data.hasData,true,JSON.stringify(data));
  assert.equal(data.issue,undefined);assert.equal(data.issueDatabase,undefined);
  if(explicit)assert.equal(data.error,'Analysis attempt not found.');
  else assert.equal(data.analysisRequired,true,JSON.stringify(data));
}

for(const boundary of ['eligible-304','display-write','status-head','legacy-evidence','final-etag','result-read'])for(const explicit of [false,true])test(`late deletion fences ${boundary} ${explicit?'explicit attempt':'current publication'}`,async t=>{
  const held=responseGate();let armed=false,tagCalls=0,heldInput='',pending,settled=false;
  const crypto={randomUUID:webcrypto.randomUUID.bind(webcrypto),subtle:{digest:async(algorithm,bytes)=>{
    const result=await webcrypto.subtle.digest(algorithm,bytes),input=new TextDecoder().decode(bytes);
    if(armed&&['eligible-304','final-etag'].includes(boundary)&&input.includes('display-v6-outage-only')){
      tagCalls++;
      if(tagCalls===(boundary==='final-etag'?2:1)){armed=false;heldInput=input;await held.hold();}
    }
    return result;
  }}};
  const f=boundary==='display-write'?await canonicalFixture(t):await retainedCsvFixture(t,{crypto});
  const completed=await finish(f),runId=completed.issueDatabase.analysisRunId,root=`analysis/site/jobs/${runId}`;
  assert.ok(completed.analysis.issues.length>0);assert.equal(completed.hasData,true);
  const resultKey=`${root}/result.json`,evidenceKey=`${root}/legacy-evidence.json`;
  const get=f.bucket.get.bind(f.bucket),put=f.bucket.put.bind(f.bucket),head=f.bucket.head.bind(f.bucket);
  if(boundary==='legacy-evidence'){
    // Compatibility fixture: retain the real completed calculation, but encode
    // its detail in the older per-issue evidence layout before taking snapshots.
    const object=await get(resultKey),payload=await checkpointStorage.readCheckpoint(object);
    const issue=payload.analysis.issues[0];await put(evidenceKey,JSON.stringify({...issue.evidence,intervalLosses:issue.intervalLosses}));
    issue.evidence={evidenceKey};await checkpointStorage.writeCheckpoint(f.bucket,resultKey,payload,{customMetadata:object.customMetadata});
    await f.bucket.delete('analysis/site/display.json');
  }
  const query=(explicit?`&attemptId=${runId}`:'')+(boundary==='status-head'?'&statusOnly=1':boundary==='legacy-evidence'?`&issueId=${encodeURIComponent(completed.analysis.issues[0].id)}`:'');
  const initial=await browse(f),etag=initial.headers.get('etag');await initial.json();
  if(boundary!=='display-write'){
    assert.ok(etag);
    const control=await f.api.GET(new Request(`https://test/api/performance-summary?siteId=site${explicit?`&attemptId=${runId}`:''}`,{headers:{'If-None-Match':etag}}));
    assert.equal(control.status,304,'the unchanged real CSV publication is genuinely ETag eligible');
    assert.match(control.headers.get('cache-control'),/private, no-cache/);
  }
  if(['display-write','result-read'].includes(boundary))await f.bucket.delete('analysis/site/display.json');
  const before=await retainedSnapshot(f,runId);
  f.bucket.head=async(key,...args)=>{const result=await head(key,...args);if(armed&&boundary==='status-head'&&key===resultKey){armed=false;await held.hold();}return result;};
  f.bucket.get=async(key,...args)=>{const result=await get(key,...args);if(armed&&((boundary==='legacy-evidence'&&key===evidenceKey)||(boundary==='result-read'&&key===resultKey))){armed=false;await held.hold();}return result;};
  f.bucket.put=async(key,...args)=>{if(armed&&boundary==='display-write'&&key==='analysis/site/display.json'){armed=false;await held.hold();}return put(key,...args);};
  try {
    armed=true;
    pending=f.api.GET(new Request(`https://test/api/performance-summary?siteId=site${query}`,{headers:boundary==='eligible-304'?{'If-None-Match':etag}:{}}));
    pending.then(()=>{settled=true;},()=>{settled=true;});
    await awaitResponseGate(held,pending);assert.equal(settled,false,'the public request is actually held in flight');
    if(['eligible-304','final-etag'].includes(boundary))assert.ok(heldInput.includes('display-v6-outage-only'));
    const receipt=await deleteCompletedPublication(f,runId);
    assert.equal(settled,false,'deletion committed before response preparation resumes');
    held.release();
    const late=await pending;await assertDeletedResponse(late,explicit);
    const fresh=await f.api.GET(new Request(`https://test/api/performance-summary?siteId=site${query}`,{headers:etag?{'If-None-Match':etag}:{}}));
    await assertDeletedResponse(fresh,explicit);
    await assertDeletedResponse(await browse(f,`&progressOnly=1&attemptId=${runId}`),true);
    const after=await retainedSnapshot(f,runId);
    assert.deepEqual(after.result,before.result);assert.deepEqual(after.index,before.index);
    assert.equal(after.run.status,'deleted');assert.equal(after.pointer.length,0);assert.equal(after.occurrences.length,0);
    t.diagnostic(JSON.stringify({boundary,explicit,heldInFlight:true,deletion:receipt,lateStatus:late.status,freshStatus:fresh.status,tagCalls}));
  } finally {
    armed=false;held.release();
    if(pending)await pending.catch(()=>{});
    f.bucket.get=get;f.bucket.put=put;f.bucket.head=head;
  }
});
