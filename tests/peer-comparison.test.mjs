import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource, modelCapacityBindings} from './source-module.mjs';
const time=loadSource('app/telemetry-time.ts');
const peers=loadSource('app/api/performance-summary/peer-comparison.ts',[],{...modelCapacityBindings(),...time});
const causes={...time,...peers,...loadSource('app/api/performance-summary/causes.ts',[],time)};
Object.assign(causes,loadSource('app/api/performance-summary/telemetry-events.ts',[],{...modelCapacityBindings(),...(causes)}));
const {buildAnalysis,applyLossThreshold}=loadSource('app/api/performance-summary/route.ts',['buildAnalysis','applyLossThreshold'],{...modelCapacityBindings(),...(causes)});
function fixture({days=8,minutes=60,loss=.2,pattern='persistent',count=4}={}){
 const assets=[{id:'meter',name:'Meter',type:'revenue_meter',externalId:'meter',aliases:'[]'}];
 for(let i=0;i<count;i++) assets.push({id:`i${i}`,name:`Inv ${i}`,type:'inverter',externalId:`i${i}`,parentId:'meter',acRatedCapacityKw:'100',aliases:'[]'},
  {id:`m${i}`,name:`Modules ${i}`,type:'module_group',externalId:`m${i}`,parentId:`i${i}`,moduleRatedCapacityW:'500',quantity:250,aliases:'[]'});
 const production=assets.filter(a=>a.type!=='module_group').map(a=>({equipmentId:a.id,equipmentName:a.name,equipmentType:a.type,externalId:a.externalId,capacityKw:a.id==='meter'?count*100:100,intervalProduction:[],dailyProduction:[],readingCount:0,source:'interval_energy'}));
 const summary={intervalMinutes:minutes,timezone:'America/New_York',equipmentProduction:production,intervalIrradiance:[],expectedProduction:[],dailyProduction:[],totalEnergyKwh:0,latestDate:'',latestDayEnergyKwh:0,readingCount:0,source:'interval_energy',causeContext:{latitude:'40',longitude:'-75',timeZone:'America/New_York',assumptions:causes.expectedAssumptions({})}};
 for(let d=1;d<=days;d++)for(let m=0;m<1440;m+=minutes){
  const h=Math.floor(m/60),timestamp=`2026-06-${String(d).padStart(2,'0')}T${String(h).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:00`;
  const energy=h>=8&&h<=16?60*minutes/60:0;
  summary.intervalIrradiance.push({timestamp,averageWm2:energy?600:0,insolationKwhM2:energy?.6*minutes/60:0,peakWm2:energy?600:0,readingCount:1});
  summary.expectedProduction.push({timestamp,energyKwh:energy*count});
  let aggregate=0;
  for(let i=0;i<count;i++){const value=energy*(i===0&&(pattern==='persistent'||h===9)?1-loss:1);production[i+1].intervalProduction.push({timestamp,energyKwh:value});aggregate+=value;}
  production[0].intervalProduction.push({timestamp,energyKwh:aggregate});
 }
 return {summary,assets};
}
function plan(f){return peers.compareCapacityPeers(f.summary,f.assets);}
function assertOutageOnly(result){
 assert.equal(result.issues.some(i=>i.type==='Underperformance'),false);
 assert.equal(result.peerComparison,undefined);assert.equal(result.causeAnalysis,undefined);
 assert.equal(result.recurringIssues.length,0);
 assert.equal(result.inverterExpectation.coverage,undefined,'repeated-deficit coverage is retired');
 assert.ok(result.issues.every(i=>!i.suspectedCause&&!i.recurringId));
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);

test('peer groups require both exact nameplate capacities, summing all module groups',()=>{
 const f=fixture();
 const groups=peers.capacityPeerGroups(f.assets);
 assert.equal(groups.get('i0').dcKw,125);assert.equal(groups.get('i0').ids.length,4);
 f.assets.find(a=>a.id==='m1').quantity=260;
 f.assets.find(a=>a.id==='i2').acRatedCapacityKw='80';f.assets.find(a=>a.id==='m2').quantity=200; // same DC/AC ratio is insufficient
 f.assets.find(a=>a.id==='m3').quantity=125;f.assets.push({id:'m3b',type:'module_group',parentId:'i3',moduleRatedCapacityW:'500',quantity:125});
 const split=peers.capacityPeerGroups(f.assets);
 assert.deepEqual([...split.get('i0').ids],['i0','i3']);assert.notEqual(split.get('i0').key,split.get('i2').key);
 assert.equal(plan(f).findings.size,0,'one matching peer cannot establish the reference');
});

test('unknown, invalid and absent DC ratings never use an inferred production capacity',()=>{
 for(const invalid of ['missing','zero','nan','negative','fractional']){
  const f=fixture();
  for(const a of f.assets.filter(a=>a.type==='module_group')){
   if(invalid==='missing')delete a.moduleRatedCapacityW;
   else if(invalid==='fractional')a.quantity=250.5;
   else a.moduleRatedCapacityW={zero:'0',nan:'unknown',negative:'-500'}[invalid];
  }
  assert.equal(peers.capacityPeerGroups(f.assets).size,0);assert.equal(plan(f).findings.size,0);
 }
});

test('legacy peers still describe persistent 20% deficits, but the active engine creates no underperformance',()=>{
 const f=fixture(),p=plan(f),result=buildAnalysis(f.summary,f.assets);
 assert.equal(p.findings.size,1);assert.equal(p.findings.get('i0').qualifiedDays,8);
 const finding=p.findings.get('i0');assert.equal(finding.intervals.size,8*9);
 assert.equal(finding.group.acKw,100);assert.equal(finding.group.dcKw,125);
 assert.ok([...finding.intervals.values()].every(pnt=>pnt.peerCount>=2&&!p.referenceSets[pnt.peerSetIndex].includes('i0')));
 assert.equal(result.analyzedIntervals,8*9);assert.equal(result.analyzedDays,8);
 assertOutageOnly(result);assert.equal(result.issues.length,0);assert.equal(result.totalLossKwh,0);
});

test('small deficits, insufficient days, weak peers, clipped output, telemetry blocks and snow do not produce peer findings',()=>{
 assert.equal(plan(fixture({loss:.05})).findings.size,0);
 assert.equal(plan(fixture({days:2})).findings.size,0);
 assert.equal(plan(fixture({count:2})).findings.size,0);
 for(const kind of ['clipped','missing','zero','disagree','irradiance','snow']){
  const f=fixture();
  if(kind==='snow'){f.summary.snowSensorConfigured=true;f.summary.snowDays=Array.from({length:8},(_,i)=>`2026-06-${String(i+1).padStart(2,'0')}`);}
  else if(kind==='irradiance')f.summary.intervalIrradiance.forEach(p=>p.averageWm2=100);
  else for(const series of f.summary.equipmentProduction.filter(p=>p.equipmentId!=='i0'&&p.equipmentType==='inverter')){
   if(kind==='missing')series.intervalProduction=[];
   else series.intervalProduction.forEach(p=>p.energyKwh=p.energyKwh?(kind==='clipped'?95:kind==='zero'?0:series.equipmentId==='i1'?25:series.equipmentId==='i2'?70:90):0);
  }
  assert.equal(plan(f).findings.has('i0'),false,kind);
 }
 const f=fixture();const blocked=new Map([['i0',new Set(f.summary.intervalIrradiance.map(p=>p.timestamp))]]);
 assert.equal(peers.compareCapacityPeers(f.summary,f.assets,blocked).findings.has('i0'),false);
});

test('native five-minute and hourly measured inverter outages conserve the same nonzero energy',()=>{
 const totals=[];
 for(const minutes of [5,60]){const f=fixture({minutes,days:3,loss:1});const result=buildAnalysis(f.summary,f.assets);
  const target=result.issues.filter(i=>i.equipmentId==='i0');
  assert.ok(target.length);assert.ok(target.every(i=>i.type==='Equipment outage'&&!i.lossUnknown));
  const ledger=target.flatMap(i=>i.evidence.intervalLosses);
  assert.equal(ledger.length,3*9*60/minutes);assert.equal(new Set(ledger.map(p=>p.timestamp)).size,ledger.length);
  assert.ok(ledger.every(p=>p.actualKwh===0&&Math.abs(p.expectedKwh-60*minutes/60)<1e-8));
  const loss=target.reduce((s,i)=>s+i.estimatedLossKwh,0);totals.push(loss);
  near(loss,3*9*60);near(result.totalLossKwh,loss);
  near(result.issues.flatMap(i=>i.evidence.intervalLosses).reduce((s,p)=>s+(p.countedLossKwh??p.lossKwh),0),result.totalLossKwh);
  assertOutageOnly(result);
 }
 near(totals[0],totals[1]);
});

test('legacy shading compatibility does not reintroduce active cause or recurring findings',()=>{
 const f=fixture({pattern:'morning'}),p=plan(f),result=buildAnalysis(f.summary,f.assets);
 // Explicit historical evidence exercises the retained helper, not buildAnalysis.
 const timestamps=[...p.findings.get('i0').intervals.keys()];assert.equal(timestamps.length,8);
 const historical={id:'historical-i0',equipmentId:'i0',equipmentType:'inverter',category:'Performance',type:'Underperformance',
  startDateTime:timestamps[0],endDateTime:'2026-06-08T10:00:00',estimatedLossKwh:96,actualEnergyKwh:384,expectedEnergyKwh:480,
  evidence:{intervalLosses:timestamps.map(timestamp=>({timestamp,lossKwh:12,actualKwh:48,expectedKwh:60,detectionBasis:'derived_inverter_expectation_v1'}))}};
 assert.equal(causes.shadingCandidates(f.summary,[historical],p).size,8);
 const shade=causes.attributeCauses([historical],f.summary,p);
 assert.equal(shade.length,1);assert.equal(shade[0].suspectedCause,'Shading');assert.equal(shade[0].estimatedLossKwh,96);
 assert.match(shade[0].causeExplanation,/shortfall against the inverter expectation derived from site Expected Production/);
 assertOutageOnly(result);assert.equal(result.issues.length,0);assert.equal(result.totalLossKwh,0);
 f.assets.filter(a=>a.type==='module_group'&&a.parentId!=='i0').forEach(a=>a.quantity=260);
 assert.equal(causes.shadingCandidates(f.summary,[historical],plan(f)).size,0);
 assert.equal(p.findings.get('i0').deficitHours,8);
});

test('the threshold treats outages individually without recurrence pooling, preserves unknowns and strict boundaries',()=>{
 const issue=(id,equipmentId,loss)=>({id,equipmentId,equipmentType:'inverter',category:'Performance',type:'Equipment outage',estimatedLossKwh:loss,startDateTime:'2026-06-01T10:00:00',endDateTime:'2026-06-01T11:00:00'});
 const issues=[issue('a','i0',40),issue('b','i0',40),issue('c','i0',20),issue('d','i1',80),{...issue('u','i0',0),lossUnknown:true}];
 const a={issues,totalLossKwh:180};
 const result=applyLossThreshold(a,'75');assert.deepEqual(result.issues.map(i=>i.id),['d','u']);assert.equal(result.totalLossKwh,80);assert.equal(result.thresholdExcludedLossKwh,100);
 assert.deepEqual(applyLossThreshold(a,'80').issues.map(i=>i.id),['u']);assert.equal(applyLossThreshold(a,'').issues.length,5);
});

test('site and inverter outages share a single interval ledger without duplicate covered losses',()=>{
 const f=fixture({pattern:'morning',loss:1}),siteTimestamp='2026-06-04T09:00:00';
 for(const p of f.summary.equipmentProduction)p.intervalProduction.find(p=>p.timestamp===siteTimestamp).energyKwh=0;
 const result=buildAnalysis(f.summary,f.assets),target=result.issues.filter(i=>i.equipmentId==='i0');
 const children=target.flatMap(i=>i.evidence.intervalLosses);
 assert.equal(children.length,7);assert.ok(children.every(p=>p.timestamp!==siteTimestamp&&p.actualKwh===0));
 const site=result.issues.filter(i=>i.type==='Site outage');assert.equal(site.length,1);assert.equal(site[0].estimatedLossKwh,240);
 const intervals=result.issues.flatMap(i=>i.evidence.intervalLosses);
 assert.equal(intervals.length,8);
 assert.equal(new Set(intervals.map(p=>p.timestamp)).size,intervals.length);
 assert.equal(target.reduce((s,i)=>s+i.estimatedLossKwh,0),7*60);
 assert.equal(result.totalLossKwh,7*60+240);near(intervals.reduce((s,p)=>s+(p.countedLossKwh??p.lossKwh),0),result.totalLossKwh);
 assertOutageOnly(result);
});

test('two independently qualified references remain usable when eight of ten inverters are impaired',()=>{
 const f=fixture({count:10});
 for(const p of f.summary.equipmentProduction.filter(p=>p.equipmentType==='inverter'))
  p.intervalProduction.forEach(v=>v.energyKwh=v.energyKwh?(Number(p.equipmentId.slice(1))<8?48:60):0);
 const p=plan(f);
 assert.equal(p.findings.size,8);
 assert.equal(p.referenceQualification.qualifiedInverters,2);
 for(const [id,finding] of p.findings){assert.ok(!['i8','i9'].includes(id));
  for(const interval of finding.intervals.values())assert.deepEqual([...p.referenceSets[interval.peerSetIndex]],['i8','i9']);}
});

test('a uniformly impaired fleet cannot qualify itself and missing expectations never fall back to relative peers',()=>{
 for(const kind of ['impaired','missing','negative','nan','conflict']){
  const f=fixture();
  if(kind==='impaired')for(const p of f.summary.equipmentProduction.filter(p=>p.equipmentType==='inverter'))p.intervalProduction.forEach(v=>v.energyKwh=v.energyKwh?42:0);
  if(kind==='missing')f.summary.expectedProduction=[];
  if(['negative','nan','conflict'].includes(kind))f.summary.expectedProduction.forEach(p=>p.energyKwh=kind==='negative'?-1:kind==='nan'?NaN:450);
  const p=plan(f);assert.equal(p.findings.size,0,kind);assert.equal(p.referenceQualification.qualifiedInverters,0,kind);
  assert.equal(p.referenceQualification.status,'unavailable');assert.match(p.referenceQualification.message,/Primary model-derived detection does not require peer references/);
  if(kind==='conflict')assert.equal(p.referenceQualification.expectedData.capacityConflict,8*9);
 }
 const f=fixture();f.summary.expectedProduction=[];
 // Measured outages remain active without a historical or peer loss fallback.
 f.summary.equipmentProduction[1].intervalProduction.filter(p=>p.timestamp.startsWith('2026-06-04')).forEach(p=>p.energyKwh=0);
 const result=buildAnalysis(f.summary,f.assets),outage=result.issues.find(i=>i.equipmentId==='i0'&&i.type==='Equipment outage');
 assert.ok(outage);assert.equal(outage.lossUnknown,true);assert.equal(outage.expectedUnknown,true);
 assert.equal(outage.actualEnergyKwh,0);assert.equal(result.totalLossKwh,0);assertOutageOnly(result);
});

test('reference qualification is specific to the local hour and month and rechecks each timestamp',()=>{
 const f=fixture({days:10,count:3});
 const reference=f.summary.equipmentProduction.find(p=>p.equipmentId==='i1');
 reference.intervalProduction.forEach(p=>{if(p.timestamp.slice(11,13)==='09')p.energyKwh*=.8;});
 // One bad interval does not erase this reference\'s otherwise qualified 10:00 window,
 // but it must be excluded at the affected timestamp.
 reference.intervalProduction.find(p=>p.timestamp==='2026-06-05T10:00:00').energyKwh=48;
 const p=plan(f),record=p.referenceQualification.records.find(r=>r.equipmentId==='i1');
 assert.equal(record.windows.find(w=>w.window==='2026-06 09').qualified,false);
 assert.equal(record.windows.find(w=>w.window==='2026-06 10').qualified,true);
 assert.ok([...p.findings.get('i0').intervals.keys()].every(t=>t.slice(11,13)!=='09'&&t!=='2026-06-05T10:00:00'));
 // A short July period cannot inherit the qualifying June observations.
 for(const series of [f.summary.intervalIrradiance,f.summary.expectedProduction,...f.summary.equipmentProduction.map(p=>p.intervalProduction)])
  series.push(...series.filter(p=>p.timestamp.startsWith('2026-06-01')).map(p=>({...p,timestamp:p.timestamp.replace('2026-06','2026-07')})));
 const july=plan(f);assert.ok([...july.findings.get('i0').intervals.keys()].every(t=>!t.startsWith('2026-07')));
});

test('qualification requires 80% agreement, three distinct dates and three measured hours, including missing readings in the denominator',()=>{
 for(const kind of ['missing','low','brief']){
  const f=fixture({days:5,count:3});
  const series=f.summary.equipmentProduction.find(p=>p.equipmentId==='i1');
  if(kind==='missing')series.intervalProduction=series.intervalProduction.filter(p=>!['02','03'].includes(p.timestamp.slice(8,10)));
  else series.intervalProduction.forEach(p=>{if(kind==='low'&&['02','03'].includes(p.timestamp.slice(8,10)))p.energyKwh*=.8;});
  if(kind==='brief'){f.summary.intervalMinutes=5;for(const s of [f.summary.expectedProduction,...f.summary.equipmentProduction.map(p=>p.intervalProduction)])s.forEach(p=>p.energyKwh/=12);}
  const p=plan(f);assert.equal(p.findings.size,0,kind);
  if(kind!=='brief')assert.equal(p.referenceQualification.records.find(r=>r.equipmentId==='i1').qualified,false);
 }
});

test('UTC timestamps qualify by local calendar month and hour',()=>{
 const f=fixture({days:4});
 for(const series of [f.summary.intervalIrradiance,f.summary.expectedProduction,...f.summary.equipmentProduction.map(p=>p.intervalProduction)])
  series.forEach(p=>p.timestamp=p.timestamp+'Z');
 const p=plan(f),record=p.referenceQualification.records.find(r=>r.equipmentId==='i1');
 assert.ok(record.windows.some(w=>w.window==='2026-06 04'&&w.qualified));
 assert.ok(!record.windows.some(w=>w.window==='2026-06 16'));
});

test('derived high-loading exclusions apply even when actual underperformance hides inverter or transformer saturation',()=>{
 for(const kind of ['inverter','transformer']){
  const f=fixture();
  if(kind==='inverter')f.summary.expectedProduction.forEach(p=>p.energyKwh=p.energyKwh?384:0);
  else {
   f.assets.push({id:'tx',type:'transformer',parentId:'meter',nameplateKva:'250'});
   f.assets.filter(a=>a.type==='inverter').forEach(a=>a.parentId='tx');
  }
  const p=plan(f);assert.equal(p.findings.size,0,kind);
  assert.ok(p.referenceQualification.records.every(r=>r.excluded.capacityLimited===72));
 }
});

test('sustained common nonzero fleet deficits create neither inverter nor shared site findings',()=>{
 for(const count of [1,2,4]){
  const f=fixture({count});
  for(const p of f.summary.equipmentProduction.filter(p=>p.equipmentType==='inverter'))p.intervalProduction.forEach(v=>v.energyKwh=v.energyKwh?48:0);
  f.summary.equipmentProduction[0].intervalProduction.forEach(p=>p.energyKwh=p.energyKwh?48*count:0);
  const result=buildAnalysis(f.summary,f.assets);
  assert.equal(result.analyzedIntervals,8*9);assert.equal(result.inverterExpectation.expectedData.available,8*9);
  assertOutageOnly(result);assert.equal(result.issues.length,0);assert.equal(result.totalLossKwh,0);
 }
});

test('measured peers cannot replace outage allocation or create extra nonzero-deficit loss',()=>{
 const f=fixture({loss:1});
 for(const p of f.summary.equipmentProduction.filter(p=>p.equipmentType==='inverter'&&p.equipmentId!=='i0'))p.intervalProduction.forEach(v=>v.energyKwh=v.energyKwh?66:0);
 f.summary.equipmentProduction[0].intervalProduction.forEach(p=>p.energyKwh=p.energyKwh?198:0);
 const result=buildAnalysis(f.summary,f.assets),ledger=result.issues.filter(i=>i.equipmentId==='i0').flatMap(i=>i.evidence.intervalLosses);
 assert.equal(result.totalLossKwh,8*9*60);assert.equal(ledger.length,8*9);
 assert.ok(ledger.every(p=>p.derivedInverterExpectedKwh===60&&p.actualKwh===0&&p.lossKwh===60&&p.peerExpectedKwh===undefined&&p.peerCorroborated===undefined));
 assertOutageOnly(result);
 const small=fixture({loss:.05});
 for(const p of small.summary.equipmentProduction.filter(p=>p.equipmentType==='inverter'&&p.equipmentId!=='i0'))p.intervalProduction.forEach(v=>v.energyKwh=v.energyKwh?66:0);
 assert.equal(plan(small).findings.size,1,'a peer-only deficit can exist within the primary model tolerance');
 const smallResult=buildAnalysis(small.summary,small.assets);assert.equal(smallResult.issues.length,0,'optional evidence cannot independently create a finding');assertOutageOnly(smallResult);
 const boundary=fixture({loss:.1}),boundaryResult=buildAnalysis(boundary.summary,boundary.assets);
 assert.equal(boundaryResult.issues.length,0);assertOutageOnly(boundaryResult);
 assert.equal(plan(boundary).referenceQualification.records.find(r=>r.equipmentId==='i0').qualified,false,'the legacy helper still excludes a reference at its deficit threshold');
});

test('different DC ratings allocate measured outage loss without an equal-capacity peer',()=>{
 const f=fixture({count:3});
 f.assets.find(a=>a.id==='m1').quantity=500;f.assets.find(a=>a.id==='m2').quantity=750;
 f.summary.expectedProduction.forEach(p=>p.energyKwh=p.energyKwh?180:0);
 for(const p of f.summary.equipmentProduction)p.intervalProduction.forEach(v=>v.energyKwh=v.energyKwh?({meter:150,i0:0,i1:60,i2:90}[p.equipmentId]):0);
 const result=buildAnalysis(f.summary,f.assets);
 assert.ok(result.issues.some(i=>i.equipmentId==='i0'&&i.type==='Equipment outage'));assert.equal(result.totalLossKwh,8*9*30);
 const ledger=result.issues.flatMap(i=>i.evidence.intervalLosses);assert.equal(ledger.length,8*9);
 assert.ok(ledger.every(p=>p.derivedInverterExpectedKwh===30&&p.expectedKwh===30&&p.actualKwh===0));assertOutageOnly(result);
});

test('measured outage losses use the meter delivery boundary once, at five-minute and hourly cadence',()=>{
 for(const minutes of [5,60]){
  const f=fixture({minutes,loss:1});f.assets[0].acLineLossPercent='2';
  f.summary.expectedProduction.forEach(p=>p.energyKwh*=.98);
  f.summary.equipmentProduction[0].intervalProduction.forEach(p=>p.energyKwh*=.98);
  const result=buildAnalysis(f.summary,f.assets),ledger=result.issues.flatMap(i=>i.evidence.intervalLosses);
  assert.equal(ledger.length,8*9*60/minutes);near(result.totalLossKwh,8*9*60*.98);
  assert.ok(ledger.every(p=>p.lossBoundary==='meter_poi'&&Math.abs(p.lossKwh-p.inverterTerminalLossKwh*.98)<1e-8));
  assert.ok(result.issues.every(i=>i.type==='Equipment outage'&&Math.abs(i.lossPercent-100)<1e-8));
  assert.ok(ledger.every(p=>Math.abs(p.expectedKwh-p.derivedInverterExpectedKwh*.98)<1e-8&&Math.abs(p.actualKwh-(p.derivedInverterExpectedKwh-p.inverterTerminalLossKwh)*.98)<1e-8));
  assert.ok(Math.abs(ledger.reduce((s,p)=>s+p.lossKwh,0)-result.totalLossKwh)<1e-7);
  assertOutageOnly(result);
 }
});

test('nonzero deficits never use historical fallback, while a measured zero retains unknown outage loss',()=>{
 for(const options of [{days:2},{loss:.05},{minutes:5,days:3,pattern:'morning'}]){
  const f=fixture(options);if(options.minutes===5)for(const s of [f.summary.intervalIrradiance,f.summary.expectedProduction,...f.summary.equipmentProduction.map(p=>p.intervalProduction)])
   s.splice(0,s.length,...s.filter(p=>p.timestamp.slice(14,16)==='00'));
  const result=buildAnalysis(f.summary,f.assets);assertOutageOnly(result);assert.equal(result.totalLossKwh,0);
  if(options.minutes===5){
   assert.ok(result.issues.length,'omitted native intervals remain visible as telemetry gaps');
   assert.ok(result.issues.every(i=>i.lossUnknown&&i.productionUnknown));
  }else assert.equal(result.issues.length,0,JSON.stringify(options));
 }
 const f=fixture();f.summary.expectedProduction=[];
 f.summary.equipmentProduction[1].intervalProduction.find(p=>p.timestamp==='2026-06-04T10:00:00').energyKwh=12;
 const result=buildAnalysis(f.summary,f.assets);
 assert.equal(result.inverterExpectation.expectedData.missing,8*9);
 assertOutageOnly(result);assert.equal(result.issues.length,0);assert.equal(result.totalLossKwh,0);
 f.summary.equipmentProduction[1].intervalProduction.find(p=>p.timestamp==='2026-06-04T11:00:00').energyKwh=0;
 const zero=buildAnalysis(f.summary,f.assets),outage=zero.issues.find(i=>i.equipmentId==='i0');
 assert.ok(outage);assert.equal(outage.type,'Equipment outage');assert.equal(outage.lossUnknown,true);assert.equal(outage.actualEnergyKwh,0);
 assert.equal(outage.evidence.intervalLosses.length,1);assert.equal(zero.totalLossKwh,0);assertOutageOnly(zero);
 const clipped=fixture();clipped.summary.expectedProduction.forEach(p=>p.energyKwh=p.energyKwh?384:0);
 const highExpected=buildAnalysis(clipped.summary,clipped.assets);assertOutageOnly(highExpected);assert.equal(highExpected.issues.length,0);
});
