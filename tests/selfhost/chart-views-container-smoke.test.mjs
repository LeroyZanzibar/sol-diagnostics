import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {runMonthlyPersistenceSmoke, verifyMonthlyPersistence} from '../../scripts/monthly-persistence-smoke.mjs';

// Use the existing production build, just as the other HTTP smoke tests do.
// This does not claim native-image hardening or container recreation coverage.
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sol-container-chart-views-http-'));
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
      const rows = db.prepare('SELECT * FROM chart_views ORDER BY created_at ASC, id ASC').all();
      assert.deepEqual(rows.map(row => ({...row})), expected.views.map(view => ({
        id: view.id, user_id: 'primary-user', name: view.name, name_key: view.name.toLowerCase(),
        settings_json: JSON.stringify(view.settings), created_at: view.createdAt,
      })));
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
  }
  return {root, start, stop, request, api, verifyStore};
}

test('native-container chart-view scenario: independently checked setup and immutable snapshot survive production HTTP restart', {timeout: 90000}, async t => {
  const {runChartViewsPersistenceSmoke, verifyChartViewsPersistence} = await import('../../scripts/chart-views-persistence-smoke.mjs');
  const f = await fixture(t);
  await f.start();
  const monthly = await runMonthlyPersistenceSmoke({api: f.api, request: f.request});
  const scenario = await runChartViewsPersistenceSmoke({api: f.api, request: f.request});
  assert.ok(Object.isFrozen(scenario.expected));
  assert.ok(Object.isFrozen(scenario.expected.views));
  assert.ok(Object.isFrozen(scenario.expected.views[0].settings.metrics));
  assert.throws(() => scenario.expected.views[0].settings.metrics.reverse(), TypeError);
  const snapshot = join(f.root, 'chart-views-expected.json');
  writeFileSync(snapshot, JSON.stringify(scenario.expected));
  const bytes = readFileSync(snapshot, 'utf8');
  const expected = JSON.parse(bytes);
  assert.equal(expected.views.length, 2);
  assert.deepEqual(expected.views.map(view => view.settings.comparisonYears).sort(), [0, 2]);
  await verifyChartViewsPersistence({api: f.api, expected});
  f.verifyStore(expected);
  await verifyMonthlyPersistence({api: f.api, expected: monthly.expected});
  // Refuse a nonempty profile instead of overwriting or adopting existing views.
  await assert.rejects(runChartViewsPersistenceSmoke({api: f.api, request: f.request}), /fresh synthetic profile/);
  await verifyChartViewsPersistence({api: f.api, expected});
  // A missing view or changed identity/settings must fail, even if counts agree.
  for (const mutate of [list => list.views.pop(), list => {list.views[0].id = randomUUID();},
    list => {list.views[0].name = 'Changed';}, list => {list.views[0].createdAt = '2020-01-01T00:00:00.000Z';},
    list => {list.views[0].settings.metrics.reverse();}, list => {list.views[0].settings.comparisonYears = 1;}]) {
    await assert.rejects(verifyChartViewsPersistence({expected, api: async path => {
      const actual = await f.api(path); mutate(actual); return actual;
    }}), {code: 'ERR_ASSERTION'});
  }
  await f.stop();
  await f.start();
  assert.equal(readFileSync(snapshot, 'utf8'), bytes, 'Never recapture expectations from the restarted application');
  await verifyChartViewsPersistence({api: f.api, expected: JSON.parse(readFileSync(snapshot, 'utf8'))});
  f.verifyStore(expected);
  await verifyMonthlyPersistence({api: f.api, expected: monthly.expected});
  if (process.env.SOL_CHART_VIEWS_SMOKE_EVIDENCE_DIR) {
    mkdirSync(process.env.SOL_CHART_VIEWS_SMOKE_EVIDENCE_DIR, {recursive: true});
    writeFileSync(join(process.env.SOL_CHART_VIEWS_SMOKE_EVIDENCE_DIR, 'chart-views-expected.json'), bytes);
    writeFileSync(join(process.env.SOL_CHART_VIEWS_SMOKE_EVIDENCE_DIR, 'chart-views-after-restart.json'),
      JSON.stringify(await f.api('/api/chart-views')));
  }
  t.diagnostic('Two exact saved setups, identities, timestamps and SQLite rows survive clean production restart; populated monthly inputs, projections, telemetry and receipts remain unchanged. Native images and recreation remain CI gates.');
});

test('chart-view seed rejects a successful acknowledgement with altered settings before capturing an expectation', {timeout: 45000}, async t => {
  const {runChartViewsPersistenceSmoke} = await import('../../scripts/chart-views-persistence-smoke.mjs');
  const f = await fixture(t);
  await f.start();
  let altered = false;
  await assert.rejects(runChartViewsPersistenceSmoke({request: f.request, api: async (path, method, body) => {
    const result = await f.api(path, method, body);
    if (path === '/api/chart-views' && method === 'POST') {
      result.view.settings.comparisonYears = 1;
      altered = true;
    }
    return result;
  }}), {code: 'ERR_ASSERTION'});
  assert.equal(altered, true, 'Exercise the independent create-response oracle, not an earlier guard');
});
