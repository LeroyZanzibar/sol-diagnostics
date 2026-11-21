import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {LocalDatabase,LocalBucket} from '../../selfhost/storage.mjs';
import {MonthlyStore} from '../../selfhost/monthly-store.mjs';
import {emptyConfiguration} from '../../app/monthly-domain.mjs';

const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const quote=s=>'"'+s.replaceAll('"','""')+'"';
function typed(db,table){
 const columns=db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(c=>c.name);
 return db.prepare(`SELECT ${columns.flatMap(c=>[quote(c),`typeof(${quote(c)}) AS ${quote(c+'__type')}`]).join(',')} FROM ${quote(table)} ORDER BY rowid`).all().map(row=>({...row}));
}
test('unpaid upgrade from actual chronological 0021 schema preserves all typed rows and ledger, repeat reopen and fresh install',async()=>{
 const root=mkdtempSync(join(tmpdir(),'unpaid-upgrade-')),old=join(root,'through-0021');mkdirSync(old);
 const inventory=readdirSync(resolve('drizzle')).filter(n=>/^\d+.*\.sql$/.test(n)).sort(),prefix=inventory.filter(n=>n<'0022');
 assert.equal(prefix.at(-1).slice(0,4),'0021');assert.ok(inventory.includes('0022_unpaid_energy.sql'));
 const historicalFiles=[...prefix.map(n=>resolve('drizzle',n)),...readdirSync(resolve('drizzle/meta')).filter(n=>/^\d{4}_snapshot.json$/.test(n)&&n<'0022').map(n=>resolve('drizzle/meta',n))];
 const historicalHashes=Object.fromEntries(historicalFiles.map(p=>[p,hash(p)]));
 for(const name of prefix)copyFileSync(resolve('drizzle',name),join(old,name));
 const path=join(root,'shared.sqlite');let db=new LocalDatabase(path,old);
 try{
  assert.ok(!db.sqlite.prepare('PRAGMA table_info(monthly_utility)').all().some(c=>c.name==='unpaid_energy'));
  db.sqlite.exec("INSERT INTO site_settings(id,name,expected_production_notes) VALUES ('retained','Synthetic retained','unchanged assumptions'),('other','Other',''); INSERT INTO maintenance_tasks VALUES ('retained-task','deleting','2024-01-01');");
  const configuration={...emptyConfiguration(),operationsStart:'2024-03-16',degradation:'0.123456789012345678'};configuration.baselines[3]={production:'3100.1250',revenue:'310.50',insolation:'31.1250'};
  db.sqlite.prepare('INSERT INTO monthly_configuration VALUES (?,?,?,?)').run('retained',7,JSON.stringify(configuration),'2024-04-01');
  const insert=db.sqlite.prepare('INSERT INTO monthly_utility (site_id,month,on_peak,off_peak,revenue,energy_used,invoice_cost) VALUES (?,?,?,?,?,?,?)');
  insert.run('retained','2024-03','123.1234567890123456',null,'-12.3450','0','000.01230');
  insert.run('retained','2024-04',null,'999999999998.9999999',null,null,'0');
  insert.run('other','2020-01',null,null,null,null,null);
  db.sqlite.prepare('INSERT INTO monthly_rollups VALUES (?,?,?,?,?,?)').run('retained',9,'null',2,'{"retained":"telemetry bytes"}','2024-04-01');
  db.sqlite.prepare('INSERT INTO analysis_runs(id,site_id,import_id,parser_version,model_revision,analysis_object_key) VALUES (?,?,?,?,?,?)').run('retained-run','retained','retained-import',28,'retained-model','analysis/retained.json');
  db.sqlite.prepare('INSERT INTO issue_event_reviews(id,site_id,event_key,version,state,updated_at) VALUES (?,?,?,?,?,?)').run('retained-review','retained','retained-event',1,'{"status":"confirmed"}','2024-04-01');
  db.sqlite.prepare('INSERT INTO performance_summaries VALUES (?,?,?,?)').run('retained-import','retained','{"objectKey":"analysis/retained.json"}','2024-04-01');
  await new LocalBucket(db,join(root,'objects')).put('analysis/retained.json','{"synthetic":"unaltered saved outage result"}');
  const tables=db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
  const before=Object.fromEntries(tables.map(t=>[t,typed(db.sqlite,t)])),ledger=db.sqlite.prepare('SELECT * FROM __sol_migrations ORDER BY name').all();
  assert.deepEqual(ledger.map(r=>r.name),prefix);db.close();db=null;
  const reopens=[];
  for(let i=0;i<2;i++){
   db=new LocalDatabase(path,resolve('drizzle'));
   const after=Object.fromEntries(tables.map(t=>[t,typed(db.sqlite,t)]));
   for(const table of tables){if(table==='__sol_migrations')continue;
    assert.deepEqual(after[table],table==='monthly_utility'?before[table].map(row=>({...row,unpaid_energy:null,unpaid_energy__type:'null'})):before[table],`${table} typed preservation`);
   }
   const currentLedger=db.sqlite.prepare('SELECT * FROM __sol_migrations ORDER BY name').all();assert.deepEqual(currentLedger.slice(0,ledger.length),ledger);assert.deepEqual(currentLedger.map(r=>r.name),inventory);
   const column=db.sqlite.prepare('PRAGMA table_info(monthly_utility)').all().find(c=>c.name==='unpaid_energy');assert.equal(column.type.toUpperCase(),'TEXT');assert.equal(column.notnull,0);assert.equal(column.dflt_value,null);
   assert.equal(db.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
   const snapshot=new MonthlyStore(db).read('retained');assert.equal(snapshot.revision,7);assert.deepEqual(snapshot.configuration,configuration);assert.equal(Object.keys(snapshot.utility).length,2);assert.ok(Object.values(snapshot.utility).every(r=>r.unpaidEnergy===null));
   assert.equal(await(await new LocalBucket(db,join(root,'objects')).get('analysis/retained.json')).text(),'{"synthetic":"unaltered saved outage result"}');
   reopens.push({after,ledger:currentLedger,snapshot,column});db.close();db=null;
  }
  db=new LocalDatabase(join(root,'fresh.sqlite'),resolve('drizzle'));
  assert.deepEqual(db.sqlite.prepare('SELECT name FROM __sol_migrations ORDER BY name').all().map(r=>r.name),inventory);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM monthly_utility').get().n,0);assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM monthly_configuration').get().n,0);
  assert.ok(db.sqlite.prepare('PRAGMA table_info(monthly_utility)').all().some(c=>c.name==='unpaid_energy'&&c.type.toUpperCase()==='TEXT'&&!c.notnull&&c.dflt_value===null));
  assert.equal(db.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.deepEqual(Object.fromEntries(historicalFiles.map(p=>[p,hash(p)])),historicalHashes);
  writeFileSync(join(root,'verified-upgrade.json'),JSON.stringify({prefix,inventory,historicalHashes,before,ledger,reopens,freshInstall:true},null,2));console.log('Unpaid upgrade evidence:',root);
 }finally{db?.close();}
});
