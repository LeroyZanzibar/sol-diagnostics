import {createHash} from 'node:crypto';
import {planVcomImport} from './vcom-provider.mjs';

const factors=new Map([['W/m²',1],['W/m2',1],['W/m^2',1],['kW/m²',1000],['kW/m2',1000],['kW/m^2',1000]]);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const nullable=x=>x===null||finite(x);
const requireProof=(condition)=>{if(!condition)throw Error('Measured POA evidence unavailable or inconsistent.');};
function retain(map,key,value,limit){if(map.size>=limit)map.delete(map.keys().next().value);map.set(key,value);return value;}
export function measuredPoaSource(siteId,plan,sensor){return {id:JSON.stringify(['measured-poa',1,siteId,'vcom',plan.systemKey,sensor.deviceId,'SRAD','W/m²']),siteId,provider:'vcom',systemKey:plan.systemKey,deviceId:sensor.deviceId,measurement:'SRAD',unit:'W/m²',name:sensor.name};}
/** Read only the current cell owner's bounded, pinned evidence. No raw provider
 * downloads, latest-import fallback, old revisions, or analytical-series stats. */
export class MeasuredPoaReader {
  constructor(database,bucket,siteId){Object.assign(this,{database,bucket,siteId});this.jobs=new Map();this.windows=new Map();this.failures=new Map();this.retryable=false;}
  async inspect(row){
    const owner=row.owner,source=owner?.metadata?.sourceImportId;
    if(owner?.metadata?.source!=='api'||typeof source!=='string'||!source.startsWith('vcom:'))return {candidates:[],value:null,reason:'No authenticated measured POA sensor evidence for this imported interval.'};
    let failedKey=null;
    try{
      const id=source.slice(5);let job=this.jobs.get(id);
      if(job===undefined){
        failedKey='job:'+id;requireProof(!this.failures.has(failedKey));
        const saved=await this.database.prepare('SELECT site_id,stage_id,status,result,plan,state FROM vcom_manual_jobs WHERE id=? AND length(plan)<=8388608 AND length(state)<=2097152').bind(id).first();
        requireProof(saved&&saved.status==='committed');
        const plan=JSON.parse(saved.plan),state=JSON.parse(saved.state),result=JSON.parse(saved.result);
        // The provider reproduces the exact immutable plan (including request
        // identities and unit eligibility). It performs no I/O on this path.
        const replay=planVcomImport({...plan,now:Date.parse(`${plan.throughDate}T12:00:00Z`)+172800000});
        requireProof(replay.planHash===plan.planHash&&JSON.stringify(replay)===JSON.stringify(plan));
        job=retain(this.jobs,id,{...saved,plan,state,result},4);
      }
      failedKey=null;
      const {plan,state,result}=job;
      requireProof(job.site_id===this.siteId&&plan.siteId===this.siteId&&plan.systemKey===plan.discovery.systemKey&&job.stage_id===owner.stageId&&result.siteId===this.siteId&&result.stageId===owner.stageId&&result.revision===owner.revision&&owner.metadata.originalObjectKey===`manual-vcom/${id}/manifest.json`&&owner.metadata.intervalMinutes===60&&owner.metadata.timezone===plan.timezone&&owner.metadata.modelRevision===plan.modelRevision);
      const mapping=plan.mappings.filter(m=>m.excluded!==true&&m.equipmentId===row.channel.equipmentId&&m.measurement===row.channel.measurement);
      requireProof(mapping.length===1&&row.channel.id===JSON.stringify([row.channel.equipmentId,row.channel.measurement,null]));
      const sourceInfo=plan.discovery.sources.find(s=>s.id===mapping[0].sourceId);
      requireProof(sourceInfo?.eligible===true&&sourceInfo.unit===row.channel.unit);
      const refs=state.windowObjects?.filter(w=>w.windowStartUtc<=row.timestamp&&w.windowEndUtc>row.timestamp);
      requireProof(refs?.length===1);const ref=refs[0];
      requireProof(plan.windows.some(w=>w.startUtc===ref.windowStartUtc&&w.endUtc===ref.windowEndUtc)&&ref.key===`manual-vcom/${id}/window-${plan.windows.findIndex(w=>w.startUtc===ref.windowStartUtc)}-${ref.sha256}.json`);
      const cacheKey=JSON.stringify([id,plan.planHash,ref]);let window=this.windows.get(cacheKey);
      if(!window){
        failedKey=cacheKey;requireProof(!this.failures.has(failedKey));
        requireProof(Number.isSafeInteger(ref.bytes)&&ref.bytes>0&&ref.bytes<=32*1024*1024);
        const object=await this.bucket.get(ref.key);requireProof(object&&object.size===ref.bytes);
        const text=await object.text();requireProof(Buffer.byteLength(text)===ref.bytes&&createHash('sha256').update(text).digest('hex')===ref.sha256);
        const data=JSON.parse(text);
        requireProof(data.version===1&&data.planHash===plan.planHash&&data.windowStartUtc===ref.windowStartUtc&&data.windowEndUtc===ref.windowEndUtc&&Array.isArray(data.quality)&&Array.isArray(data.readings)&&data.readings.length===ref.readings&&data.quality.length===ref.readings&&ref.readings<=5000);
        const readings=new Map(),qualities=new Map();
        for(const r of data.readings){const key=JSON.stringify([r.timestamp,r.equipmentId,r.measurement]);requireProof(!readings.has(key));readings.set(key,r);}
        for(const q of data.quality){const key=JSON.stringify([q.timestampStartUtc,q.sourceId]);requireProof(!qualities.has(key));qualities.set(key,q);}
        window=retain(this.windows,cacheKey,{readings,qualities},4);
      }
      failedKey=null;
      const reading=window.readings.get(JSON.stringify([row.timestamp,row.channel.equipmentId,row.channel.measurement])),q=window.qualities.get(JSON.stringify([row.timestamp,mapping[0].sourceId]));
      requireProof(reading&&q&&reading.value===row.value&&nullable(row.value)&&reading.unit===row.channel.unit&&new Date(row.timestamp).toISOString()===row.timestamp&&(Date.parse(row.timestamp)-Date.parse(plan.startUtc))%3600000===0);
      const candidates=plan.discovery.poaSensors.filter(s=>s.eligible===true&&s.kind==='poa'&&s.aggregation==='AVG'&&factors.has(s.sourceUnit)).map(s=>measuredPoaSource(this.siteId,plan,s));
      if(mapping[0].sourceId!=='irradiance:combined')return {candidates,value:null,carrier:false};
      requireProof(nullable(q.originalSatellite)&&nullable(q.originalPoa)&&nullable(q.selectedPoa)&&typeof q.poaPresent==='boolean'&&typeof q.satellitePresent==='boolean'&&q.selectedPoaSourceId===plan.selectedPoaSourceId);
      const chosen=q.originalSatellite!==null?'satellite':q.selectedPoa!==null?'poa':'missing';
      requireProof(q.chosenIrradianceSource===chosen&&(q.originalSatellite??q.selectedPoa)===row.value&&(q.originalSatellite===null||q.satellitePresent)&&q.sourceTimestampConvention==='end');
      if(plan.selectedPoaSourceId===null){requireProof(q.selectedPoa===null&&q.originalPoa===null&&!q.poaPresent);return {candidates,value:null,reason:'The owning import selected no measured POA sensor; satellite is not substituted.'};}
      const sensor=plan.discovery.poaSensors.find(s=>s.id===plan.selectedPoaSourceId);
      requireProof(sensor&&candidates.some(c=>c.deviceId===sensor.deviceId)&&sensor.id===`poa:${sensor.deviceId}`);
      const requests=plan.requests.filter(r=>r.ownedStartUtc<=row.timestamp&&r.ownedEndUtcExclusive>row.timestamp&&['satellite','poa'].includes(r.kind));
      const poa=requests.filter(r=>r.kind==='poa');
      requireProof(poa.length===1&&poa[0].deviceId===sensor.deviceId&&poa[0].abbreviation==='SRAD'&&Array.isArray(q.requestIds)&&JSON.stringify([...q.requestIds].sort())===JSON.stringify(requests.map(r=>r.requestId).sort()));
      requireProof(q.selectedPoa===(q.originalPoa===null?null:q.originalPoa*factors.get(sensor.sourceUnit))&&(q.originalPoa===null||q.poaPresent));
      return {candidates,sourceId:measuredPoaSource(this.siteId,plan,sensor).id,value:q.selectedPoa,reason:q.selectedPoa===null?'Measured POA sensor reading is missing; no substitute is used.':null};
    }catch{
      if(failedKey)retain(this.failures,failedKey,true,4);
      this.retryable=true;
      return {candidates:[],value:null,unavailable:true,reason:'Measured POA evidence is unavailable or inconsistent; excluded intervals will be retried.'};
    }
  }
}
