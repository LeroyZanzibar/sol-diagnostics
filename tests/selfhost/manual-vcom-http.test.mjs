import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';
import {seedSyntheticSite,fixtureSiteId,fixtureAuth,fixtureLogin,fixtureMappings} from './manual-vcom-fixture.preload.mjs';

// Requires current production dist. The parent owns builds; this test does not
// build or change an installed service. Every byte is an isolated synthetic fixture.
test('production HTTP server resumes an authorized TEST1 import without browser polling, then exact explicit approval and reopened data', {timeout:180000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'manual-vcom-http-'));seedSyntheticSite(directory);const trace=join(directory,'synthetic-requests.ndjson');
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const base=`http://127.0.0.1:${port}`,auth='Basic '+Buffer.from(`${fixtureLogin.username}:${fixtureLogin.password}`).toString('base64');let child,logs='';
 const inspect=operation=>{const db=new DatabaseSync(join(directory,'sol-diagnostics.sqlite'),{readOnly:true});try{return operation(db);}finally{db.close();}};
 const inspectSite=operation=>{const manager=new PerformanceStoreManager(join(directory,'performance'));try{return operation(manager.site(fixtureSiteId));}finally{manager.close();}};
 const start=async()=>{
  child=spawn(process.execPath,['--import',resolve('tests/selfhost/manual-vcom-fixture.preload.mjs'),'selfhost/server.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),SOL_DATA_DIR:directory,SOL_USERNAME:fixtureLogin.username,SOL_PASSWORD:fixtureLogin.password,SOL_PASSWORD_FILE:'',SOL_TEST_VCOM_FIXTURE:'1',SOL_TEST_VCOM_TRACE:trace},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',value=>{logs+=value;});child.stderr.on('data',value=>{logs+=value;});
  for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/healthz',{signal:AbortSignal.timeout(500)})).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Synthetic server did not start: '+logs);
 };
 const stop=async()=>{if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);try{await exit;}finally{clearTimeout(timer);}}};
 t.after(async()=>{await stop();rmSync(directory,{recursive:true,force:true});});
 const request=async(path,body,status=200,extra={})=>{const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:auth,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});const text=await response.text();let json;try{json=JSON.parse(text);}catch{json={text};}assert.equal(response.status,status,JSON.stringify(json)+'\n'+logs);return json;};
 const action=(body,status=200,extra={})=>request('/api/manual-vcom',{siteId:fixtureSiteId,...body},status,extra);
 const waitFor=async(predicate,label,timeout=60000)=>{const end=Date.now()+timeout;while(Date.now()<end){const result=predicate();if(result)return result;if(child.exitCode!==null)throw Error(logs);await new Promise(resolve=>setTimeout(resolve,100));}throw Error(label+'\n'+logs);};
 await start();assert.equal((await fetch(base+'/api/manual-vcom?siteId='+fixtureSiteId)).status,401);
 await request('/api/manual-vcom/work',{},403);
 await action({action:'configure',expectedGeneration:0,systemKey:'TEST1',credentials:fixtureAuth},403,{Origin:'https://foreign.invalid'});
 await action({action:'configure',expectedGeneration:0,systemKey:'TEST1',credentials:fixtureAuth});
 const discovered=await action({action:'discover',expectedGeneration:1});assert.equal(discovered.settings.discovery.sources.length,6);
 await action({action:'mappings',expectedGeneration:2,mappings:fixtureMappings,selectedPoaSourceId:'poa:301'});
 const started=await action({action:'start',expectedGeneration:3,requestId:'synthetic-http-restart',fromDate:'2026-01-01',throughDate:'2026-01-01'},202),id=started.job.id;
 const saved=await waitFor(()=>inspect(db=>db.prepare('SELECT plan,completed_requests FROM vcom_manual_jobs WHERE id=? AND completed_requests>=1').get(id)),'First raw checkpoint was not persisted');
 await stop();const before=inspect(db=>db.prepare('SELECT completed_requests FROM vcom_manual_jobs WHERE id=?').get(id)).completed_requests;assert.ok(before>=1);
 await start();
 // Only direct read-only DB inspection here: no GET/status request advances work.
 await waitFor(()=>inspect(db=>db.prepare("SELECT id FROM vcom_manual_jobs WHERE id=? AND status='awaiting_approval'").get(id)),'Server restart did not reach approval without browser polling');
 const row=inspect(db=>db.prepare('SELECT plan,completed_requests,total_requests FROM vcom_manual_jobs WHERE id=?').get(id));assert.equal(row.plan,saved.plan);assert.equal(row.completed_requests,row.total_requests);
 const traceRows=readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.query.from);assert.equal(traceRows.length,row.total_requests);assert.equal(new Set(traceRows.map(row=>JSON.stringify([row.path,row.query]))).size,row.total_requests);
 const preview=(await request(`/api/manual-vcom?siteId=${fixtureSiteId}&jobId=${id}`)).job;assert.equal(preview.status,'awaiting_approval');assert.equal(inspectSite(store=>store.describe().revision),0);
 await request('/api/performance-data',{action:'commit',siteId:fixtureSiteId,stageId:preview.stageId,previewToken:preview.preview.previewToken,approveOverlap:true},409);
 const applied=await action({action:'apply',jobId:id,stageId:preview.stageId,previewToken:preview.preview.previewToken,approveOverlap:false},200,{'oai-authenticated-user-id':'forged'});assert.equal(applied.job.status,'committed');
 await stop();await start();const receipt=(await request(`/api/manual-vcom?siteId=${fixtureSiteId}&jobId=${id}`)).job.result;assert.equal(receipt.stageId,preview.stageId);
 assert.equal(inspectSite(store=>store.describe().readingCount),144);assert.equal(inspectSite(store=>store.imports()[0].actor),fixtureLogin.username);
 assert.equal(inspect(db=>db.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n),0);assert.equal(inspect(db=>db.prepare('SELECT COUNT(*) n FROM analysis_runs').get().n),0);
 const bytes=JSON.stringify(applied);for(const secret of [fixtureAuth.apiKey,fixtureAuth.username,fixtureAuth.password])assert.ok(!bytes.includes(secret));
});
