// Bounded synthetic API scenario shared by native-image smoke and production
// HTTP tests. Only call this with a newly created, empty synthetic site.
import assert from 'node:assert/strict';

const endpoint = '/api/performance-data';
const datasetPath = siteId => `${endpoint}?siteId=${encodeURIComponent(siteId)}`;
const stagePath = (siteId, stageId) => `${datasetPath(siteId)}&stageId=${encodeURIComponent(stageId)}`;
const counts = (added, overlapping = 0, changed = 0, identical = 0) =>
  ({added, overlapping, changed, identical, blankPreserved: 0});
const ordered = rows => [...rows].sort((a, b) =>
  a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.channel.id < b.channel.id ? -1 : a.channel.id > b.channel.id ? 1 : 0);
const incoming = rows => rows.map(({timestamp, channel, value}) =>
  ({timestamp, equipmentId: channel.equipmentId, measurement: channel.measurement, unit: channel.unit, value}));
const samples = rows => rows.map(({timestamp, channel, value}) => ({timestamp, channel, previous: value, incoming: value}));

async function preview(api, siteId, readings, fileName) {
  const {preview: staged} = await api(endpoint, 'POST', {
    action: 'preview', siteId, timezone: 'UTC', timestampConvention: 'start', intervalMinutes: 60, fileName, readings,
  });
  assert.equal(staged.siteId, siteId);
  assert.equal(staged.status, 'preview');
  assert.ok(staged.stageId && staged.previewToken);
  assert.equal(staged.metadata.source, 'api');
  assert.equal(staged.metadata.fileName, fileName);
  assert.equal(staged.metadata.timezone, 'UTC');
  assert.equal(staged.metadata.sourceTimestampConvention, 'start');
  assert.equal(staged.metadata.intervalMinutes, 60);
  assert.deepEqual((await api(stagePath(siteId, staged.stageId))).preview, staged);
  return staged;
}

const commitBody = (siteId, staged, approveOverlap) => ({
  action: 'commit', siteId, stageId: staged.stageId, previewToken: staged.previewToken, approveOverlap,
});

async function commit(api, siteId, staged, approveOverlap, rows, revision) {
  const saved = await api(endpoint, 'POST', commitBody(siteId, staged, approveOverlap));
  assert.equal(saved.committed, true);
  assert.equal(saved.dataset.siteId, siteId);
  assert.equal(saved.dataset.revision, revision);
  assert.equal(saved.dataset.readingCount, rows.length);
  assert.equal(saved.dataset.timestampCount, new Set(rows.map(row => row.timestamp)).size);
  assert.equal(saved.dataset.channelCount, new Set(rows.map(row => row.channel.id)).size);
  assert.equal(saved.dataset.timestampStart, rows[0].timestamp);
  assert.equal(saved.dataset.timestampEnd, rows.at(-1).timestamp);
  assert.equal(saved.dataset.timezone, 'UTC');
  assert.equal(saved.dataset.intervalMinutes, 60);
  assert.ok(saved.dataset.revisionId && saved.dataset.updatedAt);
  assert.deepEqual(saved.result, {siteId, stageId: staged.stageId, revision,
    revisionId: saved.dataset.revisionId, committedAt: saved.dataset.updatedAt, counts: staged.counts});
  const receipt = {...staged, status: 'committed', result: saved.result};
  assert.deepEqual((await api(stagePath(siteId, staged.stageId))).preview, receipt);
  return {dataset: saved.dataset, rows, receipt};
}

async function assertHead(api, expected) {
  const saved = await api(datasetPath(expected.siteId));
  assert.deepEqual(saved.dataset, expected.revisions.at(-1).dataset, 'Canonical dataset identity/counts must be unchanged');
  assert.deepEqual(saved.imports, expected.imports, 'Commit identities and approval audit must be retained exactly');
  assert.equal(saved.requiresMigration, false);
  assert.equal(saved.legacyImport, null);
}

/** Verify a JSON-serializable snapshot using only the existing parsed api(). */
export async function verifyPerformancePersistence({api, expected}) {
  const {siteId, model, revisions} = expected;
  const head = revisions.at(-1);
  await assertHead(api, expected);
  const inventory = await api('/api/site-settings');
  assert.ok(inventory.sites.some(site => site.id === siteId));
  assert.ok(inventory.sitesWithPerformanceData.includes(siteId));
  assert.deepEqual(await api(`/api/equipment?siteId=${encodeURIComponent(siteId)}`), model);
  for (const revision of revisions) {
    const receipt = (await api(stagePath(siteId, revision.receipt.stageId))).preview;
    assert.deepEqual(receipt, revision.receipt, 'Committed stage receipts must survive restart/recreation');
    const audit = expected.imports.find(item => item.stageId === receipt.stageId);
    const replay = await api(endpoint, 'POST', commitBody(siteId, receipt, audit.overlapApproved));
    assert.equal(replay.committed, true);
    assert.deepEqual(replay.result, receipt.result, 'Replaying a committed stage must return the original receipt');
    assert.deepEqual(replay.dataset, head.dataset, 'Receipt replay must not create another revision');
  }
  // GET describes counts but not values. All six rows fit in the bounded preview
  // sample: its previous values prove every saved key/value, not just metadata.
  // Cancel the probe, then read back both its cancellation and unchanged head.
  const probe = await preview(api, siteId, incoming(head.rows), 'Synthetic persistence readback');
  try {
    assert.equal(probe.baseRevision, head.dataset.revision);
    assert.equal(probe.readingCount, head.rows.length);
    assert.equal(probe.channelCount, head.dataset.channelCount);
    assert.deepEqual(probe.counts, counts(0, head.rows.length, 0, head.rows.length));
    assert.deepEqual(ordered(probe.samples), samples(head.rows), 'Omitted timestamps/channels and zero values must survive');
  } finally {
    const canceled = (await api(endpoint, 'POST', {action: 'cancel', siteId, stageId: probe.stageId})).preview;
    assert.deepEqual(canceled, {...probe, status: 'canceled'});
    assert.deepEqual((await api(stagePath(siteId, probe.stageId))).preview, canceled);
  }
  await assertHead(api, expected);
}

/** api(path, method?, body?) returns JSON; request(path, options?) returns Response. */
export async function runPerformancePersistenceSmoke({api, request, siteId, actor = 'tester'}) {
  const empty = await api(datasetPath(siteId));
  assert.equal(empty.dataset.revision, 0, 'Use a new synthetic site, never an existing dataset');
  assert.equal(empty.dataset.readingCount, 0);
  assert.deepEqual(empty.imports, []);
  assert.equal(empty.requiresMigration, false);
  const equipmentPath = `/api/equipment?siteId=${encodeURIComponent(siteId)}`;
  assert.deepEqual((await api(equipmentPath)).equipment, [], 'Do not replace an existing array model');
  const id = suffix => `smoke-${siteId}-${suffix}`;
  const node = (suffix, type, parent = null) => ({id: id(suffix), name: `Synthetic ${suffix}`,
    externalId: id(suffix), type, parentId: parent ? id(parent) : null, quantity: 1, aliases: [], channels: []});
  // Exactly one revenue meter, with a complete rated inverter/module hierarchy.
  const equipment = [node('meter', 'revenue_meter'),
    {...node('transformer', 'transformer', 'meter'), nameplateKva: '200'},
    {...node('inverter', 'inverter', 'transformer'), acRatedCapacityKw: '100', maxDcCapacityKw: '150'},
    {...node('modules', 'module_group', 'inverter'), moduleRatedCapacityW: '400', quantity: 300}];
  const configured = await api('/api/equipment', 'PUT', {siteId, equipment, verified: true});
  assert.equal(configured.verified, true);
  assert.deepEqual(configured.idAdjustments, []);
  assert.deepEqual(configured.nodeIdAdjustments, []);
  const model = await api(equipmentPath);
  assert.deepEqual(model, {equipment: configured.equipment, verified: true});
  for (const asset of equipment) {
    const saved = model.equipment.find(item => item.id === asset.id);
    assert.ok(saved);
    for (const key of Object.keys(asset)) assert.deepEqual(saved[key], asset[key]);
  }
  const initialRows = ordered([
    ['2026-01-01T00:00:00.000Z', 12, 10],
    ['2026-01-01T01:00:00.000Z', 24, 20],
    ['2026-01-01T02:00:00.000Z', 0, 0],
  ].flatMap(([timestamp, meter, inverter]) => [['meter', meter], ['inverter', inverter]].map(([equipment, value]) => ({
    timestamp, channel: {id: JSON.stringify([id(equipment), 'Energy', null]), equipmentId: id(equipment), measurement: 'Energy', unit: 'kWh'}, value,
  }))));
  const seeded = await preview(api, siteId, incoming(initialRows), 'Synthetic persistence seed');
  assert.equal(seeded.baseRevision, 0);
  assert.deepEqual(seeded.counts, counts(6));
  assert.deepEqual(await api(datasetPath(siteId)), empty, 'Initial preview must not create canonical readings');
  const first = await commit(api, siteId, seeded, false, initialRows, 1);
  const audit = (revision, overlapApproved) => ({...revision.receipt.result, metadata: revision.receipt.metadata, actor, overlapApproved});
  let expected = {siteId, model, revisions: [first], imports: [audit(first, false)]};
  await assertHead(api, expected);

  const correctedRows = initialRows.map(row => row.timestamp === '2026-01-01T01:00:00.000Z' && row.channel.equipmentId === id('inverter')
    ? {...row, value: 17} : row);
  const changedRow = correctedRows.find(row => row.value === 17);
  const correction = await preview(api, siteId, incoming([changedRow]), 'Synthetic single-reading correction');
  assert.equal(correction.baseRevision, 1);
  assert.equal(correction.readingCount, 1);
  assert.equal(correction.channelCount, 1);
  assert.deepEqual(correction.counts, counts(0, 1, 1));
  assert.deepEqual(correction.samples, [{timestamp: changedRow.timestamp, channel: changedRow.channel, previous: 20, incoming: 17}]);
  await verifyPerformancePersistence({api, expected});
  const denied = await request(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(commitBody(siteId, correction, false))});
  const denial = await denied.json();
  assert.equal(denied.status, 409, JSON.stringify(denial));
  assert.equal(denial.code, 'OVERLAP_APPROVAL_REQUIRED');
  await verifyPerformancePersistence({api, expected});
  assert.deepEqual((await api(stagePath(siteId, correction.stageId))).preview, correction);

  const second = await commit(api, siteId, correction, true, correctedRows, 2);
  assert.deepEqual(second.dataset, {...first.dataset, revision: 2,
    revisionId: second.receipt.result.revisionId, updatedAt: second.receipt.result.committedAt});
  expected = {siteId, model, revisions: [first, second], imports: [audit(second, true), audit(first, false)]};
  await verifyPerformancePersistence({api, expected});
  return {expected, verify: () => verifyPerformancePersistence({api, expected})};
}
