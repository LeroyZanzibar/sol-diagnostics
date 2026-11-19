import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createVcomClient, discoverVcom, planVcomImport, normalizeVcomWindow, validateVcomMappings } from '../selfhost/vcom-provider.mjs';

const H = 3_600_000, F = 300_000;
const NOW = Date.parse('2026-11-19T12:00:00Z');
const auth = { mode: 'basic', apiKey: 'synthetic-key-private', username: 'synthetic-user-private', password: 'synthetic-password-private' };
const iso = t => new Date(t).toISOString();
const clone = x => JSON.parse(JSON.stringify(x));
const canonical = x => JSON.stringify(sort(x));
function sort(x) { return Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sort(x[k])])) : x; }
const hash = x => createHash('sha256').update(canonical(x)).digest('hex');
const signed = x => ({ ...x, requestId: hash(x) });
const discoveryDescriptor = (path = '/systems/ABCDE') => signed({ path, query: {} });
const chunk = (descriptor, payload) => ({ version: 1, requestId: descriptor.requestId, descriptor: clone(descriptor), fetchedAt: iso(NOW), payloadSha256: hash(payload), payload, decodedBodyByteLength: Buffer.byteLength(JSON.stringify(payload)) });
function metadata(options = {}) {
  const p = '/systems/ABCDE';
  const map = {
    [p]: { data: { name: 'Ordinary Solar Farm', timezone: { name: options.timezone ?? 'America/New_York' } } },
    [`${p}/inverters`]: { data: [{ id: 'Inv001.1', name: 'Inverter 1' }, { id: 'Inv002.1', name: 'Inverter 2' }] },
    [`${p}/meters`]: { data: [{ id: 'Meter651.1', name: 'Revenue meter' }, { id: 'Meter002.1', name: 'Backup 651 meter' }] },
    [`${p}/sensors`]: { data: [{ id: 'Sensor001.1', name: 'POA South' }, { id: 'Sensor002.1', name: 'poa North' }, { id: 'Sensor003.1', name: 'BPOA rear' }, { id: 'Sensor004.1', name: 'Temperature' }] },
  };
  for (const [family, id, abbrs, unit, aggregation] of [
    ['inverters', 'Inv001.1', ['E_INT'], 'Wh', 'SUM'], ['inverters', 'Inv002.1', ['E_INT'], 'MWh', 'SUM'],
    ['meters', 'Meter651.1', ['M_E_INT_EXP', 'M_E_INT_IMP'], 'kWh', 'SUM'],
    ['sensors', 'Sensor001.1', ['SRAD'], 'W/m²', 'AVG'], ['sensors', 'Sensor002.1', ['SRAD'], 'kW/m²', 'AVG'],
  ]) {
    const base = `${p}/${family}/${id}/abbreviations`;
    map[base] = { data: abbrs };
    for (const abbr of abbrs) map[`${base}/${abbr}`] = { data: { unit, aggregation, precision: 3, description: 'Synthetic metadata' } };
  }
  return { ...map, ...options.overrides };
}
async function fixture(options = {}) {
  const calls = [];
  const map = metadata(options);
  const client = createVcomClient({ auth, minSpacingMs: 0, clock: () => NOW, fetchImpl: async (url, init) => {
    const u = new URL(url); calls.push({ path: u.pathname.slice(3), url: u.href, init });
    assert.ok(Object.hasOwn(map, u.pathname.slice(3)), `Unexpected discovery path ${u.pathname}`);
    const payload = map[u.pathname.slice(3)];
    return payload instanceof Response ? payload.clone() : new Response(JSON.stringify(payload));
  } });
  const discovery = await discoverVcom({ client, systemKey: 'ABCDE' });
  const equipment = [{ id: 'meter', type: 'revenue_meter' }, { id: 'inv-1', type: 'inverter' }, { id: 'inv-2', type: 'inverter' }, { id: 'weather', type: 'weather_sensor' }];
  const destinations = { 'simulation:expected': '@site', 'irradiance:combined': 'weather', 'inverter:Inv001.1:E_INT': 'inv-1', 'inverter:Inv002.1:E_INT': 'inv-2', 'meter:Meter651.1:M_E_INT_EXP': 'meter', 'meter:Meter651.1:M_E_INT_IMP': 'meter' };
  const mappings = discovery.sources.map(s => ({ sourceId: s.id, equipmentId: destinations[s.id], measurement: s.measurement }));
  return { discovery, mappings, equipment, selectedPoaSourceId: 'poa:Sensor001.1', calls };
}
async function makePlan(options = {}) {
  const f = await fixture(options);
  return planVcomImport({ siteId: 'test-site', ...f, fromDate: '2026-09-01', throughDate: '2026-09-01', modelRevision: 'model-1', datasetRevision: 0, now: NOW, ...options });
}
function payloadFor(d) {
  const a = Date.parse(d.ownedStartUtc), b = Date.parse(d.ownedEndUtcExclusive);
  if (d.kind === 'simulation') return { data: Array.from({ length: (b - a) / F }, (_, i) => ({ timestamp: iso(a + i * F), expected: 12 })) };
  if (d.kind === 'satellite') return { data: Array.from({ length: (b - a) / H + 1 }, (_, i) => ({ timestamp: iso(a + i * H), value: i === 0 ? 999 : 0 })) };
  if (d.kind === 'inverterBulk') return Object.fromEntries(Array.from({ length: (b - a) / H }, (_, i) => [iso(a + (i + 1) * H), { 'Inv001.1': { E_INT: 2000 }, 'Inv002.1': { E_INT: 0.003 } }]));
  return { data: { [d.deviceId]: { [d.abbreviation]: Array.from({ length: (b - a) / H }, (_, i) => ({ timestamp: iso(a + (i + 1) * H), value: d.kind === 'poa' ? 850 : d.abbreviation === 'M_E_INT_IMP' ? -1 : 5 })) } } };
}
const chunksFor = plan => plan.requests.map(d => chunk(d, payloadFor(d)));
const forWindow = (plan, w, rawChunks) => normalizeVcomWindow({ plan, windowStartUtc: w.startUtc, windowEndUtc: w.endUtc, rawChunks: rawChunks.filter(c => c.descriptor.ownedStartUtc < w.endUtc && c.descriptor.ownedEndUtcExclusive > w.startUtc) });
const readingsOf = (result, id, measurement) => result.readings.filter(r => r.equipmentId === id && (!measurement || r.measurement === measurement));
const qualityOf = (result, id) => result.quality.filter(q => q.sourceId === id);
function editChunk(chunks, kind, edit, abbreviation) {
  const target = chunks.find(c => c.descriptor.kind === kind && (!abbreviation || c.descriptor.abbreviation === abbreviation));
  edit(target.payload); target.payloadSha256 = hash(target.payload); target.decodedBodyByteLength = Buffer.byteLength(JSON.stringify(target.payload));
  return target;
}

const excludedMapping = mapping => ({ ...mapping, equipmentId: '', excluded: true });
const excludeSources = (mappings, ids) => mappings.map(m => ids.includes(m.sourceId) ? excludedMapping(m) : m);
const planningInput = f => ({ siteId: 'test-site', ...f, fromDate: '2026-09-01', throughDate: '2026-09-01', modelRevision: 'model-1', datasetRevision: 0, now: NOW });

test('exclusions distinguish valid saved decisions from import readiness, including legacy and explicit false', async () => {
  const f = await fixture();
  assert.deepEqual(validateVcomMappings(f), { valid: true, ready: true, issues: [] });
  const explicit = { ...f, mappings: f.mappings.map(m => ({ ...m, excluded: false })) };
  assert.deepEqual(validateVcomMappings(explicit), { valid: true, ready: true, issues: [] });
  const all = { ...f, selectedPoaSourceId: null, mappings: f.mappings.map(excludedMapping), equipment: [] };
  const decision = validateVcomMappings(all);
  assert.equal(decision.valid, true); assert.equal(decision.ready, false);
  assert.match(decision.issues.join(' '), /include at least one|at least one.*included/i);
  assert.throws(() => planVcomImport(planningInput(all)), /include at least one|at least one.*included/i);
});

for (const [label, edit] of [
  ...[undefined, null, 'true', 'false', 0, 1, {}, []].map(value => [`non-boolean ${String(value)}`, f => { f.mappings[0].excluded = value; }]),
  ['retained destination', f => { f.mappings[0].excluded = true; }],
  ['missing excluded destination', f => { f.mappings[0] = excludedMapping(f.mappings[0]); delete f.mappings[0].equipmentId; }],
  ['null excluded destination', f => { f.mappings[0] = { ...excludedMapping(f.mappings[0]), equipmentId: null }; }],
  ['wrong excluded measurement', f => { f.mappings[0] = { ...excludedMapping(f.mappings[0]), measurement: 'Energy' }; }],
  ['excluded import is not Energy', f => { const i = f.mappings.findIndex(m => m.sourceId.endsWith('IMP')); f.mappings[i] = { ...excludedMapping(f.mappings[i]), measurement: 'Energy' }; }],
  ['unknown excluded source', f => { f.mappings.push({ sourceId: 'inverter:Unknown:E_INT', measurement: 'Energy', equipmentId: '', excluded: true }); }],
  ['duplicate exclusion', f => { f.mappings.push(excludedMapping(f.mappings[0])); }],
  ['missing decision', f => { f.mappings.pop(); }],
]) test(`exclusions reject ${label}`, async () => {
  const f = await fixture(); edit(f);
  const result = validateVcomMappings(f);
  assert.equal(result.ready, false); assert.equal(result.valid, false); assert.ok(result.issues.length);
  assert.throws(() => planVcomImport(planningInput(f)));
});

test('exclusions allow unsupported sources without destinations but retain full discovery and included collisions', async () => {
  const f = await fixture({ overrides: { '/systems/ABCDE/inverters/Inv002.1/abbreviations': { data: [] } } });
  assert.equal(validateVcomMappings(f).ready, false);
  f.mappings = excludeSources(f.mappings, ['inverter:Inv002.1:E_INT']);
  f.equipment = f.equipment.filter(e => e.id !== 'inv-2');
  assert.deepEqual(validateVcomMappings(f), { valid: true, ready: true, issues: [] });
  const plan = planVcomImport(planningInput(f));
  assert.deepEqual(plan.discovery, f.discovery); assert.equal(plan.discovery.sources.length, 6);
  assert.equal(plan.readingCount, 120);
  const collision = await fixture(); collision.mappings.find(m => m.equipmentId === 'inv-2').equipmentId = 'inv-1';
  assert.match(validateVcomMappings(collision).issues.join(' '), /collide/i);
  collision.mappings = excludeSources(collision.mappings, ['inverter:Inv002.1:E_INT']);
  assert.equal(validateVcomMappings(collision).valid, true);
});

for (const selectedPoaSourceId of ['poa:Sensor001.1', 'poa:missing', '']) test(`exclusions reject POA selection ${JSON.stringify(selectedPoaSourceId)} when combined irradiance is excluded`, async () => {
  const f = await fixture(); f.mappings = excludeSources(f.mappings, ['irradiance:combined']); f.selectedPoaSourceId = selectedPoaSourceId;
  const result = validateVcomMappings(f); assert.equal(result.valid, false); assert.match(result.issues.join(' '), /POA.*excluded|excluded.*POA/i);
  assert.throws(() => planVcomImport(planningInput(f)), /POA.*excluded|excluded.*POA/i);
});

for (const [sourceId, expectedKinds, expectedValue] of [
  ['simulation:expected', ['simulation'], 12], ['irradiance:combined', ['satellite', 'poa'], 0],
  ['inverter:Inv001.1:E_INT', ['inverterBulk'], 2], ['inverter:Inv002.1:E_INT', ['inverterBulk'], 3],
  ['meter:Meter651.1:M_E_INT_EXP', ['meter'], 5], ['meter:Meter651.1:M_E_INT_IMP', ['meter'], -1],
]) test(`exclusions single included ${sourceId} fetches and normalizes only its analytical channel`, async () => {
  const f = await fixture();
  f.mappings = f.mappings.map(m => m.sourceId === sourceId ? m : excludedMapping(m));
  if (sourceId !== 'irradiance:combined') f.selectedPoaSourceId = null;
  const plan = planVcomImport(planningInput(f)), result = forWindow(plan, plan.windows[0], chunksFor(plan));
  assert.equal(plan.readingCount, 24); assert.deepEqual(plan.requests.map(d => d.kind), expectedKinds);
  assert.equal(result.readings.length, 24); assert.equal(result.quality.length, 24); assert.equal(result.summary.sources, 1);
  assert.ok(result.quality.every(q => q.sourceId === sourceId)); assert.ok(result.readings.every(r => r.value === expectedValue));
  assert.equal(result.summary.missingReadings, 0); assert.equal(result.summary.missingSimulationHours, 0);
  assert.equal(result.summary.satelliteGaps, 0); assert.equal(result.summary.remainingIrradianceGaps, 0);
  assert.doesNotMatch(result.summary.warnings.join(' '), /no positive|missing/i);
  if (sourceId.endsWith('IMP')) assert.ok(result.readings.every(r => r.measurement === 'Other'));
  const empty = plan.requests.map(d => chunk(d, ['simulation', 'satellite'].includes(d.kind) ? { data: [] } : d.kind === 'inverterBulk' ? {} : { data: {} }));
  const missing = forWindow(plan, plan.windows[0], empty);
  assert.equal(missing.readings.length, 24); assert.equal(missing.summary.missingReadings, 24);
  assert.ok(missing.quality.every(q => q.sourceId === sourceId));
  if (sourceId !== 'simulation:expected') { assert.equal(missing.summary.missingSimulationHours, 0); assert.doesNotMatch(missing.summary.warnings.join(' '), /no positive.*simulation|missing simulation/i); }
  if (sourceId !== 'irradiance:combined') assert.equal(missing.summary.remainingIrradianceGaps, 0);
});

test('exclusions mixed bundle ignores excluded bulk measurements and quality, without weakening payload identity', async () => {
  const f = await fixture(); f.selectedPoaSourceId = null;
  f.mappings = excludeSources(f.mappings, ['simulation:expected', 'irradiance:combined', 'inverter:Inv002.1:E_INT', 'meter:Meter651.1:M_E_INT_IMP']);
  const plan = planVcomImport(planningInput(f)), chunks = chunksFor(plan);
  assert.deepEqual(plan.requests.map(d => [d.kind, d.abbreviation]), [['inverterBulk', 'E_INT'], ['meter', 'M_E_INT_EXP']]);
  editChunk(chunks, 'inverterBulk', p => { for (const row of Object.values(p)) row['Inv002.1'] = { E_INT: 'not-a-number', ignored: { malformed: true } }; });
  const result = forWindow(plan, plan.windows[0], chunks);
  assert.equal(result.readings.length, 48); assert.equal(result.quality.length, 48); assert.equal(plan.readingCount, 48);
  assert.deepEqual([...new Set(result.readings.map(r => r.equipmentId))].sort(), ['inv-1', 'meter']);
  assert.equal(result.summary.missingReadings, 0); assert.equal(result.summary.sources, 2);
  assert.doesNotMatch(result.summary.warnings.join(' '), /missing|simulation/i);
  const tampered = clone(chunks); tampered[0].payload[Object.keys(tampered[0].payload)[0]]['Inv002.1'].E_INT = 123;
  assert.throws(() => forWindow(plan, plan.windows[0], tampered), /digest/i);
  editChunk(chunks, 'inverterBulk', p => { Object.values(p)[0].Foreign = { E_INT: 1 }; });
  assert.throws(() => forWindow(plan, plan.windows[0], chunks), /foreign/i);
});

test('exclusions size windows and reading admission by included sources, not full discovery', async () => {
  const f = await fixture();
  for (let i = 0; i < 600; i++) {
    const source = { ...f.discovery.sources.find(s => s.kind === 'inverter'), id: `inverter:Extra${i}:E_INT`, deviceId: `Extra${i}` };
    f.discovery.sources.push(source); f.mappings.push({ sourceId: source.id, equipmentId: '', measurement: source.measurement, excluded: true });
  }
  const plan = planVcomImport({ ...planningInput(f), fromDate: '2025-01-01', throughDate: '2025-12-31' });
  assert.equal(plan.discovery.sources.length, 606); assert.equal(plan.readingCount, 365 * 24 * 6);
  assert.equal(plan.windows.length, 365); assert.ok(plan.windows.every(w => Date.parse(w.endUtc) - Date.parse(w.startUtc) === 24 * H));
});

test('exclusions preserve legacy omitted-property plan hashes, descriptors and normalized replay byte-for-byte', async () => {
  // Captured before implementation from provider at 1750913e2299d2f10f0935601965b7a540b2d063.
  const plan = await makePlan();
  assert.equal(plan.planHash, '0bbcb9074afc2a93718046312f0b18063fa99a89d381ccbaf5a8e1e5075e5c39');
  assert.equal(hash(plan.requests), '3775b2e76b20868fa9ca873d8fd0643cb0148a156efde8f2509c80c7469381f6');
  assert.ok(plan.mappings.every(m => !Object.hasOwn(m, 'excluded')));
  const replay = clone(plan), result = forWindow(replay, replay.windows[0], clone(chunksFor(plan)));
  assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'), 'bce7b15314716d473506d3db83c01286732f3e3e32bd8cfc7d4112f59fd302b3');
});

// First gate: ordinary populated, complete exporter bundle, no server or credentials.
test('ordinary full bundle discovers, plans and normalizes every source with canonical identities', async () => {
  const f = await fixture();
  assert.equal(validateVcomMappings(f).ready, true);
  assert.deepEqual(f.discovery.sources.map(s => s.id).sort(), ['simulation:expected', 'irradiance:combined', 'inverter:Inv001.1:E_INT', 'inverter:Inv002.1:E_INT', 'meter:Meter651.1:M_E_INT_EXP', 'meter:Meter651.1:M_E_INT_IMP'].sort());
  assert.equal(f.discovery.poaSensors.length, 2);
  assert.equal(f.discovery.excludedMeters[0].id, 'Meter002.1');
  assert.ok(f.calls.every(c => c.path !== '/systems'));
  assert.equal(f.calls.filter(c => /abbreviations\/(E_INT|SRAD|M_E_INT_EXP|M_E_INT_IMP)$/.test(c.path)).length, 6);
  const plan = await makePlan();
  assert.equal(plan.readingCount, 144);
  assert.equal(plan.requests.length, 6);
  assert.equal(plan.startUtc, '2026-09-01T04:00:00.000Z');
  assert.equal(plan.endUtc, '2026-09-02T04:00:00.000Z');
  const rawChunks = chunksFor(plan), before = canonical(rawChunks);
  const result = forWindow(plan, plan.windows[0], rawChunks);
  assert.equal(canonical(rawChunks), before);
  assert.equal(result.readings.length, 144);
  for (const [id, measurement, expected] of [['@site', 'Expected Production', 12], ['weather', 'Irradiance', 0], ['inv-1', 'Energy', 2], ['inv-2', 'Energy', 3], ['meter', 'Energy', 5], ['meter', 'Other', -1]]) {
    const rows = readingsOf(result, id, measurement); assert.equal(rows.length, 24);
    assert.ok(rows.every(r => r.value === expected && !Object.hasOwn(r, 'channelId')));
    assert.equal(rows[0].timestamp, plan.startUtc); assert.equal(rows.at(-1).timestamp, iso(Date.parse(plan.endUtc) - H));
  }
  assert.equal(result.quality.length, 144);
  assert.equal(result.summary.hours, 24); assert.equal(result.summary.sources, 6);
  assert.equal(result.summary.missingReadings, 0); assert.equal(result.summary.poaFilled, 0);
  assert.match(qualityOf(result, 'simulation:expected')[0].unitBasis, /accepted-workflow-convention/);
  assert.equal(qualityOf(result, 'simulation:expected')[0].validSamples, 12);
});

test('planning is immutable, stable sorted-JSON hashed and does not mutate callers', async () => {
  const f = await fixture(), before = canonical(f.discovery);
  const input = { siteId: 'site', ...f, fromDate: '2026-09-01', throughDate: '2026-09-01', modelRevision: 'm', datasetRevision: 0, now: NOW };
  const plan = planVcomImport(input), { planHash, ...body } = plan;
  assert.equal(planHash, hash(body)); assert.deepEqual(plan, planVcomImport(input));
  for (const d of plan.requests) { const { requestId, ...body } = d; assert.equal(requestId, hash(body)); }
  assert.throws(() => { plan.requests[0].query.from = 'changed'; }, TypeError);
  f.discovery.sources[0].name = 'caller change'; assert.equal(canonical(plan.discovery), before);
  assert.notEqual(planVcomImport({ ...input, modelRevision: 'new' }).planHash, planHash);
});

for (const [day, hours] of [['2026-03-08', 23], ['2026-11-01', 25]]) test(`DST ${day} retains ${hours} real UTC hours without duplicate canonical cells`, async () => {
  const plan = await makePlan({ fromDate: day, throughDate: day });
  assert.equal(plan.readingCount, hours * 6);
  assert.ok(plan.windows.every(w => Date.parse(w.endUtc) - Date.parse(w.startUtc) <= 24 * H));
  const chunks = chunksFor(plan), results = plan.windows.map(w => forWindow(plan, w, chunks));
  const rows = results.flatMap(x => readingsOf(x, '@site'));
  assert.equal(rows.length, hours); assert.equal(new Set(rows.map(r => r.timestamp)).size, hours);
  assert.ok(rows.every((r, i) => Date.parse(r.timestamp) === Date.parse(plan.startUtc) + i * H));
  assert.equal(results.reduce((s, r) => s + r.summary.hours, 0), hours);
});

test('inclusive dates use leap-clamped exclusive anniversary and site-local today', async () => {
  const f = await fixture(); const input = { siteId: 's', ...f, modelRevision: 'm', datasetRevision: 0, now: NOW };
  assert.doesNotThrow(() => planVcomImport({ ...input, fromDate: '2024-01-01', throughDate: '2024-12-31' }));
  assert.doesNotThrow(() => planVcomImport({ ...input, fromDate: '2024-02-29', throughDate: '2025-02-27' }));
  for (const [fromDate, throughDate] of [['2024-02-29', '2025-02-28'], ['2023-01-01', '2024-01-01'], ['2026-02-30', '2026-03-01'], ['2026-09-02', '2026-09-01'], ['2026-11-20', '2026-11-20']]) assert.throws(() => planVcomImport({ ...input, fromDate, throughDate }));
  assert.throws(() => planVcomImport({ ...input, now: Date.parse('2026-11-19T01:00:00Z'), fromDate: '2026-11-19', throughDate: '2026-11-19' }));
});

test('ambiguous/skipped midnight and fractional DST grids fail closed', async () => {
  for (const opts of [{ timezone: 'Australia/Lord_Howe', fromDate: '2026-10-04', throughDate: '2026-10-04' }, { timezone: 'Pacific/Apia', fromDate: '2011-12-30', throughDate: '2011-12-30' }, { timezone: 'America/Havana', fromDate: '2026-11-01', throughDate: '2026-11-01' }]) await assert.rejects(makePlan(opts));
});

test('request bounds pin explicit queries, daily bulk, and satellite THROUGH final midnight', async () => {
  const plan = await makePlan({ fromDate: '2026-08-01', throughDate: '2026-09-02' });
  for (const d of plan.requests) {
    const a = Date.parse(d.ownedStartUtc), b = Date.parse(d.ownedEndUtcExclusive);
    assert.equal(d.query.from, d.ownedStartUtc);
    assert.equal(Date.parse(d.query.to), b - (d.kind === 'satellite' ? 0 : 1000));
    assert.ok(b - a <= (d.kind === 'simulation' ? 31 : d.kind === 'satellite' ? 30 : 1) * 24 * H);
    assert.equal(d.query.resolution, d.kind === 'simulation' ? 'interval' : 'hour');
    if (d.kind === 'simulation') assert.equal(d.query.considerPowerControl, 'true');
    if (d.kind === 'inverterBulk') { assert.equal(d.query.format, 'json'); assert.equal(d.query.abbreviations, 'E_INT'); }
  }
  const chunks = chunksFor(plan), last = plan.windows.at(-1), result = forWindow(plan, last, chunks);
  assert.equal(readingsOf(result, 'weather').at(-1).value, 0);
});

test('missing, partial, zero, negative and raw quality preserve exporter numeric behavior', async () => {
  const plan = await makePlan(), chunks = chunksFor(plan), a = Date.parse(plan.startUtc);
  editChunk(chunks, 'simulation', p => {
    p.data[0].expected = null; // 11 valid, partial sum /12 = 11
    for (let i = 12; i < 24; i++) p.data[i].expected = null;
    for (let i = 24; i < 36; i++) p.data[i].expected = 0;
    for (let i = 36; i < 48; i++) p.data[i].expected = -12;
    p.data.splice(48, 12); // absent entire hour
    delete p.data[48].expected; // present row, absent value
  });
  editChunk(chunks, 'satellite', p => { p.data[2].value = null; p.data[3].value = -5; p.data.splice(4, 1); });
  editChunk(chunks, 'poa', p => { p.data['Sensor001.1'].SRAD[3].value = null; });
  editChunk(chunks, 'inverterBulk', p => { for (const row of Object.values(p)) delete row['Inv002.1']; });
  const result = forWindow(plan, plan.windows[0], chunks), expected = readingsOf(result, '@site');
  assert.deepEqual(expected.slice(0, 6).map(r => r.value), [11, null, 0, -12, null, 11]);
  assert.deepEqual(readingsOf(result, 'weather').slice(0, 4).map(r => r.value), [0, 850, -5, null]);
  assert.ok(readingsOf(result, 'inv-2').every(r => r.value === null));
  const q = qualityOf(result, 'simulation:expected');
  assert.equal(q[0].presentSamples, 12); assert.equal(q[0].validSamples, 11); assert.equal(q[0].partialExpectedKwh, 11); assert.equal(q[0].state, 'partial');
  assert.equal(q[1].nullSamples, 12); assert.equal(q[4].absentSamples, 12); assert.equal(q[5].missingValueSamples, 1);
  assert.equal(q[3].negative, true); assert.equal(q[0].timestampStartUtc, iso(a));
  assert.equal(result.summary.partialSimulationHours, 2); assert.equal(result.summary.missingSimulationHours, 2);
  assert.equal(result.summary.satelliteGaps, 2); assert.equal(result.summary.poaFilled, 1); assert.equal(result.summary.remainingIrradianceGaps, 1);
  assert.match(result.summary.warnings.join(' '), /partial/i);
});

test('explicit no POA is accepted; selected supported kW/m² fallback converts but raw value is retained', async () => {
  const noPoa = await makePlan({ selectedPoaSourceId: null }); assert.ok(noPoa.requests.every(d => d.kind !== 'poa'));
  const empty = await makePlan({ selectedPoaSourceId: '' }); assert.equal(empty.selectedPoaSourceId, null);
  const plan = await makePlan({ selectedPoaSourceId: 'poa:Sensor002.1' }), chunks = chunksFor(plan);
  editChunk(chunks, 'satellite', p => { p.data = []; });
  editChunk(chunks, 'poa', p => { p.data['Sensor002.1'].SRAD[0].value = 0.7; });
  const result = forWindow(plan, plan.windows[0], chunks);
  assert.equal(readingsOf(result, 'weather')[0].value, 700);
  assert.equal(qualityOf(result, 'irradiance:combined')[0].originalPoa, 0.7);
});

for (const [label, edit] of [
  ['daily-only', p => { p.data = [p.data[0]]; }],
  ['hourly-only', p => { p.data = p.data.filter((_, i) => i % 12 === 0); }],
  ['off-five-minute-grid', p => { p.data[1].timestamp = iso(Date.parse(p.data[1].timestamp) + 1000); }],
  ['invalid calendar timestamp', p => { p.data[1].timestamp = '2026-02-30T04:05:00Z'; }],
  ['unaware timestamp', p => { p.data[1].timestamp = '2026-09-01T04:05:00'; }],
  ['unsupported precision', p => { p.data[1].timestamp = '2026-09-01T04:05:00.0001Z'; }],
]) test(`simulation rejects ${label} before division`, async () => {
  const plan = await makePlan(), chunks = chunksFor(plan); editChunk(chunks, 'simulation', edit);
  assert.throws(() => forWindow(plan, plan.windows[0], chunks));
});

test('empty valid envelopes produce the entire null grid without invented cadence or zeros', async () => {
  const plan = await makePlan();
  const chunks = plan.requests.map(d => chunk(d, d.kind === 'inverterBulk' ? {} : d.kind === 'simulation' || d.kind === 'satellite' ? { data: [] } : { data: {} }));
  const result = forWindow(plan, plan.windows[0], chunks);
  assert.equal(result.readings.length, 144); assert.ok(result.readings.every(r => r.value === null));
  assert.equal(result.summary.missingReadings, 144); assert.equal(result.summary.missingSimulationHours, 24);
});

for (const [label, kind, payload] of [
  ['null data', 'simulation', { data: null }], ['null measurement array', 'meter', { data: { 'Meter651.1': { M_E_INT_EXP: null } } }],
  ['foreign device', 'meter', { data: { Foreign: { M_E_INT_EXP: [] } } }],
  ['unexpected abbreviation', 'meter', { data: { 'Meter651.1': { P_AC: [] } } }],
  ['null bulk data', 'inverterBulk', { data: null }],
  ['foreign inverter', 'inverterBulk', { '2026-09-01T05:00:00Z': { Foreign: { E_INT: 2 } } }],
  ['foreign bulk abbreviation', 'inverterBulk', { '2026-09-01T05:00:00Z': { 'Inv001.1': { E_INT: 2, P_AC: 5 } } }],
  ['boolean value', 'satellite', { data: [{ timestamp: '2026-09-01T05:00:00Z', value: true }] }],
  ['invalid decimal', 'satellite', { data: [{ timestamp: '2026-09-01T05:00:00Z', value: '0x10' }] }],
]) test(`malformed envelope fails: ${label}`, async () => {
  const plan = await makePlan(), chunks = chunksFor(plan), d = chunks.find(c => c.descriptor.kind === kind).descriptor;
  chunks[chunks.findIndex(c => c.requestId === d.requestId)] = chunk(d, payload);
  assert.throws(() => forWindow(plan, plan.windows[0], chunks));
});

test('explicit historical bulk data wrapper and strict decimal strings are supported', async () => {
  const plan = await makePlan(), chunks = chunksFor(plan), i = chunks.findIndex(c => c.descriptor.kind === 'inverterBulk');
  chunks[i] = chunk(chunks[i].descriptor, { data: chunks[i].payload, metadata: { unrelated: 'retained' } });
  editChunk(chunks, 'simulation', p => { p.data[0].expected = '1.2e1'; });
  assert.equal(readingsOf(forWindow(plan, plan.windows[0], chunks), '@site')[0].value, 12);
});

test('equal duplicates coalesce, blanks fill, conflicting nonblank duplicates reject', async () => {
  const plan = await makePlan(), chunks = chunksFor(plan);
  editChunk(chunks, 'simulation', p => { p.data.push({ ...p.data[0] }, { ...p.data[0], expected: null }); });
  assert.equal(qualityOf(forWindow(plan, plan.windows[0], chunks), 'simulation:expected')[0].validSamples, 12);
  editChunk(chunks, 'simulation', p => { p.data.push({ ...p.data[0], expected: 999 }); });
  assert.throws(() => forWindow(plan, plan.windows[0], chunks), /conflict|duplicate/i);
});

test('normalization authenticates exact persisted plans, chunks, descriptors, and complete requested work', async () => {
  const plan = await makePlan(), chunks = chunksFor(plan);
  for (const mutate of [cs => { cs[0].payload.data[0].expected = 9; }, cs => { cs[0].descriptor.query.to = '2026-12-01T00:00:00.000Z'; }, cs => { cs[0].requestId = 'a'.repeat(64); }, cs => { cs.pop(); }, cs => { cs.push(cs[0]); }, cs => { cs[0].decodedBodyByteLength = 17 * 1024 * 1024; }]) {
    const cs = clone(chunks); mutate(cs); assert.throws(() => forWindow(plan, plan.windows[0], cs));
  }
  const badPlan = clone(plan); badPlan.mappings[0].equipmentId = 'foreign';
  assert.throws(() => forWindow(badPlan, badPlan.windows[0], chunks));
  assert.throws(() => normalizeVcomWindow({ plan, windowStartUtc: plan.startUtc, windowEndUtc: iso(Date.parse(plan.startUtc) + H / 2), rawChunks: chunks }));
});

test('metadata unsupported abbreviations remain visible and unit/aggregation block readiness', async () => {
  const f = await fixture({ overrides: {
    '/systems/ABCDE/inverters/Inv002.1/abbreviations': { data: [] },
    '/systems/ABCDE/meters/Meter651.1/abbreviations/M_E_INT_IMP': { data: { unit: 'kW', aggregation: 'AVG' } },
    '/systems/ABCDE/sensors/Sensor002.1/abbreviations/SRAD': { data: { unit: 'W/m²', aggregation: 'SUM' } },
  } });
  assert.equal(f.discovery.sources.length, 6); assert.equal(f.discovery.sources.find(s => s.id === 'inverter:Inv002.1:E_INT').eligible, false);
  assert.equal(f.discovery.sources.find(s => s.kind === 'meter-import').eligible, false);
  assert.equal(f.discovery.poaSensors.find(s => s.id === 'poa:Sensor002.1').eligible, false);
  assert.equal(validateVcomMappings(f).ready, false);
  assert.throws(() => planVcomImport({ ...f, siteId: 's', fromDate: '2026-09-01', throughDate: '2026-09-01', modelRevision: 'm', datasetRevision: 0, now: NOW }));
});

test('discovery fails on corrupt inventories, mismatched exact keys, or failed metadata calls', async () => {
  for (const overrides of [
    { '/systems/ABCDE': { data: { key: 'OTHER', name: 'wrong', timezone: { name: 'UTC' } } } },
    { '/systems/ABCDE/inverters': { data: [{ id: ' Inv001.1', name: 'invalid' }] } },
    { '/systems/ABCDE/inverters': { data: [{ id: 'x', name: 'one' }, { id: 'x', name: 'two' }] } },
    { '/systems/ABCDE/meters': { data: null } },
    { '/systems/ABCDE': { data: { name: 'wrong', timezone: { name: 'Invalid/Timezone' } } } },
  ]) await assert.rejects(fixture({ overrides }));
  let calls = 0;
  await assert.rejects(discoverVcom({ systemKey: ' ABCDE', client: { get: async () => { calls++; throw new Error('not reached'); } } }));
  assert.equal(calls, 0);
  await assert.rejects(discoverVcom({ systemKey: 'ABCDE', client: { get: async () => { throw Object.assign(new Error('failed'), { code: 'VCOM_NETWORK' }); } } }));
});

test('mapping checks every analytical source, fixed measurement, canonical collisions, equipment and optional dependency', async () => {
  const good = await fixture();
  for (const mutate of [
    f => f.mappings.pop(), f => f.mappings.push(f.mappings[0]),
    f => { f.mappings.find(m => m.sourceId.includes('IMP')).measurement = 'Energy'; },
    f => { f.mappings.find(m => m.sourceId === 'simulation:expected').equipmentId = 'meter'; },
    f => { f.mappings.find(m => m.sourceId === 'inverter:Inv002.1:E_INT').equipmentId = 'inv-1'; },
    f => { f.equipment.find(e => e.id === 'inv-1').type = 'weather_sensor'; },
    f => { f.selectedPoaSourceId = 'poa:stale'; },
    f => { f.discovery.poaSensors.find(s => s.id === f.selectedPoaSourceId).eligible = false; },
    f => { f.discovery.poaSensors.find(s => s.id === f.selectedPoaSourceId).name = 'BPOA rear'; },
    f => { f.discovery.poaSensors.find(s => s.id === f.selectedPoaSourceId).sourceUnit = 'kWh'; },
    f => { f.mappings.push({ sourceId: f.selectedPoaSourceId, equipmentId: 'weather', measurement: 'Irradiance' }); },
  ]) { const f = clone(good); mutate(f); const result = validateVcomMappings(f); assert.equal(result.ready, false); assert.ok(result.issues.length); }
  assert.equal(validateVcomMappings({ ...good, selectedPoaSourceId: null }).ready, true);
  assert.equal(validateVcomMappings({ ...good, selectedPoaSourceId: '' }).ready, true);
});

test('planner enforces separate request, serialized plan, and projected output bounds', async () => {
  const f = await fixture();
  const input = { ...f, siteId: 's', fromDate: '2025-01-01', throughDate: '2025-12-31', modelRevision: 'm', datasetRevision: 0, now: NOW };
  const crowded = clone(f.discovery), mappings = clone(f.mappings);
  for (let i = 0; i < 240; i++) { const source = { ...crowded.sources.find(s => s.kind === 'inverter'), id: `inverter:Extra${i}:E_INT`, deviceId: `Extra${i}` }; crowded.sources.push(source); mappings.push({ sourceId: source.id, equipmentId: `e-${i}`, measurement: 'Energy' }); }
  assert.throws(() => planVcomImport({ ...input, discovery: crowded, mappings }), /limit|bound|million|large|readings/i);
  const meters = clone(f.discovery), mm = clone(f.mappings);
  for (let i = 0; i < 14; i++) for (const kind of ['meter-export', 'meter-import']) {
    const abbr = kind === 'meter-export' ? 'M_E_INT_EXP' : 'M_E_INT_IMP', source = { ...meters.sources.find(s => s.kind === kind), deviceId: `Extra${i}`, id: `meter:Extra${i}:${abbr}` };
    meters.sources.push(source); mm.push({ sourceId: source.id, equipmentId: `m-${i}`, measurement: source.measurement });
  }
  assert.throws(() => planVcomImport({ ...input, discovery: meters, mappings: mm }), /limit|bound|requests|large/i);
  assert.throws(() => planVcomImport({ ...input, modelRevision: 'x'.repeat(9 * 1024 * 1024) }));
});

test('client uses fixed official origin, supplied credentials and raw hashes without persisted secrets', async () => {
  for (const credentials of [auth, { mode: 'bearer', apiKey: 'synthetic-key-private', accessToken: 'synthetic-token-private' }]) {
    let seen;
    const client = createVcomClient({ auth: credentials, clock: () => NOW, minSpacingMs: 0, fetchImpl: async (url, init) => { seen = { url, init }; return new Response('{"data":{"b":2,"a":1}}'); } });
    const d = discoveryDescriptor(), raw = await client.get(d);
    assert.equal(String(seen.url), 'https://api.meteocontrol.de/v2/systems/ABCDE'); assert.equal(seen.init.redirect, 'error');
    assert.equal(new Headers(seen.init.headers).get('X-API-KEY'), credentials.apiKey);
    assert.equal(new Headers(seen.init.headers).get('Authorization'), credentials.mode === 'basic' ? `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}` : 'Bearer synthetic-token-private');
    assert.equal(raw.payloadSha256, hash(raw.payload)); assert.equal(raw.decodedBodyByteLength, Buffer.byteLength('{"data":{"b":2,"a":1}}'));
    assert.equal(raw.fetchedAt, iso(NOW)); assert.deepEqual(raw.descriptor, d);
    assert.doesNotMatch(JSON.stringify(raw), /synthetic-(?:key|password|token|user)-private|Authorization|X-API-KEY/);
  }
});

test('client refuses arbitrary paths, query injection, repaired identifiers, credentials and descriptor tampering before fetch', async () => {
  let calls = 0;
  const client = createVcomClient({ auth, minSpacingMs: 0, fetchImpl: async () => { calls++; return new Response('{}'); } });
  for (const path of ['https://evil.test/', '//evil.test/', '/systems/ABCDE/../OTHER', '/systems/%41BCDE', '/systems/ ABCDE', '/systems/ABCDE?accessToken=secret', '/login', '/systems/ABCDE/inverters/a%2fb/abbreviations']) await assert.rejects(client.get(discoveryDescriptor(path)));
  await assert.rejects(client.get(signed({ path: '/systems/ABCDE', query: { authorization: 'secret' } })));
  await assert.rejects(client.get({ ...discoveryDescriptor(), requestId: 'incorrect' })); assert.equal(calls, 0);
  for (const bad of [{ ...auth, apiKey: '' }, { ...auth, username: 'bad:name' }, { ...auth, password: 'bad\r\nvalue' }, { mode: 'bearer', apiKey: 'key', accessToken: '' }]) assert.throws(() => createVcomClient({ auth: bad }));
});

test('deadline covers a stalled streamed BODY, not just headers, and cancels the reader', async () => {
  let canceled = false, observedSignal;
  const client = createVcomClient({ auth, timeoutMs: 25, minSpacingMs: 0, fetchImpl: async (_, init) => {
    observedSignal = init.signal; return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"data":')); }, cancel() { canceled = true; } }));
  } });
  const start = Date.now(); await assert.rejects(client.get(discoveryDescriptor()), e => e.code === 'VCOM_TIMEOUT' && e.retryable === true);
  assert.ok(Date.now() - start < 1000); assert.equal(observedSignal.aborted, true); assert.equal(canceled, true);
});

test('client bounds actual bytes, uses fatal UTF-8 and rejects invalid JSON', async () => {
  for (const [payload, maxResponseBytes, code] of [[new TextEncoder().encode('{"data":"1234567890"}'), 10, 'VCOM_RESPONSE_TOO_LARGE'], [new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]), 100, 'VCOM_INVALID_RESPONSE'], [new TextEncoder().encode('{broken'), 100, 'VCOM_INVALID_RESPONSE']]) {
    const client = createVcomClient({ auth, maxResponseBytes, minSpacingMs: 0, fetchImpl: async () => new Response(payload, { headers: { 'Content-Length': '1' } }) });
    await assert.rejects(client.get(discoveryDescriptor()), e => e.code === code && !e.retryable);
  }
});

for (const [status, retryable, code] of [[401, false, 'VCOM_CREDENTIALS'], [403, false, 'VCOM_ACCESS_DENIED'], [404, false, 'VCOM_NOT_FOUND'], [400, false, 'VCOM_REQUEST_REJECTED'], [429, true, 'VCOM_RATE_LIMITED'], [503, true, 'VCOM_UNAVAILABLE'], [302, false, 'VCOM_REDIRECT_BLOCKED']]) test(`HTTP ${status} errors are safe and have explicit retry policy`, async () => {
  const client = createVcomClient({ auth, minSpacingMs: 0, clock: () => NOW, fetchImpl: async () => new Response('synthetic-password-private Authorization upstream body', { status, headers: { 'Retry-After': '60', Location: 'https://evil.test/' } }) });
  await assert.rejects(client.get(discoveryDescriptor()), e => {
    assert.equal(e.code, code); assert.equal(e.status, status); assert.equal(e.retryable, retryable);
    assert.doesNotMatch(`${e.message} ${e.stack} ${JSON.stringify(e)}`, /synthetic-password-private|Authorization|upstream body|evil/);
    if (retryable) assert.equal(e.retryAt, iso(NOW + 60_000)); return true;
  });
});

test('quota headers choose later exhausted reset, gate next calls, and recover after clock advances', async () => {
  let now = NOW, calls = 0;
  const client = createVcomClient({ auth, clock: () => now, minSpacingMs: 0, fetchImpl: async () => {
    calls++; return new Response('{}', { headers: calls === 1 ? { 'X-RateLimit-Remaining-Minute': '0', 'X-RateLimit-Reset-Minute': new Date(NOW + 60_000).toUTCString(), 'X-RateLimit-Remaining-Day': '0', 'X-RateLimit-Reset-Day': new Date(NOW + 3600_000).toUTCString() } : {} });
  } });
  await client.get(discoveryDescriptor());
  await assert.rejects(client.get(discoveryDescriptor()), e => e.retryAt === iso(NOW + H)); assert.equal(calls, 1);
  now += H; await client.get(discoveryDescriptor()); assert.equal(calls, 2);
});

test('client is single-flight with spacing, queue failures recover, cancellation and network messages are sanitized', async () => {
  let concurrent = 0, maximum = 0; const starts = [];
  const client = createVcomClient({ auth, minSpacingMs: 20, fetchImpl: async () => { starts.push(Date.now()); concurrent++; maximum = Math.max(maximum, concurrent); await new Promise(r => setTimeout(r, 5)); concurrent--; return new Response('{}'); } });
  await Promise.all([client.get(discoveryDescriptor()), client.get(discoveryDescriptor()), client.get(discoveryDescriptor())]);
  assert.equal(maximum, 1); assert.ok(starts[1] - starts[0] >= 18); assert.ok(starts[2] - starts[1] >= 18);
  const failed = createVcomClient({ auth, minSpacingMs: 0, fetchImpl: async () => { throw new Error('synthetic-password-private upstream'); } });
  await assert.rejects(failed.get(discoveryDescriptor()), e => e.code === 'VCOM_NETWORK' && !/private|upstream/.test(`${e.message} ${e.stack}`));
  const ac = new AbortController(); ac.abort('synthetic-password-private');
  await assert.rejects(client.get(discoveryDescriptor(), { signal: ac.signal }), e => e.code === 'VCOM_CANCELED' && !e.retryable);
});

test('unit metadata cannot inherit Object.prototype values as supported units', async () => {
  for (const unit of ['constructor', 'toString', '__proto__']) {
    const f = await fixture({ overrides: {
      '/systems/ABCDE/inverters/Inv002.1/abbreviations/E_INT': { data: { unit, aggregation: 'SUM' } },
      '/systems/ABCDE/sensors/Sensor002.1/abbreviations/SRAD': { data: { unit, aggregation: 'AVG' } },
    } });
    assert.equal(f.discovery.sources.find(s => s.deviceId === 'Inv002.1').eligible, false);
    assert.equal(f.discovery.poaSensors.find(s => s.deviceId === 'Sensor002.1').eligible, false);
    assert.equal(validateVcomMappings(f).ready, false);
  }
});

test('wide accepted population uses bounded normalization windows rather than a giant quality object', async () => {
  const f = await fixture(), discovery = clone(f.discovery), mappings = clone(f.mappings);
  for (let i = 0; i < 600; i++) {
    const source = { ...discovery.sources.find(s => s.kind === 'inverter'), id: `inverter:Extra${i}:E_INT`, deviceId: `Extra${i}` };
    discovery.sources.push(source); mappings.push({ sourceId: source.id, equipmentId: `extra-${i}`, measurement: 'Energy' });
  }
  const plan = await makePlan({ discovery, mappings }), chunks = chunksFor(plan);
  assert.equal(plan.readingCount, 24 * 606);
  assert.ok(plan.windows.every(w => (Date.parse(w.endUtc) - Date.parse(w.startUtc)) / H * discovery.sources.length <= 5000));
  const result = forWindow(plan, plan.windows[0], chunks);
  assert.ok(result.readings.length <= 5000);
});

test('persisted discovery rejects duplicate, malformed or excluded source metadata', async () => {
  const good = await fixture();
  for (const mutate of [
    f => { f.discovery.excludedMeters = [{ id: 'invalid id', name: 'Wrong', reason: 'excluded' }]; },
    f => { f.discovery.warnings = [123]; },
    f => { f.discovery.sources[0].secret = 'not allowed'; },
  ]) { const f = clone(good); mutate(f); assert.equal(validateVcomMappings(f).ready, false); }
});

test('default request-start spacing is at least two seconds without concurrent fetches', async () => {
  const starts = [];
  const client = createVcomClient({ auth, fetchImpl: async () => { starts.push(Date.now()); return new Response('{}'); } });
  await Promise.all([client.get(discoveryDescriptor()), client.get(discoveryDescriptor())]);
  assert.ok(starts[1] - starts[0] >= 1990);
});

test('active cancellation aborts body read without returning caller abort secrets', async () => {
  const ac = new AbortController(); let canceledBody = false, began;
  const started = new Promise(resolve => { began = resolve; });
  const client = createVcomClient({ auth, minSpacingMs: 0, fetchImpl: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); began(); }, cancel() { canceledBody = true; } })) });
  const pending = client.get(discoveryDescriptor(), { signal: ac.signal }); await started; ac.abort('synthetic-secret-abort');
  await assert.rejects(pending, e => e.code === 'VCOM_CANCELED' && !`${e.message} ${e.stack}`.includes('synthetic-secret-abort'));
  assert.equal(canceledBody, true);
});

test('Retry-After HTTP date, numeric quota reset, and earliest retry are respected', async () => {
  const client = createVcomClient({ auth, minSpacingMs: 0, clock: () => NOW, fetchImpl: async () => new Response('', { status: 429, headers: {
    'Retry-After': new Date(NOW + 30_000).toUTCString(), 'X-RateLimit-Remaining-Minute': '0', 'X-RateLimit-Reset-Minute': String((NOW + 90_000) / 1000),
  } }) });
  await assert.rejects(client.get(discoveryDescriptor()), e => e.retryAt === iso(NOW + 90_000));
});

test('partial all-zero simulation is numeric zero, while an absent requested series stays null', async () => {
  const plan = await makePlan(), chunks = chunksFor(plan);
  editChunk(chunks, 'simulation', p => { for (let i = 0; i < 12; i++) p.data[i].expected = i === 0 ? null : 0; });
  editChunk(chunks, 'meter', p => { p.data['Meter651.1'] = {}; }, 'M_E_INT_IMP');
  const result = forWindow(plan, plan.windows[0], chunks);
  assert.equal(readingsOf(result, '@site')[0].value, 0);
  assert.equal(qualityOf(result, 'simulation:expected')[0].state, 'partial');
  assert.ok(readingsOf(result, 'meter', 'Other').every(r => r.value === null));
});

test('an advertised but unavailable abbreviation detail remains visible as unsupported', async () => {
  const f = await fixture({ overrides: { '/systems/ABCDE/inverters/Inv002.1/abbreviations/E_INT': new Response('', { status: 404 }) } });
  assert.equal(f.discovery.sources.length, 6);
  assert.equal(f.discovery.sources.find(s => s.deviceId === 'Inv002.1').eligible, false);
  assert.equal(validateVcomMappings(f).ready, false);
});

test('display names are preserved exactly without applying identifier whitespace rules', async () => {
  const f = await fixture({ overrides: {
    '/systems/ABCDE': { data: { name: '  Ordinary Farm  ', timezone: { name: 'UTC' } } },
    '/systems/ABCDE/sensors': { data: [{ id: 'Sensor001.1', name: ' POA South ' }] },
  } });
  assert.equal(f.discovery.systemName, '  Ordinary Farm  ');
  assert.equal(f.discovery.poaSensors[0].name, ' POA South ');
  assert.equal(validateVcomMappings(f).ready, true);
});

test('streamed UTF-8 byte accounting works across split codepoints and at the exact cap', async () => {
  const bytes = new TextEncoder().encode('{"data":"☀"}');
  const client = createVcomClient({ auth, minSpacingMs: 0, maxResponseBytes: bytes.length, fetchImpl: async () => new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } })) });
  const raw = await client.get(discoveryDescriptor());
  assert.equal(raw.payload.data, '☀'); assert.equal(raw.decodedBodyByteLength, bytes.length);
});

test('actual serialized plan bytes have an independent eight-MiB admission limit', async () => {
  const f = await fixture(), discovery = clone(f.discovery), mappings = clone(f.mappings);
  for (let i = 0; i < 12; i++) for (const kind of ['meter-export', 'meter-import']) {
    const deviceId = `M${String(i).padStart(3, '0')}${'x'.repeat(124)}`, abbreviation = kind === 'meter-export' ? 'M_E_INT_EXP' : 'M_E_INT_IMP';
    const source = { ...discovery.sources.find(s => s.kind === kind), id: `meter:${deviceId}:${abbreviation}`, deviceId };
    discovery.sources.push(source); mappings.push({ sourceId: source.id, equipmentId: `extra-meter-${i}`, measurement: source.measurement });
  }
  discovery.warnings = Array.from({ length: 2000 }, (_, i) => `${i}: ${'w'.repeat(1000)}`);
  assert.throws(() => planVcomImport({ siteId: 'site', discovery, mappings, selectedPoaSourceId: null, fromDate: '2025-01-01', throughDate: '2025-12-31', modelRevision: 'model', datasetRevision: 0, now: NOW }), /plan byte limit/i);
});

test('declarations typecheck a consumer against the real shared public shapes', async () => {
  const { default: ts } = await import('typescript');
  const providerPath = new URL('../selfhost/vcom-provider.mjs', import.meta.url).pathname;
  const declarationPath = new URL('../selfhost/vcom-provider.d.mts', import.meta.url).pathname;
  const typesPath = new URL('../app/manual-vcom-types', import.meta.url).pathname;
  const filename = new URL('../.release-local/manual-vcom/provider-declaration-smoke.ts', import.meta.url).pathname;
  const source = `import {createVcomClient, discoverVcom, planVcomImport, normalizeVcomWindow, validateVcomMappings, VcomError, type VcomPlan, type HourQuality, type RawChunk} from ${JSON.stringify(providerPath)};
    import type {VcomCredentialsInput, VcomDiscovery, VcomMapping, VcomQualitySummary} from ${JSON.stringify(typesPath)};
    declare const auth: VcomCredentialsInput; declare const discovery: VcomDiscovery; declare const mappings: VcomMapping[]; declare const rawChunks: RawChunk[];
    const client = createVcomClient({auth, fetchImpl: fetch, timeoutMs:15000}); const found: Promise<VcomDiscovery> = discoverVcom({client,systemKey:'ABCDE'});
    const ready: boolean = validateVcomMappings({discovery,mappings,equipment:[],selectedPoaSourceId:null}).ready;
    const valid: boolean = validateVcomMappings({discovery,mappings,equipment:[],selectedPoaSourceId:null}).valid;
    const exclusion: VcomMapping = {sourceId:'simulation:expected',equipmentId:'',measurement:'Expected Production',excluded:true};
    const plan: VcomPlan = planVcomImport({siteId:'s',discovery,mappings,selectedPoaSourceId:null,fromDate:'2026-01-01',throughDate:'2026-01-01',modelRevision:'m',datasetRevision:0});
    const result = normalizeVcomWindow({plan,windowStartUtc:plan.startUtc,windowEndUtc:plan.endUtc,rawChunks});
    const quality: HourQuality[] = result.quality; const summary: VcomQualitySummary = result.summary; const code: string = new VcomError('VCOM_TEST','safe').code;
    const pending: Promise<RawChunk> = client.get(plan.requests[0]);
    const deadline: string | null | undefined = rawChunks[0].nextRequestAt;
    const optionalDeadline: RawChunk = {...rawChunks[0], nextRequestAt:null};`;
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true, skipLibCheck: false, esModuleInterop: true, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'] };
  const host = ts.createCompilerHost(options), originalRead = host.readFile, originalExists = host.fileExists;
  host.readFile = file => file === filename ? source : originalRead(file); host.fileExists = file => file === filename || originalExists(file);
  const program = ts.createProgram([filename], options, host);
  const targets = [program.getSourceFile(filename), program.getSourceFile(declarationPath)]; assert.ok(targets.every(Boolean));
  const diagnostics = targets.flatMap(file => [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)]);
  assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
});

for (const [label, headers, deadline] of [
  ['later exhausted quota reset', { 'Retry-After': '120', 'X-RateLimit-Remaining-Minute': '0', 'X-RateLimit-Reset-Minute': new Date(NOW + 60_000).toUTCString(), 'X-RateLimit-Remaining-Day': '0', 'X-RateLimit-Reset-Day': new Date(NOW + H).toUTCString() }, iso(NOW + H)],
  ['Retry-After seconds', { 'Retry-After': '90' }, iso(NOW + 90_000)],
  ['Retry-After HTTP date', { 'Retry-After': new Date(NOW + H).toUTCString() }, iso(NOW + H)],
  ['quota epoch seconds', { 'X-RateLimit-Remaining-Minute': '0', 'X-RateLimit-Reset-Minute': String((NOW + H) / 1000) }, iso(NOW + H)],
  ['quota epoch milliseconds', { 'X-RateLimit-Remaining-Minute': '0', 'X-RateLimit-Reset-Minute': String(NOW + H) }, iso(NOW + H)],
  ['non-exhausted quota', { 'X-RateLimit-Remaining-Minute': '1', 'X-RateLimit-Reset-Minute': String(NOW + H) }, null],
  ['past Retry-After', { 'Retry-After': new Date(NOW - H).toUTCString() }, null],
  ['invalid Retry-After', { 'Retry-After': 'synthetic-private-header-value' }, null],
  ['absent quota', {}, null],
]) test(`quota checkpoint exposes only a safe success deadline: ${label}`, async () => {
  const client = createVcomClient({ auth, clock: () => NOW, minSpacingMs: 0, fetchImpl: async () => new Response('{"data":[]}', { headers: { ...headers, 'X-Unrelated-Secret': 'synthetic-private-header-value' } }) });
  const raw = await client.get(discoveryDescriptor());
  assert.equal(raw.nextRequestAt, deadline);
  assert.deepEqual(raw.payload, { data: [] });
  assert.deepEqual(Object.keys(raw).sort(), ['version', 'requestId', 'descriptor', 'fetchedAt', 'payloadSha256', 'payload', 'decodedBodyByteLength', 'nextRequestAt'].sort());
  assert.doesNotMatch(JSON.stringify(raw), /synthetic-private-header-value|Retry-After|RateLimit|Unrelated-Secret/);
});

test('quota checkpoint optional metadata validates on replay without changing normalized numbers or quality', async () => {
  const plan = await makePlan(), chunks = chunksFor(plan), expected = forWindow(plan, plan.windows[0], chunks);
  for (const nextRequestAt of [null, iso(NOW - H), iso(NOW + H)]) {
    const annotated = chunks.map(raw => ({ ...raw, nextRequestAt }));
    assert.deepEqual(forWindow(plan, plan.windows[0], annotated), expected);
  }
  // Omission is valid; an explicitly present undefined is not persisted JSON.
  for (const nextRequestAt of [undefined, 123, false, '', 'synthetic-private-header-value', '2026-02-30T00:00:00.000Z', '2026-11-19T12:00:00Z', '2026-11-19T13:00:00.000+01:00', '+010000-01-01T00:00:00.000Z']) {
    const annotated = chunks.map(raw => ({ ...raw, nextRequestAt }));
    assert.throws(() => forWindow(plan, plan.windows[0], annotated));
  }
  const extra = chunks.map(raw => ({ ...raw, nextRequestAt: null, headers: { 'Retry-After': 'secret' } }));
  assert.throws(() => forWindow(plan, plan.windows[0], extra), /raw chunk/i);
});
