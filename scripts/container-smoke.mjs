#!/usr/bin/env node
// Exercise the actual image, not a host substitute. Only synthetic data is used.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const image = process.argv[2];
assert.ok(image, 'Usage: node scripts/container-smoke.mjs IMAGE');
const name = `sol-smoke-${randomUUID()}`;
// Keep the outer directory owned by the runner: /tmp has the sticky bit,
// so changing its ownership would prevent a different runner UID removing it.
const root = mkdtempSync(join(tmpdir(), 'sol-container-'));
const data = join(root, 'data');
mkdirSync(data);
const password = randomUUID();
const auth = `Basic ${Buffer.from(`tester:${password}`).toString('base64')}`;
let base;
const docker = (...args) => execFileSync('docker', args, {
  encoding: 'utf8', timeout: 150000, maxBuffer: 8 * 1024 * 1024,
  env: {...process.env, SOL_PASSWORD: password},
}).trim();
const hardened = ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
  '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--user', '1000:1000',
  '--mount', `type=bind,source=${data},target=/data`];
async function request(path, {authenticated = true, ...options} = {}) {
  return fetch(base + path, {...options, redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: {...(authenticated ? {Authorization: auth} : {}), ...options.headers}});
}
async function api(path, method = 'GET', body) {
  const response = await request(path, {method,
    headers: body === undefined ? {} : {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body)});
  const text = await response.text();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`);
  return JSON.parse(text);
}
async function ready() {
  // Docker may reassign an ephemeral host port after restart.
  base = `http://${docker('port', name, '3080/tcp')}`;
  for (let attempt = 0; attempt < 90; attempt++) {
    assert.equal(docker('inspect', '--format={{.State.Running}}', name), 'true', 'Container exited');
    try {
      const response = await request('/healthz', {authenticated: false});
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch {}
    await delay(1000);
  }
  throw Error('Container readiness timed out');
}
async function start() {
  docker('run', '-d', '--name', name, ...hardened, '-p', '127.0.0.1::3080',
    '-e', 'SOL_PASSWORD', '-e', 'SOL_USERNAME=tester', '-e', 'SOL_DATA_DIR=/data', image);
  base = `http://${docker('port', name, '3080/tcp')}`;
  await ready();
}
async function protectedEndpoints() {
  for (const path of ['/', '/api/site-settings', '/api/user-settings']) {
    const response = await request(path, {authenticated: false});
    assert.equal(response.status, 401, `${path} must require authentication`);
    assert.match(response.headers.get('www-authenticate'), /^Basic /);
  }
  assert.equal((await request('/api/site-settings', {headers: {
    Authorization: `Basic ${Buffer.from('tester:incorrect').toString('base64')}`,
  }})).status, 401);
}
try {
  // Prepare the bind mount as an Umbrel installation must. Root is used only
  // in this one-shot ownership initializer, never in the application container.
  docker('run', '--rm', '--user', '0:0', '--network', 'none', '--read-only',
    '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=FOWNER',
    '--security-opt=no-new-privileges', '--mount', `type=bind,source=${data},target=/data`,
    '--entrypoint', 'sh', image, '-c', 'chown 1000:1000 /data && chmod 700 /data');
  await start();
  assert.equal(docker('exec', name, 'id', '-u'), '1000');
  assert.equal(docker('inspect', '--format={{.HostConfig.ReadonlyRootfs}}', name), 'true');
  await protectedEndpoints();
  const home = await request('/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Sol Diagnostics/);
  assert.deepEqual((await api('/api/site-settings')).sites, []);
  assert.equal((await request('/api/site-settings', {method: 'POST', headers: {
    Origin: 'https://cross-origin.example', 'Content-Type': 'application/json'}, body: '{}'})).status, 403);
  const site = (await api('/api/site-settings', 'POST', {
    name: 'Synthetic CI solar', country: 'US', latitude: '35.2', longitude: '-80.8',
  })).site;
  assert.ok(site.id);
  await api('/api/user-settings', 'PUT', {
    firstName: 'Synthetic', lastName: 'CI', title: 'Smoke test', theme: 'jade', minimumIssueLossKwh: '',
  });
  const uploadId = randomUUID();
  const csv = 'Timestamp,Energy\n2026-01-01T00:00:00Z,0\n';
  const uploaded = await request(`/api/telemetry-imports/chunk?uploadId=${uploadId}&part=1`, {method: 'PUT', body: csv});
  assert.equal(uploaded.status, 201, await uploaded.text());
  const objectCheck = `
    import assert from 'node:assert/strict';
    import {LocalDatabase,LocalBucket} from './selfhost/storage.mjs';
    const db=new LocalDatabase('/data/sol-diagnostics.sqlite','/app/drizzle');
    try {
      const bucket=new LocalBucket(db,'/data/objects');
      const found=await bucket.list({prefix:'upload-parts/'+process.argv[1]+'/'});
      assert.equal(found.objects.length,1);
      assert.equal(await (await bucket.get(found.objects[0].key)).text(),process.argv[2]);
    } finally {db.close();}
  `;
  const persisted = async () => {
    assert.ok((await api('/api/site-settings')).sites.some(item => item.id === site.id && item.name === site.name));
    const settings = (await api('/api/user-settings')).user;
    assert.equal(settings.firstName, 'Synthetic');
    assert.equal(settings.theme, 'jade');
    docker('exec', name, 'node', '--input-type=module', '-e', objectCheck, uploadId, csv);
    await protectedEndpoints();
  };
  await persisted();
  console.log('PASS: initial auth, SQLite state and uploaded bytes.');
  docker('restart', '--time', '120', name);
  await ready();
  await persisted();
  console.log('PASS: persisted state after restart.');
  // Recreate as well as restart: persistence must live on /data, not a layer.
  docker('stop', '--time', '120', name);
  assert.equal(docker('inspect', '--format={{.State.ExitCode}}', name), '0');
  docker('rm', name);
  await start();
  await persisted();
  console.log('PASS: persisted state after container recreation.');
  for (let i = 0; i < 90; i++) {
    const status = docker('inspect', '--format={{.State.Health.Status}}', name);
    if (status === 'healthy') break;
    assert.notEqual(status, 'unhealthy');
    if (i === 89) throw Error('Image HEALTHCHECK did not become healthy');
    await delay(1000);
  }
  console.log('PASS: non-root/read-only startup, healthcheck, HTTP auth, CSRF rejection, SQLite and uploaded bytes survive restart and recreation.');
} catch (error) {
  console.error('Container smoke failure:', error);
  try { console.error(docker('logs', '--tail', '150', name)); } catch {}
  throw error;
} finally {
  try { docker('rm', '-f', name); } catch {}
  // Use the same UID for private files created inside the container.
  try { docker('run', '--rm', '--user', '1000:1000', '--network', 'none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--mount', `type=bind,source=${data},target=/data`, '--entrypoint', 'node', image,
    '-e', "const fs=require('node:fs');for(const n of fs.readdirSync('/data'))fs.rmSync('/data/'+n,{recursive:true,force:true});fs.chmodSync('/data',0o755);"); } finally {
    rmSync(root, {recursive: true, force: true});
  }
}
