import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadSource, modelCapacityBindings} from './source-module.mjs';

const time=loadSource('app/telemetry-time.ts');
const causes=loadSource('app/api/performance-summary/causes.ts',[],time);
const telemetry=loadSource('app/api/performance-summary/telemetry-events.ts',[],{...time,...causes,...modelCapacityBindings()});
const forbidden=['compareCapacityPeers','sharedReductionIntervals','allocateSharedReductions','attributeCauses','splitRecurringGaps','buildRecurringIssues','transformerPeerExclusions'];
const calls=Object.fromEntries(forbidden.map(name=>[name,0]));
const engine=loadSource('app/api/performance-summary/route.ts',['buildAnalysis','buildAnalysisSteps','applyLossThreshold','publicIssue','displayPayload','applyInverterLossAttribution'],{
  ...time,...causes,...modelCapacityBindings(),...telemetry,
  ...Object.fromEntries(forbidden.map(name=>[name,()=>{calls[name]++;throw new Error(`Removed analytical work called: ${name}`);}]))
});
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
function fixture(count=8,minutes=60,length=6){
  const equipment=[{id:'meter',name:'Meter',externalId:'meter',type:'revenue_meter',aliases:'[]',acLineLossPercent:'0',transformerLossPercent:'0'}];
  for(let i=0;i<count;i++)equipment.push({id:`inv${i}`,name:`Inverter ${i+1}`,externalId:`inv${i}`,type:'inverter',parentId:'meter',acRatedCapacityKw:'100',aliases:'[]'},
    {id:`modules${i}`,name:`Modules ${i+1}`,type:'module_group',parentId:`inv${i}`,moduleRatedCapacityW:'500',quantity:200,aliases:'[]'});
  const timestamps=Array.from({length},(_,i)=>new Date(Date.UTC(2026,5,1,10)+i*minutes*60000).toISOString());
  const summary={timezone:'UTC',intervalMinutes:minutes,timestamps,expectedProduction:timestamps.map(timestamp=>({timestamp,energyKwh:count*50*minutes/60})),
    intervalIrradiance:timestamps.map(timestamp=>({timestamp,averageWm2:600,insolationKwhM2:.6*minutes/60,readingCount:1,peakWm2:600})),
    equipmentProduction:equipment.filter(a=>['inverter','revenue_meter'].includes(a.type)).map(a=>({equipmentId:a.id,equipmentName:a.name,equipmentType:a.type,externalId:a.externalId,capacityKw:a.type==='inverter'?100:count*100,readingCount:length,source:'interval_energy',dailyProduction:[],intervalProduction:timestamps.map(timestamp=>({timestamp,energyKwh:(a.type==='inverter'?50:count*50)*minutes/60}))})),
    dailyProduction:[],totalEnergyKwh:0,latestDate:'',latestDayEnergyKwh:0,readingCount:length,source:'interval_energy'};
  return {summary,equipment};
}
function set(f,id,index,value){const series=f.summary.equipmentProduction.find(p=>p.equipmentId===id),t=f.summary.timestamps[index];series.intervalProduction=series.intervalProduction.filter(p=>p.timestamp!==t);if(value!==undefined)series.intervalProduction.push({timestamp:t,energyKwh:value});series.intervalProduction.sort((a,b)=>a.timestamp.localeCompare(b.timestamp));}
function expected(f,index,value){const t=f.summary.timestamps[index];f.summary.expectedProduction=f.summary.expectedProduction.filter(p=>p.timestamp!==t);if(value!==undefined)f.summary.expectedProduction.push({timestamp:t,energyKwh:value});f.summary.expectedProduction.sort((a,b)=>a.timestamp.localeCompare(b.timestamp));}
function allZero(f,index){for(const p of f.summary.equipmentProduction)set(f,p.equipmentId,index,0);}
const run=f=>engine.buildAnalysis(f.summary,f.equipment);
const outage=(result,id='meter')=>result.issues.filter(i=>i.equipmentId===id&&['Site outage','Equipment outage','Partial site outage'].includes(i.type));

test('normal and resumed outage engine never enters historical/peer/shared/cause/recurring work',()=>{
 const f=fixture(20);for(let n=0;n<6;n++){set(f,'inv0',n,0);set(f,'meter',n,950);}
 const direct=run(structuredClone(f));assert.ok(outage(direct,'inv0').length);
 let offset=0,issues=[],result;let batches=0;
 for(let k=0;k<5;k++){
  const step=engine.buildAnalysisSteps(structuredClone(f.summary),f.equipment,{offset,limit:16,issues});let next=step.next();
  while(!next.done&&!next.value.equipmentCheckpoint)next=step.next();
  if(next.done){result=next.value;break;}
  offset=next.value.completed;issues=next.value.equipmentCheckpoint.issues;batches++;
 }
 assert.ok(result,'resumed calculator must complete, not stop at a checkpoint');assert.equal(batches,2);
 assert.deepEqual(JSON.parse(JSON.stringify(result)),JSON.parse(JSON.stringify(direct)));
 assert.deepEqual(Object.values(calls),forbidden.map(()=>0));
 const source=readFileSync('app/api/performance-summary/route.ts','utf8');
 for(const removed of ['yieldsByDay','baselineByDay','derivedDeficitDays','persistentDerivedDeficit'])assert.ok(!source.includes(removed),removed);
 assert.equal(result.recurringIssues.length,0);assert.equal(result.peerComparison,undefined);assert.equal(result.causeAnalysis,undefined);
});

test('supplied weather-adjusted site expectation is used exactly at each timestamp without capacity or weather refit',()=>{
 const f=fixture(2);f.equipment.push({id:'tx',name:'Transformer',type:'transformer',parentId:'meter',nameplateKva:'100'});
 for(const a of f.equipment.filter(a=>a.type==='inverter'))a.parentId='tx';
 for(let n=1;n<=3;n++)allZero(f,n);
 expected(f,1,135);expected(f,2,270);expected(f,3,60);
 f.summary.snowSensorConfigured=true;f.summary.snowDays=['2026-06-01'];
 const before=JSON.stringify(f.summary.expectedProduction),result=run(f),items=outage(result);
 close(result.totalLossKwh,465);close(items.reduce((s,i)=>s+i.estimatedLossKwh,0),465);
 assert.equal(JSON.stringify(f.summary.expectedProduction),before);
 assert.ok(items.every(i=>!i.suspectedCause));assert.match(result.baselineMethod,/supplied|Expected Production/i);
 assert.ok(!/28-day|recurr|historical|underperformance|shading allowance/i.test(result.baselineMethod));
});

for(const missing of [undefined,NaN,Infinity,-1])test(`invalid or absent expectation (${String(missing)}) retains site outage and known actual, but no invented energy`,()=>{
 const f=fixture();allZero(f,2);expected(f,2,missing);const result=run(f),[issue]=outage(result);
 assert.ok(issue);assert.equal(issue.lossUnknown,true);assert.equal(result.totalLossKwh,0);
 assert.equal(engine.publicIssue(issue).estimatedLossKwh,null);assert.equal(engine.publicIssue(issue).lossPercent,null);
 assert.equal(engine.publicIssue(issue).actualEnergyKwh,0);assert.equal(engine.publicIssue(issue).expectedEnergyKwh,null);
 assert.equal(issue.evidence.lossUnknown,true);assert.equal(issue.evidence.expectedUnknown,true);
 assert.equal(engine.applyLossThreshold(result,'99999').issues.length,1);
 assert.equal(result.issues.filter(i=>i.equipmentType==='inverter').length,0);
});

test('valid expected zero is known zero, and missing reference splits adjacent outage coverage',()=>{
 const f=fixture();for(let n=1;n<=4;n++)allZero(f,n);expected(f,2,undefined);expected(f,3,0);
 const result=run(f),items=outage(result);close(result.totalLossKwh,800);
 assert.equal(items.filter(i=>i.lossUnknown).length,1);
 const unknown=items.find(i=>i.lossUnknown);assert.equal(unknown.startDateTime,f.summary.timestamps[2]);assert.equal(unknown.endDateTime,f.summary.timestamps[3]);
 const zero=items.flatMap(i=>i.evidence.intervalLosses).find(p=>p.timestamp===f.summary.timestamps[3]);
 assert.equal(zero.expectedKwh,0);assert.equal(zero.lossKwh,0);assert.notEqual(zero.lossUnknown,true);
 for(const issue of items.filter(i=>!i.lossUnknown))assert.ok(issue.evidence.intervalLosses.every(p=>!p.lossUnknown));
});

test('inverter zero qualifies from supplied expectation without irradiance, and no minimum history is needed',()=>{
 for(const minutes of [5,15,60]){const f=fixture(2,minutes,1);f.summary.intervalIrradiance=[];set(f,'inv0',0,0);set(f,'meter',0,50*minutes/60);
  const result=run(f),[issue]=outage(result,'inv0');assert.ok(issue);close(issue.estimatedLossKwh,50*minutes/60);assert.equal(issue.durationMinutes,minutes);
 }
 const f=fixture(2);f.summary.intervalIrradiance.forEach(p=>p.averageWm2=49);set(f,'inv0',2,0);set(f,'meter',2,50);assert.equal(outage(run(f),'inv0').length,0);
});

test('inverter unknown reference, capacity conflict, or incomplete fleet model never falls back to AC/equal/observed shares',()=>{
 for(const change of [f=>expected(f,2,undefined),f=>expected(f,2,201),f=>f.equipment.find(a=>a.id==='modules1').quantity=0]){
  const f=fixture(2);set(f,'inv0',2,0);set(f,'meter',2,50);change(f);const result=run(f),[issue]=outage(result,'inv0');
  assert.ok(issue);assert.equal(issue.lossUnknown,true);assert.equal(issue.evidence.lossUnknown,true);assert.equal(engine.publicIssue(issue).estimatedLossKwh,null);assert.equal(result.totalLossKwh,0);
 }
});

test('inverter outage allocation uses full configured module DC population and delivery conversion once',()=>{
 const f=fixture(2,15);f.equipment[0].acLineLossPercent='2';f.equipment[0].transformerLossPercent='1';f.equipment.find(a=>a.id==='modules1').quantity=400;
 expected(f,2,150*.9702/4);set(f,'inv0',2,0);set(f,'inv1',2,25);set(f,'meter',2,25*.9702);
 const [issue]=outage(run(f),'inv0');close(issue.estimatedLossKwh,50*.9702/4);close(issue.expectedEnergyKwh,50*.9702/4);
 close(issue.evidence.intervalLosses[0].inverterTerminalLossKwh,50/4);assert.equal(issue.evidence.intervalLosses[0].lossBoundary,'meter_poi');
});

for(const sample of [
 {name:'known expected and actual',expectedUnknown:false,expectedKwh:50,actualKwh:10},
 {name:'unknown expected and known actual',expectedUnknown:true,expectedKwh:0,actualKwh:10},
 {name:'known zero expected and actual',expectedUnknown:false,expectedKwh:0,actualKwh:0},
])test(`inverter delivery converts ${sample.name} independently of unknown loss`,()=>{
 const equipment=[{id:'meter',type:'revenue_meter',acLineLossPercent:'2',transformerLossPercent:'1'}];
 const interval={timestamp:'2026-06-01T11:00:00.000Z',lossKwh:0,lossUnknown:true,expectedUnknown:sample.expectedUnknown,
  expectedKwh:sample.expectedKwh,actualKwh:sample.actualKwh,derivedInverterExpectedKwh:sample.expectedKwh,lossUnavailableReason:'branch_actual_coverage'};
 const issue={equipmentType:'inverter',lossUnknown:true,expectedUnknown:sample.expectedUnknown,productionUnknown:false,
  estimatedLossKwh:0,lossPercent:0,actualEnergyKwh:sample.actualKwh,expectedEnergyKwh:sample.expectedKwh,
  evidence:{lossUnknown:true,expectedUnknown:sample.expectedUnknown,productionUnknown:false,intervalLosses:[interval]}};
 const before=JSON.stringify(issue),meterIssues=[{equipmentType:'revenue_meter',expectedEnergyKwh:80}];
 const result=engine.applyInverterLossAttribution(meterIssues,[issue],equipment,60),converted=result.equipmentIssues[0],point=converted.evidence.intervalLosses[0];
 close(converted.actualEnergyKwh,sample.actualKwh*.9702);close(point.actualKwh,sample.actualKwh*.9702);
 close(converted.expectedEnergyKwh,sample.expectedKwh*.9702);close(point.expectedKwh,sample.expectedKwh*.9702);
 assert.equal(converted.lossUnknown,true);assert.equal(converted.expectedUnknown,sample.expectedUnknown);assert.equal(converted.productionUnknown,false);
 assert.equal(converted.estimatedLossKwh,0);assert.equal(point.lossKwh,0);assert.equal(point.lossUnknown,true);
 assert.equal(point.expectedUnknown,sample.expectedUnknown);assert.equal(point.lossUnavailableReason,'branch_actual_coverage');
 assert.equal(point.derivedInverterExpectedKwh,sample.expectedKwh,'terminal allocation evidence is not converted');
 assert.equal(converted.evidence.lossUnknown,true);assert.equal(converted.evidence.expectedUnknown,sample.expectedUnknown);assert.equal(converted.evidence.productionUnknown,false);
 const publicResult=engine.publicIssue(converted);
 assert.equal(publicResult.estimatedLossKwh,null);assert.equal(publicResult.lossPercent,null);
 assert.equal(publicResult.expectedEnergyKwh,sample.expectedUnknown?null:sample.expectedKwh*.9702);
 assert.equal(publicResult.actualEnergyKwh,sample.actualKwh*.9702);
 assert.equal(JSON.stringify(issue),before);assert.equal(result.meterIssues,meterIssues);assert.equal(meterIssues[0].expectedEnergyKwh,80);
});

test('inverter delivery preserves unknown event loss and partial terminal loss evidence',()=>{
 const equipment=[{id:'meter',type:'revenue_meter',acLineLossPercent:'2',transformerLossPercent:'1'}];
 const intervals=[{timestamp:'2026-06-01T11:00:00.000Z',expectedKwh:50,actualKwh:10,lossKwh:40,lossUnknown:false},
  {timestamp:'2026-06-01T12:00:00.000Z',expectedKwh:50,actualKwh:10,lossKwh:0,lossUnknown:true,lossUnavailableReason:'branch_actual_coverage'}];
 const issue={equipmentType:'inverter',estimatedLossKwh:0,lossPercent:0,expectedEnergyKwh:100,actualEnergyKwh:20,
  lossUnknown:true,expectedUnknown:false,productionUnknown:false,
  evidence:{lossUnknown:true,lossCoverage:{knownIntervals:1,unknownIntervals:1,knownLossKwh:40},intervalLosses:intervals}};
 const before=JSON.stringify(issue),converted=engine.applyInverterLossAttribution([],[issue],equipment,60).equipmentIssues[0];
 close(converted.expectedEnergyKwh,97.02);close(converted.actualEnergyKwh,19.404);
 assert.equal(converted.estimatedLossKwh,0);assert.equal(converted.lossPercent,0);assert.equal(converted.lossUnknown,true);
 assert.equal(engine.publicIssue(converted).estimatedLossKwh,null);
 for(let index=0;index<intervals.length;index++){
  const point=converted.evidence.intervalLosses[index];close(point.expectedKwh,48.51);close(point.actualKwh,9.702);
  assert.equal(point.lossKwh,intervals[index].lossKwh);assert.equal(point.lossUnknown,intervals[index].lossUnknown);
  assert.equal(point.lossBoundary,undefined,'unquantified loss must not be labeled delivered');
 }
 assert.deepEqual(converted.evidence.lossCoverage,issue.evidence.lossCoverage);assert.equal(JSON.stringify(issue),before);
});

test('branch recoverable headroom is shared and missing sibling actual makes the loss explicitly incomplete',()=>{
 const setup=()=>{const f=fixture(4);f.equipment.push({id:'tx',name:'Transformer',type:'transformer',parentId:'meter',nameplateKva:'120'});for(const a of f.equipment.filter(a=>a.type==='inverter'))a.parentId='tx';expected(f,2,120);set(f,'inv0',2,0);set(f,'inv1',2,0);set(f,'inv2',2,50);set(f,'inv3',2,50);set(f,'meter',2,100);return f;};
 const complete=run(setup());close(complete.totalLossKwh,20);close(outage(complete,'inv0')[0].estimatedLossKwh,10);close(outage(complete,'inv1')[0].estimatedLossKwh,10);
 const f=setup();set(f,'inv3',2,undefined);const incomplete=run(f);
 for(const id of ['inv0','inv1']){const [issue]=outage(incomplete,id);assert.ok(issue);assert.equal(issue.lossUnknown,true);assert.equal(issue.evidence.lossUnknown,true);assert.equal(engine.publicIssue(issue).estimatedLossKwh,null);}
 assert.equal(incomplete.totalLossKwh,0);
});

test('complete producing fleet plus missing expected is a communication issue with known production, unknown loss',()=>{
 const f=fixture();set(f,'meter',2,undefined);expected(f,2,undefined);const result=run(f),issue=result.issues.find(i=>i.type==='Communication issue');
 assert.ok(issue);assert.equal(issue.lossUnknown,true);assert.equal(issue.productionUnknown,false);assert.equal(engine.publicIssue(issue).actualEnergyKwh,400);assert.equal(engine.publicIssue(issue).expectedEnergyKwh,null);assert.equal(engine.publicIssue(issue).estimatedLossKwh,null);
 assert.equal(f.summary.equipmentProduction[0].intervalProduction.find(p=>p.timestamp===f.summary.timestamps[2]).energyKwh,400);
 assert.equal(result.issues.filter(i=>i.category==='Performance').length,0);
});

test('low positive output cannot create site/inverter underperformance or a partial outage cohort',()=>{
 const f=fixture(8,60,100);for(const p of f.summary.equipmentProduction)for(const point of p.intervalProduction)point.energyKwh*=.1;
 const result=run(f);assert.equal(result.issues.length,0);assert.equal(result.totalLossKwh,0);assert.equal(result.recurringIssues.length,0);
});

test('supported partial onset survives without an intermediate underperformance detector',()=>{
 const f=fixture();for(const p of f.summary.equipmentProduction)set(f,p.equipmentId,1,p.equipmentType==='inverter'?32.5:260);
 for(let n=2;n<5;n++)allZero(f,n);const result=run(f),[issue]=outage(result);
 assert.equal(result.issues.length,1);assert.equal(issue.startDateTime,f.summary.timestamps[1]);assert.equal(issue.endDateTime,f.summary.timestamps[5]);close(issue.estimatedLossKwh,1340);assert.equal(issue.evidence.intervalLosses.length,4);
});

test('unknown synchronized partial outage and unknown prior child remain visible without double counting',()=>{
 const f=fixture();for(let n=0;n<6;n++){set(f,'inv7',n,0);set(f,'meter',n,350);expected(f,n,undefined);}
 for(let n=1;n<4;n++){for(let i=0;i<4;i++)set(f,`inv${i}`,n,0);set(f,'meter',n,150);}
 const result=run(f),partial=result.issues.filter(i=>i.type==='Partial site outage');assert.equal(partial.length,1);assert.equal(partial[0].lossUnknown,true);assert.equal(partial[0].actualEnergyKwh,450);
 assert.ok(outage(result,'inv7').length);assert.ok(result.issues.every(i=>i.lossUnknown));assert.equal(result.totalLossKwh,0);
 for(const issue of result.issues.filter(i=>['inv0','inv1','inv2','inv3'].includes(i.equipmentId)))assert.ok(issue.endDateTime<=f.summary.timestamps[1]||issue.startDateTime>=f.summary.timestamps[4]);
});
