import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import * as XLSX from 'xlsx';
import {loadSource} from './source-module.mjs';
const calendar=loadSource('app/maintenance-data.ts');
const file=loadSource('app/maintenance-file.ts',[],{XLSX,...calendar});
const time=loadSource('app/telemetry-time.ts');
const periods=loadSource('app/issue-periods.ts',[],time);
const timeline=loadSource('app/TimelineMaintenance.tsx',['maintenanceDaySpan'],{...periods});
const sites=[{id:'depot',name:'Depot Solar Center'},{id:'clear',name:'Clear Solar I'}];
const row=(patch={})=>({row:2,date:'2026-05-06',sourceSite:'Depot Solar Center',task:'Repair transformer',details:{},...patch});
const payload=(patch={})=>({revision:crypto.randomUUID(),baseRevision:'',fileName:'calendar.csv',fileSize:50,rows:[row()],mappings:{'Depot Solar Center':'depot'},...patch});
function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  for(const name of readdirSync('drizzle').filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(`drizzle/${name}`,'utf8'));
  for(const site of sites)sqlite.prepare('INSERT INTO site_settings(id,name) VALUES (?,?)').run(site.id,site.name);
  const stmt=(sql,values=[])=>({bind(...args){return stmt(sql,args)},async first(){return sqlite.prepare(sql).get(...values)||null},async all(){return {results:sqlite.prepare(sql).all(...values)}},async run(){return {meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}}}});
  const db={prepare:stmt,async batch(statements){sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const service=loadSource('app/api/maintenance-data/service.ts',[],{...calendar,getDatabaseBinding:()=>db});
  const route=loadSource('app/api/maintenance-data/route.ts',[],{...calendar,...service,getDatabaseBinding:()=>db});
  return {db,sqlite,service,route};
}
test('calendar dates are stable across timezone changes and reject rollover dates',()=>{
  assert.equal(calendar.maintenanceDate(46026),'2026-01-04');
  assert.equal(calendar.maintenanceDate('01/04/26'),'2026-01-04');
  assert.equal(calendar.maintenanceDate('5/6/2026'),'2026-05-06');
  assert.equal(calendar.maintenanceDate('2026-11-01'),'2026-11-01');
  assert.equal(calendar.maintenanceDate(1,true),'1904-01-02');
  for(const value of ['2/30/2026','2026-02-29','2026-13-01','2026-05-06T23:00:00Z',60,NaN])assert.equal(calendar.maintenanceDate(value),'');
});
test('CSV quoted commas and multiline Task fields survive unchanged',async()=>{
  const source='\ufeffDate,Site,Task,WO#\r\n05/06/2026,Depot Solar Center,"Inspect connectors, wiring\nand fuses",2576\r\n';
  const parsed=await file.readMaintenanceFile(new File([source],'calendar.csv'));
  assert.equal(parsed.invalidCount,0);assert.equal(parsed.rows.length,1);assert.equal(parsed.rows[0].date,'2026-05-06');assert.equal(parsed.rows[0].task,'Inspect connectors, wiring\nand fuses');assert.equal(parsed.rows[0].details['WO#'],'2576');
});
test('Excel calendar sheet is selected instead of the unrelated Comments sheet',async()=>{
  const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Row','Comment'],[2,'Unrelated']]),'Comments');
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Date','Site','Task','Type'],[46026,'Depot Solar Center','Site reenergization','OSI']]),'Delivery Calendar');
  const result=await file.readMaintenanceFile(new File([XLSX.write(book,{type:'buffer',bookType:'xlsx'})],'calendar.xlsx'));
  assert.equal(result.sheetName,'Delivery Calendar');assert.equal(result.rows[0].date,'2026-01-04');assert.equal(result.rows[0].details.Type,'OSI');
});
test('invalid rows are reported and empty rows ignored without silently accepting incomplete dates',()=>{
  const parsed=calendar.parseMaintenanceSheet([['Date','Site','Task'],['2026-05-06','Depot Solar Center','A'],['','',''],['2/30/26','Depot Solar Center','B'],['2026-05-07','','C']]);
  assert.equal(parsed.total,3);assert.equal(parsed.rows.length,1);assert.equal(parsed.invalidCount,2);assert.match(parsed.errors.join(' '),/Row 4.*Row 5/);
});
test('site matching retains digits and requires explicit handling of nonmatching names',()=>{
  const rows=[row({sourceSite:' depot solar center '}),row({sourceSite:'233 Randolph 74 Solar I'})];
  const options=[...sites,{id:'randolph',name:'233 Randolph 75 Solar I'}];
  const mappings=calendar.suggestedMaintenanceMappings(rows,options);
  assert.equal(mappings[' depot solar center '],'depot');assert.equal(mappings['233 Randolph 74 Solar I'],'');
  assert.equal(calendar.mappedMaintenanceRows(rows,mappings,options).unmatched.length,1);
  mappings['233 Randolph 74 Solar I']=calendar.SKIP_MAINTENANCE_SITE;
  assert.equal(calendar.mappedMaintenanceRows(rows,mappings,options).skipped,1);
});
test('deduplication preserves different work orders and multiple distinct tasks on a date',()=>{
  const rows=[row(),row({row:3}),row({row:4,details:{'WO#':'2'}}),row({row:5,task:'Inspect fuses'})];
  const result=calendar.mappedMaintenanceRows(rows,{'Depot Solar Center':'depot'},sites);
  assert.equal(result.duplicates,1);assert.equal(result.entries.length,3);assert.equal(calendar.maintenanceDays(result.entries,{from:'2026-05-06',through:'2026-05-06'})[0].tasks.length,3);
  assert.equal(calendar.maintenanceDays(result.entries,{from:'2026-05-07',through:''}).length,0);
});
test('date markers use actual local day boundaries through both DST transitions',()=>{
  const spring=timeline.maintenanceDaySpan('2026-03-08','America/New_York'),fall=timeline.maintenanceDaySpan('2026-11-01','America/New_York');
  assert.equal((spring.end-spring.start)/3600000,23);assert.equal((fall.end-fall.start)/3600000,25);
  assert.equal(new Date(spring.start).toISOString(),'2026-03-08T05:00:00.000Z');
});
test('calendar replacement is global and never modifies manual windows or issue losses',async()=>{
  const f=fixture(),first=payload({rows:[row(),row({sourceSite:'Clear Solar I',task:'Check fuses'})],mappings:{'Depot Solar Center':'depot','Clear Solar I':'clear'}});
  f.sqlite.exec("INSERT INTO maintenance_windows VALUES ('manual','depot',1,'2026-05-06','2026-05-07',0,'{}','now')");
  const a=await f.service.saveMaintenanceCalendar(first);assert.equal(a.calendar.rowCount,2);
  const b=await f.service.saveMaintenanceCalendar(payload({baseRevision:a.calendar.revision,rows:[row({date:'2026-06-01'})]}));
  assert.equal(b.calendar.rowCount,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM maintenance_calendar_entries').get().n,1);assert.equal(f.sqlite.prepare('SELECT date FROM maintenance_calendar_entries').get().date,'2026-06-01');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM maintenance_windows').get().n,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM analysis_jobs').get().n,0);
});
test('a lost save acknowledgement can be retried without creating duplicates',async()=>{
  const f=fixture(),p=payload();const first=await f.service.saveMaintenanceCalendar(p),retry=await f.service.saveMaintenanceCalendar(p);
  assert.equal(first.calendar.revision,retry.calendar.revision);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM maintenance_calendar_entries').get().n,1);
  await assert.rejects(f.service.saveMaintenanceCalendar({...p,rows:[row({task:'Changed task'})]}),/different content/);
});
test('stale and concurrent replacements cannot erase the winning calendar',async()=>{
  const f=fixture(),first=await f.service.saveMaintenanceCalendar(payload());
  await assert.rejects(f.service.saveMaintenanceCalendar(payload()),/calendar changed/);
  const batch=f.db.batch;
  f.db.batch=async statements=>{f.sqlite.prepare("UPDATE maintenance_calendar_state SET revision='winning-revision-1234'").run();return batch(statements);};
  await assert.rejects(f.service.saveMaintenanceCalendar(payload({baseRevision:first.calendar.revision,rows:[row({task:'Losing edit'})]})),/Another upload/);
  assert.equal(f.sqlite.prepare('SELECT task FROM maintenance_calendar_entries').get().task,'Repair transformer');
});
test('database failure rolls back both metadata and all entry changes',async()=>{
  const f=fixture(),first=await f.service.saveMaintenanceCalendar(payload());
  f.sqlite.exec("CREATE TRIGGER failed_insert BEFORE INSERT ON maintenance_calendar_entries BEGIN SELECT RAISE(ABORT,'database unavailable'); END");
  await assert.rejects(f.service.saveMaintenanceCalendar(payload({baseRevision:first.calendar.revision,rows:[row({task:'Replacement'})]})),/unavailable/);
  assert.equal((await f.service.maintenanceCalendarState()).revision,first.calendar.revision);assert.equal(f.sqlite.prepare('SELECT task FROM maintenance_calendar_entries').get().task,'Repair transformer');
});
test('server validates dates, site mappings, and tasks before changing stored data',async()=>{
  const f=fixture();for(const change of [{rows:[row({date:'2026-02-30'})]},{mappings:{'Depot Solar Center':'missing-site'}},{rows:[row({task:''})]},{rows:[]},{mappings:{'Depot Solar Center':calendar.SKIP_MAINTENANCE_SITE}}])await assert.rejects(f.service.saveMaintenanceCalendar(payload(change)));
  assert.equal(await f.service.maintenanceCalendarState(),null);
});
test('timeline reads are isolated by site and reporting dates, including a maintenance-only site',async()=>{
  const f=fixture();await f.service.saveMaintenanceCalendar(payload({rows:[row(),row({date:'2026-05-07'}),row({sourceSite:'Clear Solar I'})],mappings:{'Depot Solar Center':'depot','Clear Solar I':'clear'}}));
  const response=await f.route.GET(new Request('https://example.test/api/maintenance-data?siteId=depot&from=2026-05-06&through=2026-05-06'));const data=await response.json();
  assert.equal(response.status,200);assert.equal(data.entries.length,1);assert.equal(data.entries[0].siteId,'depot');assert.equal(data.entries[0].date,'2026-05-06');
  const only=await(await f.route.GET(new Request('https://example.test/api/maintenance-data?siteId=clear'))).json();assert.equal(only.entries.length,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM performance_issues').get().n,0);
});
test('large calendars use bounded statements and retain all rows',async()=>{
  const f=fixture(),rows=Array.from({length:1200},(_,i)=>row({row:i+2,task:`Task ${i}`}));const result=await f.service.saveMaintenanceCalendar(payload({rows}));assert.equal(result.calendar.rowCount,1200);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM maintenance_calendar_entries').get().n,1200);
});
