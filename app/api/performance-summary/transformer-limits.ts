import { arrayCapacityModel, type ArrayCapacityModel, type CapacityAsset } from "../../array-capacity";

type Point={timestamp:string;energyKwh:number};
type Production={equipmentId:string;equipmentType:string;capacityKw?:number;intervalProduction?:Point[]};
type Summary={intervalMinutes?:number;expectedProduction?:Point[];equipmentProduction?:Production[]};
type Ledger={timestamp:string;lossKwh:number;[key:string]:unknown};
type Issue={equipmentId:string;equipmentType:string;estimatedLossKwh:number;expectedEnergyKwh:number;lossPercent:number;lossUnknown?:boolean;evidence?:Record<string,unknown>;description:string};

export function transformerAnalysisContext(summary:Summary,assets:CapacityAsset[]) {
  const model=arrayCapacityModel(assets),hours=(summary.intervalMinutes||60)/60;
  const capacityConflictIntervals = model.gridExportKw === null ? 0 : (summary.expectedProduction || [])
    .filter(p => Number.isFinite(p.energyKwh) && p.energyKwh > model.gridExportKw! * hours + 1e-6).length;
  return {model,hours,methodology:{enabled:model.hasTransformers,unityPowerFactor:true,
    gridExportCeilingKw:model.gridExportKw,sitePvCeilingKw:model.pvCeilingKw,
    branches:model.branches,capacityConflictIntervals,modelIssues:model.issues,
    method:'Transformer ceilings constrain delivered inverter fallback and recoverable inverter loss, never the supplied site Expected Production. Branches cannot borrow spare capacity; missing sibling actuals leave branch loss unknown.'}};

}

export function transformerIntervalTotals(summary:Summary,model:ArrayCapacityModel) {
  const totals=new Map<string,Map<string,{energy:number;count:number}>>();
  const branchByInverter=new Map<string,string>();
  for(const b of model.branches){totals.set(b.id,new Map());for(const id of b.inverterIds)branchByInverter.set(id,b.id);}
  for(const series of summary.equipmentProduction||[]){
    const id=branchByInverter.get(series.equipmentId);if(!id)continue;
    const points=totals.get(id)!;
    for(const p of series.intervalProduction||[]){if(!Number.isFinite(p.energyKwh))continue;const prev=points.get(p.timestamp)||{energy:0,count:0};prev.energy+=Math.max(0,p.energyKwh);prev.count++;points.set(p.timestamp,prev);}
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
  for(const issue of issues){const b=branchByInverter.get(issue.equipmentId);if(!b||issue.equipmentType!=='inverter'||issue.lossUnknown)continue;
    const points=requested.get(b.id)||new Map<string,number>();
    for(const p of (issue.evidence?.intervalLosses||[]) as Ledger[])points.set(p.timestamp,(points.get(p.timestamp)||0)+Math.max(0,p.lossKwh));
    requested.set(b.id,points);
  }
  return issues.map(issue=>{
    const b=branchByInverter.get(issue.equipmentId);if(!b||issue.equipmentType!=='inverter')return issue;
    if(issue.lossUnknown)return issue;
    let reduced=0,unknownIntervals=0;
    const intervalLosses=((issue.evidence?.intervalLosses||[]) as Ledger[]).map(p=>{
      const total=requested.get(b.id)?.get(p.timestamp)||0;
      const coverage=totals.get(b.id)?.get(p.timestamp);
      if(!model.complete || !coverage || coverage.count!==b.inverterIds.length){
        unknownIntervals++;
        return {...p,lossKwh:0,countedLossKwh:0,lossUnknown:true,lossUnavailableReason:"branch_actual_coverage",transformerId:b.id};
      }
      const actual=coverage.energy,ceiling=(b.pvCeilingKw||0)*hours;
      const recoverable=Math.max(0,Math.min(ceiling,actual+total)-Math.min(ceiling,actual));
      const lossKwh=total>0?Math.max(0,p.lossKwh)*Math.min(1,recoverable/total):0;
      if(p.lossKwh-lossKwh<=1e-9)return p;
      reduced+=p.lossKwh-lossKwh;
      return {...p,lossKwh,unconstrainedLossKwh:p.lossKwh,transformerLimitKw:b.limitKw};
    });
    if(unknownIntervals){
      const knownLossKwh=intervalLosses.reduce((s,p)=>s+Math.max(0,p.lossKwh),0);
      return {...issue,lossUnknown:true,estimatedLossKwh:0,lossPercent:0,
        description:issue.description+' Branch actual coverage is incomplete; event loss is unknown and excluded from quantified totals.',
        evidence:{...issue.evidence,lossUnknown:true,intervalLosses,transformerId:b.id,
          lossCoverage:{knownIntervals:intervalLosses.length-unknownIntervals,unknownIntervals,knownLossKwh}}};
    }
    if(reduced<=1e-9)return issue;
    const estimatedLossKwh=intervalLosses.reduce((s,p)=>s+Math.max(0,p.lossKwh),0);
    return {...issue,estimatedLossKwh,lossPercent:issue.expectedEnergyKwh>0?Math.min(100,estimatedLossKwh/issue.expectedEnergyKwh*100):0,
      description:issue.description+' Counted loss is limited to the additional energy that could pass through its assigned transformer.',
      evidence:{...issue.evidence,intervalLosses,transformerId:b.id,transformerLimitKw:b.limitKw,transformerCapacityExcludedLossKwh:reduced}};
  });
}
