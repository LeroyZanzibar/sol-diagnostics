import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {utilityTotal,formatValue,utilityFields,validateUtilityRows,fraction} from '../app/monthly-domain.mjs';
import {fixture,harness,adapter,configured,field,nodes} from './monthly-client-fixture.mjs';

const blank={onPeak:null,offPeak:null,unpaidEnergy:null,revenue:null,energyUsed:null,invoiceCost:null};
const cases=[
 [null,null,null,null],[null,null,'12.625','12.625'],
 ['1.125',null,null,'1.125'],[null,'2.25',null,'2.25'],
 ['1.125','2.25',null,'3.375'],['1.125',null,'12.625','13.75'],
 [null,'2.25','12.625','14.875'],['1.125','2.25','12.625','16'],
 ['0',null,null,'0'],[null,'0',null,'0'],[null,null,'0','0'],['0','0','0','0'],
 ['0.4','0.4','0.4','1.2'],
 ['999999999999','999999999999','999999999999','2999999999997'],
];
for(const [on,off,unpaid,expected] of cases)test(`unpaid total presence/exactness ${JSON.stringify([on,off,unpaid])}`,()=>{
 assert.deepEqual(utilityTotal(on,off,unpaid),expected===null?null:fraction(expected));
});
test('unpaid display rounds only the composed exact result',()=>{
 assert.equal(formatValue(utilityTotal(null,null,'12.625')),'13');
 assert.equal(formatValue(utilityTotal('0.4','0.4','0.4')),'1');
 assert.equal(utilityTotal(null,null,null),null);
 assert.equal(formatValue(utilityTotal('1.25',null)),'1','two-argument legacy callers remain supported');
 assert.deepEqual(utilityFields,['onPeak','offPeak','unpaidEnergy','revenue','energyUsed','invoiceCost']);
});
test('unpaid full-row validation requires nullable raw value; energy bounds independent of length',()=>{
 for(const value of [null,'','0','.5','1.','000.01230','999999999999','999999999998.9999999','0.000000000000000001']){
  const [row]=validateUtilityRows([{month:'2024-03',...blank,unpaidEnergy:value}]);assert.equal(row.unpaidEnergy,value===''?null:value);
 }
 for(const value of [undefined,12,-1,'-1','+1','1e3','1,000','$1',' 1','1 ','..','NaN','999999999999.1','0.0000000000000000001']){
  assert.throws(()=>validateUtilityRows([{month:'2024-03',...blank,unpaidEnergy:value}]),{status:400},String(value));
 }
 const {unpaidEnergy:omitted,...missing}=blank;assert.equal(omitted,null);
 assert.throws(()=>validateUtilityRows([{month:'2024-03',...missing}]),{status:400});
});
const cells=(h,mode)=>nodes(h.tree(mode)).find(n=>n.type==='tbody').props.children[0].props.children;
const text=cell=>renderToStaticMarkup(cell).replace(/<[^>]+>/g,'');
async function edit(t,f){const h=harness(adapter(f));t.after(()=>h.dispose());h.render();await h.flush();h.render().edit();h.render();return h;}
test('real editor and store: unpaid-only raw input, both callers, unchanged save/reopen and clearing',async t=>{
 const f=fixture(t);configured(f);const h=await edit(t,f),label='2024-03 Unpaid energy',raw='12.6250';
 const input=field(h.tree('utility'),label);assert.ok(input,'real unpaid input');assert.equal(input.props.value,'');
 const headings=nodes(h.tree('utility')).filter(n=>n.type==='th'&&n.props.scope==='col').map(text);
 assert.deepEqual(headings,['Month','On-peak productionkWh','Off-peak productionkWh','Unpaid energykWh','Total productionkWh · calculated','Utility revenue$','Utility energy usedkWh','Invoice energy used cost$']);
 input.props.onChange({target:{value:raw}});h.render();assert.deepEqual(JSON.parse(JSON.stringify(h.current.utility['2024-03'])),{...blank,unpaidEnergy:raw});
 assert.equal(text(cells(h,'utility')[2]),'13');
 await h.current.save('utility');h.render();assert.match(h.current.notice,/Saved and verified/);
 assert.equal(text(cells(h,'utility')[1][2]),'13');assert.equal(text(cells(h,'comparison')[1]),'13');
 await f.reopen();assert.equal(f.service.inputs.read('review-site').utility['2024-03'].unpaidEnergy,raw);
 h.current.edit();h.render();assert.equal(field(h.tree('utility'),label).props.value,raw);
 await h.current.save('utility');h.render();assert.match(h.current.notice,/No changes/);
 await f.reopen();await h.current.reload();h.render();h.current.edit();h.render();assert.equal(field(h.tree('utility'),label).props.value,raw);
 field(h.tree('utility'),label).props.onChange({target:{value:''}});h.render();await h.current.save('utility');h.render();
 assert.equal(f.service.inputs.read('review-site').utility['2024-03'].unpaidEnergy,null);assert.equal(text(cells(h,'utility')[2]),'—');assert.equal(text(cells(h,'comparison')[1]),'—');
});
test('real editor sums decimals before display and suppresses invalid unpaid draft',async t=>{
 const f=fixture(t);configured(f);const h=await edit(t,f);
 for(const label of ['On-peak production','Off-peak production','Unpaid energy']){field(h.tree('utility'),`2024-03 ${label}`).props.onChange({target:{value:'0.4'}});h.render();}
 assert.equal(text(cells(h,'utility')[2]),'1');await h.current.save('utility');h.render();assert.equal(text(cells(h,'comparison')[1]),'1');
 h.current.edit();h.render();field(h.tree('utility'),'2024-03 Unpaid energy').props.onChange({target:{value:'1e3'}});h.render();
 assert.equal(field(h.tree('utility'),'2024-03 Unpaid energy').props['aria-invalid'],true);assert.equal(text(cells(h,'utility')[2]),'—');
 const before=f.service.inputs.read('review-site');await h.current.save('utility');h.render();assert.ok(h.current.error);assert.deepEqual(f.service.inputs.read('review-site'),before);
 h.current.cancel();h.render();assert.equal(text(cells(h,'utility')[2]),'1');
});
test('all presence combinations persist and agree in both real rendered callers',async t=>{
 const f=fixture(t);configured(f);const h=await edit(t,f);
 for(const [onPeak,offPeak,unpaidEnergy,exact] of cases){
  const current=f.service.inputs.read('review-site');
  f.service.inputs.saveUtility('review-site',current.revision,[{month:'2024-03',...blank,onPeak,offPeak,unpaidEnergy}]);
  await h.current.reload();h.render();
  const expected=exact===null?'—':formatValue(exact,0,true);
  assert.equal(text(cells(h,'utility')[2]),expected);assert.equal(text(cells(h,'comparison')[1]),expected);
 }
});
test('unpaid store rejects invalid or omitted field atomically and retains exact near-bound bytes',async t=>{
 const f=fixture(t),raw='999999999998.9999999';configured(f);
 const row={month:'2024-03',...blank,unpaidEnergy:raw,invoiceCost:'000.0100'};
 f.service.inputs.saveUtility('review-site',1,[row]);const before=f.service.inputs.read('review-site');
 for(const invalid of [undefined,'-1','1e3','999999999999.1','0.0000000000000000001']){
  assert.throws(()=>f.service.inputs.saveUtility('review-site',2,[{...row,month:'2024-04'},{...row,unpaidEnergy:invalid}]),{status:400});
  assert.deepEqual(f.service.inputs.read('review-site'),before);
 }
 await f.reopen();assert.deepEqual(f.service.inputs.read('review-site'),before);
 assert.equal(f.db.sqlite.prepare('SELECT typeof(unpaid_energy) t,unpaid_energy FROM monthly_utility').get().t,'text');
 const h=await edit(t,f);assert.equal(h.current.utility['2024-03'].unpaidEnergy,raw);await h.current.save('utility');h.render();await f.reopen();assert.deepEqual(f.service.inputs.read('review-site'),before);
});
