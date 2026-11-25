// SYNTHETIC ONLY. Run with Node24 from the repo; optional argv[2] is the
// evidence directory. SIGTERM stops the isolated built server cleanly.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {monthlyFixture} from './monthly-fixture.mjs';
import {seedMeasuredPoa} from './monthly-poa-fixture.mjs';
import {LocalDatabase,LocalBucket} from '../../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';
import {emptyConfiguration} from '../../app/monthly-domain.mjs';
export async function createPoaBrowserFixture({out,samples,timezone='America/New_York'}={}){
 out??=resolve('/opt/data/artifacts/sol-monthly-poa-sensor/implementation/browser');mkdirSync(out,{recursive:true});
 samples??=[{timestamp:'2026-01-31T23:00:00.000Z',poa:600,satellite:900,expected:12},{timestamp:'2026-02-01T04:00:00.000Z',poa:0,satellite:800,expected:0},{timestamp:'2026-02-01T05:00:00.000Z',poa:-10,satellite:700,expected:6},{timestamp:'2026-02-01T06:00:00.000Z',poa:null,satellite:500,expected:4}];
 const f=await monthlyFixture(),database=new LocalDatabase(join(f.directory,'sol-diagnostics.sqlite'),resolve('drizzle')),bucket=new LocalBucket(database,join(f.directory,'objects')),performance=new PerformanceStoreManager(join(f.directory,'performance'));
 try{
  await seedMeasuredPoa({database,bucket,performance,root:f.directory,siteId:f.siteId,samples,timezone});
  for(const [siteId,selected,sensors] of [['synthetic-poa-unselected',false,[{id:'301',name:'POA South',unit:'W/m²'}]],['synthetic-poa-multiple',true,[{id:'301',name:'POA South',unit:'W/m²'},{id:'302',name:'POA North',unit:'W/m²'}]]]){
   database.sqlite.prepare('INSERT INTO site_settings(id,name) VALUES(?,?)').run(siteId,siteId);
   await seedMeasuredPoa({database,bucket,performance,root:f.directory,siteId,samples,timezone,selected,sensors});
  }
 }finally{performance.close();database.close();}
 await f.start();
 for(const siteId of [f.siteId,'synthetic-poa-unselected','synthetic-poa-multiple']){
  const config={...emptyConfiguration(),operationsStart:'2026-01-01',degradation:'0',baselines:Object.fromEntries(Array.from({length:12},(_,i)=>[i+1,{production:'12000',revenue:'1000',insolation:'150'}]))};
  const post=body=>f.request('/api/monthly-data',{siteId,...body}),preview=await post({action:'preview',revision:0,configuration:config});await post({action:'configuration',revision:0,configuration:config,previewToken:preview.token});
  await post({action:'utility',revision:1,rows:[{month:'2026-01',onPeak:'8000.0000',offPeak:'4000.0000',unpaidEnergy:'0.123456789012345678',revenue:'1200',energyUsed:'0',invoiceCost:'-0.01'}]});
 }
 const descriptor={syntheticOnly:true,base:f.base,authorization:f.authorization,directory:f.directory,siteId:f.siteId,sites:[f.siteId,'synthetic-poa-unselected','synthetic-poa-multiple'],samples,timezone};
 writeFileSync(join(out,'fixture.json'),JSON.stringify(descriptor,null,2),{mode:0o600});
 writeFileSync(join(out,'monthly-readback.json'),JSON.stringify(await f.request(`/api/monthly-data?siteId=${f.siteId}`),null,2));
 return f;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const f=await createPoaBrowserFixture({out:process.argv[2]});console.log(JSON.stringify({ready:true,base:f.base,directory:f.directory,siteId:f.siteId}));
 let closing=false;async function stop(){if(closing)return;closing=true;await f.stop();process.exit(0);}process.on('SIGTERM',stop);process.on('SIGINT',stop);setInterval(()=>{},60000);
}
