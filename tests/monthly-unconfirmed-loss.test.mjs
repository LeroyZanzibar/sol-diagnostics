import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,finding,plain,gate} from './monthly-confirmed-loss-fixture.mjs';
const value=n=>({n:String(n),d:'1'});
const stored=f=>plain(f.db.sqlite.prepare('SELECT * FROM monthly_unconfirmed_loss WHERE site_id=?').get('site'));
test('persisted unconfirmed is effective Unreviewed plus Needs review, not stored status; current publication only',async t=>{
 const f=fixture(t),a=finding('a'),b=finding('b',{estimatedLossKwh:20,intervalLosses:undefined}),c=finding('c',{estimatedLossKwh:30,intervalLosses:undefined});
 await f.run({issues:[a,b,c]});await f.run({id:'history',publish:false,issues:[finding('history',{estimatedLossKwh:9999})]});
 await f.decide('current',b,'Confirmed');await f.decide('current',c,'Dismissed');
 let s=await f.read();assert.ok(s.unconfirmedLoss,'monthly API must expose persisted Unconfirmed loss');assert.deepEqual(s.unconfirmedLoss.months['2026-06'].value,value(10));assert.equal(s.unconfirmedLoss.months['2026-06'].unconfirmedCount,1);assert.deepEqual(s.confirmedLoss.months['2026-06'].value,value(20));
 assert.deepEqual(JSON.parse(stored(f).payload_json),s.unconfirmedLoss);const first=stored(f);await f.reopen();assert.deepEqual(stored(f),first);assert.deepEqual((await f.read()).unconfirmedLoss,s.unconfirmedLoss);
 await f.decide('current',a,'Confirmed');s=await f.read();assert.deepEqual(s.unconfirmedLoss.months['2026-06'].value,value(0));assert.notEqual(stored(f).review_identity,first.review_identity);
 await f.decide('current',a,'Dismissed');assert.deepEqual((await f.read()).unconfirmedLoss.months['2026-06'].value,value(0));await f.decide('current',a,'Unreviewed');assert.deepEqual((await f.read()).unconfirmedLoss.months['2026-06'].value,value(10));
 const changed=[a,{...b,evidenceSignature:'changed-b',estimatedLossKwh:200,expectedEnergyKwh:200},{...c,evidenceSignature:'changed-c',estimatedLossKwh:300,expectedEnergyKwh:300}];
 await f.run({id:'replacement',issues:changed});s=await f.read();assert.deepEqual(s.unconfirmedLoss.months['2026-06'].value,value(510));assert.deepEqual(s.confirmedLoss.months['2026-06'].value,value(0));assert.equal(s.unconfirmedLoss.months['2026-06'].unconfirmedCount,3);assert.notEqual(stored(f).publication_identity,first.publication_identity);
 await f.decide('replacement',changed[1],'Confirmed');await f.decide('replacement',changed[2],'Dismissed');s=await f.read();assert.deepEqual(s.unconfirmedLoss.months['2026-06'].value,value(10));assert.deepEqual(s.confirmedLoss.months['2026-06'].value,value(200));assert.deepEqual(s.unconfirmedLoss.months['2026-07'].value,value(0));assert.equal(s.unconfirmedLoss.months['2026-08'],undefined);
});
test('unknown loss is not zero; missing publication replaces persisted totals',async t=>{
 const f=fixture(t);await f.run({issues:[finding('unknown',{estimatedLossKwh:null,lossUnknown:true})]});const s=await f.read();assert.ok(s.unconfirmedLoss);assert.equal(s.unconfirmedLoss.months['2026-06'].value,null);assert.equal(s.unconfirmedLoss.months['2026-06'].unknownCount,1);
 f.db.sqlite.prepare('DELETE FROM performance_summaries').run();const missing=(await f.read()).unconfirmedLoss;assert.equal(missing.state,'missing');assert.deepEqual(missing.months,{});assert.deepEqual(JSON.parse(stored(f).payload_json),missing);
});

test('inherited review membership and direct Unreviewed override are partitioned once',async t=>{
 const f=fixture(t),a=finding('a'),b=finding('b'),parent={...finding('parent'),isRecurring:true,members:[a,b].map(i=>({id:i.id,eventKey:i.eventKey,evidenceSignature:i.evidenceSignature}))};
 await f.run({issues:[a,b,plain(a)],recurringIssues:[parent]});await f.decide('current',parent,'Confirmed');
 assert.deepEqual((await f.read()).unconfirmedLoss.months['2026-06'].value,value(0));
 await f.decide('current',a,'Unreviewed');const s=await f.read();assert.deepEqual(s.unconfirmedLoss.months['2026-06'].value,value(10));assert.equal(s.unconfirmedLoss.months['2026-06'].unconfirmedCount,1);assert.deepEqual(s.confirmedLoss.months['2026-06'].value,value(10));assert.deepEqual(JSON.parse(stored(f).payload_json),s.unconfirmedLoss);
});
for(const change of ['review','publication'])test(`${change} committed during read cannot persist or return obsolete partitions`,async t=>{
 const f=fixture(t),a=finding();await f.run();await f.read();const original=f.bindings().effectiveReviews,held=gate();let armed=true;t.after(()=>held.release());
 const work=f.read('site',{effectiveReviews:async(...args)=>{const result=await original(...args);if(armed){armed=false;await held.hold();}return result;}});
 await Promise.race([held.reached,work.then(()=>{throw Error('Read finished before race gate');})]);
 if(change==='review')await f.decide('current',a,'Confirmed');else f.db.sqlite.prepare('DELETE FROM performance_summaries').run();
 held.release();const s=await work;assert.deepEqual(JSON.parse(stored(f).payload_json),s.unconfirmedLoss);
 if(change==='review'){assert.deepEqual(s.unconfirmedLoss.months['2026-06'].value,value(0));assert.deepEqual(s.confirmedLoss.months['2026-06'].value,value(10));}
 else {assert.equal(s.unconfirmedLoss.state,'missing');assert.equal(s.confirmedLoss.state,'missing');assert.deepEqual(s.unconfirmedLoss.months,{});}
});
test('derived persistence failure does not invalidate independently available Confirmed math or saved utility',async t=>{
 const f=fixture(t);await f.run();await f.decide('current',finding(),'Confirmed');f.db.sqlite.exec('DROP TABLE monthly_unconfirmed_loss');
 const s=await f.read();assert.equal(s.unconfirmedLoss.state,'unavailable');assert.deepEqual(s.confirmedLoss.months['2026-06'].value,value(10));assert.equal(s.revision,0);
});

test('a retained stale or old-calculation materialization is never served without revalidation',async t=>{
 const f=fixture(t);await f.run();const first=await f.read();
 f.db.sqlite.prepare("UPDATE monthly_unconfirmed_loss SET calculation_version=0,publication_identity='obsolete',review_identity='obsolete',payload_json=? WHERE site_id='site'").run(JSON.stringify({...first.unconfirmedLoss,months:{'2026-06':{...first.unconfirmedLoss.months['2026-06'],value:value(99999)}}}));
 await f.reopen();const current=await f.read();assert.deepEqual(current.unconfirmedLoss,first.unconfirmedLoss);assert.equal(current.revision,first.revision);assert.equal(current.telemetry.sourceRevision,first.telemetry.sourceRevision);assert.equal(stored(f).calculation_version,1);assert.deepEqual(JSON.parse(stored(f).payload_json),current.unconfirmedLoss);
});
