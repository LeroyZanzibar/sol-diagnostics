import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { drizzle } from 'drizzle-orm/d1';
import { eq, desc, sql } from 'drizzle-orm';
import * as sqliteCore from 'drizzle-orm/sqlite-core';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as XLSX from 'xlsx';
import { LocalDatabase, LocalBucket } from '../selfhost/storage.mjs';
import { PerformanceStoreManager } from '../selfhost/performance-store.mjs';
import { loadSource, modelCapacityBindings } from './source-module.mjs';
import { versionedStore, performanceBindings } from './performance-analysis-fixture.mjs';

// Reuse the existing real-storage and actual-component harnesses without
// registering their suites a second time. Production code is not substituted.
function fixtureExports(path, names, bindings) {
  const parsed = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const source = parsed.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getFullText(parsed)).join('\n');
  const output = ts.transpileModule(source + `\nglobalThis.testExports = {${names.join(',')}};`, {
    fileName: 'first-analysis-fixtures.ts',
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = vm.createContext({ exports: {}, console, crypto: webcrypto, TextEncoder, TextDecoder,
    URL, Request, Response, Headers, Blob, File, ReadableStream, CompressionStream, DecompressionStream,
    setTimeout, clearTimeout, setImmediate, AbortController, test() {}, assert, ...bindings });
  vm.runInContext(output, context);
  return context.testExports;
}
const { canonicalFixture, finish } = fixtureExports('tests/analysis-jobs.test.mjs', ['canonicalFixture', 'finish'], {
  DatabaseSync, readFileSync, readdirSync, mkdtempSync, rmSync, join, drizzle, eq, desc, sql, sqliteCore,
  LocalDatabase, LocalBucket, PerformanceStoreManager, loadSource, modelCapacityBindings, versionedStore, performanceBindings, process,
});
const { home, button, html, nodes } = fixtureExports('tests/performance-data-ui.test.mjs', ['home', 'button', 'html', 'nodes'], {
  readFileSync, ts, React, renderToStaticMarkup, XLSX, loadSource,
});
const checkpoints = loadSource('app/api/performance-summary/checkpoint-storage.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const input = async (f, id) => plain(await checkpoints.readCheckpoint(await f.bucket.get(`analysis/site/jobs/${id}/input.json`)));
const jobRows = f => f.db.sqlite.prepare('SELECT * FROM analysis_jobs ORDER BY id').all();
const publications = f => f.db.sqlite.prepare('SELECT * FROM performance_summaries ORDER BY import_id').all();
async function retainedAttempt(f, attemptId) {
  const objects = [];
  for (const { key } of f.db.sqlite.prepare('SELECT key FROM __sol_objects WHERE key LIKE ? ORDER BY key').all(`analysis/site/jobs/${attemptId}/%`)) {
    objects.push([key, Buffer.from(await (await f.bucket.get(key)).arrayBuffer())]);
  }
  return {
    objects,
    provenance: plain(f.store.analysis(attemptId)),
    runs: f.db.sqlite.prepare('SELECT * FROM analysis_runs WHERE id=?').all(attemptId),
    occurrences: f.db.sqlite.prepare('SELECT * FROM performance_issue_occurrences WHERE analysis_run_id=? ORDER BY id').all(attemptId),
    reviews: f.db.sqlite.prepare('SELECT * FROM issue_event_reviews ORDER BY id').all(),
    audit: f.db.sqlite.prepare('SELECT * FROM issue_review_changes ORDER BY id').all(),
  };
}
async function eventually(check, message) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}
function actualPage(t, f) {
  const calls = [];
  const h = home({ performance: null, analysisState: null }, 'unknown', true, {
    queueMicrotask,
    window: { scrollTo() {}, clearTimeout, clearInterval() {}, setInterval() { return 0; },
      // Keep the actual load/poll loop, but don't wait between bounded steps.
      setTimeout: (fn, delay) => setTimeout(fn, delay >= 60_000 ? delay : 0) },
    fetch: async (url, options = {}) => {
      assert.match(String(url), /^\/api\/performance-summary(?:\?|$)/);
      const call = { method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null };
      calls.push(call);
      const request = new Request(`https://test${url}`, options);
      const response = await f.api[call.method](request);
      call.status = response.status;
      call.response = await response.clone().json();
      return response;
    },
  });
  let cleanup;
  t.after(() => cleanup?.());
  return {
    h, calls,
    async load() {
      cleanup?.();
      h.render();
      // Exercise the actual response normalization, progress state and polling
      // effect, not a hand-constructed approximation of its output.
      const effects = h.effects.filter(e => e.deps?.length === 3 && e.deps[0] === 'site'
        && e.deps[1] === h.state.performanceRevision && e.deps[2] === '');
      assert.equal(effects.length, 1);
      cleanup = effects[0].fn();
      await new Promise(resolve => setImmediate(resolve));
      await eventually(() => h.state.performance !== null, 'The actual page did not finish loading the analysis response');
      return h.render();
    },
    async click(tree, label) {
      const action = button(tree, label);
      assert.ok(action, `The actual page must offer ${label}`);
      assert.equal(action.props.disabled, false);
      const revision = h.state.performanceRevision;
      action.props.onClick();
      await eventually(() => h.state.performanceRevision === revision + 1, `${label} did not complete its explicit action`);
      return calls.filter(call => call.method === 'POST').at(-1);
    },
  };
}

for (const correction of ['data revision', 'equipment model']) {
  test(`failed first analysis recovers through the actual page using corrected current ${correction}, not pinned Retry`, async t => {
    const f = await canonicalFixture(t);
    // A single configured revenue meter has no readings yet. The existing
    // Energy source is initially modeled as a weather sensor, not a second meter.
    f.db.sqlite.prepare("UPDATE equipment_assets SET type='weather_sensor' WHERE id='meter'").run();
    f.db.sqlite.prepare("INSERT INTO equipment_assets (id,site_id,type,name,external_id) VALUES ('meter2','site','revenue_meter','Configured meter','M2')").run();
    f.db.sqlite.prepare("UPDATE equipment_assets SET parent_id='meter2' WHERE id='inv'").run();
    const failed = await finish(f);
    assert.equal(failed.hasData, false);
    assert.equal(failed.progress.status, 'failed');
    assert.match(failed.progress.error, /Analysis could not complete/);
    const originalId = failed.progress.attemptId;
    const originalInput = await input(f, originalId);
    const originalEvidence = await retainedAttempt(f, originalId);
    assert.ok(originalInput.equipment.some(asset => asset.id === 'meter2'));
    assert.equal(originalInput.provenance.revision, 1);
    assert.deepEqual(publications(f), []);

    if (correction === 'data revision') {
      await f.commit(f.rows.filter(row => row.channel.equipmentId === 'meter' && row.channel.measurement === 'Energy')
        .map(row => ({ ...row, channel: { ...row.channel, id: 'meter2-energy', equipmentId: 'meter2' } })));
    } else {
      f.db.sqlite.prepare("UPDATE equipment_assets SET type='revenue_meter' WHERE id='meter'").run();
      f.db.sqlite.prepare("UPDATE equipment_assets SET parent_id='meter' WHERE id='inv'").run();
      f.db.sqlite.prepare("DELETE FROM equipment_assets WHERE id='meter2'").run();
    }
    const sourceBefore = plain(f.store.describe());
    const stoppedBefore = jobRows(f);
    const page = actualPage(t, f);
    let tree = await page.load();
    const stoppedResponse = page.calls.at(-1).response;
    assert.equal(stoppedResponse.hasData, false);
    assert.equal(stoppedResponse.progress.attemptId, originalId);
    assert.equal(page.h.state.analysisState.status, 'failed');
    assert.ok(button(tree, 'Retry analysis'));
    // This is the original defect's RED: a genuine corrected-source response
    // rendered only Retry, which must never silently pick up those corrections.
    assert.ok(button(tree, 'Run analysis'), 'Corrected current inputs need an explicit fresh-analysis action alongside pinned Retry');
    assert.equal(stoppedResponse.analysisRequired, true);
    assert.equal(nodes(tree).filter(node => node.type === 'button' && html(node).includes('Run analysis')).length, 1);
    assert.match(html(tree), /Run analysis.*current data and model/);
    assert.match(html(tree), /Retry analysis.*original saved data and model/);
    assert.ok(page.calls.every(call => call.method === 'GET'), 'Browsing must never create work');
    assert.deepEqual(jobRows(f), stoppedBefore);
    assert.deepEqual(await retainedAttempt(f, originalId), originalEvidence);
    assert.deepEqual(publications(f), []);

    const retry = await page.click(tree, 'Retry analysis');
    assert.deepEqual(retry.body, { siteId: 'site', attemptId: originalId, action: 'retry' });
    assert.equal(retry.status, 202);
    const retryId = retry.response.progress.attemptId;
    assert.notEqual(retryId, originalId, 'A failed read retains the existing replacement-attempt Retry semantics');
    const retryInput = await input(f, retryId);
    assert.deepEqual(retryInput, { ...originalInput, provenance: null });
    tree = await page.load();
    assert.equal(page.h.state.performance.hasData, false);
    assert.equal(page.h.state.analysisState.attemptId, retryId);
    assert.equal(page.h.state.analysisState.status, 'failed', 'Retry still uses the incomplete original inputs');
    assert.match(page.h.state.analysisState.error, /Analysis could not complete/);
    assert.deepEqual(await retainedAttempt(f, originalId), originalEvidence);
    assert.deepEqual(publications(f), []);

    const retriedBefore = jobRows(f);
    const retryEvidence = await retainedAttempt(f, retryId);
    const fresh = await page.click(tree, 'Run analysis');
    assert.deepEqual(fresh.body, { siteId: 'site', action: 'reanalyze' });
    assert.equal(fresh.status, 202);
    const freshId = fresh.response.progress.attemptId;
    assert.notEqual(freshId, originalId);
    assert.notEqual(freshId, retryId);
    const freshInput = await input(f, freshId);
    assert.equal(JSON.parse(freshInput.record.validation).datasetRevision, sourceBefore.revision);
    assert.equal(freshInput.equipment.some(asset => asset.id === 'meter2'), correction === 'data revision');
    if (correction === 'equipment model') assert.notEqual(freshInput.modelRevision, originalInput.modelRevision);
    else assert.equal(freshInput.modelRevision, originalInput.modelRevision);

    tree = await page.load();
    const published = plain(page.h.state.performance);
    assert.equal(published.hasData, true, JSON.stringify(published));
    assert.equal(published.issueDatabase.analysisRunId, freshId);
    assert.equal(published.provenance.revision, sourceBefore.revision);
    assert.equal(published.methodology.modelRevision, freshInput.modelRevision);
    assert.deepEqual(published.methodology.equipmentModel, freshInput.equipment);
    assert.equal(published.dataFreshness.status, 'current');
    assert.equal(published.analysisRequired, undefined);
    assert.equal(page.h.state.analysisState, null);
    assert.ok(button(tree, 'Reanalyze current data'));
    assert.equal(button(tree, 'Retry analysis'), undefined);
    assert.equal(publications(f).length, 1);
    assert.equal(JSON.parse(publications(f)[0].summary).analysisRunId, freshId);
    assert.deepEqual(jobRows(f).filter(row => row.attempt_id !== freshId), retriedBefore, 'Fresh analysis must not rewrite the stopped job');
    assert.deepEqual(await retainedAttempt(f, originalId), originalEvidence);
    assert.deepEqual(await retainedAttempt(f, retryId), retryEvidence);
    assert.deepEqual(plain(f.store.describe()), sourceBefore, 'Analysis cannot modify the canonical source');
    assert.deepEqual(page.calls.filter(call => call.method === 'POST').map(call => call.body.action), ['retry', 'reanalyze']);
  });
}
