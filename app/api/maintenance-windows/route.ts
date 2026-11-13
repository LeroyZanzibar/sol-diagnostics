import {getDatabaseBinding} from '../../../db/binding';
import {expandMaintenanceEquipment,type MaintenanceState} from '../../review-groups';
import {activeHistory} from '../data-history/service';
import {isValidTimezone} from '../../telemetry-time';
const actor=(request:Request)=>request.headers.get('oai-authenticated-user-email')||request.headers.get('oai-authenticated-user-id')||'Site service / local preview';
async function context(siteId:string){
 const db=getDatabaseBinding();
 if(!siteId||!await db.prepare('SELECT id FROM site_settings WHERE id=?').bind(siteId).first())throw new Error('Choose an available site.');
 const equipment=await db.prepare('SELECT id,name,type,parent_id AS parentId FROM equipment_assets WHERE site_id=? ORDER BY position,name').bind(siteId).all();
 const latest=await db.prepare('SELECT timezone FROM telemetry_imports WHERE site_id=? ORDER BY created_at DESC LIMIT 1').bind(siteId).first<{timezone:string}>();
 const history=await activeHistory(siteId,2026),zone=history?.timezone||latest?.timezone;
 return {db,equipment:equipment.results as any[],timezone:zone&&isValidTimezone(zone)?zone:'UTC'};
}
export async function GET(request:Request){try{
 const q=new URL(request.url).searchParams,siteId=q.get('siteId')||'',{db,equipment,timezone}=await context(siteId);
 const rows=await db.prepare('SELECT id,version,state,updated_at FROM maintenance_windows WHERE site_id=? ORDER BY start_at DESC').bind(siteId).all();
 let audit:any[]=[];if(q.get('id')){const result=await db.prepare('SELECT version,state,actor,created_at FROM maintenance_window_changes WHERE site_id=? AND window_id=? ORDER BY version DESC LIMIT 30').bind(siteId,q.get('id')).all();audit=result.results;}
 return Response.json({windows:rows.results.map((r:any)=>({id:r.id,version:r.version,state:JSON.parse(r.state),updatedAt:r.updated_at})),equipment,timezone,audit,retrievedAt:new Date().toISOString()},{headers:{'Cache-Control':'private, no-store'}});
}catch(e){return Response.json({error:e instanceof Error?e.message:'Unable to load maintenance windows.'},{status:400});}}
export async function POST(request:Request){try{
 const p=await request.json(),{db,equipment,timezone}=await context(p.siteId),input=p.state;
 if(typeof p.id!=='string'||!/^[\w-]{16,100}$/.test(p.id)||!Number.isInteger(p.baseVersion)||p.baseVersion<0||typeof p.changeId!=='string'||!/^[\w-]{16,100}$/.test(p.changeId))throw new Error('Invalid window or revision.');
 const existing=await db.prepare('SELECT version,state FROM maintenance_windows WHERE id=? AND site_id=?').bind(p.id,p.siteId).first<{version:number;state:string}>();
 if(existing&&JSON.parse(existing.state).changeId===p.changeId)return Response.json({saved:true});
 if((existing?.version||0)!==p.baseVersion)throw new Error('This window changed. Reload it before saving.');
 if(!input||typeof input.title!=='string'||!input.title.trim()||input.title.length>160||typeof input.notes!=='string'||input.notes.length>10000||typeof input.wholeSite!=='boolean'||typeof input.archived!=='boolean')throw new Error('Enter a title and valid maintenance details.');
 if(!/^\d{4}-\d\d-\d\dT.*Z$/.test(input.startAt)||!/^\d{4}-\d\d-\d\dT.*Z$/.test(input.endAt)||!Number.isFinite(Date.parse(input.startAt))||!Number.isFinite(Date.parse(input.endAt))||Date.parse(input.endAt)<=Date.parse(input.startAt))throw new Error('The window end must be after its start.');
 const old:MaintenanceState|undefined=existing?JSON.parse(existing.state):undefined;
 const ids=input.wholeSite?[]:input.equipmentIds;
 if(!Array.isArray(ids))throw new Error('Choose equipment.');
 // Preserve the saved equipment snapshot when editing dates/notes, including removed assets.
 const sameScope=old&&old.wholeSite===input.wholeSite&&JSON.stringify([...old.equipmentIds].sort())===JSON.stringify([...ids].sort());
 const snapshot=input.wholeSite?[]:sameScope?old!.equipment:expandMaintenanceEquipment(ids,equipment);
 const state:MaintenanceState={title:input.title.trim(),notes:input.notes.trim(),startAt:new Date(input.startAt).toISOString(),endAt:new Date(input.endAt).toISOString(),timezone:old?.timezone||timezone,wholeSite:input.wholeSite,equipmentIds:ids,equipment:snapshot,archived:input.archived,changeId:p.changeId};
 const json=JSON.stringify(state),now=new Date().toISOString(),version=p.baseVersion+1;
 await db.batch([
  db.prepare(`INSERT INTO maintenance_windows (id,site_id,version,start_at,end_at,archived,state,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE ?=0 OR EXISTS (SELECT 1 FROM maintenance_windows WHERE id=? AND site_id=? AND version=?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,start_at=excluded.start_at,end_at=excluded.end_at,archived=excluded.archived,state=excluded.state,updated_at=excluded.updated_at WHERE maintenance_windows.site_id=? AND maintenance_windows.version=?`).bind(p.id,p.siteId,version,state.startAt,state.endAt,Number(state.archived),json,now,p.baseVersion,p.id,p.siteId,p.baseVersion,p.siteId,p.baseVersion),
  db.prepare(`INSERT INTO maintenance_window_changes (id,window_id,site_id,version,state,actor,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM maintenance_windows WHERE id=? AND site_id=? AND version=? AND state=?)`).bind(crypto.randomUUID(),p.id,p.siteId,version,json,actor(request),now,p.id,p.siteId,version,json),
 ]);
 const row=await db.prepare('SELECT state FROM maintenance_windows WHERE id=? AND site_id=?').bind(p.id,p.siteId).first<{state:string}>();
 if(!row||JSON.parse(row.state).changeId!==p.changeId)throw new Error('This window changed. Reload it before saving.');
 return Response.json({saved:true});
}catch(e){return Response.json({error:e instanceof Error?e.message:'Unable to save maintenance window.'},{status:409});}}
