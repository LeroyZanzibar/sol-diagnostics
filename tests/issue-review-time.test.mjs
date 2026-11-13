import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './source-module.mjs';
const telemetry=loadSource('app/telemetry-time.ts');
const time=loadSource('app/issue-review-time.ts',[],telemetry);
const review=loadSource('app/issue-review.ts');

test('resolution defaults to the recorded issue end, with seconds and milliseconds intact',()=>{
 const end='2026-06-08T17:23:45.123Z';
 const instant=time.issueResolutionTime(end,'America/New_York');
 assert.equal(instant,end);
 assert.equal(time.resolutionLocalTime(instant,'America/New_York'),'2026-06-08T13:23:45.123');
 assert.equal(time.resolutionTimeOptions('2026-06-08T13:23:45.123','America/New_York')[0].timestamp,end);
 assert.equal(time.issueResolutionTime('','America/New_York'),'');
});
test('site timezone conversion handles seasons and fractional offsets independently of browser timezone',()=>{
 for(const [instant,zone,local] of [
  ['2026-01-08T17:00:00.000Z','America/New_York','2026-01-08T12:00:00'],
  ['2026-06-08T17:00:00.000Z','America/New_York','2026-06-08T13:00:00'],
  ['2026-06-08T22:30:00.000Z','Asia/Kathmandu','2026-06-09T04:15:00'],
  ['2026-06-08T17:00:00.000Z','UTC','2026-06-08T17:00:00'],
 ]){
  assert.equal(time.resolutionLocalTime(instant,zone),local);
  assert.equal(time.resolutionTimeOptions(local,zone)[0].timestamp,instant);
  assert.equal(time.resolutionTimeError(local,zone,instant),'');
 }
 assert.equal(time.reviewTimezone('Bad/Zone'),'UTC');
});
test('both occurrences of repeated hours remain distinct and require a choice for manual edits',()=>{
 const zone='America/New_York',local='2026-11-01T01:30';
 const options=time.resolutionTimeOptions(local,zone);
 assert.deepEqual(Array.from(options,o=>o.timestamp),['2026-11-01T05:30:00.000Z','2026-11-01T06:30:00.000Z']);
 assert.match(options[0].label,/GMT-04:00/);assert.match(options[1].label,/GMT-05:00/);
 assert.match(time.resolutionTimeError(local,zone,''),/occurs twice/);
 for(const o of options){
  const instant=time.issueResolutionTime(o.timestamp,zone);
  assert.equal(time.resolutionTimeError(time.resolutionLocalTime(instant,zone),zone,instant),'');
 }
 const halfHour=time.resolutionTimeOptions('2026-04-05T01:45','Australia/Lord_Howe');
 assert.equal(halfHour.length,2);
 assert.equal(Date.parse(halfHour[1].timestamp)-Date.parse(halfHour[0].timestamp),30*60000);
});
test('nonexistent and invalid local dates cannot save an invented instant',()=>{
 assert.equal(time.resolutionTimeOptions('2026-03-08T02:30','America/New_York').length,0);
 assert.match(time.resolutionTimeError('2026-03-08T02:30','America/New_York',''),/does not exist/);
 assert.match(time.resolutionTimeError('2026-02-30T12:00','UTC',''),/valid resolution/);
 assert.match(time.resolutionTimeError('','UTC',''),/valid resolution/);
});
test('new analyst reviews default to Unknown even when detection suggests a listed cause',()=>{
 const state=review.blankReview({equipmentId:'inv',type:'outage',suspectedCause:'Snow',estimatedLossKwh:12,startDateTime:'2026-01-01T00:00Z',endDateTime:'2026-01-02T00:00Z'},'sig');
 assert.equal(state.classification,'Unknown');
 for(const classification of review.operationalCauses)assert.doesNotThrow(()=>review.validateReview({...state,classification},''));
 assert.throws(()=>review.validateReview({...state,classification:'Equipment fault'},''),/valid review/);
});
