import test from 'node:test';
import assert from 'node:assert/strict';
import {seedMeasuredPoa} from './monthly-poa-fixture.mjs';
import {fixture} from '../monthly-client-fixture.mjs';
// Provider sidecar evidence is deliberately irrelevant to uploaded reporting.
// Analytical canonical data, including satellite-first arbitration, is untouched.
test('uploaded canonical values qualify independently of physical sensor evidence',async t=>{
 const f=fixture(t);await seedMeasuredPoa({database:f.db,bucket:f.service.bucket,performance:f.service.performance,root:f.root,siteId:'review-site',samples:[{timestamp:'2026-01-01T00:00:00.000Z',poa:600,satellite:900,expected:12},{timestamp:'2026-01-01T01:00:00.000Z',poa:null,satellite:500,expected:4}]});
 const store=f.service.performance.site('review-site'),before=[...store.rows()],head=store.describe();
 const v=await f.service.read('review-site');assert.deepEqual(v.telemetry.months['2026-01'].insolation.value,{n:'7',d:'5'});assert.deepEqual(v.telemetry.months['2026-01'].expected.value,{n:'16',d:'1'});assert.deepEqual([...store.rows()],before);assert.deepEqual(store.describe(),head);
 f.db.sqlite.prepare("UPDATE vcom_manual_jobs SET state='{}'").run();f.db.sqlite.prepare('DELETE FROM monthly_rollups').run();await f.reopen();assert.deepEqual((await f.service.read('review-site')).telemetry.months['2026-01'].insolation.value,{n:'7',d:'5'});
});
