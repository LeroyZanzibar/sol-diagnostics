import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PerformanceStoreManager} from '../selfhost/performance-store.mjs';
import {loadSource} from './source-module.mjs';
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'sol-export-csv-')),manager=new PerformanceStoreManager(root),store=manager.site('site');
 t.after(()=>{manager.close();rmSync(root,{recursive:true,force:true});});
 const bindings={loadPerformanceContext:async siteId=>{if(siteId!=='site')throw Object.assign(new Error('Site unavailable.'),{status:400});return {siteId,store,dataset:store.describe()};},requiredText:(value)=>{if(!value)throw Object.assign(new Error('Site required.'),{status:400});return value;},performanceError:error=>Response.json({error:error.message},{status:error.status||500,headers:{'Cache-Control':'private, no-store'}})};
 const route=loadSource('app/api/performance-data/export/route.ts',[],bindings);
 const put=async(values,approveOverlap=false)=>{const p=await store.stage({source:'api',fileName:'Synthetic',timezone:'UTC',intervalMinutes:60,modelRevision:'model'},values);return store.commit(p.stageId,{previewToken:p.previewToken,modelRevision:'model',approveOverlap,actor:'test'});};
 return {route,store,put};
}
const row=(timestamp,value,equipmentId='meter',measurement='Energy',unit='kWh')=>({timestamp,channel:{id:JSON.stringify([equipmentId,measurement,null]),equipmentId,measurement,unit},value});
const request=()=>new Request('http://local/api/performance-data/export?siteId=site');
test('CSV export emits actual canonical values, exact UTC timestamps and blank nulls',async t=>{
 const f=fixture(t);await f.put([row('2026-11-01T05:00:00.000Z',0),row('2026-11-01T06:00:00.000Z',null),row('2026-11-01T07:00:00.000Z',-2)]);
 const response=await f.route.GET(request()),text=await response.text();
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/csv/);assert.match(response.headers.get('cache-control'),/no-store/);assert.match(response.headers.get('content-disposition'),/attachment/);assert.equal(response.headers.get('x-data-revision'),'1');
 assert.match(text,/Timestamp,Equipment ID,Measurement,Value,Unit,Channel ID\r\n/);
 assert.match(text,/2026-11-01T05:00:00.000Z,meter,Energy,0,kWh/);assert.match(text,/2026-11-01T06:00:00.000Z,meter,Energy,,kWh/);assert.match(text,/2026-11-01T07:00:00.000Z,meter,Energy,-2,kWh/);
 assert.equal(f.store.describe().revision,1);
});
test('CSV export pins revision before a correction, including readings beyond its first page',async t=>{
 const f=fixture(t),values=Array.from({length:700},(_,i)=>row(new Date(Date.UTC(2026,0,1)+i*3600000).toISOString(),i));await f.put(values);
 const response=await f.route.GET(request());await f.put([row(values[699].timestamp,9999)],true);
 const text=await response.text();assert.ok(text.includes(`${values[699].timestamp},meter,Energy,699,kWh`));assert.ok(!text.includes(',9999,'));assert.equal(response.headers.get('x-data-revision'),'1');assert.equal(f.store.describe().revision,2);
});
test('CSV export quotes multiline text and protects spreadsheet-formula-like text without changing numeric negatives',async t=>{
 const f=fixture(t);await f.put([row('2026-01-01T00:00:00.000Z','=HYPERLINK("example")','sensor','Other',''),row('2026-01-01T01:00:00.000Z','line one,\nline "two"','sensor','Other',''),row('2026-01-01T02:00:00.000Z',-5)]);
 const text=await(await f.route.GET(request())).text();assert.ok(text.includes("'=HYPERLINK"));assert.ok(text.includes('"line one,\nline ""two"""'));assert.ok(text.includes(',Energy,-5,kWh'));
});
test('empty, missing and foreign sites return errors instead of misleading empty exports',async t=>{
 const f=fixture(t);for(const url of ['http://local/api/performance-data/export','http://local/api/performance-data/export?siteId=other','http://local/api/performance-data/export?siteId=site']){const response=await f.route.GET(new Request(url));assert.equal(response.status,400);assert.ok((await response.json()).error);}
});
test('cancelled download closes the retained row iterator',async t=>{
 const f=fixture(t);await f.put([row('2026-01-01T00:00:00.000Z',1)]);let returned=false;const original=f.store.rows.bind(f.store);f.store.rows=(...args)=>{const it=original(...args),close=it.return.bind(it);it.return=(...values)=>{returned=true;return close(...values);};return it;};
 const response=await f.route.GET(request());await response.body.cancel();assert.equal(returned,true);
});
