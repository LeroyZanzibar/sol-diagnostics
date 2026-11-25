import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {LocalDatabase,LocalBucket} from '../../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';
import {monthlyFixture} from './monthly-fixture.mjs';
import {emptyConfiguration,formatValue} from '../../app/monthly-domain.mjs';
import {fixtureAuth,fixtureMappings} from './manual-vcom-fixture.preload.mjs';

test('built authenticated named expected import/Apply/readback and correction preserve monthly and saved outage/model state',{timeout:90000},async t=>{
 const f=await monthlyFixture(t),key='analysis/synthetic-retained.json',savedBytes='{"synthetic":true,"outage":"retained result"}';
 const db=new LocalDatabase(join(f.directory,'sol-diagnostics.sqlite'),resolve('drizzle')),bucket=new LocalBucket(db,join(f.directory,'objects'));
 try{
  db.sqlite.prepare('INSERT INTO analysis_runs(id,site_id,import_id,parser_version,model_revision,analysis_object_key) VALUES (?,?,?,?,?,?)').run('retained-run',f.siteId,'retained-import',28,'retained-model',key);
  db.sqlite.prepare('INSERT INTO issue_event_reviews(id,site_id,event_key,version,state,updated_at) VALUES (?,?,?,?,?,?)').run('retained-review',f.siteId,'retained-event',1,'{"status":"confirmed"}','2026-01-02');
  db.sqlite.prepare('INSERT INTO performance_summaries VALUES (?,?,?,?)').run('retained-import',f.siteId,JSON.stringify({objectKey:key}),'2026-01-02');
  await bucket.put(key,savedBytes);
 }finally{db.close();}
 const protectedState=()=>f.inspect(shared=>Object.fromEntries(['site_settings','equipment_assets','analysis_runs','issue_event_reviews','performance_summaries','analysis_jobs'].map(table=>[table,shared.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
 const before=protectedState();await f.start();
 const get=()=>f.request(`/api/monthly-data?siteId=${f.siteId}`),post=body=>f.request('/api/monthly-data',{siteId:f.siteId,...body});
 const configuration={...emptyConfiguration(),operationsStart:'2026-01-01',degradation:'0'};configuration.baselines[1]={production:'1000.1250',revenue:'100',insolation:'31'};
 const impact=await post({action:'preview',revision:0,configuration});await post({action:'configuration',revision:0,configuration,previewToken:impact.token});
 await post({action:'utility',revision:1,rows:[{month:'2026-01',onPeak:'5.1250',offPeak:null,unpaidEnergy:'12.6250',revenue:'-1.25',energyUsed:'0',invoiceCost:null}]});
 const monthlyBefore=await get(),events=[];
 async function apply(readings,approveOverlap){
  const previewBody={action:'preview',siteId:f.siteId,timezone:'UTC',timestampConvention:'start',intervalMinutes:60,readings};
  const staged=await f.request('/api/performance-data',previewBody),p=staged.preview;
  const stagedReadback=await f.request(`/api/performance-data?siteId=${f.siteId}&stageId=${p.stageId}`);
  assert.equal(stagedReadback.preview.stageId,p.stageId);
  const commitBody={action:'commit',siteId:f.siteId,stageId:p.stageId,previewToken:p.previewToken,approveOverlap};
  const receipt=await f.request('/api/performance-data',commitBody),canonical=await f.request(`/api/performance-data?siteId=${f.siteId}`),monthly=await get();
  events.push({previewBody,staged,stagedReadback,commitBody,receipt,canonical,monthly});return monthly;
 }
 const readings=[12,24].flatMap((value,i)=>{const timestamp=`2026-01-01T${12+i}:00:00Z`;return [{timestamp,equipmentId:'@site',measurement:'Expected Production',channelId:'forecast',value,unit:'kWh'},{timestamp,equipmentId:'weather',measurement:'Irradiance',value:500,unit:'W/m²'}];});
 let current=await apply(readings,false);assert.equal(current.telemetry.expectedChannelId,'["@site","Expected Production","forecast"]');assert.equal(current.telemetry.expectedUnavailableReason,null);
 assert.equal(formatValue(current.telemetry.months['2026-01'].expected.value),'36');assert.equal(current.telemetry.months['2026-01'].expected.coveredMilliseconds,7200000);assert.equal(current.telemetry.months['2026-01'].expected.state,'partial');assert.deepEqual(current.telemetry.months['2026-01'].insolation.value,{n:'1',d:'1'});assert.equal(current.telemetry.poa.state,'selected');
 current=await apply([{...readings[0],value:18}],true);assert.equal(current.telemetry.sourceRevision,2);assert.equal(formatValue(current.telemetry.months['2026-01'].expected.value),'42');
 await f.stop();await f.start();current=await get();assert.equal(formatValue(current.telemetry.months['2026-01'].expected.value),'42');
 assert.deepEqual(current.utility,monthlyBefore.utility);assert.deepEqual(current.configuration,monthlyBefore.configuration);assert.equal(current.revision,monthlyBefore.revision);assert.deepEqual(protectedState(),before);
 await f.stop();const manager=new PerformanceStoreManager(join(f.directory,'performance'));let retained;
 try{
  const store=manager.site(f.siteId);retained={original:Array.from(store.rows(1)),corrected:Array.from(store.rows(2))};
  for(const [rows,values] of [[retained.original,[12,24]],[retained.corrected,[18,24]]])assert.deepEqual(rows.filter(r=>r.channel.measurement==='Expected Production').map(r=>[r.channel.id,r.value]),values.map(v=>['["@site","Expected Production","forecast"]',v]));
 }finally{manager.close();}
 const reopened=new LocalDatabase(join(f.directory,'sol-diagnostics.sqlite'),resolve('drizzle'));try{assert.equal(await(await new LocalBucket(reopened,join(f.directory,'objects')).get(key)).text(),savedBytes);}finally{reopened.close();}
 writeFileSync(join(f.directory,'verified-named-expected.json'),JSON.stringify({monthlyBefore,events,final:current,protectedBefore:before,protectedAfter:protectedState(),retained,savedResultUnchanged:true},null,2));console.log('Named expected HTTP evidence:',f.directory);
});

test('built HTTP absent degradation: unrelated utility save, partial setup, exact zero and clear survive restart',{timeout:90000},async t=>{
 const f=await monthlyFixture(t);await f.start();const get=()=>f.request(`/api/monthly-data?siteId=${f.siteId}`),post=body=>f.request('/api/monthly-data',{siteId:f.siteId,...body});
 let current=await get();assert.equal(current.configuration.degradation,null);assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM monthly_configuration').get().n),0);
 const actual={month:'2024-03',onPeak:'123.1250',offPeak:null,unpaidEnergy:null,revenue:'-5.75',energyUsed:'0',invoiceCost:null};
 current=await post({action:'utility',revision:0,rows:[actual]});await f.stop();await f.start();current=await get();assert.equal(current.configuration.degradation,null);
 const readbacks=[current];async function save(configuration){const preview=await post({action:'preview',revision:current.revision,configuration});assert.equal((await get()).revision,current.revision);await post({action:'configuration',revision:current.revision,configuration,previewToken:preview.token});current=await get();readbacks.push(current);}
 const partial=structuredClone(current.configuration);partial.baselines[3]={production:'3100.1250',revenue:null,insolation:'31.1250'};await save(partial);assert.equal(current.configuration.operationsStart,null);assert.equal(current.configuration.degradation,null);
 await save({...current.configuration,operationsStart:'2024-03-16'});assert.equal(current.projections.length,300);assert.ok(current.projections.every(row=>row.production===null&&row.revenue===null));assert.ok(current.projections[0].insolation);
 const insolations=current.projections.map(row=>row.insolation);
 for(const rate of ['0','0.123456789012345678','']){await save({...current.configuration,degradation:rate});await f.stop();await f.start();current=await get();assert.equal(current.configuration.degradation,rate||null);assert.deepEqual(current.projections.map(row=>row.insolation),insolations);assert.equal(current.utility['2024-03'].onPeak,actual.onPeak);if(rate==='0')assert.ok(current.projections[0].production);}
 assert.equal(current.configuration.baselines[3].production,'3100.1250');assert.equal(current.projections[0].production,null);
 writeFileSync(join(f.directory,'verified-absence.json'),JSON.stringify({readbacks,final:current},null,2));console.log('Absence HTTP evidence:',f.directory);
});

test('built authenticated HTTP: populated setup, exact monthly saves, preview/impact, corrected import and durable restart recovery', {timeout:180000},async t=>{
 const f=await monthlyFixture(t);await f.start();const get=()=>f.request(`/api/monthly-data?siteId=${f.siteId}`),post=(body,status=200,extra={})=>f.request('/api/monthly-data',{siteId:f.siteId,...body},status,extra);
 assert.equal((await fetch(f.base+`/api/monthly-data?siteId=${f.siteId}`)).status,401);
 const setup=await get();assert.equal(setup.configuration.operationsStart,null);assert.equal(setup.projections.length,0);assert.deepEqual(setup.utility,{});
 const config={...emptyConfiguration(),operationsStart:'2026-01-16',degradation:'0.123456789012345678',baselines:Object.fromEntries(Array.from({length:12},(_,i)=>[i+1,{production:'3100.123456789012345',revenue:'310.1234567890123456',insolation:'31.12345678901234567'}]))};
 await post({action:'preview',revision:0,configuration:config},403,{Origin:'https://foreign.invalid'});
 const preview=await post({action:'preview',revision:0,configuration:config});assert.equal(preview.impact.length,300);assert.equal((await get()).revision,0);
 let saved=await post({action:'configuration',revision:0,configuration:config,previewToken:preview.token});assert.equal(saved.projections.length,300);assert.equal(saved.configuration.degradation,config.degradation);
 assert.equal(saved.projections[0].operationalDays,16);assert.equal(saved.projections.at(-1).month,'2050-12');
 const rows=[{month:'2026-01',onPeak:'123.1234567890123456',offPeak:'0.000000000000000001',unpaidEnergy:null,revenue:'-123.123456789012345',energyUsed:'0',invoiceCost:'000.01230'},{month:'2026-02',onPeak:null,offPeak:'123.45',unpaidEnergy:null,revenue:null,energyUsed:null,invoiceCost:'0'}];
 saved=await post({action:'utility',revision:1,rows});assert.equal(saved.revision,2);
 for(const {month,...values} of rows)assert.deepEqual(saved.utility[month],values);
 await post({action:'utility',revision:1,rows},409);await post({action:'utility',revision:2,rows:[...rows,{...rows[0],month:'2026-03',onPeak:'1e3'}]},400);
 assert.equal((await get()).utility['2026-03'],undefined);
 const unchanged=await post({action:'utility',revision:2,rows});assert.deepEqual(unchanged.utility,saved.utility);
 const corrected={...config,baselines:{...config.baselines,1:{...config.baselines[1],production:'6200.123456789012345'}}};
 const impact=await post({action:'preview',revision:3,configuration:corrected});assert.equal(impact.impact.length,25);assert.equal((await get()).configuration.baselines[1].production,config.baselines[1].production);
 await post({action:'configuration',revision:3,configuration:corrected,previewToken:impact.token});assert.deepEqual((await get()).utility,saved.utility);
 const readings=[];for(let hour=0;hour<24;hour++)for(const [equipmentId,measurement,value,unit] of [['@site','Expected Production',12,'kWh'],['weather','Irradiance',500,'W/m²']])readings.push({timestamp:`2026-01-01T${String(hour).padStart(2,'0')}:00:00Z`,equipmentId,measurement,value,unit});
 const siteBefore=f.inspect(db=>db.prepare('SELECT * FROM site_settings WHERE id=?').get(f.siteId));
 const staged=(await f.request('/api/performance-data',{action:'preview',siteId:f.siteId,timezone:'UTC',timestampConvention:'start',intervalMinutes:60,readings})).preview;
 const monthlyOnly={...corrected,degradation:'0.25'};const monthlyImpact=await post({action:'preview',revision:4,configuration:monthlyOnly});
 await post({action:'configuration',revision:4,configuration:monthlyOnly,previewToken:monthlyImpact.token});
 assert.deepEqual(f.inspect(db=>db.prepare('SELECT * FROM site_settings WHERE id=?').get(f.siteId)),siteBefore,'Monthly-only settings do not change whole-site import hashes');
 await f.request('/api/performance-data',{action:'commit',siteId:f.siteId,stageId:staged.stageId,previewToken:staged.previewToken,approveOverlap:false});let current=await get();assert.equal(formatValue(current.telemetry.months['2026-01'].expected.value),'288');assert.deepEqual(current.telemetry.months['2026-01'].insolation.value,{n:'12',d:'1'});assert.equal(current.telemetry.poa.state,'selected');assert.equal(current.telemetry.months['2026-01'].expected.state,'partial');assert.equal(current.telemetry.state,'current');
 await f.commit([{...readings[0],value:24}]);
 // Miss the browser wake completely: stop before reading monthly output.
 await f.stop();await f.start();const deadline=Date.now()+20000;let durable;
 while(Date.now()<deadline){durable=f.inspect(db=>db.prepare('SELECT source_revision,payload_json FROM monthly_rollups WHERE site_id=?').get(f.siteId));if(durable?.source_revision===2)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.equal(durable.source_revision,2,'startup refresh advances without monthly GET');assert.equal(formatValue(JSON.parse(durable.payload_json).months['2026-01'].expected.value),'300');
 current=await get();assert.equal(current.telemetry.sourceRevision,2);assert.deepEqual(current.utility,saved.utility);assert.equal(current.configuration.baselines[1].production,corrected.baselines[1].production);
 assert.deepEqual(f.inspect(db=>Object.fromEntries(['analysis_jobs','analysis_runs','performance_summaries','issue_event_reviews'].map(table=>[table,db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]))),{analysis_jobs:0,analysis_runs:0,performance_summaries:0,issue_event_reviews:0});
 writeFileSync(join(f.directory,'verified-monthly.json'),JSON.stringify(current,null,2));console.log('Synthetic evidence:',f.directory);
});

test('real offline VCOM Apply retains satellite zero, selected POA fallback and partial simulation coverage through owner corrections', {timeout:180000},async t=>{
 const f=await monthlyFixture(t);await f.start();const action=(body,status=200)=>f.request('/api/manual-vcom',{siteId:f.siteId,...body},status);
 await action({action:'configure',expectedGeneration:0,systemKey:'TEST1',credentials:fixtureAuth});await action({action:'discover',expectedGeneration:1});await action({action:'mappings',expectedGeneration:2,mappings:fixtureMappings,selectedPoaSourceId:'poa:301'});
 const started=await action({action:'start',expectedGeneration:3,requestId:'monthly-offline-vcom',fromDate:'2026-01-01',throughDate:'2026-01-01'},202),id=started.job.id;
 const deadline=Date.now()+60000;let job;
 while(Date.now()<deadline){job=f.inspect(db=>db.prepare('SELECT status FROM vcom_manual_jobs WHERE id=?').get(id));if(job.status==='awaiting_approval')break;assert.notEqual(job.status,'failed');await new Promise(resolve=>setTimeout(resolve,100));}
 assert.equal(job.status,'awaiting_approval');job=(await f.request(`/api/manual-vcom?siteId=${f.siteId}&jobId=${id}`)).job;
 await action({action:'apply',jobId:id,stageId:job.stageId,previewToken:job.preview.previewToken,approveOverlap:false});
 const get=()=>f.request(`/api/monthly-data?siteId=${f.siteId}`);let current=await get(),m=current.telemetry.months['2026-01'];
 assert.equal(formatValue(m.expected.value),'287');assert.equal(m.expected.partialIntervals,1);assert.equal(m.expected.unknownQualityIntervals,0);assert.equal(m.expected.coveredMilliseconds,24*3600000-300000);
 assert.equal(formatValue(m.insolation.value,2),'11.60');assert.equal(m.insolation.satelliteIntervals,undefined);assert.equal(m.insolation.poaIntervals,24);assert.equal(m.insolation.unknownQualityIntervals,0);assert.match(m.insolation.source,/Uploaded POA/);assert.equal(current.telemetry.poa.state,'selected');assert.equal(current.confirmedLoss.state,'missing');
 const configuration={...current.configuration,irradianceChannelId:current.telemetry.selectedChannelId};
 const preview=await f.request('/api/monthly-data',{siteId:f.siteId,action:'preview',revision:current.revision,configuration});assert.equal(preview.sourceChanged,true);assert.equal((await get()).configuration.irradianceChannelId,null);
 await f.request('/api/monthly-data',{siteId:f.siteId,action:'configuration',revision:current.revision,configuration,previewToken:preview.token});assert.deepEqual((await get()).configuration,configuration);
 // Null overlaps retain original effective ownership, including the partial hour.
 await f.commit([{timestamp:'2026-01-01T00:00:00Z',equipmentId:'@site',measurement:'Expected Production',value:null,unit:'kWh'}]);current=await get();assert.equal(current.telemetry.months['2026-01'].expected.partialIntervals,1);
 // An explicit numeric CSV correction becomes its own owner, no stale VCOM quality.
 await f.commit([{timestamp:'2026-01-01T00:00:00Z',equipmentId:'@site',measurement:'Expected Production',value:11,unit:'kWh'}]);current=await get();assert.equal(current.telemetry.months['2026-01'].expected.partialIntervals,0);assert.equal(formatValue(current.telemetry.months['2026-01'].expected.value),'287');
 assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n),0);writeFileSync(join(f.directory,'verified-vcom-monthly.json'),JSON.stringify(current,null,2));console.log('Offline VCOM evidence:',f.directory);
});
