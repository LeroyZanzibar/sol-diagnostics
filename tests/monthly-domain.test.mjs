import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateDecimal, validateConfiguration, emptyConfiguration, projectionRows, utilityTotal, formatValue, fraction, add, multiply} from '../app/monthly-domain.mjs';
const configuration=(start='2024-03-16', degradation='1')=>({...emptyConfiguration(),operationsStart:start,degradation,baselines:Object.fromEntries(Array.from({length:12},(_,i)=>[i+1,{production:'3100.123456789012345',revenue:'310',insolation:'31'}]))});
test('exact decimal strings, independent magnitude/length and syntax',()=>{
 for(const value of ['0','0.000000000000000001','999999999999','123.1234567890123456','.5','1.'])assert.equal(validateDecimal(value),value);
 for(const value of ['1e3','1,000','$1',' 1','1 ','-1','+1','..','NaN','999999999999.1','0.0000000000000000001',''])assert.throws(()=>validateDecimal(value));
 assert.equal(validateDecimal('-0.12345678901234567',true),'-0.12345678901234567');
 assert.throws(()=>validateDecimal('-999999999999.01',true));
 assert.equal(formatValue(add(fraction('0.000000000000000001'),fraction('0.000000000000000002')),18),'0.000000000000000003');
});
test('total treats blanks, a single category and zero independently',()=>{
 assert.equal(utilityTotal(null,null),null);assert.equal(formatValue(utilityTotal('0',null)),'0');
 assert.equal(formatValue(utilityTotal(null,'9.9'),1),'9.9');assert.equal(formatValue(utilityTotal('9.9','0.2'),1),'10.1');
 assert.equal(formatValue(fraction('-1.5')),'-2');
});
test('300 consecutive months; inclusive partial start and exact anniversaries, no insolation degradation',()=>{
 const c=configuration(),rows=projectionRows(c);assert.equal(rows.length,300);assert.equal(rows[0].month,'2024-03');assert.equal(rows.at(-1).month,'2049-02');
 assert.equal(formatValue(rows[0].insolation,2),'16.00');assert.equal(formatValue(rows[0].revenue),'160');
 assert.deepEqual(rows[0].production,multiply(fraction(c.baselines[3].production),fraction('16'),{n:'1',d:'31'}));
 assert.equal(formatValue(rows[11].revenue),'310');assert.equal(formatValue(rows[12].revenue,2),'308.40');
 assert.equal(formatValue(rows[12].insolation,2),'31.00');assert.equal(formatValue(rows[13].revenue,2),'306.90');
 c.baselines[3].production=null;assert.equal(projectionRows(c)[0].production,null);
});
test('leap anniversary is February 28; 100 percent degradation; date and degradation ranges',()=>{
 const c=configuration('2024-02-29','100');const rows=projectionRows(c);
 assert.equal(formatValue(rows[0].insolation,6),'1.068966');assert.equal(formatValue(rows[12].revenue,6),'298.928571');assert.equal(formatValue(rows[13].revenue),'0');
 for(const start of ['1900-01-01','2075-12-31'])validateConfiguration(configuration(start,'0.000000000000000001'));
 for(const start of ['1899-12-31','2076-01-01','2023-02-29','2024-2-01'])assert.throws(()=>validateConfiguration(configuration(start)));
 for(const value of ['100.0000000000000001','-1','1e-2',' 1'])assert.throws(()=>validateConfiguration(configuration('2020-01-01',value)));
 assert.equal(projectionRows(emptyConfiguration()).length,0);
});
test('absent degradation is not zero; partial setup retains horizon and independent insolation',()=>{
 assert.equal(emptyConfiguration().degradation,null);
 for(const rate of [null,'']){
  const c=validateConfiguration(configuration('2024-03-16',rate));assert.equal(c.degradation,null);
  const rows=projectionRows(c);assert.equal(rows.length,300);
  assert.ok(rows.every(r=>r.production===null&&r.revenue===null));
  assert.deepEqual(rows.map(r=>r.insolation),projectionRows(configuration('2024-03-16','0')).map(r=>r.insolation));
  assert.equal(formatValue(rows[0].insolation,2),'16.00');assert.equal(formatValue(rows[12].insolation,2),'31.00');
 }
 const zero=validateConfiguration(configuration('2024-03-16','000.000'));
 assert.equal(zero.degradation,'000.000');assert.equal(formatValue(projectionRows(zero)[13].revenue),'310');
 const partial=emptyConfiguration();partial.baselines[3].production='1.2500';
 assert.equal(validateConfiguration(partial).baselines[3].production,'1.2500');
});
