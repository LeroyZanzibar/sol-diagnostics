'use client';
import type {RecurringIssue} from './recurring-issues';
import {inverterReviewCards} from './inverter-review';
import InverterReviewCard from './InverterReviewCard';
import {useMemo,useState} from 'react';
import {combinedLoss,type ReviewFinding} from './review-groups';
import type {IssueReview} from './issue-review';
import BulkReviewDialog,{reviewEnergy} from './BulkReviewDialog';
import MaintenanceWindows,{type MaintenanceData} from './MaintenanceWindows';
export default function ReviewWorkbench({siteId,runId,visible,originals,episodes,reviews,selected,onSelect,onReplace,filterScope,onClear,onUpdated,onReview,readOnly,maintenance,showRecurring=true}:{siteId:string;runId:string;visible:ReviewFinding[];originals:ReviewFinding[];episodes:RecurringIssue[];reviews:Record<string,IssueReview>;selected:string[];onSelect:(ids:string[],checked:boolean)=>void;onReplace:(equipmentId:string,ids:string[])=>boolean;filterScope:string;onClear:()=>void;onUpdated:(rows:(IssueReview&{eventKey:string})[])=>void;onReview:(id:string)=>void;readOnly:boolean;maintenance:MaintenanceData;showRecurring?:boolean}){
 const cards=useMemo(()=>inverterReviewCards(episodes,visible,originals),[episodes,visible,originals]);
 const [selectionReset,setSelectionReset]=useState(0);
 const scopeKey=`${filterScope}:${selectionReset}`;
 const clearSelection=()=>{onClear();setSelectionReset(value=>value+1);};
 const groupCount=cards.reduce((count,card)=>count+card.groups.length,0);
 const [groupLimit,setGroupLimit]=useState(10);
 const [bulk,setBulk]=useState<ReviewFinding[]|null>(null);
 const originalById=new Map(originals.map(i=>[i.id,i])),selection=visible.filter(i=>selected.includes(i.id)),loss=combinedLoss(selection);
 // Maintenance classification candidates use complete events, never reporting-period fragments.
 const fullVisible=visible.map(i=>originalById.get(i.id)||i);
 return <section className="review-workbench" aria-label="Grouped analyst review">
  <header><div><p className="eyebrow">REVIEW WORKSPACE</p><h3>{showRecurring?'Review recurring findings together':'Review findings together'}</h3><p>{showRecurring?'Each inverter has one card, with a separate timeline row for each recurring group. Select a crosshatched period to choose its findings; select a solid occurrence to review it. Losses count active intervals only.':'Select visible findings from the table or a maintenance window to review them together.'}</p></div></header>
  {showRecurring&&<details className="recurring-groups" open><summary>Recurring inverter underperformance <span>{cards.length} {cards.length===1?'inverter':'inverters'} · {groupCount} recurring {groupCount===1?'group':'groups'}</span></summary>
   {!cards.length&&<p>No recurring inverter issues within the five-day window are visible. Standalone findings remain in the table below.</p>}
   {cards.slice(0,groupLimit).map(card=><InverterReviewCard key={card.equipmentId} card={card} reviews={reviews} selected={selected} scopeKey={scopeKey} onSelect={onSelect} onReplace={onReplace} onReview={onReview} readOnly={readOnly}/>)}
   {cards.length>groupLimit&&<button className="secondary-btn" onClick={()=>setGroupLimit(n=>n+10)}>Show more inverters ({cards.length-groupLimit} remaining)</button>}
   {cards.length>0&&<p>Crosshatched periods include gaps, not continuous downtime. Recurring groups retain their saved dates and five-day grouping rule. Findings, displayed losses and bulk selections follow current filters. Reviewing a recurring group applies to its complete saved episode; individual reviews remain exceptions.</p>}
  </details>}
  <MaintenanceWindows siteId={siteId} data={maintenance} findings={fullVisible} onSelect={ids=>onSelect(ids,true)} readOnly={readOnly}/>
  <div className="bulk-review-bar"><div><strong>{selection.length} findings selected</strong><span>{reviewEnergy(loss.known)} in this reporting period{loss.unknown?` · ${loss.unknown} unknown`:''}</span></div><div className="review-actions"><button className="secondary-btn" disabled={!selection.length} onClick={clearSelection}>Clear selection</button><button className="primary-btn" disabled={readOnly||!selection.length} onClick={()=>setBulk(selection.map(i=>originalById.get(i.id)||i))}>Review selected…</button></div></div>
  <p className="selection-help">Select findings using the table checkboxes, a group, or a maintenance window. Up to 500 per action. Changing filters clears the selection.{readOnly?' Select Current data history to edit reviews.':''}</p>
  {bulk&&<BulkReviewDialog siteId={siteId} runId={runId} findings={bulk} reviews={reviews} onUpdated={onUpdated} onClose={()=>{setBulk(null);clearSelection();}}/>}
 </section>;
}
