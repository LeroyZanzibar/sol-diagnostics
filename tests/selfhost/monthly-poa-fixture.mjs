// SYNTHETIC ONLY: real provider discovery/planning/normalization and controller
// checkpoints, native canonical commits. No production endpoint or live transport.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {loadSource} from '../source-module.mjs';
import * as provider from '../../selfhost/vcom-provider.mjs';
import {ManualVcomStore} from '../../selfhost/manual-vcom-store.mjs';
import {fixtureAuth,syntheticMetadata} from './manual-vcom-fixture.preload.mjs';
const clone=x=>JSON.parse(JSON.stringify(x));
export const syntheticPoaId=(siteId,deviceId='301')=>JSON.stringify(['measured-poa',1,siteId,'vcom','TEST1',deviceId,'SRAD','W/m²']);
export async function seedMeasuredPoa({database,bucket,performance,root,siteId='site',samples,timezone='UTC',deviceId='301',sensors=[{id:deviceId,name:'POA South',unit:'W/m²'}],selected=true,equipmentId='weather',fromDate,throughDate}){
  assert.ok(samples.length,'Supply explicit synthetic intervals');
  let now=Date.now();const store=performance.site(siteId),manual=new ManualVcomStore({database,dataDirectory:root,clock:()=>now});
  const values=new Map(samples.map(s=>[s.timestamp,s]));
  const date=t=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
  fromDate??=date(samples[0].timestamp);throughDate??=date(samples.at(-1).timestamp);
  const metadata=syntheticMetadata();metadata['/systems/TEST1'].data.timezone.name=timezone;
  metadata['/systems/TEST1/sensors']={data:sensors.map(s=>({id:s.id,name:s.name}))};
  for(const s of sensors){const path=`/systems/TEST1/sensors/${s.id}/abbreviations`;metadata[path]={data:['SRAD']};metadata[path+'/SRAD']={data:{unit:s.unit,aggregation:'AVG'}};}
  const fetchImpl=async(input)=>{
    const u=new URL(input);assert.equal(u.origin,'https://api.meteocontrol.de','Synthetic transport refuses other origins');
    const path=u.pathname.replace(/^\/v2/,'');if(metadata[path])return Response.json(metadata[path]);
    const a=Date.parse(u.searchParams.get('from')),b=Date.parse(u.searchParams.get('to')),iso=t=>new Date(t).toISOString();
    if(path.endsWith('/calculations/simulation'))return Response.json({data:Array.from({length:(b+1000-a)/300000},(_,i)=>{const t=a+i*300000,h=a+Math.floor(i/12)*3600000;return {timestamp:iso(t),expected:values.get(iso(h))?.expected==null?null:i%12===0?values.get(iso(h)).expected*12:0};})});
    if(path.endsWith('/satellite/irradiance'))return Response.json({data:Array.from({length:(b-a)/3600000+1},(_,i)=>{const t=a+i*3600000;return {timestamp:iso(t),value:values.get(iso(t-3600000))?.satellite??null};})});
    const match=/\/sensors\/([^/]+)\/abbreviations\/SRAD\/measurements$/.exec(path);assert.ok(match,'Only offline measured-POA fixture requests are supported: '+path);
    return Response.json({data:{[match[1]]:{SRAD:Array.from({length:(b+1000-a)/3600000},(_,i)=>{const t=a+i*3600000,s=values.get(iso(t));return {timestamp:iso(t+3600000),value:s?.poa??null};})}}});
  };
  const context=()=>({siteId,modelRevision:'synthetic-monthly-poa',dataset:store.describe(),store,equipment:[{id:equipmentId,type:'weather_sensor'}]});
  const bindings={Error,TypeError,SyntaxError,Uint8Array,AbortController,...provider,
    createVcomClient:options=>provider.createVcomClient({...clone(options),fetchImpl,minSpacingMs:0}),
    validateVcomMappings:options=>provider.validateVcomMappings(clone(options)),
    planVcomImport:options=>provider.planVcomImport(clone(options)),
    normalizeVcomWindow:options=>provider.normalizeVcomWindow(clone(options)),
    getManualVcomRuntime:()=>({store:manual,wake(){}}),getBucketBinding:()=>bucket,
    loadPerformanceContext:async()=>context(),assertPerformanceWritable:async()=>{},
    requiredText:x=>x,PerformanceValidationError:Error,PerformanceConflictError:Error,
    previewPerformanceProvider:async(ctx,metadata,batches)=>{
      async function* readings(){for await(const batch of batches)for(const row of batch)yield {timestamp:row.timestamp,value:row.value,channel:{id:JSON.stringify([row.equipmentId,row.measurement,null]),equipmentId:row.equipmentId,measurement:row.measurement,unit:row.unit}};}
      return store.stage({source:'api',fileName:'SYNTHETIC VCOM',intervalMinutes:60,modelRevision:ctx.modelRevision,...clone(metadata)},readings());
    },
    commitPerformancePreview:async(payload,actor)=>store.commit(payload.stageId,{previewToken:payload.previewToken,approveOverlap:payload.approveOverlap,modelRevision:context().modelRevision,actor}),
  };
  const controller=loadSource('app/api/manual-vcom/controller.ts',[],bindings),send=action=>controller.mutateManualVcom({siteId,...action},'synthetic-test');
  let generation=manual.settings(siteId).generation;
  await send({action:'configure',expectedGeneration:generation++,systemKey:'TEST1',credentials:fixtureAuth});
  await send({action:'discover',expectedGeneration:generation++});
  const mappings=manual.settings(siteId).discovery.sources.map(s=>({sourceId:s.id,measurement:s.measurement,equipmentId:s.kind==='irradiance'?equipmentId:s.kind==='simulation'?'@site':'',...(!['irradiance','simulation'].includes(s.kind)?{excluded:true}:{})}));
  await send({action:'mappings',expectedGeneration:generation++,mappings,selectedPoaSourceId:selected?`poa:${deviceId}`:null});
  const started=await send({action:'start',expectedGeneration:generation,requestId:randomUUID(),fromDate,throughDate}),id=started.job.id;
  for(let i=0;i<10000;i++){
    const job=manual.job(siteId,id);if(job.status==='awaiting_approval')break;
    assert.ok(['queued','downloading','staging'].includes(job.status),JSON.stringify({status:job.status,error:job.errorCode}));now+=3000;await controller.workManualVcom();
  }
  const staged=manual.job(siteId,id);assert.equal(staged.status,'awaiting_approval');
  await send({action:'apply',jobId:id,stageId:staged.stageId,previewToken:staged.preview.previewToken,approveOverlap:true});
  const job=manual.job(siteId,id);assert.equal(job.status,'committed');
  return {job,sourceId:syntheticPoaId(siteId,deviceId),channelId:JSON.stringify([equipmentId,'Irradiance',null])};
}
