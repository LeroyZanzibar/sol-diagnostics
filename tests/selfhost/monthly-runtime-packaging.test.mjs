import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));

// Reproduce only the final-stage COPY layout. This is an import/packaging test,
// not a Docker build or a substitute for native non-root/read-only image CI.
test('Dockerfile runtime COPY layout can import both monthly adapters without the source checkout', t => {
  const root = mkdtempSync(join(tmpdir(), 'sol-monthly-runtime-layout-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const dockerfile = readFileSync(join(repository, 'Dockerfile'), 'utf8');
  const stage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM ') + 1);
  const copies = stage.split(/\r?\n/).filter(line => line.startsWith('COPY '));
  assert.ok(copies.length > 0, 'Expected final-stage COPY instructions');
  const copied = [];
  for (const line of copies) {
    const args = line.split(/\s+/).slice(1).filter(arg => !arg.startsWith('--'));
    assert.equal(args.length, 2, `Keep the layout fixture explicit for unsupported COPY syntax: ${line}`);
    const [source, destination] = args;
    const relativeSource = source.replace(/^\/app\//, '');
    const from = resolve(repository, relativeSource);
    let to = resolve(root, destination);
    assert.ok(from.startsWith(repository), `COPY source escapes checkout: ${source}`);
    assert.ok(to === root || to.startsWith(root + sep), `COPY destination escapes fixture: ${destination}`);
    if (!statSync(from).isDirectory() && destination.endsWith('/')) to = join(to, basename(from));
    mkdirSync(dirname(to), {recursive: true});
    // Share installed third-party dependencies only. No app/selfhost source link
    // exists, so the runtime import cannot accidentally find a missing app file.
    if (relativeSource === 'node_modules') symlinkSync(from, to, 'dir');
    else cpSync(from, to, {recursive: true});
    copied.push(relativeSource);
  }
  for (const required of ['package.json', 'dist', 'drizzle', 'selfhost', 'node_modules']) assert.ok(copied.includes(required));
  const env = {...process.env};
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const {MonthlyStore} = await import('./selfhost/monthly-store.mjs');
    const {MonthlyService} = await import('./selfhost/monthly-rollups.mjs');
    assert.equal(typeof MonthlyStore, 'function');
    assert.equal(typeof MonthlyService, 'function');
    console.log('Both runtime monthly adapters imported from the final COPY layout.');
  `], {cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024});
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Isolated runtime import failed:\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Both runtime monthly adapters imported/);
  t.diagnostic(`Final COPY sources: ${copied.join(', ')}. Synthetic layout only; native image checks remain separate.`);
});
