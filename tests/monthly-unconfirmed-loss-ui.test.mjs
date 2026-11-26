import {selectedPoa} from './monthly-poa-unit-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadSource} from './source-module.mjs';
import * as domain from '../app/monthly-domain.mjs';

// Real React server rendering of the production editor; only its data hook is
// supplied here. The companion client suite runs the real hook with ReactDOM.
const blank={onPeak:null,offPeak:null,unpaidEnergy:null,revenue:null,energyUsed:null,invoiceCost:null};
const metric=(value,overrides={})=>({value,state:'complete',unconfirmedCount:1,unknownCount:0,reason:null,...overrides});
function snapshot(){
  const configuration={...domain.emptyConfiguration(),operationsStart:'2026-01-01',degradation:'0'};
  const s={siteId:'loss-ui-site',revision:7,configuration,
    utility:{'2026-01':{...blank,onPeak:'12.1250',offPeak:'3.2500',unpaidEnergy:'0.1250',revenue:'-9.5000'}},
    projections:[{month:'2026-01',days:31,operationalDays:31,production:{n:'20',d:'1'},revenue:{n:'-10',d:'1'},insolation:{n:'5',d:'2'}}],
    capacity:{dcKwp:{n:'2',d:'1'},unavailableReason:null},
    telemetry:{poa:selectedPoa(),state:'current',sourceRevision:11,timezone:'America/New_York',selectedChannelId:'irradiance',selectionRequired:false,expectedChannelId:'expected',expectedUnavailableReason:null,candidates:[],months:{}},
    unconfirmedLoss:{state:'current',analysisRunId:'current-publication',timezone:'America/New_York',months:{'2026-01':metric({n:'2469',d:'2'})},reason:null}};
  s.calculated=domain.calculatedRows(s.projections,s.utility,s.telemetry,s.capacity);return s;
}
function render(s,mode='comparison',overrides={}){
  const state={snapshot:s,configuration:s.configuration,utility:s.utility,editing:false,busy:false,refreshing:false,error:'',notice:'',preview:null,...overrides};
  const editor=loadSource('app/MonthlyWorkspace.tsx',[],{React,useState:React.useState,...domain,useMonthly:()=>state,confirmMonthlyNavigation:()=>true});
  return renderToStaticMarkup(React.createElement(editor.MonthlyEditor,{siteId:s.siteId,mode}));
}
const text=html=>html.replace(/<[^>]+>/g,'').replaceAll('&#x27;',"'").replaceAll('&amp;','&');
const rows=html=>[...(html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1]??'').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m=>m[1]);
const cells=row=>[...row.matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/g)].map(m=>m[0]);
const lossCell=row=>{
  const matches=cells(row).filter(cell=>/data-unconfirmed-loss(?:=|\s|>)/.test(cell));
  assert.equal(matches.length,1,'one read-only Unconfirmed estimated loss cell per month');return matches[0];
};
const lossValue=row=>lossCell(row).match(/<span[^>]*>([^<]*)<\/span>/)?.[1];

test('comparison appends a read-only whole-kWh loss column and retains all calculated columns and month/scroll semantics',()=>{
  const s=snapshot(),before=structuredClone(s),html=render(s),body=rows(html);
  assert.match(html,/<th[^>]*scope="col"[^>]*data-unconfirmed-loss/);
  assert.match(html,/Unconfirmed estimated loss \(kWh\)/);
  assert.match(html,/tabindex="0"[^>]*aria-label="Unconfirmed estimated loss \(kWh\)/);
  assert.equal(body.length,1);assert.equal(lossValue(body[0]),'1,235');
  assert.equal(cells(body[0]).at(-1),lossCell(body[0]),'loss is appended, not substituted for an existing metric');
  assert.deepEqual([...body[0].matchAll(/data-calculated-field="([^"]+)"/g)].map(m=>m[1]),domain.calculatedFields);
  assert.equal(text(cells(body[0])[0]),'16','existing exact utility total is unchanged');
  assert.equal(text(cells(body[0])[1]),'20');assert.equal(text(cells(body[0])[3]),'-10');
  assert.match(cells(body[0])[7],/<span>10\.00<\/span>/);
  assert.match(body[0],/<th scope="row">Jan 2026/);
  assert.match(html,/class="table-scroll comparison-scroll" tabindex="0"/);
  assert.doesNotMatch(html,/<(?:input|select|textarea)\b|contenteditable=/i);
  assert.doesNotMatch(html,/>Edit |Save utility data/);
  assert.deepEqual(s,before,'rendering does not round or mutate accepted fractions/inputs');
});

test('loss display distinguishes true zero, unknown partial total, missing coverage and absent month',()=>{
  const s=snapshot();s.projections=Array.from({length:4},(_,i)=>({...s.projections[0],month:`2026-0${i+1}`}));
  s.unconfirmedLoss.months={
    '2026-01':metric({n:'0',d:'1'},{unconfirmedCount:0}),
    '2026-02':metric(null,{state:'partial',unconfirmedCount:3,unknownCount:2,reason:'Two Unconfirmed findings have no retained counted interval loss.'}),
    '2026-03':metric(null,{state:'missing',unconfirmedCount:0,reason:'Outside the saved analysis coverage.'})
  };
  const body=rows(render(s));assert.deepEqual(body.map(lossValue),['0','Unknown','Missing','Missing']);
  const partial=lossCell(body[1]);assert.match(partial,/partial/);assert.match(text(partial),/3 Unconfirmed findings/);assert.match(text(partial),/2 unknown/);
  assert.match(partial,/>Two Unconfirmed findings have no retained counted interval loss\.<\/small>/,'unknown reason is visible text, not only a title');
  assert.match(text(lossCell(body[2])),/Outside the saved analysis coverage/);
  assert.match(text(lossCell(body[3])),/coverage|unavailable|not available/i);
  assert.doesNotMatch(partial,/<span>0<\/span>/);
});

test('exact rational loss values round only at display, including half-kWh boundaries and integers beyond Number precision',()=>{
  // Expected strings independently checked with Python integer/Fraction arithmetic.
  for(const [value,expected] of [
    [{n:'2468999999999999999999',d:'2000000000000000000'},'1,234'],
    [{n:'2469',d:'2'},'1,235'],
    [{n:'9007199254740993',d:'1'},'9,007,199,254,740,993'],
    [{n:'6',d:'5'},'1'],[{n:'0',d:'1'},'0']
  ]){
    const s=snapshot();s.unconfirmedLoss.months['2026-01']=metric(value);const before=structuredClone(value);
    assert.equal(lossValue(rows(render(s))[0]),expected);assert.deepEqual(s.unconfirmedLoss.months['2026-01'].value,before);
  }
});

test('source explanation identifies current publication only, saved timezone and automatic review/publication updates',()=>{
  const html=render(snapshot());
  assert.match(text(html),/current published analysis only/i);
  assert.match(text(html),/effective Unreviewed and Needs review findings/);
  assert.match(text(html),/Updates when saved data is refreshed/i);
  assert.match(text(html),/historical/i);
  assert.match(text(html),/America\/New_York/);
});

for(const [state,label,reason] of [
  ['refreshing','Refreshing','The current publication changed while reading.'],
  ['missing','Missing','No current published analysis is available.'],
  ['unavailable','Unavailable','The current published analysis could not be read.']
])test(`${state} publication never displays retained loss as current and exposes its reason`,()=>{
  const s=snapshot();s.unconfirmedLoss.state=state;s.unconfirmedLoss.reason=reason;
  const html=render(s),body=rows(html),cell=lossCell(body[0]);
  assert.equal(lossValue(body[0]),label);assert.match(text(cell),new RegExp(reason.replaceAll('.','\\.')));
  assert.doesNotMatch(cell,/1,235|1 Unconfirmed finding/,'retained values and counts are not current');
  assert.equal(text(cells(body[0])[0]),'16','unrelated saved utility input remains available');
  assert.match(cells(body[0])[7],/<span>10\.00<\/span>/,'capacity-only calculated value remains available');
});

test('polling and transport failure suppress apparently-current loss until a successful read',()=>{
  for(const [overrides,label,reason] of [
    [{refreshing:true},'Refreshing',/checking|refresh/i],
    [{error:'Synthetic transport failure'},'Unavailable',/freshness|unavailable/i]
  ]){
    const html=render(snapshot(),'comparison',overrides),body=rows(html);
    assert.equal(lossValue(body[0]),label);assert.match(text(lossCell(body[0])),reason);assert.doesNotMatch(lossCell(body[0]),/1,235/);
    assert.equal(text(cells(body[0])[0]),'16');
  }
});

test('partial estimates never expose a numeric known subtotal; null complete values fail closed',()=>{
  const s=snapshot();s.unconfirmedLoss.months['2026-01']=metric({n:'12345',d:'1'},{state:'partial',unconfirmedCount:2,unknownCount:1,reason:null});
  let row=rows(render(s))[0];assert.equal(lossValue(row),'Unknown');assert.match(text(lossCell(row)),/1 unknown/);assert.match(text(lossCell(row)),/unknown|unavailable/i);assert.doesNotMatch(lossCell(row),/12,345/);
  s.unconfirmedLoss.months['2026-01']=metric(null);
  row=rows(render(s))[0];assert.equal(lossValue(row),'Missing');assert.doesNotMatch(lossCell(row),/<span>0<\/span>/);
});

test('loss-only months render without operations, inputs, projections or telemetry, but do not extend utility editing',()=>{
  const s=snapshot();s.configuration=domain.emptyConfiguration();s.utility={};s.projections=[];s.calculated={};
  s.unconfirmedLoss.months={'2025-11':metric({n:'17',d:'2'})};
  const html=render(s),body=rows(html);assert.equal(body.length,1);assert.match(body[0],/<th scope="row">Nov 2025/);assert.equal(lossValue(body[0]),'9');
  assert.equal(text(cells(body[0])[0]),'—');assert.equal(text(cells(body[0])[1]),'—');
  for(const mode of ['utility','baselines','settings']){
    const other=render(s,mode,{editing:true});assert.doesNotMatch(other,/data-unconfirmed-loss|Unconfirmed estimated loss/);
    if(mode==='utility')assert.equal(rows(other).length,0);
  }
});

test('comparison month union is chronological and deduplicated while the utility horizon remains exactly 300 months',()=>{
  const s=snapshot();s.projections=domain.projectionRows(s.configuration);
  s.utility['2024-02']={...blank,onPeak:'0'};
  s.telemetry.months['2025-12']={expected:{value:null,state:'missing'},insolation:{value:null,state:'missing'}};
  s.unconfirmedLoss.months={'2052-03':metric({n:'0',d:'1'}),'2026-01':metric({n:'2469',d:'2'}),'2023-11':metric({n:'8',d:'1'})};
  const before=structuredClone(s),comparison=rows(render(s)),utility=rows(render(s,'utility'));
  assert.equal(comparison.length,304);assert.equal(utility.length,300);
  assert.match(comparison[0],/<th scope="row">Nov 2023/);assert.match(comparison[1],/<th scope="row">Feb 2024/);assert.match(comparison[2],/<th scope="row">Dec 2025/);assert.match(comparison.at(-1),/<th scope="row">Mar 2052/);
  assert.equal(comparison.filter(row=>/<th scope="row">Jan 2026/.test(row)).length,1);
  assert.match(utility[0],/<th scope="row">Jan 2026/);assert.match(utility.at(-1),/<th scope="row">Dec 2050/);
  assert.doesNotMatch(render(s,'utility'),/data-unconfirmed-loss/);assert.deepEqual(s,before);
});

test('an older snapshot with no loss block renders explicit missing, not zero or a crash',()=>{
  const s=snapshot();delete s.unconfirmedLoss;
  const row=rows(render(s))[0];assert.equal(lossValue(row),'Missing');assert.match(text(lossCell(row)),/publication|analysis|unavailable/i);
});
