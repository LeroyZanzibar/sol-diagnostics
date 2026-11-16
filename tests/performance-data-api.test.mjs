import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {loadSource,modelCapacityBindings} from './source-module.mjs';
import {LocalDatabase,LocalBucket} from '../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../selfhost/performance-store.mjs';
import {createHash,webcrypto} from 'node:crypto';
const time=loadSource('app/telemetry-time.ts'),csv=loadSource('app/telemetry-csv.ts',[],{...modelCapacityBindings(),...time});
const ingest=loadSource('app/performance-ingest.ts',[],{...time,...csv});
async function fixture(t,overrides={}){
 const root=mkdtempSync(join(tmpdir(),'sol-ingest-api-')),db=new LocalDatabase(join(root,'shared.sqlite'),'drizzle'),bucket=new LocalBucket(db,join(root,'objects')),manager=new PerformanceStoreManager(join(root,'performance'));
 t.after(()=>{manager.close();db.close();rmSync(root,{recursive:true,force:true});});
 db.sqlite.exec("INSERT INTO site_settings(id,name) VALUES ('site','Synthetic site'),('other','Other site'); INSERT INTO equipment_assets(id,site_id,type,name,external_id) VALUES ('meter','site','revenue_meter','Meter','MTR'),('inv','site','inverter','Inverter','INV'),('meter2','site','revenue_meter','Second meter','MTR2'),('other-meter','other','revenue_meter','Other meter','OTHER');");
 const bindings={...ingest,...time,getDatabaseBinding:()=>db,getBucketBinding:()=>bucket,getPerformanceStoreManager:()=>manager,depotCleanupInProgress:async()=>false,...overrides};
 const service=loadSource('app/api/performance-data/service.ts',[],bindings),route=loadSource('app/api/performance-data/route.ts',[],{...bindings,...service});
 const shared=loadSource('app/api/telemetry-imports/shared.ts',[],{...bindings,...service});
 const uploadRoute=loadSource('app/api/telemetry-imports/route.ts',[],{...bindings,...service,...shared,TransformStream});
 const finalizeRoute=loadSource('app/api/telemetry-imports/finalize/route.ts',[],{...bindings,...service,...shared});
 const chunkRoute=loadSource('app/api/telemetry-imports/chunk/route.ts',[],{...bindings,...service,...shared});
 const send=async(body,status=200)=>{const response=await route.POST(new Request('http://local/api/performance-data',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':'real-user'},body:JSON.stringify(body)}));const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));assert.match(response.headers.get('cache-control'),/no-store/);return value;};
 const get=async(query='siteId=site',status=200)=>{const response=await route.GET(new Request(`http://local/api/performance-data?${query}`));const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));assert.match(response.headers.get('cache-control'),/no-store/);return value;};
 const preview=(readings,extra={})=>send({action:'preview',siteId:'site',timezone:'UTC',timestampConvention:'start',intervalMinutes:60,readings,...extra});
 const commit=(preview,approveOverlap=false,status=200,extra={})=>send({action:'commit',siteId:'site',stageId:preview.stageId,previewToken:preview.previewToken,approveOverlap,...extra},status);
 return {root,db,bucket,manager,route,service,shared,uploadRoute,finalizeRoute,chunkRoute,send,get,preview,commit};
}
const r=(timestamp,value,extra={})=>({timestamp,equipmentId:'meter',measurement:'Energy',value,...extra});
const t0='2026-01-01T00:00:00Z',t1='2026-01-01T01:00:00Z';
test('API previews never modify canonical data; partial approved commit preserves omitted rows/channels and blanks',async t=>{
 const f=await fixture(t),initial=(await f.preview([r(t0,1),r(t1,2),r(t0,3,{equipmentId:'inv'})])).preview;
 assert.equal((await f.get()).dataset.revision,0);assert.equal([...f.manager.site('site').rows()].length,0);
 assert.equal((await f.commit(initial,false,200,{actor:'forged actor',modelRevision:'forged model'})).committed,true);
 const correction=(await f.preview([r(t0,0),r(t1,null)])).preview;
 assert.equal(correction.counts.overlapping,2);await f.commit(correction,false,409);
 assert.equal(f.manager.site('site').describe().revision,1);
 await f.commit(correction,true);const rows=[...f.manager.site('site').rows()];
 assert.equal(rows.length,3);assert.equal(rows.find(x=>x.timestamp.startsWith('2026-01-01T00')&&x.channel.equipmentId==='meter').value,0);assert.equal(rows.find(x=>x.timestamp.startsWith('2026-01-01T01')).value,2);assert.equal(rows.find(x=>x.channel.equipmentId==='inv').value,3);
 const audit=(await f.get()).imports;assert.ok(audit.every(item=>item.actor==='real-user'));assert.equal(audit[0].overlapApproved,true);
 assert.equal((await f.get('siteId=other')).dataset.revision,0);
});
test('stale dataset/model/token, cancellation and stage replay are guarded',async t=>{
 const f=await fixture(t),a=(await f.preview([r(t0,1)])).preview,b=(await f.preview([r(t1,2)])).preview;
 await f.commit(a);await f.commit(b,false,409);
 const replay=await f.commit(a);assert.equal(replay.result.revision,1);
 const c=(await f.preview([r(t1,2)])).preview;
 await f.commit(c,false,409,{previewToken:'forged'});
 f.db.sqlite.exec("UPDATE equipment_assets SET aliases='[\"changed\"]' WHERE id='meter'");await f.commit(c,false,409);
 const d=(await f.preview([r(t1,2)])).preview;assert.equal((await f.send({action:'cancel',siteId:'site',stageId:d.stageId})).preview.status,'canceled');await f.commit(d,false,409);
 assert.equal((await f.get()).dataset.revision,1);assert.equal((await f.get(`siteId=site&stageId=${a.stageId}`)).preview.status,'committed');
 await f.get(`siteId=other&stageId=${a.stageId}`,400);
});
test('API validates exact equipment, invalid numerics, strict approval types and bounded JSON',async t=>{
 const f=await fixture(t);
 for(const patch of [{equipmentId:'MTR'},{equipmentId:'other-meter'},{value:'broken'}])await f.send({action:'preview',siteId:'site',timezone:'UTC',timestampConvention:'start',intervalMinutes:60,readings:[r(t0,1,patch)],validation:{errors:0}},400);
 const p=(await f.preview([r(t0,1)])).preview;await f.commit(p,false,400,{approveOverlap:'yes'});
 const unauthenticated=await f.route.POST(new Request('http://local/api/performance-data',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'commit',siteId:'site',stageId:p.stageId,previewToken:p.previewToken,approveOverlap:false,actor:'forged'})}));assert.equal(unauthenticated.status,401);assert.equal((await f.get()).dataset.revision,0);
 const invalid=await f.route.POST(new Request('http://local/api/performance-data',{method:'POST',headers:{'content-type':'application/json'},body:'{'}));assert.equal(invalid.status,400);
 await assert.rejects(ingest.readBoundedJson(new Request('http://local/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({too:'large'})}),4),/large/);
});
test('CSV validation is advisory, partial equipment accepted, source bytes retained outside legacy cleanup',async t=>{
 const f=await fixture(t),text='time,energy\n2026-01-01T00:00Z,1\n2026-01-01T01:00Z,2';
 const metadata={siteId:'site',fileName:'partial.csv',fileSize:Buffer.byteLength(text),timezone:'UTC',mapping:{timestamp:'time'},equipmentMapping:{signals:[{column:'energy',equipmentId:'meter',measurement:'Energy'}]},detectedTypes:[],validation:{errors:0,totalRows:99999,timestampConvention:'start'}};
 assert.equal(await f.shared.validateImport(metadata,['time','energy']),'');
 const p=await f.shared.retainImport(metadata,new Response(text).body,['time','energy']);assert.equal(p.status,'preview');assert.equal(f.manager.site('site').describe().revision,0);
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM telemetry_imports').get().n,0);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM performance_file_cleanup').get().n,0);
 assert.equal(await(await f.bucket.get(p.metadata.originalObjectKey)).text(),text);
 await f.commit(p);assert.equal(f.manager.site('site').describe().readingCount,2);
 const bad=text.replace(',2',',invalid');await assert.rejects(f.shared.retainImport({...metadata,fileSize:Buffer.byteLength(bad)},new Response(bad).body,['time','energy']),/numeric/i);
 assert.equal(f.manager.site('site').describe().revision,1);assert.equal(await(await f.bucket.get(p.metadata.originalObjectKey)).text(),text);
});
test('legacy migration is explicit and replay-safe and preserves original bytes, analyses and reviews',async t=>{
 const f=await fixture(t),text='time,energy\n2026-01-01T00:00Z,1\n2026-01-01T01:00Z,2',key='mapped/site/retained.csv';await f.bucket.put(key,text);
 f.db.sqlite.prepare('INSERT INTO telemetry_imports(id,site_id,file_name,object_key,file_size,row_count,valid_rows,timezone,mapping,detected_types,validation) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('old','site','retained.csv',key,Buffer.byteLength(text),2,2,'UTC',JSON.stringify({roles:{timestamp:'time'},equipment:{signals:[{column:'energy',equipmentId:'meter',measurement:'Energy'}]}}),'[]',JSON.stringify({timestampConvention:'end',intervalMinutes:60}));
 f.db.sqlite.exec("INSERT INTO analysis_runs(id,site_id,import_id,parser_version,model_revision,analysis_object_key) VALUES ('old-run','site','old',28,'old-model','analysis/site/old.json'); INSERT INTO issue_event_reviews(id,site_id,event_key,version,state,updated_at) VALUES ('review-id','site','review',1,'{}','now');");
 await f.bucket.put('analysis/site/old.json','retained analysis');
 const snapshot=()=>JSON.stringify({imports:f.db.sqlite.prepare('SELECT * FROM telemetry_imports').all(),runs:f.db.sqlite.prepare('SELECT * FROM analysis_runs').all(),reviews:f.db.sqlite.prepare('SELECT * FROM issue_event_reviews').all()});const before=snapshot();
 assert.equal((await f.get()).requiresMigration,true);
 await f.send({action:'preview',siteId:'site',timezone:'UTC',timestampConvention:'start',intervalMinutes:60,readings:[r(t0,1)]},409);
 const [first,second]=await Promise.all([f.send({action:'previewLegacy',siteId:'site'}),f.send({action:'previewLegacy',siteId:'site'})]);const a=first.preview,b=second.preview;
 assert.equal(a.stageId,b.stageId);assert.equal(a.metadata.source,'migration');assert.equal(a.metadata.sourceImportId,'old');assert.equal((await f.get()).dataset.revision,0);
 await f.commit(a);await f.commit(a);assert.equal((await f.get()).requiresMigration,false);assert.equal((await f.get()).dataset.revision,1);
 assert.equal((await f.send({action:'previewLegacy',siteId:'site'})).preview.stageId,a.stageId);
 assert.equal(snapshot(),before);assert.equal(await(await f.bucket.get(key)).text(),text);assert.equal(await(await f.bucket.get('analysis/site/old.json')).text(),'retained analysis');
});

const csvMeta=(text,patch={})=>({siteId:'site',fileName:'partial.csv',fileSize:Buffer.byteLength(text),timezone:'UTC',mapping:{timestamp:'time'},equipmentMapping:{signals:[{column:'energy',equipmentId:'meter',measurement:'Energy'}]},detectedTypes:[],validation:{errors:0,timestampConvention:'start'},...patch});
test('explicit channel IDs stay distinct in the real staged store and API',async t=>{
 const f=await fixture(t),p=(await f.preview([r(t0,1,{channelId:'export'}),r(t0,2,{channelId:'import'})])).preview;
 assert.equal(p.channelCount,2);await f.commit(p);
 const rows=[...f.manager.site('site').rows()];assert.equal(rows.length,2);assert.notEqual(rows[0].channel.id,rows[1].channel.id);
 const correction=(await f.preview([r(t0,3,{channelId:'export'})])).preview;await f.commit(correction,true);
 assert.deepEqual([...f.manager.site('site').rows()].map(x=>x.value).sort(),[2,3]);
});
test('CSV overlaps require approval; one-row correction uses stored cadence and cancel never deletes sources',async t=>{
 const f=await fixture(t);await f.commit((await f.preview([r(t0,1),r(t1,2)])).preview);
 const text='time,energy\n2026-01-01T00:00Z,0',p=await f.shared.retainImport(csvMeta(text),new Response(text).body,['time','energy']);
 assert.equal(p.metadata.intervalMinutes,60);assert.equal(p.counts.overlapping,1);await f.commit(p,false,409);
 await f.send({action:'cancel',siteId:'site',stageId:p.stageId});assert.equal((await f.get()).dataset.revision,1);
 assert.equal(await(await f.bucket.get(p.metadata.originalObjectKey)).text(),text);
 const replacement=await f.shared.retainImport(csvMeta(text),new Response(text).body,['time','energy']);await f.commit(replacement,true);await f.commit(replacement,true);
 assert.equal((await f.get()).dataset.revision,2);assert.deepEqual([...f.manager.site('site').rows()].map(x=>x.value),[0,2]);
});
test('CSV conflicts, unknown assignments, late numeric errors and incorrect byte counts never mutate canonical data',async t=>{
 const f=await fixture(t);await f.commit((await f.preview([r(t0,1)])).preview);
 for(const text of ['time,energy\n2026-01-01T00:00Z,1\n2026-01-01T00:00Z,2','time,energy\n2026-01-01T00:00Z,not-number'])await assert.rejects(f.shared.retainImport(csvMeta(text),new Response(text).body,['time','energy']),/duplicate|conflict|different values|numeric/i);
 const text='time,energy\n2026-01-01T00:00Z,1';
 await assert.rejects(f.shared.retainImport(csvMeta(text,{equipmentMapping:{signals:[{column:'energy',equipmentId:'missing',measurement:'Energy'}]}}),new Response(text).body,['time','energy']),/equipment/i);
 await assert.rejects(f.shared.retainImport(csvMeta(text,{fileSize:Buffer.byteLength(text)+1}),new Response(text).body,['time','energy']),/size/i);
 assert.equal((await f.get()).dataset.revision,1);assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM __sol_objects WHERE key LIKE 'mapped/%'").get().n,0);
 const same='time,energy\n2026-01-01T00:00Z,1\n2026-01-01T00:00Z,1',p=await f.shared.retainImport(csvMeta(same),new Response(same).body,['time','energy']);assert.equal(p.readingCount,1);
});
test('mapping model edits during server CSV parsing invalidate the preview and clean only its new source',async t=>{
 const f=await fixture(t),get=f.bucket.get.bind(f.bucket);let changed=false;
 f.bucket.get=async key=>{if(!changed&&key.startsWith('mapped/')){changed=true;f.db.sqlite.exec("UPDATE equipment_assets SET name='Edited while parsing' WHERE id='meter'");}return get(key);};
 const text='time,energy\n2026-01-01T00:00Z,1\n2026-01-01T01:00Z,2';
 await f.bucket.put('analysis/site/retained.json','saved result');
 await assert.rejects(f.shared.retainImport(csvMeta(text),new Response(text).body,['time','energy']),/changed/i);
 assert.equal((await f.get()).dataset.revision,0);assert.equal(await(await get('analysis/site/retained.json')).text(),'saved result');
 assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM __sol_objects WHERE key LIKE 'mapped/%'").get().n,0);
});
test('multipart and arbitrarily split chunk transports return previews, no canonical writes, and no-store errors',async t=>{
 const f=await fixture(t),text='time,energy\r\n2026-01-01T00:00Z,1\r\n2026-01-01T01:00Z,2',metadata=csvMeta(text),form=new FormData();
 form.set('file',new File([text],'partial.csv',{type:'text/csv'}));for(const [key,value] of Object.entries(metadata))if(!['fileName','fileSize'].includes(key))form.set(key,typeof value==='string'?value:JSON.stringify(value));
 const response=await f.uploadRoute.POST(new Request('http://local/api/telemetry-imports',{method:'POST',body:form})),result=await response.json();assert.equal(response.status,201,JSON.stringify(result));assert.ok(result.preview.stageId);assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(result.import,undefined);
 const uploadId=crypto.randomUUID();for(const [index,chunk] of [text.slice(0,3),text.slice(3)].entries()){
  const response=await f.chunkRoute.PUT(new Request(`http://local/api/telemetry-imports/chunk?uploadId=${uploadId}&part=${index+1}`,{method:'PUT',body:chunk}));assert.equal(response.status,201,await response.text());
 }
 const finalized=await f.finalizeRoute.POST(new Request('http://local/api/telemetry-imports/finalize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...metadata,uploadId,totalChunks:2})})),data=await finalized.json();
 assert.equal(finalized.status,201,JSON.stringify(data));assert.ok(data.preview.stageId);assert.equal((await f.get()).dataset.revision,0);assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM __sol_objects WHERE key LIKE 'upload-parts/%'").get().n,0);
 const malformed=await f.finalizeRoute.POST(new Request('http://local/api/telemetry-imports/finalize',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));assert.equal(malformed.status,400);assert.match(malformed.headers.get('cache-control'),/no-store/);
 const excessive=await f.chunkRoute.PUT(new Request(`http://local/api/telemetry-imports/chunk?uploadId=${crypto.randomUUID()}&part=1`,{method:'PUT',body:new Uint8Array(512*1024+1)}));assert.equal(excessive.status,400);
});
for(const measurement of ['Snow code','Status','Other']) test(`API ${measurement} snow-only data does not anchor a later production grid`,async t=>{
 const f=await fixture(t);
 f.db.sqlite.exec("INSERT INTO equipment_assets(id,site_id,type,name,external_id) VALUES ('snow','site','weather_sensor','Snow sensor','SNOW')");
 const observation='2026-06-01T00:17:00Z';
 await f.commit((await f.preview([r(observation,70,{equipmentId:'snow',measurement})],{timestampConvention:'end'})).preview);
 assert.equal([...f.manager.site('site').rows()][0].timestamp,new Date(observation).toISOString());
 const next=(await f.preview([r('2026-06-01T01:00Z',10)],{timestampConvention:'end'})).preview;
 assert.equal(next.counts.added,1);await f.commit(next);
 const rows=[...f.manager.site('site').rows()];assert.equal(rows.length,2);
 assert.equal(rows.find(row=>row.channel.equipmentId==='meter').timestamp,'2026-06-01T00:00:00.000Z');
 assert.equal(rows.find(row=>row.channel.equipmentId==='snow').timestamp,new Date(observation).toISOString());
});

test('expected production, missing new keys, Status/Other and snow timestamps persist without analytic clamping',async t=>{
 const f=await fixture(t),p=(await f.preview([r(t0,1,{equipmentId:'@site',measurement:'Expected Production',unit:'MWh'}),r(t1,null),r(t0,'fault',{equipmentId:'inv',measurement:'Status'}),r(t1,'operator note',{equipmentId:'inv',measurement:'Other'}),r('2026-01-01T01:37:00Z',70,{equipmentId:'meter2',measurement:'Snow code'})],{timestampConvention:'end'})).preview;
 await f.commit(p);const rows=[...f.manager.site('site').rows()];assert.equal(rows.length,5);
 assert.equal(rows.find(x=>x.channel.measurement==='Expected Production').value,1000);assert.equal(rows.find(x=>x.channel.measurement==='Expected Production').timestamp,'2025-12-31T23:00:00.000Z');
 assert.equal(rows.find(x=>x.channel.measurement==='Snow code').timestamp,'2026-01-01T01:37:00.000Z');assert.equal(rows.find(x=>x.channel.measurement==='Energy').value,null);assert.ok(rows.some(x=>x.value==='fault'));assert.ok(rows.some(x=>x.value==='operator note'));
});

function pauseFinalModelDigest(){
 const entered=Promise.withResolvers(),resume=Promise.withResolvers();let enabled=false,calls=0;
 return {entered:entered.promise,release:()=>resume.resolve(),enable:()=>{enabled=true;},crypto:{
  randomUUID:()=>webcrypto.randomUUID(),subtle:{digest:async(...args)=>{
   const result=await webcrypto.subtle.digest(...args);
   if(enabled&&++calls===2){entered.resolve();await resume.promise;}
   return result;
  }}
 }};
}
async function migrationPreview(f){
 const text='time,energy\n2026-01-01T00:00Z,1\n2026-01-01T01:00Z,2',key='mapped/site/legacy-race.csv';
 await f.bucket.put(key,text);
 f.db.sqlite.prepare('INSERT INTO telemetry_imports(id,site_id,file_name,object_key,file_size,row_count,valid_rows,timezone,mapping,detected_types,validation) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('legacy-race','site','legacy-race.csv',key,Buffer.byteLength(text),2,2,'UTC',JSON.stringify({roles:{timestamp:'time'},equipment:{signals:[{column:'energy',equipmentId:'meter',measurement:'Energy'}]}}),'[]',JSON.stringify({timestampConvention:'end',intervalMinutes:60}));
 return (await f.send({action:'previewLegacy',siteId:'site'})).preview;
}
const canonicalSnapshot=f=>JSON.stringify({dataset:f.manager.site('site').describe(),rows:[...f.manager.site('site').rows()],imports:f.manager.site('site').imports()});

function stageRaceState(f){
 const db=new DatabaseSync(join(f.root,'performance',`${createHash('sha256').update('site').digest('hex')}.sqlite`));
 try{return JSON.stringify({stages:db.prepare('SELECT * FROM stages ORDER BY stage_id').all(),readings:db.prepare('SELECT * FROM staged_readings ORDER BY stage_id,timestamp,channel_id').all(),channels:db.prepare('SELECT * FROM staged_channels ORDER BY stage_id,id').all()});}
 finally{db.close();}
}
const sourceSnapshot=f=>JSON.stringify(f.db.sqlite.prepare('SELECT * FROM __sol_objects ORDER BY key').all());
function independentStore(t,f){
 const manager=new PerformanceStoreManager(join(f.root,'performance'));
 t.after(()=>manager.close());
 return manager.site('site');
}
function independentCommit(store,preview){
 return store.commit(preview.stageId,{previewToken:preview.previewToken,approveOverlap:false,modelRevision:preview.metadata.modelRevision,actor:'independent-import'});
}
async function seedSnowOnly(f){
 f.db.sqlite.exec("INSERT INTO equipment_assets(id,site_id,type,name,external_id) VALUES ('snow','site','weather_sensor','Snow sensor','SNOW')");
 await f.commit((await f.preview([r('2026-01-01T00:17:00Z',70,{equipmentId:'snow',measurement:'Snow code'})])).preview);
}
async function multipartCsv(f,text,status){
 const form=new FormData(),metadata=csvMeta(text,{intervalMinutes:60});
 form.set('file',new File([text],'stage-race.csv',{type:'text/csv'}));
 for(const [key,value] of Object.entries(metadata))if(!['fileName','fileSize'].includes(key))form.set(key,typeof value==='string'?value:JSON.stringify(value));
 const response=await f.uploadRoute.POST(new Request('http://local/api/telemetry-imports',{method:'POST',body:form}));
 const body=await response.json();
 assert.equal(response.status,status,JSON.stringify(body));
 assert.match(response.headers.get('cache-control'),/no-store/);
 return body;
}
const offGrid='2026-01-01T00:30:00Z';
const racedCsv=`time,energy\n${offGrid},2\n2026-01-01T01:30:00Z,3`;

for(const snowOnly of [false,true])test(`Q1 JSON binds validation to the ${snowOnly?'snow-only':'empty'} revision across an independent commit before staging`,{timeout:10000},async t=>{
 const entered=Promise.withResolvers(),resume=Promise.withResolvers();let pauseNext=false;
 const f=await fixture(t,{depotCleanupInProgress:async()=>{if(pauseNext){pauseNext=false;entered.resolve();await resume.promise;}return false;}});
 if(snowOnly)await seedSnowOnly(f);
 const store=f.manager.site('site'),expectedRevision=store.describe().revision;
 const winner=(await f.preview([r(t0,1)])).preview,independent=independentStore(t,f);
 const stage=store.stage.bind(store);let stageOptions;
 store.stage=(metadata,readings,options)=>{stageOptions=options;return stage(metadata,readings,options);};
 const sources=sourceSnapshot(f);
 pauseNext=true;
 const pending=f.send({action:'preview',siteId:'site',timezone:'UTC',timestampConvention:'start',intervalMinutes:60,readings:[r(offGrid,2)]},409);
 let canonical,staged;
 try{
  await entered.promise;
  independentCommit(independent,winner);
  canonical=canonicalSnapshot(f);staged=stageRaceState(f);
 }finally{resume.resolve();}
 const rejected=await pending;
 assert.equal(rejected.code,'STALE_PREVIEW');assert.equal(rejected.preview,undefined);
 assert.equal(stageOptions.expectedRevision,expectedRevision);
 assert.equal(canonicalSnapshot(f),canonical,'the rejected import must add no readings, revisions or audit');
 assert.equal(stageRaceState(f),staged,'the stale import must allocate no stage or staged payload');
 assert.equal(sourceSnapshot(f),sources);
 const freshRejected=await f.send({action:'preview',siteId:'site',timezone:'UTC',timestampConvention:'start',intervalMinutes:60,readings:[r(offGrid,3)]},400);
 assert.match(freshRejected.error,/grid/i);
 const fresh=(await f.preview([r(t1,4)],{intervalMinutes:undefined})).preview;
 assert.equal(fresh.baseRevision,store.describe().revision);assert.equal(fresh.metadata.intervalMinutes,60);
 await f.send({action:'cancel',siteId:'site',stageId:fresh.stageId});
 assert.equal(canonicalSnapshot(f),canonical);
 assert.deepEqual([...store.rows()].filter(row=>row.channel.measurement==='Energy').map(row=>row.timestamp),['2026-01-01T00:00:00.000Z']);
});

for(const snowOnly of [false,true])test(`Q1 CSV binds validation to the ${snowOnly?'snow-only':'empty'} revision at the independent stage-entry race`,async t=>{
 const f=await fixture(t);
 if(snowOnly)await seedSnowOnly(f);
 const store=f.manager.site('site'),expectedRevision=store.describe().revision;
 const winner=(await f.preview([r(t0,1)])).preview,independent=independentStore(t,f);
 await f.bucket.put('mapped/site/retained.csv','retained source');
 await f.bucket.put('analysis/site/retained.json','retained analysis');
 const sources=sourceSnapshot(f),stage=store.stage.bind(store);
 let canonical,staged,allocated,stageOptions,injected=false;
 store.stage=(metadata,readings,options)=>{
  store.stage=stage;stageOptions=options;
  // Both parsing and the pre-stage freshness comparison have finished. Only
  // the independent real connection commits here; staging is not substituted.
  independentCommit(independent,winner);injected=true;
  canonical=canonicalSnapshot(f);staged=stageRaceState(f);allocated=metadata.originalObjectKey;
  assert.ok(f.db.sqlite.prepare('SELECT key FROM __sol_objects WHERE key=?').get(allocated));
  return stage(metadata,readings,options);
 };
 const rejected=await multipartCsv(f,racedCsv,409);
 assert.equal(injected,true);assert.equal(rejected.code,'STALE_PREVIEW');assert.equal(rejected.preview,undefined);
 assert.equal(stageOptions.expectedRevision,expectedRevision);
 assert.equal(canonicalSnapshot(f),canonical);assert.equal(stageRaceState(f),staged);
 assert.equal(await f.bucket.get(allocated),null,'only the rejected upload allocation is reclaimed');
 assert.equal(sourceSnapshot(f),sources);
 assert.equal(await(await f.bucket.get('mapped/site/retained.csv')).text(),'retained source');
 assert.equal(await(await f.bucket.get('analysis/site/retained.json')).text(),'retained analysis');
 assert.match((await multipartCsv(f,racedCsv,400)).error,/grid/i);
 assert.equal(sourceSnapshot(f),sources);
 const fresh=(await multipartCsv(f,`time,energy\n${t1},4`,201)).preview;
 assert.equal(fresh.baseRevision,store.describe().revision);
 await f.send({action:'cancel',siteId:'site',stageId:fresh.stageId});
 assert.equal(canonicalSnapshot(f),canonical);
 assert.deepEqual([...store.rows()].filter(row=>row.channel.measurement==='Energy').map(row=>row.timestamp),['2026-01-01T00:00:00.000Z']);
});

test('Q1 migration passes its validated revision and preserves the retained source on a stage-entry race',async t=>{
 const f=await fixture(t),store=f.manager.site('site');
 const winner=(await f.preview([r(t0,1)])).preview,independent=independentStore(t,f);
 const key='mapped/site/legacy-stage-race.csv';await f.bucket.put(key,racedCsv);
 f.db.sqlite.prepare('INSERT INTO telemetry_imports(id,site_id,file_name,object_key,file_size,row_count,valid_rows,timezone,mapping,detected_types,validation) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('legacy-stage-race','site','legacy-stage-race.csv',key,Buffer.byteLength(racedCsv),2,2,'UTC',JSON.stringify({roles:{timestamp:'time'},equipment:{signals:[{column:'energy',equipmentId:'meter',measurement:'Energy'}]}}),'[]',JSON.stringify({timestampConvention:'start',intervalMinutes:60}));
 const sources=sourceSnapshot(f),legacy=JSON.stringify(f.db.sqlite.prepare('SELECT * FROM telemetry_imports').all()),stage=store.stage.bind(store);
 let canonical,staged,stageOptions;
 store.stage=(metadata,readings,options)=>{
  store.stage=stage;stageOptions=options;assert.equal(metadata.source,'migration');
  independentCommit(independent,winner);canonical=canonicalSnapshot(f);staged=stageRaceState(f);
  return stage(metadata,readings,options);
 };
 const rejected=await f.send({action:'previewLegacy',siteId:'site'},409);
 assert.equal(rejected.code,'STALE_PREVIEW');assert.equal(rejected.preview,undefined);
 assert.equal(stageOptions.expectedRevision,0);
 assert.equal(canonicalSnapshot(f),canonical);assert.equal(stageRaceState(f),staged);
 assert.equal(sourceSnapshot(f),sources);assert.equal(await(await f.bucket.get(key)).text(),racedCsv);
 assert.equal(JSON.stringify(f.db.sqlite.prepare('SELECT * FROM telemetry_imports').all()),legacy);
});

for(const transport of ['json','csv'])test(`Q1 ${transport} defensively cancels a mismatched adapter preview even when it matches the new head`,async t=>{
 const f=await fixture(t),store=f.manager.site('site');
 const winner=(await f.preview([r(t0,1)])).preview,independent=independentStore(t,f),stage=store.stage.bind(store);
 let returned,canonical,stageOptions;
 const sources=sourceSnapshot(f);
 store.stage=async(metadata,readings,options)=>{
  store.stage=stage;stageOptions=options;independentCommit(independent,winner);canonical=canonicalSnapshot(f);
  // Simulate an adapter failing to honor the fence. Exercise the service's
  // independent defense with an actual persisted preview, not a fake result.
  returned=await stage(metadata,readings);
  assert.equal(returned.baseRevision,store.describe().revision);
  return returned;
 };
 const rejected=transport==='json'
  ?await f.send({action:'preview',siteId:'site',timezone:'UTC',timestampConvention:'start',intervalMinutes:60,readings:[r(offGrid,2)]},409)
  :await multipartCsv(f,racedCsv,409);
 assert.equal(rejected.code,'stale-preview');assert.equal(rejected.preview,undefined);
 assert.equal(stageOptions.expectedRevision,0);
 assert.equal(store.preview(returned.stageId).status,'canceled');
 const state=JSON.parse(stageRaceState(f));assert.deepEqual(state.readings,[]);assert.deepEqual(state.channels,[]);
 assert.equal(state.stages.filter(stage=>stage.status==='loading'||stage.status==='preview').length,0);
 assert.equal(canonicalSnapshot(f),canonical);assert.equal(sourceSnapshot(f),sources);
 if(transport==='csv')assert.equal(await f.bucket.get(returned.metadata.originalObjectKey),null);
 await f.commit(returned,false,409);
 assert.equal(canonicalSnapshot(f),canonical);
});

for(const source of ['api','csv','migration'])for(const edit of ['equipment','settings']){
 test(`${source} rejects a ${edit} change while the final real model digest is paused`,{timeout:10000},async t=>{
  const pause=pauseFinalModelDigest(),f=await fixture(t,{crypto:pause.crypto});
  let preview;
  if(source==='migration')preview=await migrationPreview(f);
  else{
   await f.commit((await f.preview([r(t0,1),r(t1,2)])).preview);
   const text='time,energy\n2026-01-01T00:00Z,0';
   preview=source==='api'?(await f.preview([r(t0,0)])).preview:await f.shared.retainImport(csvMeta(text),new Response(text).body,['time','energy']);
  }
  const before=canonicalSnapshot(f);pause.enable();
  const pending=f.commit(preview,true,409);
  try{
   await pause.entered;
   if(edit==='equipment')await f.db.batch([f.db.prepare("UPDATE equipment_assets SET name='Changed during final digest' WHERE id='meter'")]);
   else await f.db.prepare("UPDATE site_settings SET expected_snow='included' WHERE id='site'").run();
  }finally{pause.release();}
  const rejected=await pending;assert.match(rejected.error,/model|changed/i);
  assert.equal(canonicalSnapshot(f),before,'no readings, revisions or import audit may change');
  assert.equal(f.manager.site('site').preview(preview.stageId).status,'preview');
  assert.notEqual((await f.service.loadPerformanceContext('site')).modelRevision,preview.metadata.modelRevision);
 });
}
test('migration source identity is rechecked after the final paused digest', {timeout:10000},async t=>{
 const pause=pauseFinalModelDigest(),f=await fixture(t,{crypto:pause.crypto}),preview=await migrationPreview(f),before=canonicalSnapshot(f);
 pause.enable();const pending=f.commit(preview,false,409);
 try{await pause.entered;await f.db.prepare("UPDATE telemetry_imports SET id='changed-legacy' WHERE id='legacy-race'").run();}finally{pause.release();}
 assert.match((await pending).error,/retained CSV changed/i);assert.equal(canonicalSnapshot(f),before);
});
test('committed replay still returns its original receipt across a final-digest model edit', {timeout:10000},async t=>{
 const pause=pauseFinalModelDigest(),f=await fixture(t,{crypto:pause.crypto}),preview=(await f.preview([r(t0,1)])).preview,first=await f.commit(preview),before=canonicalSnapshot(f);
 pause.enable();const pending=f.commit(preview);
 try{await pause.entered;await f.db.prepare("UPDATE equipment_assets SET name='Edited after commit' WHERE id='meter'").run();}finally{pause.release();}
 assert.deepEqual((await pending).result,first.result);assert.equal(canonicalSnapshot(f),before);
});
test('final shared model lock spans the real canonical commit, and releases for queued settings writes',async t=>{
 const f=await fixture(t),preview=(await f.preview([r(t0,1)])).preview,store=f.manager.site('site'),commit=store.commit.bind(store);
 const other=new LocalDatabase(join(f.root,'shared.sqlite'),'drizzle');t.after(()=>other.close());other.sqlite.exec('PRAGMA busy_timeout=1');
 let queued,checked=false;
 store.commit=(...args)=>{
  assert.throws(()=>f.db.sqlite.prepare("UPDATE equipment_assets SET name='Reentrant writer' WHERE id='meter'").run(),/readonly/i);
  assert.throws(()=>other.sqlite.prepare("UPDATE site_settings SET name='Independent writer' WHERE id='site'").run(),/locked/i);
  queued=Promise.resolve().then(()=>f.db.prepare("UPDATE site_settings SET name='Queued after commit' WHERE id='site'").run());
  const result=commit(...args);checked=true;
  assert.throws(()=>other.sqlite.prepare("UPDATE site_settings SET name='Still guarded' WHERE id='site'").run(),/locked/i);
  return result;
 };
 assert.equal((await f.commit(preview)).result.revision,1);assert.equal(checked,true);await queued;
 assert.equal((await f.db.prepare("SELECT name FROM site_settings WHERE id='site'").first()).name,'Queued after commit');
 assert.equal(store.imports()[0].metadata.modelRevision,preview.metadata.modelRevision);
 assert.notEqual((await f.service.loadPerformanceContext('site')).modelRevision,preview.metadata.modelRevision);
});
test('canonical ingestion fails closed if the shared adapter cannot guard a synchronous snapshot',async t=>{
 const f=await fixture(t);f.db.withSynchronousRead=undefined;
 const error=await f.send({action:'preview',siteId:'site',timezone:'UTC',timestampConvention:'start',intervalMinutes:60,readings:[r(t0,1)]},500);
 assert.match(error.error,/synchronous.*guard/i);assert.equal(f.manager.site('site').describe().revision,0);
});

for(const transport of ['json','csv']){
 for(const [kind,timestamps] of [
  ['invalid calendar',['02/30/2026 00:00:00 GMT','2026-02-30T00:00:00Z','2026-02-29 00:00','1900-02-29T00:00Z','2100-02-29T00:00+05:45','04/31/2026 12:00 PM UTC']],
  ['unsupported precision',['2026-01-01T00:00:00.0001Z','2026-01-01T00:00:00.0002Z','2026-01-01T00:00:00.000001Z','2026-01-01T00:00:00.000002Z','2026-01-01T00:00:00.0000Z','01/01/2026 00:00:00.1234 GMT']],
  ['invalid offset or clock',['2026-01-01T24:00:00Z','2026-01-01T12:00:60Z','2026-01-01T12:00+24:00','2026-01-01T12:00+05:60','2026-01-01T12:00+5:00','2026-01-01T12:00Z trailing']],
 ])test(`${transport} rejects original ${kind} timestamps before touching the real canonical store`,async t=>{
  const f=await fixture(t);await f.commit((await f.preview([r(t0,7)])).preview);const before=canonicalSnapshot(f);
  for(const timestamp of timestamps){
   if(transport==='json'){
    const response=await f.send({action:'preview',siteId:'site',timezone:'UTC',timestampConvention:'start',intervalMinutes:60,readings:[r(t0,1),r(timestamp,1)]},400);
    assert.match(response.error,/timestamp|precision|calendar/i);
   }else{
    const text=`time,energy\n${t0},1\n${timestamp},1`;
    await assert.rejects(f.shared.retainImport(csvMeta(text),new Response(text).body,['time','energy']),/timestamp|precision|calendar/i,timestamp);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM __sol_objects WHERE key LIKE 'mapped/%'").get().n,0,'failed source only is reclaimed');
   }
   assert.equal(canonicalSnapshot(f),before,timestamp);
  }
 });
 test(`${transport} preserves leap dates, milliseconds, offsets and interval-end zero semantics in real storage`,async t=>{
  const f=await fixture(t),timestamps=['2024-02-29T01:00:00.001+05:45','02/29/2024 01:00:00.002 GMT','2024/02/29 01:00:00.003','2024-03-01T01:00:00.004Z'];
  // Snow-only readings use observation time, so unequal millisecond phases do
  // not invent an interval grid. Energy is tested separately below.
  let preview;
  if(transport==='json')preview=(await f.preview(timestamps.map(timestamp=>r(timestamp,0,{measurement:'Snow code'})),{timestampConvention:'end'})).preview;
  else{
   const text='time,energy\n'+timestamps.map(timestamp=>`${timestamp},0`).join('\n');
   preview=await f.shared.retainImport(csvMeta(text,{intervalMinutes:60,validation:{timestampConvention:'end'},equipmentMapping:{signals:[{column:'energy',equipmentId:'meter',measurement:'Snow code'}]}}),new Response(text).body,['time','energy']);
  }
  await f.commit(preview);assert.deepEqual([...f.manager.site('site').rows()].map(x=>[x.timestamp,x.value]),[
   ['2024-02-28T19:15:00.001Z',0],['2024-02-29T01:00:00.002Z',0],['2024-02-29T01:00:00.003Z',0],['2024-03-01T01:00:00.004Z',0]
  ]);
  if(transport==='json')preview=(await f.preview([r('2024-03-01T00:00:00.125+00:00',0)],{timestampConvention:'end'})).preview;
  else{
   const text='time,energy\n2024-03-01T00:00:00.125+00:00,0';
   preview=await f.shared.retainImport(csvMeta(text,{validation:{timestampConvention:'end'}}),new Response(text).body,['time','energy']);
  }
  await f.commit(preview);assert.equal([...f.manager.site('site').rows()].find(x=>x.channel.measurement==='Energy').timestamp,'2024-02-29T23:00:00.125Z');
 });
 test(`${transport} keeps both DST-fold instants distinct and rejects ambiguous or missing wall times`,async t=>{
  const f=await fixture(t),timezone='America/New_York',timestamps=['2026-11-01T01:30-04:00','2026-11-01T01:30-05:00'];let preview;
  if(transport==='json')preview=(await f.preview(timestamps.map(timestamp=>r(timestamp,0)),{timezone,timestampConvention:'end'})).preview;
  else{
   const text='time,energy\n'+timestamps.map(timestamp=>`${timestamp},0`).join('\n');
   preview=await f.shared.retainImport(csvMeta(text,{timezone,validation:{timestampConvention:'end'}}),new Response(text).body,['time','energy']);
  }
  await f.commit(preview);assert.deepEqual([...f.manager.site('site').rows()].map(x=>[x.timestamp,x.value]),[['2026-11-01T04:30:00.000Z',0],['2026-11-01T05:30:00.000Z',0]]);
  const before=canonicalSnapshot(f);
  for(const timestamp of ['2026-11-01 01:30','2026-03-08 02:30']){
   if(transport==='json')await f.send({action:'preview',siteId:'site',timezone,timestampConvention:'start',intervalMinutes:60,readings:[r(timestamp,1)]},400);
   else{const text=`time,energy\n${timestamp},1`;await assert.rejects(f.shared.retainImport(csvMeta(text,{timezone}),new Response(text).body,['time','energy']),/ambiguous|nonexistent/i);}
  }
  assert.equal(canonicalSnapshot(f),before);
 });
}
