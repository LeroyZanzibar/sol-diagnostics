"use client";
import {useEffect,useRef,useState} from 'react';
import {freshnessLabel,type DataFreshnessStatus} from './data-freshness';

type AnalysisRun={id:string;completed_at?:string|null;created_at?:string|null;status?:string;issue_count?:number|null;timestamp_start?:string|null;timestamp_end?:string|null;source_revision?:number|null;is_current?:boolean;data_freshness?:DataFreshnessStatus|{status:DataFreshnessStatus};parser_version?:number};
type DeleteTarget={run:AnalysisRun;scope:string;siteId:string;currentCleared?:boolean};
function date(value?:string|null){if(!value)return 'Unknown';const parsed=new Date(value);return Number.isFinite(parsed.getTime())?parsed.toLocaleString(): 'Unknown';}
function status(run:AnalysisRun):DataFreshnessStatus{const value=typeof run.data_freshness==='object'?run.data_freshness?.status:run.data_freshness;return value==='current'||value==='older'?value:'unknown';}
async function responseData(response:Response):Promise<Record<string,any>|null>{
 const text=await response.text();try{const value=JSON.parse(text);return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}catch{return null;}
}
function responseError(response:Response,data:Record<string,any>|null,fallback:string){
 if(response.status===401||response.status===403)return 'Access denied. Sign in again and reload analyses.';
 const reasons:Record<string,string>={ANALYSIS_IN_USE:'This analysis is in use by active or resumable work. Wait for it to finish before deleting.',ANALYSIS_NOT_COMPLETED:'Only completed analyses can be deleted.',ANALYSIS_POINTER_CONFLICT:'The published analysis pointer could not be safely identified. Reload analyses before trying again.',INVALID_ANALYSIS_ID:'The site or analysis identifier is invalid.',ANALYSIS_NOT_FOUND:'This analysis was not found for the selected site.'};
 return reasons[String(data?.code)]||(typeof data?.error==='string'?data.error.slice(0,400):fallback);
}
function historyPage(data:Record<string,any>|null):{runs:AnalysisRun[];next:string|null}{
 if(!data||!Array.isArray(data.runs)||data.runs.some(run=>!run||typeof run.id!=='string')||!('next' in data)||(data.next!==null&&typeof data.next!=='string'))throw new Error('Invalid analysis history response.');
 return {runs:data.runs,next:data.next||null};
}
export default function ManageAnalyses({sites,siteId,runId,onSiteChange,onChange,onFindings,onDeleted,revision}:{sites:{id:string;name:string}[];siteId:string;runId:string;onSiteChange:(id:string)=>void;onChange:(id:string)=>void;onFindings:()=>void;onDeleted:(siteId:string,runId:string,currentCleared:boolean)=>void;revision:string}){
 const [runs,setRuns]=useState<AnalysisRun[]>([]),[next,setNext]=useState<string|null>(null),[loading,setLoading]=useState(true),[moreLoading,setMoreLoading]=useState(false),[error,setError]=useState(''),[loadedScope,setLoadedScope]=useState(''),[retry,setRetry]=useState(0);
 const [confirmation,setConfirmation]=useState<DeleteTarget|null>(null),[uncertain,setUncertain]=useState<DeleteTarget|null>(null),[deleting,setDeleting]=useState(false),[deleteError,setDeleteError]=useState(''),[notice,setNotice]=useState('');
 const scope=JSON.stringify([siteId,revision,retry]),currentScope=useRef(scope),controllerRef=useRef<AbortController|null>(null),moreBusy=useRef(false),deleteBusy=useRef(false),listSequence=useRef(0);currentScope.current=scope;
 const deleteAuthorization=useRef<DeleteTarget|null>(null),uncertainRef=useRef<DeleteTarget|null>(null);
 const siteEpoch=useRef({id:siteId,version:0});
 if(siteEpoch.current.id!==siteId)siteEpoch.current={id:siteId,version:siteEpoch.current.version+1};
 const deleteScope=JSON.stringify([siteId,siteEpoch.current.version]),currentDeleteScope=useRef(deleteScope),lifetimeControllerRef=useRef<AbortController|null>(null);currentDeleteScope.current=deleteScope;
 useEffect(()=>{
  const controller=new AbortController();lifetimeControllerRef.current=controller;deleteBusy.current=false;
  deleteAuthorization.current=null;uncertainRef.current=null;setConfirmation(null);setUncertain(null);setDeleting(false);setDeleteError('');setNotice('');
  return()=>controller.abort();
 },[deleteScope]);
 useEffect(()=>{
  const controller=new AbortController();controllerRef.current=controller;const sequence=++listSequence.current;moreBusy.current=false;
  setRuns([]);setNext(null);setError('');setLoading(true);setMoreLoading(false);
  if(!siteId){setLoading(false);return()=>controller.abort();}
  void (async()=>{try{const response=await fetch(`/api/analysis-history?siteId=${encodeURIComponent(siteId)}`,{cache:'no-store',signal:controller.signal});const data=await responseData(response);if(!response.ok)throw new Error(responseError(response,data,'Unable to load analyses.'));const page=historyPage(data);if(controller.signal.aborted||currentScope.current!==scope||sequence!==listSequence.current)return;setRuns(page.runs);setNext(page.next);setLoadedScope(scope);}catch(reason){if(!controller.signal.aborted&&currentScope.current===scope&&sequence===listSequence.current)setError(reason instanceof Error?reason.message:'Unable to load analyses.');}finally{if(!controller.signal.aborted&&currentScope.current===scope&&sequence===listSequence.current)setLoading(false);}})();
  return()=>{controller.abort();};
 },[siteId,scope]);
 async function more(){
  const controller=controllerRef.current;if(!next||moreBusy.current||deleteBusy.current||!controller||controller.signal.aborted||loadedScope!==scope||currentScope.current!==scope)return;
  const sequence=++listSequence.current;moreBusy.current=true;setMoreLoading(true);setError('');
  try{const response=await fetch(`/api/analysis-history?siteId=${encodeURIComponent(siteId)}&before=${encodeURIComponent(next)}`,{cache:'no-store',signal:controller.signal});const data=await responseData(response);if(!response.ok)throw new Error(responseError(response,data,'Unable to load older analyses.'));const page=historyPage(data);if(controller.signal.aborted||currentScope.current!==scope||sequence!==listSequence.current)return;setRuns(previous=>[...new Map([...previous,...page.runs].map(run=>[run.id,run])).values()]);setNext(page.next);}catch(reason){if(!controller.signal.aborted&&currentScope.current===scope&&sequence===listSequence.current)setError(reason instanceof Error?reason.message:'Unable to load older analyses.');}finally{if(currentScope.current===scope&&sequence===listSequence.current){moreBusy.current=false;setMoreLoading(false);}}
 }
 function chooseDelete(run:AnalysisRun){
  if(deleteBusy.current||uncertainRef.current||currentScope.current!==scope||loadedScope!==scope)return;
  setDeleteError('');setNotice('');const target={run,scope:deleteScope,siteId};deleteAuthorization.current=target;setConfirmation(target);
 }
 function stillHere(target:DeleteTarget){return currentDeleteScope.current===target.scope&&!!lifetimeControllerRef.current&&!lifetimeControllerRef.current.signal.aborted;}
 async function verifyDeletion(target:DeleteTarget){
  // History GET for a payload returns generic 404s for storage failures too. Verify exact
  // membership in the authoritative paginated catalogue instead of mistaking 404 for deletion.
  const cursors=new Set<string>();let before:string|null=null,firstPage:{runs:AnalysisRun[];next:string|null}|null=null;
  do{
   // A submitted deletion outlives navigation. Complete its readback for the parent's
   // identity-scoped cache invalidation, but never install old-site UI state.
   const response=await fetch(`/api/analysis-history?siteId=${encodeURIComponent(target.siteId)}${before?`&before=${encodeURIComponent(before)}`:''}`,{cache:'no-store'});
   const data=await responseData(response);
   if(!response.ok)throw new Error(responseError(response,data,'Unable to verify deletion.'));
   const page=historyPage(data);firstPage??=page;
   if(page.runs.some(run=>run.id===target.run.id)){
    if(stillHere(target)){uncertainRef.current=null;setUncertain(null);setConfirmation(null);setDeleteError('Deletion was not confirmed: this analysis is still in saved history. No request was retried.');}return;
   }
   before=page.next;if(before&&cursors.has(before))throw new Error('Unable to verify all analysis history pages.');if(before)cursors.add(before);
  }while(before);
  if(stillHere(target)){
   ++listSequence.current;moreBusy.current=false;setMoreLoading(false);setRuns(firstPage!.runs);setNext(firstPage!.next);setLoadedScope(currentScope.current);setLoading(false);setConfirmation(null);uncertainRef.current=null;setUncertain(null);setDeleteError('');setNotice(`Analysis ${target.run.id} deleted from saved analyses. Source readings and review evidence are retained.`);
  }
  onDeleted(target.siteId,target.run.id,target.currentCleared??target.run.is_current===true);
 }
 async function remove(checkOnly=false){
  const pending=checkOnly?uncertainRef.current:confirmation;
  if(!pending||deleteBusy.current||!stillHere(pending)||(!checkOnly&&(uncertainRef.current||deleteAuthorization.current!==pending)))return;
  if(!checkOnly)deleteAuthorization.current=null;
  const target={...pending};
  deleteBusy.current=true;++listSequence.current;moreBusy.current=false;setMoreLoading(false);setDeleting(true);setDeleteError('');setNotice('');
  try{
   if(!checkOnly){
    let response:Response|undefined,data:Record<string,any>|null=null;
    try{response=await fetch(`/api/analysis-history?siteId=${encodeURIComponent(target.siteId)}&runId=${encodeURIComponent(target.run.id)}`,{method:'DELETE',cache:'no-store'});data=await responseData(response);}catch{/* An interrupted response is an unknown outcome, not permission to replay. */}
    if(response&&!response.ok&&response.status>=400&&response.status<500){if(stillHere(target)){setConfirmation(null);setDeleteError(responseError(response,data,'Unable to delete this analysis. Reload analyses before trying again.'));}return;}
    if(response?.ok&&data?.deleted===true&&data.siteId===target.siteId&&data.runId===target.run.id&&typeof data.currentCleared==='boolean')target.currentCleared=data.currentCleared;
   }
   if(stillHere(target)){uncertainRef.current=target;setUncertain(target);}
   await verifyDeletion(target);
  }catch{if(stillHere(target)){setConfirmation(null);uncertainRef.current=target;setUncertain(target);setDeleteError('Deletion could not be verified. The outcome is uncertain. Check deletion status before trying another deletion.');}}
  finally{if(stillHere(target)){deleteBusy.current=false;setDeleting(false);}}
 }
 const visibleRuns=loadedScope===scope?runs:[],pending=confirmation?.scope===deleteScope?confirmation:null,recovery=uncertain?.scope===deleteScope?uncertain:null;
 return <section className="settings-view manage-analyses" aria-labelledby="manage-analyses-title">
  <header className="settings-header"><div><p className="eyebrow">DATA MANAGEMENT</p><h1 id="manage-analyses-title">Manage Analyses</h1><p>Select a saved analysis for Findings, Summaries and Timeline. Selection does not replace the published current analysis or change saved reviews.</p></div><label className="field">Site<select aria-label="Analysis management site" value={siteId} onChange={event=>{currentScope.current='';currentDeleteScope.current='';onSiteChange(event.target.value);}}>{sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}</select></label></header>
  <div className="analysis-selection-note"><strong>{runId?`Selected snapshot: ${runId}`:'Published current analysis selected'}</strong><p>Unknown freshness means the source-data comparison is unavailable, not that the data is current. Deleting an analysis removes it from saved analyses; source readings and review evidence are retained.</p><button className="secondary-btn" disabled={!runId} onClick={()=>onChange('')}>Use published current</button> <button className="primary-btn" onClick={onFindings}>View Findings</button></div>
  {error&&<div role="alert" className="import-error">{error} <button className="secondary-btn" disabled={deleting||!!recovery} onClick={()=>{if(!deleteBusy.current&&!uncertain)setRetry(value=>value+1);}}>Retry loading analyses</button></div>}
  {deleteError&&<div role="alert" className="import-error">{deleteError}</div>}
  <p role="status" aria-live="polite" aria-atomic="true">{deleting?'Deleting analysis and checking saved history…':notice}</p>
  {recovery&&!deleting&&<button className="secondary-btn" onClick={()=>remove(true)}>Check deletion status</button>}
  {pending&&<section className="analysis-selection-note" role="alertdialog" aria-labelledby="delete-analysis-title" aria-describedby="delete-analysis-detail">
   <h2 id="delete-analysis-title">Delete this analysis?</h2><div id="delete-analysis-detail"><p><strong>{sites.find(site=>site.id===pending.siteId)?.name||pending.siteId}</strong> · Site {pending.siteId}<br/>Analysis {pending.run.id}<br/>Data range: {date(pending.run.timestamp_start)} – {date(pending.run.timestamp_end)}</p>
   {pending.run.is_current&&<p><strong>This is the published current analysis.</strong> Deleting it clears the current result. An older analysis will not be promoted automatically.</p>}
   <p>This removes the analysis from saved analyses and reports. Source readings and review evidence are retained. This action cannot be undone here.</p></div>
   <div className="review-actions"><button autoFocus className="secondary-btn" disabled={deleting} onClick={()=>{if(!deleteBusy.current){deleteAuthorization.current=null;setConfirmation(null);}}}>Cancel</button><button className="primary-btn" disabled={deleting} onClick={()=>remove()}>{deleting?'Deleting…':'Delete analysis'}</button></div>
  </section>}
  {!siteId?<p>Select a site to manage analyses.</p>:loading?<p role="status">Loading analyses…</p>:!visibleRuns.length&&!error?<p>No saved analyses for this site. Run an analysis from Findings after importing performance data.</p>:null}
  {!!visibleRuns.length&&<div className="table-wrap"><table className="analysis-history-table"><thead><tr><th>Analysis</th><th>Data date range</th><th>Run time</th><th>Status</th><th>Findings</th><th>Data revision</th><th>Data freshness</th><th>Selection</th><th>Actions</th></tr></thead><tbody>{visibleRuns.map(run=>{const selected=runId?run.id===runId:run.is_current===true;return <tr key={run.id} className={selected?'selected-analysis':''}><td><strong>{run.id}</strong>{run.is_current&&<small>Published current</small>}</td><td>{date(run.timestamp_start)} – {date(run.timestamp_end)}</td><td>{date(run.completed_at||run.created_at)}</td><td>{run.status||'Completed'}</td><td>{run.issue_count??'Unknown'}</td><td>{run.source_revision??'Unknown'}</td><td><span className={`freshness-badge ${status(run)}`}>{freshnessLabel(status(run))}</span></td><td><button className="secondary-btn" aria-pressed={selected} disabled={selected} onClick={()=>{if(!selected&&currentScope.current===scope&&loadedScope===scope)onChange(run.is_current?'':run.id)}}>{selected?(runId?'Selected snapshot':'Selected current'):'Select analysis'}</button></td><td><button className="secondary-btn" aria-label={`Delete analysis ${run.id}`} disabled={deleting||!!recovery} onClick={()=>chooseDelete(run)}>Delete</button></td></tr>;})}</tbody></table></div>}
  {next&&loadedScope===scope&&<button className="secondary-btn" disabled={moreLoading||deleting||!!recovery} onClick={more}>{moreLoading?'Loading older analyses…':'Older analyses'}</button>}
 </section>;
}
