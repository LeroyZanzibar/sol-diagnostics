import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {LocalDatabase, LocalBucket} from '../../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';
import {loadSource} from '../source-module.mjs';

// Test-only, synthetic and local. No provider transport, analytical reducer or
// production migration is mocked. The parent must build dist before candidate QA.
export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const deliveryFactor = (1 - 2 / 100) * (1 - 1 / 100);
export const plain = value => JSON.parse(JSON.stringify(value));
const delay = ms => new Promise(done => setTimeout(done, ms));
const checkpoint = loadSource(join(repository, 'app/api/performance-summary/checkpoint-storage.ts'), [], {JSON, Error, TypeError});

export function syntheticModel(prefix = '') {
  const id = value => prefix + value;
  const node = (name, type, parent = null) => ({id: id(name), name, externalId: id(name), type,
    parentId: parent === null ? null : id(parent), quantity: 1, aliases: [], channels: []});
  return [
    {...node('meter', 'revenue_meter'), acLineLossPercent: '2', transformerLossPercent: '1'},
    {...node('transformer', 'transformer', 'meter'), nameplateKva: '160'},
    {...node('inv1', 'inverter', 'transformer'), acRatedCapacityKw: '100', maxDcCapacityKw: '150'},
    {...node('inv1-modules', 'module_group', 'inv1'), moduleRatedCapacityW: '500', quantity: 300},
    {...node('inv2', 'inverter', 'transformer'), acRatedCapacityKw: '100', maxDcCapacityKw: '100'},
    {...node('inv2-modules', 'module_group', 'inv2'), moduleRatedCapacityW: '500', quantity: 200},
    node('weather', 'weather_sensor'),
  ];
}

export function syntheticReadings(prefix = '') {
  const readings = [];
  for (let day = 1; day <= 8; day++) for (let hour = 0; hour < 24; hour++) {
    const timestamp = new Date(Date.UTC(2026, 4, day, hour)).toISOString();
    const daylight = hour >= 8 && hour <= 16;
    let inv1 = daylight ? 60 : 0, inv2 = daylight ? 40 : 0;
    let expected = daylight ? 100 * deliveryFactor : 0;
    if (day === 2 && hour === 10) {inv1 = 20; inv2 = 20; expected = 130;}
    if (day === 2 && (hour === 11 || hour === 12)) {
      inv1 = 0; inv2 = 0;
      // A supplied weather-adjusted reference is authoritative even above the
      // configured transformer ceiling. Do not clip or refit the site reference.
      expected = hour === 11 ? 180 : 110;
    }
    if (day === 3 && daylight) {inv1 = 0; expected = 130; if (hour === 13) inv2 = 100;}
    if (day === 4 && hour === 11) {inv1 = 0; inv2 = 0; expected = null;}
    if (day === 4 && hour === 14) {inv1 = 0; expected = null;}
    if (day === 5 && hour === 11) {inv1 = null; inv2 = null;}
    if (day === 6 && hour === 11) {inv1 = 0; inv2 = 0; expected = 0;}
    // Nonzero, recurring deficits are not outages and must not produce findings.
    if ((day === 7 || day === 8) && daylight) {inv1 = 10; inv2 = 20;}
    let meter = inv1 === null || inv2 === null ? null : (inv1 + inv2) * deliveryFactor;
    if (day === 5 && hour === 14) meter = null;
    for (const [equipmentId, measurement, value, unit] of [
      [prefix + 'meter', 'Energy', meter, 'kWh'],
      [prefix + 'inv1', 'Energy', inv1, 'kWh'],
      [prefix + 'inv2', 'Energy', inv2, 'kWh'],
      ['@site', 'Expected Production', expected, 'kWh'],
      [prefix + 'weather', 'Irradiance', daylight ? 600 : 0, 'W/m2'],
    ]) readings.push({timestamp, equipmentId, measurement, value, unit});
  }
  return readings;
}

export async function createOutageFixture({directory, port, keep = false} = {}) {
  directory = directory ? resolve(directory) : mkdtempSync(join(tmpdir(), 'sol-outage-only-http-'));
  if (existsSync(directory)) assert.equal(readdirSync(directory).length, 0, 'Refuse to seed a nonempty/existing fixture');
  else mkdirSync(directory, {recursive: true, mode: 0o700});
  // Startup alone runs the actual shared/per-site production migration paths.
  const username = 'outage-test', password = 'synthetic-' + randomUUID();
  if (!port) {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    port = reservation.address().port;
    await new Promise((done, fail) => reservation.close(error => error ? fail(error) : done()));
  }
  const base = `http://127.0.0.1:${port}`;
  const authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const transcript = [];
  let child, logs = '';
  const inspect = operation => {
    const db = new DatabaseSync(join(directory, 'sol-diagnostics.sqlite'), {readOnly: true});
    try {return plain(operation(db));} finally {db.close();}
  };
  const withStore = (siteId, operation) => {
    const manager = new PerformanceStoreManager(join(directory, 'performance'));
    try {return plain(operation(manager.site(siteId)));} finally {manager.close();}
  };
  async function start() {
    assert.ok(!child || child.exitCode !== null || child.signalCode !== null, 'Fixture already running');
    child = spawn(process.execPath, ['selfhost/server.mjs'], {cwd: repository,
      env: {...process.env, HOST: '127.0.0.1', PORT: String(port), SOL_DATA_DIR: directory,
        SOL_USERNAME: username, SOL_PASSWORD: password, SOL_PASSWORD_FILE: '', SOL_PUBLIC_URL: ''},
      stdio: ['ignore', 'pipe', 'pipe']});
    child.stdout.on('data', value => {logs += value;});
    child.stderr.on('data', value => {logs += value;});
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw Error(logs);
      try {if ((await fetch(base + '/healthz', {signal: AbortSignal.timeout(1000)})).ok) return;} catch {}
      await delay(50);
    }
    throw Error('Synthetic production server did not start:\n' + logs);
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      try {await exited;} finally {clearTimeout(timer);}
    }
  }
  async function request(path, {method = 'GET', body, headers = {}, authenticated = true} = {}) {
    const response = await fetch(base + path, {method, headers: {
      ...(authenticated ? {Authorization: authorization} : {}),
      ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers},
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000)});
    const text = await response.text();
    const data = text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : {text: text.slice(0, 600)};
    const result = {status: response.status, data, etag: response.headers.get('etag'), cacheControl: response.headers.get('cache-control')};
    transcript.push({method, path, status: result.status, etag: result.etag,
      ...(result.status >= 400 ? {error: data} : {}), ...(method === 'DELETE' ? {response: data} : {})});
    return result;
  }
  async function api(path, method = 'GET', body) {
    const result = await request(path, {method, body});
    assert.ok(result.status >= 200 && result.status < 300,
      `${method} ${path}: ${result.status} ${JSON.stringify(result.data)}\n${logs}`);
    return result.data;
  }
  async function analyze(siteId) {
    const started = await api('/api/performance-summary', 'POST', {siteId, action: 'reanalyze'});
    const attemptId = started.progress?.attemptId;
    assert.ok(attemptId, 'Manual analysis must create a real attempt');
    const deadline = Date.now() + 90000;
    let result;
    while (Date.now() < deadline) {
      result = await api(`/api/performance-summary?siteId=${siteId}&attemptId=${attemptId}`);
      if (!result.processing) break;
      assert.ok(!['failed', 'canceled', 'interrupted'].includes(result.progress?.status), JSON.stringify(result));
      await delay(20);
    }
    assert.equal(result?.hasData, true, 'Real manual analysis must finish: ' + JSON.stringify(result));
    assert.equal(result.issueDatabase.analysisRunId, attemptId);
    const saved = await api(`/api/analysis-history?siteId=${siteId}&runId=${attemptId}`);
    assert.equal(saved.issueDatabase.analysisRunId, attemptId);
    assert.ok(saved.analysis.issues.length > 0, 'Synthetic daylight outages must be detected');
    return {runId: attemptId, result, saved};
  }
  async function seedSite(name, prefix) {
    const site = (await api('/api/site-settings', 'POST', {name, country: 'US', latitude: '35.2', longitude: '-80.8'})).site;
    const model = await api('/api/equipment', 'PUT', {siteId: site.id, equipment: syntheticModel(prefix), verified: true});
    assert.equal(model.verified, true);
    assert.equal(model.equipment.length, syntheticModel(prefix).length);
    const readings = syntheticReadings(prefix);
    const {preview} = await api('/api/performance-data', 'POST', {action: 'preview', siteId: site.id,
      fileName: 'synthetic-outages', timezone: 'UTC', timestampConvention: 'start', intervalMinutes: 60, readings});
    assert.equal((await api(`/api/performance-data?siteId=${site.id}`)).dataset.revision, 0);
    const committed = await api('/api/performance-data', 'POST', {action: 'commit', siteId: site.id,
      stageId: preview.stageId, previewToken: preview.previewToken, approveOverlap: false});
    assert.equal(committed.dataset.readingCount, readings.length);
    assert.equal(committed.dataset.revision, 1);
    assert.equal((await api(`/api/performance-summary?siteId=${site.id}`)).analysisRequired, true);
    assert.deepEqual((await api(`/api/analysis-history?siteId=${site.id}`)).runs, []);
    return site;
  }
  async function seed() {
    await api('/api/user-settings', 'PUT', {firstName: 'Synthetic', lastName: 'Analyst', title: 'Outage QA', theme: 'jade', minimumIssueLossKwh: ''});
    const site = await seedSite('Synthetic outage acceptance', '');
    const older = await analyze(site.id);
    const reviewedIssue = older.saved.analysis.issues.find(issue => issue.type === 'Site outage' && !issue.lossUnknown);
    assert.ok(reviewedIssue, 'Need one real reviewed site outage');
    const reviewPath = runId => `/api/issue-reviews?siteId=${site.id}&runId=${runId}&issueId=${encodeURIComponent(reviewedIssue.id)}`;
    const review = await api(reviewPath(older.runId));
    await api('/api/issue-reviews', 'POST', {siteId: site.id, runId: older.runId, issueId: reviewedIssue.id,
      baseVersion: review.review.version, state: {...review.review.state, status: 'Confirmed', classification: 'Fuse Failure'},
      note: 'Synthetic review baseline must survive saved-analysis deletion.'});
    assert.equal((await api(reviewPath(older.runId))).review.state.status, 'Confirmed');
    const retained = await analyze(site.id);
    const current = await analyze(site.id);
    const otherSite = await seedSite('Synthetic retained comparison', 'other-');
    const other = await analyze(otherSite.id);
    const data = {site, otherSite, older, retained, current, other, reviewedIssue};
    return data;
  }
  async function readRetained(runId) {
    const db = new LocalDatabase(join(directory, 'sol-diagnostics.sqlite'), join(repository, 'drizzle'));
    try {
      const row = db.sqlite.prepare('SELECT * FROM analysis_runs WHERE id=?').get(runId);
      assert.ok(row);
      const bucket = new LocalBucket(db, join(directory, 'objects'));
      const object = await bucket.get(row.analysis_object_key); assert.ok(object, 'Retained result bytes must exist');
      return {row: plain(row), payload: plain(await checkpoint.readCheckpoint(object))};
    } finally {db.close();}
  }
  async function seedLegacyAlias(runId) {
    // Retained legacy current.json is deliberately left in place after deletion.
    // Use the real completed bytes/metadata, never an invented result payload.
    await stop();
    const db = new LocalDatabase(join(directory, 'sol-diagnostics.sqlite'), join(repository, 'drizzle'));
    try {
      const run = db.sqlite.prepare('SELECT * FROM analysis_runs WHERE id=?').get(runId);
      const row = db.sqlite.prepare('SELECT * FROM __sol_objects WHERE key=?').get(run.analysis_object_key);
      const bucket = new LocalBucket(db, join(directory, 'objects'));
      const key = `analysis/${run.site_id}/current.json`;
      await bucket.put(key, readFileSync(join(directory, 'objects', row.path)), {
        httpMetadata: JSON.parse(row.http), customMetadata: JSON.parse(row.custom)});
      assert.equal((await bucket.head(key)).etag, row.etag);
      return {key, etag: row.etag};
    } finally {db.close(); await start();}
  }
  function objectManifest() {
    return inspect(db => db.prepare('SELECT * FROM __sol_objects ORDER BY key').all()).map(row => ({...row,
      sha256: createHash('sha256').update(readFileSync(join(directory, 'objects', row.path))).digest('hex')}));
  }
  async function withGuardState(runId, kind, operation) {
    // Defined conflict preconditions only. All saved results above were produced
    // by the real engine. Stop the listener before changing/restoring guard state.
    await stop();
    const db = new DatabaseSync(join(directory, 'sol-diagnostics.sqlite'));
    let saved;
    try {
      if (kind === 'unfinished') {
        saved = db.prepare('SELECT status FROM analysis_runs WHERE id=?').get(runId); assert.equal(saved.status, 'completed');
        db.prepare("UPDATE analysis_runs SET status='processing' WHERE id=?").run(runId);
      } else {
        saved = db.prepare('SELECT * FROM analysis_jobs WHERE attempt_id=?').get(runId); assert.equal(saved.status, 'completed');
        db.prepare("UPDATE analysis_jobs SET status='processing', lease_token='synthetic-live-lease', lease_until=? WHERE attempt_id=?")
          .run(Date.now() + 120000, runId);
      }
    } finally {db.close();}
    try {await start(); await operation();}
    finally {
      await stop();
      const restore = new DatabaseSync(join(directory, 'sol-diagnostics.sqlite'));
      try {
        if (kind === 'unfinished') restore.prepare('UPDATE analysis_runs SET status=? WHERE id=?').run(saved.status, runId);
        else restore.prepare('UPDATE analysis_jobs SET status=?,lease_token=?,lease_until=? WHERE attempt_id=?')
          .run(saved.status, saved.lease_token, saved.lease_until, runId);
      } finally {restore.close();}
      await start();
    }
  }
  async function cleanup() {await stop(); if (!keep) rmSync(directory, {recursive: true, force: true});}
  return {directory, base, port, username, password, start, stop, request, api, analyze, seed, inspect, withStore,
    readRetained, seedLegacyAlias, objectManifest, withGuardState, cleanup, transcript, get logs() {return logs;}};
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node tests/selfhost/outage-only-fixture.mjs --serve [--data-dir NEW_DIRECTORY] [--port PORT]\nCreates synthetic models, canonical readings, four real completed analyses and one review; serves the existing production build. Ctrl-C stops the server; the printed fixture directory is retained.');
    return;
  }
  assert.ok(args.includes('--serve'), 'Use --serve or --help. Existing directories are never adopted.');
  const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const fixture = await createOutageFixture({directory: option('--data-dir'), port: Number(option('--port')) || undefined, keep: true});
  const stop = async () => {await fixture.stop(); process.exit(0);};
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await fixture.start();
    const data = await fixture.seed();
    const manifest = {synthetic: true, base: fixture.base, directory: fixture.directory,
      username: fixture.username, password: fixture.password, siteId: data.site.id, otherSiteId: data.otherSite.id,
      olderRunId: data.older.runId, retainedRunId: data.retained.runId, currentRunId: data.current.runId, otherRunId: data.other.runId};
    writeFileSync(join(fixture.directory, 'fixture.json'), JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600});
    console.log(JSON.stringify(manifest, null, 2));
  } catch (error) {await fixture.stop(); throw error;}
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
