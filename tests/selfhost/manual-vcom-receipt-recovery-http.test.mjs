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

// Requires current production dist. Real HTTP/controller/provider/native stores,
// production migrations and offline official-origin transport; no Apply replay.
test('production HTTP next download recovers the exact receipt after shared-write failure and real server restart', {timeout:180000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'manual-vcom-receipt-http-'));seedSyntheticSite(directory);const trace=join(directory,'synthetic-requests.ndjson');
 const shared=(operation,write=false)=>{const db=new DatabaseSync(join(directory,'sol-diagnostics.sqlite'),{readOnly:!write});try{return operation(db);}finally{db.close();}};
 const canonical=stageId=>{const manager=new PerformanceStoreManager(join(directory,'performance'));try{const site=manager.site(fixtureSiteId);return JSON.stringify({dataset:site.describe(),imports:site.imports(),rows:[...site.rows()],receipt:site.preview(stageId)});}finally{manager.close();}};
 shared(db=>db.exec("INSERT INTO site_settings(id,name) VALUES('receipt-other-site','Other synthetic site')"),true);
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(done=>reservation.close(done));
 const base=`http://127.0.0.1:${port}`,authorization='Basic '+Buffer.from(`${fixtureLogin.username}:${fixtureLogin.password}`).toString('base64');let child,logs='';
 const startServer=async()=>{
  child=spawn(process.execPath,['--import',resolve('tests/selfhost/manual-vcom-fixture.preload.mjs'),'selfhost/server.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),SOL_DATA_DIR:directory,SOL_USERNAME:fixtureLogin.username,SOL_PASSWORD:fixtureLogin.password,SOL_PASSWORD_FILE:'',SOL_TEST_VCOM_FIXTURE:'1',SOL_TEST_VCOM_TRACE:trace},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',value=>logs+=value);child.stderr.on('data',value=>logs+=value);
  for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/healthz',{signal:AbortSignal.timeout(500)})).ok)return;}catch{}await new Promise(done=>setTimeout(done,50));}throw Error('Synthetic server start timed out: '+logs);
 };
 const stop=async()=>{if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);try{await exited;}finally{clearTimeout(timer);}}};
 t.after(async()=>{await stop();if(!t.passed)t.diagnostic(logs);rmSync(directory,{recursive:true,force:true});});
 const api=async(path,body,status=200,extra={})=>{
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization,'content-type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
  const text=await response.text();let value;try{value=JSON.parse(text);}catch{value={text};}assert.equal(response.status,status,JSON.stringify(value)+'\n'+logs);return value;
 };
 const action=(body,status=200,extra={})=>api('/api/manual-vcom',{siteId:fixtureSiteId,...body},status,extra);
 const jobRow=id=>shared(db=>db.prepare('SELECT * FROM vcom_manual_jobs WHERE site_id=? AND id=?').get(fixtureSiteId,id));
 const waitForApproval=async id=>{const deadline=Date.now()+60000;while(jobRow(id).status!=='awaiting_approval'){assert.ok(Date.now()<deadline,'Authorized download must reach approval: '+logs);assert.equal(child.exitCode,null,logs);await new Promise(done=>setTimeout(done,100));}};
 const downloads=()=>readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.query.from);
 await startServer();
 await action({action:'configure',expectedGeneration:0,systemKey:'TEST1',credentials:fixtureAuth});
 await action({action:'discover',expectedGeneration:1});
 await action({action:'mappings',expectedGeneration:2,mappings:fixtureMappings,selectedPoaSourceId:null});
 const firstAction={action:'start',expectedGeneration:3,requestId:'receipt-first',fromDate:'2026-01-01',throughDate:'2026-01-01'};
 const first=(await action(firstAction,202)).job;await waitForApproval(first.id);
 const preview=(await api(`/api/manual-vcom?siteId=${fixtureSiteId}&jobId=${first.id}`)).job;
 shared(db=>db.exec("CREATE TRIGGER injected_receipt_failure BEFORE UPDATE OF status ON vcom_manual_jobs WHEN NEW.status='committed' BEGIN SELECT RAISE(ABORT,'synthetic shared receipt write failure'); END"),true);
 try{await action({action:'apply',jobId:first.id,stageId:preview.stageId,previewToken:preview.preview.previewToken,approveOverlap:false},500);}
 finally{shared(db=>db.exec('DROP TRIGGER injected_receipt_failure'),true);}
 const before=canonical(preview.stageId),saved=JSON.parse(before),stale=jobRow(first.id),originalDownloads=downloads();
 assert.equal(saved.dataset.revision,1);assert.equal(saved.dataset.readingCount,144);assert.equal(saved.imports.length,1);assert.equal(saved.receipt.status,'committed');
 assert.equal(saved.receipt.siteId,fixtureSiteId);assert.equal(saved.receipt.stageId,preview.stageId);assert.equal(saved.receipt.metadata.sourceImportId,`vcom:${first.id}`);assert.equal(stale.status,'awaiting_approval');assert.equal(stale.result,null);
 assert.equal(originalDownloads.length,stale.total_requests);
 const readback=(await api(`/api/manual-vcom?siteId=${fixtureSiteId}&jobId=${first.id}`)).job;
 assert.equal(readback.status,'committed');assert.deepEqual(readback.result,saved.receipt.result);assert.deepEqual(jobRow(first.id),stale,'GET must not write shared receipt state');
 await stop();await startServer();
 assert.deepEqual(jobRow(first.id),stale,'Restart must not implicitly repair or download this awaiting-approval job');
 const restarted=(await api(`/api/manual-vcom?siteId=${fixtureSiteId}&jobId=${first.id}`)).job;
 assert.equal(restarted.status,'committed');assert.deepEqual(restarted.result,saved.receipt.result);assert.deepEqual(jobRow(first.id),stale);assert.equal(canonical(preview.stageId),before);
 const nextAction={action:'start',expectedGeneration:3,requestId:'receipt-next',fromDate:'2026-01-02',throughDate:'2026-01-02'};
 assert.equal((await action({...nextAction,expectedGeneration:2},409)).code,'stale-generation');
 await action(nextAction,403,{Origin:'https://foreign.invalid'});
 await api(`/api/manual-vcom?siteId=receipt-other-site&jobId=${first.id}`,undefined,400);
 await action({...nextAction,siteId:'receipt-other-site',expectedGeneration:0},400);
 assert.deepEqual(jobRow(first.id),stale);assert.deepEqual(downloads(),originalDownloads);
 t.diagnostic(JSON.stringify({synthetic:true,applyStatus:500,publicStatusAfterRestart:restarted.status,sharedStatusAfterRestart:stale.status,revision:saved.dataset.revision,imports:saved.imports.length,readings:saved.dataset.readingCount}));
 const next=(await action(nextAction,202)).job;
 assert.notEqual(next.id,first.id);const recovered=jobRow(first.id);
 assert.equal(recovered.status,'committed');assert.deepEqual(JSON.parse(recovered.result),saved.receipt.result);assert.deepEqual(JSON.parse(recovered.preview),saved.receipt);assert.equal(recovered.plan,stale.plan);assert.equal(recovered.stage_id,stale.stage_id);
 assert.equal(JSON.parse(jobRow(next.id).plan).datasetRevision,1);assert.equal(canonical(preview.stageId),before,'Recovery must not commit or change any canonical measurements/receipt/audit');
 assert.equal((await action(nextAction,202)).job.id,next.id);assert.equal((await action(firstAction,202)).job.id,first.id);
 assert.equal((await action({...nextAction,throughDate:'2026-01-03'},409)).code,'request-id-conflict');
 assert.equal((await action({...nextAction,requestId:'receipt-competing'},409)).code,'job-active');
 // The one newly authorized job can download, but still requires its own Apply.
 await waitForApproval(next.id);assert.equal(canonical(preview.stageId),before);
 const nextPreview=(await api(`/api/manual-vcom?siteId=${fixtureSiteId}&jobId=${next.id}`)).job;assert.equal(nextPreview.preview.baseRevision,1);
 assert.equal((await action({...nextAction,requestId:'receipt-third'},409)).code,'job-active');
 const requests=downloads();assert.equal(requests.length,stale.total_requests+jobRow(next.id).total_requests);assert.equal(new Set(requests.map(row=>JSON.stringify([row.path,row.query]))).size,requests.length);
 assert.equal(shared(db=>db.prepare('SELECT COUNT(*) n FROM vcom_manual_jobs').get().n),2);
 assert.equal(shared(db=>db.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n),0);assert.equal(shared(db=>db.prepare('SELECT COUNT(*) n FROM analysis_runs').get().n),0);
 await action({action:'cancel',jobId:next.id});assert.equal(jobRow(next.id).status,'canceled');assert.equal(canonical(preview.stageId),before);
 t.diagnostic(JSON.stringify({synthetic:true,nextStartStatus:202,reconciledSharedStatus:recovered.status,newPlanDatasetRevision:JSON.parse(jobRow(next.id).plan).datasetRevision,downloads:requests.length,uniqueDownloads:requests.length,canonicalUnchanged:true,analysisJobs:0}));
});
