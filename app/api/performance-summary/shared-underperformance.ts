import type { InverterExpectationContext } from './inverter-expectation';

export const SHARED_REDUCTION_METHOD = {
  version: 1, minimumInverters: 3, minimumEligibleCapacityPercent: 90,
  minimumSupportingCapacityPercent: 75, similarityPercentagePoints: 5,
  minimumDeficitPercent: 10, additionalInverterDeficitPercentagePoints: 10,
  maximumMeterFleetDifferencePercentagePoints: 10,
  basis: 'Capacity-weighted median actual / derived expected production across eligible inverters. At least three inverters representing 75% of total configured AC capacity must agree within five percentage points, with 90% eligible capacity coverage. Shared and additional inverter losses remain referenced to the original healthy expectation.',
  exclusions: 'Requires persistent model-derived inverter findings and a positive, directly measured meter shortfall of at least 10%. Excludes missing or blocked telemetry, snow days, low irradiance, low expected output, and inverter or transformer saturation. Meter and monitored fleet production ratios must agree within ten percentage points. Outages and communication events retain priority.',
  allocation: 'Reallocate existing interval losses without adding energy: shared reductions and sub-threshold differences are reviewed at site level; an additional inverter deficit of at least ten percentage points of its healthy expected energy remains separate. Include any existing unexplained meter remainder in the site finding. Preserve source event and interval evidence. Shared behavior alone does not establish a physical cause or validate the expected-production model.',
};
type Point = { timestamp: string; energyKwh: number };
type Loss = { timestamp: string; lossKwh: number; countedLossKwh?: number; actualKwh?: number; expectedKwh?: number;
  derivedInverterExpectedKwh?: number; intervalMinutes?: number; [key: string]: unknown };
type Issue = { id: string; name: string; type: string; category: string; equipmentId: string; equipmentType: string;
  equipmentName: string; equipmentExternalId: string; startDateTime: string; endDateTime: string;
  durationMinutes: number; durationDays: number; estimatedLossKwh: number; actualEnergyKwh: number; expectedEnergyKwh: number;
  lossPercent: number; siteImpactPercent: number; description: string; evidence?: Record<string, unknown>;
  lossUnknown?: boolean; productionUnknown?: boolean; affectedEquipment?: {id:string;name:string}[] };
type Summary = { expectedProduction?:Point[]; equipmentProduction?: {equipmentId:string;equipmentType:string;intervalProduction?:Point[]}[];
  intervalIrradiance?:{timestamp:string;averageWm2:number}[]; revenueMeterFallback?:{points:Point[]} };
export type SharedInterval = { ratio:number; eligibleCapacityPercent:number; supportingCapacityPercent:number;
  supportingInverters:number; meterActualKwh:number; meterExpectedKwh:number };

/** One scalar record per qualified timestamp, not a second inverter × year matrix. */
export function sharedReductionIntervals(summary:Summary, issues:Issue[], context:InverterExpectationContext,
  blocked:Map<string,Set<string>>, skipDate:(timestamp:string)=>boolean):Map<string,SharedInterval> {
  const result = new Map<string,SharedInterval>();
  const method=SHARED_REDUCTION_METHOD;
  if (!context.model.ready || context.model.inverters.size < method.minimumInverters) return result;
  const timestamps = [...new Set(issues.filter(i=>i.equipmentType==='inverter'&&i.type==='Underperformance')
    .flatMap(i=>((i.evidence?.intervalLosses||[]) as Loss[]).filter(p=>p.derivedInverterExpectedKwh!==undefined).map(p=>p.timestamp)))].sort();
  if (!timestamps.length) return result;
  const production=summary.equipmentProduction||[],meter=production.find(p=>p.equipmentType==='revenue_meter');
  if (!meter) return result;
  const inputs=production.filter(p=>p.equipmentType==='inverter'&&context.model.inverters.has(p.equipmentId))
    .map(p=>({id:p.equipmentId,points:p.intervalProduction||[],cursor:0,model:context.model.inverters.get(p.equipmentId)!}));
  const meterPoints=meter.intervalProduction||[],sun=new Map((summary.intervalIrradiance||[]).map(p=>[p.timestamp,p.averageWm2]));
  const substituted=new Set((summary.revenueMeterFallback?.points||[]).map(p=>p.timestamp));
  const expectedByTime=new Map((summary.expectedProduction||[]).map(p=>[p.timestamp,p.energyKwh]));
  const totalAc=[...context.model.inverters.values()].reduce((s,i)=>s+i.acKw,0);
  let meterCursor=0;
  for (const timestamp of timestamps) {
    if ((sun.get(timestamp)||0)<200 || skipDate(timestamp) || substituted.has(timestamp) || blocked.get(meter.equipmentId)?.has(timestamp)) continue;
    while(meterCursor<meterPoints.length&&meterPoints[meterCursor].timestamp<timestamp)meterCursor++;
    const meterValue=meterPoints[meterCursor]?.timestamp===timestamp?meterPoints[meterCursor].energyKwh:undefined;
    if (!Number.isFinite(meterValue)||meterValue!<=0) continue;
    const values:{ratio:number;ac:number;expected:number;actual:number}[]=[];
    let eligibleAc=0,expected=0,actual=0;
    for(const input of inputs){
      while(input.cursor<input.points.length&&input.points[input.cursor].timestamp<timestamp)input.cursor++;
      const value=input.points[input.cursor]?.timestamp===timestamp?input.points[input.cursor].energyKwh:undefined;
      const point=context.at(input.id,timestamp),ceiling=input.model.acKw*context.hours;
      if(!point||point.capacityLimited||blocked.get(input.id)?.has(timestamp)||!Number.isFinite(value)||value!<=0||
        point.expectedKwh<ceiling*.1||value!>=ceiling*.95)continue;
      values.push({ratio:value!/point.expectedKwh,ac:input.model.acKw,expected:point.expectedKwh,actual:value!});
      eligibleAc+=input.model.acKw;expected+=point.expectedKwh;actual+=value!;
    }
    if(values.length<method.minimumInverters||eligibleAc+1e-8<totalAc*method.minimumEligibleCapacityPercent/100)continue;
    values.sort((a,b)=>a.ratio-b.ratio);
    let accumulated=0,ratio=values[0].ratio;
    for(const value of values){accumulated+=value.ac;if(accumulated>=eligibleAc/2){ratio=value.ratio;break;}}
    if(ratio>1-method.minimumDeficitPercent/100+1e-9)continue;
    const supporters=values.filter(v=>v.ratio<=1-method.minimumDeficitPercent/100+1e-9&&Math.abs(v.ratio-ratio)<=method.similarityPercentagePoints/100+1e-9);
    const supportingAc=supporters.reduce((s,v)=>s+v.ac,0);
    if(supporters.length<method.minimumInverters||supportingAc+1e-8<totalAc*method.minimumSupportingCapacityPercent/100)continue;
    const siteExpected=expectedByTime.get(timestamp)||0;
    const meterRatio=meterValue!/siteExpected;
    if(!Number.isFinite(meterRatio)||meterRatio>1-method.minimumDeficitPercent/100+1e-9||Math.abs(meterRatio-actual/expected)>method.maximumMeterFleetDifferencePercentagePoints/100+1e-9)continue;
    result.set(timestamp,{ratio,eligibleCapacityPercent:eligibleAc/totalAc*100,supportingCapacityPercent:supportingAc/totalAc*100,
      supportingInverters:supporters.length,meterActualKwh:meterValue!,meterExpectedKwh:siteExpected});
  }
  return result;
}

/** Loss transfers happen after outage/telemetry reconciliation; total energy is conserved. */
export function allocateSharedReductions<T extends Issue>(issues:T[], shared:Map<string,SharedInterval>, meter:{id:string;name:string;externalId?:string},
  intervalMinutes:number, join:(a:string,b:string)=>boolean, addMinutes:(timestamp:string,minutes:number)=>string):T[]{
  if(!shared.size)return issues;
  const ledger=(i:T)=>(i.evidence?.intervalLosses||[]) as Loss[];
  // A parent outage or unknown-production event always wins, including partial-site events.
  const excluded=new Set(issues.filter(i=>i.type!=='Underperformance'&&(i.equipmentType==='revenue_meter'||i.type==='Partial site outage'))
    .flatMap(i=>ledger(i).map(p=>p.timestamp)));
  const sourceEvents:{issueId:string;equipmentId:string;equipmentName:string;sourceStart:string;sourceEnd:string}[]=[];
  const sourceIndexes=new Map<string,number>();
  const siteIntervals=new Map<string,Loss>();
  const siteAt=(timestamp:string)=>{
    let p=siteIntervals.get(timestamp);if(p)return p;
    const s=shared.get(timestamp)!;
    p={timestamp,lossKwh:0,countedLossKwh:0,actualKwh:s.meterActualKwh,expectedKwh:s.meterExpectedKwh,
      sharedFleetRatio:s.ratio,eligibleCapacityPercent:s.eligibleCapacityPercent,supportingCapacityPercent:s.supportingCapacityPercent,
      supportingInverters:s.supportingInverters,sharedContributors:[],unexplainedSiteLossKwh:0,detectionBasis:'shared_site_reduction_v1'};
    siteIntervals.set(timestamp,p);return p;
  };
  const regroup=(issue:T,points:Loss[],suffix:string):T[]=>{
    const groups:Loss[][]=[];
    for(const p of points){const last=groups.at(-1);if(last&&join(last.at(-1)!.timestamp,p.timestamp))last.push(p);else groups.push([p]);}
    return groups.map((group,index)=>{
      const start=group[0].timestamp,end=addMinutes(group.at(-1)!.timestamp,intervalMinutes);
      const duration=(Date.parse(/Z$|[+-]\d\d:\d\d$/.test(end)?end:end+'Z')-Date.parse(/Z$|[+-]\d\d:\d\d$/.test(start)?start:start+'Z'))/60000;
      const loss=group.reduce((s,p)=>s+(p.countedLossKwh??p.lossKwh),0),actual=group.reduce((s,p)=>s+(p.actualKwh||0),0),expected=group.reduce((s,p)=>s+(p.expectedKwh||0),0);
      return {...issue,id:`${issue.id}-${suffix}-${index}`,startDateTime:start,endDateTime:end,durationMinutes:duration,durationDays:duration/1440,
        estimatedLossKwh:loss,actualEnergyKwh:actual,expectedEnergyKwh:expected,lossPercent:expected?100*loss/expected:0,
        evidence:{...issue.evidence,intervalCount:group.length,intervalLosses:group,originalIssueId:issue.id}};
    });
  };
  const retained:T[]=[];
  for(const issue of issues){
    if(issue.type!=='Underperformance'||issue.category!=='Performance'||issue.equipmentType!=='inverter'||issue.lossUnknown){retained.push(issue);continue;}
    let changed=false;
    const remaining=ledger(issue).flatMap(p=>{
      const s=shared.get(p.timestamp),loss=Math.max(0,p.countedLossKwh??p.lossKwh),expected=p.expectedKwh||0,actual=p.actualKwh||0;
      if(!s||excluded.has(p.timestamp)||p.derivedInverterExpectedKwh===undefined||!expected||!loss)return [p];
      const ratio=actual/expected,extra=Math.max(0,s.ratio-ratio);
      const additional=extra+1e-9>=SHARED_REDUCTION_METHOD.additionalInverterDeficitPercentagePoints/100?Math.min(loss,loss*extra/Math.max(1e-12,1-ratio)):0;
      const transferred=loss-additional;if(transferred<=1e-9)return [p];
      changed=true;
      const site=siteAt(p.timestamp);site.lossKwh+=transferred;site.countedLossKwh=site.lossKwh;
      let sourceIndex=sourceIndexes.get(issue.id);
      if(sourceIndex===undefined){sourceIndex=sourceEvents.length;sourceIndexes.set(issue.id,sourceIndex);sourceEvents.push({issueId:issue.id,equipmentId:issue.equipmentId,equipmentName:issue.equipmentName,sourceStart:issue.startDateTime,sourceEnd:issue.endDateTime});}
      // Numeric tuples avoid repeating equipment names, event IDs and bounds at every interval.
      (site.sharedContributors as number[][]).push([sourceIndex,actual,expected,loss,transferred,additional,p.derivedInverterExpectedKwh]);
      return additional>1e-9?[{...p,lossKwh:additional,countedLossKwh:additional,healthyExpectedKwh:expected,
        sharedSiteLossKwh:transferred,sharedFleetRatio:s.ratio,detectionBasis:'additional_inverter_deficit_v1'}]:[];
    });
    if(!changed)retained.push(issue);
    else retained.push(...regroup({...issue,description:'Additional inverter underperformance beyond the shared sitewide reduction. Loss includes only the additional component; the healthy expected-production baseline is retained in the evidence.',
      evidence:{...issue.evidence,rule:'additional_inverter_deficit_v1',sharedReductionMethodVersion:1}},remaining,'additional'));
  }
  // Fold an existing unexplained meter remainder into the same site review item.
  const result=retained.flatMap(issue=>{
    if(issue.equipmentType!=='revenue_meter'||issue.type!=='Underperformance')return [issue];
    let changed=false;
    const remaining=ledger(issue).filter(p=>{
      const site=siteIntervals.get(p.timestamp);if(!site)return true;
      changed=true;const loss=Math.max(0,p.countedLossKwh??p.lossKwh);site.lossKwh+=loss;site.countedLossKwh=site.lossKwh;
      site.unexplainedSiteLossKwh=Number(site.unexplainedSiteLossKwh)+loss;return false;
    });
    return changed?regroup(issue,remaining,'residual'):[issue];
  });
  const points=[...siteIntervals.values()].sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
  if(!points.length)return issues;
  const template=issues.find(i=>i.equipmentType==='inverter'&&i.type==='Underperformance')!;
  const siteIssue={...template,id:`${meter.id}-shared-underperformance`,name:'Shared site underperformance',equipmentId:meter.id,
    equipmentName:meter.name,equipmentType:'revenue_meter',equipmentExternalId:meter.externalId||'',siteImpactPercent:100,
    severity:'medium',confidence:'model-based',description:'A substantial majority of the monitored inverter capacity shows a similar reduction against its healthy derived expectation, corroborated by the revenue meter. Shared inverter loss and any unexplained meter remainder are counted here once. Additional material inverter deficits remain separate. The cause is not established.',
    evidence:{rule:'shared_site_reduction_v1',sharedReductionMethodVersion:1}} as T;
  for(const issue of regroup(siteIssue,points,'event')){
    const ids=new Map<string,string>();
    const localSources:typeof sourceEvents=[],localIndexes=new Map<number,number>();
    for(const p of ledger(issue))for(const c of p.sharedContributors as number[][]){
      const source=sourceEvents[c[0]];ids.set(source.equipmentId,source.equipmentName);
      let index=localIndexes.get(c[0]);if(index===undefined){index=localSources.length;localIndexes.set(c[0],index);localSources.push(source);}
      c[0]=index;
    }
    issue.evidence={...issue.evidence,sharedSourceEvents:localSources,sharedContributorFormat:1};
    (issue as T & {severity:string}).severity=ledger(issue).some(p=>Number(p.sharedFleetRatio)<.4)?'high':'medium';
    issue.affectedEquipment=[...ids].map(([id,name])=>({id,name}));
    result.push(issue);
  }
  return result;
}
