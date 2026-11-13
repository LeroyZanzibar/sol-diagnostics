import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import * as XLSX from 'xlsx';
import {loadSource} from './source-module.mjs';
const time=loadSource('app/telemetry-time.ts'),review=loadSource('app/issue-review.ts'),group=loadSource('app/review-groups.ts',[],time);
function database(){const sqlite=new DatabaseSync(':memory:');for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(`drizzle/${f}`,'utf8'));let reads=0,maxBatch=0;const prepare=(sql,v=[])=>({bind(...values){return prepare(sql,values)},async run(){return {meta:{changes:sqlite.prepare(sql).run(...v).changes}}},async first(){reads++;return sqlite.prepare(sql).get(...v)||null},async all(){reads++;return {results:sqlite.prepare(sql).all(...v)}}});return {sqlite,prepare,get reads(){return reads},get maxBatch(){return maxBatch},async batch(items){maxBatch=Math.max(maxBatch,items.length);sqlite.exec('BEGIN');try{for(const item of items)await item.run();sqlite.exec('COMMIT');}catch(e){sqlite.exec('ROLLBACK');throw e;}}};}
const issue=(id,day=1,patch={})=>({id,eventKey:`key-${id}`,evidenceSignature:`sig-${id}`,equipmentId:'inv',equipmentName:'Inverter A',equipmentType:'inverter',type:'Underperformance',category:'Performance',name:'Underperformance',timezone:'America/New_York',startDateTime:`2026-06-${String(day).padStart(2,'0')}T12:00:00.000Z`,endDateTime:`2026-06-${String(day).padStart(2,'0')}T14:00:00.000Z`,estimatedLossKwh:10,actualEnergyKwh:90,expectedEnergyKwh:100,intervalLosses:[{timestamp:`2026-06-${String(day).padStart(2,'0')}T12:00:00.000Z`,lossKwh:10,actualKwh:90,expectedKwh:100}],...patch});
const basis={calculationVersion:25,modelRevision:'model'};
function bulkApi(db,issues,old=issues){const savedAnalysis=async(site,run)=>{if(site!=='site'||!['run','old'].includes(run))throw new Error('Analysis not found');return {reviewCalculationBasis:basis,analysis:{issues:structuredClone(run==='old'?old:issues)}}};const service=loadSource('app/api/issue-reviews/service.ts',[],{...review,savedAnalysis});return {...service,...loadSource('app/api/issue-reviews/bulk/route.ts',[],{...review,...service,blankReview:review.blankReview,savedAnalysis,getDatabaseBinding:()=>db})};}
const input=(issues,patch={confirm:true,classification:'',note:''},extra={})=>({siteId:'site',runId:'run',operationId:crypto.randomUUID(),patch,items:issues.map(i=>({issueId:i.id,evidenceSignature:i.evidenceSignature,baseVersion:0})),...extra});
const post=(api,body)=>api.POST(new Request('https://test/api',{method:'POST',body:JSON.stringify(body)}));

test('recurring groups preserve separate dates, equipment identity, unknown losses and original ledgers',()=>{
 const items=[issue('a'),issue('b',3,{estimatedLossKwh:20}),issue('c',7,{estimatedLossKwh:null,lossUnknown:true}),issue('other',1,{equipmentId:'other'}),issue('outage',2,{type:'Equipment outage'}),issue('quality',4,{category:'Data quality'})],before=structuredClone(items);
 const groups=group.recurringInverterGroups(items);assert.equal(groups.length,1);assert.equal(groups[0].issues.length,3);assert.equal(groups[0].known,30);assert.equal(groups[0].unknown,1);assert.deepEqual([...groups[0].dates],['2026-06-01','2026-06-03','2026-06-07']);assert.deepEqual(items,before);assert.strictEqual(groups[0].issues[0],items[0]);
 const midnight=issue('midnight',1,{intervalLosses:[],startDateTime:'2026-03-08T05:00:00.000Z',endDateTime:'2026-03-09T04:00:00.000Z'});assert.deepEqual([...group.findingDates(midnight)],['2026-03-08']);
});
test('bulk confirmation and classification touch only explicit findings, append audit notes and retry without duplication',async()=>{
 const db=database(),items=[issue('a'),issue('b',2),issue('untouched',4)],copy=structuredClone(items),api=bulkApi(db,items);
 const body=input(items.slice(0,2),{confirm:true,classification:'Fuse Failure',note:'Same confirmed fuse fault on these dates.'});
 let response=await post(api,body),data=await response.json();assert.equal(response.status,200);assert.equal(data.results.length,2);assert.ok(data.results.every(r=>r.review.state.status==='Confirmed'&&r.review.state.classification==='Fuse Failure'));assert.equal(db.reads,3);assert.equal(db.maxBatch,4);
 assert.equal(db.sqlite.prepare('SELECT count(*) n FROM issue_event_reviews').get().n,2);assert.equal(db.sqlite.prepare('SELECT count(*) n FROM issue_review_changes').get().n,2);
 response=await post(api,body);data=await response.json();assert.ok(data.results.every(r=>r.replayed));assert.equal(db.sqlite.prepare('SELECT count(*) n FROM issue_review_changes').get().n,2);assert.deepEqual(items,copy);assert.equal(db.sqlite.prepare('SELECT count(*) n FROM performance_issue_occurrences').get().n,0);
});
test('notes and classification do not reaffirm stale dismissals or advance the human-reviewed analysis',async()=>{
 const db=database(),before=issue('a'),after=issue('a',1,{estimatedLossKwh:30,evidenceSignature:'new'}),api=bulkApi(db,[after],[before]);
 await api.saveReview(db,'site',before.eventKey,'old',0,{...review.blankReview(before,before.evidenceSignature),status:'Dismissed',dismissalReason:'Source data is incorrect',classification:'Unknown'},'Original review','analyst');
 const body=input([after],{confirm:false,classification:'Maintenance',note:'Scheduled work is additional context.'});body.items[0].baseVersion=1;
 const data=await (await post(api,body)).json(),saved=data.results[0].review;
 assert.equal(saved.state.status,'Dismissed');assert.equal(saved.needsReview,true);assert.equal(saved.state.evidenceRunId,'old');assert.equal(saved.state.evidenceSignature,before.evidenceSignature);assert.equal(saved.state.dismissalReason,'Source data is incorrect');assert.equal(saved.state.classification,'Maintenance');
 const reread=await api.assessReviews('site','run',{reviewCalculationBasis:basis,analysis:{issues:[after]}},[{...saved,eventKey:after.eventKey,runId:'run'}]);assert.equal(reread[0].needsReview,true);
 const confirm=input([after]);confirm.items[0].baseVersion=2;const accepted=await (await post(api,confirm)).json();assert.equal(accepted.results[0].review.needsReview,false);assert.equal(accepted.results[0].review.state.evidenceRunId,'run');assert.equal(accepted.results[0].review.state.evidenceSignature,'new');
});
test('bulk rejects invalid selections and handles version conflicts individually without overwriting',async()=>{
 const db=database(),items=[issue('a'),issue('b',2)],api=bulkApi(db,items);
 for(const modify of [b=>b.items.push({...b.items[0]}),b=>b.items[0].issueId='not-in-this-analysis',b=>b.items[0].evidenceSignature='obsolete',b=>b.siteId='other',b=>b.patch.classification='Invented cause']){const body=input(items);modify(body);assert.equal((await post(api,body)).status,409);}
 assert.equal(db.sqlite.prepare('SELECT count(*) n FROM issue_review_changes').get().n,0);
 await api.saveReview(db,'site',items[0].eventKey,'run',0,review.blankReview(items[0],items[0].evidenceSignature),'Other analyst note','other');
 const data=await (await post(api,input(items))).json();assert.match(data.results.find(r=>r.issueId==='a').error,/Another analyst/);assert.equal(data.results.find(r=>r.issueId==='b').review.state.status,'Confirmed');assert.equal(db.sqlite.prepare('SELECT version FROM issue_event_reviews WHERE event_key=?').get(items[0].eventKey).version,1);
});
test('bulk rollback retains old reviews if an audit write fails; large batches are bounded',async()=>{
 const db=database(),items=Array.from({length:26},(_,i)=>issue(`i${i}`)),api=bulkApi(db,items);assert.equal((await post(api,input(items))).status,409);
 db.sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON issue_review_changes BEGIN SELECT RAISE(ABORT,'audit failure'); END");const response=await post(api,input(items.slice(0,2)));assert.equal(response.status,409);assert.equal(db.sqlite.prepare('SELECT count(*) n FROM issue_event_reviews').get().n,0);
});
const equipment=[{id:'meter',name:'POI',type:'revenue_meter',parentId:null},{id:'tx',name:'Transformer',type:'transformer',parentId:'meter'},{id:'inv',name:'Inverter A',type:'inverter',parentId:'tx'},{id:'inv-b',name:'Inverter B',type:'inverter',parentId:'meter'},{id:'modules',name:'Modules',type:'module_group',parentId:'inv'}];
const windowState={title:'Scheduled inspection',startAt:'2026-06-01T12:00:00.000Z',endAt:'2026-06-01T14:00:00.000Z',timezone:'America/New_York',wholeSite:false,equipmentIds:['tx'],equipment:[equipment[1],equipment[2]],notes:'Isolate transformer and downstream inverter.',archived:false};
const window={id:'maintenance-window-1',version:1,state:windowState,updatedAt:'now'};
test('maintenance matches half-open dates and scoped equipment, distinguishing partial coverage',()=>{
 assert.deepEqual([...group.expandMaintenanceEquipment(['tx'],equipment)].map(e=>e.id),['tx','inv']);assert.throws(()=>group.expandMaintenanceEquipment(['foreign'],equipment),/valid equipment/);
 assert.equal(group.maintenanceMatch(issue('a'),window),'full');assert.equal(group.maintenanceMatch(issue('a',1,{endDateTime:'2026-06-01T15:00:00.000Z'}),window),'partial');
 assert.equal(group.maintenanceMatch(issue('a',1,{equipmentId:'inv-b'}),window),null);assert.equal(group.maintenanceMatch(issue('a',1,{startDateTime:windowState.endAt,endDateTime:'2026-06-01T15:00:00.000Z'}),window),null);
 assert.equal(group.maintenanceMatch(issue('a',1,{equipmentId:'meter',affectedEquipment:[{id:'inv'},{id:'inv-b'}]}),window),'partial');assert.equal(group.maintenanceMatch(issue('a'),{...window,state:{...windowState,archived:true}}),null);
});
function maintenanceApi(db){db.sqlite.prepare('INSERT INTO site_settings (id,name) VALUES (?,?)').run('site','Test');db.sqlite.prepare('INSERT INTO site_settings (id,name) VALUES (?,?)').run('other','Other');for(const e of equipment)db.sqlite.prepare('INSERT INTO equipment_assets (id,site_id,parent_id,type,name,external_id) VALUES (?,?,?,?,?,?)').run(e.id,'site',e.parentId,e.type,e.name,e.id);return loadSource('app/api/maintenance-windows/route.ts',[],{...group,...time,getDatabaseBinding:()=>db,activeHistory:async()=>({timezone:'America/New_York'})});}
test('maintenance windows persist one scoped record, preserve equipment snapshots and retain version history',async()=>{
 const db=database(),api=maintenanceApi(db),body={siteId:'site',id:crypto.randomUUID(),changeId:crypto.randomUUID(),baseVersion:0,state:windowState};
 assert.equal((await post(api,body)).status,200);assert.equal((await post(api,body)).status,200);assert.equal(db.sqlite.prepare('SELECT count(*) n FROM maintenance_window_changes').get().n,1);
 db.sqlite.prepare('UPDATE equipment_assets SET parent_id=? WHERE id=?').run('tx','inv-b');
 const edit={...body,changeId:crypto.randomUUID(),baseVersion:1,state:{...windowState,notes:'Updated inspection note.'}};assert.equal((await post(api,edit)).status,200);
 let d=await (await api.GET(new Request(`https://test/api?siteId=site&id=${body.id}`))).json();assert.equal(d.windows[0].version,2);assert.deepEqual(d.windows[0].state.equipment.map(e=>e.id).sort(),['inv','tx']);assert.equal(d.audit.length,2);
 assert.equal((await post(api,{...edit,changeId:crypto.randomUUID()})).status,409);
 const other=await (await api.GET(new Request('https://test/api?siteId=other'))).json();assert.equal(other.windows.length,0);
 assert.equal((await post(api,{...body,id:crypto.randomUUID(),changeId:crypto.randomUUID(),state:{...windowState,equipmentIds:['foreign']}})).status,409);
 assert.equal((await post(api,{...body,id:crypto.randomUUID(),changeId:crypto.randomUUID(),state:{...windowState,endAt:windowState.startAt}})).status,409);
 const archive={...edit,baseVersion:2,changeId:crypto.randomUUID(),state:{...edit.state,archived:true}};assert.equal((await post(api,archive)).status,200);d=await (await api.GET(new Request('https://test/api?siteId=site'))).json();assert.equal(d.windows[0].state.archived,true);assert.equal(db.sqlite.prepare('SELECT count(*) n FROM issue_event_reviews').get().n,0);
});
test('export includes versioned maintenance context without altering finding losses',()=>{
 const report=loadSource('app/report-methodology.ts',[],{XLSX,...review}),book=XLSX.utils.book_new();report.appendReportMethodology(book,{analysisId:'run',reviewFilter:'Exclude dismissed',reviews:{},reviewRetrievedAt:'now',issues:[issue('a')],maintenanceWindows:[window],maintenanceRetrievedAt:'2026-10-25T00:00:00Z'});
 const saved=XLSX.read(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));const rows=XLSX.utils.sheet_to_json(saved.Sheets['Maintenance windows']);assert.equal(rows[0].version,1);assert.equal(rows[0].notes,windowState.notes);assert.equal(JSON.parse(rows[0].equipmentSnapshot).length,2);const methodology=XLSX.utils.sheet_to_json(saved.Sheets.Methodology);assert.match(methodology.find(r=>r.Field==='Grouped review policy').Value,/separate findings/);
});

test('affected dates use measured intervals and exclude intervening low-light-only dates',()=>{
 const i=issue('gap',1,{endDateTime:'2026-06-04T00:00:00.000Z',intervalMinutes:60,intervalLosses:[{timestamp:'2026-06-01T12:00:00.000Z'},{timestamp:'2026-06-03T12:00:00.000Z'}]});
 assert.deepEqual([...group.findingDates(i)],['2026-06-01','2026-06-03']);
 assert.deepEqual([...group.findingDates({...i,startDateTime:'2026-06-03T00:00:00.000Z'})],['2026-06-03']);
});
test('operation IDs work in HTTP previews without randomUUID',()=>{
 const fallback=loadSource('app/review-groups.ts',[],{...time,crypto:{getRandomValues:array=>crypto.getRandomValues(array)}});
 const a=fallback.reviewOperationId(),b=fallback.reviewOperationId();assert.match(a,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);assert.notEqual(a,b);
});
