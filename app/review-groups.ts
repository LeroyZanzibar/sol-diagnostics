import { localTimestamp } from './telemetry-time';
export type ReviewFinding={id:string;eventKey?:string;evidenceSignature?:string;equipmentId:string;equipmentName:string;equipmentType:string;type:string;category:string;severity?:'critical'|'high'|'medium';name:string;startDateTime:string;endDateTime:string;timezone?:string;estimatedLossKwh:number|null;lossUnknown?:boolean;reportClipped?:boolean;intervalMinutes?:number;intervalLosses?:{timestamp:string;intervalMinutes?:number;lossKwh:number;countedLossKwh?:number}[];affectedEquipment?:{id:string}[]};
export function combinedLoss(issues:ReviewFinding[]){return {known:issues.reduce((sum,i)=>sum+(i.lossUnknown?0:i.estimatedLossKwh??0),0),unknown:issues.filter(i=>i.lossUnknown||i.estimatedLossKwh==null).length};}
export function findingDates(issue:ReviewFinding){
 const dates=new Set<string>(),zone=issue.timezone||'UTC';
 const zoned=(v:string)=>/(?:Z|[+-]\d{2}:?\d{2})$/i.test(v),instant=(v:string)=>Date.parse(zoned(v)?v:`${v}Z`);
 const dayOf=(v:string)=>zoned(v)?localTimestamp(v,zone).slice(0,10):v.slice(0,10);
 const add=(start:string,end:string)=>{
  const last=new Date(instant(end)-1);
  if(!Number.isFinite(last.getTime()))return;
  let day=dayOf(start),through=dayOf(zoned(end)?last.toISOString():last.toISOString().slice(0,-1));
  // Calendar-day enumeration, not 24-hour increments in a DST-observing zone.
  for(let n=0;day&&day<=through&&n<3660;n++){dates.add(day);day=new Date(Date.parse(`${day}T00:00:00Z`)+86400000).toISOString().slice(0,10);}
 };
 if(issue.intervalLosses?.length){
  for(const point of issue.intervalLosses){const left=Math.max(instant(point.timestamp),instant(issue.startDateTime)),right=Math.min(instant(point.timestamp)+(point.intervalMinutes||issue.intervalMinutes||60)*60000,instant(issue.endDateTime));if(Number.isFinite(left)&&Number.isFinite(right)&&right>left){const stamp=(n:number)=>zoned(issue.startDateTime)?new Date(n).toISOString():new Date(n).toISOString().slice(0,-1);add(stamp(left),stamp(right));}}
 }else add(issue.startDateTime,issue.endDateTime);
 return [...dates].sort();
}
export function recurringInverterGroups<T extends ReviewFinding>(issues:T[]){
 const groups=new Map<string,T[]>();
 for(const issue of issues)if(issue.type==='Underperformance'&&issue.category==='Performance'&&issue.equipmentType==='inverter'){
  const list=groups.get(issue.equipmentId)||[];list.push(issue);groups.set(issue.equipmentId,list);
 }
 return [...groups].filter(([,list])=>list.length>1).map(([equipmentId,list])=>({equipmentId,equipmentName:list[0].equipmentName,issues:[...list].sort((a,b)=>a.startDateTime.localeCompare(b.startDateTime)),dates:[...new Set(list.flatMap(findingDates))].sort(),...combinedLoss(list)})).sort((a,b)=>b.known-a.known||a.equipmentName.localeCompare(b.equipmentName));
}
export type MaintenanceEquipment={id:string;name:string;type:string;parentId?:string|null};
export type MaintenanceState={title:string;startAt:string;endAt:string;timezone:string;wholeSite:boolean;equipmentIds:string[];equipment:MaintenanceEquipment[];notes:string;archived:boolean;changeId?:string};
export type MaintenanceWindow={id:string;version:number;state:MaintenanceState;updatedAt:string};
export function expandMaintenanceEquipment(ids:string[],equipment:MaintenanceEquipment[]){
 const allowed=new Set(['revenue_meter','transformer','inverter']);
 if(!ids.length||ids.length>500||new Set(ids).size!==ids.length||ids.some(id=>!equipment.some(e=>e.id===id&&allowed.has(e.type))))throw new Error('Choose valid equipment from this site.');
 const selected=new Set(ids);
 for(let n=0;n<equipment.length;n++){let added=false;for(const item of equipment)if(item.parentId&&selected.has(item.parentId)&&allowed.has(item.type)&&!selected.has(item.id)){selected.add(item.id);added=true;}if(!added)break;}
 return equipment.filter(e=>selected.has(e.id)).map(({id,name,type,parentId})=>({id,name,type,parentId}));
}
export function maintenanceMatch(issue:Pick<ReviewFinding,'equipmentId'|'startDateTime'|'endDateTime'|'affectedEquipment'>,window:MaintenanceWindow):'full'|'partial'|null{
 const s=window.state;if(s.archived)return null;
 const a=Date.parse(issue.startDateTime),b=Date.parse(issue.endDateTime),start=Date.parse(s.startAt),end=Date.parse(s.endAt);
 if(![a,b,start,end].every(Number.isFinite)||Math.max(a,start)>=Math.min(b,end))return null;
 const ids=new Set(s.equipment.map(e=>e.id)),affected=issue.affectedEquipment?.map(e=>e.id)||[];
 const all=s.wholeSite||ids.has(issue.equipmentId)||(affected.length>0&&affected.every(id=>ids.has(id)));
 const any=all||affected.some(id=>ids.has(id));
 return !any?null:all&&start<=a&&end>=b?'full':'partial';
}

export function reviewOperationId(){
 if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
 const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const hex=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
