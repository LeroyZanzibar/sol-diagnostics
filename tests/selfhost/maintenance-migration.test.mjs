import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {copyFileSync,mkdirSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {LocalDatabase,LocalBucket} from '../../selfhost/storage.mjs';
import {loadSource} from '../source-module.mjs';

const {depotCleanupInProgress,DEPOT_SITE_ID,DEPOT_CLEANUP_ID}=loadSource('db/depot-performance-cleanup.ts');
const {getOrCreateJob,claimJob}=loadSource('app/api/performance-summary/jobs.ts',[],{depotCleanupInProgress,analysisFailureMessage:String});
const migrations=resolve('drizzle');
const migration='0019_maintenance_tasks.sql';
const legacyDDL='CREATE TABLE maintenance_tasks(id text PRIMARY KEY NOT NULL,status text NOT NULL,completed_at text NOT NULL)';
const expectedColumns=[
  {name:'id',type:'TEXT',notnull:1,pk:1},
  {name:'status',type:'TEXT',notnull:1,pk:0},
  {name:'completed_at',type:'TEXT',notnull:1,pk:0},
];
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'sol-maintenance-'));
  const previous=join(root,'previous');mkdirSync(previous);
  for(const name of readdirSync(migrations).filter(n=>/^\d+.*\.sql$/.test(n)&&Number(n.split('_')[0])<19))copyFileSync(join(migrations,name),join(previous,name));
  const opened=[];
  t.after(()=>{for(const db of opened)try{db.close()}catch{}rmSync(root,{recursive:true,force:true});});
  return {root,previous,filename:join(root,'db.sqlite'),open(dir=migrations){const db=new LocalDatabase(join(root,'db.sqlite'),dir);opened.push(db);return db;}};
}
function rows(sqlite,table){return sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();}
function retained(sqlite){return Object.fromEntries(['site_settings','equipment_assets','telemetry_imports','__sol_objects'].map(table=>[table,rows(sqlite,table)]));}
async function seed(db,root){
  // Include a formerly removed placeholder ID: invoking legacy cleanup would destroy it.
  for(const id of [DEPOT_SITE_ID,'red-mesa','other-site']){
    db.sqlite.prepare('INSERT INTO site_settings(id,name) VALUES (?,?)').run(id,`Synthetic ${id}`);
    db.sqlite.prepare('INSERT INTO equipment_assets(id,site_id,type,name,external_id) VALUES (?,?,?,?,?)').run(`${id}-meter`,id,'revenue_meter','Synthetic meter',`${id}-meter`);
    db.sqlite.prepare('INSERT INTO telemetry_imports(id,site_id,file_name,object_key,file_size,row_count,valid_rows,timezone,mapping,detected_types,validation) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(`${id}-import`,id,'synthetic.csv',`mapped/${id}/synthetic.csv`,10,1,1,'UTC','{}','[]','{}');
  }
  const bucket=new LocalBucket(db,join(root,'objects'));
  for(const id of [DEPOT_SITE_ID,'red-mesa','other-site'])await bucket.put(`mapped/${id}/synthetic.csv`,`synthetic data for ${id}`,{httpMetadata:{contentType:'text/csv'}});
  return bucket;
}
function assertColumns(db){
  assert.deepEqual(db.sqlite.prepare('PRAGMA table_info(maintenance_tasks)').all().map(({name,type,notnull,pk})=>({name,type,notnull,pk})),expectedColumns);
}

test('fresh LocalDatabase migrations create maintenance_tasks before the Depot guard runs',async t=>{
  const f=fixture(t),db=f.open();
  // Before 0019 this is the actual production failure, not a fixture schema assertion.
  assert.equal(await depotCleanupInProgress(db,DEPOT_SITE_ID),false);
  assertColumns(db);
  assert.deepEqual(rows(db.sqlite,'maintenance_tasks'),[],'startup must not fabricate completed tasks');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM __sol_migrations WHERE name=?').get(migration).n,1);
});

test('upgrade from 0018 without maintenance_tasks preserves sites, equipment, imports, objects and hashes across repeat startups',async t=>{
  const f=fixture(t);let db=f.open(f.previous);
  assert.equal(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='maintenance_tasks'").get(),undefined);
  await assert.rejects(depotCleanupInProgress(db,DEPOT_SITE_ID),/no such table: maintenance_tasks/);
  t.diagnostic('Reproduced previous-version LocalDatabase guard error: no such table: maintenance_tasks');
  await seed(db,f.root);const before=retained(db.sqlite),ledger=rows(db.sqlite,'__sol_migrations');db.close();
  for(let startup=0;startup<2;startup++){
    db=f.open();
    assert.equal(await depotCleanupInProgress(db,DEPOT_SITE_ID),false);
    assertColumns(db);assert.deepEqual(rows(db.sqlite,'maintenance_tasks'),[]);
    assert.deepEqual(retained(db.sqlite),before);
    assert.deepEqual(rows(db.sqlite,'__sol_migrations').map(row=>row.name),readdirSync(migrations).filter(name=>/^\d+.*\.sql$/.test(name)).sort());
    assert.deepEqual(rows(db.sqlite,'__sol_migrations').filter(row=>Number(row.name.split('_')[0])<19),ledger);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM __sol_migrations WHERE name=?').get(migration).n,1);
    const bucket=new LocalBucket(db,join(f.root,'objects'));
    for(const id of [DEPOT_SITE_ID,'red-mesa','other-site'])assert.equal(await(await bucket.get(`mapped/${id}/synthetic.csv`)).text(),`synthetic data for ${id}`);
    db.close();
  }
});

for(const status of ['deleting','completed'])test(`compatible legacy maintenance_tasks preserves ${status} records and guard behavior across upgrade/restart`,async t=>{
  const f=fixture(t);let db=f.open(f.previous);await seed(db,f.root);
  db.sqlite.exec(legacyDDL);
  db.sqlite.prepare('INSERT INTO maintenance_tasks VALUES (?,?,?)').run(DEPOT_CLEANUP_ID,status,'2026-01-02T03:04:05.000Z');
  db.sqlite.prepare('INSERT INTO maintenance_tasks VALUES (?,?,?)').run('unrelated-task','completed','2025-01-02T03:04:05.000Z');
  const tasks=rows(db.sqlite,'maintenance_tasks'),before=retained(db.sqlite);db.close();
  for(let startup=0;startup<2;startup++){
    db=f.open();assertColumns(db);
    assert.deepEqual(rows(db.sqlite,'maintenance_tasks'),tasks);assert.deepEqual(retained(db.sqlite),before);
    assert.equal(await depotCleanupInProgress(db,DEPOT_SITE_ID),status==='deleting');
    assert.equal(await depotCleanupInProgress(db,'other-site'),false);
    db.close();
  }
});

test('incompatible pre-existing maintenance_tasks fails closed without changing schema, records or migration ledger',async t=>{
  const cases={
    'missing column':'CREATE TABLE maintenance_tasks(id TEXT PRIMARY KEY NOT NULL,status TEXT NOT NULL)',
    'wrong type':'CREATE TABLE maintenance_tasks(id TEXT PRIMARY KEY NOT NULL,status INTEGER NOT NULL,completed_at TEXT NOT NULL)',
    'nullable status':'CREATE TABLE maintenance_tasks(id TEXT PRIMARY KEY NOT NULL,status TEXT,completed_at TEXT NOT NULL)',
    'nullable id':'CREATE TABLE maintenance_tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,completed_at TEXT NOT NULL)',
    'nullable completed_at':'CREATE TABLE maintenance_tasks(id TEXT PRIMARY KEY NOT NULL,status TEXT NOT NULL,completed_at TEXT)',
    'missing primary key':'CREATE TABLE maintenance_tasks(id TEXT NOT NULL,status TEXT NOT NULL,completed_at TEXT NOT NULL)',
    'composite primary key':'CREATE TABLE maintenance_tasks(id TEXT NOT NULL,status TEXT NOT NULL,completed_at TEXT NOT NULL,PRIMARY KEY(id,status))',
    'extra required column':'CREATE TABLE maintenance_tasks(id TEXT PRIMARY KEY NOT NULL,status TEXT NOT NULL,completed_at TEXT NOT NULL,extra TEXT NOT NULL)',
    'view instead of table':"CREATE VIEW maintenance_tasks AS SELECT 'keep' id,'deleting' status,'2026-01-02' completed_at",
  };
  for(const [name,ddl] of Object.entries(cases))await t.test(name,async t=>{
    const f=fixture(t),db=f.open(f.previous);await seed(db,f.root);db.sqlite.exec(ddl);
    if(!ddl.startsWith('CREATE VIEW')){
      const columns=db.sqlite.prepare('PRAGMA table_info(maintenance_tasks)').all();
      db.sqlite.prepare(`INSERT INTO maintenance_tasks VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(c=>c.name==='id'?'keep':c.type==='INTEGER'?7:c.name==='status'?'deleting':'retained'));
    }
    const before=retained(db.sqlite),tasks=rows(db.sqlite,'maintenance_tasks'),ledger=rows(db.sqlite,'__sol_migrations');
    const schema=db.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='maintenance_tasks'").get().sql;db.close();
    for(let startup=0;startup<2;startup++){
      assert.throws(()=>{const unexpected=f.open();unexpected.close();},/Incompatible maintenance_tasks schema.*startup refused/);
      const check=new DatabaseSync(f.filename);
      try{
        assert.equal(check.prepare("SELECT sql FROM sqlite_master WHERE name='maintenance_tasks'").get().sql,schema);
        assert.deepEqual(rows(check,'maintenance_tasks'),tasks);assert.deepEqual(retained(check),before);
        assert.deepEqual(rows(check,'__sol_migrations'),ledger);
      }finally{check.close();}
    }
  });
});

test('a recorded migration with a missing table refuses startup instead of inventing task state',async t=>{
  const f=fixture(t),db=f.open();await seed(db,f.root);
  db.sqlite.exec('DROP TABLE maintenance_tasks');
  const before=retained(db.sqlite),ledger=rows(db.sqlite,'__sol_migrations');db.close();
  assert.throws(()=>f.open(),/Incompatible maintenance_tasks schema.*startup refused/);
  const check=new DatabaseSync(f.filename);
  try{
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='maintenance_tasks'").get(),undefined);
    assert.deepEqual(retained(check),before);assert.deepEqual(rows(check,'__sol_migrations'),ledger);
  }finally{check.close();}
});

test('production LocalDatabase keeps analysis job claims blocked only during active Depot cleanup',async t=>{
  const f=fixture(t),db=f.open();
  const job=await getOrCreateJob(db,'depot-job',DEPOT_SITE_ID,'synthetic-import');
  db.sqlite.prepare('INSERT INTO maintenance_tasks VALUES (?,?,?)').run(DEPOT_CLEANUP_ID,'deleting','2026-01-02T03:04:05.000Z');
  assert.equal(await claimJob(db,job),null);
  const blocked=db.sqlite.prepare('SELECT * FROM analysis_jobs WHERE id=?').get(job.id);
  assert.equal(blocked.lease_token,'');assert.equal(blocked.lease_until,0);
  const other=await getOrCreateJob(db,'other-job','other-site','synthetic-other-import');
  assert.ok(await claimJob(db,other),'an unrelated site must not be blocked');
  db.sqlite.prepare("UPDATE maintenance_tasks SET status='completed' WHERE id=?").run(DEPOT_CLEANUP_ID);
  const token=await claimJob(db,job);assert.ok(token);
  assert.equal(db.sqlite.prepare('SELECT lease_token FROM analysis_jobs WHERE id=?').get(job.id).lease_token,token);
});

test('startup revalidates maintenance_tasks even when 0019 is already recorded',async t=>{
  const f=fixture(t),db=f.open();
  db.sqlite.exec('ALTER TABLE maintenance_tasks RENAME TO maintenance_tasks_original; CREATE TABLE maintenance_tasks(id TEXT,status TEXT,completed_at TEXT); INSERT INTO maintenance_tasks VALUES (\'keep\',\'deleting\',\'retained\')');
  const tasks=rows(db.sqlite,'maintenance_tasks'),ledger=rows(db.sqlite,'__sol_migrations');db.close();
  assert.throws(()=>{const unexpected=f.open();unexpected.close();},/Incompatible maintenance_tasks schema.*startup refused/);
  const check=new DatabaseSync(f.filename);
  try{assert.deepEqual(rows(check,'maintenance_tasks'),tasks);assert.deepEqual(rows(check,'__sol_migrations'),ledger);}finally{check.close();}
});
