import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {LocalDatabase, LocalBucket} from '../../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';
import {loadSource} from '../source-module.mjs';

async function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'sol-performance-http-'));
  const password=randomUUID();
  const reservation=createServer();
  reservation.listen(0,'127.0.0.1'); await once(reservation,'listening');
  const port=reservation.address().port;
  await new Promise((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));
  const base=`http://127.0.0.1:${port}`;
  const headers={Authorization:'Basic '+Buffer.from(`tester:${password}`).toString('base64')};
  let child,logs='';
  async function start() {
    child=spawn(process.execPath,['selfhost/server.mjs'],{
      env:{...process.env,HOST:'127.0.0.1',PORT:String(port),SOL_DATA_DIR:directory,SOL_PASSWORD:password,SOL_USERNAME:'tester'},
      stdio:['ignore','pipe','pipe'],
    });
    child.stdout.on('data',data=>{logs+=data;}); child.stderr.on('data',data=>{logs+=data;});
    for(let attempt=0;attempt<150;attempt++) {
      if(child.exitCode!==null) throw Error(logs);
      try {if((await fetch(base+'/healthz',{signal:AbortSignal.timeout(1000)})).ok)return;}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw Error('Production server did not start: '+logs);
  }
  async function stop() {
    if(child&&child.exitCode===null) {
      const exited=once(child,'exit'); child.kill('SIGTERM');
      const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
      try {await exited;} finally {clearTimeout(timer);}
    }
  }
  async function request(path,method='GET',body,extraHeaders={}) {
    const form=body instanceof FormData;
    const response=await fetch(base+path,{
      method,headers:{...headers,...(body===undefined||form?{}:{'Content-Type':'application/json'}),...extraHeaders},
      body:body===undefined?undefined:form?body:JSON.stringify(body),signal:AbortSignal.timeout(15000),
    });
    const text=await response.text(); let data;
    try {data=JSON.parse(text);} catch {data={text};}
    return {status:response.status,ok:response.ok,data};
  }
  async function api(path,method='GET',body) {
    const result=await request(path,method,body);
    assert.ok(result.ok,`${method} ${path}: ${result.status} ${JSON.stringify(result.data)}\n${logs}`);
    return result.data;
  }
  function withStore(siteId,fn) {
    const manager=new PerformanceStoreManager(join(directory,'performance'));
    try{return fn(manager.site(siteId));}finally{manager.close();}
  }
  async function setup() {
    const site=(await api('/api/site-settings','POST',{name:'Synthetic performance test',country:'US',latitude:'35.2',longitude:'-80.8'})).site;
    const node=(id,type,parentId=null)=>({id,name:id,externalId:id,type,parentId,quantity:1,aliases:[],channels:[]});
    const equipment=[node('meter','revenue_meter'),{...node('transformer','transformer','meter'),nameplateKva:'200'},
      ...['inv1','inv2'].flatMap(id=>[{...node(id,'inverter','transformer'),acRatedCapacityKw:'100',maxDcCapacityKw:'150'},
        {...node(id+'-modules','module_group',id),moduleRatedCapacityW:'400',quantity:300}]),node('weather','weather_sensor')];
    await api('/api/equipment','PUT',{siteId:site.id,equipment,verified:true});
    return site.id;
  }
  async function analyze(siteId) {
    await api('/api/performance-summary','POST',{siteId,action:'reanalyze'});
    let result;
    for(let attempt=0;attempt<80;attempt++) {
      result=await api(`/api/performance-summary?siteId=${encodeURIComponent(siteId)}`);
      if(!result.processing)break;
    }
    assert.equal(result.hasData,true,JSON.stringify(result));
    assert.ok(result.analysis?.issues?.length>0,'Synthetic outage should generate findings');
    const history=await api(`/api/analysis-history?siteId=${encodeURIComponent(siteId)}`);
    const runId=result.issueDatabase?.analysisRunId||history.runs[0]?.id;
    assert.ok(runId);
    return {result,runId};
  }
  async function commit(siteId,preview,approveOverlap=false) {
    return api('/api/performance-data','POST',{action:'commit',siteId,stageId:preview.stageId,previewToken:preview.previewToken,approveOverlap});
  }
  t.after(async()=>{await stop();rmSync(directory,{recursive:true,force:true});});
  return {directory,base,headers,start,stop,request,api,setup,analyze,commit,withStore};
}

function telemetry() {
  const readings=[],lines=['Timestamp,Meter kWh,Inv1 kWh,Inv2 kWh,Expected kWh,Irradiance'];
  for(let day=1;day<=8;day++)for(let hour=0;hour<24;hour++) {
    const timestamp=`2026-05-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:00:00Z`;
    const healthy=hour>=8&&hour<=16?60:0, inv1=day===3||day===4?0:healthy;
    const values=[['meter','Energy',inv1+healthy,'kWh'],['inv1','Energy',inv1,'kWh'],['inv2','Energy',healthy,'kWh'],
      ['@site','Expected Production',healthy*2,'kWh'],['weather','Irradiance',healthy?600:0,'W/m2']];
    for(const [equipmentId,measurement,value,unit] of values)readings.push({timestamp,equipmentId,measurement,value,unit});
    lines.push([timestamp,inv1+healthy,inv1,healthy,healthy*2,healthy?600:0].join(','));
  }
  return {readings,csv:lines.join('\n')+'\n'};
}

function correctionForm(siteId) {
  const form=new FormData();
  form.set('file',new File(['Timestamp,Inv1 kWh\n2026-05-07T12:00:00Z,30\n'],'correction.csv',{type:'text/csv'}));
  form.set('siteId',siteId); form.set('timezone','UTC');
  form.set('mapping',JSON.stringify({timestamp:'Timestamp'}));
  form.set('equipmentMapping',JSON.stringify({signals:[{column:'Inv1 kWh',equipmentId:'inv1',measurement:'Energy'}]}));
  form.set('detectedTypes','["Energy"]');
  form.set('validation',JSON.stringify({timestampConvention:'start',intervalMinutes:60,timezone:'UTC',totalRows:1,validRows:1,errors:0}));
  return form;
}

async function confirmedReview(f,siteId,runId,analysis) {
  const issue=analysis.analysis.issues[0];
  const path=`/api/issue-reviews?siteId=${siteId}&runId=${runId}&issueId=${encodeURIComponent(issue.id)}`;
  const existing=await f.api(path);
  await f.api('/api/issue-reviews','POST',{siteId,runId,issueId:issue.id,baseVersion:existing.review.version,
    state:{...existing.review.state,status:'Confirmed',classification:'Fuse Failure'},note:'Retain this reviewed finding through data corrections.'});
  return path;
}

for(const correction of ['data','model']) test(`failed first analysis can explicitly analyze corrected ${correction} over production HTTP`, {timeout:120000}, async t=>{
  const f=await fixture(t);await f.start();const siteId=await f.setup(),source=telemetry();
  // The actual model API permits one revenue meter. Omit its initial readings;
  // in the model-correction case they were mapped to the weather equipment.
  const initialReadings=correction==='data'
    ? source.readings.filter(row=>row.equipmentId!=='meter')
    : source.readings.map(row=>row.equipmentId==='meter'?{...row,equipmentId:'weather'}:row);
  const previewReadings=async readings=>(await f.api('/api/performance-data','POST',{action:'preview',siteId,timezone:'UTC',timestampConvention:'start',intervalMinutes:60,readings})).preview;
  await f.commit(siteId,await previewReadings(initialReadings));
  const initialRevision=f.withStore(siteId,store=>store.describe().revision);
  const inspect=fn=>{const db=new LocalDatabase(join(f.directory,'sol-diagnostics.sqlite'),resolve('drizzle'));try{return fn(db.sqlite);}finally{db.close();}};
  const input=async attemptId=>{
    const db=new LocalDatabase(join(f.directory,'sol-diagnostics.sqlite'),resolve('drizzle'));
    try {
      const bucket=new LocalBucket(db,join(f.directory,'objects'));
      const object=await bucket.get(`analysis/${siteId}/jobs/${attemptId}/input.json`);assert.ok(object);
      // Each source-loader call owns a VM realm; compare JSON checkpoint values
      // in the host realm rather than treating distinct Array prototypes as edits.
      return JSON.parse(JSON.stringify(await loadSource('app/api/performance-summary/checkpoint-storage.ts').readCheckpoint(object)));
    } finally {db.close();}
  };
  const finish=async()=>{
    for(let i=0;i<80;i++){
      const result=await f.api(`/api/performance-summary?siteId=${siteId}`);
      if(!result.processing)return result;
    }
    assert.fail('Synthetic analysis did not reach a terminal state');
  };
  const started=await f.api('/api/performance-summary','POST',{siteId,action:'reanalyze'}),oldAttempt=started.progress.attemptId;
  const failed=await finish();assert.equal(failed.hasData,false);assert.equal(failed.progress.status,'failed');
  const oldInput=await input(oldAttempt);assert.equal(JSON.parse(oldInput.record.validation).datasetRevision,initialRevision);
  assert.equal((await f.api(`/api/analysis-history?siteId=${siteId}`)).runs.length,0);
  if(correction==='data') {
    await f.commit(siteId,await previewReadings(source.readings.filter(row=>row.equipmentId==='meter')));
  } else {
    const {equipment}=await f.api(`/api/equipment?siteId=${siteId}`);
    const corrected=equipment.filter(asset=>asset.id!=='meter').map(asset=>asset.id==='weather'
      ? {...asset,type:'revenue_meter',name:'Corrected revenue meter',parentId:null}
      : asset.parentId==='meter'?{...asset,parentId:'weather'}:asset);
    await f.api('/api/equipment','PUT',{siteId,equipment:corrected,verified:true});
    assert.equal((await f.api(`/api/equipment?siteId=${siteId}`)).equipment.find(asset=>asset.id==='weather').type,'revenue_meter');
  }
  const jobsBefore=inspect(db=>db.prepare('SELECT attempt_id,status FROM analysis_jobs WHERE site_id=? ORDER BY id').all(siteId));
  const corrected=await f.api(`/api/performance-summary?siteId=${siteId}`);
  assert.equal(corrected.hasData,false);assert.equal(corrected.progress.attemptId,oldAttempt);
  assert.equal(corrected.progress.status,'failed');assert.equal(corrected.analysisRequired,true,'The UI must be allowed to start a new analysis of corrected inputs');
  assert.deepEqual(inspect(db=>db.prepare('SELECT attempt_id,status FROM analysis_jobs WHERE site_id=? ORDER BY id').all(siteId)),jobsBefore,'Browsing must not start a fresh attempt');

  const retried=await f.api('/api/performance-summary','POST',{siteId,attemptId:oldAttempt,action:'retry'});
  const failedAgain=await finish();assert.equal(failedAgain.hasData,false);assert.equal(failedAgain.progress.status,'failed');
  const retriedInput=await input(retried.progress.attemptId);
  assert.equal(JSON.parse(retriedInput.record.validation).datasetRevision,initialRevision);
  assert.equal(retriedInput.modelRevision,oldInput.modelRevision);
  assert.deepEqual(retriedInput.equipment,oldInput.equipment,'Retry must not silently adopt the corrected model');

  const fresh=await f.api('/api/performance-summary','POST',{siteId,action:'reanalyze'});
  assert.notEqual(fresh.progress.attemptId,oldAttempt);
  const published=await finish();assert.equal(published.hasData,true,JSON.stringify(published));
  assert.equal(published.issueDatabase.analysisRunId,fresh.progress.attemptId);
  assert.equal(published.provenance.revision,f.withStore(siteId,store=>store.describe().revision));
  if(correction==='model')assert.notEqual((await input(fresh.progress.attemptId)).modelRevision,oldInput.modelRevision);
  // A read-stage Retry replaces that job's attempt ID by design; the retried
  // stopped attempt remains independently addressable after the fresh run.
  assert.equal((await f.api(`/api/performance-summary?siteId=${siteId}&attemptId=${retried.progress.attemptId}`)).progress.status,'failed');
  assert.deepEqual(await input(oldAttempt),oldInput,'The original input checkpoint must remain retained');
  assert.equal((await f.api(`/api/analysis-history?siteId=${siteId}`)).runs.length,1);
});

test('stopped reruns retain the published current report, review editing and explicit attempt status over HTTP', {timeout:120000}, async t=>{
  const f=await fixture(t);await f.start();const siteId=await f.setup(),source=telemetry();
  const {preview}=await f.api('/api/performance-data','POST',{action:'preview',siteId,timezone:'UTC',timestampConvention:'start',intervalMinutes:60,readings:source.readings});
  await f.commit(siteId,preview);const {result:original,runId}=await f.analyze(siteId);
  const originalSnapshot=await f.api(`/api/analysis-history?siteId=${siteId}&runId=${runId}`);
  const reviewPath=await confirmedReview(f,siteId,runId,original);
  const inspect=fn=>{const db=new LocalDatabase(join(f.directory,'sol-diagnostics.sqlite'),resolve('drizzle'));try{return fn(db.sqlite);}finally{db.close();}};
  for(const status of ['canceled','failed','interrupted']){
    const started=await f.api('/api/performance-summary','POST',{siteId,action:'reanalyze'}),attemptId=started.progress.attemptId;
    assert.notEqual(attemptId,runId);
    if(status==='canceled')await f.api('/api/performance-summary','POST',{siteId,attemptId,action:'cancel'});
    else inspect(db=>assert.equal(db.prepare('UPDATE analysis_jobs SET status=?,error=?,lease_token=?,lease_until=0,updated_at=? WHERE site_id=? AND attempt_id=?')
      .run(status,`Synthetic ${status} rerun`,'',Date.now(),siteId,attemptId).changes,1));
    const before=inspect(db=>db.prepare('SELECT attempt_id,status FROM analysis_jobs WHERE site_id=?').all(siteId));
    const current=await f.api(`/api/performance-summary?siteId=${siteId}`);
    assert.equal(current.hasData,true,`${status} rerun must not hide the published result`);
    assert.equal(current.issueDatabase.analysisRunId,runId);assert.equal(current.lastAttempt.attemptId,attemptId);assert.equal(current.lastAttempt.status,status);
    assert.equal(current.processing,false);assert.deepEqual(current.analysis,original.analysis);
    assert.deepEqual(inspect(db=>db.prepare('SELECT attempt_id,status FROM analysis_jobs WHERE site_id=?').all(siteId)),before,'Browsing must not start or resume work');
    const attempt=await f.api(`/api/performance-summary?siteId=${siteId}&attemptId=${attemptId}`);assert.equal(attempt.progress.status,status);assert.equal(attempt.hasData,false);
    assert.equal((await f.api(`/api/analysis-history?siteId=${siteId}`)).runs.find(run=>run.id===runId).is_current,true);
    const review=await f.api(reviewPath);assert.equal(review.review.state.status,'Confirmed');
    await f.api('/api/issue-reviews','POST',{siteId,runId,issueId:original.analysis.issues[0].id,baseVersion:review.review.version,state:review.review.state,note:`Review remains editable after ${status} rerun.`});
    const saved=await f.api(reviewPath);assert.equal(saved.review.version,review.review.version+1);assert.equal(saved.review.state.status,'Confirmed');
    assert.deepEqual((await f.api(`/api/analysis-history?siteId=${siteId}&runId=${runId}`)).analysis,originalSnapshot.analysis);
  }
});

test('production performance databases: preview/approval, partial CSV+API corrections, freshness, immutable reviews and restart', {timeout:240000}, async t=>{
  const f=await fixture(t); await f.start(); const siteId=await f.setup();
  const source=telemetry();
  const initial={action:'preview',siteId,timezone:'UTC',timestampConvention:'start',intervalMinutes:60,fileName:'synthetic-api',readings:source.readings};
  const {preview}=await f.api('/api/performance-data','POST',initial);
  assert.equal((await f.api(`/api/performance-data?siteId=${siteId}`)).dataset.revision,0,'Preview must not write canonical measurements');
  assert.equal(preview.counts.overlapping,0); assert.equal(preview.counts.added,source.readings.length);
  assert.ok(!(await f.api('/api/site-settings')).sitesWithPerformanceData.includes(siteId),'An uncommitted preview is not a dataset');
  const first=await f.commit(siteId,preview);
  assert.equal(first.dataset.readingCount,source.readings.length);
  assert.ok((await f.api('/api/site-settings')).sitesWithPerformanceData.includes(siteId),'Canonical data must appear in the site inventory after commit');
  assert.deepEqual((await f.commit(siteId,preview)).result,first.result,'Commit replay returns the original result');
  const {result:original,runId:oldRun}=await f.analyze(siteId);
  const oldSnapshot=await f.api(`/api/analysis-history?siteId=${siteId}&runId=${oldRun}`);
  assert.equal((await f.api(`/api/analysis-freshness?siteId=${siteId}&runId=${oldRun}`)).status,'current');
  const reviewPath=await confirmedReview(f,siteId,oldRun,original);
  const readValue=(timestamp,id)=>f.withStore(siteId,s=>[...s.rows()].find(row=>row.timestamp===timestamp&&row.channel.equipmentId===id)?.value);
  const correctedTime='2026-05-07T12:00:00.000Z';
  assert.equal(readValue(correctedTime,'inv1'),60);

  let staged=(await f.api('/api/telemetry-imports','POST',correctionForm(siteId))).preview;
  assert.equal(staged.counts.overlapping,1); assert.equal(staged.counts.changed,1);
  const denied=await f.request('/api/performance-data','POST',{action:'commit',siteId,stageId:staged.stageId,previewToken:staged.previewToken,approveOverlap:false});
  assert.ok([403,409].includes(denied.status),JSON.stringify(denied));
  assert.equal(readValue(correctedTime,'inv1'),60);
  await f.api('/api/performance-data','POST',{action:'cancel',siteId,stageId:staged.stageId});
  assert.equal(readValue(correctedTime,'inv1'),60);

  staged=(await f.api('/api/telemetry-imports','POST',correctionForm(siteId))).preview;
  const extension=(await f.api('/api/performance-data','POST',{...initial,fileName:'unrelated-extension',readings:[
    {timestamp:'2026-05-09T00:00:00Z',equipmentId:'inv1',measurement:'Energy',unit:'kWh',value:0},
  ]})).preview;
  await f.commit(siteId,extension);
  assert.equal((await f.api(`/api/analysis-freshness?siteId=${siteId}&runId=${oldRun}`)).status,'current','Out-of-domain append must not mark old findings older');
  const stale=await f.request('/api/performance-data','POST',{action:'commit',siteId,stageId:staged.stageId,previewToken:staged.previewToken,approveOverlap:true});
  assert.equal(stale.status,409,JSON.stringify(stale));
  assert.equal(readValue(correctedTime,'inv1'),60);

  staged=(await f.api('/api/telemetry-imports','POST',correctionForm(siteId))).preview;
  await f.commit(siteId,staged,true);
  assert.equal(readValue(correctedTime,'inv1'),30);
  assert.equal(readValue(correctedTime,'inv2'),60,'Omitted channel remains intact');
  assert.equal(readValue('2026-05-07T11:00:00.000Z','inv1'),60,'Omitted timestamp remains intact');
  assert.equal((await f.api(`/api/analysis-freshness?siteId=${siteId}&runId=${oldRun}`)).status,'older');
  assert.deepEqual((await f.api(`/api/analysis-history?siteId=${siteId}&runId=${oldRun}`)).analysis,oldSnapshot.analysis,'Saved analysis results remain immutable');
  assert.equal((await f.api(reviewPath)).review.state.status,'Confirmed');
  const {runId:newRun}=await f.analyze(siteId);
  assert.notEqual(newRun,oldRun);
  assert.equal((await f.api(`/api/analysis-freshness?siteId=${siteId}&runId=${newRun}`)).status,'current');

  const identical=(await f.api('/api/telemetry-imports','POST',correctionForm(siteId))).preview;
  assert.equal(identical.counts.identical,1); assert.equal(identical.counts.changed,0);
  await f.commit(siteId,identical,true);
  assert.equal((await f.api(`/api/analysis-freshness?siteId=${siteId}&runId=${newRun}`)).status,'current');
  const blank=(await f.api('/api/performance-data','POST',{...initial,readings:[
    {timestamp:correctedTime,equipmentId:'inv1',measurement:'Energy',unit:'kWh',value:null},
  ]})).preview;
  assert.equal(blank.counts.blankPreserved,1);
  await f.commit(siteId,blank,true); assert.equal(readValue(correctedTime,'inv1'),30);
  assert.equal((await f.api(`/api/analysis-freshness?siteId=${siteId}&runId=${newRun}`)).status,'current');
  assert.equal((await f.request('/api/performance-data','POST',initial,{Origin:'https://untrusted.example'})).status,403);
  assert.equal((await fetch(f.base+`/api/performance-data?siteId=${siteId}`,{signal:AbortSignal.timeout(15000)})).status,401);
  const beforeRestart=(await f.api(`/api/performance-data?siteId=${siteId}`)).dataset;
  await f.stop(); await f.start();
  assert.deepEqual((await f.api(`/api/performance-data?siteId=${siteId}`)).dataset,beforeRestart);
  assert.equal(readValue(correctedTime,'inv1'),30);
  assert.equal((await f.api(reviewPath)).review.state.status,'Confirmed');
  assert.equal((await f.api(`/api/analysis-freshness?siteId=${siteId}&runId=${oldRun}`)).status,'older');
  t.diagnostic(`Verified ${source.readings.length} initial readings, approved partial correction, retained review, old/new freshness and restart.`);
});

test('production migration: retained CSV previews without writes and preserves original file, historical analysis and review', {timeout:240000}, async t=>{
  const f=await fixture(t); await f.start(); const siteId=await f.setup(); await f.stop();
  const source=telemetry(),id=randomUUID(),objectKey=`mapped/${siteId}/legacy.csv`,createdAt='2026-05-10T00:00:00.000Z';
  const mapping={roles:{timestamp:'Timestamp',expectedProduction:'Expected kWh'},equipment:{signals:[
    {column:'Meter kWh',equipmentId:'meter',measurement:'Energy'},
    {column:'Inv1 kWh',equipmentId:'inv1',measurement:'Energy'},
    {column:'Inv2 kWh',equipmentId:'inv2',measurement:'Energy'},
    {column:'Irradiance',equipmentId:'weather',measurement:'Irradiance'},
  ]}};
  const validation={timestampConvention:'start',intervalMinutes:60,timezone:'UTC',totalRows:192,validRows:192,errors:0};
  const db=new LocalDatabase(join(f.directory,'sol-diagnostics.sqlite'),resolve('drizzle'));
  try {
    const bucket=new LocalBucket(db,join(f.directory,'objects'));
    await bucket.put(objectKey,source.csv,{httpMetadata:{contentType:'text/csv'}});
    await db.prepare(`INSERT INTO telemetry_imports(id,site_id,file_name,object_key,file_size,row_count,valid_rows,warning_count,error_count,status,timezone,mapping,detected_types,validation,timestamp_start,timestamp_end,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,siteId,'legacy.csv',objectKey,Buffer.byteLength(source.csv),192,192,0,0,'imported','UTC',JSON.stringify(mapping),'["Energy","Irradiance"]',JSON.stringify(validation),'2026-05-01T00:00:00Z','2026-05-08T23:00:00Z',createdAt).run();
  } finally {db.close();}
  await f.start();
  assert.equal((await f.api(`/api/performance-data?siteId=${siteId}`)).requiresMigration,true);
  const {result:legacyAnalysis,runId:legacyRun}=await f.analyze(siteId);
  const reviewPath=await confirmedReview(f,siteId,legacyRun,legacyAnalysis);
  assert.equal((await f.api(`/api/analysis-freshness?siteId=${siteId}&runId=${legacyRun}`)).status,'unknown');
  const {preview}=await f.api('/api/performance-data','POST',{action:'previewLegacy',siteId});
  assert.equal((await f.api(`/api/performance-data?siteId=${siteId}`)).dataset.revision,0);
  await f.commit(siteId,preview);
  assert.equal((await f.api(`/api/performance-data?siteId=${siteId}`)).requiresMigration,false);
  const {result:migrated,runId:newRun}=await f.analyze(siteId);
  assert.notEqual(newRun,legacyRun);
  const facts=result=>result.analysis.issues.map(issue=>({type:issue.type,equipmentId:issue.equipmentId,start:issue.startDateTime,end:issue.endDateTime,loss:issue.estimatedLossKwh}));
  assert.deepEqual(facts(migrated),facts(legacyAnalysis),'Canonical database analysis must preserve equivalent CSV findings/losses');
  assert.equal((await f.api(reviewPath)).review.state.status,'Confirmed');
  assert.deepEqual(facts(await f.api(`/api/analysis-history?siteId=${siteId}&runId=${legacyRun}`)),facts(legacyAnalysis));
  await f.stop();
  const check=new LocalDatabase(join(f.directory,'sol-diagnostics.sqlite'),resolve('drizzle'));
  try {
    assert.equal((await check.prepare('SELECT id FROM telemetry_imports WHERE id=?').bind(id).first()).id,id);
    const bucket=new LocalBucket(check,join(f.directory,'objects'));
    assert.equal(await (await bucket.get(objectKey)).text(),source.csv);
  } finally {check.close();}
  t.diagnostic('Legacy CSV bytes/import row, equivalent findings and saved review survived explicit migration.');
});
