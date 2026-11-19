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

// Real built-route acceptance. Everything is synthetic/offline; parent owns the
// production build. No installed application, customer data or provider is used.
test('saved exclusions survive restart and restrict actual imports without removing prior readings', {timeout:240000}, async t=>{
  const directory=mkdtempSync(join(tmpdir(),'manual-vcom-exclusion-http-'));
  seedSyntheticSite(directory);
  const trace=join(directory,'synthetic-requests.ndjson');
  const reservation=createServer();
  reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  const base=`http://127.0.0.1:${port}`;
  const authorization='Basic '+Buffer.from(`${fixtureLogin.username}:${fixtureLogin.password}`).toString('base64');
  let child,logs='';
  const inspect=operation=>{const db=new DatabaseSync(join(directory,'sol-diagnostics.sqlite'),{readOnly:true});try{return operation(db);}finally{db.close();}};
  const inspectSite=operation=>{const manager=new PerformanceStoreManager(join(directory,'performance'));try{return operation(manager.site(fixtureSiteId));}finally{manager.close();}};
  const start=async()=>{
    child=spawn(process.execPath,['--import',resolve('tests/selfhost/manual-vcom-fixture.preload.mjs'),'selfhost/server.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),SOL_DATA_DIR:directory,SOL_USERNAME:fixtureLogin.username,SOL_PASSWORD:fixtureLogin.password,SOL_PASSWORD_FILE:'',SOL_TEST_VCOM_FIXTURE:'1',SOL_TEST_VCOM_TRACE:trace},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',value=>{logs+=value;});child.stderr.on('data',value=>{logs+=value;});
    for(let i=0;i<200;i++){
      if(child.exitCode!==null)throw Error(logs);
      try{if((await fetch(base+'/healthz',{signal:AbortSignal.timeout(500)})).ok)return;}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw Error('Synthetic server did not start: '+logs);
  };
  const stop=async()=>{
    if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);try{await exit;}finally{clearTimeout(timer);}}
  };
  t.after(async()=>{await stop();rmSync(directory,{recursive:true,force:true});});
  const request=async(path,body,status=200)=>{
    // Local discovery includes multiple individually bounded, rate-spaced
    // provider calls. This overall fixture deadline is not a network timeout.
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:authorization,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
    const text=await response.text();let json;try{json=JSON.parse(text);}catch{json={text:text.slice(0,400)};}
    assert.equal(response.status,status,JSON.stringify(json)+'\n'+logs);return json;
  };
  const action=(body,status=200)=>request('/api/manual-vcom',{siteId:fixtureSiteId,...body},status);
  const workspace=()=>request('/api/manual-vcom?siteId='+fixtureSiteId);
  const waitForPreview=async id=>{
    const end=Date.now()+60000;
    while(Date.now()<end){
      const state=inspect(db=>db.prepare('SELECT status,error_code FROM vcom_manual_jobs WHERE id=?').get(id));
      assert.ok(state&&!['failed','canceled'].includes(state.status),JSON.stringify(state));
      if(state.status==='awaiting_approval')return (await request(`/api/manual-vcom?siteId=${fixtureSiteId}&jobId=${id}`)).job;
      if(child.exitCode!==null)throw Error(logs);
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Synthetic excluded import did not reach preview: '+logs);
  };
  const exclude=m=>({...m,equipmentId:'',excluded:true});
  const allExcluded=fixtureMappings.map(exclude);
  await start();
  await action({action:'configure',expectedGeneration:0,systemKey:'TEST1',credentials:fixtureAuth});
  await action({action:'discover',expectedGeneration:1});
  const disabled=await action({action:'mappings',expectedGeneration:2,mappings:allExcluded,selectedPoaSourceId:null});
  assert.deepEqual(disabled.settings.mappings,allExcluded);
  assert.equal(disabled.settings.ready,false);
  await action({action:'start',expectedGeneration:disabled.settings.generation,requestId:'excluded-all-must-not-start',fromDate:'2026-01-01',throughDate:'2026-01-01'},400);
  assert.equal(inspect(db=>db.prepare('SELECT COUNT(*) n FROM vcom_manual_jobs').get().n),0);
  await stop();await start();
  assert.deepEqual((await workspace()).settings.mappings,allExcluded);

  const restored=await action({action:'mappings',expectedGeneration:disabled.settings.generation,mappings:fixtureMappings,selectedPoaSourceId:'poa:301'});
  const original=await action({action:'start',expectedGeneration:restored.settings.generation,requestId:'initial-full-import',fromDate:'2026-01-01',throughDate:'2026-01-01'},202);
  const first=await waitForPreview(original.job.id);
  await action({action:'apply',jobId:first.id,stageId:first.stageId,previewToken:first.preview.previewToken,approveOverlap:false});
  const oldRows=inspectSite(store=>[...store.rows()]);
  const oldDataset=inspectSite(store=>store.describe());
  assert.equal(oldRows.length,24*fixtureMappings.length);
  assert.equal(oldDataset.channelCount,fixtureMappings.length);

  const includedId='inverter:101:E_INT';
  const selective=fixtureMappings.map(m=>m.sourceId===includedId?m:exclude(m));
  const saved=await action({action:'mappings',expectedGeneration:restored.settings.generation,mappings:selective,selectedPoaSourceId:null});
  assert.equal(saved.settings.ready,true);
  assert.deepEqual(saved.settings.mappings,selective);
  await stop();await start();
  assert.deepEqual((await workspace()).settings.mappings,selective);
  const refreshed=await action({action:'discover',expectedGeneration:saved.settings.generation});
  assert.deepEqual(refreshed.settings.mappings,selective,'Discovery must not re-include excluded fields');
  const beforeTrace=readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).length;
  const next=await action({action:'start',expectedGeneration:refreshed.settings.generation,requestId:'only-one-inverter-import',fromDate:'2026-01-02',throughDate:'2026-01-02'},202);
  const nextPreview=await waitForPreview(next.job.id);
  const plan=inspect(db=>JSON.parse(db.prepare('SELECT plan FROM vcom_manual_jobs WHERE id=?').get(next.job.id).plan));
  assert.deepEqual(plan.requests.map(r=>r.kind),['inverterBulk']);
  assert.equal(plan.readingCount,24);
  assert.deepEqual(plan.mappings,selective.toSorted((a,b)=>a.sourceId.localeCompare(b.sourceId)));
  assert.equal(nextPreview.preview.channelCount,1);
  assert.equal(nextPreview.preview.readingCount,24);
  assert.equal(nextPreview.quality.sources,1);
  assert.equal(inspectSite(store=>store.describe().revision),oldDataset.revision,'Preview cannot mutate the dataset');
  const requests=readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).slice(beforeTrace).map(line=>JSON.parse(line));
  assert.equal(requests.length,1);
  assert.match(requests[0].path,/\/inverters\/bulk\/measurements$/);
  await action({action:'apply',jobId:nextPreview.id,stageId:nextPreview.stageId,previewToken:nextPreview.preview.previewToken,approveOverlap:false});
  await stop();await start();
  const rows=inspectSite(store=>[...store.rows()]);
  const newRows=rows.filter(row=>row.timestamp>='2026-01-02T00:00:00.000Z');
  const retained=rows.filter(row=>row.timestamp<'2026-01-02T00:00:00.000Z');
  assert.deepEqual(retained,oldRows,'Excluded historical channels and all existing values must remain unchanged');
  assert.equal(newRows.length,24);
  assert.ok(newRows.every(row=>row.channel.equipmentId==='inv1'&&row.channel.measurement==='Energy'&&row.value===2));
  assert.equal(inspectSite(store=>store.describe().readingCount),oldRows.length+24);
  assert.equal(inspectSite(store=>store.describe().channelCount),oldDataset.channelCount);
  assert.equal(inspectSite(store=>store.imports().length),2);
  assert.equal(inspect(db=>db.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n),0);
  assert.equal(inspect(db=>db.prepare('SELECT COUNT(*) n FROM analysis_runs').get().n),0);
  const output=JSON.stringify(await workspace());
  for(const secret of [fixtureAuth.apiKey,fixtureAuth.username,fixtureAuth.password])assert.ok(!output.includes(secret));
});
