import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync, readdirSync, copyFileSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';

const channel = {id: 'inverter-1/power', equipmentId: 'inverter-1', measurement: 'power', unit: 'kW'};
const other = {id: 'inverter-2/power', equipmentId: 'inverter-2', measurement: 'power', unit: 'kW'};
const irradiance = {id: 'sensor/irradiance', equipmentId: 'sensor', measurement: 'irradiance', unit: 'W/m²'};
const metadata = {source: 'csv', fileName: 'synthetic.csv', timezone: 'America/New_York', intervalMinutes: 15, modelRevision: 'model-1', sourceTimestampConvention: 'end'};
const ts = n => new Date(Date.UTC(2025, 0, 1, 0, n * 15)).toISOString();
const row = (n, value, definition = channel) => ({timestamp: ts(n), channel: {...definition}, value});
const options = (preview, extra = {}) => ({previewToken: preview.previewToken, approveOverlap: true, modelRevision: metadata.modelRevision, actor: 'test-operator', ...extra});
const errorCode = code => error => error.code === code && Number.isInteger(error.status) && error.status >= 400;
const values = (site, revision) => [...site.rows(revision)].map(r => [r.timestamp, r.channel.id, r.value]);
const whole = {start: ts(-100), end: ts(100)};
function fixture(t, siteId = 'exact/site-id') {
  const directory = mkdtempSync(join(tmpdir(), 'sol-performance-'));
  const manager = new PerformanceStoreManager(directory);
  t.after(() => {manager.close(); rmSync(directory, {recursive: true, force: true});});
  return {manager, site: manager.site(siteId), directory, siteId};
}
function filename(directory, siteId) {return join(directory, `${createHash('sha256').update(siteId).digest('hex')}.sqlite`);}
function inspect(directory, siteId, fn) {
  const db = new DatabaseSync(filename(directory, siteId));
  try {return fn(db);} finally {db.close();}
}
async function ingest(site, readings, extraMetadata = {}) {
  const preview = await site.stage({...metadata, ...extraMetadata}, readings);
  return site.commit(preview.stageId, options(preview, {modelRevision: preview.metadata.modelRevision}));
}

// Observe real SQLite connections, not substitutes for the storage adapter. The
// in-memory schema manifest is excluded; every file-backed connection is counted.
function trackConnections(t) {
  const live = new Map(), opened = [], closed = [];
  let peak = 0;
  const exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, 'exec', function(...args) {
    const file = this.prepare('PRAGMA database_list').get().file;
    if (file && !live.has(this)) {
      live.set(this, file); opened.push(file); peak = Math.max(peak, live.size);
    }
    return exec.apply(this, args);
  });
  t.mock.method(DatabaseSync.prototype, 'close', function(...args) {
    const result = close.apply(this, args);
    if (live.has(this)) {closed.push(live.get(this)); live.delete(this);}
    return result;
  });
  return {live, opened, closed, get peak() {return peak;}};
}
function visitSites(manager, prefix, count = 64) {
  for (let n = 0; n < count; n++) {
    const id = `${prefix}/${n}`;
    assert.equal(manager.site(id).describe().siteId, id);
  }
}
function assertNoSQLiteLease(directory, siteId) {
  inspect(directory, siteId, db => {
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK;');
    assert.deepEqual({...db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()}, {busy: 0, log: 0, checkpointed: 0});
  });
}

test('stage is durable but never writes canonical data; initial commit and audit match the contract', async t => {
  const {site, directory, siteId} = fixture(t);
  const empty = site.describe();
  assert.equal(empty.revision, 0);
  assert.equal(empty.readingCount, 0);
  assert.equal(empty.timestampStart, null);
  const preview = await site.stage(metadata, [row(1, 0), row(0, 4), row(0, null, other)]);
  assert.equal(preview.status, 'preview');
  assert.equal(preview.baseRevision, 0);
  assert.equal(preview.siteId, siteId);
  assert.deepEqual(preview.metadata, metadata);
  assert.deepEqual(preview.counts, {added: 3, overlapping: 0, changed: 0, identical: 0, blankPreserved: 0});
  assert.equal(preview.readingCount, 3);
  assert.equal(preview.channelCount, 2);
  assert.equal(preview.timestampStart, ts(0));
  assert.equal(preview.timestampEnd, ts(1));
  assert.deepEqual(site.describe(), empty);
  assert.deepEqual([...site.rows()], []);
  assert.deepEqual(site.imports(), []);
  inspect(directory, siteId, db => {
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM staged_readings').get().n, 3);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM readings').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM reading_versions').get().n, 0);
  });
  const result = site.commit(preview.stageId, options(preview, {approveOverlap: false}));
  assert.equal(result.revision, 1);
  assert.equal(result.siteId, siteId);
  assert.equal(result.stageId, preview.stageId);
  assert.deepEqual(result.counts, preview.counts);
  assert.deepEqual(site.preview(preview.stageId), {...preview, status: 'committed', result});
  const description = site.describe();
  assert.equal(description.readingCount, 3);
  assert.equal(description.timestampCount, 2);
  assert.equal(description.channelCount, 2);
  assert.equal(description.timezone, metadata.timezone);
  assert.equal(description.intervalMinutes, 15);
  assert.equal(description.revisionId, result.revisionId);
  assert.deepEqual(site.imports(), [{...result, metadata, actor: 'test-operator', overlapApproved: false}]);
});

const stageRaceSnapshot = (site, directory, siteId) => JSON.stringify({
  dataset: site.describe(), rows: [...site.rows()], imports: site.imports(),
  staged: inspect(directory, siteId, db => ({
    stages: db.prepare('SELECT * FROM stages ORDER BY stage_id').all(),
    readings: db.prepare('SELECT * FROM staged_readings ORDER BY stage_id,timestamp,channel_id').all(),
    channels: db.prepare('SELECT * FROM staged_channels ORDER BY stage_id,id').all(),
  })),
});

test('Q1 expected revision accepts the exact head and preserves omitted-option callers', async t => {
  const {site} = fixture(t);
  const initial = await site.stage(metadata, [row(0, 1)], {expectedRevision: 0});
  assert.equal(initial.baseRevision, 0);
  site.commit(initial.stageId, options(initial));
  const legacy = await site.stage(metadata, [row(1, 2)]);
  assert.equal(legacy.baseRevision, 1);
  site.commit(legacy.stageId, options(legacy));
  const explicit = await site.stage(metadata, [row(0, 3)], {expectedRevision: 2});
  assert.equal(explicit.baseRevision, 2);
  site.commit(explicit.stageId, options(explicit));
  const omitted = await site.stage(metadata, [row(2, 4)], undefined);
  assert.equal(omitted.baseRevision, 3);
  assert.deepEqual(values(site), [[ts(0), channel.id, 3], [ts(1), channel.id, 2]]);
});

for (const [label, expectedRevision] of [
  ['null', null], ['undefined', undefined], ['negative', -1], ['fraction', 0.5],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 1], ['NaN', NaN], ['infinity', Infinity],
  ['string', '0'], ['bigint', 0n], ['object', {}], ['boolean', true],
]) test(`Q1 expected revision rejects ${label} before allocating a stage or opening input`, async t => {
  const {site, directory, siteId} = fixture(t);
  const before = stageRaceSnapshot(site, directory, siteId);
  let opened = false;
  const input = {[Symbol.iterator]() {opened = true; return [row(0, 1)][Symbol.iterator]();}};
  await assert.rejects(site.stage(metadata, input, {expectedRevision}), error => error.code === 'INVALID_REVISION' && error.status === 400);
  assert.equal(opened, false);
  assert.equal(stageRaceSnapshot(site, directory, siteId), before);
  assertNoSQLiteLease(directory, siteId);
});

for (const asynchronous of [false, true]) test(`Q1 expected revision rejects stale and future heads before consuming ${asynchronous ? 'async' : 'sync'} input`, async t => {
  const {site, directory, siteId} = fixture(t);
  await ingest(site, [row(0, 1)]);
  const before = stageRaceSnapshot(site, directory, siteId);
  let opened = 0, consumed = 0;
  const input = {
    [asynchronous ? Symbol.asyncIterator : Symbol.iterator]() {opened++; return this;},
    next() {consumed++; const step = {done: consumed > 1, value: row(1, 2)}; return asynchronous ? Promise.resolve(step) : step;},
  };
  for (const expectedRevision of [0, 2, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(site.stage(metadata, input, {expectedRevision}), error => error.code === 'STALE_PREVIEW' && error.status === 409);
    assert.equal(opened, 0);
    assert.equal(consumed, 0);
    assert.equal(stageRaceSnapshot(site, directory, siteId), before);
  }
  assertNoSQLiteLease(directory, siteId);
});

test('Q1 expected revision is checked inside stage creation after an independent connection commits', async t => {
  const {site, directory, siteId} = fixture(t);
  const competitor = new PerformanceStoreManager(directory);
  t.after(() => competitor.close());
  const independent = competitor.site(siteId);
  const winner = await independent.stage(metadata, [row(0, 1)]);
  const exec = DatabaseSync.prototype.exec;
  let begins = 0, injected = false, before, opened = false;
  // Cleanup has its own transaction. Commit at the next BEGIN boundary, after
  // any check outside stage creation, then let the real transaction acquire it.
  t.mock.method(DatabaseSync.prototype, 'exec', function(sql, ...args) {
    if (!injected && sql === 'BEGIN IMMEDIATE' && this.prepare('PRAGMA database_list').get().file === filename(directory, siteId) && ++begins === 2) {
      injected = true;
      independent.commit(winner.stageId, options(winner));
      before = stageRaceSnapshot(independent, directory, siteId);
    }
    return exec.call(this, sql, ...args);
  });
  const input = {[Symbol.iterator]() {opened = true; return [row(1, 2)][Symbol.iterator]();}};
  await assert.rejects(site.stage(metadata, input, {expectedRevision: 0}), error => error.code === 'STALE_PREVIEW' && error.status === 409);
  assert.equal(injected, true);
  assert.equal(opened, false);
  assert.equal(stageRaceSnapshot(site, directory, siteId), before);
  assertNoSQLiteLease(directory, siteId);
});

test('Q1 expected revision remains immutable during async staging and releases cleanup after an independent commit', {timeout: 10000}, async t => {
  const {site, directory, siteId} = fixture(t);
  const competitor = new PerformanceStoreManager(directory);
  t.after(() => competitor.close());
  const independent = competitor.site(siteId);
  const winner = await independent.stage(metadata, [row(1000, 7)], {expectedRevision: 0});
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  let returned = false;
  async function* input() {
    try {
      for (let n = 0; n < 650; n++) yield row(n, n);
      entered.resolve(); await resume.promise; yield row(650, 650);
    } finally {returned = true;}
  }
  const stageOptions = {expectedRevision: 0};
  const pending = site.stage(metadata, input(), stageOptions);
  const rejected = assert.rejects(pending, error => error.code === 'STALE_PREVIEW' && error.status === 409);
  let stageId, before;
  try {
    await entered.promise;
    const loading = inspect(directory, siteId, db => db.prepare("SELECT stage_id,base_revision FROM stages WHERE status='loading'").get());
    stageId = loading.stage_id;
    assert.equal(loading.base_revision, 0);
    assertNoSQLiteLease(directory, siteId);
    independent.commit(winner.stageId, options(winner));
    before = JSON.stringify({dataset: independent.describe(), rows: [...independent.rows()], imports: independent.imports()});
    stageOptions.expectedRevision = independent.describe().revision;
  } finally {resume.resolve(); await rejected;}
  assert.equal(returned, true);
  assert.equal(JSON.stringify({dataset: site.describe(), rows: [...site.rows()], imports: site.imports()}), before);
  inspect(directory, siteId, db => {
    const saved = db.prepare('SELECT status,base_revision FROM stages WHERE stage_id=?').get(stageId);
    assert.equal(saved.status, 'canceled'); assert.equal(saved.base_revision, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM staged_readings').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM staged_channels').get().n, 0);
  });
  assertNoSQLiteLease(directory, siteId);
});

test('all overlaps, including identical values, require literal true approval', async t => {
  const {site} = fixture(t);
  await ingest(site, [row(0, 7)]);
  for (const value of [7, 8]) {
    const preview = await site.stage(metadata, [row(0, value)]);
    const before = site.describe();
    const missing = options(preview); delete missing.approveOverlap;
    for (const approval of [missing, options(preview, {approveOverlap: false}), options(preview, {approveOverlap: 'true'})]) {
      assert.throws(() => site.commit(preview.stageId, approval), errorCode('OVERLAP_APPROVAL_REQUIRED'));
      assert.deepEqual(site.describe(), before);
      assert.equal(site.preview(preview.stageId).status, 'preview');
    }
    site.commit(preview.stageId, options(preview));
  }
});

test('matching supplied keys only: blanks preserve, zero overwrites, omissions survive, new nulls retain coverage', async t => {
  const {site} = fixture(t);
  await ingest(site, [row(0, 10), row(1, 20), row(2, 30), row(0, 40, other), row(1, 50, other)]);
  const preview = await site.stage(metadata, [row(0, null), row(1, 0), row(0, 40, other), row(3, null), row(4, 'OFF')]);
  assert.deepEqual(preview.counts, {added: 2, overlapping: 3, changed: 1, identical: 1, blankPreserved: 1});
  site.commit(preview.stageId, options(preview));
  assert.deepEqual(values(site), [
    [ts(0), channel.id, 10], [ts(0), other.id, 40], [ts(1), channel.id, 0],
    [ts(1), other.id, 50], [ts(2), channel.id, 30], [ts(3), channel.id, null], [ts(4), channel.id, 'OFF'],
  ]);
  const nullAgain = await site.stage(metadata, [row(3, null)]);
  assert.deepEqual(nullAgain.counts, {added: 0, overlapping: 1, changed: 0, identical: 1, blankPreserved: 0});
});

test('identical duplicate keys dedupe after UTC normalization; conflicting duplicates fail atomically', async t => {
  const {site} = fixture(t);
  const duplicate = {...row(0, 1), timestamp: '2024-12-31T19:00:00-05:00'};
  const preview = await site.stage(metadata, [row(0, 1), duplicate]);
  assert.equal(preview.readingCount, 1);
  site.commit(preview.stageId, options(preview));
  const before = site.describe();
  await assert.rejects(site.stage(metadata, [row(1, 2), row(1, 3)]), errorCode('CONFLICTING_DUPLICATE'));
  assert.deepEqual(site.describe(), before);
});

test('nonfinite numbers, nonprimitive values, naive/invalid timestamps, and empty inputs fail', async t => {
  const {site} = fixture(t);
  for (const value of [NaN, Infinity, -Infinity, undefined, true, {}, [], 1n]) {
    await assert.rejects(site.stage(metadata, [row(0, value)]), errorCode('INVALID_READING'));
  }
  for (const timestamp of ['2025-01-01T00:00:00', 'not-a-date', '2025-02-30T00:00:00Z', '2025-01-01T24:00:00Z']) {
    await assert.rejects(site.stage(metadata, [{...row(0, 1), timestamp}]), errorCode('INVALID_READING'));
  }
  await assert.rejects(site.stage(metadata, []), errorCode('EMPTY_IMPORT'));
  assert.equal(site.describe().revision, 0);
});

test('stable channel definitions cannot change; distinct explicit IDs preserve independent channels', async t => {
  const {site} = fixture(t);
  await ingest(site, [row(0, 1)]);
  for (const definition of [
    {...channel, unit: 'W'}, {...channel, measurement: 'energy'}, {...channel, equipmentId: 'elsewhere'},
  ]) await assert.rejects(site.stage(metadata, [row(1, 2, definition)]), errorCode('CHANNEL_CONFLICT'));
  await assert.rejects(site.stage(metadata, [row(1, 1, other), row(2, 1, {...other, unit: 'W'})]), errorCode('CHANNEL_CONFLICT'));
  assert.equal(site.describe().channelCount, 1);
  const independent = {...channel, id: 'separate-explicit-channel'};
  await ingest(site, [row(0, 9, independent)]);
  assert.equal(site.describe().channelCount, 2);
  assert.deepEqual(values(site), [[ts(0), channel.id, 1], [ts(0), independent.id, 9]]);
});

test('token, saved base revision, and model revision guard the synchronous commit', async t => {
  const {site} = fixture(t);
  const preview = await site.stage(metadata, [row(0, 1)]);
  assert.throws(() => site.commit(preview.stageId, options(preview, {previewToken: 'é'.repeat(preview.previewToken.length)})), errorCode('INVALID_PREVIEW_TOKEN'));
  assert.throws(() => site.commit(preview.stageId, options(preview, {previewToken: 'wrong'})), errorCode('INVALID_PREVIEW_TOKEN'));
  assert.throws(() => site.commit(preview.stageId, options(preview, {modelRevision: 'model-2'})), errorCode('MODEL_REVISION_CHANGED'));
  assert.equal(site.describe().revision, 0);
  await ingest(site, [row(1, 2)]);
  assert.throws(() => site.commit(preview.stageId, options(preview)), errorCode('STALE_PREVIEW'));
  assert.equal(site.describe().readingCount, 1);
});

test('transaction failure after writes rolls back data, revisions, channels, audit and stage result', async t => {
  const {site, directory, siteId} = fixture(t);
  await ingest(site, [row(0, 1)]);
  const before = site.describe();
  const preview = await site.stage(metadata, [row(0, 2), row(1, 3, other)]);
  inspect(directory, siteId, db => db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON imports BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;"));
  assert.throws(() => site.commit(preview.stageId, options(preview)), /injected audit failure/);
  assert.deepEqual(site.describe(), before);
  assert.deepEqual(values(site), [[ts(0), channel.id, 1]]);
  assert.equal(site.imports().length, 1);
  assert.equal(site.preview(preview.stageId).status, 'preview');
  inspect(directory, siteId, db => {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM reading_versions').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM channels').get().n, 1);
    db.exec('DROP TRIGGER fail_import');
  });
  assert.equal(site.commit(preview.stageId, options(preview)).revision, 2);
});

test('cancel and expiration never change canonical state; stage payloads are reclaimed', async t => {
  const {site, directory, siteId} = fixture(t);
  const canceled = await site.stage(metadata, [row(0, 1)]);
  assert.equal(site.cancel(canceled.stageId).status, 'canceled');
  assert.equal(site.cancel(canceled.stageId).status, 'canceled');
  assert.throws(() => site.commit(canceled.stageId, options(canceled)), errorCode('STAGE_CANCELED'));
  const expired = await site.stage(metadata, [row(0, 1)]);
  t.mock.method(Date, 'now', () => Date.parse(expired.expiresAt) + 1);
  assert.throws(() => site.commit(expired.stageId, options(expired)), errorCode('STAGE_EXPIRED'));
  assert.equal(site.preview(expired.stageId).status, 'canceled');
  assert.equal(site.describe().revision, 0);
  inspect(directory, siteId, db => assert.equal(db.prepare('SELECT COUNT(*) n FROM staged_readings').get().n, 0));
});

test('commit replay is exact, including after another import and restart', async t => {
  const {site, manager, directory, siteId} = fixture(t);
  const preview = await site.stage(metadata, [row(0, 1)]);
  const result = site.commit(preview.stageId, options(preview));
  await ingest(site, [row(1, 2)]);
  assert.deepEqual(site.commit(preview.stageId, options(preview, {modelRevision: 'new-model', actor: 'different', approveOverlap: false})), result);
  manager.close();
  const reopened = new PerformanceStoreManager(directory); t.after(() => reopened.close());
  assert.deepEqual(reopened.site(siteId).commit(preview.stageId, options(preview)), result);
  assert.equal(reopened.site(siteId).imports().length, 2);
  assert.equal(reopened.site(siteId).cancel(preview.stageId).status, 'committed');
});

test('old revisions and rows iterators remain immutable across corrections and new channels', async t => {
  const {site} = fixture(t);
  await ingest(site, [row(0, 1), row(1, 2)]);
  const first = site.describe(1);
  const pinned = site.rows();
  assert.deepEqual(pinned.next().value, row(0, 1));
  await ingest(site, [row(1, 9), row(0, 3, other)]);
  assert.deepEqual([...pinned], [row(1, 2)]);
  assert.deepEqual([...site.rows(1)], [row(0, 1), row(1, 2)]);
  assert.deepEqual(site.describe(1), first);
  assert.equal(site.describe(2).channelCount, 2);
  assert.deepEqual([...site.rows(0)], []);
  assert.throws(() => site.describe(99), errorCode('REVISION_NOT_FOUND'));
  assert.throws(() => site.rows(-1), errorCode('INVALID_REVISION'));
});

test('fingerprints are semantic, inclusive, scoped and missingness-sensitive, not provenance-dependent', async t => {
  const {site} = fixture(t);
  await ingest(site, [row(0, 1), row(1, null), row(2, 3), row(1, 7, other), row(1, 9, irradiance)]);
  const scope = {start: ts(0), end: ts(1), equipmentIds: [channel.equipmentId], measurements: ['power']};
  const hash = site.fingerprint(1, scope);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.deepEqual([...site.rows(1, scope)], [row(0, 1), row(1, null)]);
  await ingest(site, [row(0, 1), row(2, 99), row(1, 99, other)], {source: 'api', fileName: 'api', sourceImportId: 'different'});
  assert.equal(site.fingerprint(2, scope), hash);
  assert.equal(site.fingerprint(1, scope), hash);
  assert.deepEqual([...site.rows(2, {...scope, equipmentIds: []})], []);
  await ingest(site, [row(1, 0)]);
  assert.notEqual(site.fingerprint(3, scope), hash);
  const {site: absent} = fixture(t, 'absent');
  await ingest(absent, [row(0, 1)]);
  assert.notEqual(absent.fingerprint(1, scope), hash);
  const {site: otherUnit} = fixture(t, 'unit');
  await ingest(otherUnit, [row(0, 1, {...channel, unit: 'W'}), row(1, null, {...channel, unit: 'W'})]);
  assert.notEqual(otherUnit.fingerprint(1, scope), hash);
});

test('site identifiers are exact, filenames are safe, and revision IDs are globally site-unique', async t => {
  const {manager, directory} = fixture(t, '../alpha');
  const identifiers = ['../alpha', 'alpha', 'Alpha', ' alpha', 'é', 'e\u0301'];
  const revisions = new Set();
  for (const [index, id] of identifiers.entries()) {
    const site = manager.site(id);
    await ingest(site, [row(0, index)]);
    assert.equal(site.describe().siteId, id);
    assert.equal(values(site)[0][2], index);
    revisions.add(site.describe().revisionId);
  }
  assert.equal(revisions.size, identifiers.length);
  const files = readdirSync(directory).filter(name => name.endsWith('.sqlite'));
  assert.equal(files.length, identifiers.length);
  assert.ok(files.every(name => /^[a-f0-9]{64}\.sqlite$/.test(name)));
  assert.throws(() => manager.site(''), errorCode('INVALID_SITE_ID'));
});

test('persisted ownership refuses a copied database and symlink aliases', async t => {
  const {site, manager, directory, siteId} = fixture(t);
  await ingest(site, [row(0, 1)]); manager.close();
  copyFileSync(filename(directory, siteId), filename(directory, 'wrong-owner'));
  symlinkSync(filename(directory, siteId), filename(directory, 'symlink-owner'));
  const reopened = new PerformanceStoreManager(directory); t.after(() => reopened.close());
  assert.throws(() => reopened.site('wrong-owner'), errorCode('SITE_OWNERSHIP_MISMATCH'));
  assert.throws(() => reopened.site('symlink-owner'), errorCode('UNSAFE_DATABASE_PATH'));
  assert.equal(reopened.site(siteId).describe().readingCount, 1);
});

test('first commit fixes cadence and reporting timezone; later normalized sources may use another timezone', async t => {
  const {site} = fixture(t);
  await ingest(site, [row(0, 1)]);
  await ingest(site, [row(1, 2)], {timezone: 'UTC'});
  assert.equal(site.describe().timezone, metadata.timezone);
  assert.equal(site.imports()[0].metadata.timezone, 'UTC');
  await assert.rejects(site.stage({...metadata, intervalMinutes: 60}, [row(2, 3)]), errorCode('CADENCE_MISMATCH'));
  for (const invalid of [{timezone: 'Invalid/Timezone'}, {intervalMinutes: 0}, {intervalMinutes: 0.0000001}, {source: 'unknown'}, {modelRevision: ''}]) {
    await assert.rejects(site.stage({...metadata, ...invalid}, [row(2, 3)]), errorCode('INVALID_METADATA'));
  }
});

test('analysis provenance is immutable, idempotent across object-key ordering, site-bound and restart-safe', async t => {
  const {site, manager, directory, siteId} = fixture(t);
  await ingest(site, [row(0, 1)]);
  const provenance = {version: 1, siteId, revision: 1, revisionId: site.describe().revisionId, scopes: [whole], hashes: [site.fingerprint(1, whole)], dependencyScope: 'analysis-range'};
  site.recordAnalysis('run-1', provenance);
  site.recordAnalysis('run-1', Object.fromEntries(Object.entries(provenance).reverse()));
  assert.deepEqual(site.analysis('run-1'), provenance);
  const changed = {...provenance, scopes: [{...whole, end: ts(0)}]};
  assert.throws(() => site.recordAnalysis('run-1', changed), errorCode('ANALYSIS_CONFLICT'));
  assert.throws(() => site.recordAnalysis('foreign', {...provenance, siteId: 'foreign'}), errorCode('INVALID_PROVENANCE'));
  assert.equal(site.analysis('missing'), null);
  await ingest(site, [row(0, 2)]);
  assert.deepEqual(site.analysis('run-1'), provenance);
  manager.close();
  const reopened = new PerformanceStoreManager(directory); t.after(() => reopened.close());
  assert.deepEqual(reopened.site(siteId).analysis('run-1'), provenance);
});

test('streaming async stages yield without a transaction, release iterators on errors, and isolate concurrent imports', async t => {
  const {site, directory, siteId} = fixture(t);
  let resume, reached;
  const paused = new Promise(resolve => {reached = resolve;});
  const gate = new Promise(resolve => {resume = resolve;});
  let closed = false;
  async function* input() {
    try {
      for (let n = 0; n < 600; n++) yield row(n, n);
      reached(); await gate;
      yield row(600, 600);
    } finally {closed = true;}
  }
  const pending = site.stage(metadata, input());
  await paused;
  inspect(directory, siteId, db => {
    db.exec('BEGIN IMMEDIATE');
    assert.ok(db.prepare('SELECT COUNT(*) n FROM staged_readings').get().n >= 500);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM readings').get().n, 0);
    db.exec('ROLLBACK');
  });
  await ingest(site, [row(1000, 3)]);
  resume();
  await assert.rejects(pending, errorCode('STALE_PREVIEW'));
  assert.equal(closed, true);
  assert.equal(site.describe().readingCount, 1);
  let returned = false;
  async function* broken() {try {yield row(0, 1); yield row(0, Infinity);} finally {returned = true;}}
  await assert.rejects(site.stage(metadata, broken()), errorCode('INVALID_READING'));
  assert.equal(returned, true);
});

test('bounded previews, payload reclamation and iterator closure work for multi-batch input', async t => {
  const {site, directory, siteId} = fixture(t);
  function* readings() {for (let n = 0; n < 2100; n++) yield row(n, n);}
  await ingest(site, readings());
  const pinned = site.rows(1);
  assert.equal(pinned.next().value.value, 0);
  const preview = await site.stage(metadata, readings());
  assert.equal(preview.counts.identical, 2100);
  assert.ok(preview.samples.length > 0 && preview.samples.length <= 25);
  site.commit(preview.stageId, options(preview));
  assert.equal([...pinned].length, 2099);
  inspect(directory, siteId, db => assert.equal(db.prepare('SELECT COUNT(*) n FROM staged_readings').get().n, 0));
  const toClose = site.rows(); toClose.next(); site.close();
  assert.equal(toClose.next().done, true);
  assert.throws(() => site.describe(), errorCode('STORE_CLOSED'));
});

test('staged previews survive restart; metadata and returned objects cannot mutate saved state', async t => {
  const {site, manager, directory, siteId} = fixture(t);
  const mutable = {...metadata};
  const preview = await site.stage(mutable, [row(0, 1)]);
  mutable.fileName = 'mutated';
  preview.metadata.fileName = 'also-mutated';
  preview.counts.added = 99;
  assert.equal(site.preview(preview.stageId).metadata.fileName, metadata.fileName);
  assert.equal(site.preview(preview.stageId).counts.added, 1);
  manager.close();
  const reopened = new PerformanceStoreManager(directory); t.after(() => reopened.close());
  const saved = reopened.site(siteId).preview(preview.stageId);
  assert.equal(saved.metadata.fileName, metadata.fileName);
  reopened.site(siteId).commit(saved.stageId, options(saved));
  assert.equal(reopened.site(siteId).describe().readingCount, 1);
});

test('embedded additive migration preserves existing revisions and validates every reopen', async t => {
  const {site, manager, directory, siteId} = fixture(t);
  await ingest(site, [row(0, 1)]);
  const first = site.describe(); manager.close();
  inspect(directory, siteId, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    db.exec('DROP TABLE analyses; DELETE FROM __performance_migrations WHERE version=2; PRAGMA user_version=1;');
  });
  const upgraded = new PerformanceStoreManager(directory);
  assert.deepEqual(upgraded.site(siteId).describe(), first);
  upgraded.close();
  inspect(directory, siteId, db => {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM __performance_migrations').get().n, 2);
    db.exec('ALTER TABLE readings ADD COLUMN unexpected TEXT');
  });
  const rejected = new PerformanceStoreManager(directory); t.after(() => rejected.close());
  assert.throws(() => rejected.site(siteId), errorCode('INCOMPATIBLE_SCHEMA'));
  inspect(directory, siteId, db => assert.equal(db.prepare('SELECT COUNT(*) n FROM readings').get().n, 1));
});

test('multi-page readers are pinned before first next and remain pinned beyond their buffered page', async t => {
  const {site} = fixture(t);
  function* input() {for (let n = 0; n < 1300; n++) yield row(n, n);}
  await ingest(site, input());
  const untouched = site.rows();
  const active = site.rows(1);
  assert.equal(active.next().value.value, 0);
  await ingest(site, [row(600, -6), row(1299, -9), row(1400, 1)]);
  const remaining = [...active];
  assert.equal(remaining[599].value, 600);
  assert.equal(remaining.at(-1).value, 1299);
  assert.equal(remaining.length, 1299);
  assert.deepEqual([...untouched], [...input()]);
  assert.equal(site.describe(1).readingCount, 1300);
  assert.equal(site.describe(2).readingCount, 1301);
});

test('before, incoming and after values are retained for changed, identical, blank and absent keys', async t => {
  const {site, directory, siteId} = fixture(t);
  await ingest(site, [row(0, 8), row(1, 9), row(2, null)]);
  await ingest(site, [row(0, 0), row(1, null), row(2, null), row(3, null)]);
  inspect(directory, siteId, db => {
    const history = db.prepare('SELECT previous_value_json,incoming_value_json,value_json FROM reading_versions WHERE revision=2 ORDER BY timestamp').all();
    assert.deepEqual(history.map(r => [r.previous_value_json, r.incoming_value_json, r.value_json]), [['8', '0', '0'], ['9', 'null', '9'], ['null', 'null', 'null'], [null, 'null', 'null']]);
  });
});

test('two managers serialize staged revision gates and committed replay authoritatively', async t => {
  const {site, directory, siteId} = fixture(t);
  const second = new PerformanceStoreManager(directory); t.after(() => second.close());
  const otherConnection = second.site(siteId);
  const a = await site.stage(metadata, [row(0, 1)]);
  const b = await otherConnection.stage(metadata, [row(0, 2)]);
  const committed = site.commit(a.stageId, options(a));
  assert.throws(() => otherConnection.commit(b.stageId, options(b)), errorCode('STALE_PREVIEW'));
  assert.deepEqual(otherConnection.commit(a.stageId, options(a)), committed);
  assert.deepEqual(otherConnection.describe(), site.describe());
});

test('pending stage limits do not evict ready previews and cancellation frees capacity', async t => {
  const {site} = fixture(t);
  const previews = [];
  for (let n = 0; n < 8; n++) previews.push(await site.stage(metadata, [row(n, n)]));
  await assert.rejects(site.stage(metadata, [row(9, 9)]), errorCode('STAGE_CAPACITY'));
  for (const preview of previews) assert.deepEqual(site.preview(preview.stageId), preview);
  site.cancel(previews[0].stageId);
  const available = await site.stage(metadata, [row(9, 9)]);
  assert.equal(available.status, 'preview');
});

test('bounded strings, timestamp precision and scopes reject loss of semantic input', async t => {
  const {site} = fixture(t);
  await assert.rejects(site.stage(metadata, [row(0, 'x'.repeat(65_537))]), errorCode('INVALID_READING'));
  const longText = '界'.repeat(65_536);
  const accepted = await site.stage(metadata, [row(0, longText)]);
  site.cancel(accepted.stageId);
  await assert.rejects(site.stage(metadata, [{...row(0, 1), timestamp: '2025-01-01T00:00:00.000001Z'}]), errorCode('INVALID_READING'));
  await ingest(site, [row(0, 1)]);
  assert.throws(() => site.rows(1, {start: ts(1), end: ts(0)}), errorCode('INVALID_SCOPE'));
  assert.throws(() => site.rows(1, {...whole, measurements: 'power'}), errorCode('INVALID_SCOPE'));
  const numeric = site.fingerprint(1, whole);
  await ingest(site, [row(0, '1')]);
  assert.notEqual(site.fingerprint(2, whole), numeric);
});

test('analysis provenance rejects missing scope objects without saving malformed provenance', async t => {
  const {site, siteId} = fixture(t);
  await ingest(site, [row(0, 1)]);
  const provenance = {version: 1, siteId, revision: 1, revisionId: site.describe().revisionId, scopes: [undefined], hashes: [site.fingerprint(1, whole)], dependencyScope: 'analysis-range'};
  assert.throws(() => site.recordAnalysis('invalid', provenance), errorCode('INVALID_PROVENANCE'));
  assert.throws(() => site.recordAnalysis('invalid', {...provenance, scopes: [whole], hashes: new Array(1)}), errorCode('INVALID_PROVENANCE'));
  assert.equal(site.analysis('invalid'), null);
});

test('retention bounds canceled preview metadata without evicting committed idempotency results', async t => {
  const {site, directory, siteId} = fixture(t);
  const preview = await site.stage(metadata, [row(0, 1)]);
  const result = site.commit(preview.stageId, options(preview));
  const canceled = await site.stage(metadata, [row(1, 2)]);
  site.cancel(canceled.stageId);
  inspect(directory, siteId, db => db.prepare(`WITH RECURSIVE copies(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM copies WHERE n<160)
    INSERT INTO stages SELECT stage_id||'-'||n,token,base_revision,status,metadata_json,created_at,expires_at,preview_json,result_json,canceled_reason FROM stages,copies WHERE stage_id=?`).run(canceled.stageId));
  assert.deepEqual(site.preview(preview.stageId).result, result);
  inspect(directory, siteId, db => assert.ok(db.prepare("SELECT COUNT(*) n FROM stages WHERE status='canceled'").get().n <= 128));
  assert.deepEqual(site.commit(preview.stageId, options(preview)), result);
});

test('closing an active async producer reclaims staging data and closes the input iterator', async t => {
  const {site, directory, siteId} = fixture(t);
  let resume, reached, returned = false;
  const gate = new Promise(resolve => {resume = resolve;});
  const paused = new Promise(resolve => {reached = resolve;});
  async function* input() {
    try {yield row(0, 1); reached(); await gate; yield row(1, 2);}
    finally {returned = true;}
  }
  const pending = site.stage(metadata, input());
  await paused;
  site.close(); resume();
  await assert.rejects(pending, errorCode('STORE_CLOSED'));
  assert.equal(returned, true);
  inspect(directory, siteId, db => assert.equal(db.prepare('SELECT COUNT(*) n FROM staged_readings').get().n, 0));
});

test('future versions, changed migration checksums, and foreign schemas fail closed without adopting them', async t => {
  for (const mutate of [
    db => db.exec('PRAGMA user_version=999'),
    db => db.exec("UPDATE __performance_migrations SET checksum='tampered' WHERE version=1"),
    db => db.exec('DROP INDEX reading_versions_revision'),
  ]) {
    const {site, manager, directory, siteId} = fixture(t);
    await ingest(site, [row(0, 1)]); manager.close();
    inspect(directory, siteId, mutate);
    const reopened = new PerformanceStoreManager(directory); t.after(() => reopened.close());
    assert.throws(() => reopened.site(siteId), errorCode('INCOMPATIBLE_SCHEMA'));
    inspect(directory, siteId, db => assert.equal(db.prepare('SELECT COUNT(*) n FROM readings').get().n, 1));
  }
  const {manager, directory} = fixture(t);
  const foreign = new DatabaseSync(filename(directory, 'foreign'));
  foreign.exec('CREATE TABLE unrelated(value TEXT)'); foreign.close();
  assert.throws(() => manager.site('foreign'), errorCode('INCOMPATIBLE_SCHEMA'));
});

test('idle lifecycle: sequential visits exceed 64 sites with bounded real connections and reusable retained handles', async t => {
  const connections = trackConnections(t);
  const {site, manager, directory, siteId} = fixture(t);
  const before = site.describe();
  visitSites(manager, 'sequential', 150);
  assert.equal(connections.peak, 64);
  assert.equal(connections.live.size, 64);
  assert.ok(connections.closed.includes(filename(directory, siteId)));
  assert.equal(site.closed, false);
  await Promise.resolve(); // A service context may retain this handle across awaits.
  assert.deepEqual(site.describe(), before);
  assert.equal(manager.site(siteId), site);
  assert.equal(connections.opened.filter(file => file === filename(directory, siteId)).length, 2);
  visitSites(manager, 'sequential', 150);
  assert.deepEqual(site.describe(), before);
  assert.equal(connections.peak, 64);
  manager.close();
  assert.equal(connections.live.size, 0);
});

test('idle lifecycle: actual use refreshes LRU order without closing the returned store object', t => {
  const connections = trackConnections(t);
  const {site, manager, directory, siteId} = fixture(t);
  visitSites(manager, 'lru', 63);
  site.describe();
  manager.site('lru/0').imports();
  manager.site('overflow').describe();
  assert.deepEqual(connections.closed, [filename(directory, 'lru/1')]);
  assert.ok([...connections.live.values()].includes(filename(directory, siteId)));
  assert.equal(site.closed, false);
  assert.equal(connections.peak, 64);
});

test('idle lifecycle: retained references preserve stages, exact-channel values, history, audit, fingerprints and analysis', async t => {
  const {site, manager, siteId} = fixture(t);
  const independent = {...channel, id: 'another physical channel'};
  const first = await site.stage(metadata, [row(0, 7), row(1, null), row(0, 8, independent)]);
  const receipt = site.commit(first.stageId, options(first));
  const original = site.describe(), audit = site.imports();
  const originalRows = [...site.rows()], hash = site.fingerprint(1, whole);
  const provenance = {version: 1, siteId, revision: 1, revisionId: original.revisionId, scopes: [whole], hashes: [hash], dependencyScope: 'analysis-range'};
  site.recordAnalysis('retained-run', provenance);
  const pending = await site.stage(metadata, [row(0, 0), row(0, null, independent), row(2, 9)]);
  const canceled = await site.stage(metadata, [row(4, 4)]);
  site.cancel(canceled.stageId);
  visitSites(manager, 'retention-pressure');
  await Promise.resolve();
  assert.equal(manager.site(siteId), site);
  assert.deepEqual(site.preview(pending.stageId), pending);
  assert.deepEqual(site.describe(), original);
  assert.deepEqual([...site.rows()], originalRows);
  assert.deepEqual(site.imports(), audit);
  assert.deepEqual(site.analysis('retained-run'), provenance);
  assert.equal(site.preview(canceled.stageId).status, 'canceled');
  assert.equal(site.fingerprint(1, whole), hash);
  assert.throws(() => site.commit(pending.stageId, options(pending, {previewToken: 'wrong'})), errorCode('INVALID_PREVIEW_TOKEN'));
  const correction = site.commit(pending.stageId, options(pending));
  visitSites(manager, 'retention-pressure');
  assert.deepEqual(site.commit(first.stageId, options(first)), receipt);
  assert.deepEqual(site.commit(pending.stageId, options(pending)), correction);
  assert.deepEqual(site.describe(1), original);
  assert.deepEqual([...site.rows(1)], originalRows);
  assert.deepEqual(site.imports()[1], audit[0]);
  assert.equal(site.imports().length, 2);
  assert.deepEqual(site.analysis('retained-run'), provenance);
  assert.equal(site.fingerprint(1, whole), hash);
  assert.deepEqual([...site.rows()], [row(0, 8, independent), row(0, 0), row(1, null), row(2, 9)]);
  visitSites(manager, 'retention-pressure');
  await Promise.resolve();
  const late = await site.stage(metadata, [row(3, 11)]);
  visitSites(manager, 'retention-pressure');
  assert.equal(site.commit(late.stageId, options(late)).revision, 3);
});

test('idle lifecycle: paused staging is never parked and holds no transaction or WAL reader', async t => {
  const connections = trackConnections(t);
  const {site, manager, directory, siteId} = fixture(t);
  const connection = [...connections.live.keys()][0];
  let resume, reached, returned = false;
  const gate = new Promise(resolve => {resume = resolve;});
  const paused = new Promise(resolve => {reached = resolve;});
  async function* input() {
    try {
      for (let n = 0; n < 650; n++) yield row(n, n);
      reached(); await gate; yield row(650, 650);
    } finally {returned = true;}
  }
  const pending = site.stage(metadata, input());
  try {
    await paused;
    visitSites(manager, 'during-stage');
    assert.equal(connections.live.has(connection), true);
    assert.equal(returned, false);
    assert.equal(site.closed, false);
    assertNoSQLiteLease(directory, siteId);
  } finally {resume(); await pending.catch(() => {});}
  const preview = await pending;
  assert.equal(returned, true);
  assert.equal(preview.readingCount, 651);
  visitSites(manager, 'during-stage');
  assert.equal(connections.live.has(connection), false);
  assert.equal(site.commit(preview.stageId, options(preview)).revision, 1);
  assert.equal(site.describe().readingCount, 651);
  assertNoSQLiteLease(directory, siteId);
});

test('idle lifecycle: an asynchronous producer return remains pinned until stage rejection settles', async t => {
  const connections = trackConnections(t);
  const {site, manager, directory, siteId} = fixture(t);
  const connection = [...connections.live.keys()][0];
  let resume, reached;
  const gate = new Promise(resolve => {resume = resolve;});
  const paused = new Promise(resolve => {reached = resolve;});
  const input = {
    [Symbol.asyncIterator]() {return this;},
    async next() {return {done: false, value: row(0, Infinity)};},
    async return() {reached(); await gate; return {done: true};},
  };
  const pending = site.stage(metadata, input);
  const rejected = assert.rejects(pending, errorCode('INVALID_READING'));
  try {
    await paused;
    visitSites(manager, 'producer-cleanup');
    assert.equal(connections.live.has(connection), true);
    assertNoSQLiteLease(directory, siteId);
  } finally {resume(); await rejected;}
  visitSites(manager, 'producer-cleanup');
  assert.equal(connections.live.has(connection), false);
  assert.equal(site.describe().revision, 0);
  assertNoSQLiteLease(directory, siteId);
});

test('idle lifecycle: paused multi-page readers remain connected and immutable without pinning WAL', async t => {
  const connections = trackConnections(t);
  const {site, manager, directory, siteId} = fixture(t);
  const connection = [...connections.live.keys()][0];
  const input = Array.from({length: 1300}, (_, n) => row(n, n));
  await ingest(site, input);
  const active = site.rows();
  assert.deepEqual(active.next().value, row(0, 0));
  visitSites(manager, 'during-read');
  assert.equal(connections.live.has(connection), true);
  await ingest(site, [row(600, -6), row(1299, -9), row(1400, -14)]);
  assertNoSQLiteLease(directory, siteId);
  assert.deepEqual([...active], input.slice(1));
  visitSites(manager, 'during-read');
  assert.equal(connections.live.has(connection), false);
  assert.equal(site.describe().readingCount, 1301);
  assertNoSQLiteLease(directory, siteId);
});

test('idle lifecycle: never-started iterators pin at creation, all-active capacity rejects safely and release permits retry', t => {
  const connections = trackConnections(t);
  const {site, manager, directory, siteId} = fixture(t);
  const stores = [site], readers = [site.rows()];
  for (let n = 1; n < 64; n++) {
    stores.push(manager.site(`pinned/${n}`));
    readers.push(stores[n].rows());
  }
  for (let n = 0; n < 2; n++) assert.throws(() => manager.site('all-active'), errorCode('STORE_CAPACITY'));
  assert.equal(connections.live.size, 64);
  assert.equal(connections.closed.length, 0);
  assert.equal(readdirSync(directory).filter(file => file.endsWith('.sqlite')).length, 64);
  assert.equal(readers[0].return().done, true);
  assert.equal(readers[0].next().done, true);
  const extra = manager.site('all-active'), extraReader = extra.rows();
  assert.deepEqual(connections.closed, [filename(directory, siteId)]);
  assert.throws(() => site.describe(), errorCode('STORE_CAPACITY'));
  assert.equal(site.closed, false);
  const error = new Error('consumer canceled before first next');
  assert.throws(() => extraReader.throw(error), error);
  assert.equal(site.describe().revision, 0);
  for (const reader of readers) assert.equal(reader.next().done, true);
  visitSites(manager, 'released-readers');
  assert.equal(connections.peak, 64);
  assert.equal(connections.live.size, 64);
  manager.close();
  assert.equal(connections.live.size, 0);
});

test('idle lifecycle: explicit site close and manager close are final even for parked references', async t => {
  const connections = trackConnections(t);
  const {site, manager, siteId} = fixture(t);
  await ingest(site, [row(0, 3)]);
  visitSites(manager, 'park-before-close');
  const opens = connections.opened.length;
  site.close(); site.close();
  assert.equal(connections.opened.length, opens, 'closing a parked store must not reopen it');
  assert.equal(site.closed, true);
  assert.throws(() => site.describe(), errorCode('STORE_CLOSED'));
  assert.throws(() => site.rows(), errorCode('STORE_CLOSED'));
  await assert.rejects(site.stage(metadata, [row(1, 2)]), errorCode('STORE_CLOSED'));
  const replacement = manager.site(siteId);
  assert.notEqual(replacement, site);
  assert.deepEqual([...replacement.rows()], [row(0, 3)]);
  visitSites(manager, 'park-before-close');
  manager.close(); manager.close();
  assert.equal(connections.live.size, 0);
  assert.equal(replacement.closed, true);
  assert.throws(() => replacement.describe(), errorCode('STORE_CLOSED'));
  assert.throws(() => replacement.rows(), errorCode('STORE_CLOSED'));
  assert.throws(() => manager.site(siteId), errorCode('STORE_CLOSED'));
  await assert.rejects(replacement.stage(metadata, [row(1, 2)]), errorCode('STORE_CLOSED'));
});

test('idle lifecycle: schema, ledger and ownership validation rerun after parking without leaking failed connections', async t => {
  const connections = trackConnections(t);
  const {site, manager, directory, siteId} = fixture(t);
  await ingest(site, [row(0, 3)]);
  const checksum = inspect(directory, siteId, db => db.prepare('SELECT checksum FROM __performance_migrations WHERE version=1').get().checksum);
  const indexSQL = inspect(directory, siteId, db => db.prepare("SELECT sql FROM sqlite_schema WHERE name='reading_versions_revision'").get().sql);
  const mutations = [
    [db => db.exec('PRAGMA user_version=999'), db => db.exec('PRAGMA user_version=2'), 'INCOMPATIBLE_SCHEMA'],
    [db => db.exec("UPDATE __performance_migrations SET checksum='tampered' WHERE version=1"), db => db.prepare('UPDATE __performance_migrations SET checksum=? WHERE version=1').run(checksum), 'INCOMPATIBLE_SCHEMA'],
    [db => db.exec('DROP INDEX reading_versions_revision'), db => db.exec(indexSQL), 'INCOMPATIBLE_SCHEMA'],
    [db => db.exec("UPDATE site_state SET site_id='foreign'"), db => db.prepare('UPDATE site_state SET site_id=?').run(siteId), 'SITE_OWNERSHIP_MISMATCH'],
  ];
  for (const [mutate, repair, code] of mutations) {
    visitSites(manager, 'schema-pressure');
    inspect(directory, siteId, mutate);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(() => site.describe(), errorCode(code));
      assert.equal([...connections.live.values()].includes(filename(directory, siteId)), false);
      assert.equal(site.closed, false);
    }
    inspect(directory, siteId, db => {assert.equal(db.prepare('SELECT COUNT(*) n FROM readings').get().n, 1); repair(db);});
    assert.deepEqual([...site.rows()], [row(0, 3)]);
    assert.equal(manager.site(siteId), site);
  }
});

test('idle lifecycle: reentrant caller validation cannot park a synchronous commit or a new reader', async t => {
  const connections = trackConnections(t);
  const {site, manager, directory, siteId} = fixture(t);
  const connection = [...connections.live.keys()][0];
  const preview = await site.stage(metadata, [row(0, 1)]);
  const approval = options(preview);
  let checked = false;
  Object.defineProperty(approval, 'actor', {get() {
    if (!checked) {
      checked = true;
      visitSites(manager, 'reentrant-validation');
      assert.equal(connections.live.has(connection), true);
    }
    return 'test-operator';
  }});
  assert.equal(site.commit(preview.stageId, approval).revision, 1);
  const scope = {...whole};
  Object.defineProperty(scope, 'start', {get() {
    visitSites(manager, 'reentrant-validation');
    assert.equal(connections.live.has(connection), true);
    return whole.start;
  }});
  const reader = site.rows(undefined, scope);
  assert.deepEqual([...reader], [row(0, 1)]);
  assertNoSQLiteLease(directory, siteId);
});

test('idle lifecycle: producer setup is pinned before calling caller-owned iterator factories', async t => {
  const connections = trackConnections(t);
  const {site, manager} = fixture(t);
  const connection = [...connections.live.keys()][0];
  const input = {
    [Symbol.iterator]() {
      visitSites(manager, 'producer-factory');
      assert.equal(connections.live.has(connection), true);
      return [row(0, 1)][Symbol.iterator]();
    },
  };
  const preview = await site.stage(metadata, input);
  assert.equal(site.commit(preview.stageId, options(preview)).revision, 1);
});

test('idle lifecycle: a never-started nonempty reader pins its revision and connection until return', async t => {
  const connections = trackConnections(t);
  const {site, manager, directory, siteId} = fixture(t);
  const connection = [...connections.live.keys()][0];
  await ingest(site, [row(0, 1), row(1, 2)]);
  const untouched = site.rows();
  visitSites(manager, 'never-started');
  assert.equal(connections.live.has(connection), true);
  await ingest(site, [row(1, 99)]);
  assertNoSQLiteLease(directory, siteId);
  assert.deepEqual([...untouched], [row(0, 1), row(1, 2)]);
  const readers = Array.from({length: 64}, () => site.rows());
  assert.throws(() => site.rows(), errorCode('ITERATOR_CAPACITY'));
  for (const reader of readers) reader.return();
  assert.throws(() => site.rows(undefined, {start: ts(1), end: ts(0)}), errorCode('INVALID_SCOPE'));
  visitSites(manager, 'never-started');
  assert.equal(connections.live.has(connection), false);
});

test('idle lifecycle: a producer and 63 readers exhaust only active capacity, then stage completion frees a slot', async t => {
  const connections = trackConnections(t);
  const {site, manager, directory, siteId} = fixture(t);
  let resume, reached;
  const gate = new Promise(resolve => {resume = resolve;});
  const paused = new Promise(resolve => {reached = resolve;});
  async function* input() {yield row(0, 1); reached(); await gate;}
  const pending = site.stage(metadata, input());
  const readers = [];
  try {
    await paused;
    for (let n = 0; n < 63; n++) readers.push(manager.site(`mixed-active/${n}`).rows());
    assert.throws(() => manager.site('mixed-overflow'), errorCode('STORE_CAPACITY'));
    assert.equal(connections.closed.length, 0);
    assertNoSQLiteLease(directory, siteId);
  } finally {resume(); await pending.catch(() => {});}
  const preview = await pending;
  assert.equal(manager.site('mixed-overflow').describe().revision, 0);
  assert.equal(site.preview(preview.stageId).status, 'preview');
  assert.equal(site.commit(preview.stageId, options(preview)).revision, 1);
  for (const reader of readers) reader.return();
});

test('inventory hasData: absent IDs create no files, empty/preview-only sites are false, committed sites survive idle pressure', async t => {
  const connections = trackConnections(t);
  const {site, manager, directory, siteId} = fixture(t);
  const beforeFiles = readdirSync(directory).sort(), opens = connections.opened.length;
  for (let n = 0; n < 150; n++) assert.equal(manager.hasData(`absent/${n}`), false);
  assert.deepEqual(readdirSync(directory).sort(), beforeFiles);
  assert.equal(connections.opened.length, opens);
  assert.equal(manager.hasData(siteId), false);
  const preview = await site.stage(metadata, [row(0, 1)]);
  assert.equal(manager.hasData(siteId), false);
  site.commit(preview.stageId, options(preview));
  visitSites(manager, 'inventory-pressure');
  assert.equal(manager.hasData(siteId), true);
  assert.equal(manager.site(siteId), site);
  assert.equal(manager.hasData(siteId.toUpperCase()), false);
  assert.equal(connections.peak, 64);
  assert.throws(() => manager.hasData(''), errorCode('INVALID_SITE_ID'));
  manager.close();
  assert.throws(() => manager.hasData('absent'), errorCode('STORE_CLOSED'));
});

test('inventory hasData: existing files must pass schema/ownership/path validation and active capacity limits', async t => {
  const {site, manager, directory, siteId} = fixture(t);
  await ingest(site, [row(0, 1)]);
  visitSites(manager, 'inventory-validation');
  copyFileSync(filename(directory, siteId), filename(directory, 'copied-owner'));
  symlinkSync(filename(directory, siteId), filename(directory, 'linked-owner'));
  symlinkSync(filename(directory, 'missing-target'), filename(directory, 'broken-link'));
  assert.throws(() => manager.hasData('copied-owner'), errorCode('SITE_OWNERSHIP_MISMATCH'));
  assert.throws(() => manager.hasData('linked-owner'), errorCode('UNSAFE_DATABASE_PATH'));
  assert.throws(() => manager.hasData('broken-link'), errorCode('UNSAFE_DATABASE_PATH'));
  inspect(directory, siteId, db => db.exec('PRAGMA user_version=999'));
  assert.throws(() => manager.hasData(siteId), errorCode('INCOMPATIBLE_SCHEMA'));
  inspect(directory, siteId, db => db.exec('PRAGMA user_version=2'));
  const readers = [];
  for (let n = 0; n < 64; n++) readers.push(manager.site(`inventory-pinned/${n}`).rows());
  assert.equal(manager.hasData('truly-absent'), false);
  assert.throws(() => manager.hasData(siteId), errorCode('STORE_CAPACITY'));
  readers[0].return();
  assert.equal(manager.hasData(siteId), true);
  for (const reader of readers) reader.return();
});
