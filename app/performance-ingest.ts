import { inspectTelemetryTimestamp, isValidTimezone, type TimestampConvention } from "./telemetry-time";
import { suggestedMeasurement } from "./telemetry-csv";
import type { PerformanceReading, PerformanceValue } from "../db/performance-store";

/** Hard ingestion bounds, independent of advisory browser validation.
 * CSV is decoded record-by-record twice from its retained source: first to
 * validate/infer cadence, then into SQLite's staged-reading transaction. No
 * complete CSV or reading array is retained in JS. Duplicate checking for CSV
 * is delegated to the staging store's unique timestamp/channel key.
 */
export const INGEST_LIMITS = Object.freeze({ csvBytes: 100 * 1024 * 1024, jsonBytes: 16 * 1024 * 1024,
  jsonReadings: 100_000, csvRows: 1_000_000, readings: 2_000_000, columns: 4096, cellChars: 65_536, rowChars: 1_048_576 });
export class PerformanceValidationError extends Error {
  readonly status = 400;
  readonly code = "validation";
}
const fail = (message: string): never => { throw new PerformanceValidationError(message); };
export type IngestEquipment = { id: string; type?: string; name?: string; externalId?: string; aliases?: string[] };
/** Match the analyzer's designated snow sensor and all its accepted code labels.
 * Build the identity set once per import, not once per streamed reading. */
export function observationTimePredicate(equipment: readonly IngestEquipment[]) {
  const snowIds = new Set(equipment.filter(asset => asset.type === "weather_sensor" && asset.name?.trim().toLowerCase() === "snow sensor").map(asset => asset.id));
  return (reading: PerformanceReading): boolean => reading.channel.measurement === "Snow code" ||
    snowIds.has(reading.channel.equipmentId) && (reading.channel.measurement === "Status" || reading.channel.measurement === "Other");
}
export type IngestOptions = {
  equipment: IngestEquipment[]; timezone: string; timestampConvention: TimestampConvention;
  intervalMinutes?: number; knownIntervalMinutes?: number; gridTimestamp?: string | null;
};
export type IncomingReading = { timestamp: string; equipmentId: string; measurement: string;
  value: PerformanceValue; unit?: string; channelId?: string };
export type CsvSignal = { column?: string; equipmentId?: string; measurement?: string; unit?: string; channelId?: string };
export type CsvIngestOptions = IngestOptions & { mapping: Record<string, string>; signals: CsvSignal[] };
const measures = new Set(["Energy", "Active power", "DC power", "Expected Production", "POA irradiance", "GHI irradiance", "Irradiance",
  "Module temperature", "Ambient temperature", "Wind speed", "Availability", "Snow code", "Status", "Other"]);
const blank = (value: unknown) => value === null || typeof value === "string" && !value.trim();
const boundedText = (value: unknown, label: string, max = 256): string => {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f]/.test(value)) return fail(`Invalid ${label}.`);
  return value;
};
function checkOptions(options: IngestOptions) {
  if (typeof options.timezone !== "string" || !isValidTimezone(options.timezone)) fail("Choose a valid IANA source timezone.");
  if (options.timestampConvention !== "start" && options.timestampConvention !== "end") fail("Select interval start or interval end timestamps.");
  for (const value of [options.intervalMinutes, options.knownIntervalMinutes]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 1440 || !Number.isSafeInteger(value * 60000))) fail("Interval cadence must be positive, at most 1440 minutes, and precise to a millisecond.");
  }
  if (options.intervalMinutes !== undefined && options.knownIntervalMinutes !== undefined && options.intervalMinutes !== options.knownIntervalMinutes) fail("The supplied interval cadence differs from the existing dataset.");
}
function numeric(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return fail("A nonblank numeric reading must contain a finite decimal number.");
  const text = String(value).trim();
  // Permit correctly grouped thousands, not hex, booleans, arbitrary text, or NaN.
  if (!/^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return fail(`Invalid numeric reading: ${text.slice(0, 80)}.`);
  const result = Number(text.replace(/,/g, ""));
  if (!Number.isFinite(result)) return fail("A numeric reading must be finite.");
  return result;
}
function unitHint(hint: string, measurement: string) {
  const value = hint.toLowerCase();
  const candidates = measurement.includes("temperature") ? /\b(?:deg[cf]|celsius|fahrenheit|kelvin)\b|°[cf]/g
    : measurement === "Wind speed" ? /\b(?:km\/h|m\/s|mph)\b/g
    : /\b(?:mwh|kwh|wh|mw(?:ac|dc)?|kw(?:ac|dc)?|w(?:ac|dc)?)(?:\s*\/\s*m[²2])?(?![a-z0-9])/g;
  return value.match(candidates)?.[0] || "";
}
function canonicalValue(measurement: string, value: unknown, explicitUnit?: string, hint = ""): { value: PerformanceValue; unit: string } {
  if (explicitUnit !== undefined && (typeof explicitUnit !== "string" || explicitUnit.length > 64)) fail("Invalid reading unit.");
  const categorical = measurement === "Status" || measurement === "Other";
  if (categorical) {
    if (!blank(value) && typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) fail("A categorical value must be text, a finite number, or null.");
    if (typeof value === "string" && value.length > INGEST_LIMITS.cellChars) fail("A categorical value is too long.");
    return { value: blank(value) ? null : value as PerformanceValue, unit: explicitUnit || "" };
  }
  const unit = (explicitUnit || unitHint(hint, measurement)).toLowerCase().replace(/\s|°|\^/g, "").replace(/²/g, "2");
  let canonical = "", factor = 1, offset = 0;
  if (measurement === "Energy" || measurement === "Expected Production") {
    canonical = "kWh";
    if (["", "kwh"].includes(unit)) factor = 1;
    else if (unit === "mwh") factor = 1000;
    else if (unit === "wh") factor = 0.001;
    else fail(`Unsupported energy unit: ${explicitUnit || unit}.`);
  } else if (["Active power", "DC power"].includes(measurement)) {
    canonical = "kW";
    const power = unit.replace(/(?:ac|dc)$/, "");
    if (["", "kw"].includes(power)) factor = 1;
    else if (power === "mw") factor = 1000;
    else if (power === "w") factor = 0.001;
    else fail(`Unsupported power unit: ${explicitUnit || unit}.`);
  } else if (/irradiance/i.test(measurement)) {
    canonical = "W/m²";
    if (["", "w/m2", "wm-2"].includes(unit)) factor = 1;
    else if (["kw/m2", "kwm-2"].includes(unit)) factor = 1000;
    else fail(`Unsupported irradiance unit: ${explicitUnit || unit}.`);
  } else if (measurement.includes("temperature")) {
    canonical = "°C";
    if (["", "c", "degc", "celsius"].includes(unit)) factor = 1;
    else if (["f", "degf", "fahrenheit"].includes(unit)) { factor = 5 / 9; offset = -32; }
    else if (["k", "kelvin"].includes(unit)) offset = -273.15;
    else fail(`Unsupported temperature unit: ${explicitUnit || unit}.`);
  } else if (measurement === "Wind speed") {
    canonical = "m/s";
    if (["", "m/s"].includes(unit)) factor = 1;
    else if (unit === "km/h") factor = 1 / 3.6;
    else if (unit === "mph") factor = 0.44704;
    else fail(`Unsupported wind-speed unit: ${explicitUnit || unit}.`);
  } else if (measurement === "Availability") {
    canonical = "%";
    if (["", "%", "percent"].includes(unit)) factor = 1;
    else if (["fraction", "ratio"].includes(unit)) factor = 100;
    else fail(`Unsupported availability unit: ${explicitUnit || unit}.`);
  } else if (measurement === "Snow code") {
    canonical = "code";
    if (!["", "code"].includes(unit)) fail("Snow observations require a code unit.");
  }
  if (blank(value)) return { value: null, unit: canonical };
  const converted = (numeric(value) + offset) * factor;
  if (!Number.isFinite(converted)) fail("Converted numeric reading is not finite.");
  return { value: Object.is(converted, -0) ? 0 : converted, unit: canonical };
}
export function performanceChannelId(equipmentId: string, measurement: string, explicitId?: string) {
  // Collision-safe exact identity, independent of labels, units, and CSV order.
  return JSON.stringify([equipmentId, measurement, explicitId ?? null]);
}
function performanceTimestamp(raw: unknown, timezone: string): string {
  const value = boundedText(raw, "timestamp", 100).trim();
  // Validate ORIGINAL components before any normalization or duplicate check.
  // Supported forms: year-first or month-first numeric dates with one consistent
  // separator (- / .), optional clock/AM-PM, and optional Z, UTC, GMT or ±HH[:]?MM.
  // Reject other Date.parse dialects and >3 fractional digits, even trailing zeros.
  const zone = value.match(/(Z|UTC|GMT|[+-]\d{2}:?\d{2})$/i)?.[0];
  const local = zone ? value.slice(0, -zone.length).trimEnd() : value;
  const yearFirst = local.match(/^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})/);
  const date = yearFirst || local.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})/);
  const clock = date && local.slice(date[0].length).match(/^(?:(?:T| +)(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)? *(AM|PM)?$/i);
  if (!date || !clock) return fail(`Invalid or unsupported timestamp: ${value}. Use a numeric date and at most millisecond precision.`);
  const year = Number(date[yearFirst ? 1 : 4]), month = Number(date[yearFirst ? 3 : 1]), day = Number(date[yearFirst ? 4 : 3]);
  let hour = Number(clock[1] || 0);
  const minute = Number(clock[2] || 0), second = Number(clock[3] || 0), millisecond = Number((clock[4] || "").padEnd(3, "0"));
  if (clock[5]) {
    if (!clock[1] || hour < 1 || hour > 12) return fail(`Invalid timestamp clock: ${value}.`);
    hour = hour % 12 + (clock[5].toUpperCase() === "PM" ? 12 : 0);
  }
  if (year < 100 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return fail(`Invalid timestamp calendar or clock: ${value}.`);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millisecond), calendar = new Date(wall);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) return fail(`Invalid timestamp calendar date: ${value}.`);
  if (zone) {
    const offset = /^[+-]/.test(zone) ? zone.replace(":", "") : "";
    const hours = Number(offset.slice(1, 3) || 0), minutes = Number(offset.slice(3) || 0);
    if (hours > 23 || minutes > 59) return fail(`Invalid timestamp offset: ${value}.`);
    const timestamp = new Date(wall - (offset.startsWith("-") ? -1 : 1) * (hours * 60 + minutes) * 60000).toISOString();
    if (timestamp.length !== 24) return fail("Timestamp is outside the supported four-digit-year range.");
    return timestamp;
  }
  // Reuse the established timezone/DST resolution only AFTER strict validation;
  // do not change the permissive legacy analyzer's timestamp calculations.
  const inspected = inspectTelemetryTimestamp(calendar.toISOString().slice(0, -1), timezone);
  if (!inspected.timestamp) return fail(`Invalid timestamp (${inspected.reason || "invalid"}): ${value}. Use an explicit offset for ambiguous local times.`);
  return inspected.timestamp;
}
function normalizeReading(raw: IncomingReading, options: IngestOptions, known: Set<string>, hint = ""): PerformanceReading {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("Each reading must be an object.");
  const equipmentId = boundedText(raw.equipmentId, "equipment ID");
  const measurement = boundedText(raw.measurement, "measurement");
  if (/cumulative/i.test(measurement)) fail("Cumulative energy must be converted to interval Energy before import.");
  if (!measures.has(measurement)) fail(`Unknown measurement: ${measurement}. Map it explicitly as Other if appropriate.`);
  if (equipmentId === "@site" ? measurement !== "Expected Production" : !known.has(equipmentId)) fail("Use an exact equipment ID in this site, or @site for Expected Production.");
  if (measurement === "Expected Production" && equipmentId !== "@site") fail("Expected Production must use the dedicated @site channel.");
  if (raw.channelId !== undefined) boundedText(raw.channelId, "explicit channel ID");
  const timestamp = performanceTimestamp(raw.timestamp, options.timezone);
  const normalized = canonicalValue(measurement, raw.value, raw.unit, hint);
  return { timestamp, channel: { id: performanceChannelId(equipmentId, measurement, raw.channelId), equipmentId, measurement, unit: normalized.unit }, value: normalized.value };
}
function inferCadence(times: Set<number>, options: IngestOptions): number {
  const sorted = [...times].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((value, index) => value - sorted[index]);
  const frequencies = new Map<number, number>();
  for (const gap of gaps) frequencies.set(gap, (frequencies.get(gap) || 0) + 1);
  const inferred = [...frequencies].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] || 0;
  const minutes = options.knownIntervalMinutes ?? options.intervalMinutes ?? inferred / 60000;
  if (!minutes) return fail("Cannot infer interval cadence from one timestamp. Supply intervalMinutes or use the existing dataset cadence.");
  if (minutes > 1440 || !Number.isSafeInteger(minutes * 60000)) fail("Unsupported interval cadence.");
  const ms = minutes * 60000;
  if (gaps.some(gap => gap % ms !== 0)) fail("Timestamp intervals are incompatible with the dataset cadence.");
  const start = options.gridTimestamp ? Date.parse(options.gridTimestamp) : sorted[0];
  const shift = options.timestampConvention === "end" ? ms : 0;
  if (options.gridTimestamp && sorted.some(time => (time - shift - start) % ms !== 0)) fail("Timestamp is off the existing interval grid.");
  return minutes;
}
function intervalStart(reading: PerformanceReading, minutes: number, convention: TimestampConvention, observation: boolean): PerformanceReading {
  if (convention === "start" || observation) return reading;
  return { ...reading, timestamp: new Date(Date.parse(reading.timestamp) - minutes * 60000).toISOString() };
}
export function prepareJsonImport(options: IngestOptions & { readings: IncomingReading[] }) {
  checkOptions(options);
  if (!Array.isArray(options.readings) || !options.readings.length || options.readings.length > INGEST_LIMITS.jsonReadings) fail(`Provide between 1 and ${INGEST_LIMITS.jsonReadings} readings.`);
  const known = new Set(options.equipment.map(item => item.id)), times = new Set<number>(), isObservation = observationTimePredicate(options.equipment);
  const readings: PerformanceReading[] = [], seen = new Map<string, PerformanceReading>();
  for (const raw of options.readings) {
    const reading = normalizeReading(raw, options, known);
    const key = JSON.stringify([reading.timestamp, reading.channel.id]), previous = seen.get(key);
    if (previous) {
      if (previous.value !== reading.value || previous.channel.unit !== reading.channel.unit) fail("Conflicting duplicate timestamp/channel readings in this input.");
      continue;
    }
    seen.set(key, reading); readings.push(reading);
    if (!isObservation(reading)) times.add(Date.parse(reading.timestamp));
  }
  const intervalMinutes = inferCadence(times, options);
  return { intervalMinutes, readings: readings.map(reading => intervalStart(reading, intervalMinutes, options.timestampConvention, isObservation(reading))) };
}

/** Strict RFC-style CSV records, with UTF-8 and framing errors rejected. */
export async function* performanceCsvRecords(stream: ReadableStream<Uint8Array>): AsyncGenerator<string[]> {
  const reader = stream.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let row: string[] = [], cell = "", quoted = false, afterQuote = false, skipLf = false, first = true;
  let bytes = 0, rows = 0, rowChars = 0;
  const finishCell = () => { row.push(cell); cell = ""; if (row.length > INGEST_LIMITS.columns) fail("CSV column limit exceeded."); };
  function* consume(text: string): Generator<string[]> {
    for (const character of text) {
      if (first) { first = false; if (character === "\uFEFF") continue; }
      if (skipLf) { skipLf = false; if (character === "\n") continue; }
      if (++rowChars > INGEST_LIMITS.rowChars) fail("CSV record is too long.");
      if (quoted) {
        if (character === '"') { quoted = false; afterQuote = true; }
        else cell += character;
      } else if (afterQuote && character === '"') { cell += '"'; quoted = true; afterQuote = false; }
      else if (character === ",") { finishCell(); afterQuote = false; }
      else if (character === "\n" || character === "\r") {
        finishCell(); if (row.length > 1 || afterQuote || row.some(value => value.length)) { if (++rows > INGEST_LIMITS.csvRows + 1) fail("CSV row limit exceeded."); yield row; }
        row = []; afterQuote = false; rowChars = 0; skipLf = character === "\r";
      } else if (afterQuote) fail("Unexpected character after a closing CSV quote.");
      else if (character === '"') { if (cell) fail("Unexpected quote inside an unquoted CSV field."); quoted = true; }
      else cell += character;
      if (cell.length > INGEST_LIMITS.cellChars) fail("CSV cell is too long.");
    }
  }
  let completed = false;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > INGEST_LIMITS.csvBytes) fail("CSV exceeds the 100 MB stream limit.");
      yield* consume(decoder.decode(next.value, { stream: true }));
    }
    yield* consume(decoder.decode());
    if (quoted) fail("Unterminated CSV quoted field.");
    if (cell || row.length || afterQuote) { finishCell(); if (++rows > INGEST_LIMITS.csvRows + 1) fail("CSV row limit exceeded."); yield row; }
    completed = true;
  } catch (error) {
    if (error instanceof TypeError || (error as { code?: string })?.code === "ERR_ENCODING_INVALID_ENCODED_DATA") fail("CSV must be valid UTF-8.");
    throw error;
  } finally { if (!completed) await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function csvResolver(equipment: IngestEquipment[]) {
  const exact = new Set(equipment.map(item => item.id)), aliases = new Map<string, Set<string>>();
  for (const item of equipment) for (const alias of [item.id, item.name, item.externalId, ...(item.aliases || [])]) {
    if (!alias) continue;
    const key = alias.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!key) continue;
    const ids = aliases.get(key) || new Set<string>(); ids.add(item.id); aliases.set(key, ids);
  }
  return (value: string) => {
    if (value === "@site" || exact.has(value)) return value;
    const ids = aliases.get(value.toLowerCase().replace(/[^a-z0-9]+/g, ""));
    if (ids?.size !== 1) return fail(ids?.size ? `Ambiguous equipment alias: ${value}. Use an exact equipment ID.` : `Unknown equipment: ${value}.`);
    return [...ids][0];
  };
}
async function* csvReadings(open: () => Promise<ReadableStream<Uint8Array>> | ReadableStream<Uint8Array>, options: CsvIngestOptions, isObservation: (reading: PerformanceReading) => boolean) {
  const known = new Set(options.equipment.map(item => item.id)), resolve = csvResolver(options.equipment);
  let headers: string[] | null = null, count = 0, line = 1;
  const mapped = options.mapping;
  if (!mapped || typeof mapped !== "object" || Array.isArray(mapped) || !mapped.timestamp || !Array.isArray(options.signals)) fail("A timestamp and valid column mappings are required.");
  if (Object.values(mapped).some(value => typeof value !== "string")) fail("Invalid CSV column mapping.");
  const signals = options.signals.filter(item => item?.equipmentId);
  const long = !!(mapped.equipment && mapped.measurement && mapped.value);
  if ([mapped.equipment, mapped.measurement, mapped.value].some(Boolean) && !long) fail("Long CSV requires equipment, measurement, and value mappings.");
  if (!signals.length && !long && !mapped.expectedProduction) fail("Map at least one telemetry channel.");
  for await (const row of performanceCsvRecords(await open())) {
    if (!headers) {
      headers = row.map(value => value.trim());
      if (headers.some(value => !value) || new Set(headers).size !== headers.length) fail("CSV headers must be nonempty and unique.");
      const used = [...Object.values(mapped).filter(Boolean), ...signals.map(signal => signal.column)];
      if (used.some(column => !column || !headers!.includes(column))) fail("One or more mapped CSV columns are missing.");
      if (new Set(used).size !== used.length) fail("A CSV column has multiple conflicting mappings.");
      if (headers.some(header => !used.includes(header))) fail("The CSV contains unmapped columns. Review mappings before upload.");
      continue;
    }
    line++;
    if (row.length !== headers.length) fail(`CSV record ${line} has the wrong column count.`);
    const value = (column?: string) => column ? row[headers!.indexOf(column)] : "";
    const timestamp = value(mapped.timestamp), pending: PerformanceReading[] = [];
    const add = (raw: IncomingReading, hint: string) => pending.push(normalizeReading(raw, options, known, hint));
    if (mapped.expectedProduction) add({ timestamp, equipmentId: "@site", measurement: "Expected Production", value: value(mapped.expectedProduction) }, mapped.expectedProduction);
    if (long) {
      const equipment = value(mapped.equipment), metric = value(mapped.measurement), raw = value(mapped.value);
      if (equipment || metric || raw) {
        const measurement = [...measures, "Cumulative energy"].find(name => name.toLowerCase() === metric.toLowerCase()) || suggestedMeasurement(metric);
        add({ timestamp, equipmentId: resolve(equipment), measurement, value: raw, unit: value(mapped.unit) || undefined,
          channelId: value(mapped.channelId) || undefined }, metric);
      }
    }
    for (const signal of signals) add({ timestamp, equipmentId: signal.equipmentId!, measurement: signal.measurement!, value: value(signal.column),
      unit: signal.unit ?? (long ? undefined : value(mapped.unit) || undefined), channelId: signal.channelId }, signal.column!);
    if (!pending.length) fail(`CSV record ${line} has no equipment/channel identity.`);
    const snowOnly = pending.some(item => isObservation(item) && item.value !== null) && pending.every(item => isObservation(item) || item.value === null);
    for (const reading of pending) {
      // An event-only snow row does not assert an interval for empty wide columns.
      if (snowOnly && !isObservation(reading)) continue;
      if (++count > INGEST_LIMITS.readings) fail("CSV reading limit exceeded.");
      yield reading;
    }
  }
  if (!count) fail("The CSV needs a header and at least one data record.");
}
export async function prepareCsvImport(open: () => Promise<ReadableStream<Uint8Array>> | ReadableStream<Uint8Array>, options: CsvIngestOptions) {
  checkOptions(options);
  const times = new Set<number>(), isObservation = observationTimePredicate(options.equipment);
  for await (const reading of csvReadings(open, options, isObservation)) if (!isObservation(reading)) times.add(Date.parse(reading.timestamp));
  const intervalMinutes = inferCadence(times, options);
  async function* readings() {
    for await (const reading of csvReadings(open, options, isObservation)) yield intervalStart(reading, intervalMinutes, options.timestampConvention, isObservation(reading));
  }
  return { intervalMinutes, readings: readings() };
}

/** Count actual streamed bytes instead of trusting Content-Length. */
export async function readBoundedJson(request: Request, maxBytes = INGEST_LIMITS.jsonBytes): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) fail("Content-Type must be application/json.");
  if (Number(request.headers.get("content-length") || 0) > maxBytes) fail("JSON request is too large.");
  if (!request.body) fail("A JSON body is required.");
  const reader = request.body!.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "";
  try {
    while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > maxBytes) fail("JSON request is too large."); text += decoder.decode(next.value, { stream: true }); }
    text += decoder.decode();
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("The JSON body must be an object.");
    return value;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof PerformanceValidationError) throw error;
    return fail("Invalid JSON request.");
  } finally { reader.releaseLock(); }
}
