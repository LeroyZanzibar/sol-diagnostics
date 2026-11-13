import {getDatabaseBinding} from '../../../db/binding';
import {validMaintenanceDate} from '../../maintenance-data';
import {calendarMetadata,maintenanceCalendarState,saveMaintenanceCalendar,MaintenanceConflict} from './service';
const headers={'Cache-Control':'private, no-store'};

export async function GET(request:Request){try{
  const q=new URL(request.url).searchParams,siteId=q.get('siteId'),from=q.get('from')||'',through=q.get('through')||'',db=getDatabaseBinding();
  if((from&&!validMaintenanceDate(from))||(through&&!validMaintenanceDate(through))||(from&&through&&from>through))throw Error('Choose a valid reporting period.');
  const state=await maintenanceCalendarState();
  if(siteId){
    if(!await db.prepare('SELECT id FROM site_settings WHERE id=?').bind(siteId).first())throw Error('Choose an available site.');
    const result=await db.prepare(`SELECT id,site_id AS siteId,date,task,source_site AS sourceSite,source_row AS row,details FROM maintenance_calendar_entries WHERE site_id=? AND date>=? AND date<=? ORDER BY date,source_row`).bind(siteId,from||'0000-01-01',through||'9999-12-31').all();
    const zone=await db.prepare('SELECT timezone FROM telemetry_imports WHERE site_id=? ORDER BY created_at DESC LIMIT 1').bind(siteId).first<{timezone:string}>();
    return Response.json({calendar:calendarMetadata(state),entries:result.results.map((r:any)=>({...r,details:JSON.parse(r.details)})),timezone:zone?.timezone||''},{headers});
  }
  const result=await db.prepare(`SELECT e.site_id AS siteId,s.name,COUNT(*) AS rowCount,MIN(e.date) AS firstDate,MAX(e.date) AS lastDate FROM maintenance_calendar_entries e LEFT JOIN site_settings s ON s.id=e.site_id GROUP BY e.site_id ORDER BY s.name`).all();
  return Response.json({calendar:calendarMetadata(state),sites:result.results},{headers});
}catch(error){return Response.json({error:error instanceof Error?error.message:'Unable to load maintenance data.'},{status:400,headers});}}

export async function POST(request:Request){try{
  if(Number(request.headers.get('Content-Length'))>8*1024*1024)throw Error('The maintenance upload exceeds 8 MB of calendar data.');
  const text=await request.text();if(new TextEncoder().encode(text).length>8*1024*1024)throw Error('The maintenance upload exceeds 8 MB of calendar data.');
  return Response.json(await saveMaintenanceCalendar(JSON.parse(text)),{headers});
}catch(error){return Response.json({error:error instanceof Error?error.message:'Unable to import maintenance data.'},{status:error instanceof MaintenanceConflict?409:400,headers});}}
