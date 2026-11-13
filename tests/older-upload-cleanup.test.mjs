import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {loadSource} from './source-module.mjs';
const manifest=loadSource('db/older-upload-manifest.ts');
const cleanup=loadSource('db/older-upload-cleanup.ts',['PRESERVED_TABLES'],manifest);
const entries=manifest.OLDER_UPLOADS;
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(`drizzle/${f}`,'utf8'));
 const statement=(sql,values=[])=>({bind(...v){return statement(sql,v)},async first(){return sqlite.prepare(sql).get(...values)||null},async all(){return {results:sqlite.prepare(sql).all(...values)}},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}}}});
 const db={prepare:statement};
 function insert(table,extra={}){
  const row={};for(const c of sqlite.prepare(`PRAGMA table_info(${table})`).all())if(c.pk||c.notnull&&c.dflt_value===null)row[c.name]=/int|real/i.test(c.type)?1:`saved-${c.name}`;
  Object.assign(row,extra);sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
 }
 const objects=new Map();
 for(const row of entries){insert('telemetry_imports',{id:row.id,site_id:row.siteId,object_key:row.objectKey,created_at:'2026-09-01T00:00:00Z',status:'imported'});objects.set(row.objectKey,{size:100,etag:row.id});}
 for(const row of new Map(entries.map(row=>[row.siteId,row])).values()){
  const key=`mapped/${row.siteId}/latest.csv`;insert('telemetry_imports',{id:row.keepId,site_id:row.siteId,object_key:key,created_at:'2026-10-01T00:00:00Z',status:'imported'});objects.set(key,{size:200,etag:row.keepId});
 }
 insert('telemetry_imports',{id:'only-upload',site_id:'only-site',object_key:'mapped/only-site/only.csv',created_at:'2026-01-01T00:00:00Z',status:'imported'});objects.set('mapped/only-site/only.csv',{size:300,etag:'only'});
 objects.set('analysis/clear-solar-i/current.json',{size:40000,etag:'keep-analysis'});
 for(const table of cleanup.PRESERVED_TABLES)insert(table);
 const bucket={async head(key){return objects.get(key)||null},async delete(key){objects.delete(key)},async list({prefix}){return {objects:[...objects].filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,...value})),truncated:false}}};
 const preserved=()=>JSON.stringify(cleanup.PRESERVED_TABLES.map(table=>sqlite.prepare(`SELECT * FROM ${table}`).all()));
 return {sqlite,db,bucket,objects,insert,preserved};
}
test('removes all approved older files while preserving every latest file, single-file site, analysis and review',async()=>{
 const f=fixture(),before=await cleanup.olderUploadInventory(f.db,f.bucket),protectedBefore=f.preserved();
 assert.equal(before.groups.reduce((n,g)=>n+g.older.length,0),15);
 for(const row of entries){const result=await cleanup.removeOlderUpload(f.db,f.bucket,row.id);assert.equal(result.status,'deleted');assert.equal(result.keptImportId,row.keepId);assert.equal(f.objects.has(row.objectKey),false);}
 const after=await cleanup.olderUploadInventory(f.db,f.bucket);
 assert.ok(after.groups.every(group=>group.older.length===0));assert.equal(after.groups.length,before.groups.length);
 assert.equal(f.preserved(),protectedBefore);assert.equal(f.objects.has('analysis/clear-solar-i/current.json'),true);
 for(const group of before.groups){const current=after.groups.find(g=>g.siteId===group.siteId);assert.deepEqual(current.keep,group.keep);assert.ok(f.objects.has(group.keep.object_key));}
 assert.equal((await cleanup.removeOlderUpload(f.db,f.bucket,entries[0].id)).status,'already_deleted');
 await assert.rejects(cleanup.removeOlderUpload(f.db,f.bucket,entries[0].keepId),/outside/);
 await assert.rejects(cleanup.removeOlderUpload(f.db,f.bucket,'only-upload'),/outside/);
});
test('protects uploads when the latest file is missing, not ready, changed, or history/analysis still needs the source',async()=>{
 for(const scenario of ['missing','pending','changed','history','analysis','wrong-key','shared']){
  const f=fixture(),row=entries[0];
  if(scenario==='missing')f.objects.delete(`mapped/${row.siteId}/latest.csv`);
  if(scenario==='pending')f.sqlite.prepare("UPDATE telemetry_imports SET status='pending' WHERE id=?").run(row.keepId);
  if(scenario==='changed')f.insert('telemetry_imports',{id:'newer',site_id:row.siteId,object_key:`mapped/${row.siteId}/new.csv`,created_at:'2026-11-01',status:'imported'});
  if(scenario==='history')f.insert('data_history_versions',{id:'history',site_id:row.siteId});
  if(scenario==='analysis')f.insert('analysis_jobs',{id:'active',site_id:row.siteId,import_id:row.id,status:'processing'});
  if(scenario==='wrong-key')f.sqlite.prepare('UPDATE telemetry_imports SET object_key=? WHERE id=?').run('mapped/other/keep.csv',row.id);
  if(scenario==='shared')f.insert('telemetry_imports',{id:'shared',site_id:'another',object_key:row.objectKey,created_at:'2026-01-01'});
  await assert.rejects(cleanup.removeOlderUpload(f.db,f.bucket,row.id));assert.equal(f.objects.has(row.objectKey),true,scenario);
  assert.ok(f.sqlite.prepare('SELECT id FROM telemetry_imports WHERE id=?').get(row.id));
 }
});
test('storage and database failures are retryable and never remove the latest upload',async()=>{
 const f=fixture(),row=entries[0],remove=f.bucket.delete;
 f.bucket.delete=async()=>{throw Error('R2 failure')};await assert.rejects(cleanup.removeOlderUpload(f.db,f.bucket,row.id),/R2 failure/);
 assert.ok(f.sqlite.prepare('SELECT id FROM telemetry_imports WHERE id=?').get(row.id));
 f.bucket.delete=remove;
 const broken={prepare(sql){if(sql.startsWith('DELETE FROM telemetry_imports'))return {bind(){return {async run(){throw Error('D1 failure')}}}};return f.db.prepare(sql)}};
 await assert.rejects(cleanup.removeOlderUpload(broken,f.bucket,row.id),/D1 failure/);assert.equal(f.objects.has(row.objectKey),false);
 assert.equal((await cleanup.removeOlderUpload(f.db,f.bucket,row.id)).status,'deleted');assert.ok(f.objects.has(`mapped/${row.siteId}/latest.csv`));
});
