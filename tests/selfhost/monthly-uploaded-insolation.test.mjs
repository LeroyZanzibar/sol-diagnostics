import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {LocalDatabase,LocalBucket} from '../../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';
import {MonthlyService} from '../../selfhost/monthly-rollups.mjs';
const channel={id:'uploaded-poa',equipmentId:'weather',measurement:'Irradiance',unit:'W/m²'};
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'monthly-uploaded-'));let database,performance,service;
 const open=()=>{database=new LocalDatabase(join(root,'shared.sqlite'),resolve('drizzle'));performance=new PerformanceStoreManager(join(root,'performance'));service=new MonthlyService({database,bucket:new LocalBucket(database,join(root,'objects')),performance});};
 const close=async()=>{await service.stop();performance.close();database.close();};open();database.sqlite.exec("INSERT INTO site_settings(id,name) VALUES('site','Synthetic')");t.after(close);
 return {get database(){return database;},get performance(){return performance;},get service(){return service;},async reopen(){await close();open();},async commit(rows,source='csv',intervalMinutes=60){const s=performance.site('site'),p=await s.stage({source,fileName:'Synthetic upload',timezone:'America/New_York',intervalMinutes,modelRevision:'synthetic'},rows);return s.commit(p.stageId,{previewToken:p.previewToken,approveOverlap:true,modelRevision:'synthetic',actor:'synthetic'});}};
}
const row=(timestamp,value,c=channel)=>({timestamp,value,channel:c});
const value=(v,m='2024-11')=>v.telemetry.months[m].insolation.value;
async function select(f,id){const v=await f.service.read('site'),c={...v.configuration,irradianceChannelId:id},p=f.service.inputs.preview('site',v.revision,c);assert.equal(p.sourceChanged,true);await f.service.validateSelection('site',c);f.service.inputs.saveConfiguration('site',v.revision,c,p.token);}
for(const source of ['csv','api'])test(`${source} uploaded intervals sum/1000 at local month and DST boundaries; zero, gaps, canonical preservation`,async t=>{
 const f=fixture(t);await f.commit([row('2024-11-01T03:00:00.000Z',200),row('2024-11-01T04:00:00.000Z',300),row('2024-11-03T05:00:00.000Z',400),row('2024-11-03T06:00:00.000Z',500),row('2024-11-03T07:00:00.000Z',0),row('2024-11-03T08:00:00.000Z',null)],source);
 const before=[...f.performance.site('site').rows()],head=f.performance.site('site').describe(),v=await f.service.read('site');assert.deepEqual(value(v,'2024-10'),{n:'1',d:'5'});assert.deepEqual(value(v),{n:'6',d:'5'});assert.equal(v.telemetry.months['2024-11'].insolation.coveredMilliseconds,4*3600000);assert.equal(v.telemetry.months['2024-11'].expectedMilliseconds,721*3600000);assert.equal(v.telemetry.months['2024-11'].insolation.state,'partial');assert.equal(v.telemetry.selectedChannelId,channel.id);assert.deepEqual([...f.performance.site('site').rows()],before);assert.deepEqual(f.performance.site('site').describe(),head);
 await f.reopen();assert.deepEqual(value(await f.service.read('site')),value(v));
});
test('interval energy is never multiplied by duration',async t=>{const f=fixture(t);await f.commit([row('2024-11-01T04:00:00.000Z',500)],'csv',30);assert.deepEqual(value(await f.service.read('site')),{n:'1',d:'2'});});
test('duplicate channels require explicit selection, persist, refresh edits and upgrade measured-only cache',async t=>{
 const f=fixture(t),other={...channel,equipmentId:'other-weather',id:'other-poa',measurement:'POA irradiance',unit:'Wh/m²'};await f.commit([row('2024-11-01T04:00:00.000Z',500),row('2024-11-01T04:00:00.000Z',900,other)]);
 let v=await f.service.read('site');assert.equal(v.telemetry.selectionRequired,true);assert.equal(value(v),null);await select(f,channel.id);v=await f.service.read('site');assert.deepEqual(value(v),{n:'1',d:'2'});
 const old=structuredClone(v.telemetry);old.months['2024-11'].insolation.value=null;f.database.sqlite.prepare('UPDATE monthly_rollups SET calculation_version=3,payload_json=? WHERE site_id=?').run(JSON.stringify(old),'site');await f.reopen();v=await f.service.read('site');assert.deepEqual(value(v),{n:'1',d:'2'});assert.equal(v.configuration.irradianceChannelId,channel.id);
 await select(f,other.id);assert.deepEqual(value(await f.service.read('site')),{n:'9',d:'10'});await f.commit([row('2024-11-01T04:00:00.000Z',1250,other)],'api');assert.deepEqual(value(await f.service.read('site')),{n:'5',d:'4'});
 await assert.rejects(f.service.validateSelection('site',{...v.configuration,irradianceChannelId:'missing'}),{code:'reporting-source-missing'});
});
test('same equipment historical aliases span months, deduplicate overlaps and exclude conflicts',async t=>{
 const f=fixture(t),alias={...channel,id:'historic-poa',measurement:'POA irradiance'};
 await f.commit([row('2024-11-01T03:00:00.000Z',200,alias),row('2024-11-01T04:00:00.000Z',300),row('2024-11-01T05:00:00.000Z',400),row('2024-11-01T05:00:00.000Z',400,alias),row('2024-11-01T06:00:00.000Z',500),row('2024-11-01T06:00:00.000Z',600,alias)]);
 let v=await f.service.read('site');assert.equal(v.telemetry.candidates.length,1);assert.equal(v.telemetry.selectionRequired,false);assert.deepEqual(value(v,'2024-10'),{n:'1',d:'5'});assert.deepEqual(value(v),{n:'7',d:'10'});assert.equal(v.telemetry.months['2024-11'].insolation.unavailableIntervals,1);assert.equal(v.telemetry.months['2024-11'].insolation.coveredMilliseconds,2*3600000);
 await select(f,alias.id);await f.reopen();v=await f.service.read('site');assert.equal(v.configuration.irradianceChannelId,alias.id);assert.equal(v.telemetry.selectedChannelId,alias.id);assert.deepEqual(value(v),{n:'7',d:'10'});
});
test('zero-only and missing-only months remain distinct without zero filling',async t=>{
 const f=fixture(t);await f.commit([row('2024-11-01T04:00:00.000Z',0),row('2024-12-01T05:00:00.000Z',null)]);
 const v=await f.service.read('site');assert.deepEqual(value(v),{n:'0',d:'1'});assert.equal(v.telemetry.months['2024-11'].insolation.state,'partial');assert.equal(value(v,'2024-12'),null);assert.equal(v.telemetry.months['2024-12'].insolation.state,'missing');assert.equal(v.telemetry.months['2025-01'],undefined);
});
test('same measurement duplicate IDs are independent even on one equipment',async t=>{
 const f=fixture(t),duplicate={...channel,id:'independent'};await f.commit([row('2024-11-01T04:00:00.000Z',500),row('2024-11-01T04:00:00.000Z',500,duplicate)]);
 let v=await f.service.read('site');assert.equal(v.telemetry.selectionRequired,true);assert.equal(value(v),null);await select(f,channel.id);assert.deepEqual(value(await f.service.read('site')),{n:'1',d:'2'});
});
test('selection publication fence rejects an older in-flight generation',async t=>{
 const f=fixture(t),other={...channel,id:'second',equipmentId:'other'};await f.commit([row('2024-11-01T04:00:00.000Z',500),row('2024-11-01T04:00:00.000Z',900,other)]);await select(f,channel.id);
 let release,enter;const gate=new Promise(r=>release=r),entered=new Promise(r=>enter=r),original=f.service.calculate.bind(f.service);f.service.calculate=async(...args)=>{const result=await original(...args);enter();await gate;return result;};const pending=f.service.refresh('site');await entered;
 const v=f.service.inputs.read('site'),c={...v.configuration,irradianceChannelId:other.id},p=f.service.inputs.preview('site',v.revision,c);f.service.inputs.saveConfiguration('site',v.revision,c,p.token);release();assert.equal((await pending).state,'refreshing');f.service.calculate=original;assert.deepEqual(value(await f.service.read('site')),{n:'9',d:'10'});
});

