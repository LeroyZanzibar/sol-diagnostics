import {createHash} from 'node:crypto';
import {setImmediate as yieldNow} from 'node:timers/promises';
import {MonthlyStore} from './monthly-store.mjs';
import {fraction,add,multiply,projectionRows,MonthlyError} from '../app/monthly-domain.mjs';

const VERSION=2,HOUR=3600000;
const isExpected=channel=>channel.equipmentId==='@site'&&channel.measurement==='Expected Production'&&channel.unit==='kWh';
const IRRADIANCE=new Set(['Irradiance','POA irradiance','GHI irradiance']);
const formatters=new Map();
function localMonth(t,timezone){
  if(!formatters.has(timezone))formatters.set(timezone,new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit'}));
  const p=Object.fromEntries(formatters.get(timezone).formatToParts(t).map(v=>[v.type,v.value]));return `${p.year}-${p.month}`;
}
// Find the first instant of a local month, including midnight DST transitions.
function boundary(month,timezone){
  const [y,m]=month.split('-').map(Number),utc=Date.UTC(y,m-1,1);let lo=utc-3*24*HOUR,hi=utc+3*24*HOUR;
  while(lo<hi){const mid=Math.floor((lo+hi)/2);if(localMonth(mid,timezone)<month)lo=mid+1;else hi=mid;}return lo;
}
export function monthBounds(month,timezone){const [y,m]=month.split('-').map(Number),next=new Date(Date.UTC(y,m,1)).toISOString().slice(0,7);return {start:boundary(month,timezone),end:boundary(next,timezone)};}
function numericFraction(value){
  // Canonical numbers already use the importer's Number representation. Expand
  // scientific notation without introducing a second binary arithmetic step.
  const s=String(value);if(!/[eE]/.test(s))return fraction(s);
  const [mantissa,exponent]=s.toLowerCase().split('e'),e=Number(exponent),f=fraction(mantissa);
  return multiply(f,e>=0?{n:String(10n**BigInt(e)),d:'1'}:{n:'1',d:String(10n**BigInt(-e))});
}
function emptyMetric(){return {value:null,coveredMilliseconds:0,partialIntervals:0,unknownQualityIntervals:0,negativeIntervals:0,state:'missing'};}
const UNKNOWN_SOURCE='Imported irradiance; satellite/POA provenance unknown';

/** Resolve quality against each effective cell's committed owner, never latest metadata. */
class QualityReader {
  constructor(database,bucket,siteId){Object.assign(this,{database,bucket,siteId});this.jobs=new Map();this.windows=new Map();}
  async inspect(row){
    const owner=row.owner,source=owner.metadata.sourceImportId;
    if(!source?.startsWith('vcom:'))return {coverage:1,source:UNKNOWN_SOURCE};
    try{
      const id=source.slice(5);let job=this.jobs.get(id);
      if(job===undefined){
        // Read reporting evidence only; never read credentials or raw provider data.
        const saved=await this.database.prepare('SELECT site_id,stage_id,plan,state FROM vcom_manual_jobs WHERE id=?').bind(id).first();
        job=saved?{...saved,plan:JSON.parse(saved.plan),state:JSON.parse(saved.state)}:null;
        if(this.jobs.size>=16)this.jobs.delete(this.jobs.keys().next().value);this.jobs.set(id,job);
      }
      if(!job||job.site_id!==this.siteId||job.stage_id!==owner.stageId||job.plan.siteId!==this.siteId||owner.metadata.originalObjectKey!==`manual-vcom/${id}/manifest.json`)throw Error('Owner proof unavailable');
      const sourceId=isExpected(row.channel)?'simulation:expected':job.plan.mappings.find(m=>m.excluded!==true&&m.equipmentId===row.channel.equipmentId&&m.measurement===row.channel.measurement)?.sourceId;
      if(!sourceId)throw Error('Unknown source');
      const refs=job.state.windowObjects;
      const ref=refs?.find(w=>w.windowStartUtc<=row.timestamp&&w.windowEndUtc>row.timestamp);if(!ref)throw Error('Missing window');
      let window=this.windows.get(ref.key);
      if(!window){
        const object=await this.bucket.get(ref.key);
        if(!object||object.size!==ref.bytes||object.size>12*1024*1024)throw Error('Window size');
        const text=await object.text();if(createHash('sha256').update(text).digest('hex')!==ref.sha256)throw Error('Window digest');
        const data=JSON.parse(text);if(data.planHash!==job.plan.planHash||data.windowStartUtc!==ref.windowStartUtc||data.windowEndUtc!==ref.windowEndUtc||!Array.isArray(data.quality)||!Array.isArray(data.readings)||data.readings.length!==ref.readings)throw Error('Window identity');
        const qualities=new Map(),readings=new Map();
        for(const q of data.quality){const key=JSON.stringify([q.timestampStartUtc,q.sourceId]);if(qualities.has(key))throw Error('Duplicate quality');qualities.set(key,q);}
        for(const r of data.readings){const key=JSON.stringify([r.timestamp,r.equipmentId,r.measurement]);if(readings.has(key))throw Error('Duplicate reading');readings.set(key,r);}
        window={qualities,readings};if(this.windows.size>=4)this.windows.delete(this.windows.keys().next().value);this.windows.set(ref.key,window);
      }
      const q=window.qualities.get(JSON.stringify([row.timestamp,sourceId])),r=window.readings.get(JSON.stringify([row.timestamp,row.channel.equipmentId,row.channel.measurement]));
      if(!q||!r||r.value!==row.value||r.unit!==row.channel.unit||!Number.isInteger(q.expectedSamples)||!Number.isInteger(q.validSamples)||q.expectedSamples<=0||q.validSamples<=0||q.validSamples>q.expectedSamples||q.state!==(q.validSamples===q.expectedSamples?'complete':'partial'))throw Error('Invalid quality');
      if(sourceId==='irradiance:combined'){
        const chosen=q.originalSatellite!==null?q.originalSatellite:q.selectedPoa;
        const label=q.originalSatellite!==null?'satellite':'poa';
        if(chosen!==row.value||q.chosenIrradianceSource!==label||q.expectedSamples!==1)throw Error('Source arbitration');
        return {coverage:q.validSamples/q.expectedSamples,source:'Satellite-first with selected POA gap filling',chosen:label};
      }
      if(sourceId==='simulation:expected'&&(q.expectedSamples!==12||q.state==='partial'&&q.partialExpectedKwh!==row.value))throw Error('Simulation quality');
      return {coverage:q.validSamples/q.expectedSamples,source:UNKNOWN_SOURCE};
    }catch{return {coverage:0,unknown:true,source:UNKNOWN_SOURCE};}
  }
}

export class MonthlyService {
  constructor({database,bucket,performance}){Object.assign(this,{database,bucket,performance});this.inputs=new MonthlyStore(database);this.inflight=new Map();this.stopped=false;}
  selectionKey(configuration){return JSON.stringify(configuration.irradianceChannelId);}
  async calculate(siteId,configuration,dataset){
    const store=this.performance.site(siteId),revision=dataset.revision,selectionKey=this.selectionKey(configuration),channels=new Map(),expectedChannels=new Map();
    const scope={start:dataset.timestampStart,end:dataset.timestampEnd,measurements:['Expected Production',...IRRADIANCE]};
    for(const row of store.rows(revision,scope)){
      if(IRRADIANCE.has(row.channel.measurement)&&row.channel.unit==='W/m²')channels.set(row.channel.id,row.channel);
      if(isExpected(row.channel))expectedChannels.set(row.channel.id,row.channel);
    }
    // Imported explicit IDs are identities, not different expected semantics.
    // Competing series have no approved selection policy: never guess or sum.
    const expectedChannelId=expectedChannels.size===1?expectedChannels.keys().next().value:null;
    const expectedUnavailableReason=expectedChannels.size>1?'Hourly Expected Production is unavailable: multiple site-level Expected Production channels are imported. No series is selected or combined. Insolation and manual monthly data are unaffected.':null;
    const candidates=[...channels.values()].sort((a,b)=>a.id.localeCompare(b.id)),selected=configuration.irradianceChannelId??(candidates.length===1?candidates[0].id:null);
    const selectionRequired=candidates.length>1&&!configuration.irradianceChannelId||!!selected&&!channels.has(selected);
    const months={},bounds=new Map(),quality=new QualityReader(this.database,this.bucket,siteId);let count=0;
    for(const row of store.reportingRows(revision,scope)){
      if(++count%1000===0)await yieldNow();
      const kind=row.channel.id===expectedChannelId?'expected':row.channel.id===selected&&!selectionRequired?'insolation':null;
      if(!kind)continue;
      const start=Date.parse(row.timestamp),end=start+dataset.intervalMinutes*60000;
      const valid=typeof row.value==='number'&&Number.isFinite(row.value),q=valid?await quality.inspect(row):null;
      for(let t=start;t<end;){
        const month=localMonth(t,dataset.timezone);if(!bounds.has(month))bounds.set(month,monthBounds(month,dataset.timezone));const b=bounds.get(month),to=Math.min(end,b.end),duration=to-t;
        if(duration<=0)throw Error('Invalid reporting interval');
        const target=months[month]??={expected:emptyMetric(),insolation:{...emptyMetric(),source:UNKNOWN_SOURCE,satelliteIntervals:0,poaIntervals:0,unknownSourceIntervals:0},expectedMilliseconds:b.end-b.start};
        const metric=target[kind];
        if(valid){
          // For an interval crossing a month boundary, allocate energy uniformly
          // by elapsed overlap. Irradiance integrates only that covered overlap.
          const value=multiply(numericFraction(row.value),kind==='expected'?{n:String(duration),d:String(end-start)}:{n:String(duration),d:String(HOUR*1000)});
          metric.value=metric.value===null?value:add(metric.value,value);
          metric.coveredMilliseconds+=duration*q.coverage;
          if(q.unknown)metric.unknownQualityIntervals++;else if(q.coverage<1)metric.partialIntervals++;
          if(row.value<0)metric.negativeIntervals++;
          if(kind==='insolation'){if(q.chosen==='satellite')metric.satelliteIntervals++;else if(q.chosen==='poa')metric.poaIntervals++;else metric.unknownSourceIntervals++;}
        }
        t=to;
      }
    }
    for(const m of Object.values(months))for(const kind of ['expected','insolation']){
      const x=m[kind];x.state=x.value===null?'missing':x.coveredMilliseconds>=m.expectedMilliseconds&&!x.unknownQualityIntervals&&!x.partialIntervals?'complete':'partial';
      if(kind==='insolation')x.source=x.unknownSourceIntervals?UNKNOWN_SOURCE:x.satelliteIntervals+x.poaIntervals?'Satellite-first with selected POA gap filling':UNKNOWN_SOURCE;
    }
    return {state:'current',sourceRevision:revision,revisionId:dataset.revisionId,timezone:dataset.timezone,selectionKey,selectedChannelId:selected,selectionRequired,candidates,expectedChannelId,expectedUnavailableReason,months,calculationVersion:VERSION};
  }
  async refresh(siteId){
    if(this.inflight.has(siteId))return this.inflight.get(siteId);
    const work=this.refreshOnce(siteId).finally(()=>this.inflight.delete(siteId));this.inflight.set(siteId,work);return work;
  }
  async refreshOnce(siteId){
    const config=this.inputs.read(siteId).configuration;
    if(!this.performance.hasData(siteId))return {state:'missing',sourceRevision:0,timezone:null,months:{},candidates:[],selectionRequired:false,selectedChannelId:null,expectedChannelId:null,expectedUnavailableReason:null};
    const dataset=this.performance.site(siteId).describe(),key=this.selectionKey(config);
    const cached=await this.database.prepare('SELECT * FROM monthly_rollups WHERE site_id=?').bind(siteId).first();
    if(cached?.source_revision===dataset.revision&&cached.selection_key===key&&cached.calculation_version===VERSION)return JSON.parse(cached.payload_json);
    const payload=await this.calculate(siteId,config,dataset);
    // Shared settings and canonical revisions have separate commit boundaries.
    // Never publish an old generation over corrected inputs; a missed wake is
    // recovered by this head check on every read and the startup/periodic sweep.
    const published=this.database.withSynchronousWrite(write=>{
      const current=this.inputs.snapshot(write,siteId);
      if(this.selectionKey(current.configuration)!==key||this.performance.site(siteId).describe().revision!==dataset.revision)return false;
      write.run('INSERT INTO monthly_rollups VALUES (?,?,?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET source_revision=excluded.source_revision,selection_key=excluded.selection_key,calculation_version=excluded.calculation_version,payload_json=excluded.payload_json,updated_at=excluded.updated_at',siteId,dataset.revision,key,VERSION,JSON.stringify(payload),new Date().toISOString());return true;
    });
    return published?payload:{...payload,state:'refreshing'};
  }
  async read(siteId){
    let telemetry;for(let tries=0;tries<2;tries++){telemetry=await this.refresh(siteId);if(telemetry.state!=='refreshing')break;}
    const current=this.inputs.read(siteId),head=this.performance.hasData(siteId)?this.performance.site(siteId).describe().revision:0;
    if(head!==telemetry.sourceRevision||head>0&&this.selectionKey(current.configuration)!==telemetry.selectionKey)telemetry={...telemetry,state:'refreshing'};
    return {...current,projections:projectionRows(current.configuration),telemetry};
  }
  async validateSelection(siteId,configuration){
    if(configuration.irradianceChannelId===null)return;
    const view=await this.read(siteId);if(!view.telemetry.candidates.some(c=>c.id===configuration.irradianceChannelId))throw new MonthlyError('The selected reporting channel is not available. Reload channels.',409,'reporting-source-missing');
  }
  start(){this.stopped=false;const tick=()=>{if(!this.sweeping&&!this.stopped)this.sweeping=this.sweep().catch(error=>console.error('Monthly refresh:',error.message)).finally(()=>{this.sweeping=null;});};this.timer=setInterval(tick,15000);this.timer.unref();tick();}
  async sweep(){const sites=await this.database.prepare('SELECT id FROM site_settings ORDER BY id').all();for(const {id} of sites.results){if(this.stopped)return;if(this.performance.hasData(id))await this.refresh(id);}}
  async stop(){this.stopped=true;clearInterval(this.timer);await this.sweeping;await Promise.allSettled(this.inflight.values());}
}
