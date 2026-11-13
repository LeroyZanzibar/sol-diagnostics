'use client';
import {useRef,useState} from 'react';
import ReviewModal from './ReviewModal';
import {operationalCauses,effectiveReviewStatus,type IssueReview} from './issue-review';
import {reviewOperationId,combinedLoss,type ReviewFinding} from './review-groups';
import {formatDateTime} from './issue-date-format';
export const reviewEnergy=(value:number)=>`${value.toLocaleString(undefined,{maximumFractionDigits:2})} kWh`;
export default function BulkReviewDialog({siteId,runId,findings,reviews,onUpdated,onClose}:{siteId:string;runId:string;findings:ReviewFinding[];reviews:Record<string,IssueReview>;onUpdated:(rows:(IssueReview&{eventKey:string})[])=>void;onClose:()=>void}){
 const [confirm,setConfirm]=useState(false),[classification,setClassification]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[started,setStarted]=useState(false),[error,setError]=useState(''),[done,setDone]=useState<string[]>([]),[failed,setFailed]=useState<Record<string,string>>({});
 const operation=useRef(''),snapshot=useRef(findings.map(i=>({issueId:i.id,evidenceSignature:i.evidenceSignature,baseVersion:i.eventKey?reviews[i.eventKey]?.version||0:0}))),loss=combinedLoss(findings);
 const ready=confirm||!!classification||!!note.trim(),complete=done.length===findings.length;
 async function save(){
  if(!ready||busy)return;if(!operation.current)operation.current=reviewOperationId();setBusy(true);setStarted(true);setError('');
  const completed=new Set(done),failures:Record<string,string>={};
  try{
   const pending=snapshot.current.filter(i=>!completed.has(i.issueId));
   for(let offset=0;offset<pending.length;offset+=25){
    const r=await fetch('/api/issue-reviews/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({siteId,runId,operationId:operation.current,items:pending.slice(offset,offset+25),patch:{confirm,classification,note}})}),d=await r.json();
    if(!r.ok)throw new Error(d.error||'Unable to save this batch.');
    onUpdated(d.results.filter((row:any)=>row.review).map((row:any)=>({...row.review,eventKey:row.eventKey})));
    for(const row of d.results){if(row.error)failures[row.issueId]=row.error;else completed.add(row.issueId);}
    setDone([...completed]);setFailed({...failures});
   }
  }catch(e){setError(e instanceof Error?e.message:'Unable to save. Retry safely; saved notes will not be duplicated.');}
  finally{setBusy(false);}
 }
 return <ReviewModal title={`Review ${findings.length} selected findings`} busy={busy} onClose={onClose}>
  <p>Each selected finding keeps its own dates, calculated loss and review history. Actions apply to the complete original findings, including any portions outside the reporting period.</p>
  <div className="review-evidence"><strong>{reviewEnergy(loss.known)} combined known loss</strong>{loss.unknown>0&&<p>{loss.unknown} findings have unknown loss and are excluded from this total.</p>}</div>
  <details className="bulk-findings" open><summary>Explicit selection · {findings.length} findings</summary><div className="review-table-scroll"><table><thead><tr><th>Equipment / finding</th><th>Original dates · site time</th><th>Loss</th><th>Review</th></tr></thead><tbody>{findings.map(i=><tr key={i.id}><td>{i.equipmentName}<small>{i.type}</small></td><td>{formatDateTime(i.startDateTime,i.timezone)}<br/>{formatDateTime(i.endDateTime,i.timezone)}</td><td>{i.lossUnknown||i.estimatedLossKwh==null?'Unknown':reviewEnergy(i.estimatedLossKwh)}</td><td>{done.includes(i.id)?'Saved':failed[i.id]||effectiveReviewStatus(i,i.eventKey?reviews[i.eventKey]:undefined)}</td></tr>)}</tbody></table></div></details>
  <fieldset disabled={busy||started}>
   <label className="review-checkbox"><input type="checkbox" checked={confirm} onChange={e=>setConfirm(e.target.checked)}/>Confirm all selected findings</label>
   <p>Confirmation accepts the current evidence, including findings that need reassessment. Classification and notes alone do not reaffirm a previous decision.</p>
   <label>Operational classification<select value={classification} onChange={e=>setClassification(e.target.value)}><option value="">Keep each existing classification</option>{operationalCauses.map(c=><option key={c}>{c}</option>)}</select></label>
   <label>Append this note to each selected finding<textarea maxLength={10000} value={note} onChange={e=>setNote(e.target.value)} placeholder="Optional shared operational context"/></label>
   <p>Existing notes, resolution details and confidence assessments are retained.</p>
  </fieldset>
  {started&&<p role="status">{done.length} of {findings.length} saved.{Object.keys(failed).length>0?' Conflicted findings were not changed. Close and reopen your selection to use their latest reviews.':''}</p>}
  {error&&<p role="alert" className="import-error">{error} You can retry; already saved notes will not be duplicated.</p>}
  <footer><button className="primary-btn" disabled={busy||!ready||(!complete&&Object.keys(failed).length>0&&!error)} onClick={()=>complete?onClose():void save()}>{complete?'Done':busy?`Saving ${done.length} of ${findings.length}…`:started?'Retry unsaved findings':'Apply to selected findings'}</button></footer>
 </ReviewModal>;
}
