import { parseCsv } from "./csv-stream";
import { inspectTelemetryTimestamp, localDate } from "./telemetry-time";

// Compact, immutable readings live in monthly R2 partitions, never SQL rows.
export type HistoryCell = [timestamp: string, equipment: string, measurement: string, value: number | null, sourceImport: string];
export type HistoryPart = { key: string; hash: string; count: number; bytes: number; first:string;last:string };
export type HistoryManifest = { id: string; siteId: string; year: number; timezone: string; intervalMinutes: number;
  intervalOrigin?:number;
  createdAt: string; parts: Record<string, HistoryPart>; sources: { id: string; fileName: string; createdAt: string; mode: string; from?: string; through?: string }[] };
export type HistoryImport = { id: string; siteId: string; objectKey: string; fileName: string; createdAt: string; timezone: string; mapping: string; validation: string };
export type HistoryEquipment = { id: string; name: string; externalId: string; aliases: string; type: string };
export const MAX_MONTH_CELLS = 120_000;
export const MAX_YEAR_CELLS = 1_200_000;
export const historyCellKey = (cell: HistoryCell) => JSON.stringify(cell.slice(0, 3));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
export function canonicalMeasurement(value: string) {
  const s = value.toLowerCase();
  if (/cumulative|totaliz|energy.?register|register.*energy/.test(s)) throw new Error("Convert cumulative energy to interval energy before importing.");
  if (/snow/.test(s)) return "Snow code";
  if (/\bpoa\b|plane.?of.?array/.test(s)) return "POA irradiance";
  if (/\bghi\b|irradi|pyranometer/.test(s)) return "Irradiance";
  if (/energy|kwh|mwh/.test(s)) return "Energy";
  if (/dc.*power|power.*dc/.test(s)) return "DC power";
  if (/power|\bkw\b|\bmw\b/.test(s)) return "Active power";
  return value === "Status" ? "Status" : "Other";
}
export function canonicalValue(raw: string, measurement: string, hint: string): number | null {
  if (!raw.trim()) return null;
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const s = hint.toLowerCase();
  if (measurement === "Energy") return /\bmwh\b/.test(s) ? n * 1000 : /\bwh\b/.test(s) && !/\b[mk]wh\b/.test(s) ? n / 1000 : n;
  if (/power/.test(measurement)) return /\bmw\b/.test(s) ? n * 1000 : /\bw\b/.test(s) && !/\b[mk]w\b/.test(s) ? n / 1000 : n;
  if (/irradiance/.test(measurement)) return Math.max(0, /kw\s*\/?\s*m(?:2|²)/.test(s) ? n * 1000 : n);
  return n;
}
export function importCadence(record: HistoryImport) {
  const v = JSON.parse(record.validation || "{}");
  const text = String(v.interval || "");
  const minutes = Number(v.intervalMinutes) || (/^hourly$/i.test(text)?60:/^daily$/i.test(text)?1440:Number(text.match(/[\d.]+/)?.[0]) * (/hour/i.test(text) ? 60 : 1));
  if (!(minutes > 0)) throw new Error("The import has no reliable interval duration. Revalidate and upload it again.");
  return minutes;
}

export async function normalizeHistoryMonth(stream: ReadableStream<Uint8Array>, record: HistoryImport, equipment: HistoryEquipment[], month: string, timezone: string) {
  const mapping = JSON.parse(record.mapping), roles = mapping.roles || {}, signals = mapping.equipment?.signals || [];
  const validation = JSON.parse(record.validation || "{}"), minutes = importCadence(record);
  const identity = new Map<string, string>();
  for (const a of equipment) for (const name of [a.id, a.name, a.externalId, ...JSON.parse(a.aliases || "[]")]) identity.set(norm(name), a.id);
  const known = new Set(equipment.map(a => a.id));
  const cells = new Map<string, HistoryCell>(); const signalKeys = new Set<string>();
  let headers: string[] = [], ix: Record<string, number> = {}, rowCount = 0, outsideYear = 0;
  let intervalOrigin:number|undefined,lastTimestamp='',lastDay='',lastRawTimestamp='',shiftedTimestamp='';
  const snowIds=new Set(equipment.filter(a=>a.name.trim().toLowerCase()==="snow sensor").map(a=>a.id));
  const add = (rawTimestamp: string, equipmentId: string, measurement: string, raw: string, hint: string) => {
    if (["Other", "Status"].includes(measurement) && !snowIds.has(equipmentId)) return;
    if(rawTimestamp!==lastRawTimestamp){lastRawTimestamp=rawTimestamp;shiftedTimestamp=validation.timestampConvention==="end"?new Date(Date.parse(rawTimestamp)-minutes*60000).toISOString():rawTimestamp;}
    const timestamp=snowIds.has(equipmentId)?rawTimestamp:shiftedTimestamp;
    if(!snowIds.has(equipmentId)&&measurement!=="DC power"){
      const origin=((Date.parse(timestamp)%(minutes*60000))+minutes*60000)%(minutes*60000);
      if(intervalOrigin!==undefined&&Math.abs(origin-intervalOrigin)>1)throw new Error("The file contains readings on inconsistent interval boundaries. Align the timestamps before importing.");
      intervalOrigin=origin;
    }
    signalKeys.add(JSON.stringify([equipmentId, measurement]));
    if(timestamp!==lastTimestamp){lastTimestamp=timestamp;lastDay=localDate(timestamp,timezone);}
    const day=lastDay;
    if (!day.startsWith(month.slice(0, 4))) { outsideYear++; return; }
    if (!day.startsWith(month)) return;
    const cell: HistoryCell = [timestamp, equipmentId, measurement, canonicalValue(raw, measurement, hint), record.id];
    const key = historyCellKey(cell), prior = cells.get(key);
    if (prior && prior[3] !== cell[3]) throw new Error(`Conflicting duplicate readings in ${record.fileName} at ${timestamp}. Correct the file before importing.`);
    cells.set(key, cell);
    if (cells.size > MAX_MONTH_CELLS) throw new Error(`${month} exceeds the ${MAX_MONTH_CELLS.toLocaleString("en-US")} readings-per-month limit. The uploaded file is retained; no history was changed.`);
  };
  await parseCsv(stream, row => {
    if (!headers.length) { headers = row.map((s, i) => i ? s : s.replace(/^\uFEFF/, "")); ix = Object.fromEntries(headers.map((s, i) => [s, i])); return; }
    rowCount++;
    const parsed = inspectTelemetryTimestamp(row[ix[roles.timestamp]] || "", record.timezone);
    if (!parsed.timestamp) throw new Error(`Invalid timestamp in ${record.fileName}, row ${rowCount + 1}.`);
    const timestamp = parsed.timestamp;
    const unit = row[ix[roles.unit]] || "";
    if (roles.expectedProduction) add(timestamp, "@site", "Expected Production", row[ix[roles.expectedProduction]] || "", "kWh");
    if (roles.equipment && roles.value) {
      const id = identity.get(norm(row[ix[roles.equipment]] || ""));
      if (!id) throw new Error(`Unknown equipment in ${record.fileName}, row ${rowCount + 1}. Review the equipment mapping.`);
      const header = row[ix[roles.measurement]] || "";
      add(timestamp, id, canonicalMeasurement(header), row[ix[roles.value]] || "", `${unit} ${header}`);
    }
    for (const signal of signals) if (signal.equipmentId && signal.column) {
      if (!known.has(signal.equipmentId)) throw new Error("An imported signal refers to equipment that no longer exists. Review the array model.");
      add(timestamp, signal.equipmentId, canonicalMeasurement(signal.measurement || signal.column), row[ix[signal.column]] || "", `${unit} ${signal.column}`);
    }
  });
  return { cells: [...cells.values()], signals: [...signalKeys], outsideYear, rows: rowCount,intervalOrigin };
}

export function mergeHistoryMonth(existing: HistoryCell[], incoming: HistoryCell[], mode: "append" | "replace", signals: string[], from: string, through: string, timezone: string) {
  const result = new Map(existing.map(cell => [historyCellKey(cell), cell]));
  const replacements = new Set(signals);
  const incomingKeys = mode === "replace" && existing.length ? new Set(incoming.map(historyCellKey)) : null;
  let lastTimestamp = "", lastDay = "";
  const dayFor = (timestamp:string) => {if(timestamp!==lastTimestamp){lastTimestamp=timestamp;lastDay=localDate(timestamp,timezone);}return lastDay;};
  const stats = { added: 0, identical: 0, conflicts: 0, replaced: 0, removed: 0 };
  const samples: { timestamp: string; equipment: string; measurement: string; previous: number | null; incoming: number | null }[] = [];
  if (mode === "replace") for (const [key, cell] of result) {
    const day = dayFor(cell[0]);
    if (day >= from && day <= through && replacements.has(JSON.stringify(cell.slice(1, 3))) && !incomingKeys?.has(key)) { result.delete(key); stats.removed++; }
  }
  for (const cell of incoming) {
    const day = dayFor(cell[0]);
    if (mode === "replace" && (day < from || day > through)) continue;
    const key = historyCellKey(cell), previous = result.get(key);
    if (!previous) { result.set(key, cell); stats.added++; }
    else if (previous[3] === cell[3]) stats.identical++;
    else {
      stats.conflicts++;
      if (samples.length < 5) samples.push({ timestamp: cell[0], equipment: cell[1], measurement: cell[2], previous: previous[3], incoming: cell[3] });
      if (mode === "replace") { result.set(key, cell); stats.replaced++; }
    }
  }
  if (result.size > MAX_MONTH_CELLS) throw new Error(`The combined month exceeds the ${MAX_MONTH_CELLS.toLocaleString("en-US")} readings-per-month limit. The uploaded file is retained; no history was changed.`);
  return { cells: [...result.values()].sort((a,b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2])), stats, samples };
}

type IndexedHistory = {format:"indexed-history-v1";timestamps:string[];equipment:string[];measurements:string[];sources:string[];values:[number,number,number,number|null,number][]};
export function encodeHistoryCells(cells:HistoryCell[]):IndexedHistory {
  const dictionaries=[new Map<string,number>(),new Map<string,number>(),new Map<string,number>(),new Map<string,number>()];
  const lists:string[][]=[[],[],[],[]];
  const index=(dimension:number,value:string)=>{let found=dictionaries[dimension].get(value);if(found===undefined){found=lists[dimension].length;lists[dimension].push(value);dictionaries[dimension].set(value,found);}return found;};
  const values:IndexedHistory["values"]=cells.map(c=>[index(0,c[0]),index(1,c[1]),index(2,c[2]),c[3],index(3,c[4])]);
  return {format:"indexed-history-v1",timestamps:lists[0],equipment:lists[1],measurements:lists[2],sources:lists[3],values};
}
export function decodeHistoryCells(stored:HistoryCell[]|IndexedHistory):HistoryCell[] {
  if(Array.isArray(stored))return stored;
  if(stored?.format!=="indexed-history-v1")throw new Error("The retained history partition format is unavailable.");
  return stored.values.map(c=>{
    const timestamp=stored.timestamps[c[0]],equipment=stored.equipment[c[1]],measurement=stored.measurements[c[2]],source=stored.sources[c[4]];
    if([timestamp,equipment,measurement,source].some(value=>typeof value!=="string"))throw new Error("The retained history partition contains an invalid reference.");
    return [timestamp,equipment,measurement,c[3],source];
  });
}

export async function historyHash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function historyCsv(manifest: HistoryManifest, readPart: (key: string) => Promise<HistoryCell[]>) {
  const keys = Object.values(manifest.parts); let part = 0, cells: HistoryCell[] = [], index = 0, header = false;
  const encoder = new TextEncoder();
  const quote = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return new ReadableStream<Uint8Array>({ async pull(controller) {
    if (!header) { header = true; controller.enqueue(encoder.encode("Timestamp,Equipment,Measurement,Value,Unit,Expected Production\n")); return; }
    if (index >= cells.length) {
      if (part >= keys.length) { controller.close(); return; }
      cells = await readPart(keys[part++].key); index = 0;
    }
    const batch = cells.slice(index, index + 500); index += batch.length;
    controller.enqueue(encoder.encode(batch.map(c => [c[0], c[1], c[2], c[1] === "@site" ? "" : c[3], c[2] === "Energy" ? "kWh" : /power/.test(c[2]) ? "kW" : /irradiance/.test(c[2]) ? "W/m²" : "", c[1] === "@site" ? c[3] : ""].map(quote).join(",")).join("\n") + (batch.length ? "\n" : "")));
  } });
}
