import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';
import {runPerformancePersistenceSmoke, verifyPerformancePersistence} from '../../scripts/performance-persistence-smoke.mjs';

// This exercises the container smoke's shared API scenario over real production
// HTTP. It is deliberately not a substitute for running the hardened image.
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sol-container-performance-http-'));
  const password = randomUUID();
  let child, logs = '', spawnError;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      const [code, signal] = await exited;
      assert.equal(code, 0, `Production server did not stop cleanly (${signal}): ${logs}`);
    } finally { clearTimeout(timer); }
  }
  t.after(async () => {
    try { await stop(); } finally { rmSync(directory, {recursive: true, force: true}); }
  });
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  const auth = `Basic ${Buffer.from(`tester:${password}`).toString('base64')}`;
  async function start() {
    const env = {...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
      SOL_DATA_DIR: directory, SOL_PASSWORD: password, SOL_USERNAME: 'tester'};
    delete env.SOL_PASSWORD_FILE;
    delete env.SOL_PUBLIC_URL;
    logs = ''; spawnError = undefined;
    child = spawn(process.execPath, ['selfhost/server.mjs'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = data => { logs = (logs + data).slice(-65536); };
    child.stdout.on('data', log); child.stderr.on('data', log);
    child.on('error', error => { spawnError = error; });
    const deadline = Date.now() + 15000;
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
  // Match the existing native-container request/api interfaces exactly.
  async function request(path, {authenticated = true, ...options} = {}) {
    return fetch(base + path, {...options, redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: {...(authenticated ? {Authorization: auth} : {}), ...options.headers}});
  }
  async function api(path, method = 'GET', body) {
    const response = await request(path, {method,
      headers: body === undefined ? {} : {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body)});
    const text = await response.text();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}\n${logs}`);
    return JSON.parse(text);
  }
  function verifyStore(expected) {
    const manager = new PerformanceStoreManager(join(directory, 'performance'));
    try {
      const store = manager.site(expected.siteId);
      for (const revision of expected.revisions) {
        assert.deepEqual(store.describe(revision.dataset.revision), revision.dataset);
        assert.deepEqual([...store.rows(revision.dataset.revision)], revision.rows,
          'Every revision must retain its exact timestamp/channel keys and values');
        assert.deepEqual(store.preview(revision.receipt.stageId), revision.receipt);
      }
      assert.deepEqual([...store.rows()], expected.revisions.at(-1).rows);
      assert.deepEqual(store.imports(), expected.imports);
    } finally { manager.close(); }
  }
  return {start, stop, request, api, verifyStore};
}

test('native-container canonical smoke scenario: real production HTTP approval, exact values, receipts and restart', {timeout: 90000}, async t => {
  const f = await fixture(t);
  await f.start();
  const site = (await f.api('/api/site-settings', 'POST', {
    name: 'Synthetic container persistence HTTP', country: 'US', latitude: '35.2', longitude: '-80.8',
  })).site;
  assert.equal((await f.request(`/api/performance-data?siteId=${encodeURIComponent(site.id)}`, {authenticated: false})).status, 401);
  assert.equal((await f.request('/api/performance-data', {method: 'POST',
    headers: {Origin: 'https://untrusted.example', 'Content-Type': 'application/json'}, body: '{}'})).status, 403);
  const scenario = await runPerformancePersistenceSmoke({api: f.api, request: f.request, siteId: site.id});
  // Detach the saved identities from the verifier closure before restarting.
  const expected = JSON.parse(JSON.stringify(scenario.expected));
  assert.equal(expected.siteId, site.id);
  assert.equal(expected.revisions.length, 2);
  assert.deepEqual(expected.revisions.map(item => item.dataset.revision), [1, 2]);
  assert.deepEqual(expected.revisions.map(item => item.dataset.readingCount), [6, 6]);
  assert.deepEqual(expected.revisions.map(item => item.dataset.timestampCount), [3, 3]);
  assert.deepEqual(expected.revisions.map(item => item.dataset.channelCount), [2, 2]);
  assert.equal(expected.imports.length, 2);
  assert.notEqual(expected.revisions[0].receipt.stageId, expected.revisions[1].receipt.stageId);
  const before = expected.revisions[0].rows, after = expected.revisions[1].rows;
  const changed = after.filter((row, index) => row.value !== before[index].value);
  assert.equal(changed.length, 1, 'Only the supplied overlapping reading may change');
  assert.equal(changed[0].value, 17);
  assert.equal(before.find(row => row.timestamp === changed[0].timestamp && row.channel.id === changed[0].channel.id).value, 20);
  await scenario.verify();
  f.verifyStore(expected);
  await f.stop();
  await f.start();
  await verifyPerformancePersistence({api: f.api, expected});
  f.verifyStore(expected);
  t.diagnostic('Verified 6 readings, 3 timestamps, 2 channels, 2 immutable revisions and 2 commit receipts before/after a real production-server restart. Docker hardening/recreation remain native CI checks.');
});
