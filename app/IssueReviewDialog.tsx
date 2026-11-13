"use client";
import SharedReductionEvidence from './SharedReductionEvidence';
import {useEffect,useRef,useState} from 'react';
import {confidenceLevels,operationalCauses,reviewStatuses,dismissalReasons,resolutionReasons,type IssueReview,type ReviewState,type SavedIssueReview} from './issue-review';
import type {MaintenanceWindow} from './review-groups';
import {formatDateTime} from './issue-date-format';
import {issueResolutionTime,resolutionLocalTime,resolutionTimeError,resolutionTimeOptions,reviewTimezone} from './issue-review-time';

type EvidenceSummary={recurring?:{dates:string[];activeMinutes:number;sequenceStatus:string;occurrenceCount:number};hasSharedReduction?:boolean;equipmentName:string;startDateTime:string;endDateTime:string;description:string;actualEnergyKwh?:number|null;expectedEnergyKwh?:number|null;estimatedLossKwh?:number|null;lossUnknown:boolean;productionUnknown:boolean;suspectedCause:string;causeExplanation:string};
type Audit={version:number;note:string;actor:string;created_at:string;state:string;run_id:string};
export default function IssueReviewDialog({siteId,runId,issueId,name,onClose,onSaved,readOnly=false,hasNext=false,maintenanceContext=[],onParentReview}:{onParentReview?:(id:string)=>void;maintenanceContext?:{window:MaintenanceWindow;coverage:string}[];siteId:string;runId:string;issueId:string;name:string;onClose:()=>void;onSaved:(result:SavedIssueReview,advance?:boolean)=>void;readOnly?:boolean;hasNext?:boolean}){
 const [review,setReview]=useState<IssueReview|null>(null),[state,setState]=useState<ReviewState|null>(null),[note,setNote]=useState(''),[audit,setAudit]=useState<Audit[]>([]),[next,setNext]=useState<number|null>(null),[changed,setChanged]=useState(false),[related,setRelated]=useState<any[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [timezone,setTimezone]=useState('UTC'),[issueEnd,setIssueEnd]=useState(''),[resolvedLocal,setResolvedLocal]=useState(''),[legacyClassification,setLegacyClassification]=useState('');
 const [summary,setSummary]=useState<EvidenceSummary|null>(null),[dismissReason,setDismissReason]=useState(''),[resolutionReason,setResolutionReason]=useState('');
 const dismissControl=useRef<HTMLSelectElement>(null);
 const energy=(value:number|null|undefined)=>value==null?'Unknown':`${value.toLocaleString(undefined,{maximumFractionDigits:2})} kWh`;
 const local=(value:string)=>resolutionLocalTime(value,timezone).replace('T',' ');
 const dialog=useRef<HTMLDivElement>(null),close=useRef<HTMLButtonElement>(null);
 const url=`/api/issue-reviews?siteId=${encodeURIComponent(siteId)}&runId=${encodeURIComponent(runId)}&issueId=${encodeURIComponent(issueId)}`;
 useEffect(()=>{
  const c=new AbortController(),previous=document.activeElement as HTMLElement;
  close.current?.focus();
  const old=document.body.style.overflow;document.body.style.overflow='hidden';
  fetch(url,{signal:c.signal}).then(async r=>{
   const d=await r.json();if(!r.ok)throw new Error(d.error);if(c.signal.aborted)return;
   const zone=reviewTimezone(d.timezone),saved=d.review.state as ReviewState;
   const legacy=operationalCauses.includes(saved.classification as typeof operationalCauses[number])?'':saved.classification;
   const dismissal=saved.dismissalReason||(d.audit||[]).find((a:Audit)=>JSON.parse(a.state).status==='Dismissed'&&a.note)?.note||'';
   setReview(d.review);setState({...saved,dismissalReason:dismissal,classification:legacy&&!readOnly?'Unknown':saved.classification});
   setSummary(d.issueSummary||null);setDismissReason(dismissal?(dismissalReasons.includes(dismissal)?dismissal:'Other'):'');
   setResolutionReason(saved.resolutionNote?(resolutionReasons.includes(saved.resolutionNote as typeof resolutionReasons[number])?saved.resolutionNote:'Other'):'');
   setLegacyClassification(legacy);setTimezone(zone);setIssueEnd(d.issueEndDateTime||'');
   setResolvedLocal(resolutionLocalTime(saved.resolvedAt,zone));
   setAudit(d.audit);setNext(d.next);setChanged(d.needsReview);setRelated(d.related||[]);
  }).catch(e=>{if(!c.signal.aborted)setError(e.message);});
  return()=>{c.abort();document.body.style.overflow=old;previous?.focus();};
 },[url,readOnly]);
 const timeOptions=resolutionTimeOptions(resolvedLocal,timezone);
 const timeError=state?.resolution==='Resolved'?resolutionTimeError(resolvedLocal,timezone,state.resolvedAt):'';
 function changeResolution(resolution:string){
  if(!state)return;
  // Use the complete retained event, not a reporting-period-clipped issue or the review clock.
  const resolvedAt=resolution==='Resolved'?(state.resolvedAt||issueResolutionTime(issueEnd,timezone)):'';
  setState({...state,resolution,resolvedAt});setResolvedLocal(resolutionLocalTime(resolvedAt,timezone));
 }
 function changeResolutionTime(value:string){
  if(!state)return;
  const options=resolutionTimeOptions(value,timezone);
  const resolvedAt=options.find(option=>option.timestamp===state.resolvedAt)?.timestamp||(options.length===1?options[0].timestamp:'');
  setResolvedLocal(value);setState({...state,resolvedAt});
 }
 async function more(){setBusy(true);try{const r=await fetch(`${url}&before=${next}`),d=await r.json();if(!r.ok)throw new Error(d.error);setAudit(a=>[...a,...d.audit]);setNext(d.next);}catch(e){setError(e instanceof Error?e.message:'Unable to load notes.');}finally{setBusy(false);}}
 async function save(status?:string,advance=false){
  if(!review||!state)return;
  if(timeError){setError(timeError);return;}
  const nextState={...state,status:status||state.status};
  if(nextState.status==='Dismissed'&&!nextState.dismissalReason?.trim()){setError('Choose a dismissal reason or explain why the finding is being dismissed.');dismissControl.current?.focus();return;}
  setBusy(true);setError('');
  try{const r=await fetch('/api/issue-reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({siteId,runId,issueId,baseVersion:review.version,state:nextState,note})}),d=await r.json();if(!r.ok)throw new Error(d.error);onSaved(d,advance);}
  catch(e){setError(e instanceof Error?e.message:'Unable to save review.');}finally{setBusy(false);}
 }
 return <div className="review-overlay" onKeyDown={e=>{
  if(e.key==='Escape'&&!busy)onClose();
  if(e.key==='Tab'){
   const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary')||[]).filter(item=>item.getClientRects().length>0);
   if(!items?.length)return;const first=items[0],last=items[items.length-1];
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
   else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  }
 }}>
  <div className="review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-title" ref={dialog}>
   <header><div><p className="eyebrow">ANALYST REVIEW</p><h2 id="review-title">{name}</h2></div><button ref={close} className="secondary-btn" disabled={busy} onClick={onClose}>Close</button></header>
   {!state&&!error&&<p role="status">Loading review…</p>}
   {readOnly&&<p className="review-notice">This is a saved analysis. Review history is current; select Current data history to make a new review.</p>}
   {changed&&<div className="review-notice"><strong>Reassessment needed</strong><ul>{(review?.assessment?.changes||['Evidence changed since the last review.']).map((message,i)=><li key={i}>{message}</li>)}</ul><p>Earlier decisions and notes are retained. Saving applies your assessment to this version.</p></div>}
   {review?.assessment?.retained&&<p className="review-notice">Small numerical changes only. Your previous decision remains effective; no new review is required.</p>}
   {review?.inheritedFrom&&<p className="review-notice">This occurrence inherits the recurring issue review. Saving here creates an individual exception. <button className="secondary-btn" onClick={()=>onParentReview?.(review.inheritedFrom!.id)}>Open recurring issue review</button></p>}
   {summary?.recurring&&<p className="review-notice">{summary.recurring.dates.length} affected local dates · {summary.recurring.occurrenceCount} occurrences · {(summary.recurring.activeMinutes/60).toLocaleString(undefined,{maximumFractionDigits:2})} active hours. {summary.recurring.sequenceStatus}. This review covers the complete saved episode, including occurrences outside current display filters. Individual reviews remain exceptions. Ending a sequence does not automatically resolve the problem.</p>}
   {summary&&<section className="review-evidence" aria-label="Finding evidence">
    <strong>{summary.equipmentName}</strong><p>{local(summary.startDateTime)} — {local(summary.endDateTime)} ({timezone})</p>
    <div className="review-evidence-metrics"><div><span>Actual production</span><strong>{energy(summary.actualEnergyKwh)}</strong></div><div><span>Expected production</span><strong>{energy(summary.expectedEnergyKwh)}</strong></div><div><span>Estimated loss</span><strong>{energy(summary.estimatedLossKwh)}</strong></div></div>
    <p>{summary.description}</p>
    {summary.suspectedCause&&<p>Suggested cause: {summary.suspectedCause}. {summary.causeExplanation} Operational classification stays Unknown until you choose otherwise.</p>}
    {(summary.lossUnknown||summary.productionUnknown)&&<p>Data limitations prevent a reliable quantified loss. Unknown loss is excluded from energy totals.</p>}
   </section>}
   {summary?.hasSharedReduction&&<SharedReductionEvidence key={url} url={url} timezone={timezone}/>}
   {maintenanceContext.map(({window:w,coverage})=><section className="review-notice" key={w.id}><strong>{w.state.title} · {coverage==='full'?'Full maintenance coverage':'Partial maintenance overlap'}</strong><p>{formatDateTime(w.state.startAt,w.state.timezone)} — {formatDateTime(w.state.endAt,w.state.timezone)} ({w.state.timezone})</p><p className="preserve-notes">{w.state.notes}</p><p>This is operational context only. The original finding and loss remain unchanged.{coverage!=='full'?' The window does not cover the complete finding.':''}</p></section>)}
   {legacyClassification&&!readOnly&&<p className="review-notice">The previous classification, “{legacyClassification}”, is retained in review history. Choose a classification from the updated list; saving uses the selected value.</p>}
   {related.length>0&&<details className="review-notice"><summary>Earlier overlapping findings have retained reviews</summary>{related.map(r=><div key={r.event_key}><strong>{r.state.status} · {r.state.classification}</strong><p>{local(r.state.issue.startDateTime)} — {local(r.state.issue.endDateTime)}</p><p>{r.note||r.state.resolutionNote||'No note recorded.'}</p></div>)}<p>Changed event boundaries need a fresh review; earlier decisions are not applied automatically.</p></details>}
   {state&&!readOnly&&<div className="review-quick-actions"><button className="primary-btn" disabled={busy} onClick={()=>void save('Confirmed')}>Confirm finding</button><button className="secondary-btn" disabled={busy} onClick={()=>{setState({...state,status:'Dismissed'});setTimeout(()=>dismissControl.current?.focus(),0);}}>Dismiss…</button><p>Confirmation accepts the finding. Its cause can remain Unknown.</p></div>}
   {state&&<fieldset disabled={busy||readOnly}>
    <div className="review-form-grid">
     <label>Finding status<select value={state.status} onChange={e=>setState({...state,status:e.target.value})}>{reviewStatuses.map(v=><option key={v}>{v}</option>)}</select></label>
     <label>Operational classification{legacyClassification&&readOnly?<input readOnly value={legacyClassification}/>:<select value={state.classification} onChange={e=>setState({...state,classification:e.target.value})}>{operationalCauses.map(v=><option key={v}>{v}</option>)}</select>}</label>
     <label>Resolution<select value={state.resolution} onChange={e=>changeResolution(e.target.value)}><option>Open</option><option>Resolved</option></select></label>
     {state.resolution==='Resolved'&&<label>Resolved at ({timezone})<input type="datetime-local" step={resolvedLocal.includes('.')?'0.001':'1'} value={resolvedLocal} onChange={e=>changeResolutionTime(e.target.value)} aria-invalid={!!timeError} aria-describedby="resolution-time-help"/></label>}
     {state.resolution==='Resolved'&&timeOptions.length>1&&<label>Time occurrence<select value={state.resolvedAt} onChange={e=>setState({...state,resolvedAt:e.target.value})}><option value="" disabled>Choose an occurrence</option>{timeOptions.map(option=><option key={option.timestamp} value={option.timestamp}>{option.label}</option>)}</select></label>}
    </div>
    {state.status==='Dismissed'&&<div className="review-reason"><label>Dismissal reason<select ref={dismissControl} value={dismissReason} onChange={e=>{const value=e.target.value;setDismissReason(value);setState({...state,dismissalReason:value==='Other'?'':value});}}><option value="">Choose a reason</option>{dismissalReasons.map(v=><option key={v}>{v}</option>)}</select></label>{dismissReason==='Other'&&<label>Explain dismissal<textarea maxLength={10000} value={state.dismissalReason||''} onChange={e=>setState({...state,dismissalReason:e.target.value})}/></label>}<p>Dismissal excludes this finding from reported loss. A real loss from maintenance or curtailment should be classified and retained.</p></div>}
    {state.resolution==='Resolved'&&<>
     <p id="resolution-time-help">{timeError||`Defaults to the recorded issue end time. Times are shown in ${timezone}; adjust if needed.`}</p>
     <label>Resolution reason<select value={resolutionReason} onChange={e=>{const value=e.target.value;setResolutionReason(value);setState({...state,resolutionNote:value==='Other'?'':value});}}><option value="">Choose a reason</option>{resolutionReasons.map(v=><option key={v}>{v}</option>)}</select></label>
     {resolutionReason==='Other'&&<label>Resolution note<textarea maxLength={5000} value={state.resolutionNote} onChange={e=>setState({...state,resolutionNote:e.target.value})}/></label>}
    </>}
    <details className="review-confidence"><summary>Confidence assessment · edit only if needed</summary><p>Assess the observed anomaly, its cause, and the loss estimate separately. These levels are judgments, not statistical confidence intervals.</p>
    {(['anomaly','cause','loss'] as const).map(key=><div className="confidence-assessment" key={key}>
     <label>{key==='anomaly'?'Observed anomaly':key==='cause'?'Operational cause':'Estimated loss'}<select value={state.confidence[key].level} onChange={e=>setState({...state,confidence:{...state.confidence,[key]:{...state.confidence[key],level:e.target.value}}})}>{confidenceLevels.map(v=><option key={v}>{v}</option>)}</select></label>
     <label>Reason<textarea maxLength={2000} value={state.confidence[key].reason} onChange={e=>setState({...state,confidence:{...state.confidence,[key]:{...state.confidence[key],reason:e.target.value}}})}/></label>
    </div>)}
    </details>
    <details className="review-extra-note"><summary>Add a note (optional)</summary><label>Additional context<textarea maxLength={10000} value={note} onChange={e=>setNote(e.target.value)} placeholder="Additional operational evidence or context"/></label></details>
   </fieldset>}
   {error&&<p role="alert" className="import-error">{error}</p>}
   {state&&!readOnly&&<footer>{hasNext&&<button disabled={busy} className="secondary-btn" onClick={()=>void save(state.status==='Unreviewed'?'Confirmed':undefined,true)}>{state.status==='Unreviewed'?'Confirm & next':'Save & next'}</button>}<button disabled={busy} className="primary-btn" onClick={()=>void save()}>{busy?'Saving…':state.status==='Dismissed'?'Save dismissal':'Save review'}</button></footer>}
   {hasNext&&!readOnly&&<p className="review-next-help">Next opens the next unreviewed or changed finding in your current filtered list.</p>}
   <details className="review-audit"><summary>Review history ({review?.version||0} changes)</summary>
    {!audit.length&&<p>No saved review yet.</p>}
    {audit.map(a=>{const s=JSON.parse(a.state);return <article key={a.version}>
     <strong>{s.status} · {s.classification} · {s.resolution}</strong><small>{new Date(a.created_at).toLocaleString()} · {a.actor} · revision {a.version}</small><p>{a.note||'Review fields updated.'}</p>
     {s.resolution==='Resolved'&&s.resolvedAt&&<p>Resolved at ({timezone}): {resolutionLocalTime(s.resolvedAt,timezone).replace('T',' ')}</p>}
     {s.dismissalReason&&<p>Dismissal: {s.dismissalReason}</p>}
     {s.resolutionNote&&<p>Resolution: {s.resolutionNote}</p>}
     <details><summary>Recorded confidence and analysis</summary><p>Analysis {a.run_id}</p>{(['anomaly','cause','loss'] as const).map(k=><p key={k}>{k}: {s.confidence?.[k]?.level} — {s.confidence?.[k]?.reason}</p>)}</details>
    </article>;})}
    {next&&<button className="secondary-btn" disabled={busy} onClick={more}>Earlier changes</button>}
   </details>
  </div>
 </div>;
}
