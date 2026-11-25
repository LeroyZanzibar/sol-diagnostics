import {seedMeasuredPoa} from './monthly-poa-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {LocalDatabase,LocalBucket} from '../../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';
import {MonthlyService} from '../../selfhost/monthly-rollups.mjs';
import {emptyConfiguration} from '../../app/monthly-domain.mjs';
const oracle=JSON.parse(readFileSync(new URL('../monthly-calculated-oracle.json',import.meta.url),'utf8'));
const controls=['budgetedSpecificYield','budgetedPerformanceRatio','insolationRatio','revenueRatio','iar'];
const partialFields=['actualPerformanceRatio','performanceRatioRatio','insolationRatio','productionExpectedRatio','iapr','iar'];

test('native combined save/read/reopen: unpaid-only edit changes seven exact metrics, not five controls or retained data',async t=>{
 const root=mkdtempSync(join(tmpdir(),'monthly-combined-')),path=join(root,'shared.sqlite');
 let db,manager,bucket,service;
 function open(){db=new LocalDatabase(path,resolve('drizzle'));manager=new PerformanceStoreManager(join(root,'performance'));bucket=new LocalBucket(db,join(root,'objects'));service=new MonthlyService({database:db,bucket,performance:manager});}
 async function close(){await service.stop();manager.close();db.close();}
 open();t.after(close);
 db.sqlite.exec("INSERT INTO site_settings(id,name) VALUES ('site','Synthetic combined'),('other','Synthetic control')");
 const insert=db.sqlite.prepare('INSERT INTO equipment_assets(id,site_id,type,name,external_id,parent_id,module_rated_capacity_w,quantity) VALUES(?,?,?,?,?,?,?,?)');
 for(const [id,type,parent,watts,quantity] of [['meter','revenue_meter',null,'',1],['inverter','inverter','meter','',1],['modules','module_group','inverter','400',300]])insert.run(id,'site',type,id,id,parent,watts,quantity);
 const config={...emptyConfiguration(),operationsStart:'2026-01-01',degradation:'0'};config.baselines[1]={production:'12000',revenue:'1000',insolation:'150'};
 for(const site of ['site','other']){const preview=service.inputs.preview(site,0,config);service.inputs.saveConfiguration(site,0,config,preview.token);}
 const beforeCase=oracle.combinedCases.find(c=>c.name==='combined-http-before'),afterCase=oracle.combinedCases.find(c=>c.name==='combined-http-after');
 const month=beforeCase.month;
 service.inputs.saveUtility('site',1,[{month,...beforeCase.utility,unpaidEnergy:null}]);
 service.inputs.saveUtility('other',1,[{month,...beforeCase.utility,unpaidEnergy:'000.01230'}]);
 const store=manager.site('site');
 await seedMeasuredPoa({database:db,bucket,performance:manager,root,samples:[0,1].map(hour=>({timestamp:`2026-01-01T0${hour}:00:00.000Z`,poa:500,satellite:900,expected:5000}))});
 const key='analysis/combined-retained.json',bytes='{"synthetic":"retained outage result, not reanalysed"}';
 db.sqlite.prepare('INSERT INTO analysis_runs(id,site_id,import_id,parser_version,model_revision,analysis_object_key) VALUES(?,?,?,?,?,?)').run('retained-run','site','retained-import',28,'retained-model',key);
 db.sqlite.prepare('INSERT INTO issue_event_reviews(id,site_id,event_key,version,state,updated_at) VALUES(?,?,?,?,?,?)').run('retained-review','site','retained-event',1,'{"status":"confirmed"}','2026-01-02');
 db.sqlite.prepare('INSERT INTO performance_summaries VALUES(?,?,?,?)').run('retained-import','site',JSON.stringify({objectKey:key}),'2026-01-02');await bucket.put(key,bytes);
 let current=await service.read('site');const other=await service.read('other');
 const retained=()=>Object.fromEntries(['analysis_runs','issue_event_reviews','performance_summaries','analysis_jobs','equipment_assets','monthly_rollups'].map(table=>[table,db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(r=>({...r}))]));
 const protectedBefore=retained(),canonical=Array.from(store.rows(1)),head=store.describe();
 const snapshots=[];
 for(const c of [beforeCase,afterCase]){
  const prior=structuredClone(current);service.inputs.saveUtility('site',current.revision,[{month,...c.utility}]);current=await service.read('site');
  assert.equal(current.revision,prior.revision+1);assert.deepEqual(current.utility[month],c.utility);assert.deepEqual(current.configuration,prior.configuration);assert.deepEqual(current.projections,prior.projections);assert.deepEqual(current.capacity,prior.capacity);assert.deepEqual(current.telemetry,prior.telemetry);
  assert.deepEqual(Object.keys(current.calculated[month]),oracle.keys);
  for(const field of oracle.keys){assert.deepEqual(current.calculated[month][field].value,c.values[field],`${c.name} ${field}`);assert.equal(current.calculated[month][field].state,partialFields.includes(field)?'partial':'available');assert.equal(current.calculated[month][field].reason,prior.calculated[month][field].reason);}
  for(const field of controls)assert.deepEqual(current.calculated[month][field],prior.calculated[month][field],field);
  for(const field of oracle.keys.filter(k=>!controls.includes(k)))assert.notDeepEqual(current.calculated[month][field].value,prior.calculated[month][field].value,field);
  for(const m of Object.keys(current.calculated).filter(m=>m!==month))assert.deepEqual(current.calculated[m],prior.calculated[m]);
  assert.deepEqual({...db.sqlite.prepare('SELECT unpaid_energy,typeof(unpaid_energy) type FROM monthly_utility WHERE site_id=? AND month=?').get('site',month)},{unpaid_energy:c.utility.unpaidEnergy,type:'text'});
  assert.deepEqual(await service.read('other'),other);assert.deepEqual(retained(),protectedBefore);assert.deepEqual(Array.from(manager.site('site').rows(1)),canonical);assert.deepEqual(manager.site('site').describe(),head);assert.equal(await(await bucket.get(key)).text(),bytes);
  snapshots.push(structuredClone(current));
 }
 const {unpaidEnergy:omitted,...missing}=afterCase.utility;assert.ok(omitted);
 assert.throws(()=>service.inputs.saveUtility('site',current.revision,[{month,...missing}]),{status:400});
 assert.throws(()=>service.inputs.saveUtility('site',current.revision-1,[{month,...afterCase.utility,unpaidEnergy:'0'}]),{status:409});assert.deepEqual(await service.read('site'),current);
 service.inputs.saveUtility('site',current.revision,[{month,...afterCase.utility}]);const unchanged=await service.read('site');assert.deepEqual(unchanged.utility,current.utility);assert.deepEqual(unchanged.calculated,current.calculated);current=unchanged;
 await close();open();assert.deepEqual(await service.read('site'),current);assert.deepEqual(await service.read('other'),other);assert.deepEqual(retained(),protectedBefore);assert.deepEqual(Array.from(manager.site('site').rows(1)),canonical);assert.deepEqual(manager.site('site').describe(),head);assert.equal(await(await bucket.get(key)).text(),bytes);
 writeFileSync(join(root,'verified-combined.json'),JSON.stringify({snapshots,afterReopen:current,other,retainedDataUnchanged:true},null,2));console.log('Native combined evidence:',root);
});
