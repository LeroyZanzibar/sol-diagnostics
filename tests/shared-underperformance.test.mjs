import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource,modelCapacityBindings} from './source-module.mjs';
const model=modelCapacityBindings(),time=loadSource('app/telemetry-time.ts');
const peers=loadSource('app/api/performance-summary/peer-comparison.ts',[],{...model,...time});
const causes=loadSource('app/api/performance-summary/causes.ts',[],time);
const telemetry=loadSource('app/api/performance-summary/telemetry-events.ts',[],{...model,...time,...causes});
const bindings={...model,...time,...peers,...causes,...telemetry};
const {buildAnalysis,gapContainsOnlyLowIrradiance,addMinutes}=loadSource('app/api/performance-summary/route.ts',['buildAnalysis','gapContainsOnlyLowIrradiance','addMinutes'],bindings);
const {sharedEvidencePage}=loadSource('app/shared-reduction-evidence.ts');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
function fixture({ratios=[.8,.8,.8,.8],days=4,minutes=60,weights=ratios.map(()=>1),ratioAt}={}){
 const assets=[{id:'meter',name:'POI',type:'revenue_meter',externalId:'meter',acLineLossPercent:'2',transformerLossPercent:'1'}];
 ratios.forEach((_,i)=>assets.push({id:`i${i}`,name:`Inverter ${i}`,externalId:`i${i}`,type:'inverter',parentId:'meter',acRatedCapacityKw:String(100*weights[i])},
  {id:`m${i}`,type:'module_group',parentId:`i${i}`,moduleRatedCapacityW:'500',quantity:200*weights[i]}));
 const production=assets.filter(a=>a.type!=='module_group').map(a=>({equipmentId:a.id,equipmentName:a.name,equipmentType:a.type,externalId:a.id,capacityKw:a.id==='meter'?100*weights.reduce((a,b)=>a+b,0)*.9702:Number(a.acRatedCapacityKw),intervalProduction:[],dailyProduction:[]}));
 const summary={intervalMinutes:minutes,timezone:'America/New_York',equipmentProduction:production,intervalIrradiance:[],expectedProduction:[],dailyProduction:[],source:'interval_energy'};
 // Authored historical evidence for direct legacy helper tests only. This is not
 // a replacement detector: no qualification, persistence, or cause policy runs.
 const savedLedgers=ratios.map(()=>[]);
 for(let day=0;day<days;day++)for(let minute=0;minute<1440;minute+=minutes){
  const timestamp=new Date(Date.UTC(2026,5,1+day,0,minute)).toISOString(),hour=Math.floor(minute/60),energy=hour>=12&&hour<18?50*minutes/60:0;
  summary.intervalIrradiance.push({timestamp,averageWm2:energy?600:0,insolationKwhM2:energy?.6*minutes/60:0,readingCount:1,peakWm2:energy?600:0});
  summary.expectedProduction.push({timestamp,energyKwh:energy*weights.reduce((a,b)=>a+b,0)*.9702});
  let fleet=0;
  ratios.forEach((ratio,i)=>{
   const expected=energy*weights[i],value=expected*(ratioAt?.(i,day,hour)??ratio);
   production[i+1].intervalProduction.push({timestamp,energyKwh:value});fleet+=value;
   if(value>0&&value<expected)savedLedgers[i].push({timestamp,intervalMinutes:minutes,
    lossKwh:(expected-value)*.9702,countedLossKwh:(expected-value)*.9702,
    actualKwh:value*.9702,expectedKwh:expected*.9702,derivedInverterExpectedKwh:expected});
  });
  production[0].intervalProduction.push({timestamp,energyKwh:fleet*.9702});
 }
 const savedIssues=savedLedgers.flatMap((ledger,i)=>{
  if(!ledger.length)return [];
  const actual=ledger.reduce((s,p)=>s+p.actualKwh,0),expected=ledger.reduce((s,p)=>s+p.expectedKwh,0);
  const start=ledger[0].timestamp,end=addMinutes(ledger.at(-1).timestamp,minutes),duration=(Date.parse(end)-Date.parse(start))/60000;
  return [{id:`historical-i${i}`,name:`Inverter ${i} underperformance`,type:'Underperformance',category:'Performance',equipmentId:`i${i}`,
   equipmentType:'inverter',equipmentName:`Inverter ${i}`,equipmentExternalId:`i${i}`,startDateTime:start,endDateTime:end,
   intervalMinutes:minutes,durationMinutes:duration,durationDays:duration/1440,estimatedLossKwh:ledger.reduce((s,p)=>s+p.lossKwh,0),
   actualEnergyKwh:actual,expectedEnergyKwh:expected,lossPercent:100*(expected-actual)/expected,siteImpactPercent:100/ratios.length,
   suspectedCause:'',description:'Synthetic retained historical finding.',evidence:{intervalLosses:ledger}}];
 });
 return {summary,assets,savedIssues};
}
const run=f=>buildAnalysis(structuredClone(f.summary),f.assets);
const shared=r=>r.issues.filter(i=>i.evidence.rule==='shared_site_reduction_v1');
const inv=r=>r.issues.filter(i=>i.equipmentType==='inverter'&&i.type==='Underperformance');
function assertOutageOnly(r){
 assert.equal(r.issues.some(i=>i.type==='Underperformance'),false);
 assert.equal(r.peerComparison,undefined);assert.equal(r.causeAnalysis,undefined);assert.equal(r.recurringIssues.length,0);
 assert.ok(r.issues.every(i=>!i.suspectedCause&&!i.recurringId));
}
function assertLedger(r,expected){
 near(r.totalLossKwh,expected);
 near(r.totalLossKwh,r.issues.flatMap(i=>i.evidence.intervalLosses).reduce((s,p)=>s+(p.countedLossKwh??p.lossKwh),0));
}
function legacyRun(f){
 // Explicit direct compatibility path. The active engine is tested separately;
 // disabling one retired callback on that engine is not an independent oracle.
 const context=model.inverterExpectationContext(f.summary,f.assets),issues=structuredClone(f.savedIssues);
 const snow=new Set(f.summary.snowSensorConfigured?f.summary.snowDays||[]:[]);
 const intervals=model.sharedReductionIntervals(f.summary,issues,context,new Map(),t=>snow.has(time.localDate(t,f.summary.timezone)));
 const sun=new Map(f.summary.intervalIrradiance.map(p=>[p.timestamp,p]));
 const allocated=model.allocateSharedReductions(issues,intervals,f.assets[0],f.summary.intervalMinutes,
  (a,b)=>gapContainsOnlyLowIrradiance(a,b,sun,f.summary.intervalMinutes),addMinutes);
 const result={issues:allocated,totalLossKwh:allocated.reduce((s,i)=>s+i.estimatedLossKwh,0)};
 assertLedger(result,f.savedIssues.reduce((s,i)=>s+i.estimatedLossKwh,0));
 return result;
}
test('uniform nonzero reduction is retired from the engine; direct legacy allocation preserves source evidence',()=>{
 const f=fixture(),active=run(f);assertOutageOnly(active);assert.equal(active.analyzedIntervals,4*6);assert.equal(active.issues.length,0);assert.equal(active.totalLossKwh,0);
 const r=legacyRun(f);assert.equal(shared(r).length,1);assert.equal(inv(r).length,0);
 const issue=shared(r)[0];near(issue.estimatedLossKwh,4*6*4*10*.9702);assert.equal(issue.affectedEquipment.length,4);assert.equal(issue.suspectedCause,'');
 const page=sharedEvidencePage(issue);assert.equal(page.rows.length,4);near(page.rows.reduce((s,p)=>s+p.sharedLossKwh,0),issue.estimatedLossKwh);
 const intervals=sharedEvidencePage(issue,0,page.rows[0].issueId);assert.equal(intervals.total,24);near(intervals.intervals[0].expectedKwh,50*.9702);
});
test('direct legacy allocation retains only the additional deficit; nonzero outliers create no active findings',()=>{
 const f=fixture({ratios:[.5,.8,.8,.8]}),active=run(f);assertOutageOnly(active);assert.equal(active.issues.length,0);assert.equal(active.totalLossKwh,0);
 const r=legacyRun(f);assert.equal(shared(r).length,1);assert.equal(inv(r).length,1);
 near(inv(r)[0].estimatedLossKwh,4*6*15*.9702);near(shared(r)[0].estimatedLossKwh,4*6*40*.9702);
 assert.ok(inv(r)[0].evidence.intervalLosses.every(p=>p.detectionBasis==='additional_inverter_deficit_v1'));
 const raw=sharedEvidencePage(shared(r)[0]).rows.find(p=>p.equipmentId==='i0');near(raw.originalLossKwh,raw.sharedLossKwh+raw.additionalLossKwh);
});
test('direct legacy allocation preserves its material boundary without reviving active shared reductions',()=>{
 for(const outlier of [.71,.7]){
  const f=fixture({ratios:[outlier,.8,.8,.8]}),r=legacyRun(f);
  assert.equal(inv(r).length,outlier===.7?1:0);assert.equal(shared(r).length,1);
  const active=run(f);assertOutageOnly(active);assert.equal(active.issues.length,0);assert.equal(active.totalLossKwh,0);
 }
});
test('direct legacy shared qualification excludes small fleets, insufficient coverage and inconsistent ratios',()=>{
 for(const options of [{ratios:[.5,1,1,1]},{ratios:[.8,.8]},{ratios:[.8,.8,.8,1],weights:[1,1,1,10]},{ratios:[.45,.6,.75,.9]}]){
  const f=fixture(options),r=legacyRun(f);assert.equal(shared(r).length,0,JSON.stringify(options));assert.ok(inv(r).length);
  const active=run(f);assertOutageOnly(active);assert.equal(active.issues.length,0);
 }
 const f=fixture();f.summary.equipmentProduction[4].intervalProduction=[];
 const r=legacyRun(f);assert.equal(shared(r).length,0);assert.ok(inv(r).length);
 assertOutageOnly(run(f));
});
test('direct legacy qualification still requires independent measured meter corroboration',()=>{
 for(const meter of ['missing','healthy','inconsistent','substituted']){
  const f=fixture(),p=f.summary.equipmentProduction[0];
  if(meter==='missing')p.intervalProduction=[];
  if(meter==='healthy')p.intervalProduction=f.summary.expectedProduction.map(p=>({...p}));
  if(meter==='inconsistent')p.intervalProduction.forEach(p=>p.energyKwh*=.5);
  if(meter==='substituted')f.summary.revenueMeterFallback={equipmentId:'meter',points:p.intervalProduction.filter(p=>p.energyKwh>0).map(p=>({...p,inverterAggregateEnergyKwh:p.energyKwh/.9702,wasMissing:true}))};
  const r=legacyRun(f);assert.equal(shared(r).length,0,meter);assert.ok(inv(r).length);
  assertOutageOnly(run(f));
 }
});
test('real inverter outages remain intact amid nonzero fleet deficits and split at healthy intervals',()=>{
 const f=fixture({ratioAt:(i,d,h)=>h===14?(i===0?0:1):.8}),r=run(f);assertOutageOnly(r);
 const outages=r.issues.filter(i=>i.equipmentId==='i0'&&i.type==='Equipment outage');assert.equal(outages.length,4);
 const ledger=outages.flatMap(i=>i.evidence.intervalLosses);assert.equal(ledger.length,4);
 assert.equal(new Set(ledger.map(p=>p.timestamp)).size,4);assert.ok(ledger.every(p=>p.timestamp.includes('T14:')&&p.actualKwh===0&&p.sharedSiteLossKwh===undefined));
 for(const p of ledger)near(p.lossKwh,50*.9702);
 assertLedger(r,4*50*.9702);
});
test('native outage cadence conserves energy when UTC and local dates differ; legacy evidence still pages',()=>{
 const totals=[];
 for(const minutes of [5,60]){
  const f=fixture({minutes,ratios:[0,1,1,1]});f.summary.timezone='Pacific/Honolulu';
  // Ordinary 10:00–16:00 local daylight spans two UTC dates (20:00–02:00).
  for(const points of [f.summary.intervalIrradiance,f.summary.expectedProduction,...f.summary.equipmentProduction.map(p=>p.intervalProduction)])
   for(const p of points)p.timestamp=new Date(Date.parse(p.timestamp)+8*3600000).toISOString();
  const r=run(f);assertOutageOnly(r);assertLedger(r,4*6*50*.9702);totals.push(r.totalLossKwh);
  assert.ok(r.issues.length);assert.ok(r.issues.every(i=>i.type==='Equipment outage'&&i.equipmentId==='i0'&&i.startDateTime.endsWith('Z')&&i.timezone==='Pacific/Honolulu'));
  const ledger=r.issues.flatMap(i=>i.evidence.intervalLosses);assert.equal(ledger.length,4*6*60/minutes);
  assert.equal(new Set(ledger.map(p=>p.timestamp)).size,ledger.length);
  assert.equal(new Set(ledger.map(p=>p.timestamp.slice(0,10))).size,5);
  assert.equal(new Set(ledger.map(p=>time.localDate(p.timestamp,'Pacific/Honolulu'))).size,4);assert.equal(r.analyzedDays,4);
  assert.equal(r.analysisIntervalMinutes,minutes);assert.ok(ledger.every(p=>p.actualKwh===0&&Math.abs(p.lossKwh-50*minutes/60*.9702)<1e-8));
 }
 near(totals[0],totals[1]);
 const historical=legacyRun(fixture({minutes:5,ratios:[.5,.8,.8,.8]}));assertLedger(historical,4*6*55*.9702);
 const s=shared(historical)[0],row=sharedEvidencePage(s).rows[0],first=sharedEvidencePage(s,0,row.issueId),next=sharedEvidencePage(s,first.next,row.issueId),last=sharedEvidencePage(s,next.next,row.issueId);
 assert.equal(first.total,4*6*12);assert.equal(first.intervals.length,100);assert.equal(next.intervals.length,100);assert.equal(last.intervals.length,88);assert.equal(last.next,null);
 const pages=[...first.intervals,...next.intervals,...last.intervals];assert.equal(new Set(pages.map(p=>p.timestamp)).size,first.total);assert.ok(pages.every(p=>p.intervalMinutes===5));
 near(pages.reduce((s,p)=>s+p.sharedLossKwh,0),row.sharedLossKwh);
});
test('direct legacy snow, irradiance and model exclusions remain compatible without active shared work',()=>{
 for(const mode of ['snow','low','capacity','missing-model','invalid-expected']){
  const f=fixture();
  if(mode==='snow'){f.summary.snowSensorConfigured=true;f.summary.snowDays=['2026-06-01','2026-06-02','2026-06-03','2026-06-04'];}
  if(mode==='low')f.summary.intervalIrradiance.forEach(p=>{if(p.averageWm2)p.averageWm2=150;});
  if(mode==='capacity')f.summary.expectedProduction.forEach(p=>p.energyKwh*=1.95);
  if(mode==='missing-model')f.assets.find(a=>a.id==='m0').quantity=0;
  if(mode==='invalid-expected')f.summary.expectedProduction.forEach(p=>p.energyKwh*=3);
  const r=legacyRun(f);assert.equal(shared(r).length,0,mode);assert.ok(inv(r).length);
  const active=run(f);assertOutageOnly(active);assert.equal(active.issues.length,0);
 }
});
test('site outages retain priority and remain separated by an unknown daytime telemetry gap',()=>{
 const f=fixture({ratioAt:(i,d,h)=>d===1&&h===14?0:.8}),r=run(f);assertOutageOnly(r);
 assert.equal(r.issues.length,1);assert.equal(r.issues[0].type,'Site outage');assertLedger(r,200*.9702);
 assert.equal(r.issues[0].evidence.intervalLosses.length,1);assert.equal(r.issues[0].evidence.intervalLosses[0].timestamp,'2026-06-02T14:00:00.000Z');
 const g=fixture({ratioAt:(i,d,h)=>d===1&&[13,15].includes(h)?0:.8});
 for(const p of g.summary.equipmentProduction)p.intervalProduction=p.intervalProduction.filter(p=>p.timestamp!=='2026-06-02T14:00:00.000Z');
 const s=run(g);assertOutageOnly(s);assertLedger(s,2*200*.9702);
 const outages=s.issues.filter(i=>i.type==='Site outage');assert.equal(outages.length,2);
 assert.deepEqual(Array.from(outages.flatMap(i=>i.evidence.intervalLosses),p=>p.timestamp).sort(),['2026-06-02T13:00:00.000Z','2026-06-02T15:00:00.000Z']);
 const gap=s.issues.find(i=>i.lossUnknown);assert.ok(gap);assert.equal(gap.type,'Site telemetry outage');assert.equal(gap.productionUnknown,true);
 assert.equal(gap.startDateTime,'2026-06-02T14:00:00.000Z');assert.equal(gap.endDateTime,'2026-06-02T15:00:00.000Z');
 assert.equal(s.issues.filter(i=>i.equipmentType==='inverter').length,0,'covered child outages must not duplicate site loss');
});
test('existing unexplained meter remainder is folded into the same site item exactly once',()=>{
 const timestamp='2026-06-01T12:00:00Z';
 const base={id:'inv',name:'Inv',type:'Underperformance',category:'Performance',equipmentId:'i',equipmentType:'inverter',equipmentName:'I',equipmentExternalId:'i',startDateTime:timestamp,endDateTime:'2026-06-01T13:00:00Z',durationMinutes:60,durationDays:1/24,estimatedLossKwh:20,actualEnergyKwh:80,expectedEnergyKwh:100,lossPercent:20,siteImpactPercent:25,description:'',evidence:{intervalLosses:[{timestamp,lossKwh:20,actualKwh:80,expectedKwh:100,derivedInverterExpectedKwh:100}]}};
 const meter={...base,id:'meter',equipmentId:'meter',equipmentType:'revenue_meter',estimatedLossKwh:7,evidence:{intervalLosses:[{timestamp,lossKwh:7,actualKwh:300,expectedKwh:307}]}};
 const common=new Map([[timestamp,{ratio:.8,meterActualKwh:300,meterExpectedKwh:400,eligibleCapacityPercent:100,supportingCapacityPercent:100,supportingInverters:4}]]);
 const result=model.allocateSharedReductions([base,meter],common,{id:'meter',name:'POI'},60,()=>false,()=>base.endDateTime);
 assert.equal(result.length,1);near(result[0].estimatedLossKwh,27);assert.equal(result[0].evidence.intervalLosses[0].unexplainedSiteLossKwh,7);
});
