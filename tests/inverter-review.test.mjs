import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './source-module.mjs';

const time=loadSource('app/telemetry-time.ts');
const periods=loadSource('app/issue-periods.ts',[],time);
const recurring=loadSource('app/recurring-issues.ts',[],periods);
const reviewGroups=loadSource('app/review-groups.ts',[],time);
const {inverterReviewCards,replaceInverterSelection}=loadSource('app/inverter-review.ts',[],{...periods,...recurring,...reviewGroups});
const json=value=>JSON.parse(JSON.stringify(value));
const issue=(id,day,equipmentId='inv-2',patch={})=>{
 const timestamp=`2026-06-${String(day).padStart(2,'0')}T12:00:00.000Z`;
 return {id,eventKey:`key-${id}`,equipmentId,equipmentName:equipmentId==='inv-2'?'Inverter 2':'Inverter 10',equipmentType:'inverter',type:'Underperformance',category:'Performance',name:'Underperformance',timezone:'UTC',startDateTime:timestamp,endDateTime:timestamp.replace('12:00','13:00'),estimatedLossKwh:10,intervalMinutes:60,intervalLosses:[{timestamp,intervalMinutes:60,lossKwh:10}],...patch};
};

test('one naturally ordered inverter card retains separate episodes and all its visible individual findings',()=>{
 const originals=[issue('a',1),issue('b',2),issue('c',10),issue('d',11),issue('e',1,'inv-10'),issue('f',2,'inv-10'),issue('fault',6,'inv-2',{type:'Outage',estimatedLossKwh:25}),issue('unknown',7,'inv-2',{type:'Telemetry gap',category:'Data quality',estimatedLossKwh:null,lossUnknown:true})];
 const episodes=recurring.buildRecurringIssues(originals);
 const visible=[...originals].reverse();visible.push(originals[0]);
 const cards=inverterReviewCards([...episodes].reverse(),visible,originals);
 assert.deepEqual(json(cards.map(card=>card.equipmentName)),['Inverter 2','Inverter 10']);
 assert.equal(cards[0].groups.length,2);
 assert.deepEqual(json(cards[0].groups.map(group=>group.firstDay)),['2026-06-01','2026-06-10']);
 assert.deepEqual(json(cards[0].issues.map(item=>item.id)),['a','b','fault','unknown','c','d']);
 assert.equal(cards[0].known,65);assert.equal(cards[0].unknown,1);
 assert.equal(cards[1].known,20);assert.equal(cards[1].unknown,0);
 assert.equal(episodes.length,3);assert.equal(originals[6].recurringId,undefined);
});

test('equal display names do not merge equipment and standalone-only inverters do not create recurring cards',()=>{
 const originals=[issue('a',1,'inv-b',{equipmentName:'Same inverter'}),issue('b',2,'inv-b',{equipmentName:'Same inverter'}),issue('c',1,'inv-a',{equipmentName:'Same inverter'}),issue('d',2,'inv-a',{equipmentName:'Same inverter'}),issue('standalone',20,'inv-c')];
 const cards=inverterReviewCards(recurring.buildRecurringIssues(originals),originals,originals);
 assert.deepEqual(json(cards.map(card=>card.equipmentId)),['inv-a','inv-b']);
 assert.deepEqual(json(cards.map(card=>card.issues.length)),[2,2]);
});

test('reporting filters retain saved episode identity while cards use visible losses and original chronological order',()=>{
 const originals=[issue('z-early',1,'inv-2',{endDateTime:'2026-06-03T13:00:00.000Z'}),issue('a-later',2),issue('c',10),issue('d',11)];
 const episodes=recurring.buildRecurringIssues(originals);
 const visible=[{...originals[1],reportClipped:true,estimatedLossKwh:3,startDateTime:'2026-06-02T12:30:00.000Z'},{...originals[0],reportClipped:true,estimatedLossKwh:2,startDateTime:'2026-06-02T12:30:00.000Z'}];
 const before=json(originals),cards=inverterReviewCards(episodes,visible,originals);
 assert.equal(cards.length,1);assert.equal(cards[0].groups.length,1);
 assert.equal(cards[0].groups[0].firstDay,'2026-06-01');
 assert.equal(cards[0].groups[0].filtered,true);
 assert.deepEqual(json(cards[0].issues.map(item=>item.id)),['z-early','a-later']);
 assert.equal(cards[0].known,5);assert.equal(cards[0].groups[0].visibleLossKwh,5);
 assert.deepEqual(json(originals),before);
 assert.deepEqual(json(inverterReviewCards(episodes,[],originals)),[]);
});

test('group replacement selects only its visible inverter members and preserves other inverter selections',()=>{
 const visible=[issue('old',1),issue('next-a',10),issue('next-b',11),issue('other',1,'inv-10'),issue('unselected-other',2,'inv-10')];
 const selected=['old','other','other','hidden'];
 const result=replaceInverterSelection(selected,visible,'inv-2',['next-a','next-b','next-a','hidden-member','unselected-other']);
 assert.deepEqual(json(result),['other','next-a','next-b']);
 assert.deepEqual(selected,['old','other','other','hidden']);
 assert.deepEqual(json(replaceInverterSelection(result,visible,'inv-2',[])),['other']);
});

test('selection limit checks the final atomic replacement and rejects overflow without changing input',()=>{
 const targets=Array.from({length:500},(_,index)=>issue(`target-${index}`,1));
 const visible=[issue('old',1),issue('other',1,'inv-10'),...targets];
 const selected=['old','other'];
 const exact=replaceInverterSelection(selected,visible,'inv-2',targets.slice(0,499).map(item=>item.id));
 assert.equal(exact.length,500);assert.equal(exact.includes('old'),false);assert.equal(exact.includes('other'),true);
 assert.equal(replaceInverterSelection(selected,visible,'inv-2',targets.map(item=>item.id)),null);
 assert.deepEqual(selected,['old','other']);
 assert.equal(replaceInverterSelection(['old'],visible,'inv-2',targets.map(item=>item.id)).length,500);
});
