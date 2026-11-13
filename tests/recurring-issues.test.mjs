import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import * as XLSX from 'xlsx';
import {loadSource} from './source-module.mjs';
const time=loadSource('app/telemetry-time.ts'),periods=loadSource('app/issue-periods.ts',[],time),r=loadSource('app/recurring-issues.ts',[],periods),review=loadSource('app/issue-review.ts');
const json=x=>JSON.parse(JSON.stringify(x));
const issue=(id,day,patch={})=>{const timestamp=`2026-06-${String(day).padStart(2,'0')}T12:00:00.000Z`;return {id,eventKey:`key-${id}`,evidenceSignature:`sig-${id}`,name:'Underperformance',equipmentName:'Inverter 1',equipmentId:'inv',equipmentType:'inverter',type:'Underperformance',category:'Performance',timezone:'America/New_York',startDateTime:timestamp,endDateTime:timestamp.replace('12:00','13:00'),estimatedLossKwh:10,actualEnergyKwh:40,expectedEnergyKwh:50,intervalMinutes:60,intervalLosses:[{timestamp,intervalMinutes:60,lossKwh:10,actualKwh:40,expectedKwh:50}],detectionBasis:'derived',...patch};};
const absentReadings=Array.from({length:5},(_,i)=>({timestamp:`2026-06-0${i+3}T12:00:00.000Z`,energyKwh:50}));
const summary={intervalMinutes:60,timestamps:['2026-06-20T04:00:00.000Z'],intervalIrradiance:absentReadings.map(p=>({timestamp:p.timestamp,averageWm2:600})),equipmentProduction:[{equipmentId:'inv',intervalProduction:absentReadings}]};
test('five-day grouping separates longer gaps, preserves interval losses and stable filtered identities',()=>{
 const items=[issue('a',1),issue('b',2),issue('c',8),issue('d',13),issue('single',20)],before=items.reduce((s,i)=>s+i.estimatedLossKwh,0);
 const episodes=r.buildRecurringIssues(items,summary);assert.equal(episodes.length,2);assert.deepEqual(json(episodes.map(e=>e.dates)),[['2026-06-01','2026-06-02'],['2026-06-08','2026-06-13']]);assert.equal(episodes[0].sequenceStatus,'Ended — no occurrence');assert.equal(episodes[1].sequenceStatus,'Ended — insufficient data');
 assert.equal(episodes[0].activeMinutes,120);assert.equal(episodes[0].estimatedLossKwh,20);assert.equal(items.reduce((s,i)=>s+i.estimatedLossKwh,0),before);assert.equal(items.at(-1).recurringId,undefined);
 const extended=r.buildRecurringIssues([issue('a',1),issue('b',2),issue('new',7)])[0];assert.equal(extended.id,episodes[0].id);assert.equal(extended.sequenceStatus,'Awaiting 5-day window');
 const clipped=periods.clipIssueToReport(items[1],{from:'2026-06-02',through:'2026-06-02'});
 const views=r.recurringViews(episodes,[clipped]);assert.equal(views[0].id,episodes[0].id);assert.equal(views[0].firstDay,'2026-06-01');assert.equal(views[0].visibleLossKwh,10);assert.equal(views[0].visibleActiveMinutes,60);assert.ok(views[0].filtered);
 assert.equal(r.recurringTableRows(episodes,items).length,3);
});
test('exactly five days joins and each occurrence extends the rolling window; six days starts a new record',()=>{
 const items=[issue('a',1),issue('b',6),issue('c',11),issue('d',17),issue('e',22)];const episodes=r.buildRecurringIssues(items);
 assert.deepEqual(json(episodes.map(e=>e.dates)),[['2026-06-01','2026-06-06','2026-06-11'],['2026-06-17','2026-06-22']]);assert.deepEqual(json(episodes.map(e=>e.activeMinutes)),[180,120]);assert.equal(episodes.reduce((s,e)=>s+e.estimatedLossKwh,0),50);
});
test('the fifth possible recurrence day must be fully observed before an episode ends',()=>{
 const build=timestamp=>r.buildRecurringIssues([issue('a',1),issue('b',2)],{...summary,intervalMinutes:15,timestamps:[timestamp]})[0];
 assert.equal(build('2026-06-08T03:30:00Z').sequenceStatus,'Awaiting 5-day window');
 assert.equal(build('2026-06-08T03:45:00Z').sequenceStatus,'Ended — no occurrence');
 const missing={...summary,equipmentProduction:[]};assert.equal(r.buildRecurringIssues([issue('a',1),issue('b',2)],missing)[0].sequenceStatus,'Ended — insufficient data');
});
test('five-day grouping uses local calendar dates across DST rather than elapsed 120 hours',()=>{
 const at=(id,timestamp)=>issue(id,1,{startDateTime:timestamp,endDateTime:new Date(Date.parse(timestamp)+3600000).toISOString(),intervalLosses:[{timestamp,lossKwh:10,intervalMinutes:60}]});
 const items=[at('a','2026-10-29T16:00:00Z'),at('b','2026-11-03T17:00:00Z')];assert.equal((Date.parse(items[1].startDateTime)-Date.parse(items[0].startDateTime))/3600000,121);
 const episodes=r.buildRecurringIssues(items);assert.equal(episodes.length,1);assert.deepEqual(json(episodes[0].dates),['2026-10-29','2026-11-03']);
 const spring=[at('c','2026-03-05T17:00:00Z'),at('d','2026-03-10T16:00:00Z')];assert.equal(r.buildRecurringIssues(spring).length,1);
});
test('same-day events, other equipment, cause and detection basis do not manufacture recurrence',()=>{
 const items=[issue('a',1),issue('same',1),issue('other-equipment',2,{equipmentId:'other'}),issue('other-cause',2,{suspectedCause:'Snow'}),issue('other-basis',2,{detectionBasis:'peer'}),issue('suppressed',2,{intervalLosses:[{timestamp:'2026-06-02T12:00:00Z',lossKwh:10,countedLossKwh:0}]})];
 assert.equal(r.buildRecurringIssues(items).length,0);
});
test('a detector event bridging an inactive day splits without creating gap losses',()=>{
 const first=issue('gap',1),last=issue('last',3);const original={...first,endDateTime:last.endDateTime,estimatedLossKwh:20,actualEnergyKwh:80,expectedEnergyKwh:100,intervalLosses:[...first.intervalLosses,{timestamp:'2026-06-02T12:00:00Z',lossKwh:0,actualKwh:50,expectedKwh:50},...last.intervalLosses]};
 const split=r.splitRecurringGaps([original]);assert.equal(split.length,2);assert.equal(split.reduce((s,i)=>s+i.estimatedLossKwh,0),20);assert.equal(r.buildRecurringIssues(split).length,1);assert.equal(r.buildRecurringIssues(split)[0].activeMinutes,120);assert.equal(split[1].evidence.originalDetectorIssueId,'gap');assert.deepEqual(json(split.map(i=>r.activeDates(i))),[['2026-06-01'],['2026-06-03']]);
});
test('site-local day boundaries are end-exclusive across DST and interval losses remain exact',()=>{
 const a=issue('dst',1,{startDateTime:'2026-03-07T05:00:00Z',endDateTime:'2026-03-09T04:00:00Z',intervalLosses:[{timestamp:'2026-03-07T05:00:00Z',intervalMinutes:2820,lossKwh:47}],estimatedLossKwh:47});
 assert.deepEqual(json(r.activeDates(a)),['2026-03-07','2026-03-08']);const e=r.buildRecurringIssues([a])[0];assert.equal(e.activeMinutes,2820);assert.equal(e.estimatedLossKwh,47);assert.equal(e.dates.length,2);
 const fall={...a,startDateTime:'2026-10-31T04:00:00Z',endDateTime:'2026-11-02T05:00:00Z',intervalLosses:[{timestamp:'2026-10-31T04:00:00Z',intervalMinutes:2940,lossKwh:49}],estimatedLossKwh:49};assert.equal(r.buildRecurringIssues([fall])[0].activeMinutes,2940);
});
test('a partially observed recurrence window does not end a sequence and overlapping hours are counted once',()=>{
 const items=[issue('a',1),issue('b',2),issue('b2',2)];const e=r.buildRecurringIssues(items,{...summary,timestamps:['2026-06-03T16:00:00Z'],equipmentProduction:[]})[0];assert.equal(e.sequenceStatus,'Awaiting 5-day window');assert.equal(e.activeMinutes,120);assert.equal(r.recurringViews([e],items)[0].visibleActiveMinutes,120);
});
function database(){const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));const prepare=(sql,values=[])=>({bind(...v){return prepare(sql,v)},async first(){return sqlite.prepare(sql).get(...values)||null},async all(){return {results:sqlite.prepare(sql).all(...values)}},async run(){return sqlite.prepare(sql).run(...values)}});return {sqlite,prepare,async batch(items){sqlite.exec('BEGIN');try{for(const item of items)await item.run();sqlite.exec('COMMIT')}catch(e){sqlite.exec('ROLLBACK');throw e}}};}
function apiFixture(){const db=database(),items=[issue('a',1),issue('b',2)],basis={calculationVersion:27,modelRevision:'model'};const episode={...r.buildRecurringIssues(items)[0],eventKey:'parent-key',evidenceSignature:'parent-sig'};const payload={reviewCalculationBasis:basis,analysis:{issues:items,recurringIssues:[episode]}},old=json(payload);const savedAnalysis=async(site,run)=>{assert.equal(site,'site');return run==='old'?old:payload};const service=loadSource('app/api/issue-reviews/service.ts',[],{...review,savedAnalysis,getDatabaseBinding:()=>db});const api=loadSource('app/api/issue-reviews/route.ts',[],{...service,blankReview:review.blankReview,savedAnalysis,getDatabaseBinding:()=>db});const bulk=loadSource('app/api/issue-reviews/bulk/route.ts',[],{...review,...service,savedAnalysis,getDatabaseBinding:()=>db});return {db,items,basis,episode,payload,old,service,api,bulk};}
const post=(api,body)=>api.POST(new Request('https://test/api',{method:'POST',body:JSON.stringify(body)}));
test('parent decisions persist once, inherit to reviewed members, and respect explicit exceptions',async()=>{
 const {db,items,episode,payload,service,api}=apiFixture();let state={...review.blankReview(episode,episode.evidenceSignature),status:'Dismissed',dismissalReason:'Duplicate finding',classification:'Fuse Failure'};
 const saved=await post(api,{siteId:'site',runId:'run',issueId:episode.id,baseVersion:0,state,note:'Reviewed these dates together.'});const s=await saved.json();assert.equal(saved.status,200,JSON.stringify(s));assert.equal(s.review.state.recurringId,episode.id);assert.equal(s.review.state.recurringMembers,undefined);assert.equal(db.sqlite.prepare('SELECT count(*) n FROM issue_event_reviews').get().n,1);
 let effective=await service.effectiveReviews(db,'site','run',payload,items.map(i=>i.eventKey));assert.ok(effective.every(x=>x.inheritedFrom&&x.state.status==='Dismissed'&&!x.needsReview&&!x.state.recurringMembers));assert.equal(review.reviewLossSummary(items,Object.fromEntries(effective.map(x=>[x.eventKey,x]))).adjusted,0);
 await service.saveReview(db,'site',items[1].eventKey,'run',0,{...review.blankReview(items[1],items[1].evidenceSignature),status:'Confirmed'},'Confirmed exception','analyst');
 effective=await service.effectiveReviews(db,'site','run',payload,items.map(i=>i.eventKey));assert.equal(effective.find(x=>x.eventKey===items[1].eventKey).inheritedFrom,undefined);assert.equal(review.reviewLossSummary(items,Object.fromEntries(effective.map(x=>[x.eventKey,x]))).adjusted,10);
 const detail=await(await api.GET(new Request(`https://test/api?siteId=site&runId=run&issueId=${encodeURIComponent(episode.id)}`))).json();assert.equal(detail.issueSummary.recurring.occurrenceCount,2);assert.equal(detail.audit[0].note,'Reviewed these dates together.');
});
test('new members stay unreviewed and changed members cannot retain an old parent dismissal',async()=>{
 const {db,items,basis,episode,payload,service}=apiFixture();await service.saveReview(db,'site',episode.eventKey,'old',0,{...review.blankReview(episode,episode.evidenceSignature),status:'Dismissed',dismissalReason:'Duplicate finding',recurringMembers:json(episode.members),recurringBasis:basis,evidenceRunId:'old'},'Prior decision','analyst');
 const added=issue('new',3);payload.analysis.issues.push(added);episode.members.push({id:added.id,eventKey:added.eventKey,evidenceSignature:added.evidenceSignature});episode.evidenceSignature='changed-parent';items[0].estimatedLossKwh=30;items[0].evidenceSignature='changed-child';
 const result=await service.effectiveReviews(db,'site','run',payload,[...items.map(i=>i.eventKey),episode.eventKey]);assert.equal(result.find(x=>x.eventKey===added.eventKey),undefined);assert.ok(result.find(x=>x.eventKey===items[0].eventKey).needsReview);assert.ok(result.find(x=>x.eventKey===episode.eventKey).needsReview);assert.equal(result.find(x=>x.eventKey===items[1].eventKey).needsReview,false);
 assert.equal(review.reviewLossSummary(items,Object.fromEntries(result.map(x=>[x.eventKey,x]))).adjusted,40);
});
test('note-only bulk updates preserve inherited decisions and create an audited individual exception',async()=>{
 const {db,items,episode,payload,basis,service,bulk}=apiFixture();await service.saveReview(db,'site',episode.eventKey,'run',0,{...review.blankReview(episode,episode.evidenceSignature),status:'Confirmed',classification:'Fuse Failure',recurringMembers:json(episode.members),recurringBasis:basis,evidenceRunId:'run'},'Parent note','analyst');
 const response=await post(bulk,{siteId:'site',runId:'run',operationId:crypto.randomUUID(),patch:{confirm:false,classification:'',note:'Inspected this occurrence.'},items:[{issueId:items[0].id,evidenceSignature:items[0].evidenceSignature,baseVersion:0}]});assert.equal(response.status,200);const data=await response.json();assert.equal(data.results[0].review.state.status,'Confirmed');assert.equal(data.results[0].review.state.classification,'Fuse Failure');assert.equal(data.results[0].review.inheritedFrom,undefined);assert.equal(db.sqlite.prepare('SELECT count(*) n FROM issue_event_reviews').get().n,2);
});

test('group saves return only affected effective reviews, preserving child exceptions and immediate loss totals',async()=>{
 const {db,items,episode,payload,service,api}=apiFixture();
 const unrelated=issue('unrelated',20,{equipmentId:'other'});payload.analysis.issues.push(unrelated);
 await service.saveReview(db,'site',items[1].eventKey,'run',0,{...review.blankReview(items[1],items[1].evidenceSignature),status:'Dismissed',dismissalReason:'Duplicate finding'},'Individual exception','analyst');
 await service.saveReview(db,'site',unrelated.eventKey,'run',0,{...review.blankReview(unrelated,unrelated.evidenceSignature),status:'Confirmed'},'Unrelated review','analyst');
 const state={...review.blankReview(episode,episode.evidenceSignature),status:'Confirmed',classification:'Fuse Failure'};
 const response=await post(api,{siteId:'site',runId:'run',issueId:episode.id,baseVersion:0,state,note:''});
 const saved=await response.json();assert.equal(response.status,200,JSON.stringify(saved));assert.ok(Number.isFinite(Date.parse(saved.retrievedAt)));
 const affected=new Map(saved.reviews.map(r=>[r.eventKey,r]));assert.deepEqual([...affected.keys()].sort(),[episode.eventKey,items[0].eventKey,items[1].eventKey].sort());
 assert.equal(affected.get(items[0].eventKey).state.status,'Confirmed');assert.equal(affected.get(items[0].eventKey).inheritedFrom.id,episode.id);assert.equal(affected.get(items[0].eventKey).state.classification,'Fuse Failure');
 assert.equal(affected.get(items[1].eventKey).state.status,'Dismissed');assert.equal(affected.get(items[1].eventKey).inheritedFrom,undefined);
 assert.equal(review.reviewLossSummary(items.slice(0,2),Object.fromEntries(affected)).adjusted,10);
 assert.equal(db.sqlite.prepare('SELECT count(*) n FROM issue_event_reviews').get().n,3);
 const dismissed=await(await post(api,{siteId:'site',runId:'run',issueId:episode.id,baseVersion:saved.review.version,state:{...state,status:'Dismissed',dismissalReason:'Duplicate finding'},note:''})).json();
 assert.equal(review.reviewLossSummary(items.slice(0,2),Object.fromEntries(dismissed.reviews.map(r=>[r.eventKey,r]))).adjusted,0);
});

test('group save responses cover every saved member across database query batches',async()=>{
 const {db,items,episode,api}=apiFixture();
 items.splice(0,items.length,...Array.from({length:170},(_,n)=>issue(`many-${n}`,1+n%2)));
 Object.assign(episode,r.buildRecurringIssues(items)[0],{eventKey:'parent-key',evidenceSignature:'parent-sig'});
 const response=await post(api,{siteId:'site',runId:'run',issueId:episode.id,baseVersion:0,state:{...review.blankReview(episode,episode.evidenceSignature),status:'Confirmed'},note:''});
 const saved=await response.json();assert.equal(response.status,200,JSON.stringify(saved));assert.equal(saved.reviews.length,171);assert.equal(new Set(saved.reviews.map(r=>r.eventKey)).size,171);
 assert.ok(saved.reviews.every(r=>r.state.status==='Confirmed'&&!r.needsReview));assert.equal(saved.reviews.filter(r=>r.inheritedFrom).length,170);
 assert.equal(db.sqlite.prepare('SELECT count(*) n FROM issue_event_reviews').get().n,1);
});

test('individual save responses replace inherited reviews with only the explicit occurrence decision',async()=>{
 const {items,episode,api}=apiFixture();
 await post(api,{siteId:'site',runId:'run',issueId:episode.id,baseVersion:0,state:{...review.blankReview(episode,episode.evidenceSignature),status:'Confirmed'},note:''});
 const response=await post(api,{siteId:'site',runId:'run',issueId:items[0].id,baseVersion:0,state:{...review.blankReview(items[0],items[0].evidenceSignature),status:'Dismissed',dismissalReason:'Duplicate finding'},note:''});
 const saved=await response.json();assert.equal(response.status,200);assert.equal(saved.reviews.length,1);assert.equal(saved.reviews[0].eventKey,items[0].eventKey);assert.equal(saved.reviews[0].inheritedFrom,undefined);assert.equal(saved.reviews[0].version,1);assert.equal(saved.reviews[0].state.status,'Dismissed');
});

test('annual episode exports store members as rows, avoiding spreadsheet cell limits and duplicate loss totals',()=>{
 const e={...r.buildRecurringIssues([issue('a',1),issue('b',2)])[0],members:Array.from({length:2000},(_,i)=>({id:`id-${i}`,eventKey:'k'.repeat(64)+i,evidenceSignature:'s'.repeat(64)}))},book=XLSX.utils.book_new();
 const report=loadSource('app/report-methodology.ts',[],{XLSX,...review});report.appendReportMethodology(book,{recurringIssues:[e],reviewFilter:'Exclude dismissed',reviews:{},reviewRetrievedAt:'now',issues:[]});
 const saved=XLSX.read(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));assert.equal(XLSX.utils.sheet_to_json(saved.Sheets['Recurring occurrences']).length,2000);assert.equal(XLSX.utils.sheet_to_json(saved.Sheets['Recurring issues'])[0].occurrenceCount,2000);
});
