/** Shared model ceilings for the editor, import validation, and analysis. */
export type CapacityAsset = {
  id:string; type:string; parentId?:string|null; name?:string; externalId?:string;
  acRatedCapacityKw?:string|number|null; moduleRatedCapacityW?:string|number|null; quantity?:number;
  nameplateKva?:string|number|null; pvCeilingOverrideEnabled?:boolean; pvCeilingOverrideKw?:string|number|null;
  acLineLossPercent?:string|number|null; transformerLossPercent?:string|number|null;
};
const positive = (value:unknown) => Number.isFinite(Number(value)) && Number(value)>0 ? Number(value) : 0;
const lossFactor = (value:unknown) => 1-Math.min(100,Math.max(0,Number(value)||0))/100;

export function arrayCapacityModel(assets:CapacityAsset[]) {
  const byId=new Map(assets.map(a=>[a.id,a]));
  const meter=assets.find(a=>a.type==='revenue_meter');
  const inverters=assets.filter(a=>a.type==='inverter'),transformers=assets.filter(a=>a.type==='transformer');
  const dcByInverter=new Map<string,number>();
  for(const a of assets) if(a.type==='module_group'&&a.parentId) dcByInverter.set(a.parentId,(dcByInverter.get(a.parentId)||0)+positive(a.moduleRatedCapacityW)*Math.max(0,a.quantity||0)/1000);
  const modeledByInverter=new Map(inverters.map(a=>[a.id,Math.min(positive(a.acRatedCapacityKw),dcByInverter.get(a.id)||0)]));
  const issues:string[]=[];
  const branches=transformers.map(t=>{
    const assigned=inverters.filter(a=>a.parentId===t.id);
    const inverterKw=assigned.reduce((s,a)=>s+positive(a.acRatedCapacityKw),0);
    const modeledKw=assigned.reduce((s,a)=>s+(modeledByInverter.get(a.id)||0),0);
    const ratingKva=positive(t.nameplateKva),overrideEnabled=t.pvCeilingOverrideEnabled===true;
    const limitKw=overrideEnabled?positive(t.pvCeilingOverrideKw):ratingKva;
    const label=t.name||t.externalId||'Transformer';
    if(byId.get(t.parentId||'')?.type!=='revenue_meter')issues.push(`${label}: connect to the meter / POI.`);
    if(!ratingKva)issues.push(`${label}: enter a nameplate rating greater than zero in kVA.`);
    if(overrideEnabled&&!limitKw)issues.push(`${label}: enter a manual PV ceiling greater than zero in kWac.`);
    if(assigned.some(a=>!positive(a.acRatedCapacityKw)))issues.push(`${label}: complete the assigned inverter AC ratings.`);
    const complete=ratingKva>0&&limitKw>0&&byId.get(t.parentId||'')?.type==='revenue_meter'&&assigned.every(a=>positive(a.acRatedCapacityKw)>0);
    return {id:t.id,name:label,externalId:t.externalId||'',inverterIds:assigned.map(a=>a.id),inverterKw,
      ratingKva,overrideEnabled,limitKw,pvCeilingKw:complete?Math.min(inverterKw,limitKw):null,
      modeledCeilingKw:complete?Math.min(modeledKw,limitKw):null,modeledKw,limited:complete&&inverterKw>limitKw};
  });
  const unassigned=inverters.filter(a=>byId.get(a.parentId||'')?.type!=='transformer');
  if(transformers.length&&unassigned.length)issues.push(`${unassigned.length} inverter${unassigned.length===1?' needs':'s need'} a transformer assignment.`);
  if(transformers.length)for(const a of inverters)if(!(dcByInverter.get(a.id)!>0))issues.push(`${a.name||a.id}: configure the connected module DC capacity.`);
  const installedAcKw=inverters.reduce((s,a)=>s+positive(a.acRatedCapacityKw),0);
  const unconstrainedModeledKw=[...modeledByInverter.values()].reduce((s,v)=>s+v,0);
  const complete=issues.length===0;
  const pvCeilingKw=transformers.length?(complete?branches.reduce((s,b)=>s+(b.pvCeilingKw||0),0):null):installedAcKw;
  const modeledGrossKw=transformers.length?(complete?branches.reduce((s,b)=>s+(b.modeledCeilingKw||0),0):null):unconstrainedModeledKw;
  const deliveryFactor=lossFactor(meter?.acLineLossPercent)*lossFactor(meter?.transformerLossPercent);
  const impactByInverter=new Map(modeledByInverter);
  if(transformers.length)for(const b of branches)for(const id of b.inverterIds)impactByInverter.set(id,b.modeledKw>0?(modeledByInverter.get(id)||0)*(b.modeledCeilingKw||0)/b.modeledKw:0);
  return {hasTransformers:transformers.length>0,complete,issues,branches,unassignedIds:unassigned.map(a=>a.id),
    installedAcKw,pvCeilingKw,modeledGrossKw,gridExportKw:modeledGrossKw===null?null:modeledGrossKw*deliveryFactor,
    deliveryFactor,dcByInverter,modeledByInverter,impactByInverter};
}
export type ArrayCapacityModel = ReturnType<typeof arrayCapacityModel>;

/** Inverter measurements stay unchanged. Only estimated energy delivered beyond each transformer is capped. */
export function deliveredInverterEnergy(model:ArrayCapacityModel,readings:Map<string,number>,hours:number) {
  if(!model.hasTransformers)return [...readings.values()].reduce((s,v)=>s+v,0)*model.deliveryFactor;
  if(!model.complete)throw new Error(`Complete the transformer model before analysis: ${model.issues.join(' ')}`);
  return model.branches.reduce((sum,b)=>sum+Math.min((b.pvCeilingKw||0)*hours,b.inverterIds.reduce((s,id)=>s+Math.max(0,readings.get(id)||0),0)),0)*model.deliveryFactor;
}

/** Validate parent types separately from incomplete drafts; legacy meter → inverter remains readable. */
export function hierarchyError(assets:CapacityAsset[]) {
  const byId=new Map(assets.map(a=>[a.id,a]));
  for(const a of assets){
    if(!a.parentId)continue;
    const parent=byId.get(a.parentId);
    const allowed=a.type==='transformer'?['revenue_meter']:a.type==='inverter'?['transformer','revenue_meter']:a.type==='module_group'?['inverter']:[];
    if(!parent||!allowed.includes(parent.type))return `${a.name||a.id} has an invalid parent connection.`;
  }
  return '';
}
