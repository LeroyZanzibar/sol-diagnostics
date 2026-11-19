import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {LocalDatabase} from '../../selfhost/storage.mjs';
import {ManualVcomStore} from '../../selfhost/manual-vcom-store.mjs';
import {createVcomClient,discoverVcom} from '../../selfhost/vcom-provider.mjs';
import {seedSyntheticSite,createSyntheticVcomFetch,fixtureSiteId,fixtureAuth,fixtureLogin,fixtureMappings} from './manual-vcom-fixture.preload.mjs';

// Requires current production dist. The test never builds or touches an installed
// service. Seed only isolated, production-migrated state; all telemetry is synthetic.
async function fixture(t,mode){
 const directory=mkdtempSync(join(tmpdir(),'manual-vcom-quota-http-'));let child,logs='';
 const stop=async()=>{if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);try{await exited;}finally{clearTimeout(timer);}}};
 t.after(async()=>{await stop();rmSync(directory,{recursive:true,force:true});});
 seedSyntheticSite(directory);
 // Discovery itself is not under test. Use the real provider at zero test-only
 // spacing to keep setup short; actual download steps use production defaults.
 const offline=createSyntheticVcomFetch({fallback:()=>{throw Error('Unexpected external fixture request.');}});
 const discovery=await discoverVcom({client:createVcomClient({auth:fixtureAuth,fetchImpl:offline,minSpacingMs:0}),systemKey:'TEST1'});
 const db=new LocalDatabase(join(directory,'sol-diagnostics.sqlite'),'drizzle');
 try{const store=new ManualVcomStore({database:db,dataDirectory:directory});store.configure(fixtureSiteId,0,'TEST1',fixtureAuth);store.saveDiscovery(fixtureSiteId,1,discovery);store.saveMappings(fixtureSiteId,2,fixtureMappings,null);}finally{db.close();}
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(done=>reservation.close(done));
 const base=`http://127.0.0.1:${port}`,trace=join(directory,'quota-trace.ndjson');
 const waitFor=async(predicate,label,timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error(logs);const result=await predicate();if(result)return result;await new Promise(done=>setTimeout(done,50));}throw Error(label+'\n'+logs);};
 const start=async()=>{
  child=spawn(process.execPath,['--import',resolve('tests/selfhost/manual-vcom-quota-fixture.preload.mjs'),'selfhost/server.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),SOL_DATA_DIR:directory,SOL_USERNAME:fixtureLogin.username,SOL_PASSWORD:fixtureLogin.password,SOL_PASSWORD_FILE:'',SOL_TEST_VCOM_FIXTURE:'',SOL_TEST_VCOM_QUOTA_FIXTURE:mode,SOL_TEST_VCOM_TRACE:trace},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',value=>{logs+=value;});child.stderr.on('data',value=>{logs+=value;});
  await waitFor(async()=>{try{return (await fetch(base+'/healthz',{signal:AbortSignal.timeout(500)})).ok;}catch{return false;}},'Synthetic quota server did not start');
 };
 const inspect=operation=>{const db=new DatabaseSync(join(directory,'sol-diagnostics.sqlite'),{readOnly:true});try{return operation(db);}finally{db.close();}};
 const job=id=>inspect(db=>db.prepare('SELECT id,status,plan,completed_requests,total_requests,attempts,raw_bytes,next_attempt_at,lease_token,stage_id,quality FROM vcom_manual_jobs WHERE id=?').get(id));
 const chunks=id=>inspect(db=>db.prepare('SELECT request_index,request_id,raw FROM vcom_manual_chunks WHERE job_id=? ORDER BY request_index').all(id));
 const calls=()=>readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const enqueue=async()=>{
  const response=await fetch(base+'/api/manual-vcom',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(`${fixtureLogin.username}:${fixtureLogin.password}`).toString('base64'),'Content-Type':'application/json'},body:JSON.stringify({siteId:fixtureSiteId,action:'start',expectedGeneration:3,requestId:`synthetic-quota-${mode}`,fromDate:'2026-01-01',throughDate:'2026-01-01'}),signal:AbortSignal.timeout(10000)});
  const body=await response.json();assert.equal(response.status,202,JSON.stringify(body)+'\n'+logs);return body.job.id;
 };
 return {start,stop,waitFor,inspect,job,chunks,calls,enqueue};
}

for(const mode of ['success-first','429-first'])test(`production quota checkpoint ${mode} survives real server restart without GET-driven work`,{timeout:60000},async t=>{
 const f=await fixture(t,mode);await f.start();const id=await f.enqueue();
 const first=await f.waitFor(()=>{const row=f.job(id);return (mode==='success-first'?row.completed_requests===1:row.attempts===1)&&row;},'First quota checkpoint was not persisted');
 await f.stop();const before=f.job(id),rawBefore=f.chunks(id);await f.start();
 // Longer than two normal network spacings; no status/work GETs are issued.
 await new Promise(done=>setTimeout(done,4500));
 const after=f.job(id),calls=f.calls(),rawAfter=f.chunks(id);
 t.diagnostic(JSON.stringify({synthetic:true,mode,first:{completed:first.completed_requests,nextAttemptAt:first.next_attempt_at},after:{completed:after.completed_requests,nextAttemptAt:after.next_attempt_at},calls}));
 assert.equal(calls.length,1,'A retained future quota deadline must prevent the next production fetch, including after restart.');
 assert.ok(after.next_attempt_at>Date.now()+3000000);assert.equal(after.next_attempt_at,before.next_attempt_at);assert.equal(after.plan,before.plan);assert.deepEqual(rawAfter,rawBefore);
 if(mode==='success-first'){
  assert.equal(after.completed_requests,1);assert.equal(after.status,'downloading');assert.equal(after.attempts,0);assert.equal(after.lease_token,null);assert.equal(rawAfter.length,1);
  const raw=JSON.parse(rawAfter[0].raw);assert.equal(raw.nextRequestAt,calls[0].nextRequestAt);assert.equal(after.next_attempt_at,Date.parse(raw.nextRequestAt));assert.ok(raw.payload.data.length>0);
 }else{
  assert.equal(after.completed_requests,0);assert.equal(after.status,'queued');assert.equal(after.attempts,1);assert.equal(rawAfter.length,0);
  // Retry-After seconds starts when headers are received, just after fixture trace.
  assert.ok(after.next_attempt_at>=Date.parse(calls[0].nextRequestAt));assert.ok(after.next_attempt_at-Date.parse(calls[0].nextRequestAt)<1000);
 }
 assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n),0);
});

test('production final-request quota is retained but does not postpone normalization or approval staging',{timeout:60000},async t=>{
 const f=await fixture(t,'success-final');await f.start();const id=await f.enqueue();
 const ready=await f.waitFor(()=>{const row=f.job(id);return row.status==='awaiting_approval'&&row;},'A final successful quota response blocked offline normalization/staging',25000);
 const calls=f.calls(),chunks=f.chunks(id),last=JSON.parse(chunks.at(-1).raw);
 assert.equal(ready.completed_requests,ready.total_requests);assert.equal(calls.length,ready.total_requests);assert.equal(new Set(calls.map(row=>JSON.stringify([row.path,row.query]))).size,ready.total_requests);
 assert.equal(last.nextRequestAt,calls.at(-1).nextRequestAt);assert.ok(Date.parse(last.nextRequestAt)>Date.now()+3000000);assert.equal(ready.next_attempt_at,null);assert.equal(ready.attempts,0);assert.ok(ready.stage_id);
 const quality=JSON.parse(ready.quality);assert.equal(quality.hours,24);assert.equal(quality.partialSimulationHours,1);
 await f.stop();await f.start();assert.equal(f.job(id).status,'awaiting_approval');assert.deepEqual(f.chunks(id),chunks);assert.equal(f.calls().length,ready.total_requests);
 assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n),0);assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM analysis_runs').get().n),0);
 t.diagnostic(JSON.stringify({synthetic:true,completedRequests:ready.completed_requests,status:ready.status,retainedQuotaDeadline:last.nextRequestAt}));
});
