import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {lossStorageProgram, runMonthlyLossPersistenceSmoke, verifyMonthlyLossPersistence} from '../../scripts/monthly-loss-persistence-smoke.mjs';
import {once} from 'node:events';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';
import {runMonthlyPersistenceSmoke, verifyMonthlyPersistence} from '../../scripts/monthly-persistence-smoke.mjs';

// Exercise the shared native-image scenario with the actual production listener
// and compiled routes. This is not evidence of Docker hardening or recreation.
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sol-container-monthly-http-'));
  const directory = join(root, 'data');
  mkdirSync(directory);
  const password = randomUUID();
  let child, logs = '', spawnError;
  async function stop() {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    try {
      const [code, signal] = await exited;
      assert.equal(code, 0, `Production server did not stop cleanly (${signal}): ${logs}`);
    } finally { clearTimeout(timer); }
  }
  t.after(async () => {
    try { await stop(); } finally { rmSync(root, {recursive: true, force: true}); }
  });
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  const auth = `Basic ${Buffer.from(`tester:${password}`).toString('base64')}`;
  async function start() {
    // No inherited provider credentials, public origin, password file or preload.
    const env = {PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      TMP: process.env.TMP, TEMP: process.env.TEMP, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
      SOL_DATA_DIR: directory, SOL_PASSWORD: password, SOL_USERNAME: 'tester'};
    logs = ''; spawnError = undefined;
    child = spawn(process.execPath, ['selfhost/server.mjs'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = data => { logs = (logs + data).slice(-65536); };
    child.stdout.on('data', log); child.stderr.on('data', log);
    child.on('error', error => { spawnError = error; });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw Error(`Production server exited: ${logs}`);
      try {
        const response = await fetch(base + '/healthz', {signal: AbortSignal.timeout(1000)});
        if (response.ok && (await response.json()).status === 'ok') return;
      } catch {}
      await delay(50);
    }
    throw Error(`Production server readiness timed out: ${logs}`);
  }
  async function request(path, {authenticated = true, ...options} = {}) {
    return fetch(base + path, {...options, redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: {...(authenticated ? {Authorization: auth} : {}), ...options.headers}});
  }
  async function api(path, method = 'GET', body) {
    const response = await request(path, {method,
      headers: body === undefined ? {} : {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body)});
    const text = await response.text();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${text.slice(0, 4096)}\n${logs}`);
    assert.match(response.headers.get('content-type') || '', /^application\/json/);
    return JSON.parse(text);
  }
  function verifyStore(expected) {
    const db = new DatabaseSync(join(directory, 'sol-diagnostics.sqlite'), {readOnly: true});
    try {
      const config = db.prepare('SELECT revision,configuration_json FROM monthly_configuration WHERE site_id=?').get(expected.siteId);
      assert.equal(config.revision, expected.monthly.revision);
      assert.deepEqual(JSON.parse(config.configuration_json), expected.monthly.configuration);
      const rows = db.prepare('SELECT * FROM monthly_utility WHERE site_id=? ORDER BY month').all(expected.siteId);
      assert.deepEqual(Object.fromEntries(rows.map(row => [row.month, {onPeak: row.on_peak, offPeak: row.off_peak, unpaidEnergy: row.unpaid_energy,
        revenue: row.revenue, energyUsed: row.energy_used, invoiceCost: row.invoice_cost}])), expected.monthly.utility);
      const rollup = db.prepare('SELECT source_revision,payload_json FROM monthly_rollups WHERE site_id=?').get(expected.siteId);
      assert.equal(rollup.source_revision, 2);
      assert.deepEqual(JSON.parse(rollup.payload_json), expected.monthly.telemetry);
      for (const table of ['analysis_jobs', 'analysis_runs', 'performance_summaries', 'issue_event_reviews']) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE site_id=?`).get(expected.siteId).n, 0,
          'Monthly-only work must not create or rerun analyses or reviews');
      }
    } finally { db.close(); }
    const manager = new PerformanceStoreManager(join(directory, 'performance'));
    try {
      const store = manager.site(expected.siteId);
      for (const revision of [1, 2]) {
        const rows = [...store.rows(revision)];
        assert.equal(rows.length, 4);
        assert.deepEqual(rows.filter(row => row.channel.measurement === 'Expected Production').map(row => [row.timestamp, row.channel.id, row.value]), [
          ['2026-01-01T12:00:00.000Z', '["@site","Expected Production","forecast"]', revision === 1 ? 12.125 : 18.125],
          ['2026-01-01T13:00:00.000Z', '["@site","Expected Production","forecast"]', 24.25],
        ]);
        assert.deepEqual(rows.filter(row => row.channel.measurement === 'Irradiance').map(row => [row.timestamp, row.channel.id, row.value]), [
          ['2026-01-01T12:00:00.000Z', expected.monthly.telemetry.candidates[0].id, 500],
          ['2026-01-01T13:00:00.000Z', expected.monthly.telemetry.candidates[0].id, 0],
        ]);
      }
    } finally { manager.close(); }
  }
  const lossStorage = (mode, siteId) => JSON.parse(execFileSync(process.execPath,
    ['--input-type=module', '-e', lossStorageProgram, mode, directory, siteId], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 15000,
    }));
  return {root, directory, start, stop, request, api, verifyStore, lossStorage};
}

test('native-container positive monthly loss smoke: exact stored bytes before GET after production restart', {timeout: 90000}, async t => {
  const f = await fixture(t);
  await f.start();
  const scenario = await runMonthlyLossPersistenceSmoke({api: f.api, storage: f.lossStorage});
  assert.ok(Object.isFrozen(scenario.expected));
  assert.ok(Object.isFrozen(scenario.expected.unconfirmedLoss.months['2026-01'].value));
  const snapshot = join(f.root, 'loss-expected.json');
  writeFileSync(snapshot, JSON.stringify(scenario.expected));
  const bytes = readFileSync(snapshot, 'utf8');
  const verify = () => verifyMonthlyLossPersistence({api: f.api, storage: f.lossStorage,
    expected: JSON.parse(readFileSync(snapshot, 'utf8'))});
  await verify();
  await f.stop();
  await f.start();
  assert.equal(readFileSync(snapshot, 'utf8'), bytes);
  await verify(); // Shared verifier reads SQLite BEFORE the recomputing monthly GET.
  // A missing materialization must fail before GET can repair it.
  const db = new DatabaseSync(join(f.directory, 'sol-diagnostics.sqlite'));
  try { db.prepare('DELETE FROM monthly_unconfirmed_loss WHERE site_id=?').run(scenario.expected.siteId); }
  finally { db.close(); }
  let reads = 0;
  await assert.rejects(verifyMonthlyLossPersistence({expected: JSON.parse(bytes), storage: f.lossStorage,
    api: async (...args) => { reads++; return f.api(...args); }}), /persisted monthly loss/);
  assert.equal(reads, 0, 'Missing stored rows must not be silently regenerated');
  if (process.env.SOL_MONTHLY_SMOKE_EVIDENCE_DIR) {
    mkdirSync(process.env.SOL_MONTHLY_SMOKE_EVIDENCE_DIR, {recursive: true});
    writeFileSync(join(process.env.SOL_MONTHLY_SMOKE_EVIDENCE_DIR, 'loss-expected.json'), bytes);
  }
  t.diagnostic('Shared native path: independent positive Confirmed/Unconfirmed, dismissed and historical exclusions, local-month counted ledger, unknown/zero/missing, exact SQLite payload before GET after host restart. Docker execution remains CI-only.');
});

test('native-container monthly smoke scenario: exact inputs, approved projections, calculated metrics, corrected telemetry and real production-server restart', {timeout: 90000}, async t => {
  const f = await fixture(t);
  await f.start();
  const scenario = await runMonthlyPersistenceSmoke({api: f.api, request: f.request});
  assert.ok(Object.isFrozen(scenario.expected));
  assert.ok(Object.isFrozen(scenario.expected.monthly.calculated));
  assert.deepEqual(scenario.expected.monthly.calculated['2026-01'].iapr.value,{n:'1596757330232503857',d:'645859375000000000'},'Generic uploaded intervals supply Actual insolation');assert.ok(Object.isFrozen(scenario.expected.monthly.calculated['2026-01'].productionExpectedRatio.value));
  const snapshot = join(f.root, 'monthly-expected.json');
  writeFileSync(snapshot, JSON.stringify(scenario.expected));
  const bytes = readFileSync(snapshot, 'utf8');
  const expected = JSON.parse(bytes);
  assert.equal(expected.monthly.revision, 2);
  assert.equal(expected.monthly.utility['2026-04'].unpaidEnergy, '12.6250');
  assert.equal(expected.monthly.utility['2026-03'].unpaidEnergy, '12.6250');
  assert.equal(expected.monthly.utility['2026-01'].unpaidEnergy, null);
  assert.equal(Object.keys(expected.monthly.utility).length, 4);
  assert.equal(Object.keys(expected.monthly.configuration.baselines).length, 12);
  assert.equal(expected.monthly.projections.length, 300);
  assert.deepEqual(expected.monthly.capacity, {dcKwp: {n: '120', d: '1'}, unavailableReason: null});
  assert.equal(Object.keys(expected.monthly.calculated).length, 300);
  for (const row of Object.values(expected.monthly.calculated)) assert.equal(Object.keys(row).length, 12);
  assert.equal(expected.monthly.telemetry.sourceRevision, 2);
  await verifyMonthlyPersistence({api: f.api, expected});
  f.verifyStore(expected);
  await f.stop();
  await f.start();
  assert.equal(readFileSync(snapshot, 'utf8'), bytes, 'The expectation must not be rebuilt from restarted responses');
  await verifyMonthlyPersistence({api: f.api, expected: JSON.parse(readFileSync(snapshot, 'utf8'))});
  f.verifyStore(expected);
  // Optional local evidence capture, never used as a source for assertions.
  if (process.env.SOL_MONTHLY_SMOKE_EVIDENCE_DIR) {
    mkdirSync(process.env.SOL_MONTHLY_SMOKE_EVIDENCE_DIR, {recursive: true});
    writeFileSync(join(process.env.SOL_MONTHLY_SMOKE_EVIDENCE_DIR, 'monthly-expected.json'), bytes);
    writeFileSync(join(process.env.SOL_MONTHLY_SMOKE_EVIDENCE_DIR, 'monthly-after-restart.json'),
      JSON.stringify(await f.api(`/api/monthly-data?siteId=${encodeURIComponent(expected.siteId)}`)));
  }
  t.diagnostic('Verified exact 4 utility rows, 12 baselines, operations/date/rate, all 300 preview-approved projections, 120 kWp module DC capacity, all 12 calculated fractions/statuses/reasons in every month, 4 canonical readings at 2 revisions and persisted monthly rollups before/after a real server restart; no analysis/review records. Native image hardening and recreation remain CI checks.');
});
