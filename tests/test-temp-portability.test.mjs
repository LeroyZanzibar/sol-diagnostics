import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Exercise the actual SQLite fixtures with a different temporary root. The
// preload checks allocation paths but delegates every allocation to real fs.
const preload = `
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import {basename, dirname, resolve} from 'node:path';
  import {syncBuiltinESMExports} from 'node:module';
  const prefixes = new Set(['publication-', 'analysis-store-', 'analysis-ghi-', 'analysis-snow-']);
  const allocate = fs.mkdtempSync;
  fs.mkdtempSync = (prefix, ...options) => {
    if (prefixes.has(basename(prefix))) {
      assert.equal(resolve(dirname(prefix)), resolve(process.env.SOL_TEST_TEMP_ROOT),
        'Analysis fixtures must honor the operating-system temporary directory');
      console.log('TEMP_ROOT_CHECK:' + basename(prefix));
    }
    return allocate(prefix, ...options);
  };
  syncBuiltinESMExports();
`;
const selected = '^(published current result survives a canceled same-input rerun|real SQLite store retains semantic fingerprints|GHI actual CSV ingestion|SQLite snow blank-to-70 correction|failed first analysis recovers through the actual page)';

for (const variable of process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR', 'TMP']) {
  test(`analysis SQLite fixtures honor ${variable} without a machine-specific fallback`, {timeout: 90000}, () => {
    const root = mkdtempSync(join(tmpdir(), 'sol-fixture-temp-'));
    try {
      const env = {...process.env};
      for (const key of ['TMPDIR', 'TMP', 'TEMP', 'NODE_TEST_CONTEXT']) delete env[key];
      env[variable] = root;
      env.SOL_TEST_TEMP_ROOT = root;
      const child = spawnSync(process.execPath, [
        '--import', 'data:text/javascript,' + encodeURIComponent(preload),
        '--test', '--test-reporter=tap', '--test-name-pattern=' + selected,
        'tests/analysis-jobs.test.mjs', 'tests/performance-analysis-data.test.mjs', 'tests/first-analysis-recovery.test.mjs',
      ], {cwd: fileURLToPath(new URL('../', import.meta.url)), env, encoding: 'utf8', timeout: 75000, maxBuffer: 4 * 1024 * 1024});
      assert.ifError(child.error);
      assert.equal(child.signal, null, child.stderr);
      assert.equal(child.status, 0, child.stdout + child.stderr);
      const observed = [...new Set([...child.stdout.matchAll(/TEMP_ROOT_CHECK:([a-z-]+)/g)].map(match => match[1]))].sort();
      assert.deepEqual(observed, ['analysis-ghi-', 'analysis-snow-', 'analysis-store-', 'publication-']);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
}
