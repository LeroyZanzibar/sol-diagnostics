import test from 'node:test';
import {createHash} from 'node:crypto';
import {emptyConfiguration} from '../../app/monthly-domain.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {LocalDatabase,LocalBucket} from '../../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';
import {MonthlyService} from '../../selfhost/monthly-rollups.mjs';
import {seedMeasuredPoa} from './monthly-poa-fixture.mjs';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'monthly-poa-'));let database,bucket,performance,service;
 const open=()=>{database=new LocalDatabase(join(root,'shared.sqlite'),resolve('drizzle'));performance=new PerformanceStoreManager(join(root,'performance'));bucket=new LocalBucket(database,join(root,'objects'));service=new MonthlyService({database,bucket,performance});};
 const close=async()=>{await service.stop();performance.close();database.close();};open();database.sqlite.exec("INSERT INTO site_settings(id,name) VALUES('site','Synthetic POA'),('other','Other synthetic site')");t.after(close);
 return {root,get database(){return database;},get bucket(){return bucket;},get performance(){return performance;},get service(){return service;},async reopen(){await close();open();}};
}
const samples=[{timestamp:'2026-01-01T00:00:00.000Z',poa:600,satellite:900,expected:12},{timestamp:'2026-01-01T01:00:00.000Z',poa:0,satellite:800,expected:0},{timestamp:'2026-01-01T02:00:00.000Z',poa:-10,satellite:700,expected:6},{timestamp:'2026-01-01T03:00:00.000Z',poa:null,satellite:500,expected:4}];
test('measured POA survives satellite arbitration, preserving zero/negative/gaps and analysis',async t=>{
 const f=fixture(t),seed=await seedMeasuredPoa({...f,samples}),store=f.performance.site('site'),before=Array.from(store.rows()),head=store.describe();
 const view=await f.service.read('site'),m=view.telemetry.months['2026-01'];
 assert.deepEqual(m.insolation.value,{n:'59',d:'100'},'600 + 0 - 10 measured W/m², never 900 + 800 + 700 + 500 satellite');
 assert.equal(m.insolation.coveredMilliseconds,3*3600000);assert.equal(m.insolation.negativeIntervals,1);assert.equal(m.insolation.state,'partial');
 assert.equal(view.telemetry.poa.state,'selected');assert.equal(view.telemetry.poa.selectedSourceId,seed.sourceId);assert.equal(view.telemetry.selectedChannelId===seed.sourceId,false);
 assert.deepEqual(m.expected.value,{n:'22',d:'1'});assert.deepEqual(Array.from(store.rows()),before);assert.deepEqual(store.describe(),head);
});

const insolation=view=>view.telemetry.months['2026-01'].insolation;
async function generic(f,rows){const store=f.performance.site('site'),p=await store.stage({source:'csv',fileName:'POA physical sensor.csv',timezone:'UTC',intervalMinutes:60,modelRevision:'synthetic-monthly-poa'},rows);return store.commit(p.stageId,{previewToken:p.previewToken,approveOverlap:true,modelRevision:'synthetic-monthly-poa',actor:'synthetic'});}
test('generic named POA is not proof, and legacy channel selection is preserved without authority',async t=>{
 const f=fixture(t),c={id:'named-POA',equipmentId:'POA sensor',measurement:'POA irradiance',unit:'W/m²'};
 await generic(f,[{timestamp:samples[0].timestamp,channel:c,value:500}]);
 const legacy={...emptyConfiguration(),irradianceChannelId:c.id};delete legacy.poaSourceId;
 f.database.sqlite.prepare('INSERT INTO monthly_configuration VALUES(?,?,?,?)').run('site',1,JSON.stringify(legacy),'synthetic');
 let view=await f.service.read('site');assert.equal(view.configuration.poaSourceId,null);assert.equal(view.configuration.irradianceChannelId,c.id);assert.equal(view.telemetry.poa.state,'missing');assert.equal(insolation(view).value,null);assert.equal(view.telemetry.selectionRequired,false);
 const p=f.service.inputs.preview('site',1,legacy);f.service.inputs.saveConfiguration('site',1,legacy,p.token);await f.reopen();view=await f.service.read('site');assert.equal(view.configuration.irradianceChannelId,c.id);assert.equal(view.configuration.poaSourceId,null);assert.equal(insolation(view).value,null);
});
for(const option of ['unselected','null','zero','converted'])test(`known physical identity with ${option} observations`,async t=>{
 const f=fixture(t),poa=option==='null'?null:option==='zero'?0:option==='converted'?0.6:600;
 await seedMeasuredPoa({...f,samples:[{...samples[0],poa}],selected:option!=='unselected',sensors:[{id:'301',name:'POA South',unit:option==='converted'?'kW/m²':'W/m²'}]});
 const view=await f.service.read('site');assert.equal(view.telemetry.poa.state,'selected');assert.equal(view.telemetry.poa.candidates.length,1);
 assert.deepEqual(insolation(view).value,option==='unselected'||option==='null'?null:option==='zero'?{n:'0',d:'1'}:{n:'3',d:'5'});
 assert.deepEqual(view.telemetry.months['2026-01'].expected.value,{n:'12',d:'1'});
});
test('multiple physical sensors require explicit preview/save/readback choice, with no gap switching',async t=>{
 const f=fixture(t),sensors=[{id:'301',name:'POA South',unit:'W/m²'},{id:'302',name:'POA North',unit:'W/m²'}];
 const a=await seedMeasuredPoa({...f,samples:[samples[0]],sensors});
 let view=await f.service.read('site');assert.equal(view.telemetry.poa.state,'selection-required');assert.equal(insolation(view).value,null);assert.equal(view.telemetry.poa.candidates.length,2);
 const config={...view.configuration,poaSourceId:a.sourceId,irradianceChannelId:'untouched-legacy-token'},p=f.service.inputs.preview('site',view.revision,config);
 assert.equal(p.sourceChanged,true);assert.equal((await f.service.read('site')).configuration.poaSourceId,null);await f.service.validateSelection('site',config);f.service.inputs.saveConfiguration('site',view.revision,config,p.token);
 await f.reopen();view=await f.service.read('site');assert.deepEqual(view.configuration,config);assert.deepEqual(insolation(view).value,{n:'3',d:'5'});
 const north=view.telemetry.poa.candidates.find(c=>c.deviceId==='302'),next={...config,poaSourceId:north.id},preview=f.service.inputs.preview('site',view.revision,next);f.service.inputs.saveConfiguration('site',view.revision,next,preview.token);
 view=await f.service.read('site');assert.equal(view.telemetry.poa.state,'selected');assert.equal(insolation(view).value,null,'Known unimported sensor never borrows the South sensor');
 await assert.rejects(f.service.validateSelection('site',{...config,poaSourceId:'unknown'}),{code:'reporting-source-missing'});await assert.rejects(f.service.validateSelection('other',config),{code:'reporting-source-missing'});
});
test('current owner null preservation versus identical canonical correction; never resurrect older raw POA',async t=>{
 const f=fixture(t),a=await seedMeasuredPoa({...f,samples:[samples[0]]}),store=f.performance.site('site'),row=[...store.reportingRows()].find(r=>r.channel.id===a.channelId&&r.timestamp===samples[0].timestamp);
 await generic(f,[{...row,value:null}]);let view=await f.service.read('site');assert.deepEqual(insolation(view).value,{n:'3',d:'5'});assert.equal([...store.reportingRows()].find(r=>r.channel.id===row.channel.id&&r.timestamp===row.timestamp).owner.revision,1);
 // Same canonical satellite number, different measured sensor value and owner.
 await seedMeasuredPoa({...f,samples:[{...samples[0],poa:200}]});view=await f.service.read('site');assert.deepEqual(insolation(view).value,{n:'1',d:'5'});assert.equal([...store.reportingRows()].find(r=>r.channel.id===row.channel.id&&r.timestamp===row.timestamp).owner.revision,3);
 await generic(f,[{...row,value:900}]);view=await f.service.read('site');assert.equal(insolation(view).value,null,'Older 600/200 raw POA cannot survive a generic current owner');assert.equal([...store.reportingRows()].find(r=>r.channel.id===row.channel.id&&r.timestamp===row.timestamp).owner.revision,4);
});
test('same-sensor overlapping canonical carriers deduplicate agreeing values and exclude conflicts',async t=>{
 const f=fixture(t);await seedMeasuredPoa({...f,samples:[samples[0]]});await seedMeasuredPoa({...f,samples:[samples[0]],equipmentId:'other-weather'});
 let view=await f.service.read('site');assert.equal(view.telemetry.poa.candidates.length,1);assert.deepEqual(insolation(view).value,{n:'3',d:'5'});assert.equal(insolation(view).coveredMilliseconds,3600000);
 await seedMeasuredPoa({...f,samples:[{...samples[0],poa:200}],equipmentId:'other-weather'});view=await f.service.read('site');assert.equal(insolation(view).value,null);assert.equal(insolation(view).unavailableIntervals,1);
});
test('old mixed/blank cache upgrades at unchanged revisions after native reopen; transient proof retries after restoration',async t=>{
 const f=fixture(t),{job}=await seedMeasuredPoa({...f,samples:[samples[0]]});const first=await f.service.read('site'),head=f.performance.site('site').describe();
 for(const value of [null,{n:'9',d:'10'}]){
  const old=structuredClone(first.telemetry);delete old.poa;old.months['2026-01'].insolation.value=value;old.calculationVersion=2;
  f.database.sqlite.prepare('UPDATE monthly_rollups SET calculation_version=2,payload_json=? WHERE site_id=?').run(JSON.stringify(old),'site');await f.reopen();
  const read=await f.service.read('site');assert.deepEqual(insolation(read).value,{n:'3',d:'5'});assert.equal(read.revision,first.revision);assert.deepEqual(f.performance.site('site').describe(),head);
 }
 const ref=job.state.windowObjects[0],bytes=await(await f.bucket.get(ref.key)).text();await f.bucket.delete(ref.key);f.database.sqlite.prepare('DELETE FROM monthly_rollups').run();
 let read=await f.service.read('site');assert.equal(insolation(read).value,null);assert.equal(read.telemetry.retryablePoa,true);
 await f.bucket.put(ref.key,bytes);await f.reopen();read=await f.service.read('site');assert.deepEqual(insolation(read).value,{n:'3',d:'5'});assert.equal(read.telemetry.retryablePoa,false);assert.deepEqual(f.performance.site('site').describe(),head);
});
for(const [name,mutate] of [
 ['sensor identity',q=>q.selectedPoaSourceId='poa:999'],['unit conversion',q=>q.selectedPoa=1200],['presence',q=>q.poaPresent=false],['pinned request',q=>q.requestIds=[]],['canonical arbitration',q=>q.originalSatellite=901],['timestamp',q=>q.timestampStartUtc='2026-01-02T00:00:00.000Z'],
])test(`semantic proof rejects ${name} even with matching new window digest`,async t=>{
 const f=fixture(t),{job}=await seedMeasuredPoa({...f,samples:[samples[0]]}),ref=job.state.windowObjects[0],window=await(await f.bucket.get(ref.key)).json();mutate(window.quality.find(q=>q.sourceId==='irradiance:combined'&&q.timestampStartUtc===samples[0].timestamp));
 const text=JSON.stringify(window),sha256=createHash('sha256').update(text).digest('hex'),key=`manual-vcom/${job.id}/window-0-${sha256}.json`;await f.bucket.put(key,text);
 const state={...job.state,windowObjects:[{...ref,key,sha256,bytes:Buffer.byteLength(text)}]};f.database.sqlite.prepare('UPDATE vcom_manual_jobs SET state=? WHERE id=?').run(JSON.stringify(state),job.id);
 const view=await f.service.read('site');assert.equal(insolation(view).value,null);assert.equal(insolation(view).unavailableIntervals,1);assert.deepEqual(view.telemetry.months['2026-01'].expected.value,{n:'12',d:'1'});
});
test('a changed pinned plan cannot authorize physical sensor data',async t=>{
 const f=fixture(t),{job}=await seedMeasuredPoa({...f,samples:[samples[0]]});job.plan.requests.find(r=>r.kind==='poa').deviceId='999';f.database.sqlite.prepare('UPDATE vcom_manual_jobs SET plan=? WHERE id=?').run(JSON.stringify(job.plan),job.id);
 const view=await f.service.read('site');assert.equal(view.telemetry.poa.state,'unavailable');assert.equal(insolation(view).value,null);
});

test('measured POA uses pinned local month boundaries and both fall-back instants',async t=>{
 const f=fixture(t);await seedMeasuredPoa({...f,timezone:'America/New_York',samples:[
  {timestamp:'2024-10-31T23:00:00.000Z',poa:100,satellite:900,expected:12},
  {timestamp:'2024-11-01T03:00:00.000Z',poa:200,satellite:900,expected:12},
  {timestamp:'2024-11-01T04:00:00.000Z',poa:300,satellite:900,expected:12},
  {timestamp:'2024-11-03T05:00:00.000Z',poa:400,satellite:900,expected:12},
  {timestamp:'2024-11-03T06:00:00.000Z',poa:500,satellite:900,expected:12},
 ]});
 const view=await f.service.read('site'),oct=view.telemetry.months['2024-10'],nov=view.telemetry.months['2024-11'];assert.deepEqual(oct.insolation.value,{n:'3',d:'10'});assert.deepEqual(nov.insolation.value,{n:'6',d:'5'});assert.equal(nov.expectedMilliseconds,721*3600000);assert.equal(nov.insolation.coveredMilliseconds,3*3600000);
});
test('source-change publication fence rejects an older in-flight sensor generation',async t=>{
 const f=fixture(t);await seedMeasuredPoa({...f,samples:[samples[0]],sensors:[{id:'301',name:'POA South',unit:'W/m²'},{id:'302',name:'POA North',unit:'W/m²'}]});
 const initial=await f.service.read('site'),config={...initial.configuration,poaSourceId:initial.telemetry.poa.candidates[0].id};let p=f.service.inputs.preview('site',0,config);f.service.inputs.saveConfiguration('site',0,config,p.token);
 let release,enter;const gate=new Promise(r=>release=r),entered=new Promise(r=>enter=r),original=f.service.calculate.bind(f.service);
 f.service.calculate=async(...args)=>{const result=await original(...args);enter();await gate;return result;};
 const pending=f.service.refresh('site');await entered;
 try{const next={...config,poaSourceId:initial.telemetry.poa.candidates[1].id};p=f.service.inputs.preview('site',1,next);f.service.inputs.saveConfiguration('site',1,next,p.token);}finally{release();}
 assert.equal((await pending).state,'refreshing');f.service.calculate=original;const next=await f.service.read('site');assert.equal(next.telemetry.poa.selectedSourceId,initial.telemetry.poa.candidates[1].id);assert.equal(insolation(next).value,null);
});
