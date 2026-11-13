import { depotCleanupInProgress } from "../../../db/depot-performance-cleanup";
import { and, desc, eq, ne } from "drizzle-orm";
import { getDb } from "../../../db";
import { getBucketBinding, getDatabaseBinding } from "../../../db/binding";
import { equipmentAssets, telemetryImports } from "../../../db/schema";
import { historyHash, encodeHistoryCells, decodeHistoryCells, importCadence, normalizeHistoryMonth, mergeHistoryMonth, MAX_YEAR_CELLS, type HistoryCell, type HistoryManifest } from "../../data-history";

type Version = { id: string; site_id: string; import_id: string; year: number; parent_id: string; state: string; step: number; metadata: string; created_at: string };
type Preview = { manifest: HistoryManifest; mode: "append" | "replace"; from: string; through: string; legacyId: string;
  stats: { added: number; identical: number; conflicts: number; replaced: number; removed: number }; samples: unknown[]; count: number };
const zeroStats = () => ({ added: 0, identical: 0, conflicts: 0, replaced: 0, removed: 0 });
export const manifestKey = (siteId: string, id: string) => `history/${siteId}/${id}/manifest.json`;
export async function readManifest(siteId: string, id: string): Promise<HistoryManifest> {
  const object = await getBucketBinding().get(manifestKey(siteId,id));
  if (!object) throw new Error("The retained history version is unavailable.");
  return object.json<HistoryManifest>();
}
export async function activeHistory(siteId: string, year = 2026) {
  const head = await getDatabaseBinding().prepare("SELECT revision_id FROM data_history_heads WHERE id = ?").bind(`${siteId}|${year}`).first<{revision_id:string}>();
  return head?.revision_id ? readManifest(siteId, head.revision_id) : null;
}
export async function latestLegacyImport(siteId: string) {
  return (await getDb().select().from(telemetryImports).where(and(eq(telemetryImports.siteId,siteId), ne(telemetryImports.status,"pending"))).orderBy(desc(telemetryImports.createdAt)).limit(1))[0];
}
export async function currentAnalysisInput(siteId: string, year = 2026) {
  if (await depotCleanupInProgress(getDatabaseBinding(),siteId)) return undefined;
  return latestLegacyImport(siteId);
}
export async function historyVersion(id:string,siteId:string) {
  return getDatabaseBinding().prepare("SELECT * FROM data_history_versions WHERE id = ? AND site_id = ?").bind(id,siteId).first<Version>();
}
export function publicPreview(version:Version) {
  const p:Preview=JSON.parse(version.metadata);
  return {id:version.id,state:version.state,step:version.step,total:12,year:version.year,mode:p.mode,from:p.from,through:p.through,
    stats:p.stats,samples:p.samples,readings:p.count,canActivate:version.step===12 && (p.mode==="replace" || !p.stats.conflicts),sources:p.manifest.sources,timezone:p.manifest.timezone};
}
export async function beginPreview(siteId:string,importId:string,mode:string,year:number,from:string,through:string) {
  if (!["append","replace"].includes(mode) || !Number.isInteger(year) || year<2000 || year>2100) throw new Error("Choose an import mode and valid analysis year.");
  if (mode==="replace" && (!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(through)||new Date(from).toISOString().slice(0,10)!==from||new Date(through).toISOString().slice(0,10)!==through||from>through||!from.startsWith(String(year))||!through.startsWith(String(year)))) throw new Error("Choose valid replacement dates within the selected year.");
  const [record] = await getDb().select().from(telemetryImports).where(and(eq(telemetryImports.id,importId),eq(telemetryImports.siteId,siteId))).limit(1);
  if (!record) throw new Error("The uploaded file is unavailable.");
  const active=await activeHistory(siteId,year), legacy=active?undefined:await latestLegacyImport(siteId);
  const cadence=importCadence(record), timezone=active?.timezone||legacy?.timezone||record.timezone;
  if (active && active.intervalMinutes!==cadence || legacy && importCadence(legacy)!==cadence) throw new Error("History imports must use the same interval duration. Convert the new file to the existing cadence first.");
  const id=crypto.randomUUID(), createdAt=new Date().toISOString();
  const source={id:record.id,fileName:record.fileName,createdAt:record.createdAt,mode,...(mode==="replace"?{from,through}:{})};
  const sources=active?.sources || (legacy?[{id:legacy.id,fileName:legacy.fileName,createdAt:legacy.createdAt,mode:"initial"}]:[]);
  const preview:Preview={manifest:{id,siteId,year,timezone,intervalMinutes:cadence,createdAt,parts:{},sources:[...sources,source]},mode:mode as Preview["mode"],from,through,legacyId:legacy?.id||"",stats:zeroStats(),samples:[],count:0};
  if (sources.length>=500) throw new Error("This history has reached the initial revision limit. Its existing data is preserved.");
  await getDatabaseBinding().prepare("INSERT INTO data_history_versions (id,site_id,import_id,year,parent_id,state,step,metadata,created_at) VALUES (?,?,?,?,?,'preparing',0,?,?)")
    .bind(id,siteId,importId,year,active?.id||"",JSON.stringify(preview),createdAt).run();
  return (await historyVersion(id,siteId))!;
}
export async function prepareNextMonth(version:Version) {
  if (version.step>=12) return version;
  const p:Preview=JSON.parse(version.metadata), month=`${version.year}-${String(version.step+1).padStart(2,"0")}`;
  const db=getDb(),bucket=getBucketBinding();
  const [record]=await db.select().from(telemetryImports).where(eq(telemetryImports.id,version.import_id)).limit(1);
  if (!record || record.siteId!==version.site_id) throw new Error("The uploaded file is unavailable.");
  const equipment=await db.select().from(equipmentAssets).where(eq(equipmentAssets.siteId,version.site_id));
  const object=await bucket.get(record.objectKey);if(!object)throw new Error("The uploaded CSV is unavailable.");
  const incoming=await normalizeHistoryMonth(object.body,record,equipment,month,p.manifest.timezone);
  if(incoming.outsideYear)throw new Error(`The file contains interval starts outside ${version.year}. Upload one calendar year at a time; no data has been activated.`);
  let existing:HistoryCell[]=[],previousPart:HistoryManifest["parts"][string]|undefined;
  if(version.parent_id){const previous=await readManifest(version.site_id,version.parent_id);p.manifest.intervalOrigin=previous.intervalOrigin;previousPart=previous.parts[month];if(previousPart){const o=await bucket.get(previousPart.key);if(!o)throw new Error("A retained history partition is unavailable.");existing=decodeHistoryCells(await o.json<Parameters<typeof decodeHistoryCells>[0]>());}}
  else if(p.legacyId){const [legacy]=await db.select().from(telemetryImports).where(eq(telemetryImports.id,p.legacyId)).limit(1);if(legacy){const o=await bucket.get(legacy.objectKey);if(!o)throw new Error("The previous CSV is unavailable.");const base=await normalizeHistoryMonth(o.body,legacy,equipment,month,p.manifest.timezone);existing=base.cells;p.manifest.intervalOrigin=base.intervalOrigin;}}
  if(p.manifest.intervalOrigin!==undefined&&incoming.intervalOrigin!==undefined&&Math.abs(p.manifest.intervalOrigin-incoming.intervalOrigin)>1)throw new Error("The uploaded timestamps use different interval boundaries from the existing history. Align them before importing.");
  p.manifest.intervalOrigin??=incoming.intervalOrigin;
  const merged=mergeHistoryMonth(existing,incoming.cells,p.mode,incoming.signals,p.from,p.through,p.manifest.timezone);
  const json=JSON.stringify(encodeHistoryCells(merged.cells)), key=`history/${version.site_id}/${version.id}/${month}.json`;
  if(merged.cells.length){const hash=await historyHash(json);if(previousPart?.hash===hash)p.manifest.parts[month]=previousPart;else{await bucket.put(key,json,{httpMetadata:{contentType:"application/json"}});p.manifest.parts[month]={key,hash,count:merged.cells.length,bytes:new TextEncoder().encode(json).byteLength,first:merged.cells[0][0],last:merged.cells.at(-1)![0]};}}
  for(const k of Object.keys(p.stats) as (keyof Preview["stats"])[]) p.stats[k]+=merged.stats[k];
  p.samples.push(...merged.samples.slice(0,Math.max(0,10-p.samples.length)));p.count+=merged.cells.length;
  if(p.count>MAX_YEAR_CELLS)throw new Error(`This year exceeds the ${MAX_YEAR_CELLS.toLocaleString("en-US")} readings-per-site limit. The uploaded file is retained; no history was changed.`);
  const next=version.step+1;
  if(next===12){if(!p.count)throw new Error("The selected year contains no usable readings.");const parts=Object.values(p.manifest.parts),first=parts.map(p=>p.first).sort()[0],last=parts.map(p=>p.last).sort().at(-1)!;
    const expectedSlots=(1+(Date.parse(last)-Date.parse(first))/(p.manifest.intervalMinutes*60000))*equipment.filter(e=>["inverter","revenue_meter"].includes(e.type)).length;
    if(expectedSlots>MAX_YEAR_CELLS)throw new Error(`The equipment count and time span exceed the ${MAX_YEAR_CELLS.toLocaleString("en-US")} interval capacity, including missing readings. The uploaded file is retained; no history was changed.`);
    await bucket.put(manifestKey(version.site_id,version.id),JSON.stringify(p.manifest),{httpMetadata:{contentType:"application/json"}});}
  await getDatabaseBinding().prepare("UPDATE data_history_versions SET metadata = ?, step = ?, state = ? WHERE id = ? AND step = ? AND state = 'preparing'")
    .bind(JSON.stringify(p),next,next===12?"preview":"preparing",version.id,version.step).run();
  return (await historyVersion(version.id,version.site_id))!;
}
export async function activateHistory(version:Version) {
  const preview=publicPreview(version);if(!preview.canActivate)throw new Error("Finish the preview and resolve conflicting readings before activating this history.");
  const db=getDatabaseBinding(),headId=`${version.site_id}|${version.year}`;
  await db.prepare("INSERT INTO data_history_heads (id,site_id,year,revision_id) VALUES (?,?,?,'') ON CONFLICT(id) DO NOTHING").bind(headId,version.site_id,version.year).run();
  const guard="EXISTS (SELECT 1 FROM data_history_heads WHERE id = ? AND revision_id = ?)";
  await db.batch([
    db.prepare("UPDATE data_history_heads SET revision_id = ? WHERE id = ? AND revision_id = ?").bind(version.id,headId,version.parent_id),
    db.prepare(`UPDATE data_history_versions SET state = 'active' WHERE id = ? AND ${guard}`).bind(version.id,headId,version.id),
    db.prepare(`UPDATE telemetry_imports SET status = 'imported' WHERE id = ? AND ${guard}`).bind(version.import_id,headId,version.id),
  ]);
  const head=await db.prepare("SELECT revision_id FROM data_history_heads WHERE id = ?").bind(headId).first<{revision_id:string}>();
  if(head?.revision_id!==version.id)throw new Error("Another upload changed this history. Prepare a new preview against the current version.");
  return {activated:true,revisionId:version.id};
}
