import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {npmVersionFor, checkReleaseVersion} from '../scripts/check-release-version.mjs';

test('calendar versions preserve external padding and map to internal npm SemVer', () => {
  assert.equal(npmVersionFor('2026.11.13.2'), '2026.11.13-2');
  assert.equal(npmVersionFor('2027.01.02.1'), '2027.1.2-1');
  assert.equal(npmVersionFor('2028.02.29.10'), '2028.2.29-10');
});
test('calendar versions reject invalid dates, padding and counters', () => {
  for (const value of ['2026.02.29.1', '2026.04.31.1', '2026.13.01.1', '2026.00.01.1', '2026.01.00.1', '2026.1.02.1', '2026.01.2.1', '2026.11.13.0', '2026.11.13.01', '2026.11.13.-1', '2026.11.13.1x', 'v2026.11.13.1', '1.0.0', '2026.11.13.1\n']) assert.throws(() => npmVersionFor(value), value);
});
test('version gate checks tag, package metadata and Compose image consistency', t => {
  const root = mkdtempSync(join(tmpdir(), 'sol-version-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const put = (name, value) => writeFileSync(join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
  put('VERSION', '2026.11.13.2\n');
  put('package.json', {version:'2026.11.13-2'});
  const lock = {version:'2026.11.13-2', packages:{'':{version:'2026.11.13-2'}}};
  put('package-lock.json', lock);
  put('docker-compose.yml', 'services:\n  app:\n    image: sol-diagnostics:2026.11.13.2\n');
  assert.equal(checkReleaseVersion(root), '2026.11.13.2');
  assert.equal(checkReleaseVersion(root, 'v2026.11.13.2'), '2026.11.13.2');
  assert.throws(() => checkReleaseVersion(root, 'v1.0.0'), /tag/);
  for (const target of ['package', 'lock', 'root']) {
    put('package.json', {version:target === 'package' ? '1.0.0' : '2026.11.13-2'});
    put('package-lock.json', {version:target === 'lock' ? '1.0.0' : lock.version, packages:{'':{version:target === 'root' ? '1.0.0' : lock.version}}});
    assert.throws(() => checkReleaseVersion(root), /Package and lockfile/);
  }
  put('package.json', {version:lock.version}); put('package-lock.json', lock);
  put('docker-compose.yml', 'image: sol-diagnostics:1.0.0\n');
  assert.throws(() => checkReleaseVersion(root), /Compose/);
});
test('checked-in release metadata agrees', () => {
  assert.ok(checkReleaseVersion());
});
