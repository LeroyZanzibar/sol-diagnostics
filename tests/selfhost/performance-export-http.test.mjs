import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {LocalDatabase} from '../../selfhost/storage.mjs';

test('production CSV export is authenticated, complete, read-only and survives server restart', {timeout:30000}, async t=>{
  const directory=mkdtempSync(join(tmpdir(),'sol-export-http-'));
  const password=randomUUID(), reservation=createServer();
  reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=reservation.address().port;await new Promise((done,fail)=>reservation.close(e=>e?fail(e):done()));
  const base=`http://127.0.0.1:${port}`,authorization='Basic '+Buffer.from(`tester:${password}`).toString('base64');
  let child,logs='';
  async function stop(){if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await exited;}finally{clearTimeout(timer);}}}
  t.after(async()=>{await stop();rmSync(directory,{recursive:true,force:true});});
  async function start(){
    child=spawn(process.execPath,['selfhost/server.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),SOL_DATA_DIR:directory,SOL_USERNAME:'tester',SOL_PASSWORD:password},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',data=>{logs+=data;});child.stderr.on('data',data=>{logs+=data;});
    for(let attempt=0;attempt<150;attempt++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/healthz',{signal:AbortSignal.timeout(1000)})).ok)return;}catch{}await new Promise(done=>setTimeout(done,50));}
    throw Error('Server did not become ready: '+logs);
  }
  async function api(path,method='GET',body){const response=await fetch(base+path,{method,headers:{authorization,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;}
  await start();
  assert.equal((await fetch(base+'/api/performance-data/export?siteId=unknown')).status,401);
  const site=(await api('/api/site-settings','POST',{name:'Synthetic export site',country:'US',latitude:'35.2',longitude:'-80.8'})).site;
  await api('/api/equipment','PUT',{siteId:site.id,verified:false,equipment:[{id:'meter',name:'Revenue meter',externalId:'meter',type:'revenue_meter',parentId:null,quantity:1,aliases:[],channels:[]}]});
  const rows=[0,null,-5].map((value,i)=>({timestamp:new Date(Date.UTC(2026,10,1,5+i)).toISOString(),equipmentId:'meter',measurement:'Energy',unit:'kWh',value}));
  const preview=(await api('/api/performance-data','POST',{action:'preview',siteId:site.id,timezone:'UTC',timestampConvention:'start',intervalMinutes:60,readings:rows})).preview;
  await api('/api/performance-data','POST',{action:'commit',siteId:site.id,stageId:preview.stageId,previewToken:preview.previewToken,approveOverlap:false});
  const before=await api(`/api/performance-data?siteId=${site.id}`);
  async function download(){const response=await fetch(base+`/api/performance-data/export?siteId=${site.id}`,{headers:{authorization},signal:AbortSignal.timeout(15000)});assert.equal(response.status,200);assert.equal(response.headers.get('x-data-revision'),'1');assert.match(response.headers.get('content-disposition'),/attachment/);assert.match(response.headers.get('cache-control'),/no-store/);return response.text();}
  const text=await download();assert.equal(text.split('\r\n').filter(Boolean).length,4);assert.match(text,/2026-11-01T05:00:00.000Z,meter,Energy,0,kWh/);assert.match(text,/2026-11-01T06:00:00.000Z,meter,Energy,,kWh/);assert.match(text,/2026-11-01T07:00:00.000Z,meter,Energy,-5,kWh/);
  assert.deepEqual(await api(`/api/performance-data?siteId=${site.id}`),before);
  await stop();await start();assert.equal(await download(),text);
  const database=new LocalDatabase(join(directory,'sol-diagnostics.sqlite'),resolve('drizzle'));
  try {assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM analysis_jobs').get().n,0);}finally{database.close();}
});
