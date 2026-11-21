import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {monthlyFixture} from './monthly-fixture.mjs';
import {LocalDatabase,LocalBucket} from '../../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';
import {emptyConfiguration} from '../../app/monthly-domain.mjs';
const oracle=JSON.parse(readFileSync(new URL('../monthly-calculated-oracle.json',import.meta.url),'utf8'));
const expected=oracle.cases.find(c=>c.name==='partial-telemetry');

// Requires current production output. The parent release task runs this after build.
test('built HTTP calculated metrics: saved scientific DC ratings, exact inputs, import, site isolation, read-time edits and restart',{timeout:180000},async t=>{
 const f=await monthlyFixture(t),key='analysis/monthly-calculated-retained.json',bytes='{"synthetic":"retained outage result","unchanged":true}';
 const db=new LocalDatabase(join(f.directory,'sol-diagnostics.sqlite'),resolve('drizzle'));
 try{
  db.sqlite.prepare('INSERT INTO analysis_runs(id,site_id,import_id,parser_version,model_revision,analysis_object_key) VALUES(?,?,?,?,?,?)').run('metric-retained-run',f.siteId,'metric-retained-import',28,'retained-model',key);
  db.sqlite.prepare('INSERT INTO issue_event_reviews(id,site_id,event_key,version,state,updated_at) VALUES(?,?,?,?,?,?)').run('metric-retained-review',f.siteId,'retained-event',1,'{"status":"confirmed"}','2026-01-02');
  db.sqlite.prepare('INSERT INTO performance_summaries VALUES(?,?,?,?)').run('metric-retained-import',f.siteId,JSON.stringify({objectKey:key}),'2026-01-02');
  await new LocalBucket(db,join(f.directory,'objects')).put(key,bytes);
 }finally{db.close();}
 const protectedState=()=>f.inspect(shared=>Object.fromEntries(['analysis_runs','issue_event_reviews','performance_summaries','analysis_jobs'].map(table=>[table,shared.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
 const protectedBefore=protectedState();await f.start();
 const get=(site=f.siteId)=>f.request(`/api/monthly-data?siteId=${encodeURIComponent(site)}`);
 const post=(site,body)=>f.request('/api/monthly-data',{siteId:site,...body});
 async function saveConfiguration(site,configuration){const current=await get(site),preview=await post(site,{action:'preview',revision:current.revision,configuration});await post(site,{action:'configuration',revision:current.revision,configuration,previewToken:preview.token});const saved=await get(site);assert.deepEqual(saved.configuration,configuration);return saved;}
 async function saveModel(site,equipment){
  const response=await fetch(f.base+'/api/equipment',{method:'PUT',headers:{Authorization:f.authorization,'Content-Type':'application/json'},body:JSON.stringify({siteId:site,equipment,verified:false}),signal:AbortSignal.timeout(15000)});
  const text=await response.text();assert.equal(response.status,200,text);const saved=JSON.parse(text),readback=await f.request(`/api/equipment?siteId=${encodeURIComponent(site)}`);
  assert.deepEqual(readback.equipment,saved.equipment);assert.equal(readback.verified,false);return readback.equipment;
 }
 let equipment=(await f.request(`/api/equipment?siteId=${f.siteId}`)).equipment.map(a=>a.type==='module_group'?{...a,moduleRatedCapacityW:'4.000e2',quantity:150}:a);
 equipment=await saveModel(f.siteId,equipment);
 assert.ok(equipment.filter(a=>a.type==='module_group').every(a=>a.moduleRatedCapacityW==='4.000e2'));
 const other=(await f.request('/api/site-settings',{name:'Synthetic independent monthly site',country:'US',latitude:'35.2',longitude:'-80.8'},201)).site.id;
 const otherEquipment=equipment.map(a=>({...a,id:'other-'+a.id,siteId:other,parentId:a.parentId?'other-'+a.parentId:null,...(a.type==='module_group'?{moduleRatedCapacityW:'500',quantity:300}:{})}));
 await saveModel(other,otherEquipment);
 const config={...emptyConfiguration(),operationsStart:'2026-01-01',degradation:'0'};config.baselines[1]={production:'12000',revenue:'1000',insolation:'150'};
 const raw={onPeak:'8000.0000',offPeak:'4000.000000000000000',unpaidEnergy:null,revenue:'1200.000000000000000',energyUsed:'0',invoiceCost:'-0.00000000000000001'};
 for(const site of [f.siteId,other]){await saveConfiguration(site,config);await post(site,{action:'utility',revision:1,rows:[{month:'2026-01',...raw}]});assert.deepEqual((await get(site)).utility['2026-01'],raw);}
 const beforeImport=await get(),otherBefore=await get(other),savedModel=await f.request(`/api/equipment?siteId=${f.siteId}`);
 assert.deepEqual(beforeImport.capacity,expected.capacity?{dcKwp:expected.capacity,unavailableReason:null}:null);assert.deepEqual(otherBefore.capacity.dcKwp,{n:'300',d:'1'});
 const readings=[0,1].flatMap(hour=>{const timestamp=`2026-01-01T0${hour}:00:00Z`;return [
  {timestamp,equipmentId:'@site',measurement:'Expected Production',channelId:'forecast',unit:'kWh',value:5000},
  {timestamp,equipmentId:'weather',measurement:'Irradiance',unit:'W/m²',value:500},
  {timestamp,equipmentId:'meter',measurement:'Energy',unit:'kWh',value:1}
 ];});
 await f.commit(readings);let current=await get();
 assert.deepEqual(current.utility,beforeImport.utility);assert.deepEqual(current.configuration,beforeImport.configuration);assert.equal(current.telemetry.sourceRevision,1);
 assert.deepEqual(Object.keys(current.calculated['2026-01']),oracle.keys);
 for(const field of oracle.keys)assert.deepEqual(current.calculated['2026-01'][field].value,expected.values[field],field);
 for(const field of ['actualPerformanceRatio','performanceRatioRatio','insolationRatio','productionExpectedRatio','iapr','iar']){assert.equal(current.calculated['2026-01'][field].state,'partial');assert.match(current.calculated['2026-01'][field].reason,/partial/);}
 assert.equal(current.calculated['2026-01'].actualSpecificYield.state,'available');assert.deepEqual(current.calculated['2026-01'].actualSpecificYield.value,{n:'100',d:'1'},'actual yield uses utility total, not imported meter energy');
 assert.match(current.telemetry.months['2026-01'].insolation.source,/provenance unknown/);
 assert.deepEqual(await get(other),otherBefore);assert.deepEqual(await f.request(`/api/equipment?siteId=${f.siteId}`),savedModel);
 const imported=await f.request(`/api/performance-data?siteId=${f.siteId}`);
 const cached=f.inspect(shared=>shared.prepare('SELECT * FROM monthly_rollups WHERE site_id=?').get(f.siteId));
 const exactSaved=structuredClone(current);
 // Save the same accepted values, rather than any formatted display string.
 await post(f.siteId,{action:'utility',revision:current.revision,rows:[{month:'2026-01',...raw}]});
 current=await get();assert.deepEqual(current.utility,exactSaved.utility);assert.deepEqual(current.calculated,exactSaved.calculated);
 // Combined regression: only unpaid changes, but every production metric must
 // change exactly. Python Fraction expectations never call application math.
 const controls=['budgetedSpecificYield','budgetedPerformanceRatio','insolationRatio','revenueRatio','iar'];
 const productionFields=oracle.keys.filter(field=>!controls.includes(field));
 let combinedBefore,combinedAfter;
 for(const name of ['combined-http-before','combined-http-after']){
  const c=oracle.combinedCases.find(c=>c.name===name),prior=structuredClone(current),values={...raw,unpaidEnergy:c.utility.unpaidEnergy};
  const saved=await post(f.siteId,{action:'utility',revision:current.revision,rows:[{month:'2026-01',...values}]});
  current=await get();assert.deepEqual(current,saved);assert.deepEqual(current.utility['2026-01'],values);
  assert.equal(current.revision,prior.revision+1);assert.deepEqual(current.configuration,prior.configuration);assert.deepEqual(current.projections,prior.projections);assert.deepEqual(current.capacity,prior.capacity);assert.deepEqual(current.telemetry,prior.telemetry);
  for(const field of oracle.keys){assert.deepEqual(current.calculated['2026-01'][field].value,c.values[field],`${name} ${field}`);assert.equal(current.calculated['2026-01'][field].state,prior.calculated['2026-01'][field].state);assert.equal(current.calculated['2026-01'][field].reason,prior.calculated['2026-01'][field].reason);}
  for(const field of controls)assert.deepEqual(current.calculated['2026-01'][field],prior.calculated['2026-01'][field],field+' control');
  for(const field of productionFields)assert.notDeepEqual(current.calculated['2026-01'][field].value,prior.calculated['2026-01'][field].value,field+' must include unpaid');
  for(const month of Object.keys(current.calculated).filter(m=>m!=='2026-01'))assert.deepEqual(current.calculated[month],prior.calculated[month]);
  assert.deepEqual({...f.inspect(shared=>shared.prepare('SELECT unpaid_energy,typeof(unpaid_energy) type FROM monthly_utility WHERE site_id=? AND month=?').get(f.siteId,'2026-01'))},{unpaid_energy:values.unpaidEnergy,type:'text'});
  assert.deepEqual(await get(other),otherBefore);assert.deepEqual(protectedState(),protectedBefore);
  assert.deepEqual(f.inspect(shared=>shared.prepare('SELECT * FROM monthly_rollups WHERE site_id=?').get(f.siteId)),cached);
  assert.deepEqual(await f.request(`/api/performance-data?siteId=${f.siteId}`),imported);
  if(name==='combined-http-before')combinedBefore=structuredClone(current);else combinedAfter=structuredClone(current);
 }
 // Full-row omission must reject rather than erase a saved unpaid value; CAS
 // still rejects an otherwise valid stale edit without affecting metrics.
 const {unpaidEnergy:omitted,...missingUnpaid}=current.utility['2026-01'];assert.ok(omitted);
 await f.request('/api/monthly-data',{siteId:f.siteId,action:'utility',revision:current.revision,rows:[{month:'2026-01',...missingUnpaid}]},400);
 await f.request('/api/monthly-data',{siteId:f.siteId,action:'utility',revision:current.revision-1,rows:[{month:'2026-01',...current.utility['2026-01'],unpaidEnergy:'0'}]},409);
 assert.deepEqual(await get(),combinedAfter);
 await f.stop();await f.start();current=await get();assert.deepEqual(current,combinedAfter,'populated unpaid and all twelve metrics survive restart');assert.deepEqual(await get(other),otherBefore);
 assert.deepEqual(await f.request(`/api/performance-data?siteId=${f.siteId}`),imported);assert.deepEqual(protectedState(),protectedBefore);
 // Restore the original control row and retain every preexisting model/config
 // edit assertion below rather than replacing those cases with the new case.
 await post(f.siteId,{action:'utility',revision:current.revision,rows:[{month:'2026-01',...raw}]});current=await get();assert.deepEqual(current.calculated,exactSaved.calculated);assert.deepEqual(current.utility,exactSaved.utility);
 // Model-only change: no reimport, analysis, AC-capacity readiness or rollup rewrite.
 equipment=await saveModel(f.siteId,equipment.map(a=>({...a,acRatedCapacityKw:'',maxDcCapacityKw:'',nameplateKva:'',acLineLossPercent:'',transformerLossPercent:'',...(a.type==='module_group'?{quantity:300}:{})})));
 current=await get();assert.deepEqual(current.capacity.dcKwp,{n:'240',d:'1'});assert.deepEqual(current.calculated['2026-01'].actualSpecificYield.value,{n:'50',d:'1'});assert.deepEqual(current.calculated['2026-01'].iapr.value,expected.values.iapr);assert.equal(current.telemetry.sourceRevision,1);
 assert.deepEqual(f.inspect(shared=>shared.prepare('SELECT * FROM monthly_rollups WHERE site_id=?').get(f.siteId)),cached);
 assert.deepEqual((await f.request(`/api/performance-data?siteId=${f.siteId}`)).dataset,imported.dataset);
 assert.deepEqual(await get(other),otherBefore);
 // Config and utility edits also recompute immediately at the same telemetry revision.
 const changed={...config,baselines:{...config.baselines,1:{...config.baselines[1],production:'24000'}}};
 current=await saveConfiguration(f.siteId,changed);assert.deepEqual(current.calculated['2026-01'].budgetedSpecificYield.value,{n:'100',d:'1'});
 const precise={...raw,onPeak:'123.1234567890123456',offPeak:'0.000000000000000001',revenue:'-0.12345678901234567'};
 await post(f.siteId,{action:'utility',revision:current.revision,rows:[{month:'2026-01',...precise}]});current=await get();assert.deepEqual(current.utility['2026-01'],precise);assert.equal(current.telemetry.sourceRevision,1);assert.ok(current.calculated['2026-01'].revenueRatio.value.n.startsWith('-'));
 const beforeRestart=structuredClone(current);await f.stop();await f.start();current=await get();assert.deepEqual(current,beforeRestart);
 assert.deepEqual(await get(other),otherBefore);assert.deepEqual(protectedState(),protectedBefore);
 // Incomplete connected group must not silently return the remaining group's DC total.
 await saveModel(f.siteId,equipment.map(a=>a.id==='modules1'?{...a,moduleRatedCapacityW:''}:a));
 current=await get();assert.equal(current.capacity.dcKwp,null);assert.equal(current.calculated['2026-01'].actualSpecificYield.value,null);assert.match(current.calculated['2026-01'].actualSpecificYield.reason,/DC capacity/);assert.equal(current.calculated['2026-01'].iapr.state,'partial');
 assert.deepEqual(current.utility,beforeRestart.utility);assert.deepEqual(current.telemetry,beforeRestart.telemetry);assert.deepEqual(protectedState(),protectedBefore);
 await f.stop();const reopened=new LocalDatabase(join(f.directory,'sol-diagnostics.sqlite'),resolve('drizzle')),performance=new PerformanceStoreManager(join(f.directory,'performance'));
 try{assert.equal(await(await new LocalBucket(reopened,join(f.directory,'objects')).get(key)).text(),bytes);const rows=Array.from(performance.site(f.siteId).rows(1));assert.equal(rows.length,6);assert.deepEqual(rows.filter(r=>r.channel.equipmentId==='meter').map(r=>r.value),[1,1]);assert.equal(performance.site(f.siteId).describe().revision,1);}finally{performance.close();reopened.close();}
 writeFileSync(join(f.directory,'verified-calculated-metrics.json'),JSON.stringify({exactSaved,combinedBefore,combinedAfter,beforeRestart,final:current,otherBefore,retainedResultsUnchanged:true},null,2));
 console.log('Calculated metrics HTTP evidence:',f.directory);
});
