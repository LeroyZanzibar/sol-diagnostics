import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {monthlyFixture} from './monthly-fixture.mjs';
import {emptyConfiguration,utilityTotal,formatValue} from '../../app/monthly-domain.mjs';

test('built authenticated unpaid full-row contract: save, invalid/missing atomic rejection, clear, precision and restart', {timeout:90000},async t=>{
 const f=await monthlyFixture(t);await f.start();
 const get=()=>f.request(`/api/monthly-data?siteId=${f.siteId}`),post=(body,status=200)=>f.request('/api/monthly-data',{siteId:f.siteId,...body},status);
 assert.equal((await fetch(f.base+`/api/monthly-data?siteId=${f.siteId}`)).status,401);
 const configuration={...emptyConfiguration(),operationsStart:'2024-03-16',degradation:'0.1250'};
 configuration.baselines[3]={production:'3100.1250',revenue:'310.1250',insolation:'31.1250'};
 const impact=await post({action:'preview',revision:0,configuration});await post({action:'configuration',revision:0,configuration,previewToken:impact.token});
 const before=await get();
 const protect=()=>f.inspect(db=>Object.fromEntries(['site_settings','equipment_assets','analysis_runs','issue_event_reviews','performance_summaries','analysis_jobs','vcom_site_settings','vcom_manual_jobs','monthly_rollups'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
 const protectedBefore=protect(),row={month:'2024-03',onPeak:'0.4',offPeak:'0.4',unpaidEnergy:'12.6250',revenue:'-123.1250',energyUsed:'0',invoiceCost:'000.01230'};
 let saved=await post({action:'utility',revision:1,rows:[row]});const {month,...values}=row;
 assert.deepEqual(saved.utility[month],values);assert.deepEqual(saved.projections,before.projections);assert.deepEqual(saved.configuration,before.configuration);assert.deepEqual(saved.telemetry,before.telemetry);assert.deepEqual(protect(),protectedBefore);
 assert.deepEqual(utilityTotal(values.onPeak,values.offPeak,values.unpaidEnergy),{n:'537',d:'40'});assert.equal(formatValue(utilityTotal(values.onPeak,values.offPeak,values.unpaidEnergy)),'13');
 const rejected=[];
 for(const invalid of [undefined,-1,'-1','1e3','1,000','999999999999.1','0.0000000000000000001']){
  const bad={...row,unpaidEnergy:invalid};
  const result=await post({action:'utility',revision:2,rows:[{...row,month:'2024-04',unpaidEnergy:'9.5'},bad]},400);rejected.push({bad,result});
  assert.deepEqual(await get(),saved,'Reject the whole write set without erasing previously stored unpaid energy');assert.deepEqual(protect(),protectedBefore);
 }
 await post({action:'utility',revision:1,rows:[row]},409);assert.deepEqual(await get(),saved);
 await f.stop();await f.start();assert.deepEqual(await get(),saved);
 saved=await post({action:'utility',revision:2,rows:[row]});assert.equal(saved.utility[month].unpaidEnergy,'12.6250');
 await f.stop();await f.start();assert.deepEqual(await get(),saved);
 const exact=await post({action:'utility',revision:3,rows:[{...row,onPeak:null,offPeak:null,unpaidEnergy:'999999999998.9999999'}]});
 await f.stop();await f.start();assert.deepEqual(await get(),exact);assert.equal(exact.utility[month].unpaidEnergy,'999999999998.9999999');
 const cleared=await post({action:'utility',revision:4,rows:[{...row,onPeak:null,offPeak:null,unpaidEnergy:null}]});
 await f.stop();await f.start();assert.deepEqual(await get(),cleared);assert.equal(cleared.utility[month].unpaidEnergy,null);assert.equal(utilityTotal(...['onPeak','offPeak','unpaidEnergy'].map(k=>cleared.utility[month][k])),null);
 assert.deepEqual(protect(),protectedBefore);assert.deepEqual(cleared.projections,before.projections);assert.deepEqual(cleared.configuration,before.configuration);
 writeFileSync(join(f.directory,'verified-unpaid-http.json'),JSON.stringify({before,saved,exact,cleared,rejected,protectedBefore,protectedAfter:protect()},null,2));console.log('Unpaid authenticated HTTP evidence:',f.directory);
});
