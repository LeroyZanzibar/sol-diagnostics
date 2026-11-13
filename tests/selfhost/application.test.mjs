import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

test('production app: authenticated setup, chunked import, analysis, review, maintenance and restart', {timeout:120000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'sol-app-')),password=randomUUID(),base='http://127.0.0.1:3083';
  let child,logs='';
  async function start(){
    child=spawn(process.execPath,['selfhost/server.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'3083',SOL_DATA_DIR:directory,SOL_PASSWORD:password,SOL_USERNAME:'tester'},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',d=>{logs+=d});child.stderr.on('data',d=>{logs+=d});
    for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(logs);try{if((await fetch(base+'/healthz')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('Server did not start: '+logs);
  }
  async function stop(){if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}}
  t.after(async()=>{await stop();rmSync(directory,{recursive:true,force:true});});
  const headers={Authorization:'Basic '+Buffer.from(`tester:${password}`).toString('base64')};
  async function api(path,method='GET',body){const response=await fetch(base+path,{method,headers:{...headers,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(data)}\n${logs}`);return data;}
  await start();
  assert.equal((await fetch(base+'/api/site-settings')).status,401);
  assert.equal((await fetch(base+'/api/site-settings',{method:'POST',headers:{...headers,Origin:'https://other.example','Content-Type':'application/json'},body:'{}'})).status,403);
  const html=await(await fetch(base+'/',{headers})).text();assert.ok(html.includes('Sol Diagnostics'));
  assert.deepEqual((await api('/api/site-settings')).sites,[]);
  const site=(await api('/api/site-settings','POST',{name:'Container test solar',country:'US',latitude:'35.2',longitude:'-80.8'})).site;
  const siteId=site.id;
  await api('/api/user-settings','PUT',{firstName:'Local',lastName:'Analyst',title:'Asset Manager',theme:'jade',minimumIssueLossKwh:''});
  const node=(id,type,parentId=null)=>({id,name:id,externalId:id,type,parentId,quantity:1,aliases:[],channels:[]});
  const equipment=[node('meter','revenue_meter'),{...node('transformer','transformer','meter'),nameplateKva:'200'},...['inv1','inv2'].flatMap(id=>[{...node(id,'inverter','transformer'),acRatedCapacityKw:'100',maxDcCapacityKw:'150'},{...node(id+'-modules','module_group',id),moduleRatedCapacityW:'400',quantity:300}]),node('weather','weather_sensor')];
  const model=await api('/api/equipment','PUT',{siteId,equipment,verified:true});assert.equal(model.equipment.length,7);assert.equal(model.verified,true);
  const lines=['Timestamp,Meter kWh,Inv1 kWh,Inv2 kWh,Expected kWh,Irradiance'];
  for(let day=1;day<=8;day++)for(let hour=0;hour<24;hour++){const light=hour>=8&&hour<=16;const healthy=light?60:0;const inv1=day===3||day===4?0:healthy;lines.push(`2026-05-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:00:00Z,${inv1+healthy},${inv1},${healthy},${healthy*2},${light?600:0}`);}
  const csv=Buffer.from(lines.join('\n')+'\n'),uploadId=randomUUID(),split=csv.indexOf(10,Math.floor(csv.length/2))+1;
  for(const [index,chunk] of [csv.subarray(0,split),csv.subarray(split)].entries()){const response=await fetch(`${base}/api/telemetry-imports/chunk?uploadId=${uploadId}&part=${index+1}`,{method:'PUT',headers,body:chunk});assert.equal(response.status,201,await response.text());}
  const metadata={uploadId,totalChunks:2,siteId,fileName:'test.csv',fileSize:csv.length,timezone:'UTC',mapping:{timestamp:'Timestamp',expectedProduction:'Expected kWh'},equipmentMapping:{signals:[{column:'Meter kWh',equipmentId:'meter',measurement:'Energy'},{column:'Inv1 kWh',equipmentId:'inv1',measurement:'Energy'},{column:'Inv2 kWh',equipmentId:'inv2',measurement:'Energy'},{column:'Irradiance',equipmentId:'weather',measurement:'Irradiance'}]},detectedTypes:['Energy','Irradiance'],validation:{totalRows:192,validRows:192,errors:0,timezone:'UTC',timestampConvention:'start',intervalMinutes:60,start:'2026-05-01T00:00:00Z',end:'2026-05-08T23:00:00Z'}};
  const imported=await api('/api/telemetry-imports/finalize','POST',metadata);assert.ok(imported.import.id);
  let analysis;for(let i=0;i<30;i++){analysis=await api(`/api/performance-summary?siteId=${siteId}`);if(!analysis.processing)break;}
  assert.equal(analysis.hasData,true,JSON.stringify(analysis));assert.ok(analysis.analysis.issues.length>0,'Should detect the offline inverter');
  const history=await api(`/api/analysis-history?siteId=${siteId}`);const runId=history.runs[0].id;
  const issue=analysis.analysis.issues[0];
  const reviewPath=`/api/issue-reviews?siteId=${siteId}&runId=${runId}&issueId=${issue.id}`;
  const review=await api(reviewPath);const state={...review.review.state,status:'Confirmed',classification:'Fuse Failure'};
  await api('/api/issue-reviews','POST',{siteId,runId,issueId:issue.id,baseVersion:review.review.version,state,note:'Local container test'});
  await api('/api/maintenance-data','POST',{revision:randomUUID(),baseRevision:'',fileName:'maintenance.csv',fileSize:100,rows:[{row:2,date:'2026-05-03',sourceSite:'Test',task:'Inspect string fuses',details:{}}],mappings:{Test:siteId}});
  const calendar=await api(`/api/maintenance-data?siteId=${siteId}&from=2026-05-01&through=2026-05-31`);assert.equal(calendar.entries[0].task,'Inspect string fuses');
  const oldLoss=analysis.analysis.issues.reduce((sum,item)=>sum+(item.estimatedLossKwh||0),0);
  await stop();await start();
  assert.equal((await api('/api/user-settings')).user.theme,'jade');
  assert.equal((await api(reviewPath)).review.state.status,'Confirmed');
  const again=await api(`/api/performance-summary?siteId=${siteId}`);assert.equal(again.hasData,true);assert.equal(again.analysis.issues.reduce((sum,item)=>sum+(item.estimatedLossKwh||0),0),oldLoss);
  assert.equal((await api(`/api/maintenance-data?siteId=${siteId}`)).entries.length,1);
  t.diagnostic(`Completed analysis with ${analysis.analysis.issues.length} findings and ${oldLoss} kWh; cached result and review survived restart.`);
});
