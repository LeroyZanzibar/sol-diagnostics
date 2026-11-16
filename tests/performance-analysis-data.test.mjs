import test from 'node:test';
import assert from 'node:assert/strict';
import { versionedStore, performanceBindings as bindings, analysisCsvFixture } from './performance-analysis-fixture.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PerformanceStoreManager } from '../selfhost/performance-store.mjs';

test('real SQLite store retains semantic fingerprints, canonical streaming and immutable provenance across concurrent commits',async t=>{
  const directory=mkdtempSync(join(process.env.TMPDIR||'/opt/data/cache/scratch','analysis-store-'));
  const manager=new PerformanceStoreManager(directory);t.after(()=>{manager.close();rmSync(directory,{recursive:true,force:true});});
  const store=manager.site('site'),h=helpers(store),metadata={source:'csv',fileName:'synthetic.csv',timezone:'UTC',intervalMinutes:60,modelRevision:'model'};
  const commit=async rows=>{const preview=await store.stage(metadata,rows);return store.commit(preview.stageId,{previewToken:preview.previewToken,approveOverlap:true,modelRevision:'model',actor:'test'});};
  const rows=[reading('meter','Energy',10),reading('inva','Energy',5,end),reading('snow','Status',70,end),reading('@site','Expected Production',30)];
  await commit(rows);const record=h.performanceAnalysisInput('site'),provenance=h.captureAnalysisProvenance('real-run',record,assets);
  assert.equal(provenance.revision,1);assert.deepEqual(plain(store.analysis('real-run')),plain(provenance));
  const original=store.fingerprint(1,provenance.scopes[0]);
  await commit(rows);assert.equal(h.assessAnalysisFreshness('site','real-run').status,'current');
  await commit([reading('meter','Energy',90,'2026-07-01T00:00:00.000Z'),reading('meter','DC power',900),reading('meter','Status',70)]);
  assert.equal(h.assessAnalysisFreshness('site','real-run').status,'current');
  await commit([reading('inva','Energy',6,end)]);assert.equal(h.assessAnalysisFreshness('site','real-run').status,'older');
  assert.equal(store.fingerprint(1,provenance.scopes[0]),original);
  const summary=await engine(store).buildSummary(record,assets,async completed=>{if(completed===0)await commit([reading('meter','Energy',99)]);});
  assert.equal(summary.totalEnergyKwh,10);assert.equal(summary.expectedProduction[0].energyKwh,30);assert.equal(summary.snowReadingCount,1);
  assert.deepEqual(plain(h.captureAnalysisProvenance('real-run',record,[])),plain(provenance));
  assert.throws(()=>store.recordAnalysis('real-run',{...provenance,hashes:provenance.hashes.map(()=>'0'.repeat(64))}),/immutable/);
});
import { loadSource, modelCapacityBindings } from './source-module.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const start = '2026-06-01T10:00:00.000Z', end = '2026-06-03T12:00:00.000Z';
const assets = [
  { id:'meter', name:'Meter', type:'revenue_meter', externalId:'meter', aliases:'[]' },
  { id:'inv-a', name:'First inverter', type:'inverter', parentId:'meter', externalId:'inv-a', aliases:'[]', acRatedCapacityKw:'100' },
  { id:'inva', name:'Second inverter', type:'inverter', parentId:'meter', externalId:'inva', aliases:'[]', acRatedCapacityKw:'100' },
  { id:'sun', name:'Irradiance', type:'weather_sensor', externalId:'sun', aliases:'[]' },
  { id:'snow', name:'Snow sensor', type:'weather_sensor', externalId:'snow', aliases:'[]' },
];
const reading = (equipmentId, measurement, value, timestamp = start, unit = measurement === 'Active power' ? 'kW' : /irradiance/.test(measurement) ? 'W/m2' : measurement === 'Energy' || measurement === 'Expected Production' ? 'kWh' : '') => ({timestamp, channel:{id:JSON.stringify([equipmentId,measurement]),equipmentId,measurement,unit},value});

const helpers = store => loadSource('app/api/performance-data/analysis.ts',[],bindings(store));
function engine(store, csv = '') {
  const time=loadSource('app/telemetry-time.ts');
  return loadSource('app/api/performance-summary/route.ts',['buildSummary','buildAnalysis'],{
    ...modelCapacityBindings(),...time,...loadSource('app/meter-mapping.ts'),...helpers(store),
    ...loadSource('app/api/performance-summary/causes.ts',[],time),
    ...loadSource('app/api/performance-summary/peer-comparison.ts',[],{...modelCapacityBindings(),...time}),
    ...loadSource('app/api/performance-summary/telemetry-events.ts',[],{...modelCapacityBindings(),...time}),
    getBucketBinding:()=>({get:async()=>({body:new Response(csv).body})}),
  });
}

test('canonical store is preferred, stable revision ID is the synthetic input, legacy remains before migration',async()=>{
  const store=versionedStore([reading('meter','Energy',10)]), h=helpers(store);
  let legacyReads=0;
  const service=loadSource('app/api/data-history/service.ts',[],{...h,...bindings(store),depotCleanupInProgress:async()=>false,getDatabaseBinding:()=>({}),getDb:()=>({select:()=>({from:()=>({where:()=>({orderBy:()=>({limit:async()=>{legacyReads++;return [{id:'legacy'}];}})})})})}),telemetryImports:{},and(){},eq(){},ne(){},desc(){}});
  const input=await service.currentAnalysisInput('site');
  assert.equal(input.id,store.describe().revisionId);assert.equal(legacyReads,0);
  assert.equal(JSON.parse(input.validation).timestampConvention,'start');
  const before=store.describe;store.describe=()=>({...before(),revision:0});
  assert.equal((await service.currentAnalysisInput('site')).id,'legacy');assert.equal(legacyReads,1);
});

test('canonical stream preserves expected column, blank production, snow times, exact IDs, units, and pins revision',async()=>{
  const rows=[reading('meter','Energy',20),reading('inv-a','Energy',8),reading('inva','Energy',12),reading('sun','POA irradiance',600),reading('@site','Expected Production',30),reading('snow','Status',70,'2026-06-01T23:59:00.000Z'),reading('meter','Energy',null,'2026-06-01T11:00:00.000Z'),reading('inv-a','Energy',null,'2026-06-01T11:00:00.000Z'),reading('inva','Energy',null,'2026-06-01T11:00:00.000Z'),reading('sun','POA irradiance',600,'2026-06-01T11:00:00.000Z')];
  const store=versionedStore(rows,'America/New_York'), h=helpers(store), input=h.performanceAnalysisInput('site');
  store.replace(rows.map(r=>({...r,value:r.value===null?null:999})));
  const summary=await engine(store).buildSummary(input,assets);
  assert.equal(summary.totalEnergyKwh,20);assert.equal(summary.expectedProduction[0].energyKwh,30);
  assert.equal(summary.equipmentProduction.find(a=>a.equipmentId==='inv-a').intervalProduction[0].energyKwh,8);
  assert.equal(summary.equipmentProduction.find(a=>a.equipmentId==='inva').intervalProduction[0].energyKwh,12);
  assert.equal(summary.snowReadingCount,1);assert.deepEqual(plain(summary.snowDays),['2026-06-01']);
  assert.deepEqual(plain(summary.timestamps),[start,'2026-06-01T11:00:00.000Z']);
  assert.equal(summary.equipmentProduction.find(a=>a.equipmentId==='meter').readingCount,1);
  assert.ok(store.calls.filter(c=>c[0]==='rows').every(c=>c[1]===1));
});

test('actual CSV and canonical summaries and findings agree including converted units and all-blank coverage',async()=>{
  const csv='time,meter,first,second,sun,expected,snow\n2026-06-01T11:00:00Z,20000,8000,12000,0.6,30,\n2026-06-01T12:00:00Z,,,,0.6,30,\n2026-06-01T23:59:00Z,,,,,,70';
  const record={id:'legacy',siteId:'site',objectKey:'raw',timezone:'America/New_York',rowCount:3,validation:JSON.stringify({intervalMinutes:60,timestampConvention:'end'}),mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[{column:'meter',equipmentId:'meter',measurement:'Energy'},{column:'first',equipmentId:'inv-a',measurement:'Energy'},{column:'second',equipmentId:'inva',measurement:'Energy'},{column:'sun',equipmentId:'sun',measurement:'POA irradiance'},{column:'snow',equipmentId:'snow',measurement:'Snow code'}]}})};
  // Unit-bearing headers drive the existing CSV conversion path.
  const source=csv.replaceAll('meter','meter Wh').replaceAll('first','first Wh').replaceAll('second','second Wh').replaceAll('sun','sun kW/m2');
  const mapping=JSON.parse(record.mapping);for(const signal of mapping.equipment.signals)signal.column=signal.column==='sun'?'sun kW/m2':signal.column==='snow'?'snow':`${signal.column} Wh`;record.mapping=JSON.stringify(mapping);
  const rows=[];for(const timestamp of [start,'2026-06-01T11:00:00.000Z'])rows.push(reading('meter','Energy',timestamp===start?20:null,timestamp),reading('inv-a','Energy',timestamp===start?8:null,timestamp),reading('inva','Energy',timestamp===start?12:null,timestamp),reading('sun','POA irradiance',600,timestamp),reading('@site','Expected Production',30,timestamp));
  rows.push(reading('snow','Snow code',70,'2026-06-01T23:59:00.000Z'));
  const store=versionedStore(rows,'America/New_York'), h=helpers(store), raw=engine(store,source), canonical=engine(store);
  const a=await raw.buildSummary(record,assets),b=await canonical.buildSummary(h.performanceAnalysisInput('site'),assets);
  // The recorded source convention differs, not the canonical interval data.
  a.timestampConvention='start';for(const s of [a,b])s.equipmentProduction.sort((x,y)=>x.equipmentId.localeCompare(y.equipmentId));
  assert.deepEqual(plain(b),plain(a));assert.deepEqual(plain(canonical.buildAnalysis(b,assets)),plain(raw.buildAnalysis(a,assets)));
});

test('all-null production stays covered and active-power canonical kW is not scaled twice',async()=>{
  const selected=assets.filter(a=>['meter','inva','sun'].includes(a.id));
  for(const blank of [true,false]){
    const measurement=blank?'Energy':'Active power',rows=[],times=[start,'2026-06-01T11:00:00.000Z'];
    for(const timestamp of times)rows.push(reading('meter',measurement,blank?null:40,timestamp),reading('inva',measurement,blank?null:40,timestamp),reading('sun','POA irradiance',600,timestamp),reading('@site','Expected Production',50,timestamp));
    const store=versionedStore(rows),h=helpers(store),canonical=engine(store);
    const source=['time,meter W,inverter W,sun,expected',...times.map(timestamp=>`${timestamp},${blank?'':40000},${blank?'':40000},600,50`)].join('\n');
    const raw=engine(store,source),record={id:'legacy',siteId:'site',objectKey:'raw',timezone:'UTC',rowCount:2,validation:JSON.stringify({intervalMinutes:60}),mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[{column:'meter W',equipmentId:'meter',measurement},{column:'inverter W',equipmentId:'inva',measurement},{column:'sun',equipmentId:'sun',measurement:'POA irradiance'}]}})};
    const a=await raw.buildSummary(record,selected),b=await canonical.buildSummary(h.performanceAnalysisInput('site'),selected);
    for(const s of [a,b])s.equipmentProduction.sort((x,y)=>x.equipmentId.localeCompare(y.equipmentId));
    assert.deepEqual(plain(b),plain(a));assert.deepEqual(plain(canonical.buildAnalysis(b,selected)),plain(raw.buildAnalysis(a,selected)));
    assert.equal(b.equipmentProduction.length,2);assert.equal(b.equipmentProduction[0].readingCount,blank?0:2);assert.equal(b.source,blank?'':'active_power');
  }
});

test('stream work is bounded, skips unconsumed channels, and closes pinned iterators on lease cancellation',async()=>{
  const store=versionedStore([reading('meter','Energy',10)]),h=helpers(store),record=h.performanceAnalysisInput('site');
  let reads=0,closed=0;
  store.rows=function*(){try{for(let n=0;n<2000;n++){reads++;yield reading('meter',n<1500?'DC power':'Energy',10);}}finally{closed++;}};
  const reader=h.canonicalAnalysisCsv(record,assets).getReader();await reader.read();assert.ok(reads<2000);await reader.cancel();assert.equal(closed,1);
  const text=await new Response(h.canonicalAnalysisCsv(record,assets)).text();assert.ok(!text.includes('DC power'));assert.ok(text.includes('Energy'));
  record.rowCount=2000;
  await assert.rejects(engine(store).buildSummary(record,assets,async completed=>{if(completed>0)throw new Error('Lease canceled');}),/Lease canceled/);
  assert.equal(closed,3);
});

test('unconsumed extrema do not widen the saved input domain and missing resume provenance fails closed',()=>{
  const store=versionedStore([reading('meter','Energy',10),reading('meter','DC power',8,'2025-01-01T00:00:00.000Z'),reading('unconfigured','Energy',10,'2027-01-01T00:00:00.000Z')]),h=helpers(store),record=h.performanceAnalysisInput('site');
  const p=h.captureAnalysisProvenance('fixed',record,assets);assert.equal(p.scopes[0].start,start);assert.equal(p.scopes[0].end,start);
  assert.throws(()=>h.resumeAnalysisProvenance('fixed',record,null),/checkpoint/);assert.throws(()=>h.resumeAnalysisProvenance('fixed',record,{...p,hashes:['bad']}),/checkpoint/);
  assert.deepEqual(plain(h.resumeAnalysisProvenance('fixed',record,p)),plain(p));
});

test('provenance fixes analysis-range dependency scopes and hashes and never relabels a retained attempt',()=>{
  const rows=[reading('meter','Energy',10),reading('inva','Energy',5,end),reading('@site','Expected Production',30),reading('snow','Status',70,end)];
  const store=versionedStore(rows), h=helpers(store), record=h.performanceAnalysisInput('site');
  const provenance=h.captureAnalysisProvenance('run',record,assets);
  assert.equal(provenance.revision,1);assert.equal(provenance.dependencyScope,'analysis-range');
  assert.deepEqual(plain(provenance.scopes[0].measurements),['Active power','Energy','Expected Production','Irradiance','POA irradiance','GHI irradiance']);
  assert.ok(provenance.scopes[0].equipmentIds.includes('@site'));assert.ok(!provenance.scopes[0].equipmentIds.includes('snow'));
  assert.deepEqual(plain(provenance.scopes[1].equipmentIds),['snow']);assert.deepEqual(plain(provenance.scopes[1].measurements),['Other','Snow code','Status']);
  assert.equal(provenance.scopes[0].start,start);assert.equal(provenance.scopes[0].end,end);
  store.replace([...rows,reading('meter','Energy',70,'2026-07-01T10:00:00.000Z')]);
  assert.deepEqual(plain(h.captureAnalysisProvenance('run',record,[])),plain(provenance));
  assert.throws(()=>h.captureAnalysisProvenance('run',h.performanceAnalysisInput('site'),assets),/revision|attempt/i);
});

test('freshness compares semantic data over the fixed dependency domain, not revision IDs or event windows',()=>{
  const base=[reading('meter','Energy',10),reading('inva','Energy',5,end),reading('@site','Expected Production',30),reading('snow','Status',70,end),reading('meter','DC power',100)];
  const store=versionedStore(base), h=helpers(store);h.captureAnalysisProvenance('run',h.performanceAnalysisInput('site'),assets);
  for(const rows of [base,[...base,reading('meter','Energy',9,'2026-07-01T00:00:00.000Z')],[...base,reading('unconfigured','Energy',99)],base.map(r=>r.channel.measurement==='DC power'?{...r,value:200}:r),[...base,reading('meter','Other',7)]]){
    store.replace(rows);assert.equal(h.assessAnalysisFreshness('site','run').status,'current');
  }
  for(const rows of [base.map(r=>r.channel.equipmentId==='inva'?{...r,value:6}:r),base.map(r=>r.channel.equipmentId==='@site'?{...r,value:31}:r),base.map(r=>r.channel.equipmentId==='snow'?{...r,value:60}:r),[...base,reading('sun','POA irradiance',600,end)]]){
    store.replace(rows);const f=h.assessAnalysisFreshness('site','run');assert.equal(f.status,'older');assert.equal(f.dependencyScope,'analysis-range');assert.ok(f.reasons.length);
  }
  assert.equal(h.assessAnalysisFreshness('site','legacy').status,'unknown');assert.equal(helpers(null).assessAnalysisFreshness('site','run').status,'unknown');
});

test('freshness GET is read-only, site scoped, no-store and reports unknown for legacy',async()=>{
  const store=versionedStore([reading('meter','Energy',10)]),h=helpers(store);h.captureAnalysisProvenance('run',h.performanceAnalysisInput('site'),assets);
  const route=loadSource('app/api/analysis-freshness/route.ts',[],{...h,getDatabaseBinding:()=>({prepare:()=>({bind:(run,site)=>({first:async()=>site==='site'&&['run','legacy'].includes(run)?{id:run}:null})})})});
  const r=await route.GET(new Request('https://test/api/analysis-freshness?siteId=site&runId=run'));
  assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/no-store/);assert.equal((await r.json()).status,'current');
  assert.equal((await(await route.GET(new Request('https://test/api/analysis-freshness?siteId=site&runId=legacy'))).json()).status,'unknown');
  assert.equal((await route.GET(new Request('https://test/api/analysis-freshness?siteId=else&runId=run'))).status,404);
});

const comparableSummary = summary => {
  const copy=plain(summary);copy.timestampConvention='start';
  copy.equipmentProduction.sort((a,b)=>a.equipmentId.localeCompare(b.equipmentId));
  return copy;
};

test('GHI actual CSV ingestion and SQLite canonical analysis retain all irradiance and real findings',async t=>{
  const f=await analysisCsvFixture();
  const directory=mkdtempSync(join(process.env.TMPDIR||'/opt/data/cache/scratch','analysis-ghi-'));
  const manager=new PerformanceStoreManager(directory);t.after(()=>{manager.close();rmSync(directory,{recursive:true,force:true});});
  const store=manager.site('site'),h=helpers(store),metadata={source:'csv',fileName:'synthetic-ghi.csv',timezone:f.record.timezone,intervalMinutes:60,modelRevision:'model'};
  const commit=async rows=>{const preview=await store.stage(metadata,rows);return store.commit(preview.stageId,{previewToken:preview.previewToken,approveOverlap:true,modelRevision:'model',actor:'test'});};
  await commit(f.readings);
  assert.equal([...store.rows()].filter(r=>r.channel.measurement==='GHI irradiance').length,54);
  const raw=engine(store,f.source),canonical=engine(store),record=h.performanceAnalysisInput('site');
  const original=await raw.buildSummary(f.record,f.equipment),saved=await canonical.buildSummary(record,f.equipment);
  const legacyAnalysis=raw.buildAnalysis(plain(original),f.equipment),canonicalAnalysis=canonical.buildAnalysis(plain(saved),f.equipment);
  assert.equal(legacyAnalysis.issues.filter(i=>i.type==='Underperformance').length,6);
  assert.equal(legacyAnalysis.totalLossKwh,72);
  assert.deepEqual(plain(canonicalAnalysis),plain(legacyAnalysis));
  assert.deepEqual(comparableSummary(saved),comparableSummary(original));
  assert.equal(saved.intervalIrradiance.length,54);
  assert.ok(saved.intervalIrradiance.every(p=>p.averageWm2===600));
  const p=h.captureAnalysisProvenance('sqlite-ghi',record,f.equipment),snapshot=JSON.stringify(store.analysis('sqlite-ghi'));
  const ghi=[...store.rows()].find(r=>r.channel.measurement==='GHI irradiance');
  await commit([ghi]);assert.equal(h.assessAnalysisFreshness('site','sqlite-ghi').status,'current');
  await commit([{...ghi,value:500}]);assert.equal(h.assessAnalysisFreshness('site','sqlite-ghi').status,'older');
  assert.deepEqual(comparableSummary(await canonical.buildSummary(record,f.equipment)),comparableSummary(saved));
  await commit([ghi]);assert.equal(h.assessAnalysisFreshness('site','sqlite-ghi').status,'current');
  assert.deepEqual(plain(h.captureAnalysisProvenance('sqlite-ghi',record,[])),plain(p));
  assert.deepEqual(plain(h.resumeAnalysisProvenance('sqlite-ghi',record,p)),plain(p));
  assert.equal(JSON.stringify(store.analysis('sqlite-ghi')),snapshot);
});

test('GHI corrections change freshness; identical imports, restored values and outside-domain additions do not',()=>{
  const ghi=reading('sun','GHI irradiance',600),base=[reading('meter','Energy',10),reading('inva','Energy',5,end),ghi];
  const store=versionedStore(base),h=helpers(store),record=h.performanceAnalysisInput('site'),p=h.captureAnalysisProvenance('ghi',record,assets);
  store.replace(base);assert.equal(h.assessAnalysisFreshness('site','ghi').status,'current');
  store.replace(base.map(r=>r===ghi?{...r,value:500}:r));assert.equal(h.assessAnalysisFreshness('site','ghi').status,'older');
  store.replace([...base,reading('sun','GHI irradiance',700,'2026-05-31T23:00:00.000Z')]);assert.equal(h.assessAnalysisFreshness('site','ghi').status,'current');
  assert.deepEqual(plain(h.captureAnalysisProvenance('ghi',record,[])),plain(p));
  assert.deepEqual(plain(h.resumeAnalysisProvenance('ghi',record,p)),plain(p));
});

// Explicit UTC expectations, independent of the boundary code under test.
const snowBoundaryCases=[
  {name:'UTC multi-day',timezone:'UTC',first:start,last:end,dayStart:'2026-06-01T00:00:00.000Z',dayEnd:'2026-06-03T23:59:59.999Z'},
  {name:'positive fractional offset',timezone:'Asia/Kathmandu',first:'2026-06-01T04:15:00.000Z',last:'2026-06-01T06:15:00.000Z',dayStart:'2026-05-31T18:15:00.000Z',dayEnd:'2026-06-01T18:14:59.999Z'},
  {name:'positive offset year boundary',timezone:'Pacific/Kiritimati',first:'2025-12-31T20:00:00.000Z',last:'2025-12-31T22:00:00.000Z',dayStart:'2025-12-31T10:00:00.000Z',dayEnd:'2026-01-01T09:59:59.999Z'},
  {name:'negative offset spring DST',timezone:'America/New_York',first:'2026-03-08T14:00:00.000Z',last:'2026-03-08T16:00:00.000Z',dayStart:'2026-03-08T05:00:00.000Z',dayEnd:'2026-03-09T03:59:59.999Z'},
  {name:'negative offset fall DST',timezone:'America/New_York',first:'2026-11-01T15:00:00.000Z',last:'2026-11-01T17:00:00.000Z',dayStart:'2026-11-01T04:00:00.000Z',dayEnd:'2026-11-02T04:59:59.999Z'},
  {name:'positive offset fall DST',timezone:'Australia/Sydney',first:'2026-04-05T00:00:00.000Z',last:'2026-04-05T02:00:00.000Z',dayStart:'2026-04-04T13:00:00.000Z',dayEnd:'2026-04-05T13:59:59.999Z'},
  {name:'positive offset spring DST',timezone:'Australia/Sydney',first:'2026-10-03T23:00:00.000Z',last:'2026-10-04T01:00:00.000Z',dayStart:'2026-10-03T14:00:00.000Z',dayEnd:'2026-10-04T12:59:59.999Z'},
  {name:'half-hour DST',timezone:'Australia/Lord_Howe',first:'2026-10-03T23:00:00.000Z',last:'2026-10-04T01:00:00.000Z',dayStart:'2026-10-03T13:30:00.000Z',dayEnd:'2026-10-04T12:59:59.999Z'},
  {name:'nonexistent local midnight',timezone:'America/Santiago',first:'2026-09-06T13:00:00.000Z',last:'2026-09-06T15:00:00.000Z',dayStart:'2026-09-06T04:00:00.000Z',dayEnd:'2026-09-07T02:59:59.999Z'},
  {name:'last interval crosses midnight into DST day',timezone:'America/New_York',first:'2026-03-07T15:30:00.000Z',last:'2026-03-08T04:30:00.000Z',dayStart:'2026-03-07T05:00:00.000Z',dayEnd:'2026-03-09T03:59:59.999Z'},
  {name:'last interval ends exactly at local midnight',timezone:'America/New_York',first:'2026-03-07T15:00:00.000Z',last:'2026-03-08T04:00:00.000Z',dayStart:'2026-03-07T05:00:00.000Z',dayEnd:'2026-03-08T04:59:59.999Z'},
  {name:'repeated local midnight',timezone:'America/Havana',first:'2026-11-01T15:00:00.000Z',last:'2026-11-01T17:00:00.000Z',dayStart:'2026-11-01T04:00:00.000Z',dayEnd:'2026-11-02T04:59:59.999Z'},
];
for(const c of snowBoundaryCases)test(`snow dependencies cover complete local boundary days: ${c.name}`,()=>{
  const base=[reading('meter','Energy',10,c.first),reading('inva','Energy',5,c.last)];
  const store=versionedStore(base,c.timezone),h=helpers(store),record=h.performanceAnalysisInput('site'),p=h.captureAnalysisProvenance('snow-boundary',record,assets);
  assert.equal(p.scopes[0].start,c.first);assert.equal(p.scopes[0].end,c.last);
  assert.equal(p.scopes[1].start,c.dayStart);assert.equal(p.scopes[1].end,c.dayEnd);
  for(const measurement of ['Snow code','Status','Other'])for(const timestamp of [c.dayStart,c.dayEnd]) {
    store.replace([...base,reading('snow',measurement,70,timestamp)]);
    assert.equal(h.assessAnalysisFreshness('site','snow-boundary').status,'older',`${measurement} at ${timestamp}`);
  }
  const before=new Date(Date.parse(c.dayStart)-1).toISOString(),after=new Date(Date.parse(c.dayEnd)+1).toISOString();
  for(const row of [reading('snow','Snow code',70,before),reading('snow','Status',70,after),reading('unconfigured','Snow code',70,c.dayStart),
    reading('snow','Energy',99,c.dayStart),...['Energy','Active power','Expected Production','Irradiance','POA irradiance','GHI irradiance'].flatMap(measurement=>[c.dayStart,c.dayEnd].map(timestamp=>reading(measurement==='Expected Production'?'@site':'meter',measurement,99,timestamp)))]) {
    store.replace([...base,row]);assert.equal(h.assessAnalysisFreshness('site','snow-boundary').status,'current',`${row.channel.equipmentId}/${row.channel.measurement} at ${row.timestamp}`);
  }
  assert.deepEqual(plain(h.captureAnalysisProvenance('snow-boundary',{...record,timezone:'UTC'},[])),plain(p));
  assert.deepEqual(plain(h.resumeAnalysisProvenance('snow-boundary',record,p)),plain(p));
  assert.throws(()=>h.resumeAnalysisProvenance('snow-boundary',record,{...p,scopes:[p.scopes[0],{...p.scopes[1],start:c.first}]}),/checkpoint/);
});

test('existing snow-only extrema and blanks never stretch the other semantic scopes',()=>{
  const before='2026-05-01T00:00:00.000Z',after='2026-07-01T00:00:00.000Z';
  const base=[reading('meter','Energy',10),reading('inva','Energy',5,end),reading('snow','Snow code',70,before),reading('snow','Snow code',null,after)];
  const store=versionedStore(base),h=helpers(store),record=h.performanceAnalysisInput('site'),p=h.captureAnalysisProvenance('snow-extrema',record,assets);
  assert.equal(p.scopes[0].start,start);assert.equal(p.scopes[0].end,end);
  assert.equal(p.scopes[1].start,'2026-06-01T00:00:00.000Z');assert.equal(p.scopes[1].end,'2026-06-03T23:59:59.999Z');
  store.replace([...base,reading('meter','Energy',99,before)]);assert.equal(h.assessAnalysisFreshness('site','snow-extrema').status,'current');
  store.replace(base.map(r=>r.timestamp===after?{...r,value:70}:r));assert.equal(h.assessAnalysisFreshness('site','snow-extrema').status,'current');
});

test('SQLite snow blank-to-70 correction outside production hours invalidates the immutable saved local-day dependency',async t=>{
  const directory=mkdtempSync(join(process.env.TMPDIR||'/opt/data/cache/scratch','analysis-snow-'));
  const manager=new PerformanceStoreManager(directory);t.after(()=>{manager.close();rmSync(directory,{recursive:true,force:true});});
  const store=manager.site('site'),h=helpers(store),metadata={source:'csv',fileName:'synthetic-snow.csv',timezone:'America/New_York',intervalMinutes:60,modelRevision:'model'};
  const commit=async rows=>{const preview=await store.stage(metadata,rows);return store.commit(preview.stageId,{previewToken:preview.previewToken,approveOverlap:true,modelRevision:'model',actor:'test'});};
  const observation='2026-11-01T04:00:00.000Z',first='2026-11-01T15:00:00.000Z',last='2026-11-01T17:00:00.000Z';
  await commit([reading('meter','Energy',10,first),reading('inva','Energy',5,last),reading('snow','Snow code',null,observation)]);
  const record=h.performanceAnalysisInput('site'),p=h.captureAnalysisProvenance('blank-snow',record,assets),snapshot=JSON.stringify(store.analysis('blank-snow'));
  assert.equal(p.scopes[0].start,first);assert.equal(p.scopes[0].end,last);
  const oldText=await new Response(h.canonicalAnalysisCsv(record,assets)).text();
  await commit([reading('snow','Snow code',null,observation)]);assert.equal(h.assessAnalysisFreshness('site','blank-snow').status,'current');
  await commit([reading('snow','Snow code',70,observation)]);assert.equal(h.assessAnalysisFreshness('site','blank-snow').status,'older');
  assert.equal(await new Response(h.canonicalAnalysisCsv(record,assets)).text(),oldText);
  assert.equal((await engine(store).buildSummary(record,assets)).snowReadingCount,0);
  const current=await engine(store).buildSummary(h.performanceAnalysisInput('site'),assets);
  assert.equal(current.snowReadingCount,1);assert.deepEqual(plain(current.snowDays),['2026-11-01']);assert.deepEqual(plain(current.timestamps),[first,last]);
  assert.deepEqual(plain(h.captureAnalysisProvenance('blank-snow',record,[])),plain(p));
  assert.deepEqual(plain(h.resumeAnalysisProvenance('blank-snow',record,p)),plain(p));
  assert.equal(JSON.stringify(store.analysis('blank-snow')),snapshot);
});

for(const c of [
  {timezone:'UTC',date:'2026-06-01',before:'2026-06-01T00:00:00Z',after:'2026-06-06T23:59:00Z'},
  {timezone:'Asia/Kathmandu',date:'2026-06-01',before:'2026-06-01T00:00:00+05:45',after:'2026-06-06T23:59:00+05:45'},
  {timezone:'America/New_York',date:'2026-03-08',before:'2026-03-08T00:00:00-05:00',after:'2026-03-13T23:59:00-04:00'},
  {timezone:'America/New_York',date:'2026-10-27',before:'2026-10-27T00:00:00-04:00',after:'2026-11-01T23:59:00-05:00'},
])test(`boundary-day snow changes actual findings and retains CSV/canonical parity: ${c.timezone} ${c.date}`,async()=>{
  // The unchanged snow detector requires a larger deficit than the ordinary
  // derived-expectation rule; use one that remains detectable on a snow day.
  const options={...c,measurement:'POA irradiance',deficitKwh:30};
  const f=await analysisCsvFixture(options),store=versionedStore(f.readings,c.timezone),h=helpers(store),record=h.performanceAnalysisInput('site');
  const p=h.captureAnalysisProvenance('before-snow',record,f.equipment),canonical=engine(store),beforeSummary=await canonical.buildSummary(record,f.equipment),before=canonical.buildAnalysis(plain(beforeSummary),f.equipment);
  assert.equal(before.issues.filter(i=>i.type==='Underperformance').length,6);assert.equal(before.totalLossKwh,6*options.deficitKwh);
  assert.equal(before.recurringIssues.find(i=>i.equipmentId==='inv0').members.length,6);
  for(const observation of [c.before,c.after]) {
    const changed=await analysisCsvFixture({...options,snow:[{timestamp:observation,value:70}]});
    store.replace(changed.readings);
    assert.equal(h.assessAnalysisFreshness('site','before-snow').status,'older');
    const raw=engine(store,changed.source),a=await raw.buildSummary(changed.record,changed.equipment),b=await canonical.buildSummary(h.performanceAnalysisInput('site'),f.equipment);
    assert.deepEqual(comparableSummary(b),comparableSummary(a));
    assert.deepEqual(plain(b.timestamps),plain(beforeSummary.timestamps),'snow observations never establish production intervals');
    const rerun=canonical.buildAnalysis(plain(b),f.equipment);assert.deepEqual(plain(rerun),plain(raw.buildAnalysis(plain(a),changed.equipment)));
    assert.ok(rerun.issues.some(i=>i.suspectedCause==='Snow'));
    assert.equal(rerun.recurringIssues.find(i=>i.equipmentId==='inv0').members.length,5,'the snow occurrence leaves the ordinary recurring group');
    assert.notDeepEqual(plain(rerun.issues),plain(before.issues));
    assert.equal(rerun.totalLossKwh,before.totalLossKwh);
    const snowRows=[...store.rows()].filter(r=>r.channel.equipmentId==='snow'&&r.value===70);
    assert.deepEqual(snowRows.map(r=>r.timestamp),[new Date(observation).toISOString()],'observation instants are not shifted with interval-end production');
    assert.deepEqual(plain(h.captureAnalysisProvenance('before-snow',record,[])),plain(p));
    assert.deepEqual(comparableSummary(await canonical.buildSummary(record,f.equipment)),comparableSummary(beforeSummary));
  }
  for(const timestamp of [new Date(Date.parse(c.before)-1).toISOString(),new Date(Date.parse(c.after)+60000).toISOString()]) {
    const unrelated=await analysisCsvFixture({...options,snow:[{timestamp,value:70}]});
    store.replace(unrelated.readings);assert.equal(h.assessAnalysisFreshness('site','before-snow').status,'current');
    const summary=await canonical.buildSummary(h.performanceAnalysisInput('site'),f.equipment),rerun=canonical.buildAnalysis(summary,f.equipment);
    assert.deepEqual(plain(rerun.issues),plain(before.issues));assert.deepEqual(plain(rerun.recurringIssues),plain(before.recurringIssues));
    assert.equal(rerun.totalLossKwh,before.totalLossKwh);
  }
});

test('without a configured snow model, categorical observations are neither consumed nor freshness dependencies',async()=>{
  for(const equipment of [assets.filter(a=>a.id!=='snow'),assets.map(a=>a.id==='snow'?{...a,name:'Weather station'}:a)]) {
    const base=[reading('meter','Energy',10),reading('inva','Energy',5,end)],store=versionedStore(base),h=helpers(store),record=h.performanceAnalysisInput('site');
    const p=h.captureAnalysisProvenance('no-snow',record,equipment);assert.equal(p.scopes.length,1);
    store.replace([...base,reading('snow','Snow code',70,start),reading('snow','Status',70,'2026-06-01T00:00:00.000Z')]);
    assert.equal(h.assessAnalysisFreshness('site','no-snow').status,'current');
    const summary=await engine(store).buildSummary(h.performanceAnalysisInput('site'),equipment);
    assert.equal(summary.snowSensorConfigured,false);assert.equal(summary.snowReadingCount,0);assert.deepEqual(plain(summary.snowDays),[]);
  }
});
