import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadSource} from './source-module.mjs';

const time=loadSource('app/telemetry-time.ts');
const periods=loadSource('app/issue-periods.ts',[],time);
const recurring=loadSource('app/recurring-issues.ts',[],{...time,...periods});
const axis=loadSource('app/timeline-axis.ts',[],{...time,...periods});
const dates=loadSource('app/issue-date-format.ts',[],time);
const issue=(id,overrides={})=>({id,name:'Underperformance',equipmentId:'inv-1',equipmentName:'Inverter 1',category:'Performance',severity:'medium',timezone:'UTC',startDateTime:'2026-06-01T08:00:00Z',endDateTime:'2026-06-01T09:00:00Z',estimatedLossKwh:10,...overrides});
function render(issues,{expanded=false,category='',severity='',sort='asc',episodes=[]}={}) {
  let stateIndex=0;
  const states=[true,category,severity,sort,null,{has:()=>expanded}];
  const {default:Timeline}=loadSource('app/IssueTimeline.tsx',[],{
    React,Fragment:React.Fragment,useMemo:fn=>fn(),useState:()=>[states[stateIndex++],()=>{}],
    ...time,...periods,...recurring,...axis,...dates,
    useTimelineMaintenance:()=>({days:[],timezone:'UTC',loading:false,error:null}),
    TimelineMaintenance:()=>null,
  });
  return renderToStaticMarkup(React.createElement(Timeline,{issues,episodes,siteId:'test',siteName:'Test site',sites:[],onSiteChange:()=>{},onBack:()=>{}}));
}
const rowCount=html=>(html.match(/class="timeline-issue-label timeline-parent-label"/g)||[]).length;
const barCount=html=>(html.match(/class="timeline-bar /g)||[]).length;

test('same issue and equipment share a row with separate bars and expandable occurrences',()=>{
  const issues=[issue('first'),issue('second',{startDateTime:'2026-06-20T08:00:00Z',endDateTime:'2026-06-20T09:00:00Z'})];
  const before=JSON.stringify(issues),html=render(issues);
  assert.equal(rowCount(html),1);
  assert.equal(barCount(html),2);
  assert.match(html,/Inverter 1 · 2 occurrences/);
  assert.match(html,/aria-expanded="false"/);
  const expanded=render(issues,{expanded:true});
  assert.match(expanded,/Occurrence 1/);
  assert.match(expanded,/Occurrence 2/);
  assert.equal(barCount(expanded),4);
  assert.equal(JSON.stringify(issues),before);
});

test('episode IDs do not split a row or change the issue label',()=>{
  const active={intervalLosses:[{timestamp:'2026-06-01T08:00:00Z',intervalMinutes:60,lossKwh:10}]};
  const html=render([issue('a',{recurringId:'episode-a',...active}),issue('b',{recurringId:'episode-b',...active}),issue('c')],{episodes:[{id:'episode-a',name:'Recurring underperformance',firstDay:'2026-06-01',lastDay:'2026-06-02'}]});
  assert.equal(rowCount(html),1);
  assert.match(html,/<strong>Underperformance<\/strong>/);
  assert.match(html,/3 occurrences/);
});

test('different equipment IDs stay separate even when equipment names match',()=>{
  assert.equal(rowCount(render([issue('a'),issue('b',{equipmentId:'inv-2'})])),2);
  assert.equal(rowCount(render([issue('a'),issue('b',{name:'Offline'})])),2);
});

test('equipment identity, not its display name, determines grouping; tuple keys cannot collide',()=>{
  assert.equal(rowCount(render([issue('a'),issue('b',{equipmentName:'Renamed inverter'})])),1);
  assert.equal(rowCount(render([issue('a',{equipmentId:'a|b',name:'c'}),issue('b',{equipmentId:'a',name:'b|c'})])),2);
});

test('filters apply before grouping and issue sorting still works',()=>{
  const issues=[issue('a'),issue('b',{severity:'high'}),issue('c',{name:'Offline',category:'Communications'})];
  const filtered=render(issues,{severity:'high'});
  assert.equal(rowCount(filtered),1);
  assert.match(filtered,/1 occurrence/);
  assert.equal(rowCount(render(issues,{category:'Performance'})),1);
  const asc=render(issues),desc=render(issues,{sort:'desc'});
  assert.ok(asc.indexOf('<strong>Offline</strong>')<asc.indexOf('<strong>Underperformance</strong>'));
  assert.ok(desc.indexOf('<strong>Offline</strong>')>desc.indexOf('<strong>Underperformance</strong>'));
  assert.equal(rowCount(render([])),0);
});

test('overlap merges preserve severity and losses while recurring inactive gaps stay empty',()=>{
  const html=render([issue('a'),issue('b',{severity:'critical',estimatedLossKwh:20})]);
  assert.equal(rowCount(html),1);
  assert.equal(barCount(html),1);
  assert.match(html,/timeline-bar performance critical/);
  assert.match(html,/Source occurrence total: 30 kWh/);
  const sparse=render([issue('sparse',{recurringId:'episode',endDateTime:'2026-06-01T12:00:00Z',intervalLosses:[{timestamp:'2026-06-01T08:00:00Z',intervalMinutes:60,lossKwh:5},{timestamp:'2026-06-01T11:00:00Z',intervalMinutes:60,lossKwh:5}]})]);
  assert.equal(barCount(sparse),2);
  assert.match(render([issue('unknown',{estimatedLossKwh:null}),issue('known')]),/Unknown loss/);
});
