import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,webcrypto} from 'node:crypto';
import {loadSource,modelCapacityBindings} from './source-module.mjs';
import {LocalDatabase,LocalBucket} from '../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../selfhost/performance-store.mjs';
import {ManualVcomStore} from '../selfhost/manual-vcom-store.mjs';
import * as realProvider from '../selfhost/vcom-provider.mjs';
import {createSyntheticVcomFetch,fixtureAuth,fixtureMappings,syntheticPayload} from './selfhost/manual-vcom-fixture.preload.mjs';
const globals={Error,TypeError,SyntaxError,Uint8Array,AbortController};
const time=loadSource('app/telemetry-time.ts',[],globals),csv=loadSource('app/telemetry-csv.ts',[],{...globals,...modelCapacityBindings(),...time}),ingest=loadSource('app/performance-ingest.ts',[],{...globals,...time,...csv});
const credentials={mode:'basic',apiKey:'synthetic-only-key',username:'synthetic-only-user',password:'synthetic-only-password'};
const source=(id,kind,deviceId,measurement,unit)=>({id,kind,deviceId,measurement,unit,sourceUnit:unit,aggregation:'SUM',eligible:true,reason:null,name:id});
const discovery={systemKey:'TEST1',systemName:'Synthetic Cedar Creek Solar',timezone:'UTC',discoveredAt:'2026-01-02T00:00:00Z',sources:[source('simulation:expected','simulation',null,'Expected Production','kWh'),source('irradiance:combined','irradiance',null,'Irradiance','W/m2'),source('inverter:101:E_INT','inverter','101','Energy','kWh'),source('inverter:102:E_INT','inverter','102','Energy','kWh'),source('meter:201:M_E_INT_EXP','meter-export','201','Energy','kWh'),source('meter:201:M_E_INT_IMP','meter-import','201','Other','kWh')],poaSensors:[source('poa:301','poa','301','POA irradiance','W/m2')],excludedMeters:[],warnings:[],metadataDigest:'synthetic'};
const mappings=discovery.sources.map((s,i)=>({sourceId:s.id,equipmentId:['@site','weather','inv1','inv2','meter','meter'][i],measurement:s.measurement}));
// Explicit provisional provider injection; real-provider coverage is below once
// the provider-owned fixture is available. Durable controller/storage are real.
function fixtureProvider(calls){return {
 createVcomClient:()=>({get:async descriptor=>{calls.push(descriptor.requestId);return {version:1,requestId:descriptor.requestId,descriptor,payload:{synthetic:1},payloadSha256:'synthetic',decodedBodyByteLength:15};}}),
 discoverVcom:async()=>structuredClone(discovery),
 validateVcomMappings:({mappings:m,selectedPoaSourceId})=>({valid:m?.length===6&&(!selectedPoaSourceId||selectedPoaSourceId==='poa:301'),ready:m?.length===6&&(!selectedPoaSourceId||selectedPoaSourceId==='poa:301'),issues:m?.length===6?[]:['Map every supported source.']}),
 planVcomImport:input=>({...input,version:1,systemKey:'TEST1',timezone:'UTC',startUtc:'2026-01-01T00:00:00.000Z',endUtc:'2026-01-02T00:00:00.000Z',planHash:'synthetic-plan',readingCount:144,requests:[0,1,2].map(i=>({requestId:`r${i}`,kind:'simulation',deviceId:null,abbreviation:null,path:'/systems/TEST1/simulation',query:{},ownedStartUtc:'2026-01-01T00:00:00.000Z',ownedEndUtcExclusive:'2026-01-02T00:00:00.000Z',sourceTimestampConvention:'start',conventionId:'synthetic'})),windows:[{startUtc:'2026-01-01T00:00:00.000Z',endUtc:'2026-01-02T00:00:00.000Z'}]}),
 normalizeVcomWindow:()=>({readings:Array.from({length:24},(_,hour)=>mappings.map((m,i)=>({timestamp:new Date(Date.UTC(2026,0,1,hour)).toISOString(),equipmentId:m.equipmentId,measurement:m.measurement,value:hour===0&&i===0?5:i===1?500:i===5?0:10,unit:discovery.sources[i].unit}))).flat(),quality:[{synthetic:true,partialExpectedKwh:5}],summary:{hours:24,sources:6,missingReadings:0,partialSimulationHours:1,missingSimulationHours:0,satelliteGaps:0,poaFilled:0,remainingIrradianceGaps:0,warnings:['Synthetic partial simulation /12 sum retained.']}})
};}
async function fixture(t,providerOverrides={},serviceOverrides={}){
 const root=mkdtempSync(join(tmpdir(),'manual-vcom-api-'));let db,bucket,manager,store,ticks=0,wakes=0;let now=Date.now();const calls=[];
 const open=()=>{db=new LocalDatabase(join(root,'shared.sqlite'),'drizzle');bucket=new LocalBucket(db,join(root,'objects'));manager=new PerformanceStoreManager(join(root,'performance'));store=new ManualVcomStore({database:db,dataDirectory:root,clock:()=>now});};open();
 t.after(()=>{manager.close();db.close();rmSync(root,{recursive:true,force:true});});
 db.sqlite.exec("INSERT INTO site_settings(id,name,array_model_verified) VALUES('site','Synthetic Cedar Creek Solar',1),('other','Other synthetic site',0); INSERT INTO equipment_assets(id,site_id,type,name,external_id,parent_id,ac_rated_capacity_kw) VALUES('meter','site','revenue_meter','Revenue meter','201',NULL,'200'),('inv1','site','inverter','Inverter 1','101','meter','100'),('inv2','site','inverter','Inverter 2','102','meter','100'),('weather','site','weather_sensor','Weather station','301',NULL,'');");
 const runtime={get store(){return store;},wake(){wakes++;},verifyWorker:token=>token==='synthetic-worker-token'};
 const bindings={...globals,...ingest,...time,...fixtureProvider(calls),...providerOverrides,getDatabaseBinding:()=>db,getBucketBinding:()=>bucket,getPerformanceStoreManager:()=>manager,getManualVcomRuntime:()=>runtime,depotCleanupInProgress:async()=>false,...serviceOverrides};
 const service=loadSource('app/api/performance-data/service.ts',[],bindings),controller=loadSource('app/api/manual-vcom/controller.ts',[],{...bindings,...service}),route=loadSource('app/api/manual-vcom/route.ts',[],{...bindings,...service,...controller}),work=loadSource('app/api/manual-vcom/work/route.ts',[],{...bindings,...service,...controller});
 const send=async(action,status=200)=>{const response=await route.POST(new Request('http://local/api/manual-vcom',{method:'POST',headers:{'content-type':'application/json','oai-authenticated-user-id':'synthetic-operator'},body:JSON.stringify({siteId:'site',...action})}));const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));assert.match(response.headers.get('cache-control'),/no-store/);return body;};
 const get=async(jobId)=>{const response=await route.GET(new Request(`http://local/api/manual-vcom?siteId=site${jobId?`&jobId=${jobId}`:''}`));const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
 const tick=async()=>{ticks++;now+=3000;const response=await work.POST(new Request('http://local/api/manual-vcom/work',{method:'POST',headers:{'x-sol-vcom-worker':'synthetic-worker-token','oai-authenticated-user-id':'synthetic-operator'}}));assert.equal(response.status,200,await response.text());};
 const ready=async()=>{await send({action:'configure',expectedGeneration:0,systemKey:'TEST1',credentials});await send({action:'discover',expectedGeneration:1});return send({action:'mappings',expectedGeneration:2,mappings,selectedPoaSourceId:null});};
 const start=async(id='synthetic-request')=>(await send({action:'start',expectedGeneration:3,requestId:id,fromDate:'2026-01-01',throughDate:'2026-01-01'},202)).job;
 const drain=async(id,maximum=30)=>{for(let i=0;i<maximum;i++){await tick();const job=(await get(id)).job;if(!['queued','downloading','staging'].includes(job.status))return job;}throw Error('Fixture job never completed bounded work.');};
 return {root,get ticks(){return ticks;},get wakes(){return wakes;},get db(){return db;},get manager(){return manager;},get store(){return store;},get bucket(){return bucket;},calls,service,controller,route,work,send,get,tick,ready,start,drain,reopen(){manager.close();db.close();open();}};
}
const exclude = mapping => ({...mapping,equipmentId:'',excluded:true});
const decisions = included => fixtureMappings.map(m=>included.includes(m.sourceId)?m:exclude(m));
async function realExclusionFixture(t,{mutatePayload=()=>{},holdMeasurement=async()=>{}}={}){
 const requests=[],clone=value=>JSON.parse(JSON.stringify(value));let forbidPlanning=false;
 const transport=createSyntheticVcomFetch({fallback:()=>{throw Error('No live VCOM calls permitted.');},onRequest:url=>requests.push(url.href)});
 const fetchImpl=async(input,init)=>{const url=new URL(input),response=await transport(input,init),payload=await response.json();mutatePayload(url,payload);if(url.searchParams.has('from'))await holdMeasurement(url);return new Response(JSON.stringify(payload));};
 const f=await fixture(t,{...realProvider,createVcomClient:opts=>realProvider.createVcomClient({...opts,minSpacingMs:0,fetchImpl}),
  validateVcomMappings:opts=>realProvider.validateVcomMappings(clone(opts)),normalizeVcomWindow:opts=>realProvider.normalizeVcomWindow(clone(opts)),
  planVcomImport:opts=>{assert.equal(forbidPlanning,false,'Reopened workers must use their exact saved plan.');return realProvider.planVcomImport(clone(opts));}});
 await f.send({action:'configure',expectedGeneration:0,systemKey:'TEST1',credentials:fixtureAuth});await f.send({action:'discover',expectedGeneration:1});
 return {f,requests,forbidPlanning(){forbidPlanning=true;}};
}

test('exclusions REAL API saves all-excluded, reopens and refreshes decisions, and refuses start without a fetch or job',async t=>{
 const {f,requests}=await realExclusionFixture(t),excluded=fixtureMappings.map(exclude);
 const saved=await f.send({action:'mappings',expectedGeneration:2,mappings:excluded,selectedPoaSourceId:null});
 assert.equal(saved.settings.ready,false);assert.deepEqual(saved.settings.mappings,excluded);assert.equal(saved.settings.generation,3);
 assert.match(saved.settings.issues.join(' '),/include at least one|at least one.*included/i);
 f.reopen();assert.deepEqual((await f.get()).settings.mappings,excluded);
 const refreshed=await f.send({action:'discover',expectedGeneration:3});assert.deepEqual(refreshed.settings.mappings,excluded);assert.equal(refreshed.settings.ready,false);
 const before=[...requests],wakes=f.wakes;
 const blocked=await f.send({action:'start',expectedGeneration:4,requestId:'excluded-all',fromDate:'2026-01-01',throughDate:'2026-01-01'},400);
 assert.match(blocked.error,/include at least one|at least one.*included/i);assert.equal(f.store.jobs('site').length,0);assert.deepEqual(requests,before);assert.equal(f.wakes,wakes);
 assert.equal(f.manager.site('site').describe().readingCount,0);
});

test('exclusions REAL API mixed import fetches, stages and commits included channels only across reopen',async t=>{
 const {f,requests,forbidPlanning}=await realExclusionFixture(t,{mutatePayload:(url,payload)=>{if(url.pathname.endsWith('/inverters/bulk/measurements'))for(const row of Object.values(payload))row['102']={E_INT:'ignored-invalid',P_AC:null};}});
 const mappings=decisions(['inverter:101:E_INT','meter:201:M_E_INT_IMP']);
 assert.equal((await f.send({action:'mappings',expectedGeneration:2,mappings,selectedPoaSourceId:null})).settings.ready,true);
 f.reopen();assert.deepEqual((await f.get()).settings.mappings,mappings);
 const job=await f.start('excluded-mixed'),pinned=f.store.job('site',job.id).plan,before=requests.length;forbidPlanning();
 assert.equal(pinned.readingCount,48);assert.deepEqual(pinned.requests.map(r=>[r.kind,r.abbreviation]),[['inverterBulk','E_INT'],['meter','M_E_INT_IMP']]);
 assert.equal(pinned.discovery.sources.length,6);await f.tick();f.reopen();assert.deepEqual(f.store.job('site',job.id).plan,pinned);
 const staged=await f.drain(job.id);assert.equal(staged.status,'awaiting_approval',JSON.stringify(staged));assert.equal(staged.preview.readingCount,48);assert.equal(requests.length,before+2);
 assert.equal(staged.quality.sources,2);assert.equal(staged.quality.missingReadings,0);assert.equal(staged.quality.missingSimulationHours,0);assert.equal(staged.quality.remainingIrradianceGaps,0);
 const manifest=await(await f.bucket.get(staged.preview.metadata.originalObjectKey)).json();assert.deepEqual(manifest.plan,pinned);
 for(const reference of manifest.windows){const window=await(await f.bucket.get(reference.key)).json();assert.ok(window.quality.every(q=>['inverter:101:E_INT','meter:201:M_E_INT_IMP'].includes(q.sourceId)));assert.equal(window.readings.length,48);}
 await f.send({action:'apply',jobId:job.id,stageId:staged.stageId,previewToken:staged.preview.previewToken,approveOverlap:false});f.reopen();
 const rows=[...f.manager.site('site').rows()];assert.equal(rows.length,48);assert.deepEqual([...new Set(rows.map(r=>[r.channel.equipmentId,r.channel.measurement].join(':')))].sort(),['inv1:Energy','meter:Other']);
 assert.ok(rows.every(r=>r.value===(r.channel.equipmentId==='inv1'?2:-1)));assert.equal((await f.get(job.id)).job.status,'committed');
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n,0);
});

test('exclusions REAL API rejects malformed and contradictory decisions before changing saved settings',async t=>{
 const {f}=await realExclusionFixture(t);await f.send({action:'mappings',expectedGeneration:2,mappings:fixtureMappings,selectedPoaSourceId:null});
 const before=f.store.settings('site'),bad=[
  ...[null,0,1,'true','false',{},[]].map(excluded=>({...fixtureMappings[0],excluded})),
  {...fixtureMappings[0],excluded:true}, {...exclude(fixtureMappings[0]),measurement:'Energy'},
 ];
 for(const mapping of bad)await f.send({action:'mappings',expectedGeneration:3,mappings:[mapping,...fixtureMappings.slice(1)],selectedPoaSourceId:null},400);
 const noIrradiance=fixtureMappings.map(m=>m.sourceId==='irradiance:combined'?exclude(m):m);
 for(const selectedPoaSourceId of ['poa:301','poa:missing','']){
  const response=await f.send({action:'mappings',expectedGeneration:3,mappings:noIrradiance,selectedPoaSourceId},400);assert.match(response.error,/POA.*excluded|excluded.*POA/i);
 }
 for(const mappings of [fixtureMappings.slice(1),[...fixtureMappings,exclude(fixtureMappings[0])],[...fixtureMappings,{sourceId:'unknown',equipmentId:'',measurement:'Energy',excluded:true}]])await f.send({action:'mappings',expectedGeneration:3,mappings,selectedPoaSourceId:null},400);
 assert.deepEqual(f.store.settings('site'),before);assert.equal(f.store.jobs('site').length,0);
});

test('exclusions REAL API permits unsupported excluded devices and refresh never silently removes the decision',async t=>{
 const {f}=await realExclusionFixture(t,{mutatePayload:(url,payload)=>{if(url.pathname.endsWith('/inverters/102/abbreviations'))payload.data=[];}});
 const mappings=fixtureMappings.map(m=>m.sourceId==='inverter:102:E_INT'?exclude(m):m);
 assert.equal((await f.send({action:'mappings',expectedGeneration:2,mappings,selectedPoaSourceId:null})).settings.ready,true);
 f.reopen();const refreshed=await f.send({action:'discover',expectedGeneration:3});assert.equal(refreshed.settings.ready,true);assert.deepEqual(refreshed.settings.mappings,mappings);
 assert.equal(refreshed.settings.discovery.sources.find(s=>s.deviceId==='102').eligible,false);
 const job=(await f.send({action:'start',expectedGeneration:4,requestId:'unsupported-excluded',fromDate:'2026-01-01',throughDate:'2026-01-01'},202)).job;
 const staged=await f.drain(job.id);assert.equal(staged.status,'awaiting_approval');assert.equal(staged.preview.readingCount,120);
});

test('exclusions REAL API invalidates an actual pending preview but preserves canonical history, receipts and saved analysis',async t=>{
 const {f}=await realExclusionFixture(t);await f.send({action:'mappings',expectedGeneration:2,mappings:fixtureMappings,selectedPoaSourceId:null});
 const committed=await f.start('before-exclusions'),preview=await f.drain(committed.id);
 await f.send({action:'apply',jobId:committed.id,stageId:preview.stageId,previewToken:preview.preview.previewToken,approveOverlap:false});
 f.db.sqlite.exec("INSERT INTO analysis_runs(id,site_id,import_id,parser_version,model_revision,analysis_object_key) VALUES('saved-exclusions','site','canonical',28,'old','analysis/exclusions'); INSERT INTO issue_event_reviews(id,site_id,event_key,version,state,updated_at) VALUES('review-exclusions','site','event',1,'{}','now');");await f.bucket.put('analysis/exclusions','retained analysis bytes');
 const history=()=>JSON.stringify({dataset:f.manager.site('site').describe(),rows:[...f.manager.site('site').rows()],imports:f.manager.site('site').imports(),receipt:f.manager.site('site').preview(preview.stageId),analysis:f.db.sqlite.prepare('SELECT * FROM analysis_runs').all(),reviews:f.db.sqlite.prepare('SELECT * FROM issue_event_reviews').all()});
 const before=history(),next=await f.start('preview-before-exclusions'),pending=await f.drain(next.id);
 assert.equal(pending.status,'awaiting_approval');assert.equal(pending.preview.counts.overlapping,144);
 await f.send({action:'mappings',expectedGeneration:3,mappings:fixtureMappings.map(exclude),selectedPoaSourceId:null});
 assert.equal(f.store.job('site',next.id).errorCode,'stale-configuration');assert.equal(f.manager.site('site').preview(pending.stageId).status,'canceled');
 await f.send({action:'apply',jobId:next.id,stageId:pending.stageId,previewToken:pending.preview.previewToken,approveOverlap:true},409);
 f.reopen();assert.equal(history(),before);assert.equal((await f.get(committed.id)).job.status,'committed');assert.equal(await(await f.bucket.get('analysis/exclusions')).text(),'retained analysis bytes');
 assert.equal(f.manager.site('site').describe().readingCount,144);
});

test('exclusions REAL API fences an observable in-flight old-plan fetch before chunk publication',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();t.after(()=>release.resolve());
 const {f}=await realExclusionFixture(t,{holdMeasurement:async()=>{entered.resolve();await release.promise;}});
 await f.send({action:'mappings',expectedGeneration:2,mappings:fixtureMappings,selectedPoaSourceId:null});const job=await f.start('inflight-exclusions'),pending=f.tick();await entered.promise;
 assert.ok(f.store.job('site',job.id).leaseToken);
 try{
  await f.send({action:'mappings',expectedGeneration:3,mappings:fixtureMappings.map(exclude),selectedPoaSourceId:null});
 }finally{release.resolve();await pending;}
 f.reopen();
 assert.equal(f.store.job('site',job.id).errorCode,'stale-configuration');assert.equal(f.store.job('site',job.id).completedRequests,0);
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM vcom_manual_chunks').get().n,0);assert.equal(f.manager.site('site').describe().revision,0);
});

test('ordinary synthetic full bundle config -> saved discovery -> fetch -> preview -> apply -> reopen; GET never advances work',async t=>{
 const f=await fixture(t);assert.equal((await f.get()).settings.generation,0);assert.equal((await f.ready()).settings.ready,true);assert.equal(f.calls.length,0);
 const job=await f.start();for(let i=0;i<3;i++)assert.equal((await f.get(job.id)).job.completedRequests,0);assert.equal(f.calls.length,0);
 await f.tick();assert.equal(f.calls.length,1);f.reopen();const preview=await f.drain(job.id);assert.equal(preview.status,'awaiting_approval');assert.deepEqual(f.calls,['r0','r1','r2']);
 assert.equal(f.manager.site('site').describe().revision,0);assert.equal(preview.quality.partialSimulationHours,1);
 const manifest=await (await f.bucket.get(preview.preview.metadata.originalObjectKey)).json();assert.equal(manifest.plan.planHash,'synthetic-plan');assert.equal(manifest.chunks.length,3);
 const applied=await f.send({action:'apply',jobId:job.id,stageId:preview.stageId,previewToken:preview.preview.previewToken,approveOverlap:false});assert.equal(applied.job.status,'committed');
 f.reopen();const readback=(await f.get(job.id)).job;assert.equal(readback.result.stageId,preview.stageId);assert.equal(f.manager.site('site').describe().readingCount,144);
 const rows=[...f.manager.site('site').rows()];assert.equal(rows.find(r=>r.channel.equipmentId==='@site'&&r.timestamp.startsWith('2026-01-01T00')).value,5);
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM analysis_runs').get().n,0);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n,0);
 const text=JSON.stringify(await f.get(job.id));for(const secret of Object.values(credentials).slice(1))assert.ok(!text.includes(secret));for(const field of ['leaseToken','planHash','ciphertext','rawBytes'])assert.ok(!text.includes(`"${field}"`));
});
test('exact request idempotency, generic commit bypass, stale configuration and cancel fencing',async t=>{
 const f=await fixture(t);await f.ready();const job=await f.start();assert.equal((await f.start()).id,job.id);
 await f.send({action:'start',expectedGeneration:3,requestId:'synthetic-request',fromDate:'2026-01-02',throughDate:'2026-01-02'},409);
 const ready=await f.drain(job.id);await assert.rejects(f.service.commitPerformancePreview({siteId:'site',stageId:ready.stageId,previewToken:ready.preview.previewToken,approveOverlap:true},'generic'),/workspace|manual/i);
 await f.send({action:'configure',expectedGeneration:3,systemKey:'TEST1'});
 await f.send({action:'apply',jobId:job.id,stageId:ready.stageId,previewToken:ready.preview.previewToken,approveOverlap:true},409);
 assert.equal(f.manager.site('site').describe().revision,0);
 const next=(await f.send({action:'start',expectedGeneration:4,requestId:'next',fromDate:'2026-01-01',throughDate:'2026-01-01'},202)).job;
 await f.send({action:'cancel',jobId:next.id});await f.tick();assert.equal((await f.get(next.id)).job.status,'canceled');assert.equal(f.manager.site('site').describe().revision,0);
});
for(const selectedPoaSourceId of [null,'poa:301'])test(`REAL provider + migrated stores complete synthetic TEST1 bundle (${selectedPoaSourceId||'explicit no POA'}) with reopened raw and canonical data`,async t=>{
 const requests=[],clone=x=>JSON.parse(JSON.stringify(x));let forbidPlanning=false;
 const fetchImpl=createSyntheticVcomFetch({fallback:()=>{throw Error('Unexpected external request in offline test.');},onRequest:url=>requests.push(url.href)});
 const actual={...realProvider,createVcomClient:opts=>realProvider.createVcomClient({...opts,minSpacingMs:0,fetchImpl}),
  validateVcomMappings:opts=>realProvider.validateVcomMappings(clone(opts)),normalizeVcomWindow:opts=>realProvider.normalizeVcomWindow(clone(opts)),
  planVcomImport:opts=>{assert.equal(forbidPlanning,false,'Restart must not replan');return realProvider.planVcomImport(clone(opts));}};
 const f=await fixture(t,actual);
 await f.send({action:'configure',expectedGeneration:0,systemKey:'TEST1',credentials:fixtureAuth});
 const discovered=await f.send({action:'discover',expectedGeneration:1});assert.equal(discovered.settings.discovery.sources.length,6);assert.equal(discovered.settings.discovery.poaSensors.length,1);
 const ready=await f.send({action:'mappings',expectedGeneration:2,mappings:fixtureMappings,selectedPoaSourceId});assert.equal(ready.settings.ready,true);
 const job=await f.start();forbidPlanning=true;const before=requests.length;await f.tick();assert.equal(requests.length,before+1);f.reopen();
 const total=selectedPoaSourceId?6:5;
 const staged=await f.drain(job.id);assert.equal(staged.status,'awaiting_approval',JSON.stringify(staged));assert.equal(staged.completedRequests,total);assert.equal(requests.length,before+total);
 const downloaded=requests.slice(before);assert.equal(new Set(downloaded).size,total);assert.equal(staged.quality.partialSimulationHours,1);assert.equal(staged.quality.poaFilled,selectedPoaSourceId?1:0);
 await f.send({action:'apply',jobId:job.id,stageId:staged.stageId,previewToken:staged.preview.previewToken,approveOverlap:false});f.reopen();
 const rows=[...f.manager.site('site').rows()];assert.equal(rows.length,144);const at=(equipmentId,measurement,hour)=>rows.find(r=>r.channel.equipmentId===equipmentId&&r.channel.measurement===measurement&&r.timestamp===`2026-01-01T${hour}:00:00.000Z`).value;
 assert.equal(at('@site','Expected Production','00'),11);assert.equal(at('inv1','Energy','00'),2);assert.equal(at('inv2','Energy','00'),3);assert.equal(at('meter','Other','00'),-1);assert.equal(at('weather','Irradiance','00'),0);assert.equal(at('weather','Irradiance','01'),selectedPoaSourceId?600:null);
 assert.equal((await f.get(job.id)).job.result.stageId,staged.stageId);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n,0);
});
test('REAL provider worker stages more than the public 100k HTTP cap in bounded batches and commits/reopens every synthetic reading', {timeout:120000},async t=>{
 const clone=x=>JSON.parse(JSON.stringify(x)),requests=[];const extra=Array.from({length:68},(_,i)=>({id:String(103+i),name:`Inverter ${3+i}`}));
 const fetchImpl=async(url,init)=>{
  const u=new URL(url);assert.equal(u.origin,'https://api.meteocontrol.de');assert.equal(new Headers(init.headers).get('x-api-key'),fixtureAuth.apiKey);requests.push(u.href);let payload;
  const match=/\/inverters\/(\d+)\/abbreviations(?:\/E_INT)?$/.exec(u.pathname);
  if(match&&Number(match[1])>=103)payload=u.pathname.endsWith('/E_INT')?{data:{unit:'kWh',aggregation:'SUM',precision:3,description:'Synthetic scale fixture'}}:{data:['E_INT']};
  else{payload=syntheticPayload(u);if(u.pathname.endsWith('/inverters'))payload.data.push(...extra);if(u.pathname.endsWith('/inverters/bulk/measurements'))for(const row of Object.values(payload))for(const device of extra)row[device.id]={E_INT:3};}
  return new Response(JSON.stringify(payload));
 };
 const actual={...realProvider,createVcomClient:opts=>realProvider.createVcomClient({...opts,minSpacingMs:0,fetchImpl}),validateVcomMappings:opts=>realProvider.validateVcomMappings(clone(opts)),normalizeVcomWindow:opts=>realProvider.normalizeVcomWindow(clone(opts)),planVcomImport:opts=>realProvider.planVcomImport(clone(opts))};
 const f=await fixture(t,actual);for(let i=3;i<=70;i++)f.db.sqlite.prepare('INSERT INTO equipment_assets(id,site_id,type,name,external_id,parent_id,ac_rated_capacity_kw,max_dc_capacity_kw) VALUES(?,?,?,?,?,?,?,?)').run(`inv${i}`,'site','inverter',`Inverter ${i}`,String(100+i),'meter','100','150');
 f.db.sqlite.exec("UPDATE equipment_assets SET ac_rated_capacity_kw='7000' WHERE id='meter'");
 for(let i=1;i<=70;i++)f.db.sqlite.prepare('INSERT INTO equipment_assets(id,site_id,type,name,external_id,parent_id,module_rated_capacity_w,quantity) VALUES(?,?,?,?,?,?,?,?)').run(`modules${i}`,'site','module_group',`Modules ${i}`,`MOD${i}`,`inv${i}`,'400',300);
 await f.send({action:'configure',expectedGeneration:0,systemKey:'TEST1',credentials:fixtureAuth});await f.send({action:'discover',expectedGeneration:1});
 await f.send({action:'mappings',expectedGeneration:2,mappings:[...fixtureMappings,...extra.map((device,i)=>({sourceId:`inverter:${device.id}:E_INT`,equipmentId:`inv${i+3}`,measurement:'Energy'}))],selectedPoaSourceId:null});
 const job=(await f.send({action:'start',expectedGeneration:3,requestId:'synthetic-over-http-cap',fromDate:'2026-01-01',throughDate:'2026-03-01'},202)).job;
 const planned=f.store.job('site',job.id).plan;assert.ok(planned.readingCount>100000);assert.equal(ingest.INGEST_LIMITS.jsonReadings,100000);
 const site=f.manager.site('site'),stage=site.stage.bind(site);let stageCalls=0,seen=0;
 site.stage=(metadata,readings,options)=>{stageCalls++;async function* counted(){for await(const reading of readings){seen++;yield reading;}}return stage(metadata,counted(),options);};
 const ready=await f.drain(job.id,600);assert.equal(ready.status,'awaiting_approval',JSON.stringify(ready));assert.equal(stageCalls,1);assert.equal(seen,planned.readingCount);assert.equal(ready.preview.readingCount,planned.readingCount);
 await f.send({action:'apply',jobId:job.id,stageId:ready.stageId,previewToken:ready.preview.previewToken,approveOverlap:false});f.reopen();
 assert.equal(f.manager.site('site').describe().readingCount,planned.readingCount);let retained=0,numeric=0,missing=0;for(const row of f.manager.site('site').rows()){retained++;assert.ok(row.value===null||typeof row.value==='number');if(row.value===null)missing++;else numeric++;}assert.equal(retained,planned.readingCount);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n,0);
 const persisted=f.store.job('site',job.id);t.diagnostic(JSON.stringify({synthetic:true,retained,numeric,missing,workerTurns:f.ticks,downloadRequests:requests.filter(url=>new URL(url).searchParams.has('from')).length,windows:persisted.state.windowObjects.length,rawBytes:persisted.rawBytes,normalizedSourceAndQualityBytes:persisted.state.normalizedBytes,stageCalls}));
});
test('discovery CAS refuses to overwrite newer configuration while its real await is in flight',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();t.after(()=>release.resolve());
 const f=await fixture(t,{discoverVcom:async()=>{entered.resolve();await release.promise;return structuredClone(discovery);}});
 await f.send({action:'configure',expectedGeneration:0,systemKey:'TEST1',credentials});
 const pending=f.send({action:'discover',expectedGeneration:1},409);await entered.promise;
 await f.send({action:'configure',expectedGeneration:1,systemKey:'TEST2'});release.resolve();await pending;
 const saved=(await f.get()).settings;assert.equal(saved.generation,2);assert.equal(saved.systemKey,'TEST2');assert.equal(saved.discovery,null);assert.deepEqual(saved.mappings,[]);assert.equal(f.calls.length,0);
});
for(const change of ['cancel','configuration','model'])test(`an observable in-flight download is fenced by ${change}`,async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();t.after(()=>release.resolve());
 const f=await fixture(t,{createVcomClient:()=>({get:async descriptor=>{entered.resolve();await release.promise;return {version:1,requestId:descriptor.requestId,descriptor,payload:{synthetic:1},payloadSha256:'synthetic',decodedBodyByteLength:15};}})});
 await f.ready();const job=await f.start(),pending=f.tick();await entered.promise;
 assert.ok(f.store.job('site',job.id).leaseToken,'The lease must be in flight before racing it');
 if(change==='cancel')await f.send({action:'cancel',jobId:job.id});else if(change==='configuration')await f.send({action:'configure',expectedGeneration:3,systemKey:'TEST1'});else f.db.sqlite.exec("UPDATE equipment_assets SET name='Changed during request' WHERE id='inv1'");
 release.resolve();await pending;const current=(await f.get(job.id)).job;assert.equal(current.status,change==='cancel'?'canceled':'failed');assert.equal(current.completedRequests,0);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM vcom_manual_chunks').get().n,0);assert.equal(f.manager.site('site').describe().revision,0);
});
test('an interrupted private work request remains authorized and resumes the same saved plan after reopen',async t=>{
 const entered=Promise.withResolvers();let first=true;
 const f=await fixture(t,{createVcomClient:()=>({get:async(descriptor,{signal}={})=>{if(first){first=false;entered.resolve();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}return {version:1,requestId:descriptor.requestId,descriptor,payload:{synthetic:1},payloadSha256:'synthetic',decodedBodyByteLength:15};}})});
 await f.ready();const job=await f.start(),abort=new AbortController(),pending=f.controller.workManualVcom(abort.signal);await entered.promise;assert.ok(f.store.job('site',job.id).leaseToken);abort.abort();await pending;
 const delayed=f.store.job('site',job.id);assert.equal(delayed.status,'queued');assert.equal(delayed.errorCode,'worker-interrupted');assert.equal(delayed.completedRequests,0);assert.ok(delayed.nextAttemptAt);f.reopen();assert.equal((await f.drain(job.id)).status,'awaiting_approval');
});
test('final shared configuration guard rejects a generation edit after the approval digest and stays locked THROUGH canonical commit',async t=>{
 const pause=Promise.withResolvers(),release=Promise.withResolvers();let enabled=false,digests=0;const f=await fixture(t,{}, {crypto:{randomUUID:()=>webcrypto.randomUUID(),subtle:{digest:async(...args)=>{const result=await webcrypto.subtle.digest(...args);if(enabled&&++digests===3){pause.resolve();await release.promise;}return result;}}}});
 t.after(()=>release.resolve());await f.ready();const job=await f.start(),ready=await f.drain(job.id);enabled=true;
 const pending=f.send({action:'apply',jobId:job.id,stageId:ready.stageId,previewToken:ready.preview.previewToken,approveOverlap:false},409);
 await pause.promise;await f.send({action:'configure',expectedGeneration:3,systemKey:'TEST1'});release.resolve();await pending;
 assert.equal(f.manager.site('site').describe().revision,0);
 const newer=(await f.send({action:'start',expectedGeneration:4,requestId:'guard-new',fromDate:'2026-01-01',throughDate:'2026-01-01'},202)).job,staged=await f.drain(newer.id);
 const site=f.manager.site('site'),commit=site.commit.bind(site);let checked=false;const independent=new DatabaseSync(join(f.root,'shared.sqlite'));independent.exec('PRAGMA busy_timeout=0');t.after(()=>independent.close());
 site.commit=(id,options)=>{checked=true;assert.throws(()=>f.db.sqlite.exec("UPDATE vcom_site_settings SET generation=generation+1 WHERE site_id='site'"),/readonly|read-only/i);assert.throws(()=>independent.exec("UPDATE vcom_site_settings SET generation=generation+1 WHERE site_id='site'"),/locked/i);return commit(id,options);};
 await f.send({action:'apply',jobId:newer.id,stageId:staged.stageId,previewToken:staged.preview.previewToken,approveOverlap:false});assert.equal(checked,true);assert.equal(site.describe().revision,1);
});
test('lost Apply reconciliation reads the exact authoritative receipt, no automatic replay, then survives later configuration and maintenance',async t=>{
 let maintenance=false;const f=await fixture(t,{}, {depotCleanupInProgress:async()=>maintenance});await f.ready();const job=await f.start(),ready=await f.drain(job.id);
 const reconcile=f.store.reconcile.bind(f.store);f.store.reconcile=()=>{throw Error('Synthetic lost shared acknowledgement');};
 await f.send({action:'apply',jobId:job.id,stageId:ready.stageId,previewToken:ready.preview.previewToken,approveOverlap:false},500);
 assert.equal(f.store.job('site',job.id).status,'awaiting_approval');const readback=(await f.get(job.id)).job;assert.equal(readback.status,'committed');assert.equal(readback.result.stageId,ready.stageId);assert.equal(f.manager.site('site').describe().revision,1);assert.equal(f.store.job('site',job.id).status,'awaiting_approval','GET must not reconcile shared state');
 f.store.reconcile=reconcile;await f.send({action:'configure',expectedGeneration:3,systemKey:'TEST1'});maintenance=true;
 const replay=await f.send({action:'apply',jobId:job.id,stageId:ready.stageId,previewToken:ready.preview.previewToken,approveOverlap:true});assert.equal(replay.job.result.stageId,ready.stageId);assert.equal(f.manager.site('site').describe().revision,1);assert.equal(f.manager.site('site').imports().length,1);
});
async function lostReceipt(f){
 await f.ready();const job=await f.start(),ready=await f.drain(job.id);
 f.db.sqlite.exec("CREATE TRIGGER injected_receipt_failure BEFORE UPDATE OF status ON vcom_manual_jobs WHEN NEW.status='committed' BEGIN SELECT RAISE(ABORT,'synthetic shared receipt write failure'); END");
 try{await f.send({action:'apply',jobId:job.id,stageId:ready.stageId,previewToken:ready.preview.previewToken,approveOverlap:false},500);}
 finally{f.db.sqlite.exec('DROP TRIGGER injected_receipt_failure');}
 assert.equal(f.store.job('site',job.id).status,'awaiting_approval');
 const receipt=f.manager.site('site').preview(ready.stageId);assert.equal(receipt.status,'committed');assert.equal(receipt.result.revision,1);
 return {job,receipt};
}
const nextReceiptStart={action:'start',expectedGeneration:3,requestId:'receipt-next',fromDate:'2026-01-02',throughDate:'2026-01-02'};
test('receipt recovery admits the next explicit download after lost shared acknowledgement and reopen, without replaying Apply',async t=>{
 const f=await fixture(t),{job,receipt}=await lostReceipt(f),calls=[...f.calls],wakes=f.wakes;
 const shared=()=>JSON.stringify(f.db.sqlite.prepare('SELECT * FROM vcom_manual_jobs WHERE id=?').get(job.id)),before=shared();
 assert.deepEqual((await f.get(job.id)).job.result,receipt.result);assert.equal(shared(),before,'GET must be read-only for shared state');
 f.reopen();assert.equal(shared(),before);assert.deepEqual((await f.get(job.id)).job.result,receipt.result);assert.equal(shared(),before);
 const site=f.manager.site('site'),canonical=JSON.stringify({dataset:site.describe(),imports:site.imports(),rows:[...site.rows()],receipt:site.preview(receipt.stageId)});
 site.commit=()=>assert.fail('Recovery must never replay canonical Apply');
 const next=(await f.send(nextReceiptStart,202)).job;
 assert.notEqual(next.id,job.id);assert.equal(next.status,'queued');assert.equal(f.store.job('site',next.id).plan.datasetRevision,1);
 assert.deepEqual(f.store.job('site',job.id).preview,receipt);assert.deepEqual(f.store.job('site',job.id).result,receipt.result);assert.equal(f.store.job('site',job.id).status,'committed');
 assert.equal(JSON.stringify({dataset:site.describe(),imports:site.imports(),rows:[...site.rows()],receipt:site.preview(receipt.stageId)}),canonical);
 assert.equal((await f.send(nextReceiptStart,202)).job.id,next.id);assert.equal((await f.start()).id,job.id);
 assert.equal((await f.send({...nextReceiptStart,fromDate:'2026-01-03'},409)).code,'request-id-conflict');
 assert.equal((await f.send({...nextReceiptStart,requestId:'another'},409)).code,'job-active');
 assert.deepEqual(f.calls,calls);assert.equal(f.wakes,wakes+1,'Only the new explicit job wakes the driver');
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM vcom_manual_jobs').get().n,2);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n,0);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM analysis_runs').get().n,0);
});
test('receipt recovery fails closed while the shared reconciliation write is still unavailable',async t=>{
 const f=await fixture(t),{job,receipt}=await lostReceipt(f),before=f.store.job('site',job.id),wakes=f.wakes,calls=[...f.calls];
 f.db.sqlite.exec("CREATE TRIGGER injected_receipt_failure BEFORE UPDATE OF status ON vcom_manual_jobs WHEN NEW.status='committed' BEGIN SELECT RAISE(ABORT,'synthetic shared receipt write failure'); END");
 await f.send(nextReceiptStart,500);assert.deepEqual(f.store.job('site',job.id),before);assert.equal(f.store.byRequest('site',nextReceiptStart.requestId),null);
 assert.deepEqual(f.manager.site('site').preview(receipt.stageId),receipt);assert.deepEqual(f.calls,calls);assert.equal(f.wakes,wakes);
 f.db.sqlite.exec('DROP TRIGGER injected_receipt_failure');await f.send(nextReceiptStart,202);
});
for(const unavailable of ['STAGE_NOT_FOUND','STAGE_EXPIRED'])test(`receipt recovery never admits from a cached receipt when authoritative lookup reports ${unavailable}`,async t=>{
 const f=await fixture(t),{job,receipt}=await lostReceipt(f),site=f.manager.site('site'),read=site.preview.bind(site),wakes=f.wakes;
 // A cached public receipt is deliberately present; only the site-store lookup
 // can authorize a mutation. The boundary error must not fall back to that cache.
 f.db.sqlite.prepare('UPDATE vcom_manual_jobs SET preview=? WHERE id=?').run(JSON.stringify(receipt),job.id);
 site.preview=id=>{if(id===receipt.stageId)throw Object.assign(Error('Synthetic unavailable stage'),{code:unavailable});return read(id);};
 const before=f.store.job('site',job.id);assert.equal((await f.send(nextReceiptStart,409)).code,'job-active');
 assert.deepEqual(f.store.job('site',job.id),before);assert.equal(f.store.byRequest('site',nextReceiptStart.requestId),null);assert.equal(f.wakes,wakes);assert.equal(site.describe().revision,1);
});
test('receipt recovery keeps genuinely uncommitted and expired previews blocking admission',async t=>{
 const f=await fixture(t);await f.ready();const job=await f.start();
 assert.equal((await f.send(nextReceiptStart,409)).code,'job-active');const ready=await f.drain(job.id);
 assert.equal((await f.send(nextReceiptStart,409)).code,'job-active');
 const db=new DatabaseSync(join(f.root,'performance',createHash('sha256').update('site').digest('hex')+'.sqlite'));
 try{db.prepare('UPDATE stages SET expires_at=? WHERE stage_id=?').run('2000-01-01T00:00:00.000Z',ready.stageId);}finally{db.close();}
 assert.equal((await f.send(nextReceiptStart,409)).code,'job-active');assert.equal(f.store.job('site',job.id).status,'awaiting_approval');assert.equal(f.manager.site('site').describe().revision,0);
});
for(const mismatch of ['source','sourceImportId','siteId','stageId','result.siteId','result.stageId'])test(`receipt recovery refuses an authoritative ${mismatch} mismatch without releasing the job`,async t=>{
 const f=await fixture(t),{job,receipt}=await lostReceipt(f),site=f.manager.site('site'),read=site.preview.bind(site),invalid=structuredClone(receipt),before=f.store.job('site',job.id);
 if(mismatch==='source')invalid.metadata.source='csv';else if(mismatch==='sourceImportId')invalid.metadata.sourceImportId='vcom:another-job';else if(mismatch.startsWith('result.'))invalid.result[mismatch.slice(7)]='another';else invalid[mismatch]='another';
 site.preview=id=>id===receipt.stageId?invalid:read(id);
 assert.equal((await f.send(nextReceiptStart,409)).code,'receipt-mismatch');assert.deepEqual(f.store.job('site',job.id),before);assert.equal(f.store.byRequest('site',nextReceiptStart.requestId),null);assert.equal(f.wakes,1);assert.equal(site.describe().revision,1);
});
test('receipt recovery preserves generation and site isolation before admission',async t=>{
 const f=await fixture(t),{job}=await lostReceipt(f),before=f.store.job('site',job.id);
 assert.equal((await f.send({...nextReceiptStart,expectedGeneration:2},409)).code,'stale-generation');
 // Same request ID is site-scoped; the other site has not authorized settings.
 await f.send({...nextReceiptStart,siteId:'other',expectedGeneration:0},400);
 assert.deepEqual(f.store.job('site',job.id),before);assert.equal(f.store.byRequest('other',nextReceiptStart.requestId),null);assert.equal(f.wakes,1);
});
for(const changed of ['model','dataset'])test(`receipt recovery does not bypass the current ${changed} planning fence`,async t=>{
 let onPlan=()=>{};const provider=fixtureProvider([]),f=await fixture(t,{planVcomImport:input=>{const plan=provider.planVcomImport(input);onPlan();return plan;}}),{job,receipt}=await lostReceipt(f),before=f.store.job('site',job.id);
 if(changed==='model')onPlan=()=>f.db.sqlite.exec("UPDATE equipment_assets SET name='Changed during next planning' WHERE id='inv1'");
 else{
  const site=f.manager.site('site'),preview=await site.stage({...receipt.metadata,source:'csv',sourceImportId:'synthetic-competing-csv'},[[...site.rows()][0]]);
  onPlan=()=>site.commit(preview.stageId,{previewToken:preview.previewToken,approveOverlap:true,modelRevision:preview.metadata.modelRevision,actor:'synthetic'});
 }
 assert.equal((await f.send(nextReceiptStart,409)).code,'stale-preview');assert.deepEqual(f.store.job('site',job.id),before);assert.equal(f.store.byRequest('site',nextReceiptStart.requestId),null);assert.equal(f.wakes,1);
});
test('an explicit expired-preview retry reuses saved plan/chunks without new downloads',async t=>{
 const f=await fixture(t);await f.ready();const job=await f.start(),ready=await f.drain(job.id),calls=f.calls.length;
 const path=join(f.root,'performance',createHash('sha256').update('site').digest('hex')+'.sqlite'),db=new DatabaseSync(path);
 db.prepare('UPDATE stages SET expires_at=? WHERE stage_id=?').run('2000-01-01T00:00:00.000Z',ready.stageId);db.close();
 await f.send({action:'retry',jobId:job.id});f.reopen();const replacement=await f.drain(job.id);assert.equal(replacement.status,'awaiting_approval');assert.notEqual(replacement.stageId,ready.stageId);assert.equal(f.calls.length,calls);
 await f.send({action:'apply',jobId:job.id,stageId:replacement.stageId,previewToken:replacement.preview.previewToken,approveOverlap:false});assert.equal(f.manager.site('site').describe().revision,1);
});
test('public mutation and private worker require server identity; invalid secrets and malformed JSON stay safe',async t=>{
 const f=await fixture(t),post=body=>f.route.POST(new Request('http://local/api/manual-vcom',{method:'POST',headers:{'Content-Type':'application/json'},body}));assert.equal((await post('{}')).status,401);
 assert.equal((await f.work.POST(new Request('http://local/api/manual-vcom/work',{method:'POST',headers:{'oai-authenticated-user-id':'synthetic','x-sol-vcom-worker':'forged'}}))).status,403);
 await f.send({action:'configure',expectedGeneration:0,systemKey:'TEST1',credentials:{...credentials,password:''}},400);assert.equal((await f.get()).settings.generation,0);
});
test('VCOM and CSV share canonical channels, explicit overlap, omissions/null preservation and immutable saved analysis',async t=>{
 const f=await fixture(t);await f.ready();const job=await f.start(),ready=await f.drain(job.id);
 await f.send({action:'apply',jobId:job.id,stageId:ready.stageId,previewToken:ready.preview.previewToken,approveOverlap:false});
 f.db.sqlite.exec("INSERT INTO analysis_runs(id,site_id,import_id,parser_version,model_revision,analysis_object_key) VALUES('saved','site','canonical',28,'old','analysis/synthetic'); INSERT INTO issue_event_reviews(id,site_id,event_key,version,state,updated_at) VALUES('saved-review','site','event',1,'{}','now');");await f.bucket.put('analysis/synthetic','unchanged synthetic saved result');
 const snapshot=()=>JSON.stringify({runs:f.db.sqlite.prepare('SELECT * FROM analysis_runs').all(),reviews:f.db.sqlite.prepare('SELECT * FROM issue_event_reviews').all()});const before=snapshot();
 const text='time,energy\n2026-01-01T00:00:00Z,99\n2026-01-01T01:00:00Z,',key='mapped/synthetic/correction.csv';await f.bucket.put(key,text);
 const p=await f.service.previewPerformanceCsv(await f.service.loadPerformanceContext('site'),{siteId:'site',fileName:'synthetic.csv',timezone:'UTC',mapping:{timestamp:'time'},equipmentMapping:{signals:[{column:'energy',equipmentId:'meter',measurement:'Energy'}]},intervalMinutes:60,timestampConvention:'start'},key);
 assert.equal(p.counts.overlapping,2);assert.equal(p.counts.blankPreserved,1);await assert.rejects(f.service.commitPerformancePreview({siteId:'site',stageId:p.stageId,previewToken:p.previewToken,approveOverlap:false},'synthetic'),/overlap/i);
 await f.service.commitPerformancePreview({siteId:'site',stageId:p.stageId,previewToken:p.previewToken,approveOverlap:true},'synthetic');
 const rows=[...f.manager.site('site').rows()];assert.equal(rows.length,144);assert.equal(rows.find(r=>r.channel.equipmentId==='meter'&&r.channel.measurement==='Energy'&&r.timestamp.startsWith('2026-01-01T00')).value,99);assert.equal(rows.find(r=>r.channel.equipmentId==='meter'&&r.channel.measurement==='Energy'&&r.timestamp.startsWith('2026-01-01T01')).value,10);assert.equal(snapshot(),before);assert.equal(await(await f.bucket.get('analysis/synthetic')).text(),'unchanged synthetic saved result');
});
