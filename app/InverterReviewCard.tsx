'use client';
import {useRef,useState} from 'react';
import type {InverterReviewCardData} from './inverter-review';
import {effectiveReviewStatus,type IssueReview} from './issue-review';
import {formatDateTime} from './issue-date-format';
import {reviewEnergy} from './BulkReviewDialog';
import ReviewGroupTimeline from './ReviewGroupTimeline';

export default function InverterReviewCard({card,reviews,selected,scopeKey,onSelect,onReplace,onReview,readOnly}:{card:InverterReviewCardData;reviews:Record<string,IssueReview>;selected:string[];scopeKey:string;onSelect:(ids:string[],checked:boolean)=>void;onReplace:(equipmentId:string,ids:string[])=>boolean;onReview:(id:string)=>void;readOnly:boolean}){
 const [focus,setFocus]=useState<{scope:string;id:string}|null>(null);
 const details=useRef<HTMLDetailsElement>(null);
 const focused=focus?.scope===scopeKey?card.groups.find(group=>group.id===focus.id):undefined;
 const shown=focused?focused.issues:card.issues;
 function selectGroup(id:string){
  const group=card.groups.find(group=>group.id===id);if(!group)return;
  // Historical runs can be inspected but cannot create an editable selection.
  if(!readOnly&&!onReplace(card.equipmentId,group.issues.map(issue=>issue.id)))return;
  setFocus({scope:scopeKey,id});if(details.current)details.current.open=true;
 }
 function showAll(){
  if(!readOnly&&!onReplace(card.equipmentId,[]))return;
  setFocus(null);
 }
 return <article className="recurring-group inverter-review-card" aria-label={`${card.equipmentName} recurring review`}>
  <header><div><strong>{card.equipmentName}</strong><span>{card.groups.length} recurring {card.groups.length===1?'group':'groups'} · {card.issues.length} individual findings in this view</span></div><div><strong>{reviewEnergy(card.known)}</strong><span>All visible inverter findings{card.unknown?` · ${card.unknown} unknown loss`:''}</span></div></header>
  <ReviewGroupTimeline groups={card.groups} equipmentName={card.equipmentName} reviews={reviews} selectedGroupId={focused?.id||null} onSelectGroup={selectGroup} onReview={onReview}/>
  <div className="inverter-review-scope">
   <p role="status">{focused?`Showing Group ${card.groups.indexOf(focused)+1}: ${shown.length} of ${card.issues.length} individual findings.`:`Showing all ${card.issues.length} individual findings for this inverter, including standalone events.`}</p>
   {focused&&<button className="secondary-btn" onClick={showAll}>Show all inverter findings</button>}
  </div>
  <div className="review-actions"><button className="secondary-btn" disabled={readOnly} onClick={()=>onSelect(shown.map(issue=>issue.id),true)}>Select all {shown.length} {focused?'group':'inverter'} findings</button><button className="secondary-btn" disabled={readOnly||!shown.some(issue=>selected.includes(issue.id))} onClick={()=>onSelect(shown.map(issue=>issue.id),false)}>Deselect shown findings</button></div>
  <details ref={details}><summary>Inspect dates and individual findings <span>({shown.length})</span></summary><div className="review-table-scroll"><table><thead><tr><th>Select</th><th>Finding</th><th>Separate event dates · site time</th><th>Loss</th><th>Review</th></tr></thead><tbody>{shown.map(issue=><tr key={issue.id}>
   <td><input type="checkbox" aria-label={`Select ${issue.equipmentName} ${issue.startDateTime}`} checked={selected.includes(issue.id)} disabled={readOnly} onChange={e=>onSelect([issue.id],e.target.checked)}/></td>
   <td>{issue.name}</td><td>{formatDateTime(issue.startDateTime,issue.timezone)} — {formatDateTime(issue.endDateTime,issue.timezone)}{issue.reportClipped&&<small>Reporting-period portion; review applies to the original finding.</small>}</td>
   <td>{issue.estimatedLossKwh==null||issue.lossUnknown?'Unknown':reviewEnergy(issue.estimatedLossKwh)}</td><td><button className="issue-review-button" onClick={()=>onReview(issue.id)}>{effectiveReviewStatus(issue,issue.eventKey?reviews[issue.eventKey]:undefined)} · Review</button></td>
  </tr>)}</tbody></table></div></details>
 </article>;
}
