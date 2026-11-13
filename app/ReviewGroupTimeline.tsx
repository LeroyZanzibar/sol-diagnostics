'use client';
import {useLayoutEffect,useMemo,useRef} from 'react';
import {activeSegments,recurringStatus,type RecurringView} from './recurring-issues';
import {formatDateTime} from './issue-date-format';
import {localMoment} from './issue-periods';
import {formatAxis,reviewTimelineScale} from './timeline-axis';
import type {ReviewFinding} from './review-groups';
import type {IssueReview} from './issue-review';

type Props={groups:RecurringView<ReviewFinding>[];equipmentName:string;selectedGroupId:string|null;reviews:Record<string,IssueReview>;onSelectGroup:(id:string)=>void;onReview:(id:string)=>void};
const energy=(value:number)=>`${value.toLocaleString(undefined,{maximumFractionDigits:2})} kWh`;

export default function ReviewGroupTimeline({groups,equipmentName,selectedGroupId,reviews,onSelectGroup,onReview}:Props){
 const rows=useMemo(()=>groups.map(group=>({group,segments:group.issues.flatMap(issue=>{
  const active=activeSegments(issue);
  return (active.length?active:[{startDateTime:issue.startDateTime,endDateTime:issue.endDateTime}]).map(segment=>({issue,...segment,timezone:issue.timezone,rowId:group.id}));
 })})),[groups]);
 const segments=useMemo(()=>rows.flatMap(row=>row.segments),[rows]);
 const scale=useMemo(()=>reviewTimelineScale(segments),[segments]);
 const viewport=useRef<HTMLDivElement>(null);
 const firstStart=segments.reduce((first,segment)=>Math.min(first,localMoment(segment.startDateTime)),Infinity);
 const positionKey=JSON.stringify([firstStart,scale]);
 useLayoutEffect(()=>{
  const container=viewport.current,chart=container?.querySelector<HTMLElement>('.review-timeline-chart');
  if(!container||!chart)return;
  let positioned=false;
  const position=()=>{
   if(!container.clientWidth)return; // Closed details receive their initial position on opening.
   const first=chart.querySelector<HTMLElement>('[data-first-issue="true"]');
   if(!first)return;
   const previousScroll=container.scrollLeft;
   chart.style.paddingRight='0px';
   const left=first.getBoundingClientRect().left-container.getBoundingClientRect().left+container.scrollLeft-container.clientLeft;
   const target=Math.max(0,left-24);
   chart.style.paddingRight=`${Math.max(0,target+container.clientWidth-chart.scrollWidth)}px`;
   container.scrollLeft=positioned?previousScroll:target;positioned=true;
  };
  position();
  const observer=new ResizeObserver(position);observer.observe(container);
  return ()=>observer.disconnect();
 },[positionKey]);
 if(!scale)return <p>Event dates are unavailable. Expand the individual findings for details.</p>;
 const {timezone,months}=scale;
 // A single shared coordinate system gives every group one continuous background
 // button, including groups that span month boundaries. Empty months stay omitted.
 const plotWidth=months.reduce((sum,month)=>sum+month.minWidth-24,0);
 let offset=0;
 const columns=months.map(month=>{const column={...month,offset,width:month.minWidth-24};offset+=column.width;return column;});
 const positionAt=(time:number)=>{
  for(const month of columns){
   if(time<month.start)return month.offset;
   if(time<month.end)return month.offset+(time-month.start)/(month.end-month.start)*month.width;
  }
  return plotWidth;
 };
 const barStyle=(start:number,end:number)=>{
  const from=positionAt(start),through=positionAt(end);
  if(through<=from)return null;
  const width=Math.max(6,through-from),left=Math.max(0,Math.min(plotWidth-width,from));
  return {left:`${left/plotWidth*100}%`,width:`${width/plotWidth*100}%`};
 };
 const days=columns.flatMap(month=>month.days.map(day=>({...day,offset:month.offset+(day.time-month.start)/(month.end-month.start)*month.width})));
 return <div className="review-group-timeline review-inverter-timeline">
  <div className="review-inverter-timeline-layout">
   <div className="review-timeline-labels">
    <div className="review-timeline-label-heading">Recurring groups</div>
    {groups.map((group,index)=><div className={`review-timeline-row-label${selectedGroupId===group.id?' is-selected':''}`} key={group.id}>
     <strong>Group {index+1}</strong>
     <span>{group.firstDay} — {group.lastDay}</span>
     <span>{group.issues.length} of {group.members.length} occurrences shown</span>
     <span>{energy(group.visibleLossKwh)} · {group.sequenceStatus}</span>
     <button type="button" className="secondary-btn" onClick={()=>onReview(group.id)}>{recurringStatus(group,reviews)} · Review group</button>
    </div>)}
   </div>
   <div ref={viewport} className="timeline-scroll" role="region" aria-label={`${equipmentName} finding timeline, scroll horizontally to explore dates`} tabIndex={0}>
    <div className="review-timeline-chart" style={{width:plotWidth+24}}>
     <div className="review-inverter-months">
      {columns.map(month=><div key={month.start} className="timeline-axis" style={{width:`${month.width/plotWidth*100}%`}}><span>{formatAxis(month.start,timezone)}</span></div>)}
     </div>
     <div className="review-inverter-tracks">
      <div className="review-inverter-day-grid" aria-hidden="true">
       {days.map(({day,time,offset:dayOffset})=><div key={time} className="review-day-gridline" style={{left:`${dayOffset/plotWidth*100}%`}}><span>{day}</span></div>)}
      </div>
      {rows.map(({group,segments:occurrences},index)=>{
      const selected=selectedGroupId===group.id,background=barStyle(localMoment(group.startDateTime),localMoment(group.endDateTime));
      const groupLabel=`Group ${index+1} · ${formatDateTime(group.startDateTime,group.timezone)} to ${formatDateTime(group.endDateTime,group.timezone)} · ${group.issues.length} visible occurrences · ${energy(group.visibleLossKwh)} in this view`;
      return <div key={group.id} className={`timeline-track review-timeline-group-row${selected?' is-selected':''}`} data-group-id={group.id}>
       {background&&<button type="button" className={`review-recurring-bar${selected?' is-selected':''}`} style={background} aria-pressed={selected} aria-label={`Select recurring ${groupLabel}`} title={`${groupLabel} · Recurring period includes gaps; select to filter individual findings.`} onClick={()=>onSelectGroup(group.id)}/>}
       {occurrences.map(segment=>{
        const {issue}=segment,start=localMoment(segment.startDateTime),style=barStyle(start,localMoment(segment.endDateTime));
        if(!style)return null;
        const loss=issue.lossUnknown||issue.estimatedLossKwh==null?'Unknown loss':energy(issue.estimatedLossKwh);
        const detail=`${issue.equipmentName} · ${formatDateTime(segment.startDateTime,issue.timezone)} to ${formatDateTime(segment.endDateTime,issue.timezone)} · Occurrence total: ${loss}${issue.reportClipped?' · Reporting-period portion; review opens the original finding.':''}`;
        return <button key={`${issue.id}:${segment.startDateTime}`} data-first-issue={start===firstStart||undefined} type="button" className={`timeline-bar performance ${issue.severity||'medium'}`} style={style} title={detail} aria-label={`Review finding: ${detail}`} onClick={()=>onReview(issue.id)}/>;
       })}
      </div>;
      })}
     </div>
    </div>
   </div>
  </div>
  <div className="review-timeline-key" aria-label="Timeline legend"><span><i className="review-recurring-swatch" aria-hidden="true"/>Recurring period · includes gaps</span><span><i className="review-occurrence-swatch" aria-hidden="true"/>Individual occurrence</span></div>
  <p className="review-timeline-caption">{groups[0]?.timezone||timezone} · Opens at the first active finding. Daily lines use site dates; only months with active findings are shown. Select a crosshatched period to select its findings; select a solid bar to review that individual occurrence.</p>
 </div>;
}
