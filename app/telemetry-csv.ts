import { arrayCapacityModel } from "./array-capacity";
import type { EquipmentAsset } from "./equipment";
import { inspectTelemetryTimestamp, isValidTimezone, type TimestampConvention } from "./telemetry-time";

export type Mapping = { timestamp: string; expectedProduction: string; equipment: string; measurement: string; value: string; unit: string };
export type SignalMapping = { column:string; equipmentId:string; measurement:string; confidence:"high"|"medium"|"low"; reason:string };
export type CsvFormat = "long" | "wide" | "hybrid";
export type BaseValidation = {
  totalRows: number; checkedRows: number; validRows: number; errors: number; warnings: number;
  invalidTimestamps: number; missingValues: number; duplicateTimestamps: number; signalColumns: string[];
  start: string; end: string; interval: string; sampled: boolean;
  intervalMinutes: number; timezone: string; timestampConvention: TimestampConvention;
  ambiguousTimestamps: number; nonexistentTimestamps: number; cumulativeEnergySignals: number; inconsistentIntervals: number;
};
export type Validation = BaseValidation & {
  exportCapacityKw: number; capacityCheckedReadings: number; capacityExceededRows: number;
  maxObservedPowerKw: number; capacityCheckReady: boolean; capacityCheckMessage: string;
  capacityCheckSource: "active_power" | "interval_energy" | ""; capacityIntervalMinutes: number;
};

export function normalized(value:string){ return value.toLowerCase().replace(/[^a-z0-9]+/g,""); }
export function signalColumnsFor(headers:string[],mapping:Mapping){ const reserved=new Set(Object.values(mapping).filter(Boolean)); return headers.filter(header=>!reserved.has(header)); }
export function suggestedMeasurement(header:string){ const value=header.toLowerCase(); if(/snow/.test(value)) return "Snow code"; if(/poa|irradi/.test(value)) return "POA irradiance"; if(/\bghi\b/.test(value)) return "GHI irradiance"; if(/module.*temp|tmod|backsheet/.test(value)) return "Module temperature"; if(/ambient.*temp|tamb/.test(value)) return "Ambient temperature"; if(/wind/.test(value)) return "Wind speed"; if(/avail/.test(value)) return "Availability"; if(/status|alarm/.test(value)) return "Status"; if(/cumulative|totaliz|energy.?register|register.*energy/.test(value)) return "Cumulative energy"; if(/energy|kwh|mwh/.test(value)) return "Energy"; if(/dc.*power|power.*dc/.test(value)) return "DC power"; if(/power|kw|mw/.test(value)) return "Active power"; return "Other"; }
function gridExportCapacityKw(equipment:EquipmentAsset[]) {
  return arrayCapacityModel(equipment).gridExportKw ?? 0;
}
function powerToKw(raw:string,unit:string,header:string) {
  const cleaned=raw.replace(/,/g,"").trim();
  if(!cleaned)return null;
  const value=Number(cleaned);
  if(!Number.isFinite(value)) return null;
  const hint=`${unit} ${header}`.toLowerCase();
  if(/\bmw(?:ac)?\b/.test(hint)) return value*1000;
  if(/\bw(?:ac)?\b/.test(hint)&&!/\b[mk]w(?:ac)?\b/.test(hint)) return value/1000;
  return value;
}
function energyToKwh(raw:string,unit:string,header:string) {
  const cleaned=raw.replace(/,/g,"").trim();
  if(!cleaned)return null;
  const value=Number(cleaned);
  if(!Number.isFinite(value))return null;
  const hint=`${unit} ${header}`.toLowerCase();
  if(/\bmwh\b/.test(hint))return value*1000;
  if(/\bwh\b/.test(hint)&&!/\b[mk]wh\b/.test(hint))return value/1000;
  return value;
}
type TimestampProfile = {
  column: string; timezone: string; cadenceKey: string; parsed: Float64Array; sorted: number[]; ambiguous: number; nonexistent: number; inconsistent: number;
  interval: { minutes: number; reliable: boolean; gapCount: number; consistency: number };
  medianGap: number;
};
const timestampProfiles = new WeakMap<string[][], TimestampProfile>();
function timestampProfile(headers: string[], rows: string[][], mapping: Mapping, timezone = "UTC", signals: SignalMapping[] = []): TimestampProfile {
  const cadenceKey = JSON.stringify([mapping, signals.map(signal => [signal.column, signal.equipmentId, signal.measurement])]);
  const previous = timestampProfiles.get(rows);
  if (previous?.column === mapping.timestamp && previous.timezone === timezone && previous.cadenceKey === cadenceKey) return previous;
  const timestampIndex = headers.indexOf(mapping.timestamp);
  const parsed = new Float64Array(rows.length);
  const unique = new Set<number>();
  const cadenceTimes = new Set<number>();
  const expectedIndex = headers.indexOf(mapping.expectedProduction);
  const valueIndex = headers.indexOf(mapping.value), measurementIndex = headers.indexOf(mapping.measurement);
  const cadenceSignals = signals.filter(signal => signal.equipmentId).map(signal => ({ index: headers.indexOf(signal.column), measurement: signal.measurement }));
  const numeric = (value: string) => Boolean(value?.trim()) && Number.isFinite(Number(value.replace(/,/g, "")));
  const intervalMeasurement = (measurement: string) => measurement === "Energy" || measurement === "Active power" || measurement === "Expected Production" || /irradiance/i.test(measurement);
  const categoricalMeasurement = (measurement: string) => ["Snow code", "Status", "Other", "Availability"].includes(measurement);
  let ambiguous = 0, nonexistent = 0;
  rows.forEach((row, index) => {
    const result = inspectTelemetryTimestamp(row[timestampIndex] || "", timezone);
    if (result.reason === "ambiguous") ambiguous++;
    if (result.reason === "nonexistent") nonexistent++;
    const value = Date.parse(result.timestamp);
    parsed[index] = value;
    if (Number.isFinite(value)) {
      unique.add(value);
      let intervalReading = expectedIndex >= 0 && numeric(row[expectedIndex] || "");
      let categoricalReading = false;
      const inspect = (measurement: string, raw: string) => {
        if (intervalMeasurement(measurement) && numeric(raw)) intervalReading = true;
        if (categoricalMeasurement(measurement) && raw.trim()) categoricalReading = true;
      };
      if (valueIndex >= 0 && measurementIndex >= 0) inspect(suggestedMeasurement(row[measurementIndex] || ""), row[valueIndex] || "");
      cadenceSignals.forEach(signal => inspect(signal.measurement, row[signal.index] || ""));
      // Event/status observations need not share the interval-meter cadence.
      // Keep all-blank rows because they can represent missing interval telemetry.
      if (!categoricalReading || intervalReading) cadenceTimes.add(value);
    }
  });
  const sorted = [...unique].sort((a, b) => a - b);
  const cadenceSorted = [...cadenceTimes].sort((a, b) => a - b);
  const gaps = cadenceSorted.slice(1).map((value, index) => value - cadenceSorted[index]);
  const frequencies = new Map<number, number>();
  gaps.forEach(gap => { frequencies.set(gap, (frequencies.get(gap) || 0) + 1); });
  const cadenceMs = [...frequencies.entries()].sort((a,b) => b[1]-a[1] || a[0]-b[0])[0]?.[0] || 0;
  const inconsistent = gaps.filter(gap => gap < cadenceMs - 1 || Math.abs(gap - Math.round(gap / cadenceMs) * cadenceMs) > 1).length;
  const consistent = gaps.length - inconsistent;
  const consistency = gaps.length ? consistent / gaps.length : 0;
  gaps.sort((a, b) => a - b);
  const profile = { column: mapping.timestamp, timezone, cadenceKey, parsed, sorted, ambiguous, nonexistent, inconsistent,
    medianGap: gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0,
    interval: { minutes: cadenceMs / 60000, reliable: cadenceMs > 0 && inconsistent === 0, gapCount: gaps.length, consistency } };
  timestampProfiles.set(rows, profile);
  return profile;
}
function intervalProfile(headers: string[], rows: string[][], mapping: Mapping, timezone = "UTC", signals: SignalMapping[] = []) {
  return timestampProfile(headers, rows, mapping, timezone, signals).interval;
}
export function capacityValidation(headers:string[],rows:string[][],mapping:Mapping,signalMappings:SignalMapping[],equipment:EquipmentAsset[],timezone = "UTC") {
  const capacityModel=arrayCapacityModel(equipment);
  const exportCapacityKw=gridExportCapacityKw(equipment);
  const meter=equipment.find(item=>item.type==="revenue_meter");
  const activePowerReadings:number[]=[];
  const intervalEnergyReadingsKwh:number[]=[];
  const unitIndex=headers.indexOf(mapping.unit);
  if(meter) {
    signalMappings.filter(item=>item.equipmentId===meter.id&&item.measurement==="Active power").forEach(signal=>{
      const index=headers.indexOf(signal.column);
      if(index<0)return;
      rows.forEach(row=>{const value=powerToKw(row[index]||"",unitIndex>=0?row[unitIndex]||"":"",signal.column);if(value!==null)activePowerReadings.push(value)});
    });
    signalMappings.filter(item=>item.equipmentId===meter.id&&item.measurement==="Energy").forEach(signal=>{
      const index=headers.indexOf(signal.column);
      if(index<0)return;
      rows.forEach(row=>{const value=energyToKwh(row[index]||"",unitIndex>=0?row[unitIndex]||"":"",signal.column);if(value!==null)intervalEnergyReadingsKwh.push(value)});
    });
    if(mapping.equipment&&mapping.measurement&&mapping.value) {
      const equipmentIndex=headers.indexOf(mapping.equipment),measurementIndex=headers.indexOf(mapping.measurement),valueIndex=headers.indexOf(mapping.value);
      const meterIds=new Set([meter.externalId,meter.name,...meter.aliases].map(normalized));
      rows.forEach(row=>{
        if(!meterIds.has(normalized(row[equipmentIndex]||"")))return;
        const measurement=suggestedMeasurement(row[measurementIndex]||"");
        if(measurement==="Active power"){
          const value=powerToKw(row[valueIndex]||"",unitIndex>=0?row[unitIndex]||"":"",row[measurementIndex]||"");if(value!==null)activePowerReadings.push(value);
        }
        if(measurement==="Energy"){
          const value=energyToKwh(row[valueIndex]||"",unitIndex>=0?row[unitIndex]||"":"",`${row[measurementIndex]||""} ${unitIndex>=0?row[unitIndex]||"":""}`);if(value!==null)intervalEnergyReadingsKwh.push(value);
        }
      });
    }
  }
  const interval=intervalProfile(headers,rows,mapping,timezone,signalMappings);
  const useIntervalEnergy=!activePowerReadings.length&&intervalEnergyReadingsKwh.length>0&&interval.reliable;
  const readings=useIntervalEnergy?intervalEnergyReadingsKwh.map(value=>value/(interval.minutes/60)):activePowerReadings;
  const capacityCheckSource:Validation["capacityCheckSource"]=activePowerReadings.length?"active_power":useIntervalEnergy?"interval_energy":"";
  // Ignore floating-point noise when interval energy converts exactly to the ceiling.
  const capacityExceededRows=exportCapacityKw>0?readings.filter(value=>value>exportCapacityKw+Math.max(1e-6,exportCapacityKw*1e-9)).length:0;
  const maxObservedPowerKw=readings.reduce((maximum,value)=>Math.max(maximum,value),0);
  const capacityCheckReady=exportCapacityKw>0&&readings.length>0;
  const factor=interval.minutes?60/interval.minutes:0;
  const intervalLabel=Number.isInteger(interval.minutes)?interval.minutes.toLocaleString():interval.minutes.toLocaleString(undefined,{maximumFractionDigits:2});
  const formulaLabel=factor?factor.toLocaleString(undefined,{maximumFractionDigits:4}):"";
  const derivation=useIntervalEnergy?` Interval-average power was derived from the detected ${intervalLabel}-minute cadence (kW = interval kWh × ${formulaLabel}).`:"";
  const capacityCheckMessage= !capacityModel.complete?`Complete the transformer model: ${capacityModel.issues.join(" ")}`:!exportCapacityKw?"Configure a positive grid-export capacity in the array model before comparing production.":!activePowerReadings.length&&intervalEnergyReadingsKwh.length>0&&!interval.reliable?"Revenue-meter interval Energy is mapped, but a reliable timestamp cadence could not be determined. Review inconsistent or missing timestamps, or map an Active power signal.":!readings.length?"Map a revenue-meter Active power or interval Energy signal to compare production against the export ceiling.":capacityExceededRows?`${capacityExceededRows} ${capacityExceededRows===1?"reading exceeds":"readings exceed"} the ${exportCapacityKw.toLocaleString(undefined,{maximumFractionDigits:2})} kWac grid-export ceiling.${derivation}`:`All ${readings.length.toLocaleString()} revenue-meter ${useIntervalEnergy?"interval-average power":"active-power"} readings are within the configured grid-export ceiling.${derivation}`;
  return {exportCapacityKw,capacityCheckedReadings:readings.length,capacityExceededRows,maxObservedPowerKw,capacityCheckReady,capacityCheckMessage,capacityCheckSource,capacityIntervalMinutes:useIntervalEnergy?interval.minutes:0};
}
export function suggestSignal(column:string,equipment:EquipmentAsset[]):SignalMapping {
  const header=normalized(column); const tokens=column.toLowerCase().split(/[^a-z0-9]+/).filter(token=>token.length>1);
  const scored=equipment.map(asset=>{
    let score=0; const identities=[asset.externalId,asset.name,...asset.aliases];
    let identityScore=0;
    identities.forEach(identity=>{const key=normalized(identity);if(key&&header.includes(key))identityScore=Math.max(identityScore,10);else identityScore=Math.max(identityScore,tokens.filter(token=>token.length>=3&&!/^(temp|power|energy|meter|sensor|device|inverter|module|array)$/.test(token)&&normalized(identity).includes(token)).length*2)}); score+=identityScore;
    asset.channels.forEach(channel=>{const key=normalized(channel);if(key&&header.includes(key))score+=3});
    if(asset.type==="revenue_meter"&&/meter|mtr|revenue|pcc|energy/.test(column.toLowerCase()))score+=4;
    if(asset.type==="inverter"&&/inverter|(^|_)inv|ac.?power|dc.?power/.test(column.toLowerCase()))score+=4;
    if(asset.type==="weather_sensor"&&/irradi|poa|ghi|temp|wind|weather|snow/.test(column.toLowerCase()))score+=6;
    if(asset.type==="module_group"&&/module|string|array|block/.test(column.toLowerCase()))score+=4;
    return {asset,score};
  }).sort((a,b)=>b.score-a.score);
  const top=scored[0], tied=top&&top.score>0&&scored.filter(item=>item.score===top.score).length>1;
  if(!top||top.score<3||tied) return {column,equipmentId:"",measurement:suggestedMeasurement(column),confidence:"low",reason:tied?"Multiple equipment nodes match":"No configured equipment identifier found"};
  return {column,equipmentId:top.asset.id,measurement:suggestedMeasurement(column),confidence:top.score>=8?"high":"medium",reason:top.score>=8?"Equipment ID or alias matched":"Type and channel pattern matched"};
}

export function autoMapping(headers: string[]): Mapping {
  const find = (pattern: RegExp) => headers.find(header => pattern.test(header.toLowerCase())) || "";
  return {
    timestamp: find(/(^|[_\s-])(timestamp|datetime|date.?time|interval.?end|time)($|[_\s-])/),
    expectedProduction: find(/expected[_\s-]*production/),
    equipment: find(/(^|[_\s-])(equipment|device|inverter|meter|station|asset|source)([_\s-]?(id|name|tag))?$/),
    measurement: find(/measurement|metric|tag|signal|channel|point/),
    value: find(/(^|[_\s-])(value|reading)($|[_\s-])/),
    unit: find(/(^|[_\s-])(unit|uom)($|[_\s-])/),
  };
}

export function detectCsvFormat(headers:string[],mapping:Mapping):CsvFormat {
  const hasLongCore=Boolean(mapping.equipment&&mapping.measurement&&mapping.value);
  const signalCount=signalColumnsFor(headers,mapping).filter(header=>suggestedMeasurement(header)!=="Other").length;
  if(hasLongCore&&signalCount)return "hybrid";
  if(hasLongCore)return "long";
  return "wide";
}

export function detectTypes(headers: string[], rows: string[][], mapping: Mapping) {
  const searchable = `${headers.join(" ")} ${rows.slice(0, 30).flat().join(" ")}`.toLowerCase();
  const detected: string[] = [];
  if (/irradi|\bghi\b|\bpoa\b|\bdni\b|\bdhi\b/.test(searchable)) detected.push("Irradiance");
  if (/inverter|\binv[_\s-]?\d|dc.?power|ac.?power/.test(searchable)) detected.push("Inverter");
  if (/revenue.?meter|\bmeter\b|delivered|received|\bkwh\b|\bmwh\b|energy/.test(searchable)) detected.push("Interval meter");
  if (/scada|ambient.?temp|module.?temp|wind.?speed|availability|status|alarm/.test(searchable)) detected.push("SCADA");
  if (!detected.length && mapping.timestamp) detected.push("Telemetry");
  return detected;
}

export function calculateValidation(headers: string[], rows: string[][], mapping: Mapping, signalMappings:SignalMapping[], timezone = "UTC", timestampConvention: TimestampConvention = "start"): BaseValidation {
  const timestampIndex = headers.indexOf(mapping.timestamp);
  const equipmentIndex = headers.indexOf(mapping.equipment);
  const valueIndex = headers.indexOf(mapping.value);
  const signalColumns = signalMappings.filter(item=>item.equipmentId).map(item=>item.column);
  const profile = timestampProfile(headers, rows, mapping, timezone,signalMappings);
  const signalIndexes = signalColumns.map(header => headers.indexOf(header));
  const dates = profile.sorted, keys = new Set<string>();
  let invalidTimestamps = 0, missingValues = 0, duplicateTimestamps = 0, validRows = 0;
  rows.forEach((row, rowIndex) => {
    const rawTime = timestampIndex >= 0 ? row[timestampIndex] : "";
    const date = profile.parsed[rowIndex];
    const key = `${date}|${equipmentIndex >= 0 ? row[equipmentIndex] : ""}|${mapping.measurement ? row[headers.indexOf(mapping.measurement)] : ""}`;
    const hasValue = valueIndex >= 0 ? row[valueIndex] !== "" : signalIndexes.some(index => row[index] !== "");
    if (!rawTime || Number.isNaN(date)) invalidTimestamps += 1;
    else { if (keys.has(key)) duplicateTimestamps += 1; keys.add(key); }
    if (!hasValue) missingValues += 1;
    if (rawTime && !Number.isNaN(date) && hasValue) validRows += 1;
  });
  const intervalMinutes = profile.interval.minutes;
  const interval = intervalMinutes ? intervalMinutes % 60 === 0 ? `${intervalMinutes / 60} hour` : `${Number(intervalMinutes.toFixed(6))} min` : "Not detected";
  const mappedCumulative = signalMappings.filter(signal => signal.equipmentId && signal.measurement === "Cumulative energy").length;
  const longCumulative = mapping.measurement ? rows.filter(row => suggestedMeasurement(row[headers.indexOf(mapping.measurement)] || "") === "Cumulative energy").length : 0;
  const cumulativeEnergySignals = mappedCumulative + longCumulative;
  const errors = (mapping.timestamp ? 0 : 1) + invalidTimestamps + (isValidTimezone(timezone) ? 0 : 1) + (cumulativeEnergySignals ? 1 : 0) + (profile.inconsistent ? 1 : 0) + (!invalidTimestamps && !intervalMinutes ? 1 : 0);
  const warnings = missingValues + duplicateTimestamps + (signalColumns.length || mapping.value ? 0 : 1) + (profile.interval.reliable ? 0 : 1);
  return {
    totalRows: rows.length, checkedRows: rows.length, validRows, errors, warnings,
    invalidTimestamps, missingValues, duplicateTimestamps, signalColumns,
    start: dates.length ? new Date(dates[0]).toISOString() : "",
    end: dates.length ? new Date(dates[dates.length - 1]).toISOString() : "",
    interval, intervalMinutes, timezone, timestampConvention, sampled: false,
    ambiguousTimestamps: profile.ambiguous, nonexistentTimestamps: profile.nonexistent, cumulativeEnergySignals, inconsistentIntervals: profile.inconsistent,
  };
}

function escapeCsvCell(value:string){return /[",\r\n]/.test(value)?`"${value.replace(/"/g,'""')}"`:value}
export function mappedCsvFile(file:File,headers:string[],rows:string[][],mapping:Mapping,signalMappings:SignalMapping[]){
  const retained=new Set([...Object.values(mapping).filter(Boolean),...signalMappings.filter(item=>item.equipmentId).map(item=>item.column)]);
  const includedHeaders=headers.filter(header=>retained.has(header));
  const indexes=includedHeaders.map(header=>headers.indexOf(header));
  const parts: BlobPart[] = [];
  let chunk = includedHeaders.map(escapeCsvCell).join(",");
  for (const row of rows) {
    chunk += "\r\n" + indexes.map(index => escapeCsvCell(row[index] || "")).join(",");
    if (chunk.length >= 512 * 1024) { parts.push(chunk); chunk = ""; }
  }
  if (chunk) parts.push(chunk);
  return new File(parts, file.name, { type: "text/csv" });
}


// Decode incrementally; quote and CRLF state survive arbitrary stream boundaries.
export async function parseCsvStream(stream: ReadableStream<Uint8Array>, onRow: (row: string[]) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let row: string[] = [], cell = "", quoted = false, pendingQuote = false, skipLf = false;
  const emit = () => {
    row.push(cell.trim()); cell = "";
    if (row.some(value => value !== "")) onRow(row);
    row = [];
  };
  const consume = (text: string) => {
    for (const char of text) {
      if (pendingQuote) {
        pendingQuote = false;
        if (char === '"') { cell += '"'; continue; }
        quoted = false;
      }
      if (skipLf) { skipLf = false; if (char === "\n") continue; }
      if (char === '"') {
        if (quoted) pendingQuote = true;
        else quoted = true;
      } else if (char === "," && !quoted) { row.push(cell.trim()); cell = ""; }
      else if ((char === "\r" || char === "\n") && !quoted) { emit(); skipLf = char === "\r"; }
      else cell += char;
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
    }
    consume(decoder.decode());
    if (cell || row.length) emit();
  } finally { reader.releaseLock(); }
}
