import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {loadSource} from './source-module.mjs';

const visibility=loadSource('app/issue-visibility.ts');
const review=loadSource('app/issue-review.ts');
const reports=loadSource('app/report-methodology.ts',[],{...visibility,...review,XLSX});
const finding=(id,type='Underperformance',equipmentType='inverter',loss=10)=>({id,eventKey:`key-${id}`,evidenceSignature:`sig-${id}`,name:id,type,equipmentType,estimatedLossKwh:loss});
const episode=(id,members)=>({id,eventKey:`key-${id}`,evidenceSignature:`sig-${id}`,isRecurring:true,type:'Underperformance',category:'Performance',equipmentType:'inverter',equipmentName:'Inverter 1',firstDay:'2026-06-01',lastDay:'2026-06-04',sequenceStatus:'Awaiting 5-day window',activeMinutes:120,estimatedLossKwh:members.reduce((sum,i)=>sum+(i.estimatedLossKwh||0),0),members:members.map(i=>({id:i.id,eventKey:i.eventKey,evidenceSignature:i.evidenceSignature}))});
const context=(patch={})=>({reviewFilter:'Exclude dismissed',reviews:{},reviewRetrievedAt:'2026-10-27T12:00:00Z',issues:[],...patch});
function exported(input){const book=XLSX.utils.book_new();reports.appendReportMethodology(book,input);return XLSX.read(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));}
const rows=(book,name)=>book.Sheets[name]?XLSX.utils.sheet_to_json(book.Sheets[name]):[];
const methodology=book=>new Map(XLSX.utils.sheet_to_json(book.Sheets.Methodology,{header:1}).slice(1));

test('visibility-aware exports omit hidden findings from review, dismissed and recurring sheets without changing source losses',()=>{
 const hidden=finding('hidden-inverter'),meter=finding('visible-site','Underperformance','revenue_meter',30),offline=finding('offline','Equipment outage','inverter',20);
 const prefs={...visibility.defaultIssueVisibility,inverterUnderperformance:false};
 const input=context({issueVisibility:prefs,visibilityHidden:{count:2,knownLossKwh:10,unknownLossCount:1},issues:[hidden,meter],excludedIssues:[hidden,offline],recurringIssues:[episode('episode',[hidden])],reviewTotals:{detected:50,dismissed:20,adjusted:30,provisional:30}});
 const before=JSON.stringify(input),book=exported(input),m=methodology(book);
 assert.deepEqual(rows(book,'Analyst reviews').map(row=>row.issueId),['visible-site']);
 assert.deepEqual(rows(book,'Dismissed findings').map(row=>row.issueId),['offline']);
 assert.equal(book.Sheets['Recurring issues'],undefined);assert.equal(book.Sheets['Recurring occurrences'],undefined);
 assert.equal(JSON.parse(m.get('Issue visibility settings')).inverterUnderperformance,false);
 assert.match(m.get('Hidden issue types'),/inverter underperformance/i);
 assert.equal(m.get('Findings hidden by issue visibility'),2);assert.equal(m.get('Known loss hidden by issue visibility (kWh)'),10);assert.equal(m.get('Unknown-loss findings hidden by issue visibility'),1);
 assert.match(m.get('Hidden findings summary scope'),/analyst review filter, before table filters/);
 assert.match(m.get('Issue visibility treatment'),/not dismissed or resolved/);
 assert.equal(m.get('Reporting period adjusted loss (kWh, before table filters)'),30);
 assert.equal(JSON.stringify(input),before);
});

test('recurring export membership follows the displayed findings while full episode totals stay context-only',()=>{
 const shown=finding('shown'),outside=finding('outside'),other=finding('other');
 const input=context({issueVisibility:visibility.defaultIssueVisibility,issues:[shown],recurringIssues:[episode('included',[shown,outside]),episode('not-in-report',[other])]});
 const book=exported(input),groups=rows(book,'Recurring issues');
 assert.equal(groups.length,1);assert.equal(groups[0].recurringId,'included');assert.equal(groups[0].occurrenceCount,2);assert.equal(groups[0].exportedOccurrenceCount,1);assert.equal(groups[0].fullEpisodeLossKwh,20);assert.match(groups[0].scope,/context only/);
 assert.deepEqual(rows(book,'Recurring occurrences').map(row=>row.issueId),['shown']);
 assert.deepEqual(rows(book,'Analyst reviews').map(row=>row.issueId),['shown']);
});

test('all hidden known types export no known findings and keep future issue types visible',()=>{
 const prefs=Object.fromEntries(visibility.issueVisibilityOptions.map(option=>[option.key,false]));
 const known=finding('known'),future=finding('future','New detector type','inverter',null);
 const book=exported(context({issueVisibility:prefs,issues:[known,future],excludedIssues:[known],recurringIssues:[episode('episode',[known])]}));
 assert.deepEqual(rows(book,'Analyst reviews').map(row=>row.issueId),['future']);assert.equal(book.Sheets['Dismissed findings'],undefined);assert.equal(book.Sheets['Recurring issues'],undefined);
 assert.equal(methodology(book).get('Enabled issue types'),'None');
});

test('legacy export contexts keep original full episode membership and need no visibility metadata',()=>{
 const shown=finding('shown'),outside=finding('outside');
 const book=exported(context({issues:[shown],recurringIssues:[episode('included',[shown,outside])]}));
 assert.deepEqual(rows(book,'Recurring occurrences').map(row=>row.issueId),['shown','outside']);
 assert.equal(methodology(book).has('Issue visibility settings'),false);
});
