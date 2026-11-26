// Offline composed integration: real built HTTP/storage + actual component handlers.
// Deterministic hook scheduling is not hydrated-browser coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {monthlyFixture} from './monthly-fixture.mjs';
import {seedMeasuredPoa} from './monthly-poa-fixture.mjs';
import {seedMonthlyLossRun,saveLossReview,lossRequest} from './monthly-confirmed-loss-fixture.mjs';
import {LocalDatabase,LocalBucket} from '../../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';
import {emptyConfiguration} from '../../app/monthly-domain.mjs';
import {home,harness,nodes,html,button,loadSource,React,periods,finding,performance as homePerformance} from '../outage-only-ui-harness.mjs';
import {harness as chartHarness,nodes as chartNodes,html as chartHtml} from '../monthly-charts-ui-fixture.mjs';

// Independent exact expectations: interval Wh/m² / 1000; site-local January
// loss = 123.25 + 10.25, February = counted 30.25 (not raw 100.25).
const samples=[
 {timestamp:'2026-01-15T17:00:00.000Z',poa:800,satellite:800,expected:12.25},
 {timestamp:'2026-01-20T17:00:00.000Z',poa:0,satellite:0,expected:0},
 {timestamp:'2026-01-31T23:00:00.000Z',poa:-25,satellite:-25,expected:6},
 {timestamp:'2026-02-07T17:00:00.000Z',poa:200,satellite:200,expected:8.5},
];
const expected={
 months:{'2026-01':{insolation:{n:'31',d:'40'},expected:{n:'73',d:'4'}},'2026-02':{insolation:{n:'1',d:'5'},expected:{n:'17',d:'2'}}},
 loss:{'2026-01':{n:'267',d:'2'},'2026-02':{n:'121',d:'4'}},
 calculated:{productionProjectionRatio:{n:'301',d:'400'},productionExpectedRatio:{n:'1204',d:'73'},revenueRatio:{n:'-1',d:'2'},insolationRatio:{n:'31',d:'80'},iapr:{n:'301',d:'155'},iar:{n:'-40',d:'31'}},
};
const plain=value=>JSON.parse(JSON.stringify(value));
const noLoss=({confirmedLoss,unconfirmedLoss,...rest})=>{assert.ok(unconfirmedLoss);return rest;};
const retained=f=>f.inspect(db=>({tables:Object.fromEntries(['monthly_configuration','monthly_utility','analysis_runs','analysis_jobs','issue_event_reviews','issue_review_changes','performance_summaries','telemetry_imports'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),objects:db.prepare('SELECT key,path FROM __sol_objects ORDER BY key').all().map(({key,path})=>[key,createHash('sha256').update(readFileSync(join(f.directory,'objects',path))).digest('hex')])}));
const ReportingPeriod=loadSource('app/ReportingPeriod.tsx',[],{React,...periods}).default;

function sharedHome(initial={}){
 const Charts=()=>null,Workbench=()=>null;
 const h=home(initial,{ReportingPeriod,MonthlyCharts:Charts,ReviewWorkbench:Workbench,confirmMonthlyNavigation:()=>true});
 return {...h,Charts,Workbench};
}
function assertFindings(h){
 const tree=h.render(),markup=html(tree),header=html(nodes(tree).find(n=>n.type==='header'&&n.props.className?.includes('diagnostic-header')));
 assert.ok(header.indexOf('ANALYSIS SITE')<header.indexOf('Reporting period from'));
 assert.ok(header.indexOf('Reporting period through')<header.indexOf('Reanalyze current data'));
 assert.match(header,/reporting-period-compact/);assert.ok(button(tree,'Issue visibility'));
 assert.doesNotMatch(markup,/class="(?:active-analysis|issue-visibility-notice|maintenance-panel)/);
 assert.equal(button(tree,'Import performance data'),undefined);
 return tree;
}

test('shared Home retains Findings controls and Visuals → Charts navigation in the combined candidate',t=>{
 const h=sharedHome();t.after(()=>h.dispose());let tree=assertFindings(h);
 assert.ok(button(tree,'Visuals'));button(tree,'Charts').props.onClick();tree=h.render();
 assert.equal(h.state.view,'charts');assert.ok(nodes(tree).some(n=>n.type===h.Charts&&n.props.siteId==='site'));
 button(tree,'Findings').props.onClick();assert.equal(h.state.view,'issues');tree=assertFindings(h);
 const reporting=nodes(tree).find(n=>n.type===ReportingPeriod);reporting.props.onChange({from:'2026-01-01',through:'2026-02-28'});
 assert.deepEqual(plain(h.state.reportRange),{from:'2026-01-01',through:'2026-02-28'});
});

test('Findings bulk handler updates current monthly loss without changing uploaded POA, chart inputs or retained history',{timeout:120000},async t=>{
 const out=process.env.FOUR_UPDATE_EVIDENCE;
 if(out)mkdirSync(out,{recursive:true});
 const f=await monthlyFixture(t,out?{directory:mkdtempSync(join(out,'composed-data-'))}:{});
 const database=new LocalDatabase(join(f.directory,'sol-diagnostics.sqlite'),resolve('drizzle'));
 const performance=new PerformanceStoreManager(join(f.directory,'performance'));
 let beforeCanonical,head,sourceId;
 try{
  const seeded=await seedMeasuredPoa({database,bucket:new LocalBucket(database,join(f.directory,'objects')),performance,root:f.directory,siteId:f.siteId,timezone:'America/New_York',sensors:[{id:'301',name:'POA South',unit:'W/m²'},{id:'302',name:'POA North',unit:'W/m²'}],samples});
  sourceId=seeded.sourceId;beforeCanonical=[...performance.site(f.siteId).reportingRows()];head=performance.site(f.siteId).describe();
 }finally{performance.close();database.close();}
 const published=await seedMonthlyLossRun(f);await seedMonthlyLossRun(f,{runId:'four-update-history-not-published',publish:false});await f.start();
 const get=()=>lossRequest(f,`/api/monthly-data?siteId=${encodeURIComponent(f.siteId)}`),post=body=>lossRequest(f,'/api/monthly-data',{body:{siteId:f.siteId,...body}});
 const initial=await get();assert.equal(initial.telemetry.poa.state,'selected');assert.deepEqual(initial.telemetry.months['2026-01'].insolation.value,expected.months['2026-01'].insolation);
 const configuration={...emptyConfiguration(),operationsStart:'2026-01-01',degradation:'0',irradianceChannelId:initial.telemetry.selectedChannelId,poaSourceId:sourceId};configuration.baselines[1]={production:'400',revenue:'25',insolation:'2'};
 const preview=await post({action:'preview',revision:initial.revision,configuration});assert.equal(preview.sourceChanged,true);assert.deepEqual(await get(),initial);
 const saved=await post({action:'configuration',revision:initial.revision,configuration,previewToken:preview.token});assert.deepEqual(await get(),saved);
 const utility={onPeak:'100.125000',offPeak:'200.375000',unpaidEnergy:'0.5',revenue:'-12.500000',energyUsed:'0',invoiceCost:'-0.00000000000000001'};
 const values=await post({action:'utility',revision:saved.revision,rows:[{month:'2026-01',...utility}]});assert.deepEqual(await get(),values);assert.deepEqual(values.utility['2026-01'],utility);
 for(const [month,want] of Object.entries(expected.months)){
  assert.deepEqual(values.telemetry.months[month].insolation.value,want.insolation);assert.deepEqual(values.telemetry.months[month].expected.value,want.expected);
  assert.match(values.telemetry.months[month].insolation.source,/Uploaded POA interval energy/);assert.equal(values.telemetry.months[month].insolation.state,'partial');
 }
 for(const [field,want] of Object.entries(expected.calculated))assert.deepEqual(values.calculated['2026-01'][field].value,want,field);
 assert.equal(values.telemetry.months['2026-01'].insolation.negativeIntervals,1);assert.equal(values.telemetry.months['2026-01'].insolation.coveredMilliseconds,10800000);
 const numericControl=noLoss(values);
 const h=sharedHome({activeSiteId:f.siteId,configs:{[f.siteId]:{id:f.siteId,name:'Composed synthetic site',city:'Test',state:'',arrayModelVerified:true}},performance:homePerformance('monthly-current',published.analysis.issues.map(issue=>finding(issue.id,{...issue,timezone:'America/New_York'}))),reviewScope:`${f.siteId}:monthly-current`,selectedFindings:['january','boundary']});t.after(()=>h.dispose());
 const tree=assertFindings(h),workProps=nodes(tree).find(n=>n.type===h.Workbench).props;
 assert.equal(workProps.readOnly,false);assert.deepEqual(plain(workProps.selected),['january','boundary']);
 const Dialog=()=>null,w=harness('app/ReviewWorkbench.tsx',{}, {BulkReviewDialog:Dialog,reviewEnergy:loadSource('app/BulkReviewDialog.tsx').reviewEnergy});t.after(()=>w.dispose());
 button(w.render(workProps),'Review selected').props.onClick();const dialogProps=nodes(w.render(workProps)).find(n=>n.type===Dialog).props;
 assert.deepEqual(plain(dialogProps.findings.map(i=>i.id)),['january','boundary']);
 let requestCount=0;
 const dialog=harness('app/BulkReviewDialog.tsx',{}, {ReviewModal:({children})=>React.createElement('section',null,children),fetch:async(path,options)=>{requestCount++;assert.equal(path,'/api/issue-reviews/bulk');return fetch(f.base+path,{...options,headers:{...options.headers,Authorization:f.authorization}});}});t.after(()=>dialog.dispose());
 nodes(dialog.render(dialogProps)).find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});
 button(dialog.render(dialogProps),'Apply to selected findings').props.onClick();
 for(let i=0;i<200&&dialog.state.busy;i++)await new Promise(r=>setTimeout(r,25));
 assert.equal(dialog.state.busy,false);assert.equal(dialog.state.error,'');assert.deepEqual(plain(dialog.state.done).sort(),['boundary','january']);assert.equal(requestCount,1);
 for(const issue of dialogProps.findings){
  const after=await lossRequest(f,`/api/issue-reviews?siteId=${f.siteId}&runId=monthly-current&issueId=${issue.id}`);
  assert.equal(after.review.state.status,'Confirmed');assert.equal(h.state.reviews[issue.eventKey].state.status,'Confirmed');
 }
 const confirmed=await get();assert.equal(confirmed.confirmedLoss.analysisRunId,'monthly-current');assert.equal(confirmed.confirmedLoss.state,'current');
 for(const [month,want] of Object.entries(expected.loss))assert.deepEqual(confirmed.confirmedLoss.months[month].value,want);
 assert.deepEqual(noLoss(confirmed),numericControl,'Review-only changes preserve all numerical inputs/revisions');
 const charts=chartHarness({plotOnly:true});t.after(()=>charts.dispose());const settings={start:'2026-01',end:'2026-02',type:'line',comparisonYears:1,metrics:['actualInsolation']};
 const series=charts.model.buildChartSeries(confirmed,settings);assert.deepEqual(plain(series),plain(charts.model.buildChartSeries(values,settings)));
 assert.equal(series.length,2);assert.equal(series[0].points[0].display,'0.78');
 charts.render({series,type:'line'});chartNodes(charts.tree).find(n=>n.props?.['data-chart-hit']==='0:0').props.onPointerMove({pointerType:'mouse'});charts.render();
 const popup=chartNodes(charts.tree).find(n=>n.props?.['data-month-details']!==undefined);assert.ok(popup);
 assert.equal(chartNodes(popup).filter(n=>n.props?.className==='mc-detail-item').length,2);
 assert.match(chartHtml(popup),/0.78/);assert.doesNotMatch(chartHtml(popup),/mc-provenance|On-peak|Utility revenue|Expected Production/);
 const protectedBefore=retained(f);assert.deepEqual(await get(),confirmed);assert.deepEqual(retained(f),protectedBefore);
 await saveLossReview(f,'monthly-current','january','Dismissed');const dismissed=await get();assert.deepEqual(dismissed.confirmedLoss.months['2026-01'].value,{n:'41',d:'4'});assert.deepEqual(noLoss(dismissed),numericControl);
 await saveLossReview(f,'monthly-current','january','Confirmed');assert.deepEqual((await get()).confirmedLoss,confirmed.confirmedLoss);
 const next={...configuration,irradianceChannelId:null};
 const nextPreview=await post({action:'preview',revision:confirmed.revision,configuration:next});
 const northSaved=await post({action:'configuration',revision:confirmed.revision,configuration:next,previewToken:nextPreview.token});assert.deepEqual(await get(),northSaved);
 assert.deepEqual(northSaved.telemetry.months['2026-01'].insolation.value,expected.months['2026-01'].insolation);assert.deepEqual(northSaved.calculated['2026-01'].iapr.value,expected.calculated.iapr);assert.deepEqual(northSaved.confirmedLoss,confirmed.confirmedLoss);
 for(const field of ['productionExpectedRatio','revenueRatio','productionProjectionRatio'])assert.deepEqual(northSaved.calculated['2026-01'][field],confirmed.calculated['2026-01'][field]);
 const backPreview=await post({action:'preview',revision:northSaved.revision,configuration});const restored=await post({action:'configuration',revision:northSaved.revision,configuration,previewToken:backPreview.token});assert.deepEqual(await get(),restored);
 assert.deepEqual(restored.telemetry,confirmed.telemetry);assert.deepEqual(restored.calculated,confirmed.calculated);assert.deepEqual(restored.confirmedLoss,confirmed.confirmedLoss);assert.deepEqual(restored.utility,confirmed.utility);
 const beforeRestart=retained(f);await f.stop();await f.start();assert.deepEqual(await get(),restored);assert.deepEqual(retained(f),beforeRestart);await f.stop();
 const reopened=new PerformanceStoreManager(join(f.directory,'performance'));try{assert.deepEqual([...reopened.site(f.siteId).reportingRows()],beforeCanonical);assert.deepEqual(reopened.site(f.siteId).describe(),head);}finally{reopened.close();}
 await assert.rejects(fetch(f.base+'/healthz',{signal:AbortSignal.timeout(2000)}));
 if(out)writeFileSync(join(f.directory,'composed-result.json'),JSON.stringify({passed:true,syntheticOnly:true,base:f.base,directory:f.directory,samples,expected,actual:restored,bulkRequests:requestCount,actualComponentHandlers:true,hydratedBrowser:false,canonicalAndHistoryPreserved:true,restartExact:true,listenerStopped:true},null,2));
});
