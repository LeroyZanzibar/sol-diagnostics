'use client';
import {Fragment,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {calendarDayMoment,reportRangeValid,type ReportRange} from './issue-periods';
import {maintenanceDays,type MaintenanceDay,type MaintenanceEntry} from './maintenance-data';

export function useTimelineMaintenance(siteId:string,range:ReportRange,revision:number){
  const scope=JSON.stringify([siteId,range.from,range.through,revision]);
  const [state,setState]=useState<{scope:string;entries:MaintenanceEntry[];timezone:string;error:string}>({scope:'',entries:[],timezone:'',error:''});
  const [retry,setRetry]=useState(0);
  useEffect(()=>{if(!siteId||!reportRangeValid(range))return;const controller=new AbortController();const params=new URLSearchParams({siteId});if(range.from)params.set('from',range.from);if(range.through)params.set('through',range.through);fetch(`/api/maintenance-data?${params}`,{signal:controller.signal}).then(async response=>{const data=await response.json();if(!response.ok)throw Error(data.error);if(!controller.signal.aborted)setState({scope,entries:data.entries,timezone:data.timezone,error:''});}).catch(e=>{if(!controller.signal.aborted)setState({scope,entries:[],timezone:'',error:e.message});});return()=>controller.abort();},[scope,retry]);
  const current=state.scope===scope;
  const days=useMemo(()=>maintenanceDays(current?state.entries:[],range),[current,state.entries,range.from,range.through]);
  return {days,timezone:current?state.timezone:'',loading:!current&&!!siteId&&reportRangeValid(range),error:current?state.error:'',retry:()=>{setState(s=>({...s,scope:''}));setRetry(v=>v+1);}};
}
export function nextMaintenanceDate(date:string){return new Date(Date.parse(`${date}T00:00:00Z`)+86400000).toISOString().slice(0,10);}
export function maintenanceDaySpan(date:string,timezone:string){return {start:calendarDayMoment(date,timezone),end:calendarDayMoment(nextMaintenanceDate(date),timezone)};}

export default function TimelineMaintenance({days,start,end,timezone}:{days:MaintenanceDay[];start:number;end:number;timezone:string}){
  const [selected,setSelected]=useState<{day:MaintenanceDay;rect:DOMRect;pinned:boolean}|null>(null),[position,setPosition]=useState({top:0,left:0});
  const tooltip=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{if(!selected||!tooltip.current)return;const r=selected.rect,tip=tooltip.current.getBoundingClientRect();setPosition({left:Math.max(8,Math.min(window.innerWidth-tip.width-8,r.left)),top:r.bottom+tip.height+10<window.innerHeight?r.bottom+8:Math.max(8,r.top-tip.height-8)});},[selected]);
  useEffect(()=>{const close=()=>setSelected(null),onScroll=(event:Event)=>{if(!tooltip.current?.contains(event.target as Node))close();},escape=(event:KeyboardEvent)=>{if(event.key==='Escape')close();};window.addEventListener('scroll',onScroll,true);window.addEventListener('resize',close);window.addEventListener('keydown',escape);return()=>{window.removeEventListener('scroll',onScroll,true);window.removeEventListener('resize',close);window.removeEventListener('keydown',escape);};},[]);
  const dateLabel=(date:string)=>new Intl.DateTimeFormat('en',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(`${date}T12:00:00Z`));
  return <Fragment>
    <div className="timeline-issue-label timeline-maintenance-label"><strong>Maintenance</strong><small>{days.length} dates · {days.reduce((sum,day)=>sum+day.tasks.length,0)} tasks</small></div>
    <div className="timeline-track timeline-maintenance-track">
      {!days.length&&<small className="timeline-no-maintenance">No maintenance dates in this period</small>}
      {days.map(day=>{const span=maintenanceDaySpan(day.date,timezone);return <button key={day.date} type="button" className="timeline-maintenance-marker" style={{left:`calc(${(span.start-start)/(end-start)*100}% + 1px)`,width:`max(18px, calc(${(span.end-span.start)/(end-start)*100}% - 2px))`}} aria-label={`${dateLabel(day.date)}: ${day.tasks.length} maintenance task${day.tasks.length===1?'':'s'}`} aria-describedby={selected?.day.date===day.date?'timeline-maintenance-tooltip':undefined} aria-pressed={selected?.day.date===day.date&&selected.pinned} onMouseEnter={event=>{if(!selected?.pinned)setSelected({day,rect:event.currentTarget.getBoundingClientRect(),pinned:false});}} onMouseLeave={()=>setSelected(s=>s?.pinned?s:null)} onFocus={event=>{if(!selected?.pinned)setSelected({day,rect:event.currentTarget.getBoundingClientRect(),pinned:false});}} onBlur={()=>setSelected(s=>s?.pinned?s:null)} onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();setSelected(s=>s?.day.date===day.date&&s.pinned?null:{day,rect,pinned:true});}}>{day.tasks.length}</button>;})}
    </div>
    {selected&&createPortal(<div id="timeline-maintenance-tooltip" ref={tooltip} className="timeline-maintenance-tooltip" role="tooltip" style={position}><button className="timeline-maintenance-close" aria-label="Close maintenance details" onClick={()=>setSelected(null)}>×</button><strong>{dateLabel(selected.day.date)}</strong><small>{selected.day.tasks.length} maintenance task{selected.day.tasks.length===1?'':'s'}</small><ul>{selected.day.tasks.map((task,index)=><li key={index}>{task}</li>)}</ul></div>,document.body)}
  </Fragment>;
}
