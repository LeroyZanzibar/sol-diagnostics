import {getDatabaseBinding} from '../../../db/binding';
import {validMaintenanceDate,mappedMaintenanceRows,MAX_MAINTENANCE_ROWS,MAX_MAINTENANCE_FILE_BYTES,type MaintenanceImportRow,type MaintenanceCalendar,type MaintenanceSite} from '../../maintenance-data';

export class MaintenanceConflict extends Error {}
type StateRow={revision:string;file_name:string;file_size:number;imported_at:string;row_count:number;site_count:number;mappings:string;content_hash:string};
export async function maintenanceCalendarState(){
  return getDatabaseBinding().prepare("SELECT * FROM maintenance_calendar_state WHERE id='current'").first<StateRow>();
}
export function calendarMetadata(row:StateRow|null):MaintenanceCalendar|null{
  return row?{revision:row.revision,fileName:row.file_name,fileSize:row.file_size,importedAt:row.imported_at,rowCount:row.row_count,siteCount:row.site_count,mappings:JSON.parse(row.mappings)}:null;
}
export async function saveMaintenanceCalendar(payload:any){
  const db=getDatabaseBinding();
  if(!payload||typeof payload.revision!=='string'||! /^[\w-]{16,100}$/.test(payload.revision)||typeof payload.baseRevision!=='string')throw Error('Invalid upload revision. Reload the current calendar and try again.');
  if(typeof payload.fileName!=='string'||!payload.fileName.trim()||payload.fileName.length>255||!Number.isInteger(payload.fileSize)||payload.fileSize<1||payload.fileSize>MAX_MAINTENANCE_FILE_BYTES)throw Error('Choose a valid maintenance file smaller than 10 MB.');
  if(!Array.isArray(payload.rows)||!payload.rows.length||payload.rows.length>MAX_MAINTENANCE_ROWS)throw Error('Upload between 1 and 5,000 maintenance rows.');
  const rows:MaintenanceImportRow[]=payload.rows.map((r:any)=>{
    if(!r||!Number.isInteger(r.row)||r.row<1||!validMaintenanceDate(r.date)||typeof r.sourceSite!=='string'||!r.sourceSite.trim()||r.sourceSite.length>200||typeof r.task!=='string'||!r.task.trim()||r.task.length>2000)throw Error(`Invalid date, site or task at row ${r?.row??'unknown'}.`);
    const details:Record<string,string>={};
    for(const key of ['Type','WO#','Assigned to','Materials Needed']){const value=r.details?.[key];if(value===undefined)continue;if(typeof value!=='string'||value.length>2000)throw Error(`Invalid ${key} at row ${r.row}.`);if(value.trim())details[key]=value.trim();}
    return {row:r.row,date:r.date,sourceSite:r.sourceSite.trim(),task:r.task.trim(),details};
  });
  if(!payload.mappings||typeof payload.mappings!=='object'||Array.isArray(payload.mappings))throw Error('Match the calendar site names before importing.');
  const mappings:Record<string,string>=Object.fromEntries([...new Set(rows.map(r=>r.sourceSite))].map(name=>{const id=payload.mappings[name];if(typeof id!=='string'||id.length>100)throw Error('Match every calendar site or explicitly skip it.');return [name,id];}));
  const sites=(await db.prepare('SELECT id,name FROM site_settings').all()).results as MaintenanceSite[];
  const resolved=mappedMaintenanceRows(rows,mappings,sites);
  if(resolved.unmatched.length)throw Error(`Match or skip these sites: ${resolved.unmatched.join(', ')}.`);
  if(!resolved.entries.length)throw Error('No maintenance rows remain after site matching.');
  const content=JSON.stringify([payload.fileName.trim(),payload.fileSize,mappings,resolved.entries]);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(content)))].map(v=>v.toString(16).padStart(2,'0')).join('');
  const existing=await maintenanceCalendarState();
  if(existing?.revision===payload.revision){if(existing.content_hash!==hash)throw Error('This upload revision has different content. Choose the file again.');return {calendar:calendarMetadata(existing),skipped:resolved.skipped,duplicates:resolved.duplicates};}
  if((existing?.revision||'')!==payload.baseRevision)throw new MaintenanceConflict('The calendar changed while you were preparing this upload. Reload it before replacing it.');
  const now=new Date().toISOString(),siteCount=new Set(resolved.entries.map(r=>r.siteId)).size;
  const statements=[db.prepare(`INSERT INTO maintenance_calendar_state(id,revision,file_name,file_size,imported_at,row_count,site_count,mappings,content_hash)
    SELECT 'current',?,?,?,?,?,?,?,? WHERE ?='' OR EXISTS(SELECT 1 FROM maintenance_calendar_state WHERE id='current' AND revision=?)
    ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,file_name=excluded.file_name,file_size=excluded.file_size,imported_at=excluded.imported_at,row_count=excluded.row_count,site_count=excluded.site_count,mappings=excluded.mappings,content_hash=excluded.content_hash WHERE maintenance_calendar_state.revision=?`)
    .bind(payload.revision,payload.fileName.trim(),payload.fileSize,now,resolved.entries.length,siteCount,JSON.stringify(mappings),hash,payload.baseRevision,payload.baseRevision,payload.baseRevision),
    db.prepare("DELETE FROM maintenance_calendar_entries WHERE EXISTS(SELECT 1 FROM maintenance_calendar_state WHERE id='current' AND revision=?)").bind(payload.revision)];
  for(let offset=0;offset<resolved.entries.length;offset+=100){
    const chunk=resolved.entries.slice(offset,offset+100).map((r,i)=>({...r,id:`${payload.revision}-${offset+i}`}));
    statements.push(db.prepare(`INSERT INTO maintenance_calendar_entries(id,site_id,date,task,source_site,source_row,details)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.siteId'),json_extract(value,'$.date'),json_extract(value,'$.task'),json_extract(value,'$.sourceSite'),json_extract(value,'$.row'),json_extract(value,'$.details')
      FROM json_each(?) WHERE EXISTS(SELECT 1 FROM maintenance_calendar_state WHERE id='current' AND revision=?)`).bind(JSON.stringify(chunk),payload.revision));
  }
  // D1 batch is one transaction: a failed upload never publishes a partial calendar.
  await db.batch(statements);
  const saved=await maintenanceCalendarState();
  if(saved?.revision!==payload.revision)throw new MaintenanceConflict('Another upload replaced this calendar. Reload the current calendar before continuing.');
  return {calendar:calendarMetadata(saved),skipped:resolved.skipped,duplicates:resolved.duplicates};
}
