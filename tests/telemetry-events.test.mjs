import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource, modelCapacityBindings} from './source-module.mjs';
const time=loadSource('app/telemetry-time.ts');
const causes={...time,...loadSource('app/api/performance-summary/causes.ts',[],time)};
Object.assign(causes, loadSource("app/api/performance-summary/peer-comparison.ts", [], {...modelCapacityBindings(),...time}));
const events=loadSource('app/api/performance-summary/telemetry-events.ts',[],{...modelCapacityBindings(),...(causes)});
const mapping=loadSource('app/meter-mapping.ts');
const engine=loadSource('app/api/performance-summary/route.ts',['buildAnalysis','publicIssue','applyLossThreshold','toKwh','toKw','toWm2'],{...modelCapacityBindings(),...({...causes,...events,...mapping})});
const intervals=['2026-06-01T10:00:00','2026-06-01T11:00:00','2026-06-01T12:00:00','2026-06-01T13:00:00','2026-06-01T14:00:00','2026-06-01T15:00:00'];
function fixture(count=8) {
  const assets=[{id:'meter',name:'Meter',externalId:'meter',type:'revenue_meter',acLineLossPercent:'0',transformerLossPercent:'0',aliases:'[]'}];
  for(let i=0;i<count;i++)assets.push({id:`i${i}`,name:`I${i}`,externalId:`i${i}`,type:'inverter',parentId:'meter',acRatedCapacityKw:'100',aliases:'[]'}, {id:`m${i}`,name:'modules',type:'module_group',parentId:`i${i}`,moduleRatedCapacityW:'400',quantity:250,aliases:'[]'});
  const summary={intervalMinutes:60,timestamps:intervals,expectedProduction:intervals.map(timestamp=>({timestamp,energyKwh:count*50})),intervalIrradiance:intervals.map(timestamp=>({timestamp,averageWm2:600,insolationKwhM2:.6,readingCount:1,peakWm2:600})),causeContext:{latitude:'37.2775',longitude:'-79.1188',timeZone:'America/New_York',assumptions:causes.expectedAssumptions({})},equipmentProduction:assets.filter(a=>a.type!=='module_group').map(a=>({equipmentId:a.id,equipmentName:a.name,equipmentType:a.type,externalId:a.id,capacityKw:a.type==='inverter'?100:count*100,readingCount:6,source:'interval_energy',dailyProduction:[],intervalProduction:intervals.map(timestamp=>({timestamp,energyKwh:a.type==='inverter'?50:count*50}))})),dailyProduction:[],totalEnergyKwh:0,latestDate:'',latestDayEnergyKwh:0,readingCount:6,source:'interval_energy'};
  return {assets,summary};
}
function set(summary,id,index,value) { const p=summary.equipmentProduction.find(p=>p.equipmentId===id);p.intervalProduction=p.intervalProduction.filter(p=>p.timestamp!==intervals[index]);if(value!==null)p.intervalProduction.push({timestamp:intervals[index],energyKwh:value});p.intervalProduction.sort((a,b)=>a.timestamp.localeCompare(b.timestamp)); }
const run=f=>engine.buildAnalysis(f.summary,f.assets);

test('empty cells remain absent, measured zeros remain zero',()=>{for(const fn of ['toKwh','toKw','toWm2']){assert.equal(engine[fn]('  ','',''),null);assert.equal(engine[fn]('0','',''),0);assert.equal(engine[fn]('bad','',''),null);}});
test('meter mapping blocks Other and absent assignments but permits Energy and Active power',()=>{const a=[{id:'meter',type:'revenue_meter',name:'SEL-735'}];for(const measurement of ['Other','']) assert.match(mapping.meterMappingError(a,{},[{column:'SEL-735',equipmentId:'meter',measurement}]),/Map the revenue meter/);for(const measurement of ['Energy','Active power'])assert.equal(mapping.meterMappingError(a,{},[{column:'SEL-735',equipmentId:'meter',measurement}]),'');});
test('all-blank daylight is one site telemetry outage with public null loss and null production',()=>{const f=fixture();for(let n=1;n<4;n++)for(const p of f.summary.equipmentProduction)set(f.summary,p.equipmentId,n,null);const a=run(f);const gaps=a.issues.filter(i=>i.type==='Site telemetry outage');assert.equal(gaps.length,1);assert.equal(gaps[0].startDateTime,intervals[1]);assert.equal(gaps[0].endDateTime,intervals[4]);assert.equal(a.totalLossKwh,0);assert.equal(a.issues.filter(i=>i.category==='Performance').length,0);assert.equal(engine.publicIssue(gaps[0]).estimatedLossKwh,null);assert.equal(engine.publicIssue(gaps[0]).actualEnergyKwh,null);assert.equal(engine.applyLossThreshold(a,'10000').issues.length,1);});
test('known darkness is zero-imputed with flags; missing coordinates never imply darkness',()=>{for(const coords of [true,false]){const f=fixture();f.summary.timestamps=['2026-06-01T00:00:00'];for(const p of f.summary.equipmentProduction)p.intervalProduction=[];f.summary.expectedProduction=[{timestamp:f.summary.timestamps[0],energyKwh:0}];f.summary.intervalIrradiance=[{timestamp:f.summary.timestamps[0],averageWm2:0}];if(!coords)f.summary.causeContext.latitude='';const a=run(f);assert.equal(a.issues.length,coords?0:1);assert.equal(a.telemetryQuality.nighttimeImputedIntervals.length,coords?1:0);}});
test('meter zero with all inverter blanks is one full site outage without child intervals',()=>{const f=fixture();for(let n=1;n<4;n++){set(f.summary,'meter',n,0);for(let i=0;i<8;i++)set(f.summary,`i${i}`,n,null);}const a=run(f);const outages=a.issues.filter(i=>i.type==='Site outage');assert.equal(outages.length,1);assert.equal(outages[0].estimatedLossKwh,1200);assert.equal(a.totalLossKwh,1200);assert.equal(a.issues.length,1);});
test('missing meter with complete zeros is probable outage; incomplete coverage stays unknown',()=>{for(const missing of [0,1]){const f=fixture();set(f.summary,'meter',2,null);for(let i=0;i<8;i++)set(f.summary,`i${i}`,2,i<missing?null:0);const a=run(f);const issue=a.issues.find(i=>i.startDateTime===intervals[2]&&i.equipmentId==='meter');assert.equal(issue.type,missing?'Communication issue':'Site outage');if(missing)assert.equal(engine.publicIssue(issue).estimatedLossKwh,null);else assert.equal(issue.confidence,'model-based');}});
test('incomplete inverter production cannot substitute for full site energy',()=>{const f=fixture();set(f.summary,'meter',2,null);set(f.summary,'i0',2,null);const a=run(f);const issue=a.issues.find(i=>i.type==='Communication issue');assert.ok(issue.lossUnknown);assert.equal(f.summary.equipmentProduction[0].intervalProduction.some(p=>p.timestamp===intervals[2]),false);assert.ok(!a.issues.some(i=>i.type==='Site outage'));});
test('missing inverter with healthy meter stays telemetry; corroborated isolated loss stays equipment-level',()=>{for(const production of [400,350]){const f=fixture();set(f.summary,'i0',2,null);set(f.summary,'meter',2,production);const a=run(f);assert.ok(!a.issues.some(i=>i.type==='Partial site outage'));if(production===400)assert.ok(a.issues.some(i=>i.type==='Equipment telemetry issue'));}});
test('synchronized partial outage creates one parent, excludes prior faults, and conserves the meter loss',()=>{const f=fixture();for(let n=0;n<6;n++){set(f.summary,'i7',n,0);set(f.summary,'meter',n,350);}for(let n=1;n<4;n++){for(let i=0;i<4;i++)set(f.summary,`i${i}`,n,null);set(f.summary,'meter',n,150);}const a=run(f);const parents=a.issues.filter(i=>i.type==='Partial site outage');assert.equal(parents.length,1);assert.deepEqual(parents[0].affectedEquipment.map(i=>i.id).sort(),['i0','i1','i2','i3']);assert.equal(parents[0].siteImpactPercent,50);assert.equal(parents[0].estimatedLossKwh,600,JSON.stringify(a.issues.map(i=>({type:i.type,id:i.equipmentId,start:i.startDateTime,end:i.endDateTime,loss:i.estimatedLossKwh,evidence:i.evidence}))));assert.equal(a.totalLossKwh,900);assert.equal(parents[0].startDateTime,intervals[1]);assert.equal(parents[0].endDateTime,intervals[4]);for(const i of a.issues.filter(i=>['i0','i1','i2','i3'].includes(i.equipmentId)))assert.ok(i.endDateTime<=intervals[1]||i.startDateTime>=intervals[4]);});
test('several missing inverter readings with healthy site meter never become partial outage',()=>{const f=fixture();for(let n=1;n<4;n++)for(let i=0;i<4;i++)set(f.summary,`i${i}`,n,null);const a=run(f);assert.equal(a.issues.filter(i=>i.category==='Performance').length,0);assert.ok(a.issues.some(i=>i.type==='Equipment telemetry issue'));});
test('full outages clip longstanding child issue dates as well as counted loss',()=>{const f=fixture();for(let n=0;n<6;n++){set(f.summary,'i0',n,0);set(f.summary,'meter',n,350);}for(let n=2;n<4;n++){set(f.summary,'meter',n,0);for(let i=1;i<8;i++)set(f.summary,`i${i}`,n,0);}const a=run(f);for(const i of a.issues.filter(i=>i.equipmentId==='i0'))assert.ok(i.endDateTime<=intervals[2]||i.startDateTime>=intervals[4]);assert.equal(a.totalLossKwh,1000);});
test('complete fleet fallback quantifies shortfall once and retains a communications finding',()=>{const f=fixture();set(f.summary,'meter',2,null);for(let i=0;i<8;i++)set(f.summary,`i${i}`,2,25);const a=run(f);assert.equal(a.totalLossKwh,200);assert.equal(a.issues.length,1);assert.equal(a.issues[0].type,'Communication issue');assert.equal(f.summary.equipmentProduction[0].intervalProduction.find(p=>p.timestamp===intervals[2]).energyKwh,200);});

test('partial onset and the adjoining telemetry-confirmed zero period form one outage end to end',()=>{
 const f=fixture();
 set(f.summary,'meter',1,260);for(let i=0;i<8;i++)set(f.summary,`i${i}`,1,32.5);
 for(let n=2;n<5;n++){set(f.summary,'meter',n,0);for(let i=0;i<8;i++)set(f.summary,`i${i}`,n,0);}
 const a=run(f),outages=a.issues.filter(i=>i.type==='Site outage');
 assert.equal(outages.length,1);
 const outage=outages[0];
 assert.equal(outage.startDateTime,intervals[1]);assert.equal(outage.endDateTime,intervals[5]);
 assert.equal(outage.durationMinutes,240);assert.equal(outage.estimatedLossKwh,1340);assert.equal(a.totalLossKwh,1340);
 assert.equal(outage.actualEnergyKwh,260);assert.equal(outage.expectedEnergyKwh,1600);
 assert.equal(outage.evidence.rule,'merged_adjoining_site_outages_v1');
 assert.equal(outage.evidence.segments.length,2);
 assert.deepEqual(Array.from(outage.evidence.segments,s=>s.evidence.rule),['irradiance_adjusted_baseline','cross_checked_telemetry_v1']);
 assert.equal(outage.evidence.intervalLosses.length,4);
 assert.equal(new Set(outage.evidence.intervalLosses.map(p=>p.timestamp)).size,4);
 assert.ok(!outage.description.includes('5% or less'));
 assert.equal(a.issues.length,1);
});

function outageSegment(id,start,readings,minutes=60,patch={}){
 const epoch=Date.parse(start),ledger=readings.map(([expectedKwh,actualKwh],n)=>({timestamp:new Date(epoch+n*minutes*60000).toISOString(),expectedKwh,actualKwh,lossKwh:expectedKwh-actualKwh}));
 const actual=ledger.reduce((s,p)=>s+p.actualKwh,0),expected=ledger.reduce((s,p)=>s+p.expectedKwh,0);
 return {id,name:'Site outage',type:'Site outage',category:'Performance',confidence:'model-based',severity:'critical',equipmentId:'meter',equipmentName:'Meter',equipmentType:'revenue_meter',equipmentExternalId:'meter',
  startDateTime:start,endDateTime:new Date(epoch+readings.length*minutes*60000).toISOString(),durationMinutes:readings.length*minutes,durationDays:readings.length*minutes/1440,
  estimatedLossKwh:expected-actual,lossPercent:100*(expected-actual)/expected,siteImpactPercent:100,actualEnergyKwh:actual,expectedEnergyKwh:expected,description:id,
  evidence:{rule:id,intervalLosses:ledger},...patch};
}

test('Randolph January 1 values merge to 11:00–18:00 Eastern with 7,923.59 kWh and intact evidence',()=>{
 const onset=outageSegment('partial-onset','2026-01-01T16:00:00.000Z',[[1304.953013,850]]);
 const zero=outageSegment('zero-period','2026-01-01T17:00:00.000Z',[1644.794493,1726.74135,1645.993305,1368.877539,888.7117619,193.519463].map(e=>[e,0]));
 const before=JSON.stringify([zero,onset]);
 const merged=events.mergeAdjoiningSiteOutages([zero,onset],60);
 assert.equal(merged.length,1);assert.equal(merged[0].id,onset.id);
 assert.equal(time.localTimestamp(merged[0].startDateTime,'America/New_York'),'2026-01-01T11:00:00');
 assert.equal(time.localTimestamp(merged[0].endDateTime,'America/New_York'),'2026-01-01T18:00:00');
 assert.ok(Math.abs(merged[0].estimatedLossKwh-7923.5909249)<1e-8);
 assert.ok(Math.abs(merged[0].estimatedLossKwh-(onset.estimatedLossKwh+zero.estimatedLossKwh))<1e-8);
 assert.equal(merged[0].durationMinutes,420);assert.equal(merged[0].actualEnergyKwh,850);
 assert.equal(merged[0].evidence.intervalCount,7);assert.equal(merged[0].evidence.segments[0].description,'partial-onset');
 assert.equal(JSON.stringify([zero,onset]),before);
 assert.deepEqual(events.mergeAdjoiningSiteOutages(merged,60),merged);
});

test('healthy or telemetry gaps, overlaps, unknown loss, other meters and other issue types remain separate',()=>{
 const first=outageSegment('a','2026-01-01T16:00:00.000Z',[[100,0]]);
 const next=outageSegment('b','2026-01-01T17:00:00.000Z',[[100,0]]);
 for(const other of [
  outageSegment('gap','2026-01-01T18:00:00.000Z',[[100,0]]),
  outageSegment('overlap','2026-01-01T16:30:00.000Z',[[100,0]]),
  {...next,lossUnknown:true}, {...next,productionUnknown:true}, {...next,equipmentId:'other-meter'},
  {...next,type:'Partial site outage'}, {...next,type:'Communication issue',category:'Communications'},
  {...next,equipmentType:'inverter'},
 ]) assert.equal(events.mergeAdjoiningSiteOutages([first,other],60).length,2,JSON.stringify(other));
 const gap={...next,type:'Site telemetry outage',category:'Communications',lossUnknown:true};
 const after=outageSegment('after','2026-01-01T18:00:00.000Z',[[100,0]]);
 assert.equal(events.mergeAdjoiningSiteOutages([first,gap,after],60).length,3);
});

test('five-minute chains retain counted loss, union affected equipment, and preserve source confidence',()=>{
 const chain=[0,1,2].map(n=>outageSegment(String(n),new Date(Date.UTC(2026,10,1,5,55+n*5)).toISOString(),[[100,20]],5,{confidence:n===0?'confirmed':'model-based',affectedEquipment:[{id:`i${n}`,name:`I${n}`}]}));
 chain[1].evidence.intervalLosses[0].countedLossKwh=50;chain[1].estimatedLossKwh=50;
 const [merged]=events.mergeAdjoiningSiteOutages([chain[2],chain[0],chain[1]],5);
 assert.equal(merged.durationMinutes,15);assert.equal(merged.estimatedLossKwh,210);assert.equal(merged.actualEnergyKwh,60);
 assert.equal(merged.confidence,'model-based');assert.equal(merged.affectedEquipment.length,3);
 assert.equal(merged.evidence.segments.length,3);assert.equal(merged.evidence.intervalLosses[1].countedLossKwh,50);
 // A repeated local hour is ordered by instant, not local clock text.
 assert.equal(time.localTimestamp(merged.startDateTime,'America/New_York'),'2026-11-01T01:55:00');
 assert.equal(time.localTimestamp(merged.endDateTime,'America/New_York'),'2026-11-01T01:10:00');
});

test('incomplete or duplicate ledgers cannot change conserved totals through merging',()=>{
 const first=outageSegment('a','2026-01-01T16:00:00.000Z',[[100,0]]),next=outageSegment('b','2026-01-01T17:00:00.000Z',[[100,0]]);
 for(const evidence of [undefined,{intervalLosses:[]},{intervalLosses:[...first.evidence.intervalLosses,...first.evidence.intervalLosses]},{intervalLosses:[{...first.evidence.intervalLosses[0],lossKwh:50}]}]){
  const result=events.mergeAdjoiningSiteOutages([{...first,evidence},next],60);
  assert.equal(result.length,2);assert.equal(result.reduce((s,i)=>s+i.estimatedLossKwh,0),200);
 }
});
