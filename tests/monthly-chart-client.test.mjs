import test from 'node:test';
import assert from 'node:assert/strict';
import {chartHarness, deferred} from './monthly-chart-client-fixture.mjs';
import {snapshot, settings, loadChartModel} from './monthly-chart-model-fixture.mjs';
import {calculatedRows} from '../app/monthly-domain.mjs';

async function mount(t, fetch, siteId = 'chart-site') {
  const h = chartHarness(fetch);
  t.after(() => h.dispose());
  h.render(siteId);
  await h.flush();
  return h;
}

test('initial private no-store GET remains stable across multiple former polling periods without editor or write side effects', async t => {
  const calls = [], s = snapshot(undefined, 'site with / &?');
  const h = await mount(t, async (url, options) => {calls.push({url, options}); return Response.json(s);}, s.siteId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/monthly-data?siteId=site%20with%20%2F%20%26%3F');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.match(new Headers(calls[0].options.headers).get('Cache-Control'), /no-store/);
  assert.equal(calls[0].options.body, undefined);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(h.current.snapshot.siteId, s.siteId);
  assert.equal(h.current.refreshing, false);
  assert.equal(h.current.error, '');
  const accepted = h.current.snapshot;
  const model = loadChartModel(), config = settings({metrics: ['utilityTotal', 'expectedProduction', 'iapr']});
  const series = model.buildChartSeries(accepted, config, h.current);
  for (const elapsed of [14999, 1, 15000, 15000, 60000]) {
    await h.tick(elapsed);
    assert.equal(calls.length, 1, 'elapsed time must not read monthly data again');
    assert.equal(h.current.snapshot, accepted);
    assert.equal(h.current.refreshing, false);
    assert.equal(h.current.error, '');
    assert.deepEqual(model.buildChartSeries(h.current.snapshot, config, h.current), series);
  }
  assert.equal(h.timerCount, 0, 'settled reads leave no background timer');
  assert.ok(calls.every(call => call.options.method === 'GET' && call.options.body === undefined));
  assert.deepEqual(Object.keys(h.current).sort(), ['error', 'refreshing', 'reload', 'snapshot']);
});

test('site changes hide prior data on the first render and abort/fence delayed old site responses', async t => {
  const pending = deferred(), calls = [];
  const h = await mount(t, async (url, options) => {
    calls.push({url, options});
    if (url.endsWith('site-a')) return calls.length === 1 ? Response.json(snapshot(undefined, 'site-a')) : pending.promise;
    return Response.json(snapshot(undefined, 'site-b'));
  }, 'site-a');
  assert.equal(h.current.snapshot.siteId, 'site-a');
  const oldReload = h.current.reload();
  await h.flush();
  assert.equal(calls.length, 2, 'old-site request is actually in flight before changing site');
  assert.equal(h.render('site-b').snapshot, null, 'no old site flash before effects');
  assert.equal(h.current.error, '');
  await h.flush();
  assert.equal(calls[1].options.signal.aborted, true);
  assert.equal(h.current.snapshot.siteId, 'site-b');
  pending.resolve(Response.json(snapshot(undefined, 'site-a')));
  await oldReload; await h.flush();
  assert.equal(h.current.snapshot.siteId, 'site-b');
  assert.equal(h.current.refreshing, false);
});

test('newer reload fences delayed same-site response and delayed response body even when abort is ignored', async t => {
  const body = deferred(), calls = [];
  const old = snapshot(); old.utility['2026-01'].revenue = '1';
  const newer = snapshot(); newer.utility['2026-01'].revenue = '2';
  const h = await mount(t, async (_url, options) => {
    calls.push(options);
    return calls.length === 1 ? {ok: true, status: 200, text: () => body.promise} : Response.json(newer);
  });
  assert.equal(calls.length, 1);
  assert.equal(h.current.refreshing, true);
  await h.current.reload(); await h.flush();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(h.current.snapshot.utility['2026-01'].revenue, '2');
  body.resolve(JSON.stringify(old)); await h.flush();
  assert.equal(h.current.snapshot.utility['2026-01'].revenue, '2');
  assert.equal(h.current.refreshing, false);
  assert.equal(h.current.error, '');
});

test('accepted snapshots always re-adapt DC-model changes despite unchanged input and telemetry revisions', async t => {
  const first = snapshot(), second = snapshot();
  second.capacity.dcKwp = {n: '240', d: '1'};
  second.calculated = calculatedRows(second.projections, second.utility, second.telemetry, second.capacity);
  let calls = 0;
  const h = await mount(t, async () => Response.json(++calls === 1 ? first : second));
  const model = loadChartModel(), config = settings({metrics: ['actualSpecificYield']});
  assert.equal(model.buildChartSeries(h.current.snapshot, config)[0].points[0].plotValue, 100);
  const before = h.current.snapshot;
  await h.current.reload(); await h.flush();
  assert.notEqual(h.current.snapshot, before);
  assert.equal(h.current.snapshot.revision, before.revision);
  assert.equal(h.current.snapshot.telemetry.sourceRevision, before.telemetry.sourceRevision);
  assert.equal(model.buildChartSeries(h.current.snapshot, config)[0].points[0].plotValue, 50);
});

test('refreshing and failed reads retain utility but make telemetry freshness explicit until retry succeeds', async t => {
  const pending = deferred(); let calls = 0;
  const h = await mount(t, async () => ++calls === 2 ? pending.promise : Response.json(snapshot()));
  const model = loadChartModel(), config = settings({metrics: ['utilityTotal', 'expectedProduction', 'iapr']});
  const reload = h.current.reload(); await h.flush();
  assert.equal(h.current.refreshing, true);
  let series = model.buildChartSeries(h.current.snapshot, config, h.current);
  assert.equal(series[0].points[0].plotValue, 12000);
  assert.equal(series[1].points[0].state, 'stale');
  pending.reject(new Error('Synthetic network read failure'));
  await reload; await h.flush();
  assert.match(h.current.error, /Synthetic network read failure/);
  assert.equal(h.current.refreshing, false);
  assert.notEqual(h.current.snapshot, null);
  series = model.buildChartSeries(h.current.snapshot, config, h.current);
  assert.equal(series[0].points[0].plotValue, 12000);
  assert.equal(series[2].points[0].display, '—');
  assert.match(series[2].points[0].reason, /freshness/i);
  await h.current.reload(); await h.flush();
  assert.equal(h.current.error, '');
  assert.equal(model.buildChartSeries(h.current.snapshot, config, h.current)[2].points[0].plotValue, 120);
});

test('15-second timeout releases a stuck fetch, never auto-retries, ignores its late response, and lets explicit retry recover', async t => {
  const stuck = deferred(), calls = [];
  const h = await mount(t, async (_url, options) => {
    calls.push(options);
    return calls.length === 1 ? stuck.promise : Response.json(snapshot());
  });
  assert.equal(h.current.refreshing, true);
  await h.tick(14999); assert.equal(calls.length, 1); assert.equal(h.current.refreshing, true);
  await h.tick(1);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(h.current.refreshing, false);
  assert.match(h.current.error, /timed out/i);
  assert.equal(calls.length, 1);
  for (let period = 0; period < 4; period++) {
    await h.tick(15000);
    assert.equal(calls.length, 1, 'timeout must wait for explicit retry');
    assert.match(h.current.error, /timed out/i);
    assert.equal(h.current.snapshot, null);
  }
  assert.equal(h.timerCount, 0);
  await h.current.reload(); await h.flush();
  assert.equal(calls.length, 2);
  assert.equal(h.current.snapshot.siteId, 'chart-site');
  const late = snapshot(); late.utility['2026-01'].revenue = '999';
  stuck.resolve(Response.json(late)); await h.flush();
  assert.equal(h.current.snapshot.utility['2026-01'].revenue, '1200');
  assert.equal(h.current.error, '');
});

test('request timeout covers a stuck response body, not just fetching the response headers', async t => {
  const body = deferred(); let signal;
  const h = await mount(t, async (_url, options) => {
    signal = options.signal;
    return {ok: true, status: 200, text: () => body.promise};
  });
  assert.equal(h.current.refreshing, true);
  await h.tick(15000);
  assert.equal(signal.aborted, true);
  assert.equal(h.current.refreshing, false);
  assert.match(h.current.error, /timed out/i);
  body.resolve(JSON.stringify(snapshot())); await h.flush();
  assert.equal(h.current.snapshot, null);
  assert.match(h.current.error, /timed out/i);
});

test('HTTP, malformed JSON and wrong-site responses fail visibly without accepting misleading snapshots', async t => {
  for (const [response, pattern] of [
    [Response.json({error: 'Synthetic service unavailable'}, {status: 503}), /Synthetic service unavailable/],
    [new Response('<html>Login required</html>', {status: 401}), /401/],
    [new Response('not json', {status: 200}), /response|JSON/i],
    [Response.json(snapshot(undefined, 'another-site')), /different site/i],
    [Response.json({siteId: 'chart-site'}), /invalid|incomplete|response/i],
  ]) {
    let calls = 0;
    const h = await mount(t, async () => {calls++; return response.clone();});
    assert.equal(h.current.snapshot, null);
    assert.equal(h.current.refreshing, false);
    assert.match(h.current.error, pattern);
    const error = h.current.error;
    for (let period = 0; period < 4; period++) {
      await h.tick(15000);
      assert.equal(calls, 1, 'failed reads must not retry automatically');
      assert.equal(h.current.error, error);
      assert.equal(h.current.refreshing, false);
      assert.equal(h.current.snapshot, null);
    }
    assert.equal(h.timerCount, 0);
    h.dispose();
  }
});

test('cleanup aborts in-flight work and every timer; empty site never fetches or exposes prior errors', async t => {
  const pending = deferred(), calls = [];
  const h = await mount(t, async (_url, options) => {calls.push(options); return pending.promise;});
  assert.equal(calls.length, 1);
  assert.ok(h.timerCount > 0);
  h.dispose();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(h.timerCount, 0);
  pending.resolve(Response.json(snapshot())); await h.flush();
  assert.equal(h.updatesAfterDispose, 0);
  await h.tick(60000); assert.equal(calls.length, 1);
  let emptyCalls = 0;
  const empty = await mount(t, async () => {emptyCalls++; return Response.json(snapshot());}, '');
  assert.equal(emptyCalls, 0);
  assert.equal(empty.current.snapshot, null);
  assert.equal(empty.current.refreshing, false);
  assert.equal(empty.timerCount, 0);
  const populated = await mount(t, async () => Response.json(snapshot()));
  assert.notEqual(populated.current.snapshot, null);
  assert.equal(populated.render('').snapshot, null);
  assert.equal(populated.current.error, '');
  await populated.flush();
  assert.equal(populated.current.refreshing, false);
});
