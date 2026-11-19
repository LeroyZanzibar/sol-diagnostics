/** Manual-only VCOM import primitives. No storage, scheduler, environment or token cache.
 * The accepted exporter conventions are versioned below; device units/aggregation
 * come from abbreviation metadata, not from the spelling of a measurement name.
 */
import { createHash } from 'node:crypto';

const ORIGIN = 'https://api.meteocontrol.de/v2';
const HOUR = 3_600_000, FIVE_MINUTES = 300_000, DAY = 24 * HOUR;
const LIMITS = Object.freeze({ responseBytes: 16 * 1024 * 1024, planBytes: 8 * 1024 * 1024, requests: 10_000, readings: 2_000_000, sources: 4096 });
const CONVENTIONS = Object.freeze({ simulation: 'vcom-simulation-five-minute-start-sum-div12-v1', satellite: 'vcom-satellite-hour-end-v1', inverterBulk: 'vcom-energy-hour-end-sum-v1', meter: 'vcom-energy-hour-end-sum-v1', poa: 'vcom-poa-hour-end-avg-v1' });
const KIND_ORDER = ['simulation', 'satellite', 'inverterBulk', 'meter', 'poa'];
const WARNING_CONVENTIONS = 'Simulation /12 and satellite hour-ending irradiance use accepted workflow conventions, not live unit verification.';
const WARNING_PARTIAL = 'Partial simulation hours retain the available five-minute sum /12; they are not complete hours and are never scaled up.';
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const own = (x, key) => Object.hasOwn(x, key);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const iso = time => new Date(time).toISOString();

export class VcomError extends Error {
  constructor(code, message, status = 400, retryable = false, retryAt = null) {
    super(message); this.name = 'VcomError'; this.code = code; this.status = status; this.retryable = retryable; this.retryAt = retryAt;
  }
}
function fail(message, code = 'VCOM_VALIDATION', status = 400) { throw new VcomError(code, message, status); }
function schema(condition, message = 'VCOM returned an unsupported or malformed response.') {
  if (!condition) fail(message, 'VCOM_INVALID_RESPONSE', 502);
}
function text(value, label, max = 256) {
  if (typeof value !== 'string' || !value || value.length > max || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail(`Invalid ${label}.`);
  return value;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) fail('Invalid exact VCOM identifier.');
  return value;
}
function displayName(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) fail(`Invalid ${label}.`);
  return value;
}
function exactKeys(value, keys) { return isObject(value) && Object.keys(value).length === keys.length && keys.every(k => own(value, k)); }
function sorted(value, depth = 0, seen = new Set()) {
  if (depth > 64) fail('JSON nesting limit exceeded.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if ((!Array.isArray(value) && !isObject(value)) || seen.has(value)) fail('Expected finite acyclic JSON.');
  seen.add(value);
  const out = Array.isArray(value) ? value.map(v => sorted(v, depth + 1, seen)) : Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k], depth + 1, seen)]));
  seen.delete(value); return out;
}
const canonical = value => JSON.stringify(sorted(value));
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
function freeze(value) { if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; }
const snapshot = value => JSON.parse(canonical(value));
const sign = descriptor => ({ ...descriptor, requestId: digest(descriptor) });
function boundedJson(value, bytes, label) {
  const result = canonical(value);
  if (Buffer.byteLength(result) > bytes) fail(`${label} byte limit exceeded.`);
  return result;
}

// Date.parse alone rolls impossible dates and silently truncates precision.
function dateParts(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('Use exact YYYY-MM-DD local dates.');
  const [year, month, day] = value.split('-').map(Number), t = new Date(0);
  t.setUTCFullYear(year, month - 1, day); t.setUTCHours(0, 0, 0, 0);
  if (year < 1000 || year > 9998 || t.getUTCFullYear() !== year || t.getUTCMonth() !== month - 1 || t.getUTCDate() !== day) fail('Invalid calendar date.');
  return { year, month, day, utc: t.getTime() };
}
function instant(value) {
  if (typeof value !== 'string' || value.length > 40) fail('Invalid source timestamp.');
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!m) fail('Require aware ISO timestamps with at most millisecond precision.');
  const date = dateParts(m[1]), h = Number(m[2]), min = Number(m[3]), sec = Number(m[4]);
  if (h > 23 || min > 59 || sec > 59) fail('Invalid source timestamp clock.');
  let offset = 0;
  if (m[6] !== 'Z') {
    const o = m[6].replace(':', ''), oh = Number(o.slice(1, 3)), om = Number(o.slice(3, 5));
    if (oh > 14 || om > 59 || (oh === 14 && om !== 0) || o === '-0000') fail('Invalid source timestamp offset.');
    offset = (o[0] === '-' ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  return date.utc + h * HOUR + min * 60_000 + sec * 1000 + Number((m[5] || '').padEnd(3, '0')) - offset;
}
function canonicalInstant(value) { const time = instant(value); if (iso(time) !== value) fail('Expected canonical UTC milliseconds.'); return time; }
function formatter(timezone) {
  text(timezone, 'IANA timezone', 128);
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { fail('Invalid IANA timezone.'); }
}
function localParts(fmt, time) { return Object.fromEntries(fmt.formatToParts(time).filter(p => p.type !== 'literal').map(p => [p.type, p.value])); }
function localDay(fmt, time) { const p = localParts(fmt, time); return `${p.year}-${p.month}-${p.day}`; }
function localMidnight(date, fmt) {
  const { utc } = dateParts(date), offsets = new Set(), candidates = new Set();
  for (let t = utc - 2 * DAY; t <= utc + 2 * DAY; t += 6 * HOUR) {
    const p = localParts(fmt, t), nominal = dateParts(`${p.year}-${p.month}-${p.day}`).utc + Number(p.hour) * HOUR + Number(p.minute) * 60_000 + Number(p.second) * 1000;
    offsets.add(nominal - t);
  }
  for (const offset of offsets) { const t = utc - offset, p = localParts(fmt, t); if (localDay(fmt, t) === date && p.hour === '00' && p.minute === '00' && p.second === '00') candidates.add(t); }
  if (candidates.size !== 1) fail('Selected local midnight is skipped or ambiguous in the site timezone.');
  return [...candidates][0];
}
function dateRange(fromDate, throughDate, timezone, now) {
  const from = dateParts(fromDate), through = dateParts(throughDate), fmt = formatter(timezone);
  if (!Number.isFinite(now)) fail('Invalid current time.');
  if (fromDate > throughDate || throughDate > localDay(fmt, now)) fail('Dates must be ordered and no later than site-local today.');
  const exclusive = iso(through.utc + DAY).slice(0, 10), anniversaryYear = from.year + 1;
  const daysInMonth = new Date(Date.UTC(anniversaryYear, from.month, 0)).getUTCDate();
  const anniversary = `${anniversaryYear}-${String(from.month).padStart(2, '0')}-${String(Math.min(from.day, daysInMonth)).padStart(2, '0')}`;
  if (exclusive > anniversary) fail('The inclusive range exceeds one calendar year.');
  const a = localMidnight(fromDate, fmt), b = localMidnight(exclusive, fmt);
  if (b <= a || (b - a) % HOUR) fail('Unsupported non-hourly timezone transition.');
  for (let t = a; t <= b; t += HOUR) { const p = localParts(fmt, t); if (p.minute !== '00' || p.second !== '00') fail('Unsupported fractional-hour timezone grid.'); }
  return { a, b };
}

function measurementDescriptor({ kind, deviceId = null, abbreviation = null, systemKey, a, b }) {
  const base = `/systems/${identifier(systemKey)}`;
  const suffix = kind === 'simulation' ? '/calculations/simulation' : kind === 'satellite' ? '/satellite/irradiance' : kind === 'inverterBulk' ? '/inverters/bulk/measurements' : `/${kind === 'meter' ? 'meters' : 'sensors'}/${identifier(deviceId)}/abbreviations/${abbreviation}/measurements`;
  const query = { from: iso(a), to: iso(b - (kind === 'satellite' ? 0 : 1000)), resolution: kind === 'simulation' ? 'interval' : 'hour' };
  if (kind === 'simulation') query.considerPowerControl = 'true';
  if (kind === 'inverterBulk') { query.abbreviations = 'E_INT'; query.format = 'json'; }
  return sign({ kind, deviceId, abbreviation, path: base + suffix, query, ownedStartUtc: iso(a), ownedEndUtcExclusive: iso(b), sourceTimestampConvention: kind === 'simulation' ? 'start' : 'end', conventionId: CONVENTIONS[kind] });
}
function validateDescriptor(descriptor) {
  if (!isObject(descriptor) || !/^[a-f0-9]{64}$/.test(descriptor.requestId || '')) fail('Invalid request identity.');
  boundedJson(descriptor, 4096, 'Request descriptor');
  const { requestId, ...identity } = descriptor;
  if (digest(identity) !== requestId) fail('Request descriptor identity mismatch.');
  const path = descriptor.path;
  if (typeof path !== 'string' || !path.startsWith('/systems/') || /[%?#\\\s]/.test(path)) fail('Unsupported VCOM path.');
  const parts = path.split('/'); identifier(parts[2]);
  if (!own(descriptor, 'kind')) {
    if (!exactKeys(descriptor, ['requestId', 'path', 'query']) || !exactKeys(descriptor.query, [])) fail('Invalid discovery descriptor.');
    const family = parts[3];
    if (parts.length === 3) return descriptor;
    if (!['inverters', 'meters', 'sensors'].includes(family)) fail('Unsupported discovery path.');
    if (parts.length === 4) return descriptor;
    identifier(parts[4]);
    if (parts[5] !== 'abbreviations' || ![6, 7].includes(parts.length)) fail('Unsupported discovery path.');
    if (parts.length === 7 && !(family === 'inverters' ? ['E_INT'] : family === 'meters' ? ['M_E_INT_EXP', 'M_E_INT_IMP'] : ['SRAD']).includes(parts[6])) fail('Unsupported abbreviation.');
    return descriptor;
  }
  const { kind, deviceId, abbreviation } = descriptor;
  if (!KIND_ORDER.includes(kind)) fail('Unsupported measurement kind.');
  if (kind === 'meter' && !['M_E_INT_EXP', 'M_E_INT_IMP'].includes(abbreviation) || kind === 'poa' && abbreviation !== 'SRAD' || kind === 'inverterBulk' && (abbreviation !== 'E_INT' || deviceId !== null) || ['simulation', 'satellite'].includes(kind) && (abbreviation !== null || deviceId !== null)) fail('Invalid measurement binding.');
  const a = canonicalInstant(descriptor.ownedStartUtc), b = canonicalInstant(descriptor.ownedEndUtcExclusive);
  const max = (kind === 'simulation' ? 31 : kind === 'satellite' ? 30 : 1) * DAY;
  if (b <= a || b - a > max || (b - a) % HOUR) fail('Invalid request ownership bounds.');
  const expected = measurementDescriptor({ kind, deviceId, abbreviation, systemKey: parts[2], a, b });
  if (canonical(expected) !== canonical(descriptor)) fail('Measurement descriptor does not match the fixed endpoint contract.');
  return descriptor;
}

function credentials(auth) {
  if (!isObject(auth) || !['basic', 'bearer'].includes(auth.mode)) fail('Valid VCOM credentials are required.', 'VCOM_CREDENTIALS', 401);
  const secret = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/u.test(value);
  if (!secret(auth.apiKey) || auth.apiKey.trim() !== auth.apiKey || (auth.mode === 'basic' ? !secret(auth.username) || auth.username.includes(':') || !secret(auth.password) : !secret(auth.accessToken) || /\s/.test(auth.accessToken))) fail('Valid VCOM credentials are required.', 'VCOM_CREDENTIALS', 401);
  // Construct once, keep in the closure only. Never return headers or causes.
  return { Accept: 'application/json', 'X-API-KEY': auth.apiKey, Authorization: auth.mode === 'basic' ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}` : `Bearer ${auth.accessToken}` };
}
function retryDeadline(headers, now) {
  const deadlines = [], ra = headers.get('retry-after');
  if (ra) { const t = /^\d+(?:\.\d+)?$/.test(ra) ? now + Number(ra) * 1000 : Date.parse(ra); if (Number.isFinite(t) && t > now && t <= 8.64e15) deadlines.push(t); }
  for (const period of ['minute', 'day']) {
    const remaining = headers.get(`x-ratelimit-remaining-${period}`), reset = headers.get(`x-ratelimit-reset-${period}`);
    if (remaining !== null && /^\d+$/.test(remaining) && Number(remaining) === 0) {
      const t = reset && /^\d+$/.test(reset) ? Number(reset) * (Number(reset) < 1e12 ? 1000 : 1) : Date.parse(reset || '');
      deadlines.push(Number.isFinite(t) && t > now && t <= 8.64e15 ? t : now + (period === 'day' ? DAY : 60_000));
    }
  }
  return deadlines.length ? Math.max(...deadlines) : 0;
}
function canceled() { return new VcomError('VCOM_CANCELED', 'VCOM request canceled.', 400, false); }
function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(canceled());
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(canceled()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export function createVcomClient({ auth, fetchImpl = globalThis.fetch, clock = () => Date.now(), timeoutMs = 15_000, maxResponseBytes = LIMITS.responseBytes, minSpacingMs = 2000 } = {}) {
  const headers = credentials(auth);
  if (typeof fetchImpl !== 'function' || typeof clock !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > LIMITS.responseBytes || !Number.isSafeInteger(minSpacingMs) || minSpacingMs < 0) fail('Invalid VCOM transport limits.');
  let tail = Promise.resolve(), lastStart = -Infinity, blockedUntil = 0;
  async function execute(descriptor, signal) {
    if (signal?.aborted) throw canceled();
    const now = clock();
    if (!Number.isFinite(now)) fail('Invalid client clock.');
    if (blockedUntil > now) throw new VcomError('VCOM_RATE_LIMITED', 'VCOM quota reset is pending.', 429, true, iso(blockedUntil));
    await wait(Math.max(0, lastStart + minSpacingMs - now), signal);
    lastStart = clock();
    const controller = new AbortController();
    let timer, reader, stop;
    const stopped = new Promise((_, reject) => { stop = reject; });
    const abort = () => { controller.abort(); if (reader) void reader.cancel().catch(() => {}); stop(canceled()); };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      controller.abort(); if (reader) void reader.cancel().catch(() => {});
      stop(new VcomError('VCOM_TIMEOUT', 'VCOM response exceeded its deadline.', 503, true, iso(clock() + Math.max(minSpacingMs, 1000))));
    }, timeoutMs);
    try {
      const work = async () => {
        const url = new URL(ORIGIN + descriptor.path);
        for (const key of Object.keys(descriptor.query).sort()) url.searchParams.set(key, descriptor.query[key]);
        const response = await fetchImpl(url.href, { method: 'GET', headers: { ...headers }, redirect: 'error', signal: controller.signal });
        if (controller.signal.aborted) {
          if (response?.body) void response.body.cancel().catch(() => {});
          throw canceled();
        }
        if (!response || !Number.isInteger(response.status) || !response.headers?.get) schema(false);
        const next = retryDeadline(response.headers, clock()); blockedUntil = Math.max(blockedUntil, next);
        if (response.redirected || response.status >= 300 && response.status < 400) {
          if (response.body) void response.body.cancel().catch(() => {});
          throw new VcomError('VCOM_REDIRECT_BLOCKED', 'VCOM redirects are not permitted.', response.status, false);
        }
        if (response.status < 200 || response.status >= 300) {
          const status = response.status, retryable = status === 429 || status >= 500;
          const code = status === 401 ? 'VCOM_CREDENTIALS' : status === 403 ? 'VCOM_ACCESS_DENIED' : status === 404 ? 'VCOM_NOT_FOUND' : status === 429 ? 'VCOM_RATE_LIMITED' : status >= 500 ? 'VCOM_UNAVAILABLE' : 'VCOM_REQUEST_REJECTED';
          if (retryable && !next) blockedUntil = Math.max(blockedUntil, clock() + Math.max(2000, minSpacingMs));
          if (response.body) void response.body.cancel().catch(() => {});
          throw new VcomError(code, `VCOM request failed (HTTP ${status}).`, status, retryable, retryable ? iso(blockedUntil) : null);
        }
        schema(response.body && typeof response.body.getReader === 'function');
        reader = response.body.getReader(); let size = 0; const bytes = [];
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw canceled();
          if (done) break;
          schema(value instanceof Uint8Array); size += value.byteLength;
          if (size > maxResponseBytes) fail('VCOM response exceeds the byte limit.', 'VCOM_RESPONSE_TOO_LARGE', 502);
          bytes.push(value);
        }
        let payload;
        try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(bytes, size))); }
        catch { schema(false); }
        schema(isObject(payload));
        // A durable worker creates a fresh client for each request. Carry only
        // the parsed deadline, never response headers, alongside its success.
        return { version: 1, requestId: descriptor.requestId, descriptor: snapshot(descriptor), fetchedAt: iso(clock()), payloadSha256: digest(payload), payload, decodedBodyByteLength: size, nextRequestAt: next ? iso(next) : null };
      };
      return await Promise.race([work(), stopped]);
    } catch (error) {
      controller.abort(); if (reader) void reader.cancel().catch(() => {});
      if (error instanceof VcomError) throw error;
      throw new VcomError('VCOM_NETWORK', 'VCOM network request failed.', 503, true, iso(clock() + Math.max(minSpacingMs, 1000)));
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return Object.freeze({ get(descriptor, { signal } = {}) {
    // Snapshot before queuing, so a caller cannot mutate a validated path later.
    let pinned;
    try { validateDescriptor(descriptor); pinned = snapshot(descriptor); }
    catch (error) { return Promise.reject(error instanceof VcomError ? error : new VcomError('VCOM_VALIDATION', 'Invalid request descriptor.')); }
    const result = tail.then(() => execute(pinned, signal)); tail = result.catch(() => {}); return result;
  } });
}

const ENERGY_FACTORS = new Map([['Wh', 0.001], ['kWh', 1], ['MWh', 1000]]);
const IRRADIANCE_FACTORS = new Map([['W/m²', 1], ['W/m2', 1], ['W/m^2', 1], ['kW/m²', 1000], ['kW/m2', 1000], ['kW/m^2', 1000]]);
const energyFactor = unit => ENERGY_FACTORS.get(unit) ?? null;
const irradianceFactor = unit => IRRADIANCE_FACTORS.get(unit) ?? null;
const isPoaName = name => typeof name === 'string' && /POA/i.test(name) && !/BPOA/i.test(name);
function sourceInfo(kind) {
  if (kind === 'simulation') return { measurement: 'Expected Production', unit: 'kWh', id: 'simulation:expected' };
  if (kind === 'irradiance') return { measurement: 'Irradiance', unit: 'W/m²', id: 'irradiance:combined' };
  if (kind === 'inverter') return { measurement: 'Energy', unit: 'kWh', prefix: 'inverter', abbreviation: 'E_INT', equipmentType: 'inverter' };
  if (kind === 'meter-export') return { measurement: 'Energy', unit: 'kWh', prefix: 'meter', abbreviation: 'M_E_INT_EXP', equipmentType: 'revenue_meter' };
  if (kind === 'meter-import') return { measurement: 'Other', unit: 'kWh', prefix: 'meter', abbreviation: 'M_E_INT_IMP', equipmentType: 'revenue_meter' };
  if (kind === 'poa') return { measurement: 'Irradiance', unit: 'W/m²', prefix: 'poa', abbreviation: 'SRAD' };
  fail('Invalid source kind.');
}
function supported(source) {
  if (!source.eligible) return false;
  if (['simulation', 'irradiance'].includes(source.kind)) return true;
  return source.kind === 'poa' ? isPoaName(source.name) && source.aggregation === 'AVG' && irradianceFactor(source.sourceUnit) !== null : source.aggregation === 'SUM' && energyFactor(source.sourceUnit) !== null && (!source.kind.startsWith('meter-') || !source.name.includes('651'));
}
function verifySource(source, poa) {
  if (!exactKeys(source, ['id', 'name', 'kind', 'deviceId', 'measurement', 'unit', 'sourceUnit', 'aggregation', 'eligible', 'reason'])) fail('Invalid discovered source.');
  const info = sourceInfo(source.kind); displayName(source.name, 'source name');
  if (Boolean(poa) !== (source.kind === 'poa') || source.measurement !== info.measurement || source.unit !== info.unit || typeof source.sourceUnit !== 'string' || source.sourceUnit.length > 128 || typeof source.aggregation !== 'string' || source.aggregation.length > 128 || typeof source.eligible !== 'boolean' || !(source.reason === null || typeof source.reason === 'string' && source.reason.length <= 1024)) fail('Invalid discovered source metadata.');
  const expected = info.id || (source.kind === 'poa' ? `poa:${identifier(source.deviceId)}` : `${info.prefix}:${identifier(source.deviceId)}:${info.abbreviation}`);
  if (source.id !== expected || info.id && source.deviceId !== null) fail('Discovered source identity mismatch.');
}
function verifyDiscovery(discovery) {
  if (!exactKeys(discovery, ['systemKey', 'systemName', 'timezone', 'discoveredAt', 'sources', 'poaSensors', 'excludedMeters', 'warnings', 'metadataDigest'])) fail('Discovery is required.');
  identifier(discovery.systemKey); displayName(discovery.systemName, 'system name'); formatter(discovery.timezone); instant(discovery.discoveredAt);
  if (!Array.isArray(discovery.sources) || !Array.isArray(discovery.poaSensors) || discovery.sources.length + discovery.poaSensors.length > LIMITS.sources || !Array.isArray(discovery.excludedMeters) || discovery.excludedMeters.length > LIMITS.sources || !Array.isArray(discovery.warnings) || discovery.warnings.length > LIMITS.sources + 1 || !/^[a-f0-9]{64}$/.test(discovery.metadataDigest || '')) fail('Invalid discovery snapshot.');
  for (const warning of discovery.warnings) text(warning, 'discovery warning', 1024);
  const excluded = new Set();
  for (const meter of discovery.excludedMeters) {
    if (!exactKeys(meter, ['id', 'name', 'reason'])) fail('Invalid excluded-meter metadata.');
    identifier(meter.id); displayName(meter.name, 'meter name'); text(meter.reason, 'exclusion reason', 1024);
    if (!meter.name.includes('651') || excluded.has(meter.id)) fail('Invalid meter exclusion.');
    excluded.add(meter.id);
  }
  const ids = new Set();
  for (const [list, poa] of [[discovery.sources, false], [discovery.poaSensors, true]]) for (const source of list) { verifySource(source, poa); if (ids.has(source.id)) fail('Duplicate discovered source.'); ids.add(source.id); }
  if (!ids.has('simulation:expected') || !ids.has('irradiance:combined')) fail('The complete simulation and combined irradiance bundle is required.');
  for (const source of discovery.sources.filter(s => s.kind.startsWith('meter-'))) { const other = source.kind === 'meter-export' ? 'M_E_INT_IMP' : 'M_E_INT_EXP'; if (!ids.has(`meter:${source.deviceId}:${other}`) || excluded.has(source.deviceId)) fail('Each eligible meter requires separate export and import sources.'); }
}
export async function discoverVcom({ client, systemKey, signal }) {
  identifier(systemKey);
  if (!client || typeof client.get !== 'function') fail('A VCOM client is required.');
  const base = `/systems/${systemKey}`; let discoveredAt;
  async function get(path, array) {
    const descriptor = sign({ path, query: {} }), raw = await client.get(descriptor, { signal });
    validateRaw(raw, descriptor); discoveredAt = raw.fetchedAt;
    schema(array ? Array.isArray(raw.payload.data) : isObject(raw.payload.data)); return raw.payload.data;
  }
  const detail = await get(base, false);
  if (own(detail, 'key') && detail.key !== systemKey) fail('VCOM returned a different system identity.');
  const systemName = displayName(detail.name, 'system name'), timezone = detail.timezone?.name; formatter(timezone);
  async function inventory(family) {
    const list = await get(`${base}/${family}`, true); schema(list.length <= LIMITS.sources);
    const ids = new Set();
    for (const row of list) { schema(isObject(row)); identifier(row.id); displayName(row.name, 'device name'); schema(!ids.has(row.id), 'Duplicate VCOM inventory device.'); ids.add(row.id); }
    return [...list].sort((a, b) => cmp(a.id, b.id));
  }
  const inverters = await inventory('inverters'), meters = await inventory('meters'), sensors = await inventory('sensors');
  const sources = [
    { id: 'simulation:expected', name: 'Simulation expected', kind: 'simulation', deviceId: null, measurement: 'Expected Production', unit: 'kWh', sourceUnit: 'accepted-workflow-convention', aggregation: 'five-minute-sum/12', eligible: true, reason: null },
    { id: 'irradiance:combined', name: 'Satellite-first combined irradiance', kind: 'irradiance', deviceId: null, measurement: 'Irradiance', unit: 'W/m²', sourceUnit: 'accepted-workflow-convention', aggregation: 'satellite-first', eligible: true, reason: null },
  ];
  const poaSensors = [], excludedMeters = [], warnings = [WARNING_CONVENTIONS];
  async function deviceSources(family, device, kinds, target) {
    const path = `${base}/${family}/${device.id}/abbreviations`, advertised = await get(path, true);
    schema(advertised.every(a => typeof a === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(a)) && new Set(advertised).size === advertised.length);
    for (const kind of kinds) {
      const info = sourceInfo(kind), listed = advertised.includes(info.abbreviation);
      let metadata = null;
      if (listed) {
        try { metadata = await get(`${path}/${info.abbreviation}`, false); }
        catch (error) {
          // A specific missing advertised detail is unsupported, not a smaller
          // inventory. Authentication, transport and corrupt envelopes still
          // abort the entire discovery rather than publish a partial snapshot.
          if (error?.code !== 'VCOM_NOT_FOUND' || error.status !== 404) throw error;
        }
      }
      if (metadata) schema(typeof metadata.unit === 'string' && metadata.unit.length <= 128 && typeof metadata.aggregation === 'string' && metadata.aggregation.length <= 128);
      const source = { id: kind === 'poa' ? `poa:${device.id}` : `${info.prefix}:${device.id}:${info.abbreviation}`, name: device.name, kind, deviceId: device.id, measurement: info.measurement, unit: info.unit, sourceUnit: metadata?.unit ?? '', aggregation: metadata?.aggregation ?? '', eligible: Boolean(metadata), reason: null };
      source.eligible = supported(source);
      if (!source.eligible) { source.reason = !listed ? 'Required abbreviation is not advertised.' : !metadata ? 'Required abbreviation metadata is unavailable.' : 'Unsupported abbreviation unit or aggregation.'; warnings.push(`${source.id}: ${source.reason}`); }
      target.push(source);
    }
  }
  for (const device of inverters) await deviceSources('inverters', device, ['inverter'], sources);
  for (const device of meters) {
    if (device.name.includes('651')) { excludedMeters.push({ id: device.id, name: device.name, reason: 'Meter name contains 651.' }); continue; }
    await deviceSources('meters', device, ['meter-export', 'meter-import'], sources);
  }
  for (const device of sensors.filter(s => isPoaName(s.name))) await deviceSources('sensors', device, ['poa'], poaSensors);
  const metadata = { systemKey, systemName, timezone, sources, poaSensors, excludedMeters, warnings };
  return { ...metadata, discoveredAt, metadataDigest: digest(metadata) };
}

export function validateVcomMappings({ discovery, mappings, selectedPoaSourceId = null, equipment } = {}) {
  const issues = [];
  try { verifyDiscovery(discovery); } catch { return { ready: false, issues: ['Refresh valid complete VCOM discovery before mapping.'] }; }
  if (!Array.isArray(mappings) || mappings.length > LIMITS.sources) return { ready: false, issues: ['Map every analytical source exactly once.'] };
  let assets;
  if (equipment !== undefined) {
    if (!Array.isArray(equipment) || equipment.some(e => !isObject(e) || typeof e.id !== 'string') || new Set(equipment.map(e => e.id)).size !== equipment.length) issues.push('Invalid equipment inventory.');
    else assets = new Map(equipment.map(e => [e.id, e]));
  }
  const sources = new Map(discovery.sources.map(s => [s.id, s])), seen = new Set(), channels = new Set();
  for (const source of discovery.sources) if (!supported(source)) issues.push(`Source ${source.id} is unsupported; refresh its unit and aggregation metadata.`);
  for (const mapping of mappings) {
    if (!isObject(mapping)) { issues.push('Invalid mapping.'); continue; }
    const source = sources.get(mapping.sourceId);
    if (!source) { issues.push('Mappings may contain only the discovered analytical sources.'); continue; }
    if (seen.has(source.id)) issues.push(`Map ${source.id} exactly once.`); seen.add(source.id);
    try { text(mapping.equipmentId, 'equipment ID'); } catch { issues.push('Mapping has an invalid exact equipment ID.'); continue; }
    if (mapping.measurement !== source.measurement) issues.push(`Keep the fixed measurement for ${source.id}.`);
    if (source.kind === 'simulation') { if (mapping.equipmentId !== '@site') issues.push('Simulation must map to @site Expected Production.'); }
    else {
      if (mapping.equipmentId === '@site') issues.push('Device and irradiance sources require equipment destinations.');
      if (assets) { const expectedType = source.kind === 'irradiance' ? 'weather_sensor' : sourceInfo(source.kind).equipmentType; if (assets.get(mapping.equipmentId)?.type !== expectedType) issues.push(`Choose compatible ${expectedType} equipment for ${source.id}.`); }
    }
    const channel = JSON.stringify([mapping.equipmentId, mapping.measurement, null]);
    if (channels.has(channel)) issues.push('Two VCOM sources collide on the same canonical equipment/measurement channel.'); channels.add(channel);
  }
  for (const source of discovery.sources) if (!seen.has(source.id)) issues.push(`Missing mapping for ${source.id}.`);
  if (selectedPoaSourceId !== null && selectedPoaSourceId !== '' && selectedPoaSourceId !== undefined) {
    const selected = discovery.poaSensors.find(s => s.id === selectedPoaSourceId);
    if (!selected || !supported(selected)) issues.push('The explicitly selected POA fallback is missing or unsupported.');
  }
  return { ready: issues.length === 0, issues: [...new Set(issues)] };
}

export function planVcomImport({ siteId, discovery, mappings, selectedPoaSourceId = null, fromDate, throughDate, modelRevision, datasetRevision, now = Date.now() }) {
  text(siteId, 'site ID'); text(modelRevision, 'model revision', 1024);
  if (!Number.isSafeInteger(datasetRevision) || datasetRevision < 0) fail('Invalid dataset revision.');
  const ready = validateVcomMappings({ discovery, mappings, selectedPoaSourceId });
  if (!ready.ready) fail(ready.issues.join(' '), 'VCOM_MAPPINGS');
  selectedPoaSourceId = selectedPoaSourceId || null;
  const { a, b } = dateRange(fromDate, throughDate, discovery.timezone, now), readingCount = (b - a) / HOUR * discovery.sources.length;
  if (readingCount > LIMITS.readings) fail('Projected readings exceed the two-million-reading limit.');
  const windows = [], requests = [];
  // Bound the per-step readings/quality artifact as well as total job size.
  const windowSize = Math.min(24, Math.max(1, Math.floor(5000 / discovery.sources.length))) * HOUR;
  for (let t = a; t < b; t += windowSize) windows.push({ startUtc: iso(t), endUtc: iso(Math.min(t + windowSize, b)) });
  const add = (kind, size, deviceId = null, abbreviation = null) => {
    for (let t = a; t < b; t += size) {
      if (requests.length >= LIMITS.requests) fail('VCOM request count limit exceeded.');
      requests.push(measurementDescriptor({ kind, systemKey: discovery.systemKey, deviceId, abbreviation, a: t, b: Math.min(t + size, b) }));
    }
  };
  add('simulation', 31 * DAY); add('satellite', 30 * DAY);
  if (discovery.sources.some(s => s.kind === 'inverter')) add('inverterBulk', DAY, null, 'E_INT');
  for (const source of discovery.sources.filter(s => s.kind.startsWith('meter-'))) add('meter', DAY, source.deviceId, sourceInfo(source.kind).abbreviation);
  if (selectedPoaSourceId) add('poa', DAY, discovery.poaSensors.find(s => s.id === selectedPoaSourceId).deviceId, 'SRAD');
  requests.sort((x, y) => cmp(x.ownedStartUtc, y.ownedStartUtc) || KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || cmp(x.deviceId ?? '', y.deviceId ?? '') || cmp(x.abbreviation ?? '', y.abbreviation ?? ''));
  const value = { version: 1, siteId, systemKey: discovery.systemKey, timezone: discovery.timezone, fromDate, throughDate, startUtc: iso(a), endUtc: iso(b), modelRevision, datasetRevision, discovery: snapshot(discovery), mappings: snapshot(mappings).sort((x, y) => cmp(x.sourceId, y.sourceId)), selectedPoaSourceId, requests, windows, readingCount };
  const plan = { ...value, planHash: digest(value) };
  return freeze(JSON.parse(boundedJson(plan, LIMITS.planBytes, 'VCOM plan')));
}

function validateRaw(raw, descriptor) {
  const keys = ['version', 'requestId', 'descriptor', 'fetchedAt', 'payloadSha256', 'payload', 'decodedBodyByteLength'];
  if (isObject(raw) && own(raw, 'nextRequestAt')) keys.push('nextRequestAt');
  if (!exactKeys(raw, keys) || raw.version !== 1 || raw.requestId !== descriptor.requestId || canonical(raw.descriptor) !== canonical(descriptor) || !Number.isSafeInteger(raw.decodedBodyByteLength) || raw.decodedBodyByteLength <= 0 || raw.decodedBodyByteLength > LIMITS.responseBytes) fail('Invalid persisted VCOM raw chunk.', 'VCOM_INTEGRITY');
  canonicalInstant(raw.fetchedAt);
  if (own(raw, 'nextRequestAt') && raw.nextRequestAt !== null) canonicalInstant(raw.nextRequestAt);
  if (!isObject(raw.payload) || digest(raw.payload) !== raw.payloadSha256) fail('VCOM payload digest mismatch.', 'VCOM_INTEGRITY');
  // Canonical JSON cannot have more whitespace than the original; this is a
  // separate replay allocation cap, not a claim to reconstruct wire bytes.
  boundedJson(raw.payload, LIMITS.responseBytes, 'Persisted VCOM payload');
}
function numeric(record, field) {
  if (!own(record, field)) return { value: null, missingValue: true, explicitNull: false, empty: false };
  const value = record[field];
  if (value === null || value === '') return { value: null, missingValue: false, explicitNull: value === null, empty: value === '' };
  if (!(typeof value === 'number' || typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) || !Number.isFinite(Number(value))) schema(false, 'VCOM returned a non-finite or non-decimal measurement.');
  return { value: Number(value), missingValue: false, explicitNull: false, empty: false };
}
function parsePayload(payload, descriptor, inverterIds, consume) {
  schema(isObject(payload));
  if (descriptor.kind === 'inverterBulk') {
    const data = own(payload, 'data') ? payload.data : payload; schema(isObject(data));
    for (const [stamp, devices] of Object.entries(data)) {
      const time = instant(stamp); schema(isObject(devices));
      for (const [id, measurements] of Object.entries(devices)) {
        schema(inverterIds.has(id), 'VCOM returned a foreign inverter device.');
        schema(isObject(measurements) && Object.keys(measurements).every(k => k === 'E_INT'), 'VCOM returned an unexpected bulk abbreviation.');
        consume(`inverter:${id}:E_INT`, time, numeric(measurements, 'E_INT'));
      }
    }
    return;
  }
  schema(own(payload, 'data')); let data = payload.data;
  const device = descriptor.kind === 'meter' || descriptor.kind === 'poa';
  if (device) {
    schema(isObject(data) && Object.keys(data).every(id => id === descriptor.deviceId), 'VCOM returned a foreign measurement device.');
    if (!own(data, descriptor.deviceId)) data = [];
    else {
      const series = data[descriptor.deviceId]; schema(isObject(series) && Object.keys(series).every(k => k === descriptor.abbreviation), 'VCOM returned an unexpected measurement abbreviation.');
      data = own(series, descriptor.abbreviation) ? series[descriptor.abbreviation] : [];
    }
  }
  schema(Array.isArray(data), 'VCOM measurement data must be an array, not null.');
  const sourceId = descriptor.kind === 'simulation' ? 'simulation:expected' : descriptor.kind === 'satellite' ? 'satellite:irradiance' : descriptor.kind === 'poa' ? `poa:${descriptor.deviceId}` : `meter:${descriptor.deviceId}:${descriptor.abbreviation}`;
  for (const row of data) { schema(isObject(row)); consume(sourceId, instant(row.timestamp), numeric(row, descriptor.kind === 'simulation' ? 'expected' : 'value')); }
}
function validatePlan(plan) {
  boundedJson(plan, LIMITS.planBytes, 'VCOM plan');
  if (!isObject(plan) || plan.version !== 1 || !Array.isArray(plan.requests) || plan.requests.length > LIMITS.requests || !Array.isArray(plan.windows)) fail('Invalid immutable VCOM plan.', 'VCOM_INTEGRITY');
  const { planHash, ...body } = plan;
  if (digest(body) !== planHash) fail('VCOM plan hash mismatch.', 'VCOM_INTEGRITY');
  // Reproduce the structural plan independently of the wall clock on replay.
  // The original start gate checked today; a later restart cannot change it.
  const replay = planVcomImport({ ...plan, now: Date.parse(`${plan.throughDate}T12:00:00Z`) + 2 * DAY });
  if (replay.planHash !== planHash) fail('VCOM plan does not match its pinned inputs.', 'VCOM_INTEGRITY');
}
function mergeCell(index, sourceId, time, cell, requestId) {
  if (!index.has(sourceId)) index.set(sourceId, new Map());
  const series = index.get(sourceId), old = series.get(time);
  if (old && old.value !== null && cell.value !== null && old.value !== cell.value) fail('Conflicting nonblank VCOM duplicate measurements.', 'VCOM_DUPLICATE');
  if (!old) series.set(time, { ...cell, requestIds: new Set([requestId]) });
  else {
    old.requestIds.add(requestId);
    if (old.value === null && cell.value !== null) { old.value = cell.value; old.missingValue = cell.missingValue; old.explicitNull = cell.explicitNull; old.empty = cell.empty; }
  }
}
function statistics(cells, expectedSamples) {
  const present = cells.filter(Boolean), valid = present.filter(c => c.value !== null);
  return { expectedSamples, presentSamples: present.length, validSamples: valid.length, nullSamples: present.filter(c => c.value === null).length, absentSamples: expectedSamples - present.length, missingValueSamples: present.filter(c => c.missingValue).length, explicitNullSamples: present.filter(c => c.explicitNull).length, emptySamples: present.filter(c => c.empty).length, state: valid.length === expectedSamples ? 'complete' : valid.length ? 'partial' : 'missing' };
}
function scale(value, factor) { if (value === null) return null; const result = value * factor; schema(Number.isFinite(result), 'VCOM unit conversion overflowed.'); return result; }

export function normalizeVcomWindow({ plan, windowStartUtc, windowEndUtc, rawChunks }) {
  validatePlan(plan);
  const a = canonicalInstant(windowStartUtc), b = canonicalInstant(windowEndUtc), anchor = canonicalInstant(plan.startUtc);
  if (!plan.windows.some(w => w.startUtc === windowStartUtc && w.endUtc === windowEndUtc) || b <= a || b - a > DAY || (a - anchor) % HOUR || (b - a) % HOUR) fail('Normalize only an exact pinned VCOM window.');
  const descriptors = plan.requests.filter(d => d.ownedStartUtc < windowEndUtc && d.ownedEndUtcExclusive > windowStartUtc);
  if (!Array.isArray(rawChunks) || rawChunks.length !== descriptors.length) fail('Every relevant completed raw request is required exactly once.', 'VCOM_INTEGRITY');
  const expected = new Map(descriptors.map(d => [d.requestId, d])), seen = new Set(), index = new Map(), simulationTimes = new Set();
  const inverterIds = new Set(plan.discovery.sources.filter(s => s.kind === 'inverter').map(s => s.deviceId));
  let numericSimulation = false;
  for (const raw of rawChunks) {
    const descriptor = expected.get(raw?.requestId);
    if (!descriptor || seen.has(raw.requestId)) fail('Unexpected or repeated VCOM raw request.', 'VCOM_INTEGRITY');
    seen.add(raw.requestId); validateDescriptor(descriptor); validateRaw(raw, descriptor);
    const left = canonicalInstant(descriptor.ownedStartUtc), right = canonicalInstant(descriptor.ownedEndUtcExclusive);
    parsePayload(raw.payload, descriptor, inverterIds, (sourceId, time, cell) => {
      const simulation = descriptor.kind === 'simulation';
      if ((time - anchor) % (simulation ? FIVE_MINUTES : HOUR)) fail('VCOM timestamps are off the pinned source cadence grid.', 'VCOM_CADENCE');
      // Validate every row, including guard data; consume only this descriptor's
      // ownership. An hour-ending sample shifts exactly once, in UTC.
      if (simulation ? time < left || time >= right : time <= left || time > right) return;
      if (simulation) { simulationTimes.add(time); if (cell.value !== null) numericSimulation = true; }
      const start = simulation ? time : time - HOUR;
      // All simulation rows remain available for positive cadence evidence and
      // duplicate checks, even when normalizing only one of its daily windows.
      if (simulation || start >= a && start < b) mergeCell(index, sourceId, start, cell, descriptor.requestId);
    });
  }
  const ordered = [...simulationTimes].sort((x, y) => x - y), cadenceProved = ordered.some((t, i) => i > 0 && t - ordered[i - 1] === FIVE_MINUTES);
  if (numericSimulation && !cadenceProved) fail('Positive five-minute simulation cadence evidence is required before /12.', 'VCOM_CADENCE');
  const sources = plan.discovery.sources, mappings = new Map(plan.mappings.map(m => [m.sourceId, m]));
  const poa = plan.selectedPoaSourceId ? plan.discovery.poaSensors.find(s => s.id === plan.selectedPoaSourceId) : null;
  const summary = { hours: (b - a) / HOUR, sources: sources.length, missingReadings: 0, partialSimulationHours: 0, missingSimulationHours: 0, satelliteGaps: 0, poaFilled: 0, remainingIrradianceGaps: 0, warnings: [WARNING_CONVENTIONS] };
  if (!cadenceProved) summary.warnings.push('No positive five-minute simulation cadence evidence was available; all expected values are missing.');
  const readings = [], quality = [];
  const cellAt = (id, t) => index.get(id)?.get(t);
  for (let t = a; t < b; t += HOUR) for (const source of sources) {
    const mapping = mappings.get(source.id), timestamp = iso(t);
    let value, q;
    if (source.kind === 'simulation') {
      const cells = Array.from({ length: 12 }, (_, i) => cellAt(source.id, t + i * FIVE_MINUTES)), stats = statistics(cells, 12);
      value = stats.validSamples ? cells.reduce((sum, c) => sum + (c?.value ?? 0) / 12, 0) : null;
      schema(value === null || Number.isFinite(value), 'Simulation sum overflowed.');
      if (stats.state === 'partial') summary.partialSimulationHours++;
      if (stats.state === 'missing') summary.missingSimulationHours++;
      q = { ...stats, partialExpectedKwh: stats.state === 'partial' ? value : null, cadenceProved, unitBasis: 'accepted-workflow-convention', conventionId: CONVENTIONS.simulation, sourceTimestampConvention: 'start' };
    } else if (source.kind === 'irradiance') {
      const sat = cellAt('satellite:irradiance', t), sensor = poa ? cellAt(poa.id, t) : undefined;
      const originalSatellite = sat?.value ?? null, originalPoa = sensor?.value ?? null, selectedPoa = poa ? scale(originalPoa, irradianceFactor(poa.sourceUnit)) : null;
      const chosenIrradianceSource = originalSatellite !== null ? 'satellite' : selectedPoa !== null ? 'poa' : 'missing';
      value = originalSatellite ?? selectedPoa;
      if (originalSatellite === null) summary.satelliteGaps++;
      if (chosenIrradianceSource === 'poa') summary.poaFilled++;
      if (chosenIrradianceSource === 'missing') summary.remainingIrradianceGaps++;
      q = { ...statistics([chosenIrradianceSource === 'poa' ? sensor : sat], 1), originalSatellite, originalPoa, selectedPoa, selectedPoaSourceId: poa?.id ?? null, chosenIrradianceSource, satellitePresent: Boolean(sat), poaPresent: Boolean(sensor), unitBasis: 'accepted-workflow-convention', conventionId: CONVENTIONS.satellite, sourceTimestampConvention: 'end' };
    } else {
      const cell = cellAt(source.id, t); value = scale(cell?.value ?? null, energyFactor(source.sourceUnit));
      q = { ...statistics([cell], 1), originalValue: cell?.value ?? null, sourceUnit: source.sourceUnit, aggregation: source.aggregation, unitBasis: 'abbreviation-metadata', conventionId: CONVENTIONS.meter, sourceTimestampConvention: 'end' };
    }
    const requestIds = descriptors.filter(d => d.ownedStartUtc <= timestamp && d.ownedEndUtcExclusive > timestamp && (source.kind === 'simulation' ? d.kind === 'simulation' : source.kind === 'irradiance' ? ['satellite', 'poa'].includes(d.kind) : source.kind === 'inverter' ? d.kind === 'inverterBulk' : d.kind === 'meter' && d.deviceId === source.deviceId && d.abbreviation === sourceInfo(source.kind).abbreviation)).map(d => d.requestId).sort();
    if (value === null) summary.missingReadings++;
    readings.push({ timestamp, equipmentId: mapping.equipmentId, measurement: source.measurement, value, unit: source.unit });
    quality.push({ timestampStartUtc: timestamp, sourceId: source.id, requestIds, ...q, negative: value !== null && value < 0 });
  }
  if (summary.partialSimulationHours) summary.warnings.push(WARNING_PARTIAL);
  if (summary.missingSimulationHours) summary.warnings.push('Missing simulation hours remain null, not zero.');
  if (summary.missingReadings) summary.warnings.push('Missing source readings are retained on the expected hourly grid as nulls.');
  return { readings, quality, summary };
}
