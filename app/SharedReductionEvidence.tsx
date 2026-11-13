"use client";
import {useState} from 'react';
import {formatDateTime} from './issue-date-format';
import type {SharedEvidenceRow,SharedEvidenceInterval} from './shared-reduction-evidence';
const energy=(v:number)=>v.toLocaleString(undefined,{maximumFractionDigits:2});
function IntervalEvidence({url,timezone}:{url:string;timezone:string}){
 const [items,setItems]=useState<SharedEvidenceInterval[]>([]),[next,setNext]=useState<number|null>(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function load(){if(busy||next===null)return;setBusy(true);setError('');try{const r=await fetch(`${url}&offset=${next}`),d=await r.json();if(!r.ok)throw new Error(d.error);setItems(p=>[...p,...d.intervals]);setNext(d.next);}catch(e){setError(e instanceof Error?e.message:'Unable to load interval evidence.');}finally{setBusy(false);}}
 return <details onToggle={e=>{if(e.currentTarget.open&&!items.length)void load();}}><summary>View contributing intervals</summary>
  <div className="review-table-wrap"><table className="review-evidence-table"><thead><tr><th>Interval start ({timezone})</th><th>Minutes</th><th>Healthy expected kWh</th><th>Actual kWh</th><th>Shared loss kWh</th><th>Additional loss kWh</th></tr></thead><tbody>{items.map(p=><tr key={p.timestamp}><td>{formatDateTime(p.timestamp,timezone)}</td><td>{p.intervalMinutes}</td><td>{energy(p.expectedKwh)}</td><td>{energy(p.actualKwh)}</td><td>{energy(p.sharedLossKwh)}</td><td>{energy(p.additionalLossKwh)}</td></tr>)}</tbody></table></div>
  {busy&&<p role="status">Loading intervals…</p>}{error&&<p role="alert">{error}</p>}{next!==null&&!busy&&<button className="secondary-btn" onClick={()=>void load()}>{error?'Retry':'More intervals'}</button>}
 </details>;
}
export default function SharedReductionEvidence({url,timezone}:{url:string;timezone:string}){
 const [rows,setRows]=useState<SharedEvidenceRow[]>([]),[next,setNext]=useState<number|null>(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function load(){if(busy||next===null)return;setBusy(true);setError('');try{const r=await fetch(`${url}&sharedEvidence=1&offset=${next}`),d=await r.json();if(!r.ok)throw new Error(d.error);setRows(p=>[...p,...d.rows]);setNext(d.next);}catch(e){setError(e instanceof Error?e.message:'Unable to load inverter evidence.');}finally{setBusy(false);}}
 return <details className="review-shared-evidence" onToggle={e=>{if(e.target===e.currentTarget&&e.currentTarget.open&&!rows.length)void load();}}><summary>Affected inverter evidence</summary>
  <p>These source findings support this shared site reduction. Their shared losses are already included here; additional inverter losses are counted in separate findings. Only the contributing intervals below are included, even when an original finding spans a longer period. Energy values use the meter / POI delivery boundary.</p>
  {rows.map(row=><article key={row.issueId}><strong>{row.equipmentName}</strong><p>Original finding: {formatDateTime(row.sourceStart,timezone)} — {formatDateTime(row.sourceEnd,timezone)} ({timezone})</p>
   <p>{row.intervalCount} contributing intervals · Shared loss: {energy(row.sharedLossKwh)} kWh · Additional inverter loss: {energy(row.additionalLossKwh)} kWh</p>
   <IntervalEvidence url={`${url}&sharedEvidence=1&event=${encodeURIComponent(row.issueId)}`} timezone={timezone}/>
  </article>)}
  {busy&&<p role="status">Loading inverter evidence…</p>}{error&&<p role="alert">{error}</p>}{next!==null&&!busy&&<button className="secondary-btn" onClick={()=>void load()}>{error?'Retry':'More source findings'}</button>}
 </details>;
}
