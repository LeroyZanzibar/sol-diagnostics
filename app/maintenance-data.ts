export const MAX_MAINTENANCE_ROWS = 5000;
export const MAX_MAINTENANCE_FILE_BYTES = 10 * 1024 * 1024;
export const SKIP_MAINTENANCE_SITE = '__skip__';
export type MaintenanceImportRow = {row: number; date: string; sourceSite: string; task: string; details: Record<string,string>};
export type MaintenanceEntry = MaintenanceImportRow & {id?: string; siteId: string};
export type MaintenanceSite = {id:string; name:string};
export type MaintenanceCalendar = {revision:string; fileName:string; fileSize:number; importedAt:string; rowCount:number; siteCount:number; mappings:Record<string,string>};
export type MaintenanceDay = {date:string; tasks:string[]};
export const maintenanceSiteKey = (value:string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' ');
const headerKey = (value:unknown) => String(value??'').trim().toLowerCase().replace(/[\s_\-]+/g,'');

export function validMaintenanceDate(value:unknown):value is string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const d=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;
}

/** Preserve calendar dates. No browser timezone or inferred outage times. */
export function maintenanceDate(value:unknown,date1904=false):string {
  if(typeof value==='number'){
    if(!Number.isFinite(value)||value<1||value>2958465||(!date1904&&Math.floor(value)===60))return '';
    const serial=Math.floor(value),epoch=Date.UTC(date1904?1904:1899,date1904?0:11,date1904?1:30);
    const adjusted=!date1904&&serial<60?serial+1:serial;
    const d=new Date(epoch+adjusted*86400000);
    const iso=Number.isFinite(d.getTime())?d.toISOString().slice(0,10):'';
    return validMaintenanceDate(iso)?iso:'';
  }
  const text=String(value??'').trim();
  if(validMaintenanceDate(text))return text;
  const match=/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if(!match)return '';
  const year=match[3].length===2?`20${match[3]}`:match[3];
  const iso=`${year}-${match[1].padStart(2,'0')}-${match[2].padStart(2,'0')}`;
  return validMaintenanceDate(iso)?iso:'';
}

export function maintenanceHeader(table:unknown[][]){
  return table.slice(0,30).findIndex(row=>['date','site','task'].every(key=>row.some(cell=>headerKey(cell)===key)));
}

export function parseMaintenanceSheet(table:unknown[][],date1904=false){
  const header=maintenanceHeader(table);
  if(header<0)throw Error('The file needs Date, Site, and Task column headers.');
  const names=table[header].map(value=>String(value??'').trim()),keys=names.map(headerKey);
  for(const required of ['date','site','task'])if(keys.filter(k=>k===required).length!==1)throw Error(`Use one ${required} column.`);
  const dateIndex=keys.indexOf('date'),siteIndex=keys.indexOf('site'),taskIndex=keys.indexOf('task');
  const optional=['Type','WO#','Assigned to','Materials Needed'];
  const rows:MaintenanceImportRow[]=[],errors:string[]=[];
  let invalidCount=0,total=0;
  table.slice(header+1).forEach((cells,index)=>{
    if(cells.every(v=>v===null||v===undefined||String(v).trim()===''))return;
    if(++total>MAX_MAINTENANCE_ROWS)throw Error(`Use at most ${MAX_MAINTENANCE_ROWS.toLocaleString()} maintenance rows per file.`);
    const row=index+header+2,date=maintenanceDate(cells[dateIndex],date1904),sourceSite=String(cells[siteIndex]??'').trim(),task=String(cells[taskIndex]??'').trim();
    const details:Record<string,string>={};
    for(const name of optional){const column=keys.indexOf(headerKey(name));if(column>=0){const text=String(cells[column]??'').trim();if(text)details[name]=text;}}
    const problems=[!date?'Date must be a valid YYYY-MM-DD or US MM/DD/YYYY date':'',!sourceSite?'Site is missing':'',!task?'Task is missing':'',sourceSite.length>200?'Site exceeds 200 characters':'',task.length>2000?'Task exceeds 2,000 characters':'',Object.values(details).some(v=>v.length>2000)?'An optional field exceeds 2,000 characters':''].filter(Boolean);
    if(problems.length){invalidCount++;if(errors.length<30)errors.push(`Row ${row}: ${problems.join('; ')}.`);return;}
    rows.push({row,date,sourceSite,task,details});
  });
  if(!total)throw Error('The calendar has no maintenance rows.');
  return {rows,errors,invalidCount,total};
}

export function suggestedMaintenanceMappings(rows:MaintenanceImportRow[],sites:MaintenanceSite[],previous:Record<string,string>={}){
  const mappings:Record<string,string>=Object.create(null);
  for(const row of rows){
    const source=row.sourceSite;if(Object.hasOwn(mappings,source))continue;
    const saved=previous[source];
    const matches=sites.filter(s=>maintenanceSiteKey(s.name)===maintenanceSiteKey(source)||s.id===source);
    mappings[source]=saved===SKIP_MAINTENANCE_SITE||sites.some(s=>s.id===saved)?saved:matches.length===1?matches[0].id:'';
  }
  return mappings;
}

export function mappedMaintenanceRows(rows:MaintenanceImportRow[],mappings:Record<string,string>,sites:MaintenanceSite[]){
  const ids=new Set(sites.map(s=>s.id)),seen=new Set<string>(),entries:MaintenanceEntry[]=[],unmatched=new Set<string>();
  let skipped=0,duplicates=0;
  for(const row of rows){
    const siteId=mappings[row.sourceSite];
    if(siteId===SKIP_MAINTENANCE_SITE){skipped++;continue;}
    if(!siteId||!ids.has(siteId)){unmatched.add(row.sourceSite);continue;}
    const key=JSON.stringify([siteId,row.date,row.task,Object.entries(row.details).sort(([a],[b])=>a.localeCompare(b))]);
    if(seen.has(key)){duplicates++;continue;}seen.add(key);entries.push({...row,siteId});
  }
  return {entries,skipped,duplicates,unmatched:[...unmatched]};
}

export function maintenanceDays(entries:Pick<MaintenanceEntry,'date'|'task'>[],range:{from:string;through:string}){
  const days=new Map<string,MaintenanceDay>();
  for(const entry of entries){
    if((range.from&&entry.date<range.from)||(range.through&&entry.date>range.through))continue;
    const day=days.get(entry.date)||{date:entry.date,tasks:[]};day.tasks.push(entry.task);days.set(entry.date,day);
  }
  return [...days.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
