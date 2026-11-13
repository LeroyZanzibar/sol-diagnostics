import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/d1';
import { sql, eq, asc, inArray } from 'drizzle-orm';
import * as sqliteCore from 'drizzle-orm/sqlite-core';
import { loadSource, modelCapacityBindings } from './source-module.mjs';

const capacity = modelCapacityBindings();
const time = loadSource('app/telemetry-time.ts');
const causes = {...time,...loadSource('app/api/performance-summary/causes.ts',[],time)};
const peers = loadSource('app/api/performance-summary/peer-comparison.ts',[],{...modelCapacityBindings(),...time});
const telemetry = loadSource('app/api/performance-summary/telemetry-events.ts',[],{...capacity,...causes});
const engine = loadSource('app/api/performance-summary/route.ts',['buildAnalysis','arrayModelRevision'],{...capacity,...causes,...peers,...telemetry});
const csv = loadSource('app/telemetry-csv.ts',[],{...capacity,...time});
const near = (actual, expected) => assert.ok(Math.abs(actual-expected)<1e-8, `${actual} != ${expected}`);
function model() {
  const assets = [
    {id:'meter',type:'revenue_meter',acLineLossPercent:'0',transformerLossPercent:'0'},
    {id:'tx1',type:'transformer',parentId:'meter',nameplateKva:'150',pvCeilingOverrideEnabled:false,pvCeilingOverrideKw:''},
    {id:'tx2',type:'transformer',parentId:'meter',nameplateKva:'300',pvCeilingOverrideEnabled:false,pvCeilingOverrideKw:''},
  ];
  for(let i=0;i<4;i++) assets.push(
    {id:`i${i}`,type:'inverter',parentId:i<2?'tx1':'tx2',acRatedCapacityKw:'100'},
    {id:`m${i}`,type:'module_group',parentId:`i${i}`,moduleRatedCapacityW:'500',quantity:250},
  );
  return assets.map((a,position)=>({name:a.id,externalId:a.id,manufacturer:'',model:'',aliases:[],channels:[],quantity:1,position,...a}));
}
function fixture(days=4, minutes=60) {
  const assets=model();
  const summary={timezone:'UTC',intervalMinutes:minutes,timestamps:[],intervalIrradiance:[],expectedProduction:[],equipmentProduction:[],dailyProduction:[],totalEnergyKwh:0,latestDate:'',latestDayEnergyKwh:0};
  for(const a of assets.filter(a=>['inverter','revenue_meter'].includes(a.type))) summary.equipmentProduction.push({equipmentId:a.id,equipmentName:a.name,externalId:a.id,equipmentType:a.type,capacityKw:a.id==='meter'?400:100,source:'interval_energy',intervalProduction:[],dailyProduction:[],readingCount:0});
  for(let d=1;d<=days;d++)for(let h=10;h<14;h++)for(let m=0;m<60;m+=minutes){
    const timestamp=`2026-06-${String(d).padStart(2,'0')}T${h}:${String(m).padStart(2,'0')}:00Z`,hours=minutes/60;
    summary.timestamps.push(timestamp);summary.intervalIrradiance.push({timestamp,averageWm2:600,insolationKwhM2:.6*hours});
    summary.expectedProduction.push({timestamp,energyKwh:400*hours});
    for(const p of summary.equipmentProduction)p.intervalProduction.push({timestamp,energyKwh:(p.equipmentId==='meter'?330:p.equipmentId==='i0'||p.equipmentId==='i1'?75:90)*hours});
  }
  return {assets,summary};
}

test('independent transformer caps, override toggle, DC limits and delivery losses',()=>{
  const a=model();let m=capacity.arrayCapacityModel(a);
  assert.equal(m.complete,true);assert.equal(m.installedAcKw,400);assert.equal(m.pvCeilingKw,350);
  // Spare nameplate capacity on tx2 cannot raise tx1 above 150.
  near(capacity.deliveredInverterEnergy(m,new Map([['i0',100],['i1',100],['i2',100],['i3',100]]),1),350);
  const tx=a.find(a=>a.id==='tx1');tx.pvCeilingOverrideEnabled=true;tx.pvCeilingOverrideKw='180';
  assert.equal(capacity.arrayCapacityModel(a).pvCeilingKw,380);assert.equal(tx.nameplateKva,'150');
  tx.pvCeilingOverrideKw='250';assert.equal(capacity.arrayCapacityModel(a).pvCeilingKw,400);
  near(capacity.deliveredInverterEnergy(capacity.arrayCapacityModel(a),new Map([['i0',110],['i1',110],['i2',110],['i3',110]]),1),400);
  tx.pvCeilingOverrideEnabled=false;assert.equal(capacity.arrayCapacityModel(a).pvCeilingKw,350);
  a.filter(a=>a.type==='module_group'&&['i2','i3'].includes(a.parentId)).forEach(a=>a.quantity=100);
  a[0].acLineLossPercent='10';a[0].transformerLossPercent='2';m=capacity.arrayCapacityModel(a);
  assert.equal(m.pvCeilingKw,350);assert.equal(m.modeledGrossKw,250);near(m.gridExportKw,220.5);
});

test('incomplete transformer drafts block analysis; legacy models retain their capacity',()=>{
  for(const change of [a=>a.find(a=>a.id==='i0').parentId=null,a=>a[1].nameplateKva='',a=>a[1].parentId=null,a=>{a[1].pvCeilingOverrideEnabled=true;},a=>a.find(a=>a.id==='m0').quantity=0]){
    const f=fixture(1);change(f.assets);const m=capacity.arrayCapacityModel(f.assets);
    assert.equal(m.complete,false);assert.equal(m.gridExportKw,null);
    assert.throws(()=>engine.buildAnalysis(f.summary,f.assets),/Complete the transformer model/);
  }
  const a=model().filter(a=>a.type!=='transformer');a.filter(a=>a.type==='inverter').forEach(a=>a.parentId='meter');
  assert.equal(capacity.arrayCapacityModel(a).gridExportKw,400);
});

test('reassignment and ceiling changes invalidate analysis cache identity',async()=>{
  const a=model(),initial=await engine.arrayModelRevision(a);
  a.find(a=>a.id==='i1').parentId='tx2';assert.equal(capacity.arrayCapacityModel(a).pvCeilingKw,400);
  const reassigned=await engine.arrayModelRevision(a);assert.notEqual(reassigned,initial);
  a[1].pvCeilingOverrideEnabled=true;a[1].pvCeilingOverrideKw='180';
  assert.notEqual(await engine.arrayModelRevision(a),reassigned);
});

test('import validation uses transformer export ceiling at native cadence without changing measurements',()=>{
  for(const minutes of [5,15,60]){
    const rows=[[`2026-06-01T12:00:00Z`,String(350*minutes/60)],[new Date(Date.UTC(2026,5,1,12,minutes)).toISOString(),String(400*minutes/60)]];
    const before=JSON.stringify(rows);
    const result=csv.capacityValidation(['time','meter'],rows,{timestamp:'time'},[{column:'meter',equipmentId:'meter',measurement:'Energy'}],model());
    assert.equal(result.exportCapacityKw,350);assert.equal(result.capacityExceededRows,1);near(result.maxObservedPowerKw,400);assert.equal(JSON.stringify(rows),before);
  }
});

test('meter fallback caps each branch, preserves inverter readings, and requires full coverage',()=>{
  for(const missing of [false,true]){
    const f=fixture(1);const t=f.summary.timestamps[0];
    f.summary.equipmentProduction[0].intervalProduction=[];
    if(missing)f.summary.equipmentProduction.find(p=>p.equipmentId==='i0').intervalProduction=[];
    const original=JSON.stringify(f.summary.equipmentProduction.slice(1));
    const context=capacity.transformerAnalysisContext(f.summary,f.assets);
    const plan=telemetry.prepareTelemetry(f.summary,f.assets);
    const communication=plan.events.find(p=>p.timestamp===t&&p.type==='Communication issue');
    assert.equal(communication.unknown,missing);
    const point=f.summary.equipmentProduction[0].intervalProduction.find(p=>p.timestamp===t);
    if(missing)assert.equal(point,undefined);else near(point.energyKwh,330);
    assert.equal(JSON.stringify(f.summary.equipmentProduction.slice(1).map(({dailyProduction,...p})=>p)),JSON.stringify(JSON.parse(original).map(({dailyProduction,...p})=>p)));
    assert.equal(context.methodology.gridExportCeilingKw,350);
  }
});

test('normal transformer clipping cannot become a persistent peer anomaly',()=>{
  const f=fixture();
  const raw=JSON.stringify(f.summary.equipmentProduction.map(p=>p.intervalProduction));
  const peerPlan=peers.compareCapacityPeers(f.summary,f.assets);
  assert.equal(peerPlan.findings.size,0,'capacity-inconsistent expected data cannot qualify peer references');
  const result=engine.buildAnalysis(f.summary,f.assets);
  assert.equal(result.peerComparison.invertersWithRepeatedDeficits,0);
  assert.equal(result.totalLossKwh,0);
  assert.equal(JSON.stringify(f.summary.equipmentProduction.map(p=>p.intervalProduction)),raw);
  assert.equal(result.transformerLimits.cappedExpectedIntervals,16);
  assert.equal(result.transformerLimits.excludedExpectedKwh,800);
  assert.equal(result.inverterExpectation.expectedData.capacityConflict,16,'original expected data is checked before transformer capping');
});

test('site outage expected losses respect transformer ceiling at hourly and five-minute cadence',()=>{
  for(const minutes of [5,60]){
    const f=fixture(1,minutes);
    f.summary.equipmentProduction.forEach(p=>p.intervalProduction.forEach(p=>p.energyKwh=0));
    const result=engine.buildAnalysis(f.summary,f.assets);
    near(result.totalLossKwh,350*4);
    assert.ok(result.issues.every(p=>p.equipmentId==='meter'));
    near(result.issues.flatMap(i=>i.evidence.intervalLosses).reduce((s,p)=>s+(p.countedLossKwh??p.lossKwh),0),result.totalLossKwh);
  }
});

test('incremental recoverable losses share transformer headroom and cannot exceed it',()=>{
  for(const [actual,expected] of [[100,50],[140,10],[150,0],[180,0]]){
    const m=capacity.arrayCapacityModel(model()),t='2026-06-01T12:00:00Z';
    const issues=['i0','i1'].map(id=>({equipmentId:id,equipmentType:'inverter',estimatedLossKwh:40,expectedEnergyKwh:100,lossPercent:40,description:'Deficit',evidence:{intervalLosses:[{timestamp:t,lossKwh:40}]}}));
    const totals=new Map([['tx1',new Map([[t,{energy:actual,count:2}]])]]);
    const result=capacity.limitTransformerLosses(issues,m,totals,1);
    near(result.reduce((s,i)=>s+i.estimatedLossKwh,0),expected);
    near(result[0].estimatedLossKwh,expected/2);assert.equal(issues[0].estimatedLossKwh,40);
    near(result[0].evidence.transformerCapacityExcludedLossKwh,40-expected/2);
  }
});

function database() {
  const sqlite=new DatabaseSync(':memory:');
  for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
  const prepare=(sql,values=[])=>({bind:(...next)=>prepare(sql,next),
    async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}};},
    async first(){return sqlite.prepare(sql).get(...values)||null;},
    async all(){return {results:sqlite.prepare(sql).all(...values)};},
    async raw(){return sqlite.prepare(sql).all(...values).map(row=>Object.values(row));},
  });
  const db={prepare,async batch(items){sqlite.exec('BEGIN');try{const results=[];for(const item of items)results.push(await item.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const schema=loadSource('db/schema.ts',[],{sql,...sqliteCore});
  const orm=drizzle(db);
  const api=loadSource('app/api/equipment/route.ts',[],{...capacity,...schema,eq,asc,inArray,getDb:()=>orm,getDatabaseBinding:()=>db});
  sqlite.exec("INSERT INTO site_settings (id,name) VALUES ('site','Test')");
  return {sqlite,api,put:(equipment,verified=true)=>api.PUT(new Request('https://test/api/equipment',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({siteId:'site',equipment,verified})})),get:()=>api.GET(new Request('https://test/api/equipment?siteId=site'))};
}

test('equipment API saves and reloads transformer fields, boolean override and assignments',async()=>{
  const db=database(),assets=model();
  assets[1].pvCeilingOverrideEnabled=true;assets[1].pvCeilingOverrideKw='180';assets[1].notes='Approved operating limit';assets[1].manufacturer='Manufacturer';assets[1].model='TX model';
  let response=await db.put(assets);assert.equal(response.status,200,await response.clone().text());
  let saved=await response.json();assert.equal(saved.verified,true);
  saved=await (await db.get()).json();const transformer=saved.equipment.find(a=>a.id==='tx1');
  for(const key of ['nameplateKva','pvCeilingOverrideEnabled','pvCeilingOverrideKw','notes','manufacturer','model'])assert.equal(transformer[key],assets[1][key]);
  assert.equal(saved.equipment.find(a=>a.id==='i0').parentId,'tx1');
  near(capacity.arrayCapacityModel(saved.equipment).gridExportKw,380);
  saved.equipment.find(a=>a.id==='i1').parentId=null;
  response=await db.put(saved.equipment);assert.equal(response.status,200);assert.equal((await response.json()).verified,false);
});

test('invalid transformer values and hierarchy are rejected without changing stored configuration',async()=>{
  const db=database();assert.equal((await db.put(model())).status,200);
  for(const mutate of [a=>a[1].nameplateKva='-1',a=>a[1].nameplateKva='NaN',a=>a[1].pvCeilingOverrideKw='0',a=>a[1].pvCeilingOverrideEnabled='true',a=>a[1].parentId='i0',a=>a.find(a=>a.id==='m0').parentId='tx1']){
    const a=model();mutate(a);const response=await db.put(a);assert.equal(response.status,400,await response.clone().text());
  }
  const saved=await (await db.get()).json();assert.equal(saved.equipment.find(a=>a.id==='tx1').nameplateKva,'150');assert.equal(saved.verified,true);
});

test('additive transformer migration preserves existing equipment and verification data',()=>{
  const db=new DatabaseSync(':memory:');
  const files=readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort();
  for(const file of files.filter(f=>!f.startsWith('0014')))db.exec(readFileSync(`drizzle/${file}`,'utf8'));
  db.exec("INSERT INTO site_settings (id,name,array_model_verified) VALUES ('site','Legacy',1); INSERT INTO equipment_assets (id,site_id,type,name,external_id,ac_rated_capacity_kw) VALUES ('inv','site','inverter','Inverter','INV','125')");
  db.exec(readFileSync('drizzle/0014_conscious_king_cobra.sql','utf8'));
  const row=db.prepare('SELECT * FROM equipment_assets').get();
  assert.equal(row.ac_rated_capacity_kw,'125');assert.equal(row.nameplate_kva,'');assert.equal(row.pv_ceiling_override_enabled,0);assert.equal(row.notes,'');
  assert.equal(db.prepare('SELECT array_model_verified FROM site_settings').get().array_model_verified,1);
});
