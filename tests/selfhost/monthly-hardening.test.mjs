import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {LocalDatabase,LocalBucket} from '../../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';
import {MonthlyService,monthBounds} from '../../selfhost/monthly-rollups.mjs';
import {formatValue} from '../../app/monthly-domain.mjs';
const expected={id:'["@site","Expected Production",null]',equipmentId:'@site',measurement:'Expected Production',unit:'kWh'};
const irradiance={id:'["weather","Irradiance",null]',equipmentId:'weather',measurement:'Irradiance',unit:'W/m²'};
function fixture(t){const root=mkdtempSync(join(tmpdir(),'monthly-hardening-')),db=new LocalDatabase(join(root,'shared.sqlite'),resolve('drizzle')),performance=new PerformanceStoreManager(join(root,'performance'));db.sqlite.exec("INSERT INTO site_settings(id,name) VALUES('site','Synthetic')");const options={database:db,bucket:new LocalBucket(db,join(root,'objects')),performance},service=new MonthlyService(options);t.after(async()=>{await service.stop();performance.close();db.close();});return {root,db,performance,options,service,store:performance.site('site')};}
async function commit(store,rows,timezone='UTC'){const p=await store.stage({source:'csv',fileName:'Synthetic.csv',timezone,intervalMinutes:60,modelRevision:'synthetic'},rows);return store.commit(p.stageId,{previewToken:p.previewToken,approveOverlap:true,modelRevision:'synthetic',actor:'synthetic'});}
test('old in-flight calculation cannot overwrite a corrected generation from another consumer',async t=>{
 const {db,store,service,options}=fixture(t),timestamp='2024-03-01T00:00:00.000Z';await commit(store,[{timestamp,channel:expected,value:1}]);
 let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r),original=service.calculate.bind(service);
 service.calculate=async(...args)=>{const result=await original(...args);entered();await gate;return result;};
 const pending=service.refresh('site');await ready;
 try{await commit(store,[{timestamp,channel:expected,value:2}]);const newer=new MonthlyService(options);const result=await newer.read('site');assert.equal(result.telemetry.sourceRevision,2);assert.equal(formatValue(result.telemetry.months['2024-03'].expected.value),'2');await newer.stop();}
 finally{release();}
 assert.equal((await pending).state,'refreshing');
 const saved=db.sqlite.prepare('SELECT source_revision,payload_json FROM monthly_rollups WHERE site_id=?').get('site');assert.equal(saved.source_revision,2);assert.equal(formatValue(JSON.parse(saved.payload_json).months['2024-03'].expected.value),'2');
 service.calculate=original;assert.equal((await service.read('site')).telemetry.state,'current');
});
test('pinned local calendar splits crossing intervals, explicit zero, channel-specific coverage and missingness',async t=>{
 const {store,service}=fixture(t);const timestamp='2024-03-31T18:00:00.000Z';
 await commit(store,[{timestamp,channel:expected,value:12},{timestamp,channel:irradiance,value:600},{timestamp:'2024-03-31T19:00:00.000Z',channel:expected,value:0}], 'Asia/Kolkata');
 // Later source timezone is not the reporting timezone.
 await commit(store,[{timestamp:'2024-03-31T20:00:00.000Z',channel:irradiance,value:null}], 'America/New_York');
 const result=await service.read('site');assert.equal(result.telemetry.timezone,'Asia/Kolkata');
 const march=result.telemetry.months['2024-03'],april=result.telemetry.months['2024-04'];assert.equal(formatValue(march.expected.value),'6');assert.equal(formatValue(april.expected.value),'6');assert.equal(formatValue(march.insolation.value,2),'0.30');assert.equal(formatValue(april.insolation.value,2),'0.30');
 assert.equal(april.expected.coveredMilliseconds,5400000);assert.equal(april.insolation.coveredMilliseconds,1800000);assert.equal(april.expected.state,'partial');assert.equal(april.insolation.state,'partial');
 assert.equal(result.telemetry.months['2024-05'],undefined);
});
test('fall-back month counts both repeated local hours as distinct UTC intervals',async t=>{
 const {store,service}=fixture(t),bounds=monthBounds('2024-11','America/New_York'),rows=[];
 for(let at=bounds.start;at<bounds.end;at+=3600000)rows.push({timestamp:new Date(at).toISOString(),channel:expected,value:1});
 await commit(store,rows,'America/New_York');const month=(await service.read('site')).telemetry.months['2024-11'];
 assert.equal(formatValue(month.expected.value),'721');assert.equal(month.expected.state,'complete');assert.equal(month.insolation.state,'missing');assert.equal(month.insolation.value,null);
});
test('genuine chronological upgrade retains prior ledger, user settings and maintenance metadata',()=>{
 const root=mkdtempSync(join(tmpdir(),'monthly-upgrade-')),old=join(root,'migrations');mkdirSync(old);
 const inventory=readdirSync(resolve('drizzle')).filter(f=>/^\d+.*\.sql$/.test(f)).sort();for(const name of inventory.filter(n=>n<'0021'))copyFileSync(resolve('drizzle',name),join(old,name));
 const path=join(root,'shared.sqlite');let db=new LocalDatabase(path,old);
 db.sqlite.exec("INSERT INTO site_settings(id,name,expected_production_notes) VALUES ('site','Retained synthetic site','Keep assumptions'); INSERT INTO maintenance_tasks VALUES ('synthetic-task','deleting','2024-01-01');");
 const ledger=db.sqlite.prepare('SELECT * FROM __sol_migrations ORDER BY name').all(),site=db.sqlite.prepare('SELECT * FROM site_settings').get(),tasks=db.sqlite.prepare('SELECT * FROM maintenance_tasks').all();db.close();
 for(let reopen=0;reopen<2;reopen++){db=new LocalDatabase(path,resolve('drizzle'));assert.deepEqual(db.sqlite.prepare('SELECT * FROM site_settings').get(),site);assert.deepEqual(db.sqlite.prepare('SELECT * FROM maintenance_tasks').all(),tasks);const current=db.sqlite.prepare('SELECT * FROM __sol_migrations ORDER BY name').all();assert.deepEqual(current.slice(0,ledger.length),ledger);assert.deepEqual(current.map(x=>x.name),inventory);assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM monthly_utility').get().n,0);db.close();}
});
