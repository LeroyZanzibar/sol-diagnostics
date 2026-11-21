// Bounded synthetic monthly API scenario shared by native-image smoke and real
// production HTTP tests. Creates its own new site; never touches an existing one.
import assert from 'node:assert/strict';

const endpoint = '/api/monthly-data';
const pathFor = siteId => `${endpoint}?siteId=${encodeURIComponent(siteId)}`;
const performancePath = siteId => `/api/performance-data?siteId=${encodeURIComponent(siteId)}`;
const detached = value => JSON.parse(JSON.stringify(value));
const missingTelemetry = {state: 'missing', sourceRevision: 0, timezone: null, months: {}, candidates: [],
  selectionRequired: false, selectedChannelId: null, expectedChannelId: null, expectedUnavailableReason: null};
const emptyConfiguration = () => ({operationsStart: null, degradation: null, irradianceChannelId: null,
  baselines: Object.fromEntries(Array.from({length: 12}, (_, i) => [i + 1, {production: null, revenue: null, insolation: null}]))});

// These literals are independent spot checks, not another projection algorithm.
// All 300 preview-approved rows are retained and compared exactly on readback.
const projectionChecks = [
  {month: '2026-01', operationalDays: 16, days: 31, production: {n: '49602', d: '31'},
    revenue: {n: '24801', d: '155'}, insolation: {n: '498', d: '31'}},
  {month: '2026-02', operationalDays: 28, days: 28, production: {n: '24801', d: '8'},
    revenue: {n: '24801', d: '80'}, insolation: {n: '249', d: '8'}},
  {month: '2027-01', operationalDays: 31, days: 31, production: {n: '19171173', d: '6200'},
    revenue: {n: '19171173', d: '62000'}, insolation: {n: '249', d: '8'}},
];

function telemetryFor(dataset, weather, corrected) {
  const metric = value => ({value, coveredMilliseconds: 7200000, partialIntervals: 0,
    unknownQualityIntervals: 0, negativeIntervals: 0, state: 'partial'});
  return {state: 'current', sourceRevision: dataset.revision, revisionId: dataset.revisionId, timezone: 'UTC',
    selectionKey: 'null', selectedChannelId: weather.id, selectionRequired: false, candidates: [weather],
    expectedChannelId: '["@site","Expected Production","forecast"]', expectedUnavailableReason: null,
    months: {'2026-01': {
      expected: metric({n: corrected ? '339' : '291', d: '8'}),
      insolation: {...metric({n: '1', d: '2'}), source: 'Imported irradiance; satellite/POA provenance unknown',
        satelliteIntervals: 0, poaIntervals: 0, unknownSourceIntervals: 2},
      expectedMilliseconds: 2678400000,
    }}, calculationVersion: 2};
}

/** Read-only verification against a detached, JSON-serializable expectation. */
export async function verifyMonthlyPersistence({api, expected}) {
  const {siteId, monthly, model, canonical, receipts} = expected;
  assert.deepEqual(await api(pathFor(siteId)), monthly,
    'Exact monthly input strings, 300 approved projections and revision-pinned telemetry must persist');
  assert.deepEqual(await api(`/api/equipment?siteId=${encodeURIComponent(siteId)}`), model);
  assert.deepEqual(await api(performancePath(siteId)), canonical,
    'Monthly reporting must not create imports or change canonical revision/audit');
  for (const receipt of receipts) {
    assert.deepEqual((await api(`${performancePath(siteId)}&stageId=${encodeURIComponent(receipt.stageId)}`)).preview, receipt);
  }
}

/** api(path, method?, body?) returns JSON; request(path, options?) returns Response. */
export async function runMonthlyPersistenceSmoke({api, request}) {
  const site = (await api('/api/site-settings', 'POST', {
    name: 'Synthetic monthly container persistence', country: 'US', latitude: '35.2', longitude: '-80.8',
  })).site;
  const siteId = site.id;
  assert.ok(siteId);
  const post = body => api(endpoint, 'POST', {siteId, ...body});
  const initial = {siteId, revision: 0, configuration: emptyConfiguration(), utility: {}, projections: [], telemetry: missingTelemetry};
  assert.deepEqual(await api(pathFor(siteId)), initial, 'Monthly smoke must start on a fresh synthetic site');
  const empty = await api(performancePath(siteId));
  assert.equal(empty.dataset.revision, 0);
  assert.equal(empty.dataset.readingCount, 0);
  assert.deepEqual(empty.imports, []);
  assert.equal(empty.requiresMigration, false);
  assert.deepEqual((await api(`/api/equipment?siteId=${encodeURIComponent(siteId)}`)).equipment, []);
  assert.equal((await request(pathFor(siteId), {authenticated: false})).status, 401);
  const denied = await request(endpoint, {method: 'POST', headers: {
    Origin: 'https://untrusted.example', 'Content-Type': 'application/json'},
    body: JSON.stringify({siteId, action: 'preview', revision: 0, configuration: initial.configuration})});
  assert.equal(denied.status, 403, await denied.text());
  assert.deepEqual(await api(pathFor(siteId)), initial);

  // Single on-peak, single off-peak, both present (including zero), both absent;
  // accepted decimal strings and signed utility-money credits remain unrounded.
  const rows = [
    {month: '2026-01', onPeak: '123.1234567890123456', offPeak: null, revenue: '-12.3450', energyUsed: '0', invoiceCost: null},
    {month: '2026-02', onPeak: null, offPeak: '45.67890', revenue: null, energyUsed: null, invoiceCost: '0'},
    {month: '2026-03', onPeak: '0', offPeak: '0.000000000000000001', revenue: '0', energyUsed: '7.1250', invoiceCost: '-0.1250'},
    {month: '2026-04', onPeak: null, offPeak: null, revenue: '-1.25', energyUsed: null, invoiceCost: '000.01230'},
  ];
  const utility = Object.fromEntries(rows.map(({month, ...values}) => [month, values]));
  const afterUtility = {...initial, revision: 1, utility};
  assert.deepEqual(await post({action: 'utility', revision: 0, rows}), afterUtility);
  assert.deepEqual(await api(pathFor(siteId)), afterUtility, 'An unrelated utility save must not invent degradation');

  const configuration = {operationsStart: '2026-01-16', degradation: '0.50', irradianceChannelId: null,
    baselines: Object.fromEntries(Array.from({length: 12}, (_, i) => [i + 1,
      {production: '3100.1250', revenue: '310.01250', insolation: '31.1250'}]))};
  const preview = await post({action: 'preview', revision: 1, configuration});
  assert.equal(preview.siteId, siteId);
  assert.equal(preview.revision, 1);
  assert.deepEqual(preview.configuration, configuration);
  assert.ok(preview.token);
  assert.equal(preview.impact.length, 300);
  assert.deepEqual(preview.retainedOutsideWindow, []);
  assert.equal(preview.sourceChanged, false);
  const projections = detached(preview.impact.map(item => {
    assert.equal(item.before, null);
    assert.equal(item.month, item.after.month);
    for (const field of ['production', 'revenue', 'insolation']) assert.ok(item.after[field]);
    return item.after;
  }));
  assert.equal(new Set(projections.map(row => row.month)).size, 300);
  assert.deepEqual(projections.map(row => row.month), [...projections.map(row => row.month)].sort());
  assert.equal(projections.at(-1).month, '2050-12');
  for (const expected of projectionChecks) assert.deepEqual(projections.find(row => row.month === expected.month), expected);
  assert.deepEqual(await api(pathFor(siteId)), afterUtility, 'Preview must not save configuration or projections');
  const configured = {siteId, revision: 2, configuration, utility, projections, telemetry: missingTelemetry};
  assert.deepEqual(await post({action: 'configuration', revision: 1, configuration, previewToken: preview.token}), configured);
  assert.deepEqual(await api(pathFor(siteId)), configured, 'Explicit save must match approved preview and exact input strings');

  const id = suffix => `monthly-${siteId}-${suffix}`;
  const node = (suffix, type, parent = null) => ({id: id(suffix), name: `Synthetic ${suffix}`, externalId: id(suffix),
    type, parentId: parent ? id(parent) : null, quantity: 1, aliases: [], channels: []});
  const equipment = [node('meter', 'revenue_meter'),
    {...node('transformer', 'transformer', 'meter'), nameplateKva: '200'},
    {...node('inverter', 'inverter', 'transformer'), acRatedCapacityKw: '100', maxDcCapacityKw: '150'},
    {...node('modules', 'module_group', 'inverter'), moduleRatedCapacityW: '400', quantity: 300},
    node('weather', 'weather_sensor')];
  const savedModel = await api('/api/equipment', 'PUT', {siteId, equipment, verified: true});
  assert.equal(savedModel.verified, true);
  assert.deepEqual(savedModel.idAdjustments, []);
  assert.deepEqual(savedModel.nodeIdAdjustments, []);
  const model = await api(`/api/equipment?siteId=${encodeURIComponent(siteId)}`);
  assert.deepEqual(model, {equipment: savedModel.equipment, verified: true});
  assert.equal(model.equipment.length, equipment.length);
  for (const asset of equipment) {
    const saved = model.equipment.find(row => row.id === asset.id);
    assert.ok(saved);
    for (const key of Object.keys(asset)) assert.deepEqual(saved[key], asset[key]);
  }
  const weather = {id: JSON.stringify([id('weather'), 'Irradiance', null]), equipmentId: id('weather'), measurement: 'Irradiance', unit: 'W/m²'};
  const readings = [
    {timestamp: '2026-01-01T12:00:00Z', equipmentId: '@site', measurement: 'Expected Production', channelId: 'forecast', value: 12.125, unit: 'kWh'},
    {timestamp: '2026-01-01T12:00:00Z', equipmentId: id('weather'), measurement: 'Irradiance', value: 500, unit: 'W/m²'},
    {timestamp: '2026-01-01T13:00:00Z', equipmentId: '@site', measurement: 'Expected Production', channelId: 'forecast', value: 24.25, unit: 'kWh'},
    {timestamp: '2026-01-01T13:00:00Z', equipmentId: id('weather'), measurement: 'Irradiance', value: 0, unit: 'W/m²'},
  ];
  const receipts = [];
  let monthly = configured;
  for (const corrected of [false, true]) {
    const incoming = corrected ? [{...readings[0], value: 18.125}] : readings;
    const revision = corrected ? 2 : 1;
    const {preview: staged} = await api('/api/performance-data', 'POST', {
      action: 'preview', siteId, timezone: 'UTC', timestampConvention: 'start', intervalMinutes: 60,
      fileName: corrected ? 'Synthetic monthly correction' : 'Synthetic monthly seed', readings: incoming,
    });
    assert.equal(staged.baseRevision, revision - 1);
    assert.equal(staged.readingCount, incoming.length);
    assert.equal(staged.status, 'preview');
    assert.deepEqual(staged.counts, corrected
      ? {added: 0, overlapping: 1, changed: 1, identical: 0, blankPreserved: 0}
      : {added: 4, overlapping: 0, changed: 0, identical: 0, blankPreserved: 0});
    assert.deepEqual(await api(pathFor(siteId)), monthly, 'Staging telemetry must not change monthly reports');
    const committed = await api('/api/performance-data', 'POST', {
      action: 'commit', siteId, stageId: staged.stageId, previewToken: staged.previewToken, approveOverlap: corrected,
    });
    assert.equal(committed.committed, true);
    assert.equal(committed.dataset.revision, revision);
    assert.equal(committed.dataset.readingCount, 4);
    assert.equal(committed.dataset.timestampCount, 2);
    assert.equal(committed.dataset.channelCount, 2);
    assert.equal(committed.dataset.timezone, 'UTC');
    assert.equal(committed.dataset.intervalMinutes, 60);
    assert.ok(committed.dataset.revisionId);
    assert.deepEqual(committed.result, {siteId, stageId: staged.stageId, revision, revisionId: committed.dataset.revisionId,
      committedAt: committed.dataset.updatedAt, counts: staged.counts});
    receipts.push({...staged, status: 'committed', result: committed.result});
    monthly = {...configured, telemetry: telemetryFor(committed.dataset, weather, corrected)};
    assert.deepEqual(await api(pathFor(siteId)), monthly, 'Monthly telemetry must follow the committed revision, not stale cached values');
  }
  const canonical = await api(performancePath(siteId));
  assert.equal(canonical.dataset.revision, 2);
  assert.equal(canonical.imports.length, 2);
  assert.deepEqual(canonical.imports.map(item => [item.stageId, item.overlapApproved]),
    [...receipts].reverse().map((receipt, index) => [receipt.stageId, index === 0]));
  const expected = detached({siteId, monthly, model, canonical, receipts});
  await verifyMonthlyPersistence({api, expected});
  return {expected, verify: () => verifyMonthlyPersistence({api, expected})};
}
