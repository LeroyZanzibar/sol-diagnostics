import {localMoment,hasTimeZone,calendarDayMoment} from './issue-periods';
import {localTimestamp} from './telemetry-time';

export function formatAxis(value:number,timezone:string){
 return new Intl.DateTimeFormat('en',{month:'short',year:'numeric',timeZone:timezone}).format(new Date(value));
}
export function firstOfMonth(value:number,timezone:string){
 const wall=localTimestamp(new Date(value).toISOString(),timezone);
 return calendarDayMoment(`${wall.slice(0,7)}-01`,timezone);
}
export function nextMonth(value:number,timezone:string){
 const wall=localTimestamp(new Date(value).toISOString(),timezone);
 const next=new Date(Date.UTC(Number(wall.slice(0,4)),Number(wall.slice(5,7)),1)).toISOString().slice(0,19);
 return calendarDayMoment(next.slice(0,10),timezone);
}

/** Site-local midnights, not fixed 24-hour steps (DST days may differ in length). */
export function reviewMonthDays(start:number,timezone:string){
 const wall=localTimestamp(new Date(start).toISOString(),timezone),year=Number(wall.slice(0,4)),month=Number(wall.slice(5,7));
 const count=new Date(Date.UTC(year,month,0)).getUTCDate();
 return Array.from({length:count},(_,index)=>({day:index+1,time:calendarDayMoment(`${wall.slice(0,7)}-${String(index+1).padStart(2,'0')}`,timezone)}));
}

/** Each review card has only its active months, with room for separate same-row bars. */
export function reviewTimelineScale(issues:{startDateTime:string;endDateTime:string;timezone?:string;rowId?:string}[]){
 const valid=issues.filter(i=>Number.isFinite(localMoment(i.startDateTime))&&localMoment(i.endDateTime)>localMoment(i.startDateTime));
 if(!valid.length)return null;
 const timezone=hasTimeZone(valid[0].startDateTime)?valid[0].timezone||'UTC':'UTC';
 const byMonth=new Map<number,{start:number;end:number;rows:Map<string,Set<number>>}>();
 for(const issue of valid){
  const from=localMoment(issue.startDateTime),through=localMoment(issue.endDateTime);
  for(let start=firstOfMonth(from,timezone);start<through;start=nextMonth(start,timezone)){
   const month=byMonth.get(start)||{start,end:nextMonth(start,timezone),rows:new Map<string,Set<number>>()};
   const rowId=issue.rowId??'',starts=month.rows.get(rowId)||new Set<number>();
   starts.add(Math.max(from,start));month.rows.set(rowId,starts);byMonth.set(start,month);
  }
 }
 const months=[...byMonth.values()].sort((a,b)=>a.start-b.start).map(({start,end,rows})=>{
  let spacing=Infinity;
  for(const starts of rows.values()){
   const positions=[...starts].sort((a,b)=>a-b);
   for(let i=1;i<positions.length;i++)spacing=Math.min(spacing,positions[i]-positions[i-1]);
  }
  // A six-pixel minimum bar plus two pixels between starts. Increase horizontal
  // room only for close occurrences on the same row. Different groups already
  // have separate rows and must not force excessive horizontal expansion.
  const days=reviewMonthDays(start,timezone);
  return {start,end,days,minWidth:Math.max(days.length*32+24,Math.ceil(8*(end-start)/spacing)+24)};
 });
 // Keep elapsed-time widths comparable across the visible months.
 const pixelsPerMs=months.reduce((largest,month)=>Math.max(largest,(month.minWidth-24)/(month.end-month.start)),0);
 return {timezone,months:months.map(month=>({...month,minWidth:Math.ceil((month.end-month.start)*pixelsPerMs)+24}))};
}
