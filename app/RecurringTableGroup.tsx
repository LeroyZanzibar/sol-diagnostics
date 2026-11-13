'use client';
import {Fragment,useState,type ReactNode} from 'react';
import type {RecurringView,RecurringFinding} from './recurring-issues';
import {recurringStatus,recurringAggregate} from './recurring-issues';
import type {IssueReview} from './issue-review';
export default function RecurringTableGroup<T extends RecurringFinding>({group,columns,renderCell,reviews,onReview,selected,onSelect,readOnly}:{group:RecurringView<T>;columns:{id:string}[];renderCell:(key:any,issue:T)=>ReactNode;reviews:Record<string,IssueReview>;onReview:(id:string)=>void;selected:string[];onSelect:(ids:string[],checked:boolean)=>void;readOnly:boolean}){
 const [expanded,setExpanded]=useState(false),ids=group.issues.map(i=>i.id);
 const aggregate=recurringAggregate(group);
 const selectedAll=ids.every(id=>selected.includes(id));
 return <Fragment><tr className="recurring-parent-row"><td className="issue-select-column"><input type="checkbox" aria-label={`Select visible occurrences of ${group.equipmentName} ${group.firstDay}`} disabled={readOnly} checked={selectedAll} onChange={e=>onSelect(ids,e.target.checked)}/></td>{columns.map(column=><td key={column.id} className={`issue-column-${column.id}`}>
  {column.id==='name'?<><button className="recurring-table-toggle" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>{expanded?'⌄':'›'} {group.name}</button><button className="issue-review-button" onClick={()=>onReview(group.id)}>{recurringStatus(group,reviews)} · Review recurring issue</button><small>{group.firstDay} — {group.lastDay} · {group.issues.length} of {group.members.length} occurrences shown · {group.sequenceStatus}</small><small>{(group.visibleActiveMinutes/60).toLocaleString(undefined,{maximumFractionDigits:2})} active hours in this view. Sequence completion does not mean resolved.</small></>:column.id==='lossPercent'?`${aggregate.expectedEnergyKwh?Math.round(group.visibleLossKwh/aggregate.expectedEnergyKwh*1000)/10:0}%`:renderCell(column.id,aggregate)}
 </td>)}</tr>{expanded&&group.issues.map(issue=><tr className="recurring-child-row" key={issue.id}><td className="issue-select-column"><input type="checkbox" aria-label={`Select occurrence ${issue.equipmentName} ${issue.startDateTime}`} disabled={readOnly} checked={selected.includes(issue.id)} onChange={e=>onSelect([issue.id],e.target.checked)}/></td>{columns.map(column=><td key={column.id} className={`issue-column-${column.id}`}>{renderCell(column.id,issue)}</td>)}</tr>)}</Fragment>;
}
