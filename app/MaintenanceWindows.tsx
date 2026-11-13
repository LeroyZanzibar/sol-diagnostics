'use client';
import {useCallback,useEffect,useState} from 'react';
import ReviewModal from './ReviewModal';
import {reviewOperationId,expandMaintenanceEquipment,maintenanceMatch,type MaintenanceWindow,type MaintenanceState,type MaintenanceEquipment,type ReviewFinding} from './review-groups';
import {resolutionLocalTime,resolutionTimeOptions,resolutionTimeError} from './issue-review-time';
import {formatDateTime} from './issue-date-format';
export function useMaintenanceWindows(siteId:string){
 const [data,setData]=useState<{siteId:string;windows:MaintenanceWindow[];equipment:MaintenanceEquipment[];timezone:string;retrievedAt:string}>({siteId:'',windows:[],equipment:[],timezone:'UTC',retrievedAt:''}),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 const reload=useCallback(()=>setRevision(n=>n+1),[]);
 useEffect(()=>{const c=new AbortController();setError('');fetch(`/api/maintenance-windows?siteId=${encodeURIComponent(siteId)}`,{signal:c.signal}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.error);if(!c.signal.aborted)setData({...d,siteId});}).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[siteId,revision]);
 const ready=data.siteId===siteId&&!!data.retrievedAt&&!error;
 return {windows:ready?data.windows:[],equipment:ready?data.equipment:[],timezone:ready?data.timezone:'UTC',retrievedAt:ready?data.retrievedAt:'',error,ready,reload};
}
export type MaintenanceData=ReturnType<typeof useMaintenanceWindows>;
function WindowTime({label,value,timezone,onChange}:{label:string;value:string;timezone:string;onChange:(value:string)=>void}){
 const [wall,setWall]=useState(()=>resolutionLocalTime(value,timezone));
 const options=resolutionTimeOptions(wall,timezone),error=wall?resolutionTimeError(wall,timezone,value).replace('resolution date','date'):'';
 return <label>{label} ({timezone})<input type="datetime-local" step="1" value={wall} onChange={e=>{const v=e.target.value,list=resolutionTimeOptions(v,timezone);setWall(v);onChange(list.length===1?list[0].timestamp:'');}}/>{options.length>1&&<select aria-label={`${label} time occurrence`} value={value} onChange={e=>onChange(e.target.value)}><option value="">Choose the time occurrence</option>{options.map(o=><option key={o.timestamp} value={o.timestamp}>{o.label}</option>)}</select>}{error&&<small role="alert">{error}</small>}</label>;
}
function WindowEditor({siteId,window,data,onSaved,onClose}:{siteId:string;window:MaintenanceWindow|null;data:MaintenanceData;onSaved:()=>void;onClose:()=>void}){
 const [id]=useState(()=>window?.id||reviewOperationId()),[changeId]=useState(()=>reviewOperationId());
 const [state,setState]=useState<MaintenanceState>(()=>window?.state||{title:'',startAt:'',endAt:'',timezone:data.timezone,wholeSite:false,equipmentIds:[],equipment:[],notes:'',archived:false}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[attempted,setAttempted]=useState(false),[audit,setAudit]=useState<any[]>([]);
 useEffect(()=>{if(!window)return;const c=new AbortController();fetch(`/api/maintenance-windows?siteId=${encodeURIComponent(siteId)}&id=${encodeURIComponent(window.id)}`,{signal:c.signal}).then(r=>r.json()).then(d=>{if(!c.signal.aborted)setAudit(d.audit||[]);}).catch(()=>{});return()=>c.abort();},[siteId,window]);
 const sameScope=window&&window.state.wholeSite===state.wholeSite&&JSON.stringify([...window.state.equipmentIds].sort())===JSON.stringify([...state.equipmentIds].sort());
 let scope:MaintenanceEquipment[]=[];try{scope=state.wholeSite?[]:sameScope?window!.state.equipment:expandMaintenanceEquipment(state.equipmentIds,data.equipment);}catch{}
 const options=[...data.equipment,...(window?.state.equipment||[]).filter(e=>!data.equipment.some(i=>i.id===e.id))].filter(e=>['revenue_meter','transformer','inverter'].includes(e.type));
 async function save(){setBusy(true);setAttempted(true);setError('');try{const r=await fetch('/api/maintenance-windows',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({siteId,id,changeId,baseVersion:window?.version||0,state})}),d=await r.json();if(!r.ok)throw new Error(d.error);onSaved();}catch(e){setError(e instanceof Error?e.message:'Unable to save window.');}finally{setBusy(false);}}
 return <ReviewModal title={window?'Edit maintenance window':'Record maintenance window'} busy={busy} onClose={onClose}>
  <p>Record the equipment and time once. Matching findings display this context on current and future analyses. A window does not confirm, dismiss, merge or remove losses.</p>
  <fieldset disabled={busy||attempted}>
   <label>Window name<input maxLength={160} value={state.title} onChange={e=>setState({...state,title:e.target.value})} placeholder="Scheduled inverter maintenance"/></label>
   <div className="review-form-grid"><WindowTime label="Start" value={state.startAt} timezone={state.timezone} onChange={startAt=>setState(s=>({...s,startAt}))}/><WindowTime label="End (exclusive)" value={state.endAt} timezone={state.timezone} onChange={endAt=>setState(s=>({...s,endAt}))}/></div>
   <label>Equipment scope<select value={state.wholeSite?'site':'selected'} onChange={e=>setState({...state,wholeSite:e.target.value==='site',equipmentIds:[]})}><option value="selected">Selected equipment</option><option value="site">Entire site</option></select></label>
   {!state.wholeSite&&<div className="maintenance-equipment" role="group" aria-label="Maintenance equipment">{options.map(e=><label className="review-checkbox" key={e.id}><input type="checkbox" checked={state.equipmentIds.includes(e.id)} onChange={ev=>setState({...state,equipmentIds:ev.target.checked?[...state.equipmentIds,e.id]:state.equipmentIds.filter(id=>id!==e.id)})}/>{e.name} <small>{e.type.replaceAll('_',' ')}</small></label>)}</div>}
   <p>{state.wholeSite?'Covers the entire site.':`Covers ${scope.length} equipment items, including the selected meter/transformer’s assigned descendants.`} Equipment assignments are retained as a snapshot. Editing the selected equipment takes a new snapshot.</p>
   {!state.wholeSite&&scope.length>0&&<details><summary>Equipment included</summary><p>{scope.map(e=>e.name).join(', ')}</p></details>}
   <label>Maintenance notes<textarea maxLength={10000} value={state.notes} onChange={e=>setState({...state,notes:e.target.value})}/></label>
   {window&&<label className="review-checkbox"><input type="checkbox" checked={state.archived} onChange={e=>setState({...state,archived:e.target.checked})}/>Archive window (retain history, stop matching findings)</label>}
  </fieldset>
  {error&&<p className="import-error" role="alert">{error} You can retry the same save. Close and reopen to revise details or reload if another analyst changed the window.</p>}
  <footer><button className="primary-btn" disabled={busy||!state.title.trim()||!state.startAt||!state.endAt||(!state.wholeSite&&!scope.length)} onClick={()=>void save()}>{busy?'Saving…':attempted?'Retry saving window':'Save maintenance window'}</button></footer>
  {window&&<details className="review-audit"><summary>Window history · revision {window.version}</summary>{audit.map(a=>{const s=JSON.parse(a.state);return <article key={a.version}><strong>Revision {a.version} · {s.archived?'Archived':s.title}</strong><small>{a.actor} · {a.created_at}</small><p>{formatDateTime(s.startAt,s.timezone)} — {formatDateTime(s.endAt,s.timezone)}</p><p>{s.wholeSite?'Entire site':s.equipment.map((e:MaintenanceEquipment)=>e.name).join(', ')}</p><p>{s.notes||'No note.'}</p></article>;})}</details>}
 </ReviewModal>;
}
export default function MaintenanceWindows({siteId,data,findings,onSelect,readOnly}:{siteId:string;data:MaintenanceData;findings:ReviewFinding[];onSelect:(ids:string[])=>void;readOnly:boolean}){
 const [editing,setEditing]=useState<MaintenanceWindow|null|undefined>(undefined),[archived,setArchived]=useState(false);
 return <details className="maintenance-panel"><summary>Maintenance windows <span>{data.windows.filter(w=>!w.state.archived).length} active</span></summary><p>Reusable operational context. Partial overlaps do not justify classifying the complete finding as maintenance.</p>
  {data.error&&<p role="alert">Maintenance windows unavailable: {data.error} <button className="secondary-btn" onClick={data.reload}>Retry</button></p>}
  {!data.ready&&!data.error&&<p role="status">Loading maintenance windows…</p>}
  <div className="review-actions"><button className="secondary-btn" disabled={!data.ready||readOnly} onClick={()=>setEditing(null)}>Record a maintenance window</button><label className="review-checkbox"><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/>Show archived</label><button className="secondary-btn" onClick={data.reload}>Refresh</button></div>
  {data.windows.filter(w=>archived||!w.state.archived).map(w=>{const full=findings.filter(i=>maintenanceMatch(i,w)==='full'),partial=findings.filter(i=>maintenanceMatch(i,w)==='partial');return <article className="maintenance-window" key={w.id}><div><strong>{w.state.title}{w.state.archived?' · Archived':''}</strong><small>{formatDateTime(w.state.startAt,w.state.timezone)} — {formatDateTime(w.state.endAt,w.state.timezone)} ({w.state.timezone})</small><p>{w.state.wholeSite?'Entire site':w.state.equipment.map(e=>e.name).join(', ')}</p><p className="preserve-notes">{w.state.notes}</p><small>{full.length} fully covered · {partial.length} partially overlapping findings in the current filtered list</small></div><div className="review-actions"><button className="secondary-btn" disabled={readOnly||!full.length} onClick={()=>onSelect(full.map(i=>i.id))}>Select {full.length} fully covered findings</button><button className="secondary-btn" disabled={readOnly} onClick={()=>setEditing(w)}>Edit</button></div></article>;})}
  {editing!==undefined&&<WindowEditor key={editing?.id||'new'} siteId={siteId} window={editing} data={data} onClose={()=>setEditing(undefined)} onSaved={()=>{setEditing(undefined);data.reload();}}/>}
 </details>;
}
