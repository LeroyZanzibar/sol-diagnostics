import {seedMeasuredPoa} from './monthly-poa-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {LocalDatabase,LocalBucket} from '../../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';
import {MonthlyService} from '../../selfhost/monthly-rollups.mjs';
import {MonthlyStore} from '../../selfhost/monthly-store.mjs';
import {emptyConfiguration} from '../../app/monthly-domain.mjs';
function seed(db,site,quantity){
 db.sqlite.prepare('INSERT INTO site_settings(id,name,array_model_verified) VALUES (?,?,0)').run(site,'Synthetic '+site);
 const insert=db.sqlite.prepare('INSERT INTO equipment_assets(id,site_id,type,name,external_id,parent_id,module_rated_capacity_w,quantity) VALUES(?,?,?,?,?,?,?,?)');
 for(const [id,type,parent,watts,q] of [['meter','revenue_meter',null,'',1],['inv','inverter','meter','',1],['mod','module_group','inv','4e2',quantity]])insert.run(site+'-'+id,site,type,id,id,parent?site+'-'+parent:null,watts,q);
}
const readings=()=>[0,1].flatMap(hour=>['expected','insolation','actual'].map(kind=>({timestamp:`2026-01-01T0${hour}:00:00.000Z`,channel:{id:kind,equipmentId:kind==='expected'?'@site':kind==='actual'?'site-meter':'weather',measurement:kind==='expected'?'Expected Production':kind==='actual'?'Energy':'Irradiance',unit:kind==='insolation'?'W/m²':'kWh'},value:kind==='expected'?5000:kind==='insolation'?500:1})));

test('native saved read-time metrics: site isolation, utility/model/config edits, stale fencing, reopen and no input rewrites',async t=>{
 const root=mkdtempSync(join(tmpdir(),'monthly-calculated-')),path=join(root,'shared.sqlite');
 let db,manager,service;
 function open(){db=new LocalDatabase(path,resolve('drizzle'));manager=new PerformanceStoreManager(join(root,'performance'));service=new MonthlyService({database:db,bucket:new LocalBucket(db,join(root,'objects')),performance:manager});}
 async function close(){await service.stop();manager.close();db.close();}
 open();t.after(close);seed(db,'site',300);seed(db,'other',600);
 const config={...emptyConfiguration(),operationsStart:'2026-01-01',degradation:'0'};config.baselines[1]={production:'12000',revenue:'1000',insolation:'150'};
 const utility={month:'2026-01',onPeak:'8000.0000',offPeak:'4000.000000000000001',unpaidEnergy:null,revenue:'1200',energyUsed:'0',invoiceCost:'-0.01'};
 for(const site of ['site','other']){
  const p=service.inputs.preview(site,0,config);service.inputs.saveConfiguration(site,0,config,p.token);service.inputs.saveUtility(site,1,[utility]);
  await seedMeasuredPoa({database:db,bucket:service.bucket,performance:manager,root,siteId:site,samples:[0,1].map(hour=>({timestamp:`2026-01-01T0${hour}:00:00.000Z`,poa:500,satellite:500,expected:5000}))});
 }
 // A convenient exact ordinary total, followed by a precise edit later.
 service.inputs.saveUtility('site',2,[{...utility,offPeak:'4000.0000'}]);
 let current=await service.read('site');const other=await service.read('other');
 assert.deepEqual(current.capacity,{dcKwp:{n:'120',d:'1'},unavailableReason:null});assert.deepEqual(other.capacity.dcKwp,{n:'240',d:'1'});
 const expected={budgetedSpecificYield:['100','1'],actualSpecificYield:['100','1'],specificYieldRatio:['1','1'],budgetedPerformanceRatio:['2','3'],actualPerformanceRatio:['100','1'],performanceRatioRatio:['150','1'],insolationRatio:['1','150'],productionProjectionRatio:['1','1'],productionExpectedRatio:['6','5'],revenueRatio:['6','5'],iapr:['150','1'],iar:['180','1']};
 for(const [key,[n,d]] of Object.entries(expected))assert.deepEqual(current.calculated['2026-01'][key].value,{n,d},key);
 for(const key of ['actualPerformanceRatio','performanceRatioRatio','insolationRatio','productionExpectedRatio','iapr','iar'])assert.equal(current.calculated['2026-01'][key].state,'partial');
 const protectedTables=['analysis_runs','issue_event_reviews','performance_summaries','analysis_jobs'];
 const retained=()=>Object.fromEntries(protectedTables.map(table=>[table,db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(r=>({...r}))]));
 const before=retained(),rollup=db.sqlite.prepare('SELECT * FROM monthly_rollups WHERE site_id=?').get('site'),rawConfig=db.sqlite.prepare('SELECT configuration_json FROM monthly_configuration WHERE site_id=?').get('site').configuration_json;
 const rows=Array.from(manager.site('site').rows(1));
 db.sqlite.prepare('UPDATE equipment_assets SET quantity=600 WHERE id=?').run('site-mod');
 current=await service.read('site');assert.deepEqual(current.capacity.dcKwp,{n:'240',d:'1'});assert.deepEqual(current.calculated['2026-01'].actualSpecificYield.value,{n:'50',d:'1'});
 assert.deepEqual(current.calculated['2026-01'].iapr.value,{n:'150',d:'1'});assert.equal(current.telemetry.sourceRevision,1);assert.equal(current.revision,3);
 assert.deepEqual(await service.read('other'),other,'capacity changes stay scoped to the exact site');
 assert.deepEqual(db.sqlite.prepare('SELECT * FROM monthly_rollups WHERE site_id=?').get('site'),rollup,'calculated columns are not baked into cached telemetry');
 service.inputs.saveUtility('site',3,[utility]);current=await service.read('site');assert.deepEqual(current.utility['2026-01'],Object.fromEntries(Object.entries(utility).filter(([k])=>k!=='month')));
 assert.deepEqual(current.calculated['2026-01'].actualSpecificYield.value,{n:'12000000000000000001',d:'240000000000000000'});
 const changed={...config,baselines:{...config.baselines,1:{...config.baselines[1],production:'24000'}}};const preview=service.inputs.preview('site',4,changed);service.inputs.saveConfiguration('site',4,changed,preview.token);
 current=await service.read('site');assert.deepEqual(current.calculated['2026-01'].budgetedSpecificYield.value,{n:'100',d:'1'});assert.equal(current.telemetry.sourceRevision,1);
 assert.equal(JSON.parse(rawConfig).baselines[1].production,'12000');assert.deepEqual(Array.from(manager.site('site').rows(1)),rows);assert.deepEqual(retained(),before);
 const saved=structuredClone(current);await close();open();current=await service.read('site');assert.deepEqual(current,saved,'restart derives the same exact metrics from retained inputs');
 db.sqlite.prepare('UPDATE equipment_assets SET module_rated_capacity_w=? WHERE id=?').run('','site-mod');
 current=await service.read('site');assert.equal(current.capacity.dcKwp,null);assert.equal(current.calculated['2026-01'].actualSpecificYield.value,null);assert.equal(current.calculated['2026-01'].iapr.state,'partial');
 // Exercise the actual service head fence with otherwise numerically present data.
 const refresh=service.refresh.bind(service);service.refresh=async()=>({...await refresh('site'),sourceRevision:0});
 current=await service.read('site');assert.equal(current.telemetry.state,'refreshing');assert.equal(current.calculated['2026-01'].iapr.value,null);assert.match(current.calculated['2026-01'].iapr.reason,/refreshing/i);assert.equal(current.calculated['2026-01'].revenueRatio.state,'available');
 assert.deepEqual(retained(),before);assert.deepEqual(Array.from(manager.site('site').rows(1)),rows);
});

test('capacity and monthly inputs share one synchronous SQLite snapshot across a competing saved edit',t=>{
 const root=mkdtempSync(join(tmpdir(),'monthly-capacity-snapshot-')),path=join(root,'shared.sqlite'),db=new LocalDatabase(path,resolve('drizzle')),writer=new DatabaseSync(path);
 t.after(()=>{writer.close();db.close();});seed(db,'site',300);
 const store=new MonthlyStore(db);store.saveUtility('site',0,[{month:'2026-01',onPeak:'10',offPeak:null,unpaidEnergy:null,revenue:null,energyUsed:null,invoiceCost:null}]);
 let changed=false,reads=0;
 const observed=new MonthlyStore({withSynchronousRead:callback=>{reads++;return db.withSynchronousRead(read=>callback({
  first(sql,...args){const row=read.first(sql,...args);if(sql.includes('monthly_configuration')&&!changed){changed=true;assert.throws(()=>writer.exec("UPDATE equipment_assets SET quantity=600 WHERE id='site-mod'"),/locked/);}return row;},
  all:(...args)=>read.all(...args)
 }));}});
 const before=observed.read('site');assert.equal(reads,1);assert.equal(before.utility['2026-01'].onPeak,'10');assert.deepEqual(before.capacity.dcKwp,{n:'120',d:'1'});
 writer.exec("BEGIN IMMEDIATE; UPDATE equipment_assets SET quantity=600 WHERE id='site-mod'; UPDATE monthly_utility SET on_peak='20' WHERE site_id='site'; COMMIT;");
 const after=store.read('site');assert.equal(after.utility['2026-01'].onPeak,'20');assert.deepEqual(after.capacity.dcKwp,{n:'240',d:'1'});
});
