import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {loadSource} from './source-module.mjs';
const cleanup=loadSource('db/depot-performance-cleanup.ts',['IMPORT_IDS','TABLES','PRESERVED']);
const jobs=loadSource('app/api/performance-summary/jobs.ts',[],{...cleanup,analysisFailureMessage:String});
const site=cleanup.DEPOT_SITE_ID;
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(`drizzle/${f}`,'utf8'));
 sqlite.exec('CREATE TABLE maintenance_tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,completed_at TEXT NOT NULL)');
 const statement=(sql,values=[])=>({bind(...v){return statement(sql,v)},async first(){return sqlite.prepare(sql).get(...values)||null},async all(){return {results:sqlite.prepare(sql).all(...values)}},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}}}});
 const db={sqlite,prepare:statement,async batch(items){sqlite.exec('BEGIN');try{const out=[];for(const i of items)out.push(await i.run());sqlite.exec('COMMIT');return out}catch(e){sqlite.exec('ROLLBACK');throw e}}};
 function insert(table,suffix,siteId=site,extra={}){
  const columns=sqlite.prepare(`PRAGMA table_info(${table})`).all();
  const row={};for(const c of columns)if(c.pk||c.notnull&&c.dflt_value===null)row[c.name]=c.type.toLowerCase().includes('int')||c.type.toLowerCase().includes('real')?1:`${c.name}-${suffix}`;
  row[table==='site_settings'?'id':'site_id']=siteId;Object.assign(row,extra);
  sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 }
 const objects=new Map();
 for(const id of cleanup.IMPORT_IDS){const key=`mapped/${site}/${id}.csv`;insert('telemetry_imports',id,site,{id,object_key:key});objects.set(key,10)}
 for(const t of cleanup.TABLES.filter(t=>t!=='telemetry_imports'))insert(t,'depot');
 for(const t of cleanup.TABLES)insert(t,'other','other-site');
 for(const t of cleanup.PRESERVED)insert(t,'keep');
 insert('site_settings','config');
 objects.set(`analysis/${site}/result.json`,42_000_000);objects.set(`history/${site}/manifest.json`,123);
 objects.set(`mapped/${site}-other/keep.csv`,100);objects.set('analysis/other-site/result.json',100);
 const bucket={async list({prefix,limit}){const all=[...objects].filter(([k])=>k.startsWith(prefix));return {objects:all.slice(0,limit).map(([key,size])=>({key,size})),truncated:all.length>limit}},async delete(keys){for(const k of keys)objects.delete(k)}};
 return {db,bucket,objects,insert};
}
test('cleanup is bounded, site scoped, preserves configuration and reviews, and seals after completion',async()=>{
 const f=fixture(),now=Date.now(),before=await cleanup.depotCleanupPreview(f.db,f.bucket);
 const started=await cleanup.deleteDepotPerformanceStep(f.db,f.bucket,now);assert.equal(started.status,'waiting');
 assert.equal(await cleanup.depotCleanupInProgress(f.db,site),true);assert.equal(await cleanup.depotCleanupInProgress(f.db,'other-site'),false);
 const oldJob=f.db.sqlite.prepare('SELECT * FROM analysis_jobs WHERE site_id=?').get(site);
 assert.equal(oldJob.status,'canceled');
 // A stale request cannot claim a new job during cleanup.
 const stale=await jobs.getOrCreateJob(f.db,'stale',site,'old');assert.equal(await jobs.claimJob(f.db,stale),null);
 let deletedRows=0,deletedObjects=0;
 for(let i=0;i<30;i++){const step=await cleanup.deleteDepotPerformanceStep(f.db,f.bucket,now+66000);assert.ok(step.deletedRows<=5000);assert.ok(step.deletedObjects<=100);deletedRows+=step.deletedRows;deletedObjects+=step.deletedObjects;if(step.status==='completed')break}
 assert.equal(deletedObjects,7);assert.equal(deletedRows,13);
 const after=await cleanup.depotCleanupPreview(f.db,f.bucket);assert.equal(after.task.status,'completed');
 assert.ok(Object.values(after.generated).every(n=>n===0));assert.deepEqual(after.preserved,before.preserved);assert.deepEqual(after.site,before.site);assert.deepEqual(after.otherSites,before.otherSites);assert.equal(f.objects.size,2);
 f.insert('telemetry_imports','future',site,{id:'future'});f.objects.set(`mapped/${site}/future.csv`,100);
 const retry=await cleanup.deleteDepotPerformanceStep(f.db,f.bucket,now+120000);assert.equal(retry.deletedRows,0);assert.equal(f.objects.has(`mapped/${site}/future.csv`),true);
 assert.equal(await cleanup.depotCleanupInProgress(f.db,site),false);
});
test('changed imports prevent deletion and R2 failure remains retryable without dropping database records',async()=>{
 const f=fixture(),now=Date.now();f.insert('telemetry_imports','new',site,{id:'new'});
 await assert.rejects(cleanup.deleteDepotPerformanceStep(f.db,f.bucket,now),/uploads changed/);assert.equal(f.objects.size,9);
 f.db.sqlite.exec("DELETE FROM telemetry_imports WHERE id='new'");
 await cleanup.deleteDepotPerformanceStep(f.db,f.bucket,now);
 const remove=f.bucket.delete;f.bucket.delete=async()=>{throw Error('storage failure')};
 await assert.rejects(cleanup.deleteDepotPerformanceStep(f.db,f.bucket,now+66000),/storage failure/);
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM telemetry_imports WHERE site_id=?').get(site).n,5);
 f.bucket.delete=remove;assert.equal((await cleanup.deleteDepotPerformanceStep(f.db,f.bucket,now+66000)).deletedObjects,5);
});
