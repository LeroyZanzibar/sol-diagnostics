import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fixture, finding, seedInput, plain, gate, databaseSnapshot, checkpoint} from './monthly-confirmed-loss-fixture.mjs';

const zero = {n:'0', d:'1'};
const metric = (value, confirmedCount = 1) => ({value, state:'complete', confirmedCount, unknownCount:0, reason:null});
const post = (api, body) => api.POST(new Request('https://test/api/monthly-data', {method:'POST', body:JSON.stringify(body)}));
const resultKey = id => `analysis/site/jobs/${id}/result.json`;

// These use production migrations, native SQLite, durable result bytes, savedAnalysis,
// real effective-review assessment and the actual monthly route. No detector/importer.
test('GET composes the current Confirmed loss and review-only changes leave monthly revisions and inputs unchanged', async t => {
  const f = fixture(t), a = finding(); await f.run(); await f.decide('current', a);
  const before = await f.runtime.read('site'), stored = databaseSnapshot(f.db);
  const first = await f.read();
  assert.ok(first.confirmedLoss, 'GET must expose confirmedLoss');
  assert.deepEqual(first.confirmedLoss.months['2026-06'], metric({n:'10', d:'1'}));
  assert.equal(first.confirmedLoss.state, 'current'); assert.equal(first.confirmedLoss.analysisRunId, 'current');
  assert.deepEqual(first.confirmedLoss.months['2026-07'], metric(zero, 0));
  assert.equal(first.confirmedLoss.months['2026-08'], undefined, 'outside saved analysis coverage is not zero');
  const {monthly_unconfirmed_loss:materialized,...unchanged}=databaseSnapshot(f.db);
  assert.deepEqual(unchanged,(({monthly_unconfirmed_loss,...rest})=>rest)(stored),'only derived Unconfirmed storage may change');
  assert.deepEqual(JSON.parse(materialized[0].payload_json),first.unconfirmedLoss);
  assert.deepEqual(first.unconfirmedLoss.months['2026-06'].value,zero);
  for (const [status, expected] of [['Dismissed', zero], ['Confirmed', {n:'10', d:'1'}]]) {
    await f.decide('current', a, status); const changed = await f.read();
    assert.deepEqual(changed.confirmedLoss.months['2026-06'].value, expected);
    const {confirmedLoss, unconfirmedLoss, ...native} = changed; assert.deepEqual(unconfirmedLoss.months['2026-06'].value,zero); assert.deepEqual(native, before);
  }
  await f.reopen(); assert.deepEqual((await f.read()).confirmedLoss.months['2026-06'].value, {n:'10', d:'1'});
});

test('no publication or historical-only runs remain missing and never materialize a performance database', async t => {
  const f = fixture(t); seedInput(f.db); await f.run({id:'historical', publish:false});
  const before = databaseSnapshot(f.db), files = readdirSync(join(f.root, 'performance'));
  const snapshot = await f.read(), loss = snapshot.confirmedLoss;
  const {monthly_unconfirmed_loss:materialized,...unchanged}=databaseSnapshot(f.db);
  assert.deepEqual(JSON.parse(materialized[0].payload_json),snapshot.unconfirmedLoss);
  assert.equal(snapshot.unconfirmedLoss.state,'missing');
  assert.deepEqual(unchanged,(({monthly_unconfirmed_loss,...rest})=>rest)(before));
  assert.ok(loss, 'missing publication still has an explicit loss availability object');
  assert.deepEqual({...loss, reason:'reason'}, {state:'missing', analysisRunId:null, timezone:null, months:{}, reason:'reason'});
  assert.ok(loss.reason); assert.deepEqual(readdirSync(join(f.root, 'performance')), files);
});

test('only the input-matching publication contributes, never newer history or another site', async t => {
  const f = fixture(t), a = finding();
  await f.run({id:'old', importId:'old-input', input:{createdAt:'2026-01-01'}}); await f.decide('old', a);
  await f.run({id:'current', importId:'new-input', issues:[{...a, estimatedLossKwh:10.05, evidenceSignature:'tolerated', intervalLosses:[{...a.intervalLosses[0], lossKwh:10.05, countedLossKwh:10.05}]}], input:{createdAt:'2026-07-01'}});
  await f.run({id:'newest-history', importId:'new-input', publish:false});
  await f.run({id:'foreign', siteId:'other', importId:'other-input', issues:[finding('foreign', {estimatedLossKwh:999})]});
  await f.decide('foreign', finding('foreign'), 'Confirmed', {siteId:'other'});
  const view = await f.loss(); assert.equal(view.analysisRunId, 'current'); assert.deepEqual(view.months['2026-06'].value, {n:'201', d:'20'});
  assert.deepEqual((await f.loss('other')).months['2026-06'].value, {n:'999', d:'1'});
  f.db.sqlite.prepare("UPDATE analysis_runs SET status='deleted' WHERE id='current'").run();
  const missing = await f.loss(); assert.equal(missing.state, 'unavailable'); assert.deepEqual(missing.months, {});
  f.db.sqlite.prepare("DELETE FROM performance_summaries WHERE site_id='site'").run();
  assert.equal((await f.loss()).state, 'missing');
});

test('sole retained publication is selected with a newer input; ambiguous publications do not guess', async t => {
  const f = fixture(t); await f.run({id:'old', importId:'old-input'}); await f.decide('old', finding());
  seedInput(f.db, {id:'latest', createdAt:'2026-09-01'});
  assert.equal((await f.loss()).analysisRunId, 'old');
  await f.run({id:'unrelated', importId:'middle', input:{createdAt:'2026-08-01'}});
  assert.equal((await f.loss()).state, 'missing');
});

test('current canonical identity outranks legacy imports without creating an absent site store', async t => {
  const f = fixture(t); await f.run({id:'canonical', importId:'revision-7'}); await f.decide('canonical', finding());
  await f.run({id:'legacy', importId:'legacy-input', input:{createdAt:'2099-01-01'}});
  let describes = 0;
  const manager = {hasData:id => id === 'site', site:id => {assert.equal(id, 'site'); return {describe:() => {describes++; return {revision:7, revisionId:'revision-7'};}, analysis:() => null};}};
  assert.equal((await f.loss('site', {optionalPerformanceStoreManager:() => manager})).analysisRunId, 'canonical');
  assert.ok(describes >= 2, 'canonical input is rechecked before returning');
});

test('real retained canonical revision selection is read-only and survives reopened SQLite',async t=>{
  const f=fixture(t),store=f.performance.site('site'),empty=store.describe(),revisionId=empty.revisionId.replace(/:0$/,':1');
  const filename=join(f.root,'performance',readdirSync(join(f.root,'performance')).find(name=>name.endsWith('.sqlite')));
  const native=new DatabaseSync(filename);t.after(()=>native.close());
  // Seed synthetic committed metadata in the production-migrated schema, without
  // running a telemetry import or detector. The selector reads only this head.
  const dataset={...empty,revision:1,revisionId,readingCount:2,timestampCount:2,timestampStart:'2026-06-01T00:00:00Z',timestampEnd:'2026-07-31T23:00:00Z'};
  native.prepare('INSERT INTO revisions VALUES (?,?,?)').run(1,revisionId,JSON.stringify(dataset));native.exec('UPDATE site_state SET head_revision=1');
  await f.run({id:'canonical',importId:revisionId});await f.decide('canonical',finding());
  await f.run({id:'legacy',importId:'latest-legacy',input:{createdAt:'2099-01-01'}});
  const retained=()=>plain(native.prepare("SELECT dataset_json FROM revisions ORDER BY revision").all());
  const shared=databaseSnapshot(f.db),before=retained();
  assert.equal((await f.loss()).analysisRunId,'canonical');assert.deepEqual(databaseSnapshot(f.db),shared);assert.deepEqual(retained(),before);
  await f.reopen();assert.equal((await f.loss()).analysisRunId,'canonical');assert.deepEqual(databaseSnapshot(f.db),shared);assert.deepEqual(retained(),before);
});

test('resolved Confirmed originals count once, parent reviews inherit and explicit Unreviewed/Dismissed children win', async t => {
  const f = fixture(t), a = finding('a'), b = finding('b'), c = finding('c'), retired = finding('retired', {type:'Underperformance', estimatedLossKwh:999});
  const parent = {...finding('parent', {estimatedLossKwh:9999}), isRecurring:true,
    members:[a,b,c].map(({id,eventKey,evidenceSignature}) => ({id,eventKey,evidenceSignature}))};
  await f.run({issues:[a,b,c,retired], recurringIssues:[parent]});
  await f.decide('current', parent, 'Confirmed', {recurringId:parent.id, recurringBasis:{calculationVersion:28,modelRevision:'model'}});
  await f.decide('current', a, 'Confirmed', {resolution:'Resolved', resolvedAt:'2026-06-03T00:00:00Z', resolutionNote:'Repaired'});
  await f.decide('current', b, 'Unreviewed'); await f.decide('current', c, 'Dismissed'); await f.decide('current', retired);
  assert.deepEqual((await f.loss()).months['2026-06'], metric({n:'10', d:'1'}));
  f.db.sqlite.prepare('DELETE FROM issue_event_reviews WHERE event_key=?').run(c.eventKey);
  assert.deepEqual((await f.loss()).months['2026-06'], metric({n:'20', d:'1'}, 2));
});

test('republication reuses effective review tolerance but materially changed evidence needs review', async t => {
  const f = fixture(t), a = finding(); await f.run({id:'baseline'}); await f.decide('baseline', a);
  const changed = value => ({...a, estimatedLossKwh:value, evidenceSignature:`signature-${value}`,
    intervalLosses:[{...a.intervalLosses[0], lossKwh:value, countedLossKwh:value}]});
  await f.run({id:'small', issues:[changed(10.05)]});
  assert.deepEqual((await f.loss()).months['2026-06'].value, {n:'201', d:'20'});
  await f.run({id:'material', issues:[changed(12)]});
  assert.deepEqual((await f.loss()).months['2026-06'], metric(zero, 0));
  await f.decide('material', changed(12));
  assert.deepEqual((await f.loss()).months['2026-06'].value, {n:'12', d:'1'});
});

test('site-local boundary allocation uses counted interval losses, saved cadence, and not recurring totals', async t => {
  const f = fixture(t), a = finding('boundary', {startDateTime:'2026-07-01T03:30:00Z', endDateTime:'2026-07-01T05:00:00Z', estimatedLossKwh:10,
    timezone:'UTC', intervalMinutes:undefined, intervalLosses:[{timestamp:'2026-07-01T03:30:00Z', lossKwh:40, countedLossKwh:10}, {timestamp:'2026-07-01T04:30:00Z', intervalMinutes:30, lossKwh:90, countedLossKwh:0}]});
  await f.run({issues:[a], timezone:'America/New_York', timestamps:['2026-06-01T04:00:00Z','2026-08-01T03:00:00Z']}); await f.decide('current', a);
  const loss = await f.loss(); assert.equal(loss.timezone, 'America/New_York');
  assert.deepEqual(loss.months['2026-06'], metric({n:'5',d:'1'})); assert.deepEqual(loss.months['2026-07'], metric({n:'5',d:'1'}));
  assert.equal(loss.months['2026-08'], undefined);
});

test('fall DST repeated instants remain distinct and month boundaries are site-local', async t => {
  const f = fixture(t), a = finding('fold', {startDateTime:'2026-11-01T03:30:00Z', endDateTime:'2026-11-01T07:00:00Z', estimatedLossKwh:20,
    intervalLosses:[{timestamp:'2026-11-01T03:30:00Z', lossKwh:10}, {timestamp:'2026-11-01T05:00:00Z', lossKwh:4}, {timestamp:'2026-11-01T06:00:00Z', lossKwh:6}]});
  await f.run({issues:[a], timezone:'America/New_York', timestamps:['2026-10-01T04:00:00Z','2026-12-01T04:00:00Z']}); await f.decide('current', a);
  const loss = await f.loss(); assert.deepEqual(loss.months['2026-10'].value,{n:'5',d:'1'}); assert.deepEqual(loss.months['2026-11'].value,{n:'15',d:'1'});
  assert.equal(loss.months['2026-12'], undefined);
});

test('unknown Confirmed contributions suppress known subtotals; zero remains measured zero', async t => {
  const f = fixture(t), known = finding('known'), unknown = finding('unknown', {estimatedLossKwh:null, lossUnknown:true}), z = finding('zero', {estimatedLossKwh:0, intervalLosses:undefined, startDateTime:'2026-07-01T00:00:00Z',endDateTime:'2026-07-01T01:00:00Z'});
  await f.run({issues:[known,unknown,z]}); for(const a of [known,unknown,z])await f.decide('current',a);
  const view = await f.loss(), june = view.months['2026-06']; assert.equal(june.value,null); assert.equal(june.state,'partial'); assert.equal(june.confirmedCount,2); assert.equal(june.unknownCount,1); assert.match(june.reason,/unknown|unavailable/i);
  assert.deepEqual(view.months['2026-07'],metric(zero));
});

test('cross-month missing/inconsistent ledgers are unknown, not whole-event duration proration', async t => {
  const f = fixture(t), a = finding('no-ledger', {startDateTime:'2026-06-30T23:00:00Z',endDateTime:'2026-07-01T02:00:00Z', intervalLosses:undefined});
  await f.run({issues:[a]}); await f.decide('current',a);
  const view = await f.loss(); for(const month of ['2026-06','2026-07']){assert.equal(view.months[month].value,null);assert.equal(view.months[month].unknownCount,1);}
});

test('single-month total needs no ledger and decimal/scientific values retain precision', async t => {
  const f = fixture(t), issues = [finding('a',{estimatedLossKwh:0.1,intervalLosses:undefined}),finding('b',{estimatedLossKwh:0.2,intervalLosses:undefined}),finding('c',{estimatedLossKwh:1e-7,intervalLosses:undefined})];
  await f.run({issues}); for(const a of issues)await f.decide('current',a);
  assert.deepEqual((await f.loss()).months['2026-06'].value, {n:'3000001',d:'10000000'});
});

test('provenance primary domain establishes coverage, not auxiliary scopes or current telemetry', async t => {
  const f = fixture(t);
  await f.run({issues:[], timestamps:['2026-01-01T00:00:00Z','2026-12-31T23:00:00Z'],payloadPatch:{provenance:{version:1,siteId:'site',revision:1,revisionId:'input',dependencyScope:'analysis-range',
    scopes:[{start:'2026-06-30T23:00:00Z',end:'2026-07-01T00:00:00Z',equipmentIds:['inverter'],measurements:['Energy']},{start:'2026-01-01T00:00:00Z',end:'2026-12-31T23:00:00Z',equipmentIds:['snow'],measurements:['Snow code']}],hashes:['a'.repeat(64),'b'.repeat(64)]}}});
  const view = await f.loss(); assert.deepEqual(Object.keys(view.months),['2026-06','2026-07']);assert.deepEqual(view.months['2026-06'],metric(zero,0));
});

test('saved import range is a coverage fallback, but absent authoritative coverage never invents zeros', async t => {
  const f = fixture(t); const payload=await f.run({issues:[],payloadPatch:{summary:{}}});
  assert.deepEqual(Object.keys((await f.loss()).months),['2026-06','2026-07']);
  await checkpoint.writeCheckpoint(f.bucket,resultKey('current'),{...payload,import:{id:'input'},validation:{}});
  // Removing the authoritative exact-import range also eliminates the fallback.
  f.db.sqlite.prepare("UPDATE telemetry_imports SET timestamp_start=NULL,timestamp_end=NULL WHERE id='input'").run();
  const result = await f.loss(); assert.equal(result.state,'unavailable');assert.deepEqual(result.months,{});assert.match(result.reason,/coverage|range/i);
});

test('unreadable pointers/payloads and exact identity mismatches fail closed without older fallback', async t => {
  const f = fixture(t);const payload=await f.run();await f.decide('current',finding());
  for(const patch of [{siteId:'other'},{importId:'other-input'},{issueDatabase:{analysisRunId:'other'}},{import:{id:'other-input'}},{analysis:{}}]){
    await checkpoint.writeCheckpoint(f.bucket,resultKey('current'),{...payload,...patch});const result=await f.loss();assert.equal(result.state,'unavailable');assert.deepEqual(result.months,{});
  }
  await checkpoint.writeCheckpoint(f.bucket,resultKey('current'),payload);
  f.db.sqlite.prepare("UPDATE performance_summaries SET summary='not-json' WHERE site_id='site'").run();assert.equal((await f.loss()).state,'unavailable');
  f.publish('current');await f.bucket.delete(resultKey('current'));assert.equal((await f.loss()).state,'unavailable');
});

test('unique legacy pointer ownership is admitted but an alias or deleted owner is not', async t => {
  const f=fixture(t);await f.run();await f.decide('current',finding());
  f.publish('current',{analysisRunId:undefined});assert.equal((await f.loss()).analysisRunId,'current');
  f.db.sqlite.prepare("INSERT INTO analysis_runs(id,site_id,import_id,parser_version,model_revision,status,issue_count,analysis_object_key) VALUES ('alias','other','input',28,'model','deleted',0,?)").run(resultKey('current'));
  assert.equal((await f.loss()).state,'unavailable');
});

test('legacy evidence is hydrated only when necessary and only in the exact saved run namespace', async t => {
  const f=fixture(t), key='analysis/site/jobs/current/evidence/0.json', a=finding('legacy',{startDateTime:'2026-06-30T23:00:00Z',endDateTime:'2026-07-01T01:00:00Z',intervalLosses:undefined,evidence:{evidenceKey:key}});
  const payload=await f.run({issues:[a]});await f.decide('current',a);
  await f.bucket.put(key,JSON.stringify({intervalLosses:[{timestamp:'2026-06-30T23:00:00Z',lossKwh:2},{timestamp:'2026-07-01T00:00:00Z',lossKwh:8}]}));
  const result=await f.loss();assert.deepEqual(result.months['2026-06'].value,{n:'2',d:'1'});assert.deepEqual(result.months['2026-07'].value,{n:'8',d:'1'});
  const foreign='analysis/other/jobs/foreign/evidence/0.json';await f.bucket.put(foreign,JSON.stringify({intervalLosses:[{timestamp:'2026-06-30T23:00:00Z',lossKwh:10}]}));
  payload.analysis.issues[0].evidence.evidenceKey=foreign;await checkpoint.writeCheckpoint(f.bucket,resultKey('current'),payload);
  const get=f.bucket.get.bind(f.bucket),reads=[];f.bucket.get=async key=>{reads.push(key);return get(key);};
  assert.equal((await f.loss()).months['2026-06'].value,null);assert.ok(!reads.includes(foreign));
});

for(const boundary of ['republish','delete','review','parent-review'])test(`late ${boundary} commits cannot return stale totals after effective-review reads`,async t=>{
  const f=fixture(t),a=finding(),parent={...finding('parent'),isRecurring:true,members:[{id:a.id,eventKey:a.eventKey,evidenceSignature:a.evidenceSignature}]};
  await f.run({recurringIssues:boundary==='parent-review'?[parent]:[]});await f.decide('current',boundary==='parent-review'?parent:a);
  const original=f.bindings().effectiveReviews,held=gate();t.after(()=>held.release());let armed=true,settled=false;
  const work=f.loss('site',{effectiveReviews:async(...args)=>{const result=await original(...args);if(armed){armed=false;await held.hold();}return result;}}).finally(()=>{settled=true;});
  await Promise.race([held.reached,work.then(()=>{throw Error('read finished before race gate');})]);assert.equal(settled,false);
  if(boundary==='republish'){await f.run({id:'replacement',issues:[{...a,estimatedLossKwh:15,evidenceSignature:'new-signature'}]});await f.decide('replacement',{...a,estimatedLossKwh:15,evidenceSignature:'new-signature'});}
  if(boundary==='delete'){f.db.sqlite.prepare("UPDATE analysis_runs SET status='deleted' WHERE id='current'").run();f.db.sqlite.prepare("DELETE FROM performance_summaries WHERE site_id='site'").run();}
  if(boundary==='review')await f.decide('current',a,'Dismissed');
  if(boundary==='parent-review')await f.decide('current',parent,'Dismissed');
  assert.equal(settled,false);held.release();const result=await work;
  if(boundary==='delete'){assert.notEqual(result.state,'current');assert.deepEqual(result.months,{});}
  else if(boundary==='republish'){assert.equal(result.analysisRunId,'replacement');assert.deepEqual(result.months['2026-06'].value,{n:'15',d:'1'});}
  else assert.deepEqual(result.months['2026-06'].value,zero);
});

test('bounded retry reports refreshing rather than returning continuously changing review totals',async t=>{
  const f=fixture(t),a=finding();await f.run();await f.decide('current',a);const original=f.bindings().effectiveReviews;let calls=0;
  const result=await f.loss('site',{effectiveReviews:async(...args)=>{const rows=await original(...args);await f.decide('current',a,++calls%2?'Dismissed':'Confirmed');return rows;}});
  assert.equal(result.state,'refreshing');assert.deepEqual(result.months,{});assert.ok(calls>=2&&calls<=3);assert.match(result.reason,/chang|refresh/i);
});

test('GET and successful POST readback include loss; preview and editable operations survive a source failure',async t=>{
  const f=fixture(t);await f.run();await f.decide('current',finding());
  const api=f.api({savedAnalysis:async()=>{throw Error('synthetic unavailable result');}});
  const body={siteId:'site',revision:0,action:'utility',rows:[{month:'2026-06',onPeak:'12.345',offPeak:null,unpaidEnergy:null,revenue:null,energyUsed:null,invoiceCost:null}]};
  const response=await post(api,body);assert.equal(response.status,200,await response.clone().text());const data=await response.json();
  assert.equal(data.utility['2026-06'].onPeak,'12.345');assert.ok(data.confirmedLoss);assert.equal(data.confirmedLoss.state,'unavailable');
  assert.deepEqual((await f.read()).confirmedLoss.months['2026-06'].value,{n:'10',d:'1'});
  const preview=await post(f.api(),{siteId:'site',revision:data.revision,action:'preview',configuration:data.configuration});const draft=await preview.json();assert.equal(preview.status,200);assert.equal(Object.hasOwn(draft,'confirmedLoss'),false);
  const saved=await post(f.api(),{siteId:'site',revision:data.revision,action:'configuration',configuration:data.configuration,previewToken:draft.token});assert.equal(saved.status,200);assert.equal((await saved.json()).confirmedLoss.state,'current');
  assert.equal((await post(f.api(),body)).status,409,'existing concurrency guard is preserved');
});

for(const boundary of ['result-read','legacy-evidence-read'])test(`${boundary} is fenced against a committed publication removal`,async t=>{
  const f=fixture(t),key='analysis/site/jobs/current/evidence/0.json';
  const a=boundary==='result-read'?finding():finding('legacy',{startDateTime:'2026-06-30T23:00:00Z',endDateTime:'2026-07-01T01:00:00Z',intervalLosses:undefined,evidence:{evidenceKey:key}});
  await f.run({issues:[a]});await f.decide('current',a);
  await f.bucket.put(key,JSON.stringify({intervalLosses:[{timestamp:'2026-06-30T23:00:00Z',lossKwh:2},{timestamp:'2026-07-01T00:00:00Z',lossKwh:8}]}));
  const original=f.bucket.get.bind(f.bucket),held=gate();let armed=true,settled=false;t.after(()=>held.release());
  f.bucket.get=async requested=>{const object=await original(requested);if(armed&&requested===(boundary==='result-read'?resultKey('current'):key)){armed=false;await held.hold();}return object;};
  const work=f.loss().finally(()=>{settled=true;});await Promise.race([held.reached,work.then(()=>{throw Error('read finished before race gate');})]);assert.equal(settled,false);
  f.db.sqlite.prepare("DELETE FROM performance_summaries WHERE site_id='site'").run();
  assert.equal(settled,false);held.release();const result=await work;assert.notEqual(result.state,'current');assert.deepEqual(result.months,{});
});

test('new explicit Unreviewed exception inserted during inherited review read invalidates the total',async t=>{
  const f=fixture(t),a=finding(),parent={...finding('parent'),isRecurring:true,members:[{id:a.id,eventKey:a.eventKey,evidenceSignature:a.evidenceSignature}]};
  await f.run({recurringIssues:[parent]});await f.decide('current',parent);
  const original=f.bindings().effectiveReviews,held=gate();let armed=true;t.after(()=>held.release());
  const work=f.loss('site',{effectiveReviews:async(...args)=>{const result=await original(...args);if(armed){armed=false;await held.hold();}return result;}});
  await Promise.race([held.reached,work.then(()=>{throw Error('read finished before race gate');})]);await f.decide('current',a,'Unreviewed');held.release();
  assert.deepEqual((await work).months['2026-06'],metric(zero,0));
});

test('single-month known totals never fetch legacy evidence and malformed zero sentinels remain unknown',async t=>{
  const f=fixture(t),key='analysis/site/jobs/current/evidence/unused.json',known=finding('known',{intervalLosses:undefined,evidence:{evidenceKey:key}}),
    unknown=finding('unknown',{estimatedLossKwh:0,lossUnknown:true}),absent=finding('absent',{estimatedLossKwh:undefined});
  await f.run({issues:[known,unknown,absent]});for(const a of [known,unknown,absent])await f.decide('current',a);
  const original=f.bucket.get.bind(f.bucket),reads=[];f.bucket.get=async key=>{reads.push(key);return original(key);};
  const result=await f.loss();assert.equal(result.months['2026-06'].value,null);assert.equal(result.months['2026-06'].unknownCount,2);assert.equal(result.months['2026-06'].confirmedCount,3);assert.ok(!reads.includes(key));
});

test('review fences span every query batch and ignore irrelevant other-site decisions',async t=>{
  const f=fixture(t),issues=Array.from({length:85},(_,index)=>finding(`item-${String(index).padStart(3,'0')}`));
  await f.run({issues});for(const a of issues)await f.decide('current',a);
  assert.deepEqual((await f.loss()).months['2026-06'],metric({n:'850',d:'1'},85));
  const original=f.bindings().effectiveReviews;let once=true;
  const result=await f.loss('site',{effectiveReviews:async(...args)=>{const result=await original(...args);if(once){once=false;await f.decide('current',issues[84],'Dismissed');}return result;}});
  assert.deepEqual(result.months['2026-06'],metric({n:'840',d:'1'},84));
  await f.run({id:'foreign',siteId:'other',importId:'foreign-input'});
  let calls=0;const unchanged=await f.loss('site',{effectiveReviews:async(...args)=>{const result=await original(...args);calls++;await f.decide('foreign',finding(),'Confirmed',{siteId:'other'});return result;}});
  assert.equal(calls,1);assert.deepEqual(unchanged.months['2026-06'],metric({n:'840',d:'1'},84));
});

test('retained duplicated original identities cannot double-count and conflicting duplicates fail closed',async t=>{
  const f=fixture(t),a=finding();const payload=await f.run({issues:[a,plain(a)]});await f.decide('current',a);
  assert.deepEqual((await f.loss()).months['2026-06'],metric({n:'10',d:'1'}));
  payload.analysis.issues[1].estimatedLossKwh=20;await checkpoint.writeCheckpoint(f.bucket,resultKey('current'),payload);
  assert.equal((await f.loss()).state,'unavailable');
});

test('a saved full-result count mismatch is unavailable, never a fabricated no-confirmations zero',async t=>{
  const f=fixture(t);const payload=await f.run();await f.decide('current',finding());
  payload.analysis.issues=[];await checkpoint.writeCheckpoint(f.bucket,resultKey('current'),payload);
  const result=await f.loss();assert.equal(result.state,'unavailable');assert.deepEqual(result.months,{});
});
