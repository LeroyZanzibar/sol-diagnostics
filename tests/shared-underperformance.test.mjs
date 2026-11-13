import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource,modelCapacityBindings} from './source-module.mjs';
const model=modelCapacityBindings(),time=loadSource('app/telemetry-time.ts');
const peers=loadSource('app/api/performance-summary/peer-comparison.ts',[],{...model,...time});
const causes=loadSource('app/api/performance-summary/causes.ts',[],time);
const telemetry=loadSource('app/api/performance-summary/telemetry-events.ts',[],{...model,...time,...causes});
const bindings={...model,...time,...peers,...causes,...telemetry};
const {buildAnalysis}=loadSource('app/api/performance-summary/route.ts',['buildAnalysis'],bindings);
const old=loadSource('app/api/performance-summary/route.ts',['buildAnalysis'],{...bindings,sharedReductionIntervals:()=>new Map()}).buildAnalysis;
const {sharedEvidencePage}=loadSource('app/shared-reduction-evidence.ts');
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
function fixture({ratios=[.8,.8,.8,.8],days=4,minutes=60,weights=ratios.map(()=>1),ratioAt}={}){
 const assets=[{id:'meter',name:'POI',type:'revenue_meter',externalId:'meter',acLineLossPercent:'2',transformerLossPercent:'1'}];
 ratios.forEach((_,i)=>assets.push({id:`i${i}`,name:`Inverter ${i}`,externalId:`i${i}`,type:'inverter',parentId:'meter',acRatedCapacityKw:String(100*weights[i])},
  {id:`m${i}`,type:'module_group',parentId:`i${i}`,moduleRatedCapacityW:'500',quantity:200*weights[i]}));
 const production=assets.filter(a=>a.type!=='module_group').map(a=>({equipmentId:a.id,equipmentName:a.name,equipmentType:a.type,externalId:a.id,capacityKw:a.id==='meter'?100*weights.reduce((a,b)=>a+b,0)*.9702:Number(a.acRatedCapacityKw),intervalProduction:[],dailyProduction:[]}));
 const summary={intervalMinutes:minutes,timezone:'America/New_York',equipmentProduction:production,intervalIrradiance:[],expectedProduction:[],dailyProduction:[],source:'interval_energy'};
 for(let day=0;day<days;day++)for(let minute=0;minute<1440;minute+=minutes){
  const timestamp=new Date(Date.UTC(2026,5,1+day,0,minute)).toISOString(),hour=Math.floor(minute/60),energy=hour>=12&&hour<18?50*minutes/60:0;
  summary.intervalIrradiance.push({timestamp,averageWm2:energy?600:0,insolationKwhM2:energy?.6*minutes/60:0,readingCount:1,peakWm2:energy?600:0});
  summary.expectedProduction.push({timestamp,energyKwh:energy*weights.reduce((a,b)=>a+b,0)*.9702});
  let fleet=0;
  ratios.forEach((ratio,i)=>{const value=energy*weights[i]*(ratioAt?.(i,day,hour)??ratio);production[i+1].intervalProduction.push({timestamp,energyKwh:value});fleet+=value;});
  production[0].intervalProduction.push({timestamp,energyKwh:fleet*.9702});
 }
 return {summary,assets};
}
const run=f=>buildAnalysis(structuredClone(f.summary),f.assets);
const shared=r=>r.issues.filter(i=>i.evidence.rule==='shared_site_reduction_v1');
const inv=r=>r.issues.filter(i=>i.equipmentType==='inverter'&&i.type==='Underperformance');
function conserved(f,r){const before=old(structuredClone(f.summary),f.assets);near(r.totalLossKwh,before.totalLossKwh);near(r.totalLossKwh,r.issues.flatMap(i=>i.evidence.intervalLosses).reduce((s,p)=>s+(p.countedLossKwh??p.lossKwh),0));}
test('uniform fleet reduction becomes one shared review with unchanged delivered loss and source evidence',()=>{
 const f=fixture(),r=run(f);conserved(f,r);assert.equal(shared(r).length,1);assert.equal(inv(r).length,0);
 const issue=shared(r)[0];near(issue.estimatedLossKwh,4*6*4*10*.9702);assert.equal(issue.affectedEquipment.length,4);assert.equal(issue.suspectedCause,'');
 const page=sharedEvidencePage(issue);assert.equal(page.rows.length,4);near(page.rows.reduce((s,p)=>s+p.sharedLossKwh,0),issue.estimatedLossKwh);
 const intervals=sharedEvidencePage(issue,0,page.rows[0].issueId);assert.equal(intervals.total,24);near(intervals.intervals[0].expectedKwh,50*.9702);
});
test('80% fleet and 50% outlier retain only the additional 30 percentage-point deficit',()=>{
 const f=fixture({ratios:[.5,.8,.8,.8]}),r=run(f);conserved(f,r);assert.equal(shared(r).length,1);assert.equal(inv(r).length,1);
 near(inv(r)[0].estimatedLossKwh,4*6*15*.9702);near(shared(r)[0].estimatedLossKwh,4*6*40*.9702);
 assert.ok(inv(r)[0].evidence.intervalLosses.every(p=>p.detectionBasis==='additional_inverter_deficit_v1'));
 const raw=sharedEvidencePage(shared(r)[0]).rows.find(p=>p.equipmentId==='i0');near(raw.originalLossKwh,raw.sharedLossKwh+raw.additionalLossKwh);
});
test('minor differences are consolidated without dropping energy, exact material boundary remains separate',()=>{
 for(const outlier of [.71,.7]){const f=fixture({ratios:[outlier,.8,.8,.8]}),r=run(f);conserved(f,r);assert.equal(inv(r).length,outlier===.7?1:0);assert.equal(shared(r).length,1);}
});
test('healthy fleet, two inverters, insufficient capacity coverage and inconsistent ratios do not suppress findings',()=>{
 for(const options of [{ratios:[.5,1,1,1]},{ratios:[.8,.8]},{ratios:[.8,.8,.8,1],weights:[1,1,1,10]},{ratios:[.45,.6,.75,.9]}]){
  const f=fixture(options),r=run(f);conserved(f,r);assert.equal(shared(r).length,0,JSON.stringify(options));assert.ok(inv(r).length);
 }
 const f=fixture();f.summary.equipmentProduction[4].intervalProduction=[];const r=run(f);assert.equal(shared(r).length,0);conserved(f,r);
});
test('meter must independently corroborate the reduction; missing, substituted, healthy and inconsistent meter do not qualify',()=>{
 for(const meter of ['missing','healthy','inconsistent','substituted']){
  const f=fixture(),p=f.summary.equipmentProduction[0];
  if(meter==='missing')p.intervalProduction=[];
  if(meter==='healthy')p.intervalProduction=f.summary.expectedProduction.map(p=>({...p}));
  if(meter==='inconsistent')p.intervalProduction.forEach(p=>p.energyKwh*=.5);
  if(meter==='substituted')f.summary.revenueMeterFallback={equipmentId:'meter',points:p.intervalProduction.filter(p=>p.energyKwh>0).map(p=>({...p,inverterAggregateEnergyKwh:p.energyKwh/.9702,wasMissing:true}))};
  const r=run(f);assert.equal(shared(r).length,0,meter);conserved(f,r);
 }
});
test('inverter faults outside shared intervals remain intact; qualified healthy intervals split shared events',()=>{
 const f=fixture({ratios:[.5,.8,.8,.8],ratioAt:(i,d,h)=>i===0?.5:(h===14?1:.8)}),r=run(f);conserved(f,r);
 assert.ok(shared(r).length>1);assert.ok(shared(r).every(i=>!i.evidence.intervalLosses.some(p=>p.timestamp.includes('T14:'))));
 const p=inv(r).flatMap(i=>i.evidence.intervalLosses).find(p=>p.timestamp.includes('T14:'));near(p.lossKwh,25*.9702);
 assert.equal(p.sharedSiteLossKwh,undefined);
});
test('native five-minute cadence and UTC timestamps conserve energy across local date boundaries',()=>{
 const f=fixture({minutes:5,ratios:[.5,.8,.8,.8]}),r=run(f);conserved(f,r);near(r.totalLossKwh,4*6*55*.9702);
 assert.ok(r.issues.every(i=>i.startDateTime.endsWith('Z')&&i.timezone==='America/New_York'));
 const s=shared(r)[0],row=sharedEvidencePage(s).rows[0],first=sharedEvidencePage(s,0,row.issueId),next=sharedEvidencePage(s,first.next,row.issueId);
 assert.equal(first.intervals.length,100);assert.equal(next.intervals.length,100);assert.equal(first.intervals[0].intervalMinutes,5);
});
test('snow, low irradiance, capacity limits and incomplete expected models keep their existing treatment',()=>{
 for(const mode of ['snow','low','capacity','missing-model','invalid-expected']){
  const f=fixture();
  if(mode==='snow'){f.summary.snowSensorConfigured=true;f.summary.snowDays=['2026-06-01','2026-06-02','2026-06-03','2026-06-04'];}
  if(mode==='low')f.summary.intervalIrradiance.forEach(p=>{if(p.averageWm2)p.averageWm2=150;});
  if(mode==='capacity')f.summary.expectedProduction.forEach(p=>p.energyKwh*=1.95);
  if(mode==='missing-model')f.assets.find(a=>a.id==='m0').quantity=0;
  if(mode==='invalid-expected')f.summary.expectedProduction.forEach(p=>p.energyKwh*=3);
  const r=run(f);assert.equal(shared(r).length,0,mode);conserved(f,r);
 }
});
test('site outages retain priority and no common reduction crosses a missing daytime interval',()=>{
 const f=fixture({ratioAt:(i,d,h)=>d===1&&h===14?0:.8});const r=run(f);conserved(f,r);
 assert.ok(r.issues.some(i=>i.type==='Site outage'));assert.ok(shared(r).every(i=>!i.evidence.intervalLosses.some(p=>p.timestamp==='2026-06-02T14:00:00.000Z')));
 const g=fixture();for(const p of g.summary.equipmentProduction)p.intervalProduction=p.intervalProduction.filter(p=>p.timestamp!=='2026-06-02T14:00:00.000Z');
 const s=run(g);conserved(g,s);assert.ok(shared(s).length>=2);assert.ok(s.issues.some(i=>i.lossUnknown));
});
test('existing unexplained meter remainder is folded into the same site item exactly once',()=>{
 const timestamp='2026-06-01T12:00:00Z';
 const base={id:'inv',name:'Inv',type:'Underperformance',category:'Performance',equipmentId:'i',equipmentType:'inverter',equipmentName:'I',equipmentExternalId:'i',startDateTime:timestamp,endDateTime:'2026-06-01T13:00:00Z',durationMinutes:60,durationDays:1/24,estimatedLossKwh:20,actualEnergyKwh:80,expectedEnergyKwh:100,lossPercent:20,siteImpactPercent:25,description:'',evidence:{intervalLosses:[{timestamp,lossKwh:20,actualKwh:80,expectedKwh:100,derivedInverterExpectedKwh:100}]}};
 const meter={...base,id:'meter',equipmentId:'meter',equipmentType:'revenue_meter',estimatedLossKwh:7,evidence:{intervalLosses:[{timestamp,lossKwh:7,actualKwh:300,expectedKwh:307}]}};
 const common=new Map([[timestamp,{ratio:.8,meterActualKwh:300,meterExpectedKwh:400,eligibleCapacityPercent:100,supportingCapacityPercent:100,supportingInverters:4}]]);
 const result=model.allocateSharedReductions([base,meter],common,{id:'meter',name:'POI'},60,()=>false,()=>base.endDateTime);
 assert.equal(result.length,1);near(result[0].estimatedLossKwh,27);assert.equal(result[0].evidence.intervalLosses[0].unexplainedSiteLossKwh,7);
});
