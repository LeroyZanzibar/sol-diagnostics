import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {seedSyntheticSite,fixtureSiteId,fixtureLogin} from './manual-vcom-fixture.preload.mjs';
export async function monthlyFixture(t,{directory}={}){
  directory??=mkdtempSync(join(tmpdir(),'monthly-http-'));seedSyntheticSite(directory);
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const base=`http://127.0.0.1:${port}`,authorization='Basic '+Buffer.from(`${fixtureLogin.username}:${fixtureLogin.password}`).toString('base64');let child,logs='';
  async function start(){
    // Explicit synthetic environment; no inherited credential-file/public origin.
    child=spawn(process.execPath,['--import',resolve('tests/selfhost/manual-vcom-fixture.preload.mjs'),'selfhost/server.mjs'],{env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,HOST:'127.0.0.1',PORT:String(port),SOL_DATA_DIR:directory,SOL_USERNAME:fixtureLogin.username,SOL_PASSWORD:fixtureLogin.password,SOL_PASSWORD_FILE:'',SOL_PUBLIC_URL:base,SOL_TEST_VCOM_FIXTURE:'1',SOL_TEST_VCOM_TRACE:join(directory,'offline-provider.ndjson')},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',d=>{logs+=d;});child.stderr.on('data',d=>{logs+=d;});
    for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/healthz',{signal:AbortSignal.timeout(500)})).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Synthetic server did not start: '+logs);
  }
  async function stop(){if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),15000);try{await exit;}finally{clearTimeout(timer);}}writeFileSync(join(directory,'server.log'),logs);}
  async function request(path,body,status=200,extra={}){
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:authorization,'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data={text};}assert.equal(response.status,status,JSON.stringify(data)+'\n'+logs);return data;
  }
  const inspect=fn=>{const db=new DatabaseSync(join(directory,'sol-diagnostics.sqlite'),{readOnly:true});try{return fn(db);}finally{db.close();}};
  const commit=async(readings)=>{const {preview}=await request('/api/performance-data',{action:'preview',siteId:fixtureSiteId,timezone:'UTC',timestampConvention:'start',intervalMinutes:60,readings});await request('/api/performance-data',{action:'commit',siteId:fixtureSiteId,stageId:preview.stageId,previewToken:preview.previewToken,approveOverlap:true});return preview;};
  t?.after(stop);return {directory,base,authorization,siteId:fixtureSiteId,start,stop,request,inspect,commit};
}
