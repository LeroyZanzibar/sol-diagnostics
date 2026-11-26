// Synthetic-only shared fixture and smoke. Never imported by the application.
import assert from 'node:assert/strict';
import {join, resolve} from 'node:path';
import {LocalDatabase, LocalBucket} from '../selfhost/storage.mjs';

export const lossTimezone='America/New_York';
export function monthlyLossIssues(){
 const issue=(id,start,end,loss,patch={})=>({id,equipmentId:'inv1',equipmentName:'Inverter 1',equipmentType:'inverter',type:'Equipment outage',category:'Availability',name:'Inverter outage',description:'Synthetic monthly loss fixture',confidence:'confirmed',startDateTime:start,endDateTime:end,durationMinutes:(Date.parse(end)-Date.parse(start))/60000,estimatedLossKwh:loss,actualEnergyKwh:0,expectedEnergyKwh:loss,intervalMinutes:30,...patch});
 return [
  issue('january','2026-01-15T17:00:00.000Z','2026-01-15T17:30:00.000Z',123.25),
  issue('boundary','2026-02-01T04:30:00.000Z','2026-02-01T05:30:00.000Z',40.5,{intervalLosses:[
   {timestamp:'2026-02-01T04:30:00.000Z',intervalMinutes:30,lossKwh:10.25,countedLossKwh:10.25,actualKwh:0,expectedKwh:10.25},
   {timestamp:'2026-02-01T05:00:00.000Z',intervalMinutes:30,lossKwh:100.25,countedLossKwh:30.25,actualKwh:0,expectedKwh:100.25},
  ]}),
  issue('unreviewed','2026-01-20T17:00:00.000Z','2026-01-20T17:30:00.000Z',999),
  issue('unknown','2026-02-15T17:00:00.000Z','2026-02-15T17:30:00.000Z',null,{lossUnknown:true,expectedUnknown:true}),
 ];
}
export async function seedMonthlyLossPublication(f,{runId='monthly-current',issues=monthlyLossIssues(),publish=true}={}){
 const db=new LocalDatabase(join(f.directory,'sol-diagnostics.sqlite'),resolve('drizzle'));
 try{
  const importId=`monthly-loss-input-${f.siteId}`,objectKey=`analysis/${f.siteId}/jobs/${runId}/result.json`;
  db.sqlite.prepare(`INSERT OR IGNORE INTO telemetry_imports(id,site_id,file_name,object_key,file_size,row_count,valid_rows,timezone,mapping,detected_types,validation,timestamp_start,timestamp_end) VALUES(?,?,?,?,0,0,0,?,'{}','{}',?,?,?)`).run(importId,f.siteId,'synthetic-monthly-loss.csv','synthetic-retained-input',lossTimezone,JSON.stringify({intervalMinutes:30,timestampConvention:'start'}),'2026-01-01T05:00:00.000Z','2026-04-01T03:30:00.000Z');
  db.sqlite.prepare(`INSERT INTO analysis_runs(id,site_id,import_id,parser_version,model_revision,status,issue_count,analysis_object_key,completed_at) VALUES(?,?,?,28,'synthetic-monthly-model','completed',?,?,?)`).run(runId,f.siteId,importId,issues.length,objectKey,'2026-04-02T00:00:00.000Z');
  const payload={siteId:f.siteId,importId,parserVersion:28,modelRevision:'synthetic-monthly-model',timeZone:lossTimezone,generatedAt:'2026-04-02T00:00:00.000Z',
   import:{id:importId,fileName:'synthetic-monthly-loss.csv',createdAt:'2026-04-01T12:00:00.000Z',timestampStart:'2026-01-01T05:00:00.000Z',timestampEnd:'2026-04-01T03:30:00.000Z'},
   validation:{intervalMinutes:30,timestampConvention:'start'},summary:{timezone:lossTimezone},issueDatabase:{analysisRunId:runId,persistedIssueCount:issues.length},
   analysis:{timezone:lossTimezone,analysisIntervalMinutes:30,issues,recurringIssues:[]}};
  await new LocalBucket(db,join(f.directory,'objects')).put(objectKey,JSON.stringify(payload));
  if(publish)db.sqlite.prepare('INSERT OR REPLACE INTO performance_summaries(import_id,site_id,summary,processed_at) VALUES(?,?,?,?)').run(importId,f.siteId,JSON.stringify({analysisRunId:runId,objectKey,parserVersion:28,modelRevision:'synthetic-monthly-model'}),'2026-04-02T00:00:00.000Z');
  return payload;
 }finally{db.close();}
}

// Execute the identical program via `docker exec node -e` or a host child Node.
// Only native runtime modules shipped in the image are imported; no source TS,
// transpiler, copied fixture file, host dependencies or mounted expectations.
export const lossStorageProgram = `
import assert from 'node:assert/strict';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {LocalDatabase, LocalBucket} from './selfhost/storage.mjs';
const lossTimezone = ${JSON.stringify(lossTimezone)};
${monthlyLossIssues.toString()}
${seedMonthlyLossPublication.toString()}
const [mode, directory, siteId] = process.argv.slice(1);
assert.ok(directory && siteId);
if (mode === 'seed') {
  const db = new DatabaseSync(join(directory, 'sol-diagnostics.sqlite'), {readOnly: true});
  try {
    assert.equal(db.prepare('SELECT name FROM site_settings WHERE id=?').get(siteId)?.name,
      'Synthetic native monthly loss');
    for (const table of ['analysis_runs', 'telemetry_imports', 'performance_summaries', 'issue_event_reviews', 'monthly_unconfirmed_loss'])
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE site_id=?').get(siteId).n, 0,
        'Refuse to seed a populated site');
  } finally { db.close(); }
  await seedMonthlyLossPublication({directory, siteId}, {runId: 'monthly-native-current'});
  await seedMonthlyLossPublication({directory, siteId}, {runId: 'monthly-native-history', publish: false,
    issues: [{...monthlyLossIssues()[0], estimatedLossKwh: 99999, expectedEnergyKwh: 99999}]});
  console.log(JSON.stringify({siteId, runId: 'monthly-native-current'}));
} else {
  assert.equal(mode, 'read');
  const db = new DatabaseSync(join(directory, 'sol-diagnostics.sqlite'), {readOnly: true});
  try { console.log(JSON.stringify(db.prepare('SELECT * FROM monthly_unconfirmed_loss WHERE site_id=?').get(siteId) || null)); }
  finally { db.close(); }
}
`;

const fraction = (n, d = '1') => ({n, d});
const lossPath = siteId => `/api/monthly-data?siteId=${encodeURIComponent(siteId)}`;
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function assertPositiveLoss(snapshot) {
  const {confirmedLoss: confirmed, unconfirmedLoss: unconfirmed} = snapshot;
  for (const loss of [confirmed, unconfirmed]) {
    assert.equal(loss.analysisRunId, 'monthly-native-current', 'Historical unpublished loss is excluded');
    assert.equal(loss.timezone, lossTimezone);
    assert.deepEqual(loss.months['2026-03'].value, fraction('0'));
    assert.equal(loss.months['2026-04'], undefined, 'Uncovered month is not zero');
  }
  // Independent exact totals: 123.25 Confirmed; only the 10.25/30.25 counted
  // boundary ledger remains Unconfirmed. Neither the dismissed 999 nor the
  // unpublished 99999 belongs to either total, and raw 100.25 is not counted.
  assert.deepEqual(confirmed.months['2026-01'].value, fraction('493', '4'));
  assert.deepEqual(confirmed.months['2026-02'].value, fraction('0'));
  assert.deepEqual(unconfirmed.months['2026-01'].value, fraction('41', '4'));
  assert.deepEqual(unconfirmed.months['2026-02'].value, fraction('121', '4'));
  assert.equal(unconfirmed.months['2026-01'].unconfirmedCount, 1);
  assert.equal(unconfirmed.months['2026-02'].unconfirmedCount, 1);
  assert.equal(unconfirmed.months['2026-02'].unknownCount, 0);
}

export async function runMonthlyLossPersistenceSmoke({api, storage}) {
  const {site} = await api('/api/site-settings', 'POST', {
    name: 'Synthetic native monthly loss', country: 'US', latitude: '35.2', longitude: '-80.8',
  });
  const siteId = site.id;
  assert.deepEqual(await storage('seed', siteId), {siteId, runId: 'monthly-native-current'});
  assert.equal(await storage('read', siteId), null, 'No preexisting derived loss row');
  const initial = await api(lossPath(siteId));
  assert.deepEqual(initial.unconfirmedLoss.months['2026-01'].value, fraction('2265', '2'));
  assert.equal(initial.unconfirmedLoss.months['2026-01'].unconfirmedCount, 3);
  assert.equal(initial.unconfirmedLoss.months['2026-02'].value, null);
  assert.equal(initial.unconfirmedLoss.months['2026-02'].unknownCount, 1);
  for (const [issueId, status] of [['january', 'Confirmed'], ['unreviewed', 'Dismissed'], ['unknown', 'Dismissed']]) {
    const path = `/api/issue-reviews?siteId=${encodeURIComponent(siteId)}&runId=monthly-native-current&issueId=${issueId}`;
    const before = await api(path);
    const state = {...before.review.state, status,
      ...(status === 'Dismissed' ? {dismissalReason: 'Synthetic smoke exclusion'} : {})};
    const saved = await api('/api/issue-reviews', 'POST', {siteId, runId: 'monthly-native-current', issueId,
      baseVersion: before.review.version, state, note: 'Synthetic native monthly loss smoke'});
    const after = await api(path);
    assert.equal(after.review.state.status, status);
    assert.equal(after.review.version, saved.review.version);
  }
  const snapshot = await api(lossPath(siteId));
  assertPositiveLoss(snapshot);
  const stored = await storage('read', siteId);
  assert.ok(stored, 'Newly persisted monthly loss row');
  assert.equal(stored.calculation_version, 1);
  assert.deepEqual(JSON.parse(stored.payload_json), snapshot.unconfirmedLoss);
  const expected = freeze(JSON.parse(JSON.stringify({siteId, confirmedLoss: snapshot.confirmedLoss,
    unconfirmedLoss: snapshot.unconfirmedLoss, stored})));
  await verifyMonthlyLossPersistence({api, storage, expected});
  return {expected};
}

export async function verifyMonthlyLossPersistence({api, storage, expected}) {
  // MUST precede GET: monthly-data recomputes/upserts and could hide lost bytes.
  assert.deepEqual(await storage('read', expected.siteId), expected.stored,
    'Exact persisted monthly loss row must survive before recomputing GET');
  const snapshot = await api(lossPath(expected.siteId));
  assertPositiveLoss(snapshot);
  assert.deepEqual(snapshot.confirmedLoss, expected.confirmedLoss);
  assert.deepEqual(snapshot.unconfirmedLoss, expected.unconfirmedLoss);
  assert.deepEqual(await storage('read', expected.siteId), expected.stored,
    'Unchanged GET must retain the exact persisted monthly loss payload');
}
