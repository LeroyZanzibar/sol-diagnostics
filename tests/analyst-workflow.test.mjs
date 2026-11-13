import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {loadSource} from './source-module.mjs';
const review=loadSource('app/issue-review.ts');
const basis={calculationVersion:25,modelRevision:'model-a'};
const original={id:'event',eventKey:'event-key',equipmentId:'inverter',type:'Underperformance',category:'Performance',name:'Inverter underperformance',confidence:'model-based',startDateTime:'2026-01-01T16:00:00.000Z',endDateTime:'2026-01-01T18:00:00.000Z',estimatedLossKwh:20,actualEnergyKwh:180,expectedEnergyKwh:200,evidenceSignature:'old',intervalMinutes:60,evidence:{rule:'derived_inverter_expectation_v1'},intervalLosses:[{timestamp:'2026-01-01T16:00:00.000Z',lossKwh:10,countedLossKwh:10,actualKwh:90,expectedKwh:100},{timestamp:'2026-01-01T17:00:00.000Z',lossKwh:10,countedLossKwh:10,actualKwh:90,expectedKwh:100}]};
function scaled(factor){return {...original,evidenceSignature:'new',estimatedLossKwh:20*factor,actualEnergyKwh:180*factor,expectedEnergyKwh:200*factor,intervalLosses:original.intervalLosses.map(p=>({...p,lossKwh:p.lossKwh*factor,countedLossKwh:p.countedLossKwh*factor,actualKwh:p.actualKwh*factor,expectedKwh:p.expectedKwh*factor}))};}
const decide=(before,after,oldBasis=basis,newBasis=basis)=>review.assessReviewEvidence(before,after,oldBasis,newBasis);
const saved=(issue,status='Dismissed')=>({eventKey:issue.eventKey,version:1,state:{...review.blankReview(issue,issue.evidenceSignature),status,dismissalReason:status==='Dismissed'?'Source data is incorrect':''},updatedAt:'2026-10-24',runId:'old-run'});
const strip=issue=>{const {intervalLosses,evidence,...result}=issue;return result};
const payload=(issues,compact=false)=>({reviewCalculationBasis:basis,analysis:{analysisIntervalMinutes:60,issues:compact?issues.map(strip):issues}});

test('small changes retain decisions without mutating or advancing the reviewed evidence',()=>{
 const before=structuredClone(original),after=scaled(1.0005),result=decide(before,after);
 assert.equal(result.needsReview,false);assert.equal(result.retained,true);assert.equal(result.evidenceChanged,true);
 assert.deepEqual(before,original);
 assert.equal(decide(original,scaled(1.02)).needsReview,true);
 // Many tolerated incremental recalculations are still compared to the original.
 assert.equal(decide(scaled(1.02),scaled(1.0205)).needsReview,false);
 assert.equal(decide(original,scaled(1.0205)).needsReview,true);
});
test('boundaries, calculation version, model, cause, availability and zero transitions always require reassessment',()=>{
 for(const change of [
  {endDateTime:'2026-01-01T19:00:00.000Z'}, {startDateTime:'2026-01-01T15:00:00.000Z'},
  {suspectedCause:'Snow'}, {productionUnknown:true}, {confidence:'confirmed'},
  {affectedEquipment:[{id:'other-inverter'}]},
 ])assert.equal(decide(original,{...original,...change}).needsReview,true,JSON.stringify(change));
 assert.equal(decide(original,original,basis,{...basis,calculationVersion:26}).needsReview,true);
 assert.equal(decide(original,original,basis,{...basis,modelRevision:'model-b'}).needsReview,true);
 const outage={...original,actualEnergyKwh:0,intervalLosses:original.intervalLosses.map(p=>({...p,actualKwh:0}))};
 assert.equal(decide(outage,{...outage,evidenceSignature:'new',actualEnergyKwh:.001}).needsReview,true);
});
test('changed coverage, cadence, loss basis, missing readings and redistributions cannot pass as a small total change',()=>{
 const small=scaled(1.0005);
 for(const after of [
  {...small,intervalLosses:small.intervalLosses.slice(1)},
  {...small,intervalMinutes:30},
  {...small,evidence:{rule:'historical_fallback'}},
  {...small,intervalLosses:small.intervalLosses.map((p,i)=>({...p,actualKwh:i?null:p.actualKwh}))},
  {...small,intervalLosses:[small.intervalLosses[0],small.intervalLosses[0]]},
  {...small,intervalLosses:small.intervalLosses.map((p,i)=>({...p,lossKwh:i?5:15}))},
 ])assert.equal(decide(original,after).needsReview,true);
 const huge={...original,estimatedLossKwh:2000,actualEnergyKwh:18000,expectedEnergyKwh:20000,intervalLosses:original.intervalLosses.map(p=>({...p,lossKwh:1000,countedLossKwh:1000,actualKwh:9000,expectedKwh:10000}))};
 const offset={...huge,evidenceSignature:'changed',intervalLosses:huge.intervalLosses.map((p,i)=>({...p,lossKwh:p.lossKwh+(i?-.6:.6),countedLossKwh:p.countedLossKwh+(i?-.6:.6)}))};
 assert.equal(decide(huge,offset).needsReview,true); // zero net change, 1.2 kWh absolute movement
});
test('default reports exclude effective dismissals while resolved losses and provisional findings remain counted',()=>{
 const issues=['dismissed','resolved','new','changed','unknown'].map((eventKey,i)=>({...original,eventKey,estimatedLossKwh:i===4?null:10*(i+1)}));
 const reviews={dismissed:{...saved(issues[0]),needsReview:false},resolved:{...saved(issues[1],'Confirmed'),needsReview:false},changed:{...saved(issues[3]),needsReview:true}};
 reviews.resolved.state.resolution='Resolved';
 const included=issues.filter(i=>review.matchesReviewFilter(i,reviews[i.eventKey],'Exclude dismissed'));
 assert.deepEqual(included.map(i=>i.eventKey),['resolved','new','changed','unknown']);
 assert.deepEqual(JSON.parse(JSON.stringify(review.reviewLossSummary(issues,reviews))),{detected:100,dismissed:10,adjusted:90,provisional:70});
 assert.equal(issues.filter(i=>review.matchesReviewFilter(i,reviews[i.eventKey],'All findings')).length,5);
 assert.equal(review.effectiveReviewStatus(issues[3],reviews.changed),'Needs review');
});
test('review assessments share retained analysis reads across changed findings and leave review versions untouched',async()=>{
 const old=Array.from({length:120},(_,i)=>({...original,eventKey:`event-${i}`,id:`event-${i}`}));
 const current=old.map(i=>({...scaled(1.0005),eventKey:i.eventKey,id:i.id}));
 const calls=[];
 const savedAnalysis=async(site,run,compact=false)=>{calls.push([site,run,compact]);return payload(run==='old-run'?old:current,compact)};
 const service=loadSource('app/api/issue-reviews/service.ts',[],{...review,savedAnalysis});
 const records=old.map(i=>saved(i));
 const assessed=await service.assessReviews('site','new-run',payload(current,true),records);
 assert.equal(assessed.length,120);assert.ok(assessed.every(r=>!r.needsReview&&r.assessment.retained&&r.version===1));
 assert.deepEqual(calls,[['site','old-run',true],['site','new-run',false],['site','old-run',false]]);
 assert.ok(records.every(r=>r.state.evidenceSignature==='old'&&!r.assessment));
});
test('unchanged reruns use the compact index and current-run reviews need no extra retained reads',async()=>{
 let calls=0;
 const service=loadSource('app/api/issue-reviews/service.ts',[],{...review,savedAnalysis:async()=>{calls++;return payload([original],true)}});
 const same=await service.assessReviews('site','old-run',payload([original],true),[saved(original)]);
 assert.equal(calls,0);assert.equal(same[0].needsReview,false);
 const rerun=await service.assessReviews('site','new-run',payload([original],true),[saved(original)]);
 assert.equal(calls,1);assert.equal(rerun[0].needsReview,false);
});
test('missing prior evidence conservatively reopens a decision without deleting the saved reason',async()=>{
 const service=loadSource('app/api/issue-reviews/service.ts',[],{...review,savedAnalysis:async()=>{throw new Error('unavailable')}});
 const [result]=await service.assessReviews('site','new-run',payload([scaled(1.0005)],true),[saved(original)]);
 assert.equal(result.needsReview,true);assert.equal(result.state.status,'Dismissed');assert.equal(result.state.dismissalReason,'Source data is incorrect');
});
test('preset dismissal and resolution reasons satisfy validation without typing and require valid evidence',()=>{
 const state=saved(original).state;
 assert.doesNotThrow(()=>review.validateReview(state,''));
 assert.throws(()=>review.validateReview({...state,dismissalReason:''},''),/Explain why/);
 assert.throws(()=>review.validateReview({...state,dismissalReason:42},''),/valid dismissal/);
 assert.doesNotThrow(()=>review.validateReview({...state,status:'Confirmed',resolution:'Resolved',resolvedAt:original.endDateTime,resolutionNote:'Production recovery verified'},''));
});
test('XLSX records effective decisions, retained numerical changes, audit mode and period loss treatment',()=>{
 const report=loadSource('app/report-methodology.ts',[],{...review,XLSX}),book=XLSX.utils.book_new(),issue=scaled(1.0005);
 const r={...saved(original),needsReview:false,assessment:decide(original,issue)};
 report.appendReportMethodology(book,{reviewFilter:'All findings',reviews:{[issue.eventKey]:r},reviewRetrievedAt:'now',reviewTotals:{detected:20.01,dismissed:20.01,adjusted:0,provisional:0},issues:[issue]});
 const reopened=XLSX.read(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));
 const [row]=XLSX.utils.sheet_to_json(reopened.Sheets['Analyst reviews']);
 assert.equal(row.status,'Dismissed');assert.equal(row.decisionRetained,true);assert.equal(row.dismissalReason,'Source data is incorrect');assert.equal(row.reviewVersion,1);
 const method=XLSX.utils.sheet_to_json(reopened.Sheets.Methodology,{header:1});
 assert.ok(method.some(r=>r[0]==='Analyst review filter'&&r[1]==='All findings'));
 assert.ok(method.some(r=>r[0]==='Reporting period adjusted loss (kWh, before table filters)'&&r[1]===0));
 assert.ok(method.some(r=>r[0]==='Repeat review policy'&&r[1].includes('last human-reviewed')));
});
test('a zero-loss summary exports an empty main table and a separate dismissed-findings audit sheet',()=>{
 const methodology=loadSource('app/report-methodology.ts',[],{...review,XLSX});let captured;
 const component=loadSource('app/IssueSummaries.tsx',[],{...methodology,
  useState:initial=>[initial,()=>{}],useMemo:fn=>fn(),React:{createElement:(type,props,...children)=>({type,props,children})},
  XLSX:{...XLSX,writeFile:book=>{captured=book;}},
 });
 const context={reviewFilter:'Exclude dismissed',reviews:{[original.eventKey]:{...saved(original),needsReview:false}},reviewRetrievedAt:'now',reviewTotals:{detected:20,dismissed:20,adjusted:0,provisional:0},excludedIssues:[original],issues:[]};
 const tree=component.default({issues:[],siteName:'Synthetic review QA',onBack:()=>{},reportContext:context});
 const find=node=>{if(!node||typeof node!=='object')return null;if(node.type==='button'&&node.children.includes('Export XLSX '))return node;return node.children?.flat(Infinity).map(find).find(Boolean);};
 const button=find(tree);assert.ok(button);assert.equal(button.props.disabled,false);button.props.onClick();
 assert.ok(captured);assert.equal(XLSX.utils.sheet_to_json(captured.Sheets.Summaries).length,0);
 const [dismissed]=XLSX.utils.sheet_to_json(captured.Sheets['Dismissed findings']);assert.equal(dismissed.excludedLossKwh,20);assert.equal(dismissed.dismissalReason,'Source data is incorrect');
});
test('save and next follows the filtered order, skips completed decisions and wraps without repeating the saved issue',()=>{
 const issues=['a','b','c','d'].map(id=>({...original,id,eventKey:id}));
 const reviews={b:{...saved(issues[1],'Confirmed'),needsReview:false},c:{...saved(issues[2]),needsReview:false}};
 assert.equal(review.nextReviewFinding(issues,'a',reviews).id,'d');
 assert.equal(review.nextReviewFinding(issues,'d',reviews).id,'a');
 assert.equal(review.nextReviewFinding(issues.filter(i=>i.id!=='d'),'a',reviews),undefined);
 reviews.b.needsReview=true;assert.equal(review.nextReviewFinding(issues,'a',reviews).id,'b');
 assert.equal(review.nextReviewFinding([issues[0]],'a',{}),undefined);
});
