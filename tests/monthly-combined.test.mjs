import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calculatedRows,calculatedFields,formatCalculatedValue,projectionRows} from '../app/monthly-domain.mjs';
const oracle=JSON.parse(readFileSync(new URL('./monthly-calculated-oracle.json',import.meta.url),'utf8'));
const productionFields=['actualSpecificYield','specificYieldRatio','actualPerformanceRatio','performanceRatioRatio','productionProjectionRatio','productionExpectedRatio','iapr'];
const controls=['budgetedSpecificYield','budgetedPerformanceRatio','insolationRatio','revenueRatio','iar'];
const capacityFields=['budgetedSpecificYield','actualSpecificYield','specificYieldRatio','budgetedPerformanceRatio','actualPerformanceRatio','performanceRatioRatio'];
const telemetryFields=['actualPerformanceRatio','performanceRatioRatio','insolationRatio','productionExpectedRatio','iapr','iar'];
function inputs(c){
 const metric=value=>({value,state:'complete',partialIntervals:0,unknownQualityIntervals:0});
 return {projections:c.configuration?projectionRows(c.configuration).filter(r=>r.month===c.month):[structuredClone(c.projection)],utility:{[c.month]:structuredClone(c.utility)},capacity:{dcKwp:c.capacity,unavailableReason:null},telemetry:{state:'current',months:{[c.month]:{expected:metric(c.expected),insolation:metric(c.insolation)}}}};
}
const calculate=f=>calculatedRows(f.projections,f.utility,f.telemetry,f.capacity)[f.projections[0].month];
const named=name=>oracle.combinedCases.find(c=>c.name===name);
function check(result,c){
 assert.deepEqual(Object.keys(result),oracle.keys);
 for(const field of oracle.keys){
  assert.deepEqual(result[field].value,c.values[field],`${c.name} ${field}: unpaid energy must contribute to every production-dependent metric`);
  assert.equal(formatCalculatedValue(field,result[field].value),c.formatted[field],`${c.name} ${field} display`);
  if(c.values[field]===null){assert.equal(result[field].state,'missing');assert.match(result[field].reason,/Utility actual production total is missing/);}
  else assert.deepEqual(result[field],{value:c.values[field],state:'available',reason:null});
 }
}

test('combined: unpaid contribution reaches every exact production metric; all five controls are unchanged',()=>{
 const before=named('combined-http-before'),after=named('combined-http-after'),f=inputs(before);
 const first=calculate(f);check(first,before);
 const preserved=structuredClone(f);f.utility[before.month].unpaidEnergy=after.utility.unpaidEnergy;
 const changed=calculate(f);check(changed,after);
 for(const field of productionFields)assert.notDeepEqual(changed[field].value,first[field].value,field);
 for(const field of controls)assert.deepEqual(changed[field],first[field],field+' is not a function of utility production');
 assert.deepEqual({...f,utility:preserved.utility},preserved,'calculations must not mutate projections, telemetry, capacity or input strings');
 assert.deepEqual(f.utility[before.month],after.utility);
});

test('combined: eight presence combinations, unpaid-only zero, all blank, rounding boundaries and prorated/degraded projections',()=>{
 assert.deepEqual(calculatedFields,oracle.keys);
 const control=calculate(inputs(named('combined-presence-0')));
 for(const c of oracle.combinedCases){const f=inputs(c),before=structuredClone(f);check(calculate(f),c);assert.deepEqual(f,before);
  if(c.name.startsWith('combined-presence-')||c.name==='combined-unpaid-zero')for(const field of controls)assert.deepEqual(calculate(f)[field],control[field]);
 }
});

test('combined: unpaid-only production does not hide independent capacity, missing/zero denominator or telemetry dependencies',()=>{
 const c=named('combined-presence-4');
 const cases=[
  [f=>{f.capacity={dcKwp:null,unavailableReason:'DC capacity is unavailable.'};},capacityFields,/DC capacity/],
  [f=>{f.projections[0].production=null;},['budgetedSpecificYield','specificYieldRatio','budgetedPerformanceRatio','performanceRatioRatio','productionProjectionRatio','iapr'],/Projected production/],
  [f=>{f.projections[0].production={n:'0',d:'1'};},['specificYieldRatio','performanceRatioRatio','productionProjectionRatio','iapr'],/zero/],
  [f=>{f.telemetry.months[c.month].expected.value={n:'0',d:'1'};},['productionExpectedRatio'],/zero/],
  [f=>{f.telemetry.months[c.month].insolation.value={n:'0',d:'1'};},['actualPerformanceRatio','performanceRatioRatio','iapr','iar'],/zero/],
  [f=>{f.telemetry.state='refreshing';},telemetryFields,/refreshing/],
  [f=>{f.telemetry.state='missing';},telemetryFields,/missing/],
 ];
 for(const [mutate,fields,reason] of cases){const f=inputs(c);mutate(f);const result=calculate(f);for(const field of fields){assert.equal(result[field].value,null,field);assert.equal(result[field].state,'missing');assert.match(result[field].reason,reason);}assert.deepEqual(result.revenueRatio.value,c.values.revenueRatio);}
 const f=inputs(c);for(const metric of Object.values(f.telemetry.months[c.month])){metric.state='partial';metric.unknownQualityIntervals=1;}
 const result=calculate(f);for(const field of telemetryFields){assert.equal(result[field].state,'partial',field);assert.deepEqual(result[field].value,c.values[field]);assert.match(result[field].reason,/partial/);}
 for(const field of oracle.keys.filter(k=>!telemetryFields.includes(k)))assert.deepEqual(result[field],{value:c.values[field],state:'available',reason:null});
});
