import { arrayCapacityModel, type ArrayCapacityModel, type CapacityAsset } from "../../array-capacity";

type Point={timestamp:string;energyKwh:number};
type Production={equipmentId:string;equipmentType:string;capacityKw?:number;intervalProduction?:Point[]};
type Summary={intervalMinutes?:number;expectedProduction?:Point[];equipmentProduction?:Production[]};
type Ledger={timestamp:string;lossKwh:number;[key:string]:unknown};
type Issue={equipmentId:string;equipmentType:string;estimatedLossKwh:number;expectedEnergyKwh:number;lossPercent:number;evidence?:Record<string,unknown>;description:string};

export function transformerAnalysisContext(summary:Summary,assets:CapacityAsset[]) {
  const model=arrayCapacityModel(assets),hours=(summary.intervalMinutes||60)/60;
  if(model.hasTransformers&&!model.complete)throw new Error(`Complete the transformer model before analysis: ${model.issues.join(' ')}`);
  let excludedExpectedKwh=0,cappedExpectedIntervals=0;
  if(model.hasTransformers){
    summary.expectedProduction=(summary.expectedProduction||[]).map(p=>{
      const energyKwh=Math.min(p.energyKwh,(model.gridExportKw||0)*hours);
      if(p.energyKwh>energyKwh){excludedExpectedKwh+=p.energyKwh-energyKwh;cappedExpectedIntervals++;}
      return {...p,energyKwh};
    });
    for(const p of summary.equipmentProduction||[])if(p.equipmentType==='revenue_meter')p.capacityKw=model.gridExportKw||0;
  }
  return {model,hours,methodology:{enabled:model.hasTransformers,unityPowerFactor:true,
    gridExportCeilingKw:model.gridExportKw,sitePvCeilingKw:model.pvCeilingKw,
    branches:model.branches,excludedExpectedKwh,cappedExpectedIntervals,
    method:'Each transformer uses its kVA rating as kW at power factor 1.0 unless a manual ceiling is enabled. Branch ceilings cannot borrow spare capacity from other transformers. Inverter measurements remain unchanged; estimated meter fallback and incremental recoverable branch loss respect each ceiling. Capacity limiting is not counted as equipment-fault loss.'}};
}

export function transformerIntervalTotals(summary:Summary,model:ArrayCapacityModel) {
  const totals=new Map<string,Map<string,{energy:number;count:number}>>();
  const branchByInverter=new Map<string,string>();
  for(const b of model.branches){totals.set(b.id,new Map());for(const id of b.inverterIds)branchByInverter.set(id,b.id);}
  for(const series of summary.equipmentProduction||[]){
    const id=branchByInverter.get(series.equipmentId);if(!id)continue;
    const points=totals.get(id)!;
    for(const p of series.intervalProduction||[]){const prev=points.get(p.timestamp)||{energy:0,count:0};prev.energy+=Math.max(0,p.energyKwh);prev.count++;points.set(p.timestamp,prev);}
  }
  return totals;
}
type Totals=ReturnType<typeof transformerIntervalTotals>;

/** Shared branch clipping is not evidence of an inverter anomaly relative to unconstrained peers. */
export function transformerPeerExclusions(model:ArrayCapacityModel,totals:Totals,hours:number,blocked:Map<string,Set<string>>) {
  if(!model.hasTransformers)return blocked;
  const result=new Map(blocked);
  for(const b of model.branches){
    const clipped=[...(totals.get(b.id)||[])].filter(([,p])=>p.count===b.inverterIds.length&&p.energy>=b.limitKw*hours*.95).map(([t])=>t);
    if(clipped.length)for(const id of b.inverterIds)result.set(id,new Set([...(blocked.get(id)||[]),...clipped]));
  }
  return result;
}

export function limitTransformerLosses<T extends Issue>(issues:T[],model:ArrayCapacityModel,totals:Totals,hours:number):T[] {
  if(!model.hasTransformers)return issues;
  const branchByInverter=new Map(model.branches.flatMap(b=>b.inverterIds.map(id=>[id,b] as const)));
  const requested=new Map<string,Map<string,number>>();
  for(const issue of issues){const b=branchByInverter.get(issue.equipmentId);if(!b||issue.equipmentType!=='inverter')continue;
    const points=requested.get(b.id)||new Map<string,number>();
    for(const p of (issue.evidence?.intervalLosses||[]) as Ledger[])points.set(p.timestamp,(points.get(p.timestamp)||0)+Math.max(0,p.lossKwh));
    requested.set(b.id,points);
  }
  return issues.map(issue=>{
    const b=branchByInverter.get(issue.equipmentId);if(!b||issue.equipmentType!=='inverter')return issue;
    let reduced=0;
    const intervalLosses=((issue.evidence?.intervalLosses||[]) as Ledger[]).map(p=>{
      const total=requested.get(b.id)?.get(p.timestamp)||0;
      const actual=totals.get(b.id)?.get(p.timestamp)?.energy||0,ceiling=(b.pvCeilingKw||0)*hours;
      const recoverable=Math.max(0,Math.min(ceiling,actual+total)-Math.min(ceiling,actual));
      const lossKwh=total>0?Math.max(0,p.lossKwh)*Math.min(1,recoverable/total):0;
      if(p.lossKwh-lossKwh<=1e-9)return p;
      reduced+=p.lossKwh-lossKwh;
      return {...p,lossKwh,unconstrainedLossKwh:p.lossKwh,transformerLimitKw:b.limitKw};
    });
    if(reduced<=1e-9)return issue;
    const estimatedLossKwh=intervalLosses.reduce((s,p)=>s+Math.max(0,p.lossKwh),0);
    return {...issue,estimatedLossKwh,lossPercent:issue.expectedEnergyKwh>0?Math.min(100,estimatedLossKwh/issue.expectedEnergyKwh*100):0,
      description:issue.description+' Counted loss is limited to the additional energy that could pass through its assigned transformer.',
      evidence:{...issue.evidence,intervalLosses,transformerId:b.id,transformerLimitKw:b.limitKw,transformerCapacityExcludedLossKwh:reduced}};
  });
}
