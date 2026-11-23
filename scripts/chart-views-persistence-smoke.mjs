// Small synthetic saved-view scenario shared by native-image and production HTTP
// smoke. Only call with a fresh isolated app profile: views are not site-scoped.
import assert from 'node:assert/strict';

const endpoint = '/api/chart-views';
const detached = value => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
// Independent literals, not production validators or defaults. Preserve the
// deliberately nonalphabetical metric order, cross-year range and numeric zero.
const setups = freeze([
  {name: 'Synthetic monthly comparison', settings: {start: '2024-11', end: '2026-02', type: 'bar',
    comparisonYears: 2, metrics: ['iapr', 'utilityTotal', 'budgetRevenue', 'actualInsolation']}},
  {name: 'Synthetic monthly table', settings: {start: '2026-01', end: '2026-01', type: 'table',
    comparisonYears: 0, metrics: ['unpaidEnergy', 'revenue']}},
]);

/** Read-only comparison against the original detached JSON-serializable bytes. */
export async function verifyChartViewsPersistence({api, expected}) {
  assert.deepEqual(await api(endpoint), expected,
    'Saved chart-view names, IDs, creation timestamps and exact settings must persist');
}

/** api(path, method?, body?) returns JSON; request(path, options?) returns Response. */
export async function runChartViewsPersistenceSmoke({api, request}) {
  assert.deepEqual(await api(endpoint), {views: []}, 'Chart-view smoke requires a fresh synthetic profile');
  const sites = detached(await api('/api/site-settings'));
  const user = detached(await api('/api/user-settings'));
  const jsonPost = body => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  for (const options of [{authenticated: false}, {...jsonPost(setups[0]), authenticated: false}]) {
    const response = await request(endpoint, options);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') || '', /^Basic /);
  }
  const crossOrigin = jsonPost(setups[0]);
  crossOrigin.headers.Origin = 'https://untrusted.example';
  const denied = await request(endpoint, crossOrigin);
  assert.equal(denied.status, 403, await denied.text());
  assert.deepEqual(await api(endpoint), {views: []}, 'Rejected writes must not create a view');

  const views = [];
  for (const setup of setups) {
    const before = Date.now();
    const result = await api(endpoint, 'POST', detached({...setup, name: `  ${setup.name}  `}));
    assert.deepEqual(Object.keys(result), ['view']);
    const view = result.view;
    assert.deepEqual(Object.keys(view).sort(), ['createdAt', 'id', 'name', 'settings']);
    assert.match(view.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.ok(!views.some(existing => existing.id === view.id));
    assert.equal(view.name, setup.name);
    assert.deepEqual(view.settings, setup.settings, 'Independently check every submitted setting before snapshot capture');
    assert.equal(new Date(view.createdAt).toISOString(), view.createdAt);
    assert.ok(Date.parse(view.createdAt) >= before && Date.parse(view.createdAt) <= Date.now());
    views.push(detached(view));
    views.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    assert.deepEqual(await api(endpoint), {views}, 'Creation must have exact authoritative readback');
  }
  const expected = freeze(detached({views}));
  // Case-insensitive duplicate rejection must not replace the existing setup.
  const duplicate = await request(endpoint, jsonPost({...setups[0], name: setups[0].name.toUpperCase(),
    settings: {...setups[0].settings, comparisonYears: 1}}));
  assert.equal(duplicate.status, 409, await duplicate.text());
  await verifyChartViewsPersistence({api, expected});
  assert.deepEqual(await api('/api/site-settings'), sites, 'Saving profile views must not change sites');
  assert.deepEqual(await api('/api/user-settings'), user, 'Saving profile views must not change user settings');
  return {expected, verify: () => verifyChartViewsPersistence({api, expected})};
}
