import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {loadSource} from './source-module.mjs';

const visibility=loadSource('app/issue-visibility.ts');
const review=loadSource('app/issue-review.ts');
const reports=loadSource('app/report-methodology.ts',[],{...visibility,...review,XLSX});
const finding=(id,type='Equipment outage',equipmentType='inverter',loss=10)=>({id,eventKey:`key-${id}`,evidenceSignature:`sig-${id}`,name:id,type,equipmentType,estimatedLossKwh:loss});
const episode=(id,members)=>({id,eventKey:`key-${id}`,evidenceSignature:`sig-${id}`,isRecurring:true,type:'Underperformance',category:'Performance',equipmentType:'inverter',equipmentName:'Inverter 1',firstDay:'2026-06-01',lastDay:'2026-06-04',sequenceStatus:'Awaiting 5-day window',activeMinutes:120,estimatedLossKwh:members.reduce((sum,i)=>sum+(i.estimatedLossKwh||0),0),members:members.map(i=>({id:i.id,eventKey:i.eventKey,evidenceSignature:i.evidenceSignature}))});
const context=(patch={})=>({reviewFilter:'Exclude dismissed',reviews:{},reviewRetrievedAt:'2026-10-27T12:00:00Z',issues:[],...patch});
function exported(input){const book=XLSX.utils.book_new();reports.appendReportMethodology(book,input);return XLSX.read(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));}
const rows=(book,name)=>book.Sheets[name]?XLSX.utils.sheet_to_json(book.Sheets[name]):[];
const methodology=book=>new Map(XLSX.utils.sheet_to_json(book.Sheets.Methodology,{header:1}).slice(1));

test('visibility-aware exports omit hidden and retired findings without changing source losses',()=>{
 const hidden=finding('hidden-gap','Data gap'),meter=finding('visible-site','Site outage','revenue_meter',30),offline=finding('offline','Equipment outage','inverter',20),retired=finding('retired','Underperformance');
 const prefs={...visibility.defaultIssueVisibility,dataGap:false,inverterUnderperformance:true};
 const input=context({issueVisibility:prefs,visibilityHidden:{count:2,knownLossKwh:10,unknownLossCount:1},issues:[hidden,meter,retired],excludedIssues:[hidden,offline,retired],recurringIssues:[episode('episode',[retired])],reviewTotals:{detected:50,dismissed:20,adjusted:30,provisional:30}});
 const before=JSON.stringify(input),book=exported(input),m=methodology(book);
 assert.deepEqual(rows(book,'Analyst reviews').map(row=>row.issueId),['visible-site']);
 assert.deepEqual(rows(book,'Dismissed findings').map(row=>row.issueId),['offline']);
 assert.equal(book.Sheets['Recurring issues'],undefined);assert.equal(book.Sheets['Recurring occurrences'],undefined);
 assert.equal(JSON.parse(m.get('Issue visibility settings')).dataGap,false);assert.equal(JSON.parse(m.get('Issue visibility settings')).inverterUnderperformance,undefined);
 assert.match(m.get('Hidden issue types'),/data gaps/i);assert.doesNotMatch(m.get('Hidden issue types'),/underperformance/i);
 assert.equal(m.get('Findings hidden by issue visibility'),2);assert.equal(m.get('Known loss hidden by issue visibility (kWh)'),10);assert.equal(m.get('Unknown-loss findings hidden by issue visibility'),1);
 assert.match(m.get('Hidden findings summary scope'),/analyst review filter, before table filters/);
 assert.match(m.get('Issue visibility treatment'),/not dismissed or resolved/);
 assert.equal(m.get('Reporting period adjusted loss (kWh, before table filters)'),30);
 assert.equal(JSON.stringify(input),before);
});

test('saved recurring contexts produce no episode or occurrence exports; ordinary findings remain',()=>{
 const shown=finding('shown'),outside=finding('outside'),other=finding('other');
 const input=context({issueVisibility:visibility.defaultIssueVisibility,issues:[shown],recurringIssues:[episode('included',[shown,outside]),episode('not-in-report',[other])]});
 const before=JSON.stringify(input),book=exported(input);
 assert.equal(book.Sheets['Recurring issues'],undefined);assert.equal(book.Sheets['Recurring occurrences'],undefined);
 assert.deepEqual(rows(book,'Analyst reviews').map(row=>row.issueId),['shown']);assert.equal(JSON.stringify(input),before);
});

test('all hidden known types export no known findings and keep future issue types visible',()=>{
 const prefs=Object.fromEntries(visibility.issueVisibilityOptions.map(option=>[option.key,false]));
 const known=finding('known'),future=finding('future','New detector type','inverter',null),retired=finding('legacy','Underperformance');
 const book=exported(context({issueVisibility:prefs,issues:[known,future,retired],excludedIssues:[known,retired],recurringIssues:[episode('episode',[known])]}));
 assert.deepEqual(rows(book,'Analyst reviews').map(row=>row.issueId),['future']);assert.equal(book.Sheets['Dismissed findings'],undefined);assert.equal(book.Sheets['Recurring issues'],undefined);
 assert.equal(methodology(book).get('Enabled issue types'),'None');
});

test('legacy callers without visibility metadata still exclude all retired membership',()=>{
 const shown=finding('shown'),retired=finding('legacy','Underperformance'),site=finding('legacy-site','Underperformance','revenue_meter');
 const book=exported(context({issues:[shown,retired,site],excludedIssues:[retired,site],recurringIssues:[episode('included',[retired,site])]}));
 assert.equal(book.Sheets['Recurring issues'],undefined);assert.equal(book.Sheets['Recurring occurrences'],undefined);assert.equal(book.Sheets['Dismissed findings'],undefined);
 assert.deepEqual(rows(book,'Analyst reviews').map(row=>row.issueId),['shown']);assert.equal(methodology(book).has('Issue visibility settings'),false);
});
