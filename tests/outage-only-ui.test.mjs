import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,home,nodes,button,html,finding,performance,visibility,method,groups,review,noop,XLSX,loadSource,time,periods} from './outage-only-ui-harness.mjs';

const json=value=>JSON.parse(JSON.stringify(value));
test('retired visibility keys normalize away while unknown future findings fail open',()=>{
 const keys=visibility.issueVisibilityOptions.map(o=>o.key);
 assert.equal(keys.includes('siteUnderperformance'),false);assert.equal(keys.includes('inverterUnderperformance'),false);
 const prefs=visibility.normalizeIssueVisibility({siteUnderperformance:true,inverterUnderperformance:false,equipmentOutage:false});
 assert.equal(prefs.equipmentOutage,false);assert.equal('inverterUnderperformance' in prefs,false);
 for(const equipmentType of ['inverter','revenue_meter','future'])assert.equal(visibility.isIssueVisible({type:'Underperformance',equipmentType},prefs),false);
 assert.equal(visibility.isIssueVisible({type:'Future supported detector'},prefs),true);
 assert.equal(visibility.issueVisibilityInputError({siteUnderperformance:true,inverterUnderperformance:false,equipmentOutage:false}),null);
});

test('visibility settings renders only retained switches and saves no legacy keys',async()=>{
 const saved=[],value={...visibility.defaultIssueVisibility,siteUnderperformance:true,inverterUnderperformance:false};
 const h=harness('app/IssueVisibilitySettings.tsx'),props={value,ready:true,error:'',onRetry:noop,onBack:noop,onSave:async v=>saved.push(v)};
 let tree=h.render(props);assert.doesNotMatch(html(tree),/underperformance/i);
 const control=nodes(tree).find(n=>n.props?.['aria-labelledby']==='visibility-equipmentOutage');control.props.onClick();
 tree=h.render(props);await nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault:noop});
 assert.equal(saved.length,1);assert.equal(saved[0].equipmentOutage,false);assert.equal('siteUnderperformance' in saved[0],false);assert.equal('inverterUnderperformance' in saved[0],false);
});

test('Findings, Summaries, Timeline and real exports exclude legacy underperformance with no recurrence preparation',()=>{
 const issues=[finding('outage'),finding('unknown',{type:'Equipment telemetry issue',category:'Data quality',estimatedLossKwh:null,lossUnknown:true}),finding('legacy-inverter',{type:'Underperformance'}),finding('legacy-site',{type:'Underperformance',equipmentType:'revenue_meter'}),finding('future',{type:'Future detector'})];
 const data=performance('run',issues);data.methodology.calculationVersion=28;data.analysis.baselineMethod='OLD LONG HISTORICAL PEER AND RECURRENCE METHOD '.repeat(60);data.analysis.recurringIssues=[{id:'recurring',type:'Underperformance',members:[issues[2]]}];
 let recurrenceCalls=0;const trap=()=>{recurrenceCalls++;throw new Error('Retired recurrence computation called');};
 const h=home({performance:data},{recurringTableRows:trap,recurringAggregate:trap,replaceInverterSelection:trap});const before=JSON.stringify(data);
 let tree=h.render(),markup=html(tree);assert.equal(recurrenceCalls,0);assert.doesNotMatch(markup,/Finding legacy|OLD LONG|Recurring inverter underperformance/);assert.match(markup,/Legacy analysis/);assert.match(markup,/not recalculated/i);
 const work=nodes(tree).find(n=>n.props?.visible&&n.props?.originals);assert.deepEqual(json(work.props.visible.map(i=>i.id)),['outage','future','unknown']);assert.equal(work.props.episodes,undefined);assert.equal(work.props.onReplace,undefined);
 const select=nodes(tree).find(n=>n.props?.['aria-label']==='Select all findings on this page');select.props.onChange({target:{checked:true}});assert.deepEqual(json(h.state.selectedFindings),['outage','future','unknown']);
 button(tree,'Export XLSX').props.onClick();const book=h.getBook();assert.equal(XLSX.utils.sheet_to_json(book.Sheets.Findings).length,3);assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets['Analyst reviews']).map(i=>i.issueId),['outage','future','unknown']);assert.equal(book.Sheets['Recurring issues'],undefined);assert.equal(book.Sheets['Recurring occurrences'],undefined);
 h.state.view='summaries';const summaryProps=nodes(h.render()).find(n=>n.props?.reportContext).props;assert.deepEqual(json(summaryProps.issues.map(i=>i.id)),['outage','unknown','future']);
 let summaryBook;const summary=harness('app/IssueSummaries.tsx',{}, {XLSX:{...XLSX,writeFile:book=>{summaryBook=book;}}});const summaryTree=summary.render(summaryProps);assert.doesNotMatch(html(summaryTree),/Finding legacy/);assert.equal((html(summaryTree).match(/class="summary-group"/g)||[]).length,2);button(summaryTree,'Export XLSX').props.onClick();assert.deepEqual(XLSX.utils.sheet_to_json(summaryBook.Sheets.Summaries).filter(row=>row['Row type']==='Child issue').map(row=>row['Source issue ID']).sort(),['future','outage','unknown']);assert.equal(summaryBook.Sheets['Recurring issues'],undefined);
 h.state.view='timeline';const timelineProps=nodes(h.render()).find(n=>n.props?.maintenanceRevision!==undefined&&n.props?.issues).props;assert.deepEqual(json(timelineProps.issues.map(i=>i.id)),['outage','unknown','future']);
 const timeline=harness('app/IssueTimeline.tsx',{}, {...loadSource('app/timeline-axis.ts',[],{...time,...periods}),useTimelineMaintenance:()=>({days:[],timezone:'UTC',loading:false,error:null}),TimelineMaintenance:()=>null});const timelineMarkup=html(timeline.render(timelineProps));assert.doesNotMatch(timelineMarkup,/Finding legacy/);assert.equal((timelineMarkup.match(/class="timeline-issue-label timeline-parent-label"/g)||[]).length,3);
 assert.equal(JSON.stringify(data),before);
});

test('legacy aggregate summaries and threshold messaging cannot reintroduce retired losses',()=>{
 const data=performance('run',[finding('legacy',{type:'Underperformance'})]);data.methodology.calculationVersion=28;
 Object.assign(data.analysis,{unfilteredTotalLossKwh:987654321,thresholdExcludedLossKwh:123456789,suppressedByLossThreshold:999,issueLossThresholdKwh:999});
 const h=home({performance:data}),tree=h.render(),markup=html(tree);
 assert.doesNotMatch(markup,/Full saved analysis|987,654|123,456|999 issues|individual losses above/);
 assert.match(markup,/No outage or data-quality findings/);
 button(tree,'Export XLSX').props.onClick();const rows=XLSX.utils.sheet_to_json(h.getBook().Sheets.Methodology,{header:1});const filters=JSON.parse(rows.find(r=>r[0]==='Report filters')[1]);assert.equal(filters.lossThreshold,undefined);
});

test('new calculation shows its short recorded Method, legacy calculations never adopt it',()=>{
 const h=home();assert.match(html(h.render()),/Daylight outages use supplied Expected Production/);
 const old=home({performance:{...performance(),methodology:{calculationVersion:28}}});assert.match(html(old.render()),/Legacy analysis/);assert.doesNotMatch(html(old.render()),/Daylight outages use supplied/);
});

test('Review workbench runs no inverter preparation and preserves real bulk/maintenance handlers',()=>{
 let recurrenceCalls=0,clear=0,selected=[];
 const original=finding('outage'),visible={...original,estimatedLossKwh:3,reportClipped:true},windows=[];
 const h=harness('app/ReviewWorkbench.tsx',{}, {inverterReviewCards:()=>{recurrenceCalls++;throw new Error('Retired card work');},reviewEnergy:loadSource('app/BulkReviewDialog.tsx').reviewEnergy,MaintenanceWindows:()=>null,BulkReviewDialog:()=>null});
 const props={siteId:'site',runId:'run',visible:[visible],originals:[original],episodes:[{id:'legacy'}],reviews:{},selected:['outage'],onSelect:(...args)=>selected.push(args),onClear:()=>clear++,onUpdated:noop,readOnly:false,maintenance:{windows}};
 let tree=h.render(props);assert.equal(recurrenceCalls,0);assert.doesNotMatch(html(tree),/recurring|crosshatched/i);assert.match(html(tree),/1 findings selected/);
 const maintenance=nodes(tree).find(n=>n.props?.findings&&n.props?.data);assert.equal(maintenance.props.findings[0],original);maintenance.props.onSelect(['outage']);assert.deepEqual(selected,[[['outage'],true]]);
 button(tree,'Review selected').props.onClick();tree=h.render(props);const bulk=nodes(tree).find(n=>n.props?.findings&&n.props?.onUpdated);assert.equal(bulk.props.findings[0],original);bulk.props.onClose();assert.equal(clear,1);assert.equal(h.state.bulk,null);
 button(h.render(props),'Clear selection').props.onClick();assert.equal(clear,2);
});

test('methodology export strips retired filters and outputs even for legacy caller contexts',()=>{
 const legacy=finding('legacy',{type:'Underperformance'}),outage=finding('outage');
 const context={issues:[legacy,outage],excludedIssues:[legacy],reviews:{},reviewFilter:'All findings',reviewRetrievedAt:'now',filters:{issueVisibility:{...visibility.defaultIssueVisibility,siteUnderperformance:true,inverterUnderperformance:true},suspectedCause:'Shading'},recurringIssues:[{id:'legacy',type:'Underperformance',members:[legacy],activeMinutes:60}],methodology:{calculationVersion:28,recurringPolicy:'old policy',peerComparison:{old:true},inverterExpectation:{old:true},sharedReduction:{old:true},thresholdMethod:'Old recurring rule',exclusions:'Old long method'}};
 const before=JSON.stringify(context),book=XLSX.utils.book_new();method.appendReportMethodology(book,context);
 assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets['Analyst reviews']).map(i=>i.issueId),['outage']);assert.equal(book.Sheets['Dismissed findings'],undefined);assert.equal(book.Sheets['Recurring issues'],undefined);assert.equal(book.Sheets['Recurring occurrences'],undefined);
 const rows=XLSX.utils.sheet_to_json(book.Sheets.Methodology,{header:1});assert.doesNotMatch(JSON.stringify(rows),/siteUnderperformance|inverterUnderperformance|recurringPolicy|peerComparison|inverterExpectation|sharedReduction|Old long|Old recurring|suspectedCause/);assert.equal(JSON.stringify(context),before);
});
