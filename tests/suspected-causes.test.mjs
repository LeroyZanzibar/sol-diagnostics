import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { loadSource , modelCapacityBindings} from './source-module.mjs';
const time = loadSource('app/telemetry-time.ts');
const causes = { ...time, ...loadSource('app/api/performance-summary/causes.ts', [], time) };
Object.assign(causes, loadSource("app/api/performance-summary/peer-comparison.ts", [], {...modelCapacityBindings(),...time}));
Object.assign(causes, loadSource("app/api/performance-summary/telemetry-events.ts", [], {...modelCapacityBindings(),...(causes)}), loadSource("app/meter-mapping.ts"));
const { attributeCauses, shadingCandidates, expectedAssumptions } = causes;
const route = loadSource('app/api/performance-summary/route.ts', ['buildSummary', 'buildAnalysis', 'calendarInterval'], {...modelCapacityBindings(),...({
  ...causes, getBucketBinding: () => ({ get: async () => ({ body: new Response(csv).body }) }),
})});
let csv = '';
const evidence = timestamps => timestamps.map(timestamp => ({ timestamp, lossKwh: 20, countedLossKwh: 20, actualKwh: 20, expectedKwh: 40 }));
function issue(timestamps, fields = {}) { return { id:'original', type:'Underperformance', category:'Performance', equipmentId:'inv0', equipmentType:'inverter',
  startDateTime:timestamps[0], endDateTime:timestamps.at(-1).replace('10:00','11:00'), durationMinutes:60, durationDays:1/24,
  actualEnergyKwh:20*timestamps.length, expectedEnergyKwh:40*timestamps.length, estimatedLossKwh:20*timestamps.length, lossPercent:50,
  evidence: { intervalLosses:evidence(timestamps) }, ...fields }; }
const summary = { intervalMinutes:60, snowSensorConfigured:true, snowDays:['2026-01-02'], expectedProduction:[{timestamp:'2026-01-02T10:00:00',energyKwh:40}],
  causeContext:{ latitude:'', longitude:'', timeZone:'America/New_York', assumptions:expectedAssumptions({}) } };

test('one 70 reading qualifies its unrounded site-local day; 60, missing, and invalid codes do not', async () => {
  csv = 'time,snow\n2026-01-01T23:59:00,70\n2026-01-02T12:00:00,60\n2026-01-03T04:59:00Z,70\n2026-01-03T12:00:00,60\n2026-01-04T12:00:00,\n2026-01-05T12:00:00,bad\n2026-01-06T12:00:00,70.0\n2026-01-07T12:00:00,170';
  // Sparse categorical records are minute-aligned; declare that native cadence
  // rather than asking the production parser to infer it from multi-day gaps.
  const record = { objectKey:'x', timezone:'America/New_York', rowCount:8, validation:JSON.stringify({interval:'1 min',intervalMinutes:1}), mapping:JSON.stringify({roles:{timestamp:'time'},equipment:{signals:[{column:'snow',equipmentId:'sensor',measurement:'Snow code'}]}}) };
  const equipment = [{ id:'sensor',name:'Snow sensor',type:'weather_sensor',externalId:'snow',aliases:'[]' }];
  const parsed = await route.buildSummary(record,equipment);
  assert.deepEqual([...parsed.snowDays],['2026-01-01','2026-01-02','2026-01-06']);
  assert.equal(parsed.snowReadingCount,6);
  assert.equal(parsed.equipmentProduction.length,0);
  assert.equal(parsed.intervalIrradiance.length,0);
  const without = await route.buildSummary(record,[{...equipment[0],name:'Other sensor'}]);
  assert.equal(without.snowSensorConfigured,false);
  assert.equal(without.snowDays.length,0);
});

test('long-format Status codes support aliases and site time zones', async () => {
  csv='time,equipment,measurement,value\n2026-07-01T03:59:00Z,snow-id,Status,70\n2026-07-01T12:00:00Z,snow-id,Status,60';
  // A categorical-only fixture cannot establish a production cadence; supply it explicitly.
  const record={objectKey:'x',timezone:'America/New_York',rowCount:2,validation:JSON.stringify({intervalMinutes:60}),mapping:JSON.stringify({roles:{timestamp:'time',equipment:'equipment',measurement:'measurement',value:'value'}})};
  const parsed=await route.buildSummary(record,[{id:'sensor',name:'Snow sensor',type:'weather_sensor',externalId:'snow-id',aliases:'[]'}]);
  assert.deepEqual([...parsed.snowDays],['2026-06-30']);
});

test('snow labels the whole qualifying day, splits multi-day losses, and conserves reconciled loss', () => {
  const original=issue(['2026-01-01T10:00:00','2026-01-02T10:00:00','2026-01-03T10:00:00']);
  const rows=attributeCauses([original],summary);
  assert.deepEqual(rows.map(r=>r.suspectedCause),['','Snow','']);
  assert.equal(rows.reduce((sum,r)=>sum+r.estimatedLossKwh,0),original.estimatedLossKwh);
  assert.equal(rows[1].startDateTime,'2026-01-02T10:00:00');
  assert.equal(rows[1].endDateTime,'2026-01-02T11:00:00');
  assert.equal(rows[1].evidence.originalIssueId,original.id);
  assert.equal(new Set(rows.map(r=>r.id)).size,3);
  const without=attributeCauses([original],{...summary,snowSensorConfigured:false});
  assert.equal(without[0].suspectedCause,''); assert.equal(without.length,1);
});

test('snow does not override outages, data gaps, communications, or hierarchy-suppressed intervals', () => {
  for(const [type,category] of [['Site outage','Performance'],['Equipment outage','Performance'],['Data gap','Data quality'],['Communication issue','Communications']]){
    assert.equal(attributeCauses([issue(['2026-01-02T10:00:00'],{type,category})],summary)[0].suspectedCause,'');
  }
  const original=issue(['2026-01-01T10:00:00','2026-01-02T10:00:00'],{estimatedLossKwh:20});
  original.evidence.intervalLosses[1].countedLossKwh=0;
  const rows=attributeCauses([original],summary);
  assert.equal(rows.reduce((sum,r)=>sum+r.estimatedLossKwh,0),20);
  assert.ok(rows.every(r=>r.suspectedCause===''));
});

test('midnight-crossing intervals partition energy by local date and preserve monthly allocation', () => {
  const original=issue(['2026-01-31T23:30:00'],{endDateTime:'2026-02-01T00:30:00'});
  const rows=attributeCauses([original],{...summary,snowDays:['2026-02-01']});
  assert.deepEqual(rows.map(r=>r.suspectedCause),['','Snow']);
  assert.deepEqual(rows.map(r=>r.estimatedLossKwh),[10,10]);
  const {monthlyLosses}=loadSource('app/issue-periods.ts', [], time);
  const months=rows.flatMap(r=>monthlyLosses(r,60));
  assert.equal(months.reduce((sum,r)=>sum+r.estimatedLossKwh,0),20);
});

function shadeFixture() {
  const summary={intervalMinutes:60,snowDays:[],causeContext:{latitude:'40',longitude:'-75',timeZone:'America/New_York',assumptions:expectedAssumptions({})},expectedProduction:[],intervalIrradiance:[],equipmentProduction:[]};
  for(let i=0;i<4;i++) summary.equipmentProduction.push({equipmentId:`inv${i}`,equipmentType:'inverter',capacityKw:100,intervalProduction:[]});
  const affected=[];
  for(let day=1;day<=8;day++) for(let hour=8;hour<=16;hour++) {
    const timestamp=`2026-06-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:00:00`;
    summary.intervalIrradiance.push({timestamp,averageWm2:600,insolationKwhM2:.6});
    summary.expectedProduction.push({timestamp,energyKwh:240});
    for(let i=0;i<4;i++) summary.equipmentProduction[i].intervalProduction.push({timestamp,energyKwh:i===0&&hour===9?20:60});
    if(hour===9) affected.push(timestamp);
  }
  const assets = summary.equipmentProduction.flatMap(p => [{id:p.equipmentId,type:"inverter",acRatedCapacityKw:"100"},
    {id:p.equipmentId+"-modules",type:"module_group",parentId:p.equipmentId,moduleRatedCapacityW:"400",quantity:250}]);
  assets.push({id:'meter',type:'revenue_meter'});
  return {summary,issues:[issue(affected)],assets};
}
test('shading needs repeat sun-position losses, recovery and three healthy peers; snow takes priority',()=>{
  const {summary,issues,assets}=shadeFixture();
  const peers=causes.compareCapacityPeers(summary,assets);
  const candidates=shadingCandidates(summary,issues,peers);
  assert.equal(candidates.size,8);
  assert.equal(attributeCauses(issues,summary,peers)[0].suspectedCause,'Shading');
  for(const changed of [
    {...summary,causeContext:{...summary.causeContext,latitude:''}},
    {...summary,equipmentProduction:summary.equipmentProduction.slice(0,3)},
    {...summary,snowDays:issues[0].evidence.intervalLosses.map(p=>p.timestamp.slice(0,10))},
  ]) assert.equal(shadingCandidates(changed,issues,causes.compareCapacityPeers(changed,assets)).size,0);
  const short=[issue(issues[0].evidence.intervalLosses.slice(0,4).map(p=>p.timestamp))];
  assert.equal(shadingCandidates(summary,short,peers).size,0);
  const snow=attributeCauses(issues,{...summary,snowSensorConfigured:true,snowDays:['2026-06-01']},peers);
  assert.equal(snow[0].suspectedCause,'Snow');
});

test('included, not-included and unknown allowances change interpretation without subtracting losses again',()=>{
  for(const setting of ['included','not_included','unknown']) {
    const assumptions=expectedAssumptions({expectedSnow:setting});
    const [row]=attributeCauses([issue(['2026-01-02T10:00:00'])],{...summary,causeContext:{...summary.causeContext,assumptions}});
    assert.equal(row.estimatedLossKwh,20);
    assert.equal(row.evidence.expectedProductionAssumptions.snow,setting);
    assert.match(row.causeExplanation,setting==='included'?/additional shortfall/:setting==='unknown'?/uncertain/:/no allowance/);
  }
});

test('migration initializes existing and new sites to Not included without overwriting settings',()=>{
  const db=new DatabaseSync(':memory:');
  for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')&&!f.startsWith('0012')).sort()) db.exec(readFileSync(`drizzle/${f}`,'utf8'));
  db.prepare('INSERT INTO site_settings (id,name,latitude) VALUES (?,?,?)').run('existing','Existing','40');
  db.exec(readFileSync('drizzle/0012_real_genesis.sql','utf8'));
  db.prepare('INSERT INTO site_settings (id,name) VALUES (?,?)').run('new','New');
  for(const row of db.prepare('SELECT * FROM site_settings').all()) { assert.equal(row.expected_shading,'not_included');assert.equal(row.expected_snow,'not_included'); }
  assert.equal(db.prepare('SELECT latitude FROM site_settings WHERE id=?').get('existing').latitude,'40');
});
