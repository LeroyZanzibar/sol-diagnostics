import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createOutageFixture, deliveryFactor, syntheticReadings} from './outage-only-fixture.mjs';

const near = (actual, expected, message) => assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-7,
  `${message}: expected ${expected}, received ${actual}`);
const utc = timestamp => new Date(timestamp).toISOString();
const ledger = analysis => analysis.issues.flatMap(issue => (issue.intervalLosses || []).map(point => ({issue, point})));
const at = (analysis, timestamp, predicate = () => true) => ledger(analysis).filter(({issue, point}) => utc(point.timestamp) === timestamp && predicate(issue));
const query = (siteId, runId) => new URLSearchParams({siteId, runId}).toString();
const reviewPath = (siteId, runId, issueId) => `/api/issue-reviews?${query(siteId, runId)}&issueId=${encodeURIComponent(issueId)}`;
const retainedTables = ['site_settings', 'equipment_assets', 'user_settings', 'telemetry_imports', 'issue_event_reviews',
  'issue_review_changes', 'maintenance_tasks', '__sol_migrations'];

// One production-HTTP workflow, with independent assertions so baseline RED can
// show both the obsolete analysis behavior and the missing DELETE route. No build
// is performed here; the parent owns the candidate build and final GREEN.
test('production HTTP: outage-only manual results and safe explicit saved-analysis deletion', {timeout: 240000}, async t => {
  const f = await createOutageFixture();
  const evidence = process.env.SOL_OUTAGE_HTTP_EVIDENCE ? resolve(process.env.SOL_OUTAGE_HTTP_EVIDENCE) : null;
  let fixtureData;
  t.after(async () => {
    await f.stop();
    if (evidence) {
      mkdirSync(evidence, {recursive: true});
      writeFileSync(join(evidence, 'http-transcript.json'), JSON.stringify(f.transcript, null, 2) + '\n');
      writeFileSync(join(evidence, 'server.log'), f.logs);
      if (fixtureData) writeFileSync(join(evidence, 'completed-fixture-results.json'), JSON.stringify(fixtureData, null, 2) + '\n');
    }
    await f.cleanup();
  });
  await f.start();
  const data = fixtureData = await f.seed();
  const {site, otherSite, older, retained, current, other, reviewedIssue} = data;
  const siteId = site.id;
  const historyPath = `/api/analysis-history?siteId=${siteId}`;
  const summaryPath = `/api/performance-summary?siteId=${siteId}`;
  const savedPath = runId => `/api/analysis-history?${query(siteId, runId)}`;
  const deletionPath = (runId, owner = siteId) => `/api/analysis-history?${query(owner, runId)}`;
  const inspectTables = () => f.inspect(db => Object.fromEntries(retainedTables.map(table =>
    [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()])));
  const pointers = () => f.inspect(db => db.prepare('SELECT * FROM performance_summaries ORDER BY import_id').all());
  const otherState = () => f.inspect(db => Object.fromEntries(['analysis_runs', 'analysis_jobs', 'performance_issue_occurrences', 'performance_issues', 'performance_summaries']
    .map(table => [table, db.prepare(`SELECT * FROM "${table}" WHERE site_id=? ORDER BY rowid`).all(otherSite.id)])));
  const canonicalState = () => Object.fromEntries([siteId, otherSite.id].map(id => [id, f.withStore(id, store => ({
    dataset: store.describe(), rows: [...store.rows()], imports: store.imports(),
    analyses: (id === siteId ? [older, retained, current] : [other]).map(run => store.analysis(run.runId)),
  }))]));
  const readReview = runId => f.api(reviewPath(siteId, runId, reviewedIssue.id));
  assert.equal((await readReview(retained.runId)).review.state.status, 'Confirmed');
  assert.equal((await readReview(retained.runId)).review.needsReview, false);
  const beforeRestart = await f.api(summaryPath);
  assert.equal(beforeRestart.issueDatabase.analysisRunId, current.runId);
  const originalHistory = await f.api(historyPath);
  assert.deepEqual(new Set(originalHistory.runs.map(run => run.id)), new Set([older.runId, retained.runId, current.runId]));
  assert.equal(originalHistory.runs.filter(run => run.is_current).length, 1);
  assert.equal(originalHistory.runs.find(run => run.is_current).id, current.runId);
  const originalRows = canonicalState();
  await f.stop(); await f.start();
  const reopened = await f.api(summaryPath);
  assert.equal(reopened.hasData, true);
  assert.equal(reopened.issueDatabase.analysisRunId, current.runId);
  assert.deepEqual(reopened.analysis, beforeRestart.analysis, 'A completed real result must survive restart');
  assert.deepEqual((await f.api(savedPath(older.runId))).analysis, older.saved.analysis, 'Older completed results stay immutable');
  assert.deepEqual(canonicalState(), originalRows);
  t.diagnostic(`SETUP COMPLETE: ${syntheticReadings().length} canonical readings per site; four real manual analyses completed, a review inherited, and saved results reopened.`);
  t.diagnostic('Observed issue types: ' + JSON.stringify([...new Set(current.saved.analysis.issues.map(issue => issue.type))]));

  await t.test('site reference is direct; DC allocation, unknown loss and telemetry stay distinct', async () => {
    const analysis = current.saved.analysis;
    const source = syntheticReadings();
    for (const timestamp of ['2026-05-02T10:00:00.000Z', '2026-05-02T11:00:00.000Z', '2026-05-02T12:00:00.000Z']) {
      const points = at(analysis, timestamp, issue => issue.type === 'Site outage');
      assert.equal(points.length, 1, `One site-outage interval at ${timestamp}`);
      const expected = source.find(row => row.timestamp === timestamp && row.measurement === 'Expected Production').value;
      const actual = source.find(row => row.timestamp === timestamp && row.equipmentId === 'meter').value;
      near(points[0].point.expectedKwh, expected, `Unmodified supplied Expected Production at ${timestamp}`);
      near(points[0].point.actualKwh, actual, `Measured site actual at ${timestamp}`);
      near(points[0].point.countedLossKwh ?? points[0].point.lossKwh, Math.max(0, expected - actual), `Direct site loss at ${timestamp}`);
      assert.equal(at(analysis, timestamp).filter(({issue, point}) => !issue.lossUnknown && (point.countedLossKwh ?? point.lossKwh) > 0).length, 1,
        'Covered inverter intervals cannot double-count a site outage');
    }
    const allocated = at(analysis, '2026-05-03T12:00:00.000Z', issue => issue.type === 'Equipment outage' && issue.equipmentId === 'inv1');
    assert.equal(allocated.length, 1);
    near(allocated[0].point.expectedKwh, 130 * 150 / (150 + 100), 'Unequal connected DC capacities allocate the site reference, not equal AC shares');
    near(allocated[0].point.countedLossKwh ?? allocated[0].point.lossKwh, 130 * 150 / (150 + 100), 'Inverter loss is converted to delivered energy exactly once');
    const [headroom] = at(analysis, '2026-05-03T13:00:00.000Z', issue => issue.type === 'Equipment outage' && issue.equipmentId === 'inv1');
    assert.ok(headroom);
    near(headroom.point.expectedKwh, 130 * 150 / (150 + 100), 'Allocation stays distinct from recoverable loss');
    near(headroom.point.countedLossKwh ?? headroom.point.lossKwh, (160 - 100) * deliveryFactor, 'Only recoverable transformer headroom is counted, with one delivery conversion');
    near(analysis.inverterExpectation.deliveryFactor, deliveryFactor, 'Configured delivery factor');
    assert.equal(analysis.transformerLimits.branches[0].limitKw, 160);
    for (const [timestamp, type] of [['2026-05-04T11:00:00.000Z', 'Site outage'], ['2026-05-04T14:00:00.000Z', 'Equipment outage']]) {
      const [finding] = at(analysis, timestamp, issue => issue.type === type);
      assert.ok(finding, `Missing expectation retains ${type}`);
      assert.equal(finding.issue.lossUnknown, true);
      assert.equal(finding.issue.estimatedLossKwh, null, 'Unknown loss must not become quantified zero');
      assert.notEqual(finding.issue.productionUnknown, true, 'Measured zero remains known actual production');
      assert.equal(finding.issue.actualEnergyKwh, 0);
      assert.equal(finding.issue.expectedUnknown, true);
      assert.equal(finding.issue.expectedEnergyKwh, null, 'Saved analysis must not display a missing reference as zero');
      assert.equal(finding.issue.lossPercent, null, 'Unknown loss has no percentage');
      const currentPublic = await f.api(summaryPath);
      const projected = currentPublic.analysis.issues.find(issue => issue.id === finding.issue.id);
      assert.ok(projected); assert.equal(projected.expectedEnergyKwh, null); assert.equal(projected.actualEnergyKwh, 0);
      const detail = await f.api(reviewPath(siteId, current.runId, finding.issue.id));
      assert.equal(detail.issueSummary.expectedUnknown, true);
      assert.equal(detail.issueSummary.expectedEnergyKwh, null, 'Review detail preserves unknown expectation');
      assert.equal(detail.issueSummary.actualEnergyKwh, 0, 'Review detail preserves measured zero actual');
      assert.equal(detail.issueSummary.estimatedLossKwh, null);
    }
    const [zero] = at(analysis, '2026-05-06T11:00:00.000Z', issue => issue.type === 'Site outage');
    assert.ok(zero, 'A supplied zero is not a missing reference');
    assert.equal(zero.issue.lossUnknown, false);
    near(zero.point.expectedKwh, 0, 'Known zero expectation');
    assert.equal(zero.issue.expectedEnergyKwh, 0);
    const zeroDetail = await f.api(reviewPath(siteId, current.runId, zero.issue.id));
    assert.equal(zeroDetail.issueSummary.expectedUnknown, false);
    assert.equal(zeroDetail.issueSummary.expectedEnergyKwh, 0, 'Known zero remains distinct in review detail');
    const [telemetry] = at(analysis, '2026-05-05T11:00:00.000Z', issue => issue.type === 'Site telemetry outage');
    assert.ok(telemetry); assert.equal(telemetry.issue.productionUnknown, true); assert.equal(telemetry.issue.actualEnergyKwh, null);
    assert.equal(telemetry.issue.estimatedLossKwh, null);
    assert.equal(at(analysis, '2026-05-05T14:00:00.000Z', issue => issue.type === 'Communication issue').length, 1);
    const profile = (await f.api('/api/user-settings')).user;
    try {
      await f.api('/api/user-settings', 'PUT', {...profile, minimumIssueLossKwh: '100000'});
      const filtered = await f.api(summaryPath);
      for (const timestamp of ['2026-05-04T11:00:00.000Z', '2026-05-04T14:00:00.000Z']) {
        assert.ok(filtered.analysis.issues.some(issue => issue.lossUnknown && utc(issue.startDateTime) <= timestamp && utc(issue.endDateTime) > timestamp),
          'Unknown-loss outages survive the saved user threshold');
      }
    } finally {await f.api('/api/user-settings', 'PUT', profile);}
  });

  await t.test('new saved reports contain only outages/telemetry and a concise method', () => {
    const allowed = new Set(['Site outage', 'Partial site outage', 'Equipment outage', 'Site telemetry outage', 'Equipment telemetry issue', 'Communication issue']);
    const analysis = current.saved.analysis;
    assert.ok(analysis.issues.every(issue => allowed.has(issue.type)), 'Retired underperformance findings must not be calculated into a new saved result');
    assert.deepEqual(analysis.recurringIssues || [], []);
    assert.equal(ledger(analysis).filter(({point}) => utc(point.timestamp) >= '2026-05-07T00:00:00.000Z').length, 0,
      'Ordinary sustained nonzero deficits are not outages');
    const method = analysis.baselineMethod;
    assert.equal(typeof method, 'string');
    assert.ok(method.trim().split(/\s+/).length <= 150, 'Method should be about four short sentences, not the legacy wall of text');
    assert.ok(method.split(/[.!?]+(?:\s|$)/).filter(value => value.trim()).length <= 5);
    assert.match(method, /daylight/i); assert.match(method, /Expected Production/); assert.match(method, /weather-adjusted/i);
    assert.match(method, /DC\/AC/); assert.match(method, /transformer/i); assert.match(method, /unknown/i);
    assert.doesNotMatch(method, /underperformance|regression|recurr|peer median|historical baseline/i);
  });

  await t.test('explicit deletion is protected, tombstoned, selective and restart-safe', async () => {
    const beforeGuards = inspectTables();
    const beforePointers = pointers();
    assert.equal((await f.request(deletionPath(older.runId), {method: 'DELETE', authenticated: false})).status, 401);
    assert.equal((await f.request(deletionPath(older.runId), {method: 'DELETE', headers: {Origin: 'https://untrusted.example'}})).status, 403);
    assert.deepEqual(inspectTables(), beforeGuards); assert.deepEqual(pointers(), beforePointers);

    // First substantive DELETE is an ordinary completed reviewed historical run:
    // baseline RED must reach the absent requested operation, not a setup error.
    const beforeDelete = {tables: inspectTables(), source: canonicalState(), other: otherState(), objects: f.objectManifest(), pointers: pointers(),
      review: await readReview(retained.runId), retained: await f.api(savedPath(retained.runId)), current: await f.readRetained(current.runId), older: await f.readRetained(older.runId)};
    const deletedOlder = await f.request(deletionPath(older.runId), {method: 'DELETE'});
    assert.equal(deletedOlder.status, 200, 'Completed saved analyses must support DELETE without a request body: ' + JSON.stringify(deletedOlder.data));
    assert.deepEqual(deletedOlder.data, {deleted: true, siteId, runId: older.runId, currentCleared: false});
    assert.deepEqual(f.objectManifest(), beforeDelete.objects, 'Deletion retains the exact result bytes and object catalogue');
    assert.deepEqual(inspectTables(), beforeDelete.tables, 'Deletion preserves settings, source metadata, reviews and migration state');
    assert.deepEqual(pointers(), beforeDelete.pointers, 'Removing an older run cannot clear another current pointer');
    assert.deepEqual(otherState(), beforeDelete.other); assert.deepEqual(canonicalState(), beforeDelete.source);
    assert.equal((await f.readRetained(older.runId)).row.status, 'deleted');
    assert.deepEqual((await f.readRetained(older.runId)).payload, beforeDelete.older.payload, 'Tombstoned review baseline bytes remain internally retained');
    assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM performance_issue_occurrences WHERE analysis_run_id=?').get(older.runId).n), 0);
    assert.equal((await f.api(summaryPath)).issueDatabase.analysisRunId, current.runId);
    assert.deepEqual((await readReview(retained.runId)).review, beforeDelete.review.review, 'Another analysis inherits the same reviewed baseline after its original run is deleted');
    assert.deepEqual((await f.api(savedPath(retained.runId))).analysis, beforeDelete.retained.analysis);
    const expectedError = async (path, status, code) => {
      const response = await f.request(path, {method: 'DELETE'});
      assert.equal(response.status, status, JSON.stringify(response)); assert.equal(response.data.code, code); assert.equal(typeof response.data.error, 'string');
    };
    await expectedError(`/api/analysis-history?siteId=${siteId}`, 400, 'INVALID_ANALYSIS_ID');
    await expectedError(`/api/analysis-history?siteId=${siteId}&runId=%20`, 400, 'INVALID_ANALYSIS_ID');
    await expectedError(deletionPath(current.runId) + '&runId=duplicate', 400, 'INVALID_ANALYSIS_ID');
    await expectedError(deletionPath(current.runId, otherSite.id), 404, 'ANALYSIS_NOT_FOUND');
    await f.withGuardState(current.runId, 'unfinished', async () => {
      assert.equal(f.inspect(db => db.prepare('SELECT status FROM analysis_runs WHERE id=?').get(current.runId).status), 'processing');
      await expectedError(deletionPath(current.runId), 409, 'ANALYSIS_NOT_COMPLETED');
    });
    await f.withGuardState(current.runId, 'in-use', async () => {
      const job = f.inspect(db => db.prepare('SELECT status,lease_until FROM analysis_jobs WHERE attempt_id=?').get(current.runId));
      assert.equal(job.status, 'processing'); assert.ok(job.lease_until > Date.now());
      await expectedError(deletionPath(current.runId), 409, 'ANALYSIS_IN_USE');
    });
    assert.equal((await f.readRetained(current.runId)).row.status, 'completed');
    assert.deepEqual((await f.readRetained(current.runId)).payload, beforeDelete.current.payload);
    assert.deepEqual(pointers(), beforeDelete.pointers);

    const alias = await f.seedLegacyAlias(current.runId);
    const cached = await f.request(summaryPath);
    assert.equal(cached.data.issueDatabase.analysisRunId, current.runId);
    const rawBeforeCurrent = f.objectManifest(), tablesBeforeCurrent = inspectTables();
    const currentDelete = await f.request(deletionPath(current.runId), {method: 'DELETE'});
    assert.equal(currentDelete.status, 200, JSON.stringify(currentDelete.data));
    assert.deepEqual(currentDelete.data, {deleted: true, siteId, runId: current.runId, currentCleared: true});
    assert.deepEqual(f.objectManifest(), rawBeforeCurrent); assert.deepEqual(inspectTables(), tablesBeforeCurrent);
    assert.equal((await f.readRetained(current.runId)).row.status, 'deleted');
    assert.deepEqual((await f.readRetained(current.runId)).payload, beforeDelete.current.payload);
    assert.deepEqual(pointers(), beforeDelete.pointers.filter(pointer => pointer.site_id !== siteId));
    assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM analysis_jobs WHERE attempt_id=?').get(current.runId).n), 0);
    assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM performance_issue_occurrences WHERE analysis_run_id=?').get(current.runId).n), 0);
    const repeatState = f.inspect(db => ({runs: db.prepare('SELECT * FROM analysis_runs ORDER BY id').all(), jobs: db.prepare('SELECT * FROM analysis_jobs ORDER BY id').all()}));
    const repeated = await f.request(deletionPath(current.runId), {method: 'DELETE'});
    assert.equal(repeated.status, 200); assert.deepEqual(repeated.data, {deleted: true, siteId, runId: current.runId, currentCleared: false});
    assert.deepEqual(f.inspect(db => ({runs: db.prepare('SELECT * FROM analysis_runs ORDER BY id').all(), jobs: db.prepare('SELECT * FROM analysis_jobs ORDER BY id').all()})), repeatState);

    async function assertDeletedReaders() {
      const runHistory = await f.api(historyPath);
      assert.deepEqual(runHistory.runs.map(run => run.id), [retained.runId]);
      assert.equal(runHistory.runs[0].is_current, false, 'Do not auto-promote an older snapshot');
      for (const runId of [older.runId, current.runId]) {
        for (const path of [savedPath(runId), `/api/analysis-freshness?${query(siteId, runId)}`, reviewPath(siteId, runId, reviewedIssue.id),
          `${summaryPath}&attemptId=${runId}`, `${summaryPath}&attemptId=${runId}&progressOnly=1`]) {
          const unavailable = await f.request(path);
          assert.equal(unavailable.status, 404, path + ': ' + JSON.stringify(unavailable.data));
          assert.equal(unavailable.data.analysis, undefined);
        }
      }
      for (const path of [summaryPath, `${summaryPath}&issueId=${encodeURIComponent(reviewedIssue.id)}`]) {
        const response = await f.request(path, {headers: {'If-None-Match': cached.etag || `"${alias.etag}"`}});
        assert.equal(response.status, 200, 'A deleted result must never produce 304/cache reuse');
        assert.equal(response.data.hasData, false); assert.equal(response.data.analysisRequired, true); assert.equal(response.data.analysis, undefined);
      }
      assert.equal((await f.api(`${summaryPath}&statusOnly=1`)).cacheStatus, 'stale');
      assert.deepEqual((await readReview(retained.runId)).review, beforeDelete.review.review);
      assert.deepEqual((await f.api(savedPath(retained.runId))).analysis, beforeDelete.retained.analysis);
      assert.equal((await f.api(`/api/performance-summary?siteId=${otherSite.id}`)).issueDatabase.analysisRunId, other.runId);
      assert.deepEqual(otherState(), beforeDelete.other); assert.deepEqual(canonicalState(), beforeDelete.source);
      assert.deepEqual(inspectTables(), tablesBeforeCurrent);
    }
    await assertDeletedReaders();
    const staleWrite = await f.request('/api/issue-reviews', {method: 'POST', body: {siteId, runId: older.runId, issueId: reviewedIssue.id,
      baseVersion: beforeDelete.review.review.version, state: beforeDelete.review.review.state, note: 'This delayed review must be refused.'}});
    assert.equal(staleWrite.status, 409); assert.deepEqual(inspectTables(), tablesBeforeCurrent);
    await f.stop(); await f.start(); await assertDeletedReaders();
    for (const run of [older, current]) {
      const retainedBytes = await f.readRetained(run.runId);
      assert.equal(retainedBytes.row.status, 'deleted');
      assert.equal(retainedBytes.payload.issueDatabase.analysisRunId, run.runId);
    }
    t.diagnostic('DELETE verified through real HTTP, exact pointer clearing, public read guards, retained reviewed evidence and server restart. No disk-reclamation claim.');
  });
});
