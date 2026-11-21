import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as domain from '../app/monthly-domain.mjs';
const oracle=JSON.parse(readFileSync(new URL('./monthly-calculated-oracle.json',import.meta.url),'utf8'));
const capacityFields=['budgetedSpecificYield','actualSpecificYield','specificYieldRatio','budgetedPerformanceRatio','actualPerformanceRatio','performanceRatioRatio'];
const telemetryFields=['actualPerformanceRatio','performanceRatioRatio','insolationRatio','productionExpectedRatio','iapr','iar'];
const model=(modules=[['400',300]])=>[
 {id:'meter',type:'revenue_meter',parentId:null,acLineLossPercent:'99',transformerLossPercent:'99'},
 {id:'tx',type:'transformer',parentId:'meter',nameplateKva:'1',pvCeilingOverrideEnabled:true,pvCeilingOverrideKw:'0.5'},
 {id:'inverter',type:'inverter',parentId:'tx',acRatedCapacityKw:'1',maxDcCapacityKw:'2'},
 ...modules.map(([moduleRatedCapacityW,quantity],i)=>({id:'modules-'+i,type:'module_group',parentId:'inverter',moduleRatedCapacityW,quantity})),
 {id:'weather',type:'weather_sensor',parentId:null}
];
function inputs(c=oracle.cases[0]){
 const metric=value=>({value,state:'complete',coveredMilliseconds:2678400000,partialIntervals:0,unknownQualityIntervals:0,negativeIntervals:0});
 return {projections:[structuredClone(c.projection)],utility:{[c.month]:structuredClone(c.utility)},capacity:{dcKwp:c.capacity,unavailableReason:null},telemetry:{state:'current',months:{[c.month]:{expected:metric(c.expected),insolation:{...metric(c.insolation),source:'Imported irradiance; satellite/POA provenance unknown'}}}}};
}
const calculate=f=>domain.calculatedRows(f.projections,f.utility,f.telemetry,f.capacity)[f.projections[0].month];
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;}
function missing(metric,reason){assert.equal(metric.value,null);assert.equal(metric.state,'missing');assert.match(metric.reason,reason);}

test('all twelve exact metrics and all formats match an independent Python Fraction oracle',()=>{
 assert.deepEqual(domain.calculatedFields,oracle.keys);
 for(const c of oracle.cases){
  const f=inputs(c),assets=freeze(model(c.modules));f.capacity=domain.modelDcCapacity(assets);assert.deepEqual(f.capacity,{dcKwp:c.capacity,unavailableReason:null},c.name);
  if(c.configuration){const row=domain.projectionRows(c.configuration).find(r=>r.month===c.month);for(const key of ['production','revenue','insolation'])assert.deepEqual(row[key],c.projection[key],`${c.name} ${key}`);f.projections=[row];}
  const before=JSON.stringify(f),result=calculate(freeze(f));
  assert.deepEqual(Object.keys(result),oracle.keys);
  for(const key of oracle.keys){assert.deepEqual(result[key],{value:c.values[key],state:'available',reason:null},`${c.name} ${key}`);assert.equal(domain.formatCalculatedValue(key,result[key].value),c.formatted[key],`${c.name} ${key} display`);}
  assert.equal(JSON.stringify(f),before,'calculating and formatting never change accepted inputs');
 }
});

test('DC rating uses every connected module, decimal/scientific precision, no AC caps/losses/verification gate',()=>{
 const assets=model([['4.000000000000000001e2',300],['.5e3',1]]);
 assert.deepEqual(domain.modelDcCapacity(assets).dcKwp,{n:'12050000000000000003',d:'100000000000000000'});
 for(const rating of ['400','400.','+400',' 4e+2 ','0x190','0b110010000','0o620'])assert.deepEqual(domain.modelDcCapacity(model([[rating,300]])).dcKwp,{n:'120',d:'1'},rating);
 const direct=model();direct.splice(1,1);direct.find(a=>a.type==='inverter').parentId='meter';
 for(const asset of direct){delete asset.acRatedCapacityKw;delete asset.maxDcCapacityKw;delete asset.acLineLossPercent;delete asset.transformerLossPercent;}
 assert.deepEqual(domain.modelDcCapacity(direct),{dcKwp:{n:'120',d:'1'},unavailableReason:null});
 const irrelevant=model();for(const a of irrelevant)if(a.type!=='module_group'){a.acRatedCapacityKw='';a.nameplateKva='';a.pvCeilingOverrideKw='';a.acLineLossPercent='';a.transformerLossPercent='';}
 assert.deepEqual(domain.modelDcCapacity(irrelevant).dcKwp,{n:'120',d:'1'});
});

test('incomplete model fails closed instead of understating a site DC total',()=>{
 const mutations=[
  a=>a.splice(0),a=>a.splice(a.findIndex(x=>x.type==='module_group'),1),
  a=>a.push({id:'unfilled',type:'inverter',parentId:'tx'}),
  a=>a.push({id:'orphan',type:'module_group',parentId:'missing',moduleRatedCapacityW:'500',quantity:100}),
  a=>a.find(x=>x.type==='module_group').parentId=null,
  a=>a.find(x=>x.type==='inverter').parentId=null,
  a=>a.find(x=>x.type==='transformer').parentId=null,
  a=>a.find(x=>x.type==='module_group').parentId='meter',
  a=>a.find(x=>x.type==='revenue_meter').parentId='tx',
  a=>a.push({...a[0]})
 ];
 for(const bad of ['',null,undefined,'0','-1','NaN','Infinity','1e309','1.2.3','400 watts','true',true,{}])mutations.push(a=>{a.find(x=>x.type==='module_group').moduleRatedCapacityW=bad;});
 for(const bad of [0,-1,NaN,Infinity,null,undefined,''])mutations.push(a=>{a.find(x=>x.type==='module_group').quantity=bad;});
 for(const mutate of mutations){const assets=model();mutate(assets);const capacity=domain.modelDcCapacity(assets);assert.equal(capacity.dcKwp,null,JSON.stringify(assets));assert.match(capacity.unavailableReason,/DC capacity/i);}
 const f=inputs();f.capacity=domain.modelDcCapacity([]);const metrics=calculate(f);
 for(const key of capacityFields)missing(metrics[key],/DC capacity/i);
 for(const key of oracle.keys.filter(k=>!capacityFields.includes(k)))assert.deepEqual(metrics[key].value,oracle.cases[0].values[key],key+' is independent of capacity');
});

test('missing and zero denominators stay missing with dependency reasons; zeros, >100% and signed revenue survive',()=>{
 const cases=[
  [f=>{f.projections[0].production=null;},['budgetedSpecificYield','specificYieldRatio','budgetedPerformanceRatio','performanceRatioRatio','productionProjectionRatio','iapr'],/projected production/i],
  [f=>{f.projections[0].production={n:'0',d:'1'};},['specificYieldRatio','performanceRatioRatio','productionProjectionRatio','iapr'],/zero/i],
  [f=>{f.utility['2026-01'].onPeak=null;f.utility['2026-01'].offPeak=null;},['actualSpecificYield','specificYieldRatio','actualPerformanceRatio','performanceRatioRatio','productionProjectionRatio','productionExpectedRatio','iapr'],/utility.*production/i],
  [f=>{f.projections[0].revenue=null;},['revenueRatio','iar'],/budgeted revenue/i],
  [f=>{f.projections[0].revenue={n:'0',d:'1'};},['revenueRatio','iar'],/zero/i],
  [f=>{f.utility['2026-01'].revenue=null;},['revenueRatio','iar'],/utility.*revenue/i],
  [f=>{f.projections[0].insolation=null;},['budgetedPerformanceRatio','performanceRatioRatio','insolationRatio','iapr','iar'],/projected insolation/i],
  [f=>{f.projections[0].insolation={n:'0',d:'1'};},['budgetedPerformanceRatio','performanceRatioRatio','insolationRatio','iapr','iar'],/zero/i],
  [f=>{f.telemetry.months['2026-01'].insolation.value={n:'0',d:'1'};},['actualPerformanceRatio','performanceRatioRatio','iapr','iar'],/zero/i],
  [f=>{f.telemetry.months['2026-01'].expected.value={n:'0',d:'1'};},['productionExpectedRatio'],/zero/i]
 ];
 for(const [mutate,fields,reason] of cases){const f=inputs();mutate(f);const metrics=calculate(f);for(const key of fields)missing(metrics[key],reason);}
 const zero=inputs();zero.utility['2026-01'].onPeak='0';zero.utility['2026-01'].offPeak=null;zero.utility['2026-01'].revenue='0';
 for(const key of ['actualSpecificYield','specificYieldRatio','actualPerformanceRatio','performanceRatioRatio','productionProjectionRatio','productionExpectedRatio','revenueRatio','iapr','iar'])assert.deepEqual(calculate(zero)[key],{value:{n:'0',d:'1'},state:'available',reason:null},key);
 assert.equal(domain.formatCalculatedValue('iapr',null),'—');
});

test('partial/unknown telemetry propagates only to its dependent metrics; stale data is unavailable',()=>{
 const f=inputs();f.telemetry.months['2026-01'].insolation.state='partial';f.telemetry.months['2026-01'].insolation.unknownQualityIntervals=1;
 let result=calculate(f);
 for(const key of telemetryFields.filter(k=>k!=='productionExpectedRatio')){assert.equal(result[key].state,'partial');assert.match(result[key].reason,/insolation.*partial/i);assert.match(result[key].reason,/quality/i);assert.deepEqual(result[key].value,oracle.cases[0].values[key]);}
 assert.equal(result.productionExpectedRatio.state,'available');assert.equal(result.actualSpecificYield.state,'available');
 f.telemetry.months['2026-01'].expected.state='partial';f.telemetry.months['2026-01'].expected.partialIntervals=2;
 result=calculate(f);assert.equal(result.productionExpectedRatio.state,'partial');assert.match(result.productionExpectedRatio.reason,/Expected Production.*partial/i);
 for(const state of ['refreshing','missing']){f.telemetry.state=state;result=calculate(f);for(const key of telemetryFields)missing(result[key],/telemetry/i);assert.equal(result.actualSpecificYield.state,'available');assert.equal(result.revenueRatio.state,'available');}
 f.telemetry.state='current';f.telemetry.selectionRequired=true;result=calculate(f);for(const key of telemetryFields.filter(k=>k!=='productionExpectedRatio'))missing(result[key],/select.*irradiance/i);
 f.telemetry.selectionRequired=false;f.telemetry.expectedUnavailableReason='Multiple Expected Production channels; no series selected.';missing(calculate(f).productionExpectedRatio,/Multiple Expected Production/);
 delete f.telemetry.months['2026-01'];for(const key of telemetryFields)missing(calculate(f)[key],/missing|Expected Production/);
});
