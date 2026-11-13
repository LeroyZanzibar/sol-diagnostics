import test from 'node:test';
import assert from 'node:assert/strict';
import {modelCapacityBindings} from './source-module.mjs';
const {inverterExpectationModel}=modelCapacityBindings();
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
function assets(){return [
 {id:'meter',type:'revenue_meter',acLineLossPercent:'2',transformerLossPercent:'0'},
 {id:'a',type:'inverter',parentId:'meter',acRatedCapacityKw:'100'},
 {id:'ma',type:'module_group',parentId:'a',moduleRatedCapacityW:'500',quantity:200},
 {id:'b',type:'inverter',parentId:'meter',acRatedCapacityKw:'100'},
 {id:'mb',type:'module_group',parentId:'b',moduleRatedCapacityW:'500',quantity:400},
];}
test('unclipped allocation uses module DC share and restores meter delivery losses at the native cadence',()=>{
 const a=assets();a[0].transformerLossPercent='1';const model=inverterExpectationModel(a);
 assert.equal(model.ready,true);
 for(const hours of [1,1/4,1/12]){
  const result=model.solve(147*.99*hours,hours);assert.equal(result.status,'available');close(result.rate,.5);
  close(model.inverters.get('a').dcKw*result.rate*hours,50*hours);
  close(model.inverters.get('b').dcKw*result.rate*hours,100*hours);
 }
});
test('inverse allocation reconciles a mixed DC/AC fleet after one inverter clips',()=>{
 const a=assets(),model=inverterExpectationModel(a),r=model.solve(171.5,1);
 close(r.rate,.75);
 const inv=[...model.inverters.values()];
 close(inv.reduce((s,i)=>s+Math.min(i.acKw,i.dcKw*r.rate),0)*model.deliveryFactor,171.5);
 close(Math.min(inv[0].acKw,inv[0].dcKw*r.rate),75);
 close(Math.min(inv[1].acKw,inv[1].dcKw*r.rate),100);
 assert.ok(r.rate<inv[0].referenceYieldLimit);assert.ok(r.rate>=inv[1].referenceYieldLimit);
});
test('independent transformer branches and manual overdrive ceilings constrain allocation',()=>{
 const a=assets();a[0].acLineLossPercent='0';
 a.push({id:'txa',type:'transformer',parentId:'meter',nameplateKva:'40'},
  {id:'txb',type:'transformer',parentId:'meter',nameplateKva:'100'});
 a[1].parentId='txa';a[3].parentId='txb';
 let model=inverterExpectationModel(a),r=model.solve(120,1);
 close(r.rate,.4);close(Math.min(40,100*r.rate)+Math.min(100,200*r.rate),120);
 assert.ok(r.rate>=model.inverters.get('a').referenceYieldLimit);
 assert.ok(r.rate<model.inverters.get('b').referenceYieldLimit);
 assert.equal(model.solve(141,1).status,'capacityConflict');
 a.find(x=>x.id==='txa').pvCeilingOverrideEnabled=true;a.find(x=>x.id==='txa').pvCeilingOverrideKw='60';
 model=inverterExpectationModel(a);r=model.solve(145,1);close(r.rate,.48333333333333334);
 close(Math.min(60,100*r.rate)+Math.min(100,200*r.rate),145);
});
test('invalid, incomplete, missing and impossible expectations remain explicit and never mutate the source',()=>{
 const a=assets(),before=JSON.stringify(a),m=inverterExpectationModel(a);
 assert.equal(m.solve(undefined,1).status,'missing');assert.equal(m.solve(NaN,1).status,'invalid');
 assert.equal(m.solve(-1,1).status,'invalid');assert.equal(m.solve(197,1).status,'capacityConflict');
 assert.equal(m.solve(196,1).status,'available');assert.equal(m.solve(0,1).status,'available');
 assert.equal(JSON.stringify(a),before);
 for(const change of [a=>a[0].acLineLossPercent='100',a=>a[2].quantity=0,a=>a[2].quantity=2.5,a=>a[3].acRatedCapacityKw='',a=>a.push({id:'bad',type:'inverter'})]){
  const b=assets();change(b);const invalid=inverterExpectationModel(b);assert.equal(invalid.ready,false);assert.equal(invalid.solve(100,1).status,'modelIncomplete');
 }
});
