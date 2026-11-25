import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {LocalDatabase, LocalBucket} from '../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../selfhost/performance-store.mjs';
import {MonthlyService} from '../selfhost/monthly-rollups.mjs';
import * as domain from '../app/monthly-domain.mjs';
import {loadSource} from './source-module.mjs';

export const plain = value => JSON.parse(JSON.stringify(value));
export const load = (path, bindings = {}) => loadSource(path, [], {Error, TypeError, ...bindings});
export const review = load('app/issue-review.ts');
export const checkpoint = load('app/api/performance-summary/checkpoint-storage.ts');
const time = load('app/telemetry-time.ts');
const periods = load('app/issue-periods.ts', time);
const visibility = load('app/issue-visibility.ts');
const availability = load('app/api/analysis-history/availability.ts');
const cleanup = load('db/depot-performance-cleanup.ts');

export function finding(id = 'finding', patch = {}) {
  return {id, eventKey: `event-${id}`, evidenceSignature: `signature-${id}`, equipmentId: 'inverter', equipmentName: 'Inverter',
    equipmentType: 'inverter', type: 'Equipment outage', category: 'Availability', name: 'Inverter outage',
    startDateTime: '2026-06-01T12:00:00.000Z', endDateTime: '2026-06-01T13:00:00.000Z', durationMinutes: 60,
    estimatedLossKwh: 10, actualEnergyKwh: 0, expectedEnergyKwh: 10, intervalMinutes: 60,
    intervalLosses: [{timestamp: '2026-06-01T12:00:00.000Z', lossKwh: 10, countedLossKwh: 10, actualKwh: 0, expectedKwh: 10}], ...patch};
}

export function seedInput(db, {id = 'input', siteId = 'site', createdAt = '2026-06-01T00:00:00.000Z', timezone = 'UTC',
  start = '2026-06-01T00:00:00.000Z', end = '2026-07-31T23:00:00.000Z', status = 'imported', intervalMinutes = 60} = {}) {
  db.sqlite.prepare('INSERT OR IGNORE INTO site_settings(id,name) VALUES (?,?)').run(siteId, `Synthetic ${siteId}`);
  db.sqlite.prepare(`INSERT OR IGNORE INTO telemetry_imports(id,site_id,file_name,object_key,file_size,row_count,valid_rows,status,timezone,timestamp_start,timestamp_end,mapping,detected_types,validation,created_at)
    VALUES (?,?,?,'synthetic-unused-input',0,2,2,?,?,?,?, '{}','{}',?,?)`).run(id, siteId, 'synthetic.csv', status, timezone, start, end, JSON.stringify({intervalMinutes, timestampConvention: 'start'}), createdAt);
}

// Exported for the coordinator's integrated HTTP fixture. No importer or detector runs.
export async function seedConfirmedLossRun({db, bucket}, {id = 'current', siteId = 'site', importId = 'input', status = 'completed',
  issues = [finding()], recurringIssues = [], timezone = 'UTC', intervalMinutes = 60,
  timestamps = ['2026-06-01T00:00:00.000Z', '2026-07-31T23:00:00.000Z'], payloadPatch = {},
  objectKey = `analysis/${siteId}/jobs/${id}/result.json`, publish = true, input = {}} = {}) {
  seedInput(db, {id: importId, siteId, timezone, intervalMinutes, ...input});
  db.sqlite.prepare(`INSERT INTO analysis_runs(id,site_id,import_id,parser_version,model_revision,status,issue_count,analysis_object_key,completed_at)
    VALUES (?,?,?,28,'model',?,?,?,'2026-06-01T14:00:00.000Z')`).run(id, siteId, importId, status, issues.length, objectKey);
  const payload = {siteId, importId, parserVersion: 28, modelRevision: 'model', timeZone: timezone,
    import: {id: importId, timestampStart: timestamps[0] ?? null, timestampEnd: timestamps.at(-1) ?? null},
    validation: {intervalMinutes, timestampConvention: 'start'},
    summary: {timezone, intervalMinutes, timestamps}, issueDatabase: {analysisRunId: id, persistedIssueCount: issues.length},
    analysis: {issues, recurringIssues, analysisIntervalMinutes: intervalMinutes}, ...payloadPatch};
  await checkpoint.writeCheckpoint(bucket, objectKey, payload, {customMetadata: {siteId, importId}});
  await checkpoint.writeCheckpoint(bucket, objectKey.replace(/result\.json$/, 'review-index.json'), {...payload,
    analysis: {...payload.analysis, issues: payload.analysis.issues.map(({intervalLosses, evidence, ...issue}) => issue)}});
  if (publish) publishRun(db, id);
  return payload;
}

export function publishRun(db, id, patch = {}) {
  const row = db.sqlite.prepare('SELECT * FROM analysis_runs WHERE id=?').get(id);
  db.sqlite.prepare('INSERT OR REPLACE INTO performance_summaries(import_id,site_id,summary,processed_at) VALUES (?,?,?,?)')
    .run(row.import_id, row.site_id, JSON.stringify({objectKey: row.analysis_object_key, analysisRunId: id, ...patch}), 'published');
}

export async function seedConfirmedLossReview({db, bucket}, runId, issue, status = 'Confirmed', patch = {}) {
  const bindings = {...review, ...checkpoint, ...availability, getDatabaseBinding: () => db, getBucketBinding: () => bucket};
  const history = load('app/api/analysis-history/service.ts', bindings);
  const reviews = load('app/api/issue-reviews/service.ts', {...bindings, ...history});
  const baseVersion = db.sqlite.prepare('SELECT version FROM issue_event_reviews WHERE site_id=? AND event_key=?').get(patch.siteId || 'site', issue.eventKey)?.version || 0;
  const {siteId = 'site', ...statePatch} = patch;
  return reviews.saveReview(db, siteId, issue.eventKey, runId, baseVersion,
    {...review.blankReview(issue, issue.evidenceSignature), status, evidenceRunId: runId,
      ...(status === 'Dismissed' ? {dismissalReason: 'Duplicate finding'} : {}), ...statePatch}, 'Synthetic review', 'test');
}

export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sol-monthly-confirmed-')), filename = join(root, 'shared.sqlite');
  let db, bucket, performance, runtime;
  function open() {
    db = new LocalDatabase(filename, resolve('drizzle'));
    bucket = new LocalBucket(db, join(root, 'objects'));
    performance = new PerformanceStoreManager(join(root, 'performance'));
    runtime = new MonthlyService({database: db, bucket, performance});
  }
  open();
  t.after(async () => {await runtime.stop(); performance.close(); db.close(); rmSync(root, {recursive: true, force: true});});
  const f = {root, filename, get db() {return db;}, get bucket() {return bucket;}, get performance() {return performance;}, get runtime() {return runtime;},
    run: options => seedConfirmedLossRun({db, bucket}, options),
    publish: (id, patch) => publishRun(db, id, patch),
    decide: (runId, issue, status, patch) => seedConfirmedLossReview({db, bucket}, runId, issue, status, patch),
    async reopen() {await runtime.stop(); performance.close(); db.close(); open();},
    bindings(overrides = {}) {
      const bindings = {...domain, ...time, ...periods, ...visibility, ...cleanup, ...review, ...checkpoint, ...availability,
        getDatabaseBinding: () => db, getBucketBinding: () => bucket, optionalPerformanceStoreManager: () => performance};
      const history = load('app/api/analysis-history/service.ts', bindings);
      const reviews = load('app/api/issue-reviews/service.ts', {...bindings, ...history});
      return {...bindings, ...history, ...reviews, ...overrides};
    },
    service(overrides = {}) {
      return existsSync('app/api/monthly-data/confirmed-loss.ts') ? load('app/api/monthly-data/confirmed-loss.ts', f.bindings(overrides)) : {};
    },
    api(overrides = {}) {
      return load('app/api/monthly-data/route.ts', {...domain, getMonthlyRuntime: () => runtime, ...f.service(overrides)});
    },
    async read(siteId = 'site', overrides = {}) {
      const response = await f.api(overrides).GET(new Request(`https://test/api/monthly-data?siteId=${encodeURIComponent(siteId)}`));
      if (response.status !== 200) throw Error(`Monthly GET ${response.status}: ${await response.text()}`);
      return response.json();
    },
    async loss(siteId = 'site', overrides = {}) {return plain(await f.service(overrides).readMonthlyConfirmedLoss(siteId));},
  };
  return f;
}

export function gate() {
  let enter, release;
  const reached = new Promise(resolve => {enter = resolve;});
  const wait = new Promise(resolve => {release = resolve;});
  return {reached, release, async hold() {enter(); await wait;}};
}

export function databaseSnapshot(db) {
  return Object.fromEntries(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({name}) => [name, plain(db.sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())]));
}
