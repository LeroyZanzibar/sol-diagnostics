import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalDatabase} from '../../selfhost/storage.mjs';
import {ManualVcomStore} from '../../selfhost/manual-vcom-store.mjs';
import {createVcomClient,discoverVcom,planVcomImport,normalizeVcomWindow} from '../../selfhost/vcom-provider.mjs';
import {createSyntheticVcomFetch,fixtureAuth,fixtureMappings} from './manual-vcom-fixture.preload.mjs';
const auth={mode:'basic',apiKey:'synthetic-api-secret-only',username:'synthetic-user-only',password:'synthetic-password-only'};
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'manual-vcom-store-'));let db,store,now=Date.now();
 const open=()=>{db=new LocalDatabase(join(root,'shared.sqlite'),'drizzle');store=new ManualVcomStore({database:db,dataDirectory:root,clock:()=>now});return store;};
 open();db.sqlite.exec("INSERT INTO site_settings(id,name) VALUES('site','Synthetic Cedar Creek'),('other','Other synthetic site')");
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 return {root,get db(){return db;},get store(){return store;},advance(ms){now+=ms;},reopen(){db.close();return open();}};
}
test('credentials encrypted, site-bound, private, persistent and fail closed across every site',t=>{
 const f=fixture(t);assert.equal(f.store.settings('site').generation,0);
 f.store.configure('site',0,'TEST1',auth);
 assert.equal(f.store.settings('site').hasCredentials,true);
 assert.deepEqual(f.store.credentials('site'),auth);
 const saved=f.db.sqlite.prepare('SELECT * FROM vcom_site_settings').get();
 for(const value of [auth.apiKey,auth.username,auth.password])assert.ok(!JSON.stringify(saved).includes(value));
 const key=join(f.root,'manual-vcom-master.key');assert.equal(statSync(key).mode&0o777,0o600);
 f.reopen();assert.deepEqual(f.store.credentials('site'),auth);
 f.store.configure('site',1,'TEST1');assert.deepEqual(f.store.credentials('site'),auth);
 assert.throws(()=>f.store.configure('site',2,'TEST1',{...auth,password:''}),/credential/i);
 assert.equal(f.store.settings('site').generation,2);
 f.db.sqlite.prepare('INSERT INTO vcom_site_settings SELECT ?,generation,system_key,auth_mode,credentials,discovery,mappings,selected_poa_source_id,updated_at FROM vcom_site_settings WHERE site_id=?').run('other','site');
 assert.throws(()=>f.store.credentials('other'),/key|credential/i);
 const bytes=readFileSync(key);unlinkSync(key);
 assert.throws(()=>f.store.configure('other',2,'TEST2',auth),/key/i);
 writeFileSync(key,Buffer.alloc(32,19),{mode:0o600});assert.throws(()=>f.store.configure('other',2,'TEST2',auth),/key/i);
 writeFileSync(key,bytes,{mode:0o600});assert.deepEqual(f.store.credentials('site'),auth);
});
test('settings CAS invalidation, job identity and chunk/cursor transaction survive reopen',t=>{
 const f=fixture(t),s=f.store;s.configure('site',0,'TEST1',auth);
 assert.throws(()=>s.configure('site',0,'TEST2'),/generation/i);
 const plan={version:1,siteId:'site',systemKey:'TEST1',modelRevision:'model',datasetRevision:0,fromDate:'2026-01-01',throughDate:'2026-01-01',planHash:'hash',requests:[{requestId:'r0'},{requestId:'r1'}],windows:[],readingCount:2};
 const job=s.createJob({siteId:'site',generation:1,requestId:'request-1',fromDate:plan.fromDate,throughDate:plan.throughDate,actor:'synthetic',plan});
 assert.equal(s.createJob({siteId:'site',generation:1,requestId:'request-1',fromDate:plan.fromDate,throughDate:plan.throughDate,actor:'synthetic',plan}).id,job.id);
 assert.throws(()=>s.createJob({siteId:'site',generation:1,requestId:'request-1',fromDate:'2026-01-02',throughDate:plan.throughDate,actor:'synthetic',plan}),/request/i);
 assert.throws(()=>s.createJob({siteId:'site',generation:1,requestId:'request-2',fromDate:plan.fromDate,throughDate:plan.throughDate,actor:'synthetic',plan}),/unfinished/i);
 const leased=s.claim();assert.equal(leased.id,job.id);
 const chunk={version:1,requestId:'r0',descriptor:plan.requests[0],payload:{synthetic:1},payloadSha256:'digest',decodedBodyByteLength:15};
 f.db.sqlite.exec("CREATE TRIGGER injected_cursor_failure BEFORE UPDATE OF completed_requests ON vcom_manual_jobs WHEN NEW.completed_requests=1 BEGIN SELECT RAISE(ABORT,'injected failure'); END");
 assert.throws(()=>s.completeChunk(job.id,leased.leaseToken,chunk),/injected/);
 assert.equal(s.job('site',job.id).completedRequests,0);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM vcom_manual_chunks').get().n,0);
 f.db.sqlite.exec('DROP TRIGGER injected_cursor_failure');s.completeChunk(job.id,leased.leaseToken,chunk);
 f.reopen();assert.equal(f.store.job('site',job.id).completedRequests,1);assert.deepEqual(f.store.chunk(job.id,0),chunk);
 assert.equal(f.store.job('site',job.id).plan.planHash,'hash');
 f.store.configure('site',1,'TEST2');assert.equal(f.store.job('site',job.id).errorCode,'stale-configuration');
 assert.throws(()=>f.store.completeChunk(job.id,leased.leaseToken,{...chunk,requestId:'r1'}),/lease|stale/i);
});
function jobInput(plan){return {siteId:'site',generation:1,requestId:'synthetic-limits',fromDate:'2026-01-01',throughDate:'2026-01-01',actor:'synthetic',plan};}
const smallPlan=()=>({version:1,siteId:'site',systemKey:'TEST1',modelRevision:'model',datasetRevision:0,planHash:'hash',requests:[{requestId:'r0'},{requestId:'r1'}],windows:[],readingCount:2});
test('maximum request-count multi-megabyte plan is retained before first retry and preserved after reopen',t=>{
 const f=fixture(t);f.store.configure('site',0,'TEST1',auth);
 const plan={...smallPlan(),requests:Array.from({length:10000},(_,i)=>({requestId:`r${i}`,path:'/systems/TEST1/calculations/simulation',query:{padding:'x'.repeat(500)}}))};
 assert.ok(Buffer.byteLength(JSON.stringify(plan))>2*1024*1024);assert.ok(Buffer.byteLength(JSON.stringify(plan))<8*1024*1024);
 const job=f.store.createJob(jobInput(plan)),lease=f.store.claim();assert.equal(lease.plan.requests.length,10000);
 f.store.failJob(job.id,lease.leaseToken,{code:'VCOM_RATE_LIMIT',retryable:true,retryAt:f.store.clock()+2*86400000});
 assert.equal(f.store.pendingDelay(),2*86400000,'Do not truncate a provider Retry-After to an earlier retry');f.reopen();assert.deepEqual(f.store.job('site',job.id).plan,plan);assert.equal(f.store.claim(),null);
 f.advance(2*86400000);const retried=f.store.claim();const chunk={version:1,requestId:'r0',descriptor:plan.requests[0],payload:{synthetic:1},payloadSha256:'digest',decodedBodyByteLength:15};f.store.completeChunk(job.id,retried.leaseToken,chunk);f.reopen();assert.equal(f.store.job('site',job.id).completedRequests,1);assert.deepEqual(f.store.chunk(job.id,0),chunk);
});
test('expired leases resume original cursor, transient retries are bounded, and canceled leases cannot publish',t=>{
 const f=fixture(t);f.store.configure('site',0,'TEST1',auth);const job=f.store.createJob(jobInput(smallPlan())),first=f.store.claim();f.advance(120001);f.reopen();const next=f.store.claim();assert.notEqual(next.leaseToken,first.leaseToken);assert.equal(next.completedRequests,0);assert.throws(()=>f.store.heartbeat(job.id,first.leaseToken),/lease/i);
 let leased=next;
 for(let attempt=1;attempt<=5;attempt++){const failed=f.store.failJob(job.id,leased.leaseToken,{code:'VCOM_NETWORK',retryable:true});assert.equal(failed.status,attempt<=4?'queued':'failed');if(attempt<=4){assert.equal(f.store.claim(),null);f.advance(f.store.pendingDelay());leased=f.store.claim();}}
 assert.equal(f.store.pendingDelay(),null);f.store.retry('site',job.id);const resumed=f.store.claim();f.store.cancel('site',job.id);assert.throws(()=>f.store.heartbeat(job.id,resumed.leaseToken),/lease/i);
});
test('interrupted staging waits for orphan TTL and caps reallocation; plan/raw/normalized caps are explicit',t=>{
 const f=fixture(t);f.store.configure('site',0,'TEST1',auth);
 assert.throws(()=>f.store.createJob(jobInput({...smallPlan(),requests:Array.from({length:10001},(_,i)=>({requestId:String(i)}))})),/large|limit/i);
 assert.throws(()=>f.store.createJob(jobInput({...smallPlan(),padding:'x'.repeat(8*1024*1024)})),/limit/i);
 const job=f.store.createJob(jobInput(smallPlan())),leased=f.store.claim();
 assert.throws(()=>f.store.completeChunk(job.id,leased.leaseToken,{version:1,requestId:'r0',descriptor:smallPlan().requests[0],payload:{},payloadSha256:'hash',decodedBodyByteLength:16*1024*1024+1}),/limit/i);
 assert.throws(()=>f.store.checkpointWindow(job.id,leased.leaseToken,{key:'test',bytes:1,readings:2000001},{}),/limit/i);
 f.store.beginStage(job.id,leased.leaseToken);f.advance(120001);f.reopen();assert.equal(f.store.claim(),null);assert.ok(f.store.pendingDelay()>3000000);f.advance(f.store.pendingDelay());let recovered=f.store.claim();assert.equal(recovered.stageAttempts,1);
 for(let i=0;i<2;i++){f.store.beginStage(job.id,recovered.leaseToken);f.advance(3601001);recovered=f.store.claim();}
 assert.equal(recovered.stageAttempts,3);assert.throws(()=>f.store.beginStage(job.id,recovered.leaseToken),/attempts/i);
});

test('receipt recovery selects the exact site active slot beyond the public history limit and retains native admission',t=>{
 const f=fixture(t);f.store.configure('site',0,'TEST1',auth);f.store.configure('other',0,'TEST1',auth);
 for(let i=0;i<51;i++){const historic=f.store.createJob({...jobInput(smallPlan()),requestId:`history-${i}`});f.store.cancel('site',historic.id);}
 const job=f.store.createJob(jobInput(smallPlan())),other=f.store.createJob({...jobInput({...smallPlan(),siteId:'other'}),siteId:'other'});
 f.db.sqlite.prepare('UPDATE vcom_manual_jobs SET created_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',job.id);
 assert.equal(f.store.jobs('site').length,50);assert.ok(f.store.jobs('site').every(row=>row.id!==job.id));
 for(const status of ['queued','downloading','staging','awaiting_approval']){
  f.db.sqlite.prepare('UPDATE vcom_manual_jobs SET status=? WHERE id=?').run(status,job.id);
  assert.equal(f.store.activeJob('site').id,job.id);assert.equal(f.store.activeJob('site').status,status);assert.equal(f.store.activeJob('other').id,other.id);
 }
 f.reopen();assert.equal(f.store.activeJob('site').id,job.id);
 assert.throws(()=>f.store.createJob({...jobInput(smallPlan()),requestId:'next'}),{code:'job-active'});
 f.store.cancel('site',job.id);assert.equal(f.store.activeJob('site'),null);assert.equal(f.store.activeJob('missing'),null);assert.equal(f.store.activeJob('other').id,other.id);
});
test('receipt recovery requires exact committed site/job/stage/source identity and only changes shared receipt metadata',t=>{
 const f=fixture(t);f.store.configure('site',0,'TEST1',auth);const job=f.store.createJob(jobInput(smallPlan())),lease=f.store.claim();
 const preview={siteId:'site',stageId:'synthetic-receipt-stage',status:'preview',metadata:{source:'api',sourceImportId:`vcom:${job.id}`}};
 f.store.finishStage(job.id,lease.leaseToken,preview);const before=f.store.job('site',job.id);
 const committed={...preview,status:'committed',result:{siteId:'site',stageId:preview.stageId,revision:1}};
 const invalid=[{...committed,status:'preview'},{...committed,result:null},{...committed,siteId:'other'},{...committed,stageId:'wrong'},
  {...committed,metadata:{...committed.metadata,source:'csv'}},{...committed,metadata:{...committed.metadata,sourceImportId:'vcom:other'}},
  {...committed,result:{...committed.result,siteId:'other'}},{...committed,result:{...committed.result,stageId:'wrong'}}];
 for(const receipt of invalid){assert.throws(()=>f.store.reconcile('site',job.id,receipt),error=>['receipt-missing','receipt-mismatch'].includes(error.code));assert.deepEqual(f.store.job('site',job.id),before);}
 assert.throws(()=>f.store.reconcile('other',job.id,committed),{code:'job-not-found'});
 const saved=f.store.reconcile('site',job.id,committed);assert.equal(saved.status,'committed');assert.deepEqual(saved.result,committed.result);assert.deepEqual(saved.preview,committed);
 assert.deepEqual(saved.plan,before.plan);assert.equal(saved.requestId,before.requestId);assert.equal(saved.stageId,before.stageId);assert.equal(f.store.activeJob('site'),null);
 f.reopen();assert.deepEqual(f.store.job('site',job.id).result,committed.result);
 const input={...jobInput({...smallPlan(),datasetRevision:1}),requestId:'next'};const next=f.store.createJob(input);assert.notEqual(next.id,job.id);assert.equal(f.store.createJob(input).id,next.id);
 assert.throws(()=>f.store.createJob({...input,requestId:'competing'}),{code:'job-active'});
});
const responseChunk=(plan,index=0,metadata={})=>({version:1,requestId:plan.requests[index].requestId,descriptor:plan.requests[index],payload:{synthetic:1},payloadSha256:'digest',decodedBodyByteLength:15,...metadata});
for(const [label,offset] of [['future',3600000],['within spacing',1000],['past',-3600000],['null',null],['omitted',undefined]])test(`quota checkpoint persists the later of spacing and ${label} deadline after reopen`,t=>{
 const f=fixture(t);f.store.configure('site',0,'TEST1',auth);const plan=smallPlan(),job=f.store.createJob(jobInput(plan)),lease=f.store.claim(),now=f.store.clock();
 const metadata=offset===undefined?{}:{nextRequestAt:offset===null?null:new Date(now+offset).toISOString()},chunk=responseChunk(plan,0,metadata),delay=Math.max(2000,offset??0);
 const saved=f.store.completeChunk(job.id,lease.leaseToken,chunk);
 assert.equal(saved.completedRequests,1);assert.equal(saved.status,'downloading');assert.equal(saved.attempts,0);assert.equal(saved.nextAttemptAt,new Date(now+delay).toISOString());
 f.reopen();assert.deepEqual(f.store.chunk(job.id,0),chunk);assert.equal(f.store.pendingDelay(),delay);assert.equal(f.store.claim(),null);
 f.advance(delay-1);assert.equal(f.store.claim(),null);f.advance(1);const next=f.store.claim();assert.equal(next.completedRequests,1);assert.notEqual(next.leaseToken,lease.leaseToken);
 assert.throws(()=>f.store.completeChunk(job.id,lease.leaseToken,chunk),/lease/i);
});

test('quota checkpoint rolls back deadline, response and cursor together on a failed write',t=>{
 const f=fixture(t);f.store.configure('site',0,'TEST1',auth);const plan=smallPlan(),job=f.store.createJob(jobInput(plan)),lease=f.store.claim();
 const chunk=responseChunk(plan,0,{nextRequestAt:new Date(f.store.clock()+3600000).toISOString()}),before=f.store.job('site',job.id);
 f.db.sqlite.exec("CREATE TRIGGER injected_quota_failure BEFORE UPDATE OF next_attempt_at ON vcom_manual_jobs WHEN NEW.completed_requests=1 BEGIN SELECT RAISE(ABORT,'injected quota checkpoint failure'); END");
 assert.throws(()=>f.store.completeChunk(job.id,lease.leaseToken,chunk),/injected quota/);
 assert.deepEqual(f.store.job('site',job.id),before);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM vcom_manual_chunks').get().n,0);
 f.db.sqlite.exec('DROP TRIGGER injected_quota_failure');f.store.completeChunk(job.id,lease.leaseToken,chunk);f.reopen();
 assert.equal(f.store.job('site',job.id).nextAttemptAt,chunk.nextRequestAt);assert.deepEqual(f.store.chunk(job.id,0),chunk);
});

test('quota checkpoint rejects invalid deadline metadata without accepting a chunk or changing the lease',t=>{
 const f=fixture(t);f.store.configure('site',0,'TEST1',auth);const plan=smallPlan(),job=f.store.createJob(jobInput(plan)),lease=f.store.claim(),before=f.store.job('site',job.id);
 for(const nextRequestAt of [undefined,123,false,'','synthetic-private-header-value','2026-02-30T00:00:00.000Z','2026-11-19T12:00:00Z','2026-11-19T13:00:00.000+01:00','+010000-01-01T00:00:00.000Z']){
  assert.throws(()=>f.store.completeChunk(job.id,lease.leaseToken,responseChunk(plan,0,{nextRequestAt})),error=>{assert.equal(error.code,'validation');assert.doesNotMatch(error.message,/synthetic-private/);return true;});
  assert.deepEqual(f.store.job('site',job.id),before);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM vcom_manual_chunks').get().n,0);
 }
});

async function realQuotaFixture(t,headers,status=200){
 const f=fixture(t);f.store.configure('site',0,'TEST1',fixtureAuth);
 const offline=createSyntheticVcomFetch({fallback:()=>{throw Error('No external transport is permitted.');}}),clients=[],calls=[];
 const client=()=>{const instance=createVcomClient({auth:fixtureAuth,minSpacingMs:0,clock:()=>f.store.clock(),fetchImpl:async(input,init)=>{
  const response=await offline(input,init),url=new URL(input);if(!url.searchParams.has('from'))return response;
  calls.push(url.href);return new Response(response.body,{status,headers:typeof headers==='function'?headers(calls.length):headers});
 }});clients.push(instance);return instance;};
 const discovery=await discoverVcom({client:client(),systemKey:'TEST1'}),plan=planVcomImport({siteId:'site',discovery,mappings:fixtureMappings,selectedPoaSourceId:null,fromDate:'2026-01-01',throughDate:'2026-01-01',modelRevision:'model',datasetRevision:0});
 const job=f.store.createJob(jobInput(plan));return {...f,get store(){return f.store;},get db(){return f.db;},plan,job,clients,calls,client};
}

test('quota checkpoint survives separate real clients and native reopen, resumes the next cursor, and does not hold final normalization',async t=>{
 let deadline;
 const f=await realQuotaFixture(t,()=>({'X-RateLimit-Remaining-Day':'0','X-RateLimit-Reset-Day':deadline}));
 deadline=new Date(f.store.clock()+3600000).toUTCString();const due=Date.parse(deadline),firstLease=f.store.claim();
 const raw=await f.client().get(f.plan.requests[firstLease.completedRequests]);f.store.completeChunk(f.job.id,firstLease.leaseToken,raw);f.reopen();
 assert.equal(f.store.job('site',f.job.id).nextAttemptAt,new Date(due).toISOString());assert.equal(f.store.job('site',f.job.id).attempts,0);
 f.advance(2000);assert.equal(f.store.claim(),null);assert.equal(f.calls.length,1);assert.equal(f.store.chunk(f.job.id,0).nextRequestAt,new Date(due).toISOString());
 f.advance(due-f.store.clock()-1);assert.equal(f.store.claim(),null);f.advance(1);
 for(let index=1;index<f.plan.requests.length;index++){
  const lease=f.store.claim();assert.equal(lease.completedRequests,index);deadline=new Date(f.store.clock()+3600000).toUTCString();
  const chunk=await f.client().get(lease.plan.requests[index]);const saved=f.store.completeChunk(f.job.id,lease.leaseToken,chunk);f.reopen();
  assert.equal(saved.completedRequests,index+1);assert.equal(saved.attempts,0);
  const final=index===f.plan.requests.length-1;assert.equal(f.store.pendingDelay(),final?2000:Date.parse(deadline)-f.store.clock());
  f.advance(f.store.pendingDelay());
 }
 const lease=f.store.claim();assert.equal(lease.completedRequests,lease.totalRequests);assert.equal(f.calls.length,f.plan.requests.length);assert.equal(new Set(f.calls).size,f.calls.length);assert.equal(new Set(f.clients).size,f.plan.requests.length+1);
 const window=f.plan.windows[0],normalized=normalizeVcomWindow({plan:f.plan,windowStartUtc:window.startUtc,windowEndUtc:window.endUtc,rawChunks:f.store.windowChunks(lease,window)});
 assert.equal(normalized.readings.length,144);assert.equal(normalized.readings.find(row=>row.equipmentId==='@site').value,11);
 f.store.checkpointWindow(f.job.id,lease.leaseToken,{key:'synthetic-window',readings:normalized.readings.length,bytes:100},normalized.summary);
 const staging=f.store.claim();f.store.beginStage(f.job.id,staging.leaseToken);f.store.finishStage(f.job.id,staging.leaseToken,{stageId:'synthetic-stage'});
 assert.equal(f.store.job('site',f.job.id).status,'awaiting_approval');assert.ok(Date.parse(f.store.chunk(f.job.id,f.plan.requests.length-1).nextRequestAt)>f.store.clock());
});

test('quota checkpoint 429 control retains future retry across reopen and finite retries without a success cursor',async t=>{
 const f=await realQuotaFixture(t,{'Retry-After':'3600'},429);
 for(let attempt=1;attempt<=5;attempt++){
  const lease=f.store.claim();let failure;try{await f.client().get(lease.plan.requests[lease.completedRequests]);assert.fail('Expected HTTP 429');}catch(error){assert.equal(error.code,'VCOM_RATE_LIMITED');failure=error;}
  const saved=f.store.failJob(f.job.id,lease.leaseToken,{code:failure.code,retryable:failure.retryable,retryAt:Date.parse(failure.retryAt)});f.reopen();
  assert.equal(saved.completedRequests,0);assert.equal(saved.attempts,attempt);assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM vcom_manual_chunks').get().n,0);
  if(attempt<=4){assert.equal(saved.status,'queued');assert.equal(f.store.pendingDelay(),3600000);f.advance(3599999);assert.equal(f.store.claim(),null);f.advance(1);}else{assert.equal(saved.status,'failed');assert.equal(f.store.pendingDelay(),null);}
 }
 assert.equal(f.calls.length,5);assert.equal(new Set(f.calls).size,1,'Only a failed request is retried.');
});
