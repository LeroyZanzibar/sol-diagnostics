import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../db";
import { getDatabaseBinding } from "../../../db/binding";
import { equipmentAssets, siteSettings } from "../../../db/schema";
import type { EquipmentAsset, EquipmentType } from "../../equipment";
import { arrayCapacityModel, hierarchyError } from "../../array-capacity";

const validTypes = new Set<EquipmentType>(["revenue_meter","transformer","inverter","module_group","weather_sensor"]);

function uniqueEquipmentIds(items:EquipmentAsset[]) {
  const normalized=(value:string)=>value.trim().toLowerCase();
  const groups=new Map<string,EquipmentAsset[]>();
  items.forEach(item=>{const key=normalized(item.externalId);groups.set(key,[...(groups.get(key)||[]),item])});
  const keepers=new Map<string,string>();
  groups.forEach((group,key)=>keepers.set(key,(group.find(item=>item.type==="revenue_meter")||group[0]).id));
  const reserved=new Set(items.map(item=>normalized(item.externalId)));
  const adjustments:Array<{id:string;name:string;from:string;to:string}>=[];
  const equipment=items.map(item=>{
    const from=item.externalId.trim();const key=normalized(from);const group=groups.get(key)||[];
    if(group.length<2||keepers.get(key)===item.id)return {...item,externalId:from};
    let index=2,to=`${from}-${index}`;while(reserved.has(normalized(to))){index+=1;to=`${from}-${index}`}
    reserved.add(normalized(to));adjustments.push({id:item.id,name:item.name,from,to});return {...item,externalId:to};
  });
  return {equipment,adjustments};
}

function remapCrossSiteNodeIds(items:EquipmentAsset[], occupiedIds:Set<string>) {
  const reserved=new Set([...occupiedIds,...items.map(item=>item.id)]);
  const replacements=new Map<string,string>();
  const createId=()=>{
    let id="";
    do { id=globalThis.crypto?.randomUUID?.() ?? `equipment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,12)}`; } while(reserved.has(id));
    reserved.add(id);return id;
  };
  items.forEach(item=>{if(occupiedIds.has(item.id))replacements.set(item.id,createId())});
  return {
    equipment:items.map(item=>({...item,id:replacements.get(item.id)||item.id,parentId:item.parentId?(replacements.get(item.parentId)||item.parentId):null})),
    adjustments:items.filter(item=>replacements.has(item.id)).map(item=>({name:item.name,from:item.id,to:replacements.get(item.id)!})),
  };
}

async function findEquipmentIdOwners(ids:string[]) {
  const records:Array<{id:string;siteId:string}>=[];
  for(let offset=0;offset<ids.length;offset+=50) {
    records.push(...await getDb().select({id:equipmentAssets.id,siteId:equipmentAssets.siteId}).from(equipmentAssets).where(inArray(equipmentAssets.id,ids.slice(offset,offset+50))));
  }
  return records;
}

async function ensureEquipmentTable() {
  await getDatabaseBinding().prepare(`CREATE TABLE IF NOT EXISTS equipment_assets (
    id text PRIMARY KEY NOT NULL, site_id text NOT NULL, parent_id text, type text NOT NULL,
    name text NOT NULL, external_id text NOT NULL, manufacturer text DEFAULT '' NOT NULL,
    model text DEFAULT '' NOT NULL, capacity_kw text DEFAULT '' NOT NULL,
    ac_rated_capacity_kw text DEFAULT '' NOT NULL, max_dc_capacity_kw text DEFAULT '' NOT NULL,
    module_rated_capacity_w text DEFAULT '' NOT NULL, ac_line_loss_percent text DEFAULT '' NOT NULL,
    transformer_loss_percent text DEFAULT '' NOT NULL, quantity integer DEFAULT 1 NOT NULL,
    aliases text DEFAULT '[]' NOT NULL, channels text DEFAULT '[]' NOT NULL,
    position integer DEFAULT 0 NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`).run();
  for (const statement of [
    "ALTER TABLE equipment_assets ADD COLUMN ac_rated_capacity_kw text DEFAULT '' NOT NULL",
    "ALTER TABLE equipment_assets ADD COLUMN max_dc_capacity_kw text DEFAULT '' NOT NULL",
    "ALTER TABLE equipment_assets ADD COLUMN module_rated_capacity_w text DEFAULT '' NOT NULL",
    "ALTER TABLE equipment_assets ADD COLUMN ac_line_loss_percent text DEFAULT '' NOT NULL",
    "ALTER TABLE equipment_assets ADD COLUMN transformer_loss_percent text DEFAULT '' NOT NULL",
  ]) await getDatabaseBinding().prepare(statement).run().catch(()=>undefined);
}

function decode(record: typeof equipmentAssets.$inferSelect): EquipmentAsset {
  const parse = (value: string) => { try { const result = JSON.parse(value); return Array.isArray(result) ? result.map(String) : []; } catch { return []; } };
  const legacyModuleWatts = record.type === "module_group" && Number(record.capacityKw) > 0 && record.quantity > 0
    ? String((Number(record.capacityKw) * 1000) / record.quantity)
    : "";
  return { ...record, type:record.type as EquipmentType, acRatedCapacityKw:record.acRatedCapacityKw || (record.type==="inverter"?record.capacityKw:""), maxDcCapacityKw:record.maxDcCapacityKw, moduleRatedCapacityW:record.moduleRatedCapacityW || legacyModuleWatts, acLineLossPercent:record.acLineLossPercent, transformerLossPercent:record.transformerLossPercent, aliases:parse(record.aliases), channels:parse(record.channels) };
}

export async function GET(request: Request) {
  try {
    const siteId = new URL(request.url).searchParams.get("siteId")?.trim();
    if (!siteId) return Response.json({ error:"A site is required." }, { status:400 });
    const [site]=await getDb().select({id:siteSettings.id,verified:siteSettings.arrayModelVerified}).from(siteSettings).where(eq(siteSettings.id,siteId)).limit(1);
    if (!site) return Response.json({ error:"This site is not available." }, { status:404 });
    await ensureEquipmentTable();
    const records = await getDb().select().from(equipmentAssets).where(eq(equipmentAssets.siteId,siteId)).orderBy(asc(equipmentAssets.position));
    return Response.json({ equipment:records.map(decode), verified:Boolean(site.verified) });
  } catch (error) { return Response.json({ error:error instanceof Error?error.message:"Unable to load equipment." }, { status:500 }); }
}

export async function PUT(request: Request) {
  try {
    const payload = await request.json() as { siteId?:string; equipment?:EquipmentAsset[]; verified?:boolean };
    const siteId = payload.siteId?.trim();
    const incomingItems = Array.isArray(payload.equipment) ? payload.equipment : [];
    if (!siteId) return Response.json({ error:"A site is required." }, { status:400 });
    const [site]=await getDb().select({id:siteSettings.id}).from(siteSettings).where(eq(siteSettings.id,siteId)).limit(1);
    if (!site) return Response.json({ error:"This site is not available." }, { status:404 });
    await ensureEquipmentTable();
    if (incomingItems.length > 500) return Response.json({ error:"A site may contain up to 500 configuration nodes." }, { status:400 });
    const ids = new Set(incomingItems.map(item=>item.id));
    if (ids.size !== incomingItems.length) return Response.json({ error:"Every equipment node needs a unique ID." }, { status:400 });
    if (incomingItems.filter(item=>item.type==="revenue_meter").length > 1) return Response.json({ error:"Only one revenue meter can sit at the top of this hierarchy." }, { status:400 });
    for (const item of incomingItems) {
      if (!item.id || !item.name?.trim() || !item.externalId?.trim() || !validTypes.has(item.type)) return Response.json({ error:"Each node needs a name, equipment ID, and valid type." }, { status:400 });
      if (item.parentId && !ids.has(item.parentId)) return Response.json({ error:`${item.name} has an invalid parent.` }, { status:400 });
      if ([item.acRatedCapacityKw,item.maxDcCapacityKw,item.moduleRatedCapacityW].some(value=>value && (!Number.isFinite(Number(value)) || Number(value)<0))) return Response.json({ error:`${item.name} has an invalid capacity value.` }, { status:400 });
      if ([item.acLineLossPercent,item.transformerLossPercent].some(value=>value && (!Number.isFinite(Number(value)) || Number(value)<0 || Number(value)>100))) return Response.json({ error:`${item.name} has an invalid loss percentage.` }, { status:400 });
      if (item.type==="transformer" && [item.nameplateKva,item.pvCeilingOverrideKw].some(value=>value!==undefined&&value!==""&&(!Number.isFinite(Number(value))||Number(value)<=0))) return Response.json({error:`${item.name}: transformer ratings and manual ceilings must be greater than zero.`},{status:400});
      if (item.pvCeilingOverrideEnabled!==undefined&&typeof item.pvCeilingOverrideEnabled!=="boolean") return Response.json({error:"The transformer override must be enabled or disabled."},{status:400});
    }
    const invalidHierarchy=hierarchyError(incomingItems);
    if(invalidHierarchy)return Response.json({error:invalidHierarchy},{status:400});
    const verified=Boolean(payload.verified)&&arrayCapacityModel(incomingItems).complete;
    const {equipment:uniqueItems,adjustments}=uniqueEquipmentIds(incomingItems);
    const collidingRecords = await findEquipmentIdOwners(uniqueItems.map(item=>item.id));
    const occupiedIds=new Set(collidingRecords.filter(record=>record.siteId!==siteId).map(record=>record.id));
    const {equipment:items,adjustments:nodeIdAdjustments}=remapCrossSiteNodeIds(uniqueItems,occupiedIds);
    const d1 = getDatabaseBinding();
    const now = new Date().toISOString();
    const statements = [d1.prepare("UPDATE site_settings SET array_model_verified = ?, updated_at = ? WHERE id = ?").bind(verified?1:0,now,siteId), d1.prepare("DELETE FROM equipment_assets WHERE site_id = ?").bind(siteId), ...items.map((item,index)=>d1.prepare(`INSERT INTO equipment_assets (id, site_id, parent_id, type, name, external_id, manufacturer, model, capacity_kw, ac_rated_capacity_kw, max_dc_capacity_kw, module_rated_capacity_w, ac_line_loss_percent, transformer_loss_percent, quantity, aliases, channels, position, updated_at, nameplate_kva, pv_ceiling_override_enabled, pv_ceiling_override_kw, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(item.id,siteId,item.parentId||null,item.type,item.name.trim(),item.externalId.trim(),item.manufacturer?.trim()||"",item.model?.trim()||"",item.capacityKw?.trim()||"",item.acRatedCapacityKw?.trim()||"",item.maxDcCapacityKw?.trim()||"",item.moduleRatedCapacityW?.trim()||"",item.acLineLossPercent?.trim()||"",item.transformerLossPercent?.trim()||"",Math.max(1,Number(item.quantity)||1),JSON.stringify(item.aliases||[]),JSON.stringify(item.channels||[]),Number(item.position)||index,now,String(item.nameplateKva||"").trim(),item.pvCeilingOverrideEnabled===true?1:0,String(item.pvCeilingOverrideKw||"").trim(),item.notes?.trim()||""))];
    await d1.batch(statements);
    const records = await getDb().select().from(equipmentAssets).where(eq(equipmentAssets.siteId,siteId)).orderBy(asc(equipmentAssets.position));
    return Response.json({ equipment:records.map(decode), verified, idAdjustments:adjustments, nodeIdAdjustments });
  } catch (error) { return Response.json({ error:error instanceof Error?error.message:"Unable to save equipment." }, { status:500 }); }
}
