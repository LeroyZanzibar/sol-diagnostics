'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {mappedMaintenanceRows,suggestedMaintenanceMappings,SKIP_MAINTENANCE_SITE,type MaintenanceCalendar,type MaintenanceImportRow,type MaintenanceSite} from './maintenance-data';

type StoredSite={siteId:string;name:string;rowCount:number;firstDate:string;lastDate:string};
type Preview={fileName:string;fileSize:number;sheetName:string;rows:MaintenanceImportRow[];errors:string[];invalidCount:number;total:number};
export default function MaintenanceUploads({sites,notify,onTimeline,onImported}:{sites:MaintenanceSite[];notify:(text:string)=>void;onTimeline:(siteId:string)=>void;onImported:()=>void}){
  const [calendar,setCalendar]=useState<MaintenanceCalendar|null>(null),[storedSites,setStoredSites]=useState<StoredSite[]>([]),[ready,setReady]=useState(false),[loadError,setLoadError]=useState('');
  const [preview,setPreview]=useState<Preview|null>(null),[mappings,setMappings]=useState<Record<string,string>>({}),[busy,setBusy]=useState(''),[error,setError]=useState(''),[page,setPage]=useState(0),[revision,setRevision]=useState(0);
  const generation=useRef(0),attempt=useRef<{signature:string;revision:string}|null>(null),fileInput=useRef<HTMLInputElement>(null);
  useEffect(()=>{const controller=new AbortController();setReady(false);setLoadError('');fetch('/api/maintenance-data',{signal:controller.signal}).then(async response=>{const data=await response.json();if(!response.ok)throw Error(data.error);if(!controller.signal.aborted){setCalendar(data.calendar);setStoredSites(data.sites);setReady(true);}}).catch(e=>{if(!controller.signal.aborted)setLoadError(e.message);});return()=>controller.abort();},[revision]);
  useEffect(()=>()=>{generation.current++;},[]);
  const matched=useMemo(()=>mappedMaintenanceRows(preview?.rows||[],mappings,sites),[preview,mappings,sites]);
  const sourceNames=useMemo(()=>[...new Set(preview?.rows.map(r=>r.sourceSite)||[])].sort((a,b)=>a.localeCompare(b)),[preview]);
  const siteCounts=useMemo(()=>{const counts=new Map<string,number>();preview?.rows.forEach(r=>counts.set(r.sourceSite,(counts.get(r.sourceSite)||0)+1));return counts;},[preview]);
  async function chooseFile(file:File){
    const token=++generation.current;setBusy('Reading calendar…');setError('');setPreview(null);setPage(0);attempt.current=null;
    try{const {readMaintenanceFile}=await import('./maintenance-file');const parsed=await readMaintenanceFile(file);if(token!==generation.current)return;setPreview({...parsed,fileName:file.name,fileSize:file.size});setMappings(suggestedMaintenanceMappings(parsed.rows,sites,calendar?.mappings));}
    catch(e){if(token===generation.current)setError(e instanceof Error?e.message:'Unable to read this calendar.');}
    finally{if(token===generation.current)setBusy('');}
  }
  async function save(){
    if(!preview||!ready)return;setBusy('Saving maintenance data…');setError('');
    try{
      const body={baseRevision:calendar?.revision||'',fileName:preview.fileName,fileSize:preview.fileSize,rows:preview.rows,mappings};
      const signature=JSON.stringify(body);
      if(attempt.current?.signature!==signature){
        const revision=typeof crypto.randomUUID==='function'?crypto.randomUUID():[...crypto.getRandomValues(new Uint8Array(16))].map(value=>value.toString(16).padStart(2,'0')).join('');
        attempt.current={signature,revision};
      }
      const response=await fetch('/api/maintenance-data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,revision:attempt.current.revision})});const data=await response.json();if(!response.ok)throw Error(data.error);setCalendar(data.calendar);setPreview(null);attempt.current=null;if(fileInput.current)fileInput.current.value='';setRevision(v=>v+1);onImported();notify(`Imported ${data.calendar.rowCount.toLocaleString()} maintenance tasks across ${data.calendar.siteCount} sites.`);}
    catch(e){setError(e instanceof Error?e.message:'Unable to save maintenance data. Retry the same upload.');}
    finally{setBusy('');}
  }
  return <section className="upload-view maintenance-upload-view" aria-labelledby="maintenance-upload-title">
    <header className="settings-header upload-header"><div><p className="eyebrow">DATA OPERATIONS</p><h1 id="maintenance-upload-title">Maintenance data</h1><p>Import one maintenance calendar for all sites. Dates and tasks appear on the Timeline.</p></div></header>
    <section className="panel maintenance-current"><div><p className="eyebrow">CURRENT CALENDAR</p><h2>{calendar?.fileName||'No maintenance calendar uploaded'}</h2>{calendar&&<p>{calendar.rowCount.toLocaleString()} tasks · {calendar.siteCount} sites · Imported {new Date(calendar.importedAt).toLocaleString()}</p>}{!ready&&!loadError&&<p role="status">Loading current calendar…</p>}</div><button className="secondary-btn" disabled={!!busy} onClick={()=>{setPreview(null);setRevision(v=>v+1);}}>Refresh</button></section>
    {loadError&&<p className="import-error" role="alert">{loadError}</p>}
    <section className="panel maintenance-import-panel">
      <div className="panel-head"><div><h2>{calendar?'Replace maintenance calendar':'Upload maintenance calendar'}</h2><p>A new upload replaces all previously imported maintenance dates. Manually recorded maintenance windows are preserved.</p></div><a className="secondary-btn" href="/maintenance-template.csv" download>CSV template</a></div>
      <label className={`maintenance-file-input ${busy?'is-busy':''}`}><span>Choose a CSV or Excel calendar</span><small>Required columns: Date, Site, Task · CSV or .xlsx · Up to 10 MB and 5,000 rows</small><input ref={fileInput} aria-label="Maintenance calendar file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={!ready||!!busy} onChange={e=>{const file=e.target.files?.[0];if(file)void chooseFile(file);e.target.value='';}}/></label>
      <p className="maintenance-format-help">Use YYYY-MM-DD or US MM/DD/YYYY dates. Excel dates are also supported. Each entry marks a calendar date at the site; it does not imply a full day of downtime.</p>
      {busy&&<p role="status" className="maintenance-save-status">{busy}</p>}
      {error&&<p role="alert" className="import-error">{error}</p>}
      {preview&&<>
        <div className="maintenance-preview-head"><h3>{preview.fileName}</h3><span>{preview.total.toLocaleString()} source rows · {sourceNames.length} site names</span></div>
        {!!preview.invalidCount&&<div className="maintenance-import-errors" role="alert"><strong>{preview.invalidCount} rows need correction in the source file.</strong><ul>{preview.errors.map(message=><li key={message}>{message}</li>)}</ul><p>Correct these rows and choose the file again. Nothing has been imported.</p></div>}
        <details className="maintenance-matching" open={matched.unmatched.length>0?true:undefined}><summary>Match site names <span>{matched.unmatched.length?`${matched.unmatched.length} need a match or explicit skip`:'All site names resolved'}</span></summary><p>Exact names match automatically. Choose a configured site for each other name, or skip sites outside Diagnostics. Choices are remembered for the next calendar.</p><div className="maintenance-match-list">{sourceNames.map(name=><label key={name}><span><strong>{name}</strong><small>{siteCounts.get(name)} rows</small></span><select aria-label={`Match ${name}`} value={mappings[name]||''} disabled={!!busy} onChange={e=>{setMappings(current=>({...current,[name]:e.target.value}));setPage(0);}}><option value="">Choose a site…</option><option value={SKIP_MAINTENANCE_SITE}>Skip this site</option>{sites.map(site=><option value={site.id} key={site.id}>{site.name}</option>)}</select></label>)}</div></details>
        <div className="maintenance-preview-head"><h3>Import preview</h3><span>{matched.entries.length.toLocaleString()} tasks to import · {matched.skipped} skipped · {matched.duplicates} exact duplicates removed</span></div>
        <div className="maintenance-preview-table"><table><thead><tr><th>Date</th><th>Matched site</th><th>Task</th></tr></thead><tbody>{matched.entries.slice(page*20,(page+1)*20).map((row,index)=><tr key={`${row.row}-${index}`}><td><time dateTime={row.date}>{row.date}</time></td><td>{sites.find(site=>site.id===row.siteId)?.name}</td><td>{row.task}</td></tr>)}</tbody></table>{!matched.entries.length&&<p>Match at least one site to preview its tasks.</p>}</div>
        {matched.entries.length>20&&<div className="maintenance-pagination"><button className="secondary-btn" disabled={!page} onClick={()=>setPage(p=>p-1)}>Previous</button><span>Page {page+1} of {Math.ceil(matched.entries.length/20)}</span><button className="secondary-btn" disabled={(page+1)*20>=matched.entries.length} onClick={()=>setPage(p=>p+1)}>Next</button></div>}
        <footer className="maintenance-import-actions"><p>Maintenance annotations do not change issue classifications, reviews, or calculated losses.</p><button className="primary-btn" onClick={()=>void save()} disabled={!!busy||!ready||!!preview.invalidCount||!!matched.unmatched.length||!matched.entries.length}>{busy?'Working…':calendar?'Replace calendar':'Import maintenance data'}</button></footer>
      </>}
    </section>
    {!!storedSites.length&&<section className="panel maintenance-import-panel"><div className="panel-head"><h2>Maintenance by site</h2></div><div className="maintenance-preview-table"><table><thead><tr><th>Site</th><th>Tasks</th><th>Date range</th><th></th></tr></thead><tbody>{storedSites.map(site=><tr key={site.siteId}><td>{site.name||site.siteId}</td><td>{site.rowCount}</td><td>{site.firstDate} – {site.lastDate}</td><td><button className="secondary-btn" onClick={()=>onTimeline(site.siteId)}>View timeline</button></td></tr>)}</tbody></table></div></section>}
  </section>;
}
