import { arrayCapacityModel, deliveredInverterEnergy, type CapacityAsset } from "../../array-capacity";
import { solarPosition } from './causes';
import { localDate } from '../../telemetry-time';

type Point = { timestamp: string; energyKwh: number };
type Asset = CapacityAsset & { id: string; name: string; type: string; parentId?: string | null; externalId: string; acRatedCapacityKw?: string; acLineLossPercent?: string; transformerLossPercent?: string };
type Production = { equipmentId: string; equipmentName: string; equipmentType: string; capacityKw: number; externalId: string; intervalProduction?: Point[]; dailyProduction: { date: string; energyKwh: number }[]; readingCount: number; source: string };
type Summary = { timezone?: string; intervalMinutes?: number; timestamps?: string[]; equipmentProduction?: Production[]; expectedProduction?: Point[];
  intervalIrradiance?: { timestamp: string; averageWm2: number }[]; causeContext?: { latitude: string; longitude: string; timeZone: string };
  dailyProduction: { date: string; energyKwh: number }[]; totalEnergyKwh: number; latestDate: string; latestDayEnergyKwh: number;
  telemetryQuality?: Record<string, unknown> };
type Loss = { timestamp: string; lossKwh: number; countedLossKwh?: number; actualKwh?: number; expectedKwh?: number; [key: string]: unknown };
type Issue = { id: string; name: string; type: string; category: string; confidence: string; severity: string; equipmentId: string; equipmentName: string; equipmentType: string; equipmentExternalId: string;
  startDateTime: string; endDateTime: string; durationMinutes: number; durationDays: number; estimatedLossKwh: number; lossPercent: number; siteImpactPercent: number;
  actualEnergyKwh: number; expectedEnergyKwh: number; description: string; lossUnknown?: boolean; productionUnknown?: boolean; affectedEquipment?: { id: string; name: string }[]; evidence?: Record<string, unknown> };
type Event = { timestamp: string; type: 'Site outage' | 'Partial site outage' | 'Site telemetry outage' | 'Equipment telemetry issue' | 'Communication issue'; ids: Set<string>; loss: number; actual: number; expected: number; unknown: boolean; productionUnknown: boolean; coverage: number; reason: string };
export type TelemetryPlan = { events: Event[]; blocked: Map<string, Set<string>>; minutes: number; allIds: Set<string>; meter: Asset | undefined; assets: Asset[]; inferred: Map<string, Set<string>> };
const hasZone = (value: string) => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
const time = (s: string) => Date.parse(hasZone(s) ? s : s + 'Z');
const stamp = (n: number, reference: string) => hasZone(reference) ? new Date(n).toISOString() : new Date(n).toISOString().slice(0,19);
const siteDay = (timestamp: string, timezone: string) => hasZone(timestamp) ? localDate(timestamp, timezone) : timestamp.slice(0,10);
const capacity = (e: Asset) => Math.max(0, Number(e.acRatedCapacityKw) || 0);
const daily = (points: Point[], timezone: string) => {
  const days = new Map<string, number>();
  for (const p of points) {
    const day = siteDay(p.timestamp, timezone);
    days.set(day, (days.get(day) || 0) + p.energyKwh);
  }
  return [...days].sort(([a],[b])=>a.localeCompare(b)).map(([date,energyKwh])=>({date,energyKwh}));
};

/** Keep raw missing readings missing; only supported substitutions enter detection. */
export function prepareTelemetry(summary: Summary, assets: Asset[]): TelemetryPlan {
  const minutes = summary.intervalMinutes || 60, cadence = minutes * 60000;
  const timezone = summary.timezone || summary.causeContext?.timeZone || 'UTC';
  const meter = assets.find(a=>a.type==='revenue_meter');
  const capacityModel=arrayCapacityModel(assets);
  const inverters = assets.filter(a=>a.type==='inverter');
  const allIds = new Set(assets.filter(a=>a.type==='inverter'||a.type==='revenue_meter').map(a=>a.id));
  const totalCapacity = inverters.reduce((s,a)=>s+capacity(a),0);
  const series = summary.equipmentProduction || [];
  const raw = new Map(series.map(p=>[p.equipmentId,new Map((p.intervalProduction || []).map(v=>[v.timestamp,v.energyKwh]))]));
  // Most series are unchanged. Copy only series that receive a supported
  // substitution, avoiding a second year of inverter maps and point objects.
  const next = new Map(raw);
  const meterRaw = raw.get(meter?.id || '') || new Map<string,number>();
  const meterNext = new Map(meterRaw);
  const expected = new Map((summary.expectedProduction || []).map(p=>[p.timestamp,p.energyKwh]));
  const irradiance = new Map((summary.intervalIrradiance || []).map(p=>[p.timestamp,p.averageWm2]));
  const keys = new Set([...(summary.timestamps || []), ...expected.keys(), ...irradiance.keys()]);
  for (const values of raw.values()) for (const t of values.keys()) keys.add(t);
  const ordered = [...keys].sort();
  // Also classify absent CSV rows inside the reported range, without inventing
  // evidence before or after the uploaded period.
  if (ordered.length) for (let t=time(ordered[0]); t<=time(ordered.at(-1)!); t+=cadence) keys.add(stamp(t, ordered[0]));
  const factor = (1-Math.min(100,Math.max(0,Number(meter?.acLineLossPercent)||0))/100)*(1-Math.min(100,Math.max(0,Number(meter?.transformerLossPercent)||0))/100);
  let formatter: Intl.DateTimeFormat | undefined;
  const context=summary.causeContext, lat=Number(context?.latitude), lon=Number(context?.longitude);
  if(context?.latitude.trim() && context.longitude.trim() && Number.isFinite(lat)&&Number.isFinite(lon)) {
    try { formatter=new Intl.DateTimeFormat('en-US',{timeZone:context.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}); } catch { /* Day/night remains unknown without a valid timezone. */ }
  }
  const events: Event[] = [], blocked=new Map<string,Set<string>>(), inferred=new Map<string,Set<string>>();
  const previousDown=new Map<string,boolean>(), lastKnownPositive=new Map<string,number>(), onset=new Map<string,number>();
  let activeCohort=new Set<string>();
  const nightMissingCounts: Record<string,number> = {};
  const nightMissing: string[]=[], unknownProduction: string[]=[], substituted: string[]=[];
  const block=(id:string,t:string)=>{const times=blocked.get(id)||new Set<string>();times.add(t);blocked.set(id,times);};
  const blockAll=(t:string)=>allIds.forEach(id=>block(id,t));
  for(const timestamp of [...keys].sort()) {
    const moment=time(timestamp), exp=expected.get(timestamp), sun=irradiance.get(timestamp);
    const elevations=formatter?[0,.5,1].map(offset=>solarPosition(stamp(moment+cadence*offset, timestamp),lat,lon,formatter!).elevation):[];
    const night=elevations.length>0&&Math.max(...elevations)<-6 && !(exp!>0) && !(sun!>=50);
    const qualified=(sun!==undefined?sun>=50:(exp || 0)>0);
    const values=inverters.map(asset=>({asset,value:raw.get(asset.id)?.get(timestamp)}));
    const reported=values.filter(v=>v.value!==undefined), producing=reported.filter(v=>v.value!>0);
    const missing=values.filter(v=>v.value===undefined);
    const knownCapacity=reported.reduce((s,v)=>s+capacity(v.asset),0), coverage=totalCapacity>0?knownCapacity/totalCapacity:0;
    const complete=totalCapacity>0&&knownCapacity>=totalCapacity-1e-6;
    const aggregate=capacityModel.hasTransformers?deliveredInverterEnergy(capacityModel,new Map(reported.map(v=>[v.asset.id,v.value!])),minutes/60):reported.reduce((s,v)=>s+v.value!,0)*factor;
    const meterValue=meterRaw.get(timestamp);
    const push=(type:Event['type'],ids:Set<string>,unknown:boolean,actual:number,reason:string,productionUnknown=false)=>events.push({timestamp,type,ids:new Set(ids),loss:unknown?0:Math.max(0,(exp??actual)-actual),actual,expected:exp??0,unknown,productionUnknown,coverage,reason});
    if(night) {
      for (const asset of assets.filter(a=>allIds.has(a.id))) if(raw.get(asset.id)?.get(timestamp)===undefined) nightMissingCounts[asset.id]=(nightMissingCounts[asset.id]||0)+1;
      if(meterValue===undefined) {meterNext.set(timestamp,0);nightMissing.push(timestamp);}
      blockAll(timestamp); continue;
    }
    if(meterValue===undefined && reported.length===0) {
      push('Site telemetry outage',new Set(allIds),true,0,'Meter and all inverter readings are missing; physical production is unknown.',true);
      unknownProduction.push(timestamp);blockAll(timestamp);activeCohort=new Set<string>();continue;
    }
    if((meterValue===undefined||meterValue<=0) && producing.length>0) {
      push('Communication issue',new Set(meter?[meter.id]:[]),!complete,aggregate,complete?'Meter is missing or zero while the complete inverter fleet reports production; delivered inverter energy substitutes for the meter.':'Meter is missing or zero while some inverters produce; incomplete capacity coverage cannot establish total site production.',!complete);
      if(complete) {meterNext.set(timestamp,aggregate);substituted.push(timestamp);blockAll(timestamp);} else {meterNext.delete(timestamp);unknownProduction.push(timestamp);}
      if(meter)block(meter.id,timestamp);
      // Partial inverter coverage stays unknown; do not infer missing inverters offline.
      for(const v of missing)block(v.asset.id,timestamp);
      if(missing.length)push('Equipment telemetry issue',new Set(missing.map(v=>v.asset.id)),true,0,'Inverter telemetry is missing and the meter is unavailable; outage status is unknown.',true);
      continue;
    }
    if(qualified && meterValue===undefined && coverage>=.95 && reported.length>0 && reported.every(v=>v.value===0)) {
      push('Site outage',new Set(allIds),exp===undefined,0,'Meter is missing, but valid zero readings cover at least 95% of site AC capacity. Probable site outage; production is estimated from the reporting fleet.');
      meterNext.set(timestamp,0);substituted.push(timestamp);blockAll(timestamp);activeCohort=new Set<string>();continue;
    }
    if(qualified && meterValue!==undefined && meterValue<=Math.max(.001,(exp || 0)*.05) && producing.length===0) {
      push('Site outage',new Set(allIds),exp===undefined,meterValue,'Valid meter production is near zero during qualified daylight, with no contradicting inverter production.');
      blockAll(timestamp);activeCohort=new Set<string>();continue;
    }
    if(meterValue===undefined) {unknownProduction.push(timestamp);if(meter)block(meter.id,timestamp);push('Communication issue',new Set(meter?[meter.id]:[]),true,aggregate,'Meter is missing and inverter coverage is insufficient to establish total site production.',true);}
    const deficit=meterValue!==undefined&&exp!==undefined?Math.max(0,exp-meterValue):0;
    const matchesRemaining=meterValue!==undefined&&Math.abs(meterValue-aggregate)<=Math.max(1,meterValue*.12,(exp||0)*.04);
    const missingSupported=qualified&&meterValue!==undefined&&meterValue>0&&exp!==undefined&&meterValue<=exp*.8&&producing.length>0&&matchesRemaining;
    const down=new Set<string>();
    if(qualified) for(const v of values) {
      const share=totalCapacity>0?(exp||0)*capacity(v.asset)/totalCapacity:0;
      const isDown=v.value===0 || (v.value===undefined&&missingSupported) || (v.value!==undefined&&share>0&&v.value/share<.3);
      if(isDown)down.add(v.asset.id);
      const recentlyOperating=(lastKnownPositive.get(v.asset.id)??-Infinity)>=moment-cadence*2;
      if(isDown&&previousDown.get(v.asset.id)===false&&recentlyOperating)onset.set(v.asset.id,moment);
      if(v.value!==undefined&&v.value>0)lastKnownPositive.set(v.asset.id,moment);
      previousDown.set(v.asset.id,isDown);
      if(v.value===undefined&&missingSupported) {
        const previous=next.get(v.asset.id);const values=previous&&previous!==raw.get(v.asset.id)?previous:new Map(previous);values.set(timestamp,0);next.set(v.asset.id,values);
        const times=inferred.get(v.asset.id)||new Set<string>();times.add(timestamp);inferred.set(v.asset.id,times);
      }
    }
    const cohort=new Set([...activeCohort,...[...onset].filter(([,t])=>moment-t<=cadence).map(([id])=>id)].filter(id=>down.has(id)));
    const affectedCapacity=inverters.filter(a=>cohort.has(a.id)).reduce((s,a)=>s+capacity(a),0);
    if(qualified&&meterValue!==undefined&&meterValue>0&&deficit>0&&producing.length>0&&cohort.size>=3&&totalCapacity>0&&affectedCapacity/totalCapacity>=.2&&matchesRemaining) {
      push('Partial site outage',cohort,false,meterValue,'A synchronized loss of at least three inverters and 20% of AC capacity is corroborated by the meter and the remaining producing fleet.');
      activeCohort=cohort;
    } else activeCohort=new Set<string>();
    const unresolved=missing.filter(v=>!missingSupported);
    if(unresolved.length) {
      unresolved.forEach(v=>block(v.asset.id,timestamp));
      push('Equipment telemetry issue',new Set(unresolved.map(v=>v.asset.id)),true,0,meterValue!==undefined&&exp!==undefined&&meterValue>=exp*.8?'Missing inverter readings while the meter shows substantial site production; telemetry loss is supported.':'Inverter readings are missing; available production evidence does not establish an outage.',meterValue===undefined);
    }
  }
  if(meter)next.set(meter.id,meterNext);
  summary.equipmentProduction=series.map(p=>{const values=next.get(p.equipmentId);const points=values===raw.get(p.equipmentId)?p.intervalProduction||[]:[...(values||new Map())].sort(([a],[b])=>a.localeCompare(b)).map(([timestamp,energyKwh])=>({timestamp,energyKwh}));return {...p,intervalProduction:points,dailyProduction:daily(points,timezone)};});
  const sitePoints=[...meterNext].sort(([a],[b])=>a.localeCompare(b)).map(([timestamp,energyKwh])=>({timestamp,energyKwh}));
  summary.dailyProduction=daily(sitePoints,timezone);summary.totalEnergyKwh=sitePoints.reduce((s,p)=>s+p.energyKwh,0);
  const lastTimestamp = [...keys].sort().at(-1);
  summary.latestDate=lastTimestamp?siteDay(lastTimestamp,timezone):'';summary.latestDayEnergyKwh=summary.dailyProduction.at(-1)?.energyKwh||0;
  summary.telemetryQuality={version:1,nighttimeImputedIntervals:nightMissing,unknownProductionIntervals:unknownProduction,substitutedIntervals:substituted,missingReadingsPreserved:true,nighttimeMissingReadingCounts:nightMissingCounts,coverageBasis:'configured inverter AC capacity'};
  return {events,blocked,minutes,allIds,meter,assets,inferred};
}

/** Remove covered intervals (not just their loss), retaining independent periods. */
export function reconcileTelemetry<T extends Issue>(issues:T[], plan:TelemetryPlan):T[] {
  const {events,blocked,minutes,meter,assets}=plan, cadence=minutes*60000;
  const partial=new Map(events.filter(e=>e.type==='Partial site outage').map(e=>[e.timestamp,e]));
  const independent=new Map<string,number>();
  for(const issue of issues) for(const p of (issue.evidence?.intervalLosses || []) as Loss[]) {
    const event=partial.get(p.timestamp);
    if(event&&issue.equipmentType==='inverter'&&!event.ids.has(issue.equipmentId)) independent.set(p.timestamp,(independent.get(p.timestamp)||0)+Math.max(0,p.countedLossKwh??p.lossKwh));
  }
  const remaining:T[]=[];
  for(const sourceIssue of issues) {
    const inferredCount=((sourceIssue.evidence?.intervalLosses || []) as Loss[]).filter(p=>plan.inferred.get(sourceIssue.equipmentId)?.has(p.timestamp)).length;
    const issue=inferredCount?{...sourceIssue,description:sourceIssue.description+" Missing production readings were estimated as zero only where the meter corroborates loss of that production.",evidence:{...sourceIssue.evidence,inferredMissingIntervalCount:inferredCount}}:sourceIssue;
    const original=(issue.evidence?.intervalLosses || []) as Loss[];
    if(!original.length){remaining.push(issue);continue;}
    let changed=false;const groups:Loss[][]=[];let gap=false;
    for(const point of original) {
      const parent=partial.get(point.timestamp);
      const covered=blocked.get(issue.equipmentId)?.has(point.timestamp) || (parent&&(parent.ids.has(issue.equipmentId)||issue.equipmentType==='revenue_meter')) || (point.countedLossKwh===0&&point.lossKwh>0);
      if(covered){changed=true;gap=true;continue;}
      const p={...point};
      if(parent) {const total=independent.get(p.timestamp)||0;const factor=total>parent.loss?parent.loss/total:1;p.lossKwh=Math.max(0,p.countedLossKwh??p.lossKwh)*factor;p.countedLossKwh=p.lossKwh;if(factor<1)changed=true;}
      if(!groups.length||gap)groups.push([]);groups.at(-1)!.push(p);gap=false;
    }
    if(!changed){remaining.push(issue);continue;}
    for(const [index,group] of groups.entries()) {
      const loss=group.reduce((s,p)=>s+Math.max(0,p.countedLossKwh??p.lossKwh),0);if(loss<=0)continue;
      const start=group[0].timestamp,end=stamp(time(group.at(-1)!.timestamp)+cadence, start),duration=(time(end)-time(start))/60000;
      const actual=group.reduce((s,p)=>s+(p.actualKwh||0),0),expected=group.reduce((s,p)=>s+(p.expectedKwh||0),0);
      remaining.push({...issue,id:`${issue.id}-visible-${index}`,startDateTime:start,endDateTime:end,durationMinutes:duration,durationDays:duration/1440,estimatedLossKwh:loss,actualEnergyKwh:actual,expectedEnergyKwh:expected,lossPercent:expected?100*loss/expected:0,evidence:{...issue.evidence,intervalLosses:group,originalIssueId:issue.id}});
    }
  }
  const grouped=new Map<string,Event[][]>();
  for(const e of events) {
    if(e.type==='Partial site outage')e.loss=Math.max(0,e.loss-(independent.get(e.timestamp)||0));
    const key=`${e.type}|${e.unknown}|${e.productionUnknown}|${e.type==='Equipment telemetry issue'?[...e.ids].sort().join(','):''}`;
    const groups=grouped.get(key)||[];const last=groups.at(-1);
    if(last&&time(e.timestamp)-time(last.at(-1)!.timestamp)===cadence)last.push(e);else groups.push([e]);grouped.set(key,groups);
  }
  for(const groups of grouped.values()) for(const group of groups) {
    const first=group[0],last=group.at(-1)!,ids=new Set(group.flatMap(e=>[...e.ids]));
    const affectedEquipment=assets.filter(a=>ids.has(a.id)&&a.type==='inverter').map(a=>({id:a.id,name:a.name}));
    const unknown=first.unknown,loss=group.reduce((s,e)=>s+e.loss,0),actual=group.reduce((s,e)=>s+e.actual,0),expected=group.reduce((s,e)=>s+e.expected,0);
    const end=stamp(time(last.timestamp)+cadence, last.timestamp),duration=(time(end)-time(first.timestamp))/60000;
    const total=assets.filter(a=>a.type==='inverter').reduce((s,a)=>s+capacity(a),0);
    const share=total?assets.filter(a=>ids.has(a.id)&&a.type==='inverter').reduce((s,a)=>s+capacity(a),0)/total*100:100;
    const performance=first.type==='Site outage'||first.type==='Partial site outage';
    const owner=meter||assets.find(a=>ids.has(a.id));if(!owner)continue;
    remaining.push({id:`${owner.id}-${first.type.replaceAll(' ','-')}-${first.timestamp}`,name:first.type==='Communication issue'?'Revenue meter communication issue':first.type,type:first.type,
      category:performance?'Performance':'Communications',confidence:performance?'model-based':'confirmed',severity:performance?'critical':'high',equipmentId:owner.id,equipmentName:owner.name,equipmentType:owner.type,equipmentExternalId:owner.externalId,
      startDateTime:first.timestamp,endDateTime:end,durationMinutes:duration,durationDays:duration/1440,estimatedLossKwh:loss,lossPercent:expected?100*loss/expected:0,actualEnergyKwh:actual,expectedEnergyKwh:expected,
      lossUnknown:unknown,productionUnknown:first.productionUnknown,siteImpactPercent:first.type==='Partial site outage'||first.type==='Equipment telemetry issue'?share:100,affectedEquipment,
      description:first.reason+(unknown?' Energy loss is unknown and excluded from quantified totals.':'')+(first.type==='Site telemetry outage'&&expected>0?` Expected energy during this gap: ${expected.toFixed(1)} kWh; this is not measured energy loss.`:''),evidence:{rule:'cross_checked_telemetry_v1',lossUnknown:unknown,productionUnknown:first.productionUnknown,affectedEquipment,expectedEnergyDuringGapKwh:unknown?expected:undefined,
        minimumCapacityCoverage:Math.min(...group.map(e=>e.coverage)),intervalLosses:group.map(e=>({timestamp:e.timestamp,lossKwh:e.loss,countedLossKwh:e.loss,actualKwh:e.actual,expectedKwh:e.expected})),nighttimeImputation:false}} as unknown as T);
  }
  return mergeAdjoiningSiteOutages(remaining, minutes);
}

/** Join the partial onset retained by the baseline detector to its telemetry outage.
 * Only touching, quantified segments join. A healthy or unknown gap stays a boundary.
 * Each source ledger must fit its half-open event window so joining cannot duplicate
 * intervals or change the already-reconciled loss allocation.
 */
export function mergeAdjoiningSiteOutages<T extends Issue>(issues: T[], minutes: number): T[] {
  type Segment = { issue: T; start: number; end: number; ledger: Loss[] };
  const byMeter = new Map<string, Segment[]>();
  const matches = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) <= Math.max(1e-6, Math.abs(b)*1e-8);
  for (const issue of issues) {
    if (issue.type !== 'Site outage' || issue.category !== 'Performance' || issue.equipmentType !== 'revenue_meter' || issue.lossUnknown || issue.productionUnknown) continue;
    const start=time(issue.startDateTime),end=time(issue.endDateTime);
    const source=issue.evidence?.intervalLosses;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end<=start || !Array.isArray(source) || !source.length) continue;
    const ledger=[...source as Loss[]].sort((a,b)=>time(a.timestamp)-time(b.timestamp));
    let previousEnd=start,loss=0,actual=0,expected=0,valid=true;
    for (const point of ledger) {
      const from=time(point.timestamp),to=from+Number(point.intervalMinutes??minutes)*60000;
      const counted=point.countedLossKwh??point.lossKwh;
      if (!Number.isFinite(from) || !Number.isFinite(to) || from<previousEnd || to<=from || to>end ||
          !Number.isFinite(counted) || counted<0 || !Number.isFinite(point.actualKwh) || point.actualKwh!<0 || !Number.isFinite(point.expectedKwh) || point.expectedKwh!<0) {valid=false;break;}
      previousEnd=to;loss+=counted;actual+=point.actualKwh!;expected+=point.expectedKwh!;
    }
    if (!valid || !matches(loss,issue.estimatedLossKwh) || !matches(actual,issue.actualEnergyKwh) || !matches(expected,issue.expectedEnergyKwh)) continue;
    const segments=byMeter.get(issue.equipmentId)||[];
    segments.push({issue,start,end,ledger});byMeter.set(issue.equipmentId,segments);
  }
  const replacements=new Map<T,T>(),removed=new Set<T>();
  const finish=(chain:Segment[])=>{
    if(chain.length<2)return;
    const first=chain[0].issue,last=chain.at(-1)!.issue;
    const intervalLosses=chain.flatMap(segment=>segment.ledger);
    const estimatedLossKwh=intervalLosses.reduce((sum,p)=>sum+(p.countedLossKwh??p.lossKwh),0);
    const actualEnergyKwh=intervalLosses.reduce((sum,p)=>sum+p.actualKwh!,0),expectedEnergyKwh=intervalLosses.reduce((sum,p)=>sum+p.expectedKwh!,0);
    const durationMinutes=(chain.at(-1)!.end-chain[0].start)/60000;
    const affectedEquipment=[...new Map(chain.flatMap(({issue})=>issue.affectedEquipment||[]).map(asset=>[asset.id,asset])).values()];
    // Retain each detector's explanation and compact evidence without copying ledgers.
    const segments=chain.flatMap(({issue})=>{
      if(issue.evidence?.rule==='merged_adjoining_site_outages_v1' && Array.isArray(issue.evidence.segments)) return issue.evidence.segments;
      const {intervalLosses:ledger,...evidence}=issue.evidence||{};
      return [{sourceIssueId:issue.id,startDateTime:issue.startDateTime,endDateTime:issue.endDateTime,
        description:issue.description,confidence:issue.confidence,severity:issue.severity,
        estimatedLossKwh:issue.estimatedLossKwh,actualEnergyKwh:issue.actualEnergyKwh,expectedEnergyKwh:issue.expectedEnergyKwh,evidence}];
    });
    const merged={...first,name:'Site outage',endDateTime:last.endDateTime,durationMinutes,durationDays:durationMinutes/1440,
      estimatedLossKwh,actualEnergyKwh,expectedEnergyKwh,lossPercent:expectedEnergyKwh?Math.min(100,100*estimatedLossKwh/expectedEnergyKwh):0,
      siteImpactPercent:100,affectedEquipment,lossUnknown:false,productionUnknown:false,
      severity:chain.some(({issue})=>issue.severity==='critical')?'critical':chain.some(({issue})=>issue.severity==='high')?'high':'medium',
      confidence:chain.every(({issue})=>issue.confidence==='confirmed')?'confirmed':'model-based',
      description:'A continuous site outage, including any partially affected boundary intervals. Adjoining detections are combined and each interval’s loss is counted once.',
      evidence:{rule:'merged_adjoining_site_outages_v1',intervalCount:intervalLosses.length,intervalLosses,
        actualToExpectedRatio:expectedEnergyKwh?actualEnergyKwh/expectedEnergyKwh:0,segments},
    } as T;
    replacements.set(first,merged);chain.slice(1).forEach(({issue})=>removed.add(issue));
  };
  for(const segments of byMeter.values()) {
    segments.sort((a,b)=>a.start-b.start||a.end-b.end);
    let chain:Segment[]=[];
    for(const segment of segments) {
      if(chain.length && chain.at(-1)!.end!==segment.start){finish(chain);chain=[];}
      chain.push(segment);
    }
    finish(chain);
  }
  return issues.filter(issue=>!removed.has(issue)).map(issue=>replacements.get(issue)||issue);
}
