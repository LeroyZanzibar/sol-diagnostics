import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {LocalDatabase} from '../../selfhost/storage.mjs';
import {MonthlyStore} from '../../selfhost/monthly-store.mjs';
import {emptyConfiguration,projectionRows} from '../../app/monthly-domain.mjs';
test('production migration, atomic edit-set CAS, exact reopen/readback, impact and retained actuals',()=>{
 const root=mkdtempSync(join(tmpdir(),'sol-monthly-')),path=join(root,'shared.sqlite');let db=new LocalDatabase(path,resolve('drizzle'));
 db.sqlite.prepare('INSERT INTO site_settings(id,name) VALUES (?,?)').run('exact-Site','Synthetic');
 db.sqlite.prepare('INSERT INTO site_settings(id,name) VALUES (?,?)').run('other','Other');
 let store=new MonthlyStore(db);assert.equal(store.read('exact-Site').revision,0);
 assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM monthly_utility').get().n,0);
 const values={onPeak:'123.1234567890123456',offPeak:null,revenue:'-0.12345678901234567',energyUsed:'0',invoiceCost:'000.0100'};
 const saved=store.saveUtility('exact-Site',0,[{month:'2024-03',...values}]);assert.deepEqual(saved.utility['2024-03'],values);
 assert.throws(()=>store.saveUtility('exact-Site',0,[{month:'2024-04',...values}]),e=>e.status===409);
 assert.throws(()=>store.saveUtility('exact-Site',1,[{month:'2024-04',...values},{month:'2024-05',...values,onPeak:'1e3'}]),e=>e.status===400);
 assert.equal(store.read('exact-Site').utility['2024-04'],undefined);assert.deepEqual(store.read('other').utility,{});
 const config={...emptyConfiguration(),operationsStart:'2024-03-16',degradation:'0.123456789012345678'};
 const preview=store.preview('exact-Site',1,config);assert.ok(preview.token);assert.equal(preview.impact.length,300);
 assert.throws(()=>new MonthlyStore(db).saveConfiguration('exact-Site',1,config,preview.token),e=>e.status===409,'A restarted process requires a newly reviewed impact token');
 assert.equal(store.read('exact-Site').configuration.operationsStart,null);
 assert.throws(()=>store.saveConfiguration('exact-Site',1,{...config,degradation:'2'},preview.token),e=>e.status===409);
 store.saveConfiguration('exact-Site',1,config,preview.token);
 const moved={...config,operationsStart:'2030-01-01'};const next=store.preview('exact-Site',2,moved);store.saveConfiguration('exact-Site',2,moved,next.token);
 assert.deepEqual(store.read('exact-Site').utility['2024-03'],values);
 db.close();db=new LocalDatabase(path,resolve('drizzle'));store=new MonthlyStore(db);
 assert.equal(store.read('exact-Site').configuration.degradation,config.degradation);assert.deepEqual(store.read('exact-Site').utility['2024-03'],values);
 store.saveUtility('exact-Site',3,[{month:'2024-03',...values}]);assert.deepEqual(store.read('exact-Site').utility['2024-03'],values);
 assert.equal(db.sqlite.prepare("SELECT typeof(on_peak) t FROM monthly_utility").get().t,'text');
 const beforeFault=store.read('exact-Site');
 db.sqlite.exec("CREATE TRIGGER synthetic_monthly_failure BEFORE INSERT ON monthly_utility WHEN NEW.month='2024-06' BEGIN SELECT RAISE(ABORT,'synthetic transaction failure'); END");
 assert.throws(()=>store.saveUtility('exact-Site',beforeFault.revision,[{month:'2024-05',...values},{month:'2024-06',...values}]),/synthetic transaction failure/);
 assert.deepEqual(store.read('exact-Site'),beforeFault,'A real SQLite failure after the first write rolls back the entire edit set and revision');
 db.sqlite.exec('DROP TRIGGER synthetic_monthly_failure');db.close();
});
test('native save/reopen preserves absent rate, partial setup, exact zero and explicit clearing',t=>{
 const root=mkdtempSync(join(tmpdir(),'monthly-absence-')),path=join(root,'shared.sqlite');let db=new LocalDatabase(path,resolve('drizzle')),store=new MonthlyStore(db);t.after(()=>db.close());
 db.sqlite.exec("INSERT INTO site_settings(id,name) VALUES ('partial','Synthetic partial setup')");
 const fresh=store.read('partial');assert.equal(fresh.configuration.degradation,null);assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM monthly_configuration').get().n,0);
 const actual={month:'2024-03',onPeak:'123.1250',offPeak:null,revenue:'-5.75',energyUsed:'0',invoiceCost:null};
 store.saveUtility('partial',0,[actual]);
 function reopen(){db.close();db=new LocalDatabase(path,resolve('drizzle'));store=new MonthlyStore(db);return store.read('partial');}
 let current=reopen();assert.equal(current.configuration.degradation,null);
 function save(c){const p=store.preview('partial',current.revision,c);store.saveConfiguration('partial',current.revision,c,p.token);current=reopen();return current;}
 const c=structuredClone(current.configuration);c.baselines[3]={production:'3100.1250',revenue:null,insolation:'31.1250'};save(c);
 assert.equal(current.configuration.operationsStart,null);assert.equal(current.configuration.degradation,null);assert.equal(current.configuration.baselines[3].production,'3100.1250');
 save({...current.configuration,operationsStart:'2024-03-16'});assert.equal(projectionRows(current.configuration).length,300);assert.equal(projectionRows(current.configuration)[0].production,null);assert.ok(projectionRows(current.configuration)[0].insolation);
 for(const rate of ['0','000.000','0.123456789012345678','',null]){save({...current.configuration,degradation:rate});assert.equal(current.configuration.degradation,rate===''?null:rate);assert.equal(current.configuration.baselines[3].production,'3100.1250');assert.equal(current.utility['2024-03'].onPeak,actual.onPeak);}
 const raw=JSON.parse(db.sqlite.prepare('SELECT configuration_json FROM monthly_configuration WHERE site_id=?').get('partial').configuration_json);assert.equal(raw.degradation,null);
});
