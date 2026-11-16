import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {LocalDatabase,LocalBucket} from '../../selfhost/storage.mjs';
import {loadSource} from '../source-module.mjs';

const {DEPOT_SITE_ID,DEPOT_CLEANUP_ID}=loadSource('db/depot-performance-cleanup.ts');
const migration='0019_maintenance_tasks.sql';
const legacyDDL='CREATE TABLE maintenance_tasks(id text PRIMARY KEY NOT NULL,status text NOT NULL,completed_at text NOT NULL)';
const allRows=(db,table)=>db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();

async function appFixture(t){
  const root=mkdtempSync(join(tmpdir(),'sol-maintenance-http-')),directory=join(root,'data');mkdirSync(directory);
  const previous=join(root,'previous');mkdirSync(previous);
  for(const name of readdirSync('drizzle').filter(n=>/^\d+.*\.sql$/.test(n)&&Number(n.split('_')[0])<19))copyFileSync(join('drizzle',name),join(previous,name));
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base=`http://127.0.0.1:${port}`,password=randomUUID();let child,logs='';
  const headers={Authorization:'Basic '+Buffer.from(`tester:${password}`).toString('base64')};
  const filename=join(directory,'sol-diagnostics.sqlite');
  function inspect(fn){const db=new DatabaseSync(filename);try{return fn(db);}finally{db.close();}}
  async function start(){
    child=spawn(process.execPath,['selfhost/server.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),SOL_DATA_DIR:directory,SOL_PASSWORD_FILE:'',SOL_PASSWORD:password,SOL_USERNAME:'tester'},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',d=>{logs+=d});child.stderr.on('data',d=>{logs+=d});
    for(let i=0;i<150;i++){
      if(child.exitCode!==null)throw Error(logs);
      try{if((await fetch(base+'/healthz',{signal:AbortSignal.timeout(1000)})).ok)return;}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw Error('Server did not start: '+logs);
  }
  async function stop(){
    if(child&&child.exitCode===null){
      const exited=once(child,'exit'),timer=setTimeout(()=>child.kill('SIGKILL'),10000);child.kill('SIGTERM');
      try{await exited;}finally{clearTimeout(timer);}
    }
  }
  t.after(async()=>{await stop();rmSync(root,{recursive:true,force:true});});
  async function api(path,method='GET',body,status=200){
    const response=await fetch(base+path,{method,headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    const data=await response.json();assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(data)}\n${logs}`);return data;
  }
  return {root,directory,filename,previous,base,headers,inspect,start,stop,api,logs:()=>logs};
}

async function seed(f,migrations){
  const db=new LocalDatabase(f.filename,migrations);
  try{
    const bucket=new LocalBucket(db,join(f.directory,'objects'));
    // red-mesa was targeted by legacy cleanup; preserving it proves startup did not invoke cleanup.
    for(const id of [DEPOT_SITE_ID,'red-mesa','other-site']){
      db.sqlite.prepare('INSERT INTO site_settings(id,name) VALUES (?,?)').run(id,`Synthetic ${id}`);
      if(id===DEPOT_SITE_ID)continue;
      db.sqlite.prepare('INSERT INTO equipment_assets(id,site_id,type,name,external_id) VALUES (?,?,?,?,?)').run(`${id}-meter`,id,'revenue_meter','Retained synthetic meter',`${id}-meter`);
      const key=`mapped/${id}/retained.csv`,body=`Timestamp,Energy\n2026-05-01T00:00:00Z,1\n# ${id}\n`;
      await bucket.put(key,body,{httpMetadata:{contentType:'text/csv'},customMetadata:{synthetic:'retained'}});
      db.sqlite.prepare('INSERT INTO telemetry_imports(id,site_id,file_name,object_key,file_size,row_count,valid_rows,timezone,mapping,detected_types,validation) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(`${id}-import`,id,'retained.csv',key,Buffer.byteLength(body),1,1,'UTC','{}','[]','{}');
    }
  }finally{db.close();}
}
function protectedData(f){
  return f.inspect(db=>({
    sites:db.prepare('SELECT * FROM site_settings WHERE id<>? ORDER BY id').all(DEPOT_SITE_ID),
    equipment:db.prepare('SELECT * FROM equipment_assets WHERE site_id<>? ORDER BY id').all(DEPOT_SITE_ID),
    imports:db.prepare('SELECT * FROM telemetry_imports WHERE site_id<>? ORDER BY id').all(DEPOT_SITE_ID),
    objects:allRows(db,'__sol_objects').filter(row=>row.key.startsWith('mapped/red-mesa/')||row.key.startsWith('mapped/other-site/')).map(row=>({...row,body:readFileSync(join(f.directory,'objects',row.path),'utf8')})),
  }));
}
function telemetry(){
  const lines=['Timestamp,Meter kWh,Inv1 kWh,Inv2 kWh,Expected kWh,Irradiance'];let energy=0;
  for(let day=1;day<=8;day++)for(let hour=0;hour<24;hour++){
    const light=hour>=8&&hour<=16,healthy=light?60:0,inv1=day===3||day===4?0:healthy;energy+=inv1+healthy;
    lines.push(`2026-05-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:00:00Z,${inv1+healthy},${inv1},${healthy},${healthy*2},${light?600:0}`);
  }
  const csv=Buffer.from(lines.join('\n')+'\n');
  return {csv,energy,metadata:{siteId:DEPOT_SITE_ID,fileName:'synthetic-depot.csv',fileSize:csv.length,timezone:'UTC',mapping:{timestamp:'Timestamp',expectedProduction:'Expected kWh'},equipmentMapping:{signals:[{column:'Meter kWh',equipmentId:'meter',measurement:'Energy'},{column:'Inv1 kWh',equipmentId:'inv1',measurement:'Energy'},{column:'Inv2 kWh',equipmentId:'inv2',measurement:'Energy'},{column:'Irradiance',equipmentId:'weather',measurement:'Irradiance'}]},detectedTypes:['Energy','Irradiance'],validation:{totalRows:lines.length-1,validRows:lines.length-1,errors:0,timezone:'UTC',timestampConvention:'start',intervalMinutes:60,start:'2026-05-01T00:00:00Z',end:'2026-05-08T23:00:00Z'}}};
}
async function upload(f,fixture,status=201){
  const {csv,metadata}=fixture,uploadId=randomUUID(),split=csv.indexOf(10,Math.floor(csv.length/2))+1;
  for(const [index,chunk] of [csv.subarray(0,split),csv.subarray(split)].entries()){
    const response=await fetch(`${f.base}/api/telemetry-imports/chunk?uploadId=${uploadId}&part=${index+1}`,{method:'PUT',headers:f.headers,body:chunk,signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,201,await response.text());
  }
  return f.api('/api/telemetry-imports/finalize','POST',{...metadata,uploadId,totalChunks:2},status);
}

for(const scenario of ['fresh','upgrade','legacy-active','legacy-completed'])test(`production Depot HTTP ${scenario}: chunk/finalize, analysis, preserved data and restart`,{timeout:120000},async t=>{
  const f=await appFixture(t);let before,oldLedger;
  if(scenario!=='fresh'){
    await seed(f,f.previous);before=protectedData(f);
    f.inspect(db=>{
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='maintenance_tasks'").get(),undefined);
      oldLedger=allRows(db,'__sol_migrations');
      if(scenario.startsWith('legacy-')){
        db.exec(legacyDDL);
        db.prepare('INSERT INTO maintenance_tasks VALUES (?,?,?)').run(DEPOT_CLEANUP_ID,scenario==='legacy-active'?'deleting':'completed','2026-01-02T03:04:05.000Z');
        db.prepare('INSERT INTO maintenance_tasks VALUES (?,?,?)').run('unrelated-task','completed','2025-01-02T03:04:05.000Z');
      }
    });
  }
  const initialTasks=scenario.startsWith('legacy-')?f.inspect(db=>allRows(db,'maintenance_tasks')):[];
  await f.start();
  if(scenario==='fresh'){await seed(f,resolve('drizzle'));before=protectedData(f);}
  assert.deepEqual(protectedData(f),before);
  f.inspect(db=>{
    assert.deepEqual(allRows(db,'maintenance_tasks'),initialTasks,'startup must preserve task state without completion markers');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM __sol_migrations WHERE name=?').get(migration).n,1);
    if(oldLedger)assert.deepEqual(allRows(db,'__sol_migrations').filter(row=>row.name!==migration),oldLedger);
  });
  for(const [path,method] of [[`/api/performance-summary?siteId=${DEPOT_SITE_ID}`,'GET'],['/api/telemetry-imports/finalize','POST'],[`/api/telemetry-imports/chunk?uploadId=${randomUUID()}&part=1`,'PUT']]){
    const response=await fetch(f.base+path,{method,signal:AbortSignal.timeout(15000)});assert.equal(response.status,401);await response.text();
  }
  const summaryPath=`/api/performance-summary?siteId=${DEPOT_SITE_ID}`;
  assert.equal((await f.api(summaryPath)).hasData,false);
  const node=(id,type,parentId=null)=>({id,name:id,externalId:id,type,parentId,quantity:1,aliases:[],channels:[]});
  const equipment=[node('meter','revenue_meter'),{...node('transformer','transformer','meter'),nameplateKva:'200'},...['inv1','inv2'].flatMap(id=>[{...node(id,'inverter','transformer'),acRatedCapacityKw:'100',maxDcCapacityKw:'150'},{...node(id+'-modules','module_group',id),moduleRatedCapacityW:'400',quantity:300}]),node('weather','weather_sensor')];
  const model=await f.api('/api/equipment','PUT',{siteId:DEPOT_SITE_ID,equipment,verified:true});assert.equal(model.verified,true);
  const fixture=telemetry();
  if(scenario==='legacy-active'){
    const blocked=await upload(f,fixture,409);assert.match(blocked.error,/being removed.*after cleanup completes/);
    assert.deepEqual(protectedData(f),before);
    f.inspect(db=>{
      assert.deepEqual(allRows(db,'maintenance_tasks'),initialTasks);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM telemetry_imports WHERE site_id=?').get(DEPOT_SITE_ID).n,0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM __sol_objects WHERE key LIKE ?').get(`mapped/${DEPOT_SITE_ID}/%`).n,0);
      // Simulate completion in this synthetic fixture only, not by running destructive cleanup.
      db.prepare("UPDATE maintenance_tasks SET status='completed' WHERE id=?").run(DEPOT_CLEANUP_ID);
    });
  }
  const staged=(await upload(f,fixture)).preview;assert.equal(staged.siteId,DEPOT_SITE_ID);
  assert.equal((await f.api(`/api/performance-data?siteId=${DEPOT_SITE_ID}`)).dataset.revision,0);
  const committed=await f.api('/api/performance-data','POST',{siteId:DEPOT_SITE_ID,action:'commit',stageId:staged.stageId,previewToken:staged.previewToken,approveOverlap:false});
  const imported=committed.dataset;assert.equal(imported.revision,1);
  const audit=(await f.api(`/api/performance-data?siteId=${DEPOT_SITE_ID}`)).imports;assert.equal(audit.length,1);assert.equal(audit[0].stageId,staged.stageId);
  f.inspect(db=>{
    assert.equal(db.prepare('SELECT COUNT(*) n FROM telemetry_imports WHERE site_id=?').get(DEPOT_SITE_ID).n,0,'Canonical imports must not enter destructive legacy replacement storage');
    const object=db.prepare('SELECT * FROM __sol_objects WHERE key=?').get(staged.metadata.originalObjectKey);
    assert.deepEqual(readFileSync(join(f.directory,'objects',object.path)),fixture.csv);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM __sol_objects WHERE key LIKE 'upload-parts/%'").get().n,0);
  });
  if(scenario==='legacy-active'){
    f.inspect(db=>db.prepare("UPDATE maintenance_tasks SET status='deleting' WHERE id=?").run(DEPOT_CLEANUP_ID));
    await f.stop();await f.start();
    const blocked=await f.api(summaryPath);assert.equal(blocked.hasData,false);assert.equal(blocked.reason,'No telemetry import is available.');
    f.inspect(db=>{
      assert.equal(db.prepare('SELECT status FROM maintenance_tasks WHERE id=?').get(DEPOT_CLEANUP_ID).status,'deleting');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM analysis_jobs WHERE site_id=?').get(DEPOT_SITE_ID).n,0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM telemetry_imports WHERE site_id=?').get(DEPOT_SITE_ID).n,0);
      db.prepare("UPDATE maintenance_tasks SET status='completed' WHERE id=?").run(DEPOT_CLEANUP_ID);
    });
  }
  assert.deepEqual((await f.api(`/api/performance-data?siteId=${DEPOT_SITE_ID}`)).dataset,imported);
  const required=await f.api(summaryPath);assert.equal(required.analysisRequired,true);
  await f.api('/api/performance-summary','POST',{siteId:DEPOT_SITE_ID,action:'reanalyze'},202);
  let result;
  for(let i=0;i<40;i++){
    const response=await fetch(f.base+summaryPath,{headers:f.headers,signal:AbortSignal.timeout(15000)});result=await response.json();
    assert.ok(response.status===200||response.status===202,JSON.stringify(result));
    assert.ok(!result.error,JSON.stringify(result));if(!result.processing)break;
  }
  assert.equal(result.hasData,true,JSON.stringify(result));assert.equal(result.import.id,imported.revisionId);
  assert.equal(result.summary.totalEnergyKwh,fixture.energy);assert.equal(result.summary.dailyProduction.length,8);
  assert.ok(result.analysis.issues.length>0,'real production analysis must detect the synthetic inverter outage');
  assert.deepEqual(protectedData(f),before);
  const tasks=f.inspect(db=>allRows(db,'maintenance_tasks'));
  await f.stop();await f.start();
  const again=await f.api(summaryPath);assert.equal(again.hasData,true);assert.deepEqual(again.summary,result.summary);
  assert.equal(again.import.id,imported.revisionId);assert.deepEqual(again.analysis.issues,result.analysis.issues);
  assert.deepEqual(protectedData(f),before);assert.deepEqual(f.inspect(db=>allRows(db,'maintenance_tasks')),tasks);
  assert.doesNotMatch(f.logs(),/no such table: maintenance_tasks|Performance analysis failed|Analysis stage failed/);
  t.diagnostic(`${scenario}: authenticated Depot upload and ${fixture.energy} kWh analysis with ${result.analysis.issues.length} findings survived restart; unrelated rows and object bytes unchanged.`);
});

test('production server refuses incompatible maintenance_tasks before listening and preserves records',{timeout:30000},async t=>{
  const f=await appFixture(t);await seed(f,f.previous);
  const before=protectedData(f),snapshot=f.inspect(db=>{
    db.exec('CREATE TABLE maintenance_tasks(id TEXT PRIMARY KEY NOT NULL,status INTEGER NOT NULL,completed_at TEXT NOT NULL)');
    db.prepare('INSERT INTO maintenance_tasks VALUES (?,?,?)').run('retained',7,'2026-01-02');
    return {tasks:allRows(db,'maintenance_tasks'),ledger:allRows(db,'__sol_migrations'),schema:db.prepare("SELECT sql FROM sqlite_master WHERE name='maintenance_tasks'").get().sql};
  });
  await assert.rejects(f.start(),/Incompatible maintenance_tasks schema; startup refused/);
  await assert.rejects(fetch(f.base+'/healthz',{signal:AbortSignal.timeout(1000)}));
  assert.doesNotMatch(f.logs(),/local storage ready/);
  assert.deepEqual(protectedData(f),before);
  f.inspect(db=>{
    assert.deepEqual(allRows(db,'maintenance_tasks'),snapshot.tasks);assert.deepEqual(allRows(db,'__sol_migrations'),snapshot.ledger);
    assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='maintenance_tasks'").get().sql,snapshot.schema);
  });
});
