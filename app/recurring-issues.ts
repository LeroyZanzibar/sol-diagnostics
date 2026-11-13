import {calendarDayMoment,hasTimeZone,localMoment,siteWallTime} from './issue-periods';
import type {IssueReview} from './issue-review';
export const RECURRING_MAX_GAP_DAYS=5;
export const RECURRING_POLICY='Same inverter, finding type, detection basis and suspected cause form one persistent recurring issue when successive affected site-local dates are at most five calendar days apart. Each occurrence extends the window; a gap greater than five days starts a new record, including gaps with insufficient data. Only active intervals contribute loss and active hours. Sequence completion does not resolve the operational problem. Individual reviews override the parent; new or changed occurrences require reassessment.';
type Interval={timestamp:string;intervalMinutes?:number;lossKwh:number;countedLossKwh?:number;actualKwh?:number;expectedKwh?:number;[key:string]:unknown};
export type RecurringFinding={id:string;eventKey?:string;evidenceSignature?:string;name:string;equipmentId:string;equipmentName:string;equipmentType:string;type:string;category:string;timezone?:string;startDateTime:string;endDateTime:string;estimatedLossKwh:number|null;actualEnergyKwh?:number|null;expectedEnergyKwh?:number|null;lossUnknown?:boolean;reportClipped?:boolean;intervalMinutes?:number;intervalLosses?:Interval[];evidence?:Record<string,unknown>;suspectedCause?:string;recurringId?:string;detectionBasis?:string};
export type RecurringIssue={id:string;eventKey?:string;evidenceSignature?:string;isRecurring:true;name:string;equipmentId:string;equipmentName:string;equipmentType:'inverter';type:'Underperformance';category:'Performance';timezone:string;startDateTime:string;endDateTime:string;firstDay:string;lastDay:string;dates:string[];activeMinutes:number;estimatedLossKwh:number;actualEnergyKwh:number;expectedEnergyKwh:number;lossPercent:number;durationMinutes:number;durationDays:number;description:string;detectionBasis:string;sequenceStatus:'Awaiting 5-day window'|'Awaiting next day'|'Ended — no occurrence'|'Ended — insufficient data';members:{id:string;eventKey?:string;evidenceSignature?:string}[]};
const addDays=(day:string,days:number)=>new Date(Date.parse(day+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
const nextDay=(day:string)=>addDays(day,1);
const stamp=(n:number,zoned:boolean)=>zoned?new Date(n).toISOString():new Date(n).toISOString().slice(0,-1);
type LedgerIssue=Pick<RecurringFinding,'startDateTime'|'endDateTime'|'intervalMinutes'|'intervalLosses'|'evidence'>;
export const recurringLedger=(issue:LedgerIssue)=>(issue.intervalLosses||issue.evidence?.intervalLosses||[]) as Interval[];
export const recurringEligible=(i:RecurringFinding)=>i.equipmentType==='inverter'&&i.type==='Underperformance'&&i.category==='Performance'&&!i.lossUnknown&&i.estimatedLossKwh!==null;
export function activeSegments(issue:LedgerIssue){
 const zoned=hasTimeZone(issue.startDateTime),parts=recurringLedger(issue).filter(p=>(p.countedLossKwh??p.lossKwh)>0).map(p=>({start:Math.max(localMoment(p.timestamp),localMoment(issue.startDateTime)),end:Math.min(localMoment(p.timestamp)+(p.intervalMinutes||issue.intervalMinutes||60)*60000,localMoment(issue.endDateTime))})).filter(p=>p.end>p.start).sort((a,b)=>a.start-b.start);
 const merged:typeof parts=[];for(const p of parts){const prev=merged.at(-1);if(prev&&p.start<=prev.end)prev.end=Math.max(prev.end,p.end);else merged.push({...p});}
 return merged.map(p=>({startDateTime:stamp(p.start,zoned),endDateTime:stamp(p.end,zoned)}));
}
export function activeDates(issue:RecurringFinding){
 const dates=new Set<string>(),zone=issue.timezone||'UTC';
 for(const p of activeSegments(issue)){const last=stamp(localMoment(p.endDateTime)-1,hasTimeZone(p.endDateTime));for(let d=siteWallTime(p.startDateTime,zone).slice(0,10),end=siteWallTime(last,zone).slice(0,10);d<=end;d=nextDay(d))dates.add(d);}
 return [...dates].sort();
}
/** Split only where a complete local calendar date has no active interval. Original detector references survive. */
export function splitRecurringGaps<T extends RecurringFinding>(issues:T[]):T[]{return issues.flatMap(issue=>{
 if(!recurringEligible(issue))return [issue];
 const dates=activeDates(issue),runs:string[][]=[];for(const day of dates){const last=runs.at(-1);if(last&&nextDay(last.at(-1)!)===day)last.push(day);else runs.push([day]);}
 if(runs.length<2)return [issue];
 const zoned=hasTimeZone(issue.startDateTime),zone=issue.timezone||'UTC';
 return runs.map((days,index)=>{
  const from=calendarDayMoment(days[0],zone,zoned),through=calendarDayMoment(nextDay(days.at(-1)!),zone,zoned);
  const points=recurringLedger(issue).flatMap(p=>{const left=localMoment(p.timestamp),right=left+(p.intervalMinutes||issue.intervalMinutes||60)*60000,start=Math.max(from,left),end=Math.min(through,right);if(end<=start||(p.countedLossKwh??p.lossKwh)<=0)return [];const fraction=(end-start)/(right-left);return [{...p,timestamp:stamp(start,zoned),intervalMinutes:(end-start)/60000,lossKwh:p.lossKwh*fraction,countedLossKwh:(p.countedLossKwh??p.lossKwh)*fraction,actualKwh:(p.actualKwh||0)*fraction,expectedKwh:(p.expectedKwh||0)*fraction}];});
  const startDateTime=points[0].timestamp,endDateTime=stamp(localMoment(points.at(-1)!.timestamp)+points.at(-1)!.intervalMinutes*60000,zoned),durationMinutes=(localMoment(endDateTime)-localMoment(startDateTime))/60000;
  const estimatedLossKwh=points.reduce((s,p)=>s+p.countedLossKwh,0),actualEnergyKwh=points.reduce((s,p)=>s+p.actualKwh,0),expectedEnergyKwh=points.reduce((s,p)=>s+p.expectedKwh,0);
  return {...issue,id:`${issue.id}-sequence-${index}`,startDateTime,endDateTime,durationMinutes,durationDays:durationMinutes/1440,estimatedLossKwh,actualEnergyKwh,expectedEnergyKwh,lossPercent:expectedEnergyKwh?estimatedLossKwh/expectedEnergyKwh*100:0,intervalLosses:undefined,evidence:{...issue.evidence,intervalLosses:points,originalDetectorIssueId:issue.id,originalDetectorStart:issue.startDateTime,originalDetectorEnd:issue.endDateTime}};
 });
});}
type Summary={intervalMinutes?:number;timestamps?:string[];intervalIrradiance?:{timestamp:string;averageWm2:number}[];equipmentProduction?:{equipmentId:string;intervalProduction?:{timestamp:string;energyKwh:number}[]}[]};
export function buildRecurringIssues<T extends RecurringFinding>(issues:T[],summary:Summary={}):RecurringIssue[]{
 const groups=new Map<string,{issue:T;dates:string[]}[]>();
 for(const issue of issues){if(!recurringEligible(issue))continue;const dates=activeDates(issue);if(!dates.length)continue;
  const basis=String(issue.detectionBasis||issue.evidence?.rule||'legacy'),key=JSON.stringify([issue.equipmentId,issue.type,basis,issue.suspectedCause||'',issue.timezone||'UTC']);
  const list=groups.get(key)||[];list.push({issue,dates});groups.set(key,list);
 }
 let watermark=-Infinity;for(const t of summary.timestamps||[])watermark=Math.max(watermark,localMoment(t)+(summary.intervalMinutes||60)*60000);
 for(const p of summary.equipmentProduction||[])for(const t of p.intervalProduction||[])watermark=Math.max(watermark,localMoment(t.timestamp)+(summary.intervalMinutes||60)*60000);
 const sunByZone=new Map<string,Map<string,string[]>>(),readingsByEquipment=new Map((summary.equipmentProduction||[]).map(p=>[p.equipmentId,new Map((p.intervalProduction||[]).map(r=>[r.timestamp,r.energyKwh]))]));
 const sunOnDay=(zone:string,day:string)=>{let index=sunByZone.get(zone);if(!index){index=new Map();for(const p of summary.intervalIrradiance||[])if(p.averageWm2>=200){const d=siteWallTime(p.timestamp,zone).slice(0,10),values=index.get(d)||[];values.push(p.timestamp);index.set(d,values);}sunByZone.set(zone,index);}return index.get(day)||[];};
 const episodes:RecurringIssue[]=[];
 for(const [family,list] of groups){
  list.sort((a,b)=>a.dates[0].localeCompare(b.dates[0])||a.issue.startDateTime.localeCompare(b.issue.startDateTime));
  const runs:typeof list[]=[];let lastDay='';for(const item of list){const last=runs.at(-1);if(last&&item.dates[0]<=addDays(lastDay,RECURRING_MAX_GAP_DAYS)){last.push(item);lastDay=[lastDay,item.dates.at(-1)!].sort().at(-1)!;}else{runs.push([item]);lastDay=item.dates.at(-1)!;}}
  for(const run of runs){const dates=[...new Set(run.flatMap(i=>i.dates))].sort();if(dates.length<2)continue;
   const first=run[0].issue,timezone=first.timezone||'UTC',firstDay=dates[0],lastDay=dates.at(-1)!,id=`recurring:${encodeURIComponent(family)}:${firstDay}`;
   const members=run.map(x=>x.issue),segments=members.flatMap(activeSegments).sort((a,b)=>localMoment(a.startDateTime)-localMoment(b.startDateTime));
   let activeMinutes=0,end=-Infinity;for(const p of segments){const start=localMoment(p.startDateTime),through=localMoment(p.endDateTime);activeMinutes+=Math.max(0,through-Math.max(start,end))/60000;end=Math.max(end,through);}
   const startDateTime=segments[0].startDateTime,endDateTime=stamp(end,hasTimeZone(first.startDateTime)),durationMinutes=(end-localMoment(startDateTime))/60000;
   const estimatedLossKwh=members.reduce((s,i)=>s+(i.estimatedLossKwh||0),0),actualEnergyKwh=members.reduce((s,i)=>s+(i.actualEnergyKwh||0),0),expectedEnergyKwh=members.reduce((s,i)=>s+(i.expectedEnergyKwh||0),0);
   const lastEligibleDay=addDays(lastDay,RECURRING_MAX_GAP_DAYS),completed=watermark>=calendarDayMoment(nextDay(lastEligibleDay),timezone,hasTimeZone(first.startDateTime));
   let sufficient=false;
   if(completed){const readings=readingsByEquipment.get(first.equipmentId);sufficient=true;for(let day=nextDay(lastDay);day<=lastEligibleDay;day=nextDay(day)){const sun=sunOnDay(timezone,day);if(!sun.length||!sun.every(t=>Number.isFinite(readings?.get(t)))){sufficient=false;break;}}}
   for(const item of members)item.recurringId=id;
   episodes.push({id,isRecurring:true,name:`Recurring underperformance · ${first.equipmentName}`,equipmentId:first.equipmentId,equipmentName:first.equipmentName,equipmentType:'inverter',type:'Underperformance',category:'Performance',timezone,startDateTime,endDateTime,firstDay,lastDay,dates,activeMinutes,estimatedLossKwh,actualEnergyKwh,expectedEnergyKwh,lossPercent:expectedEnergyKwh?estimatedLossKwh/expectedEnergyKwh*100:0,durationMinutes,durationDays:durationMinutes/1440,detectionBasis:String(first.detectionBasis||first.evidence?.rule||'legacy'),sequenceStatus:!completed?'Awaiting 5-day window':sufficient?'Ended — no occurrence':'Ended — insufficient data',members:members.map(i=>({id:i.id,eventKey:i.eventKey,evidenceSignature:i.evidenceSignature})),description:RECURRING_POLICY});
  }
 }
 return episodes.sort((a,b)=>b.estimatedLossKwh-a.estimatedLossKwh||a.id.localeCompare(b.id));
}
function segmentMinutes(issues:RecurringFinding[]){let end=-Infinity,total=0;for(const p of issues.flatMap(activeSegments).sort((a,b)=>localMoment(a.startDateTime)-localMoment(b.startDateTime))){const left=localMoment(p.startDateTime),right=localMoment(p.endDateTime);total+=Math.max(0,right-Math.max(left,end))/60000;end=Math.max(end,right);}return total;}
export function recurringViews<T extends RecurringFinding>(episodes:RecurringIssue[],visible:T[]){const byId=new Map(visible.map(i=>[i.id,i]));return episodes.flatMap(episode=>{const issues=episode.members.flatMap(m=>byId.has(m.id)?[byId.get(m.id)!]:[]);if(!issues.length)return [];return [{...episode,issues,visibleLossKwh:issues.reduce((s,i)=>s+(i.estimatedLossKwh||0),0),visibleDates:[...new Set(issues.flatMap(activeDates))].sort(),visibleActiveMinutes:segmentMinutes(issues),filtered:issues.length!==episode.members.length||issues.some(i=>i.reportClipped)}];});}
export type RecurringView<T extends RecurringFinding=RecurringFinding>=ReturnType<typeof recurringViews<T>>[number];
export function recurringTableRows<T extends RecurringFinding>(episodes:RecurringIssue[],visible:T[]){const groups=recurringViews(episodes,visible),byId=new Map(groups.map(g=>[g.id,g])),seen=new Set<string>();return visible.flatMap(issue=>{const group=issue.recurringId?byId.get(issue.recurringId):undefined;if(!group)return [{issue,group:null as RecurringView<T>|null}];if(seen.has(group.id))return [];seen.add(group.id);return [{issue,group}];});}
export function recurringStatus(episode:RecurringIssue,reviews:Record<string,IssueReview>){const review=episode.eventKey?reviews[episode.eventKey]:undefined;return !review?'Unreviewed':review.needsReview?'Needs review':review.state.status;}

export function recurringAggregate<T extends RecurringFinding>(group:RecurringView<T>):T{const expectedEnergyKwh=group.issues.reduce((s,i)=>s+(i.expectedEnergyKwh||0),0);return {...group.issues[0],...group,estimatedLossKwh:group.visibleLossKwh,durationMinutes:group.visibleActiveMinutes,actualEnergyKwh:group.issues.reduce((s,i)=>s+(i.actualEnergyKwh||0),0),expectedEnergyKwh,lossPercent:expectedEnergyKwh?group.visibleLossKwh/expectedEnergyKwh*100:0} as T;}
