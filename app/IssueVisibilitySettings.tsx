'use client';
import {useEffect,useState,type FormEvent} from 'react';
import {defaultIssueVisibility,issueVisibilityOptions,type IssueVisibility} from './issue-visibility';

export default function IssueVisibilitySettings({value,ready,error,onRetry,onSave,onBack}:{value:IssueVisibility;ready:boolean;error:string;onRetry:()=>void;onSave:(value:IssueVisibility)=>Promise<void>;onBack:()=>void}){
 const [draft,setDraft]=useState(value),[busy,setBusy]=useState(false),[saveError,setSaveError]=useState('');
 useEffect(()=>{setDraft(value);},[value]);
 const changed=issueVisibilityOptions.some(option=>draft[option.key]!==value[option.key]);
 const enabled=issueVisibilityOptions.filter(option=>draft[option.key]).length;
 async function save(event:FormEvent){
  event.preventDefault();if(!ready||busy||!changed)return;
  setBusy(true);setSaveError('');try{await onSave(draft);}catch(e){setSaveError(e instanceof Error?e.message:'Unable to save issue visibility.');}finally{setBusy(false);}
 }
 return <section className="settings-view issue-visibility-view" aria-labelledby="issue-visibility-title">
  <header className="settings-header"><div><p className="eyebrow">USER SETTINGS</p><h1 id="issue-visibility-title">Issue visibility</h1><p>Choose which issue types appear across all sites.</p></div><div className="settings-header-actions"><button className="secondary-btn" onClick={onBack}>← Profile & preferences</button></div></header>
  <div className="user-settings-layout"><form className="settings-form panel user-settings-form" onSubmit={save}>
   <div className="form-heading"><div><p className="eyebrow">DISPLAY PREFERENCES</p><h2>Visible issue types</h2><p>Applies to Performance Issues, analyst review, Summaries, Timeline, and exports, including saved analyses.</p></div><span className="saved-indicator"><i/>Saved across sessions</span></div>
   {error?<div className="visibility-load-notice" role="alert">{error} <button type="button" className="secondary-btn" onClick={onRetry}>Retry loading preferences</button></div>:!ready?<p className="visibility-load-notice" role="status">Loading saved preferences…</p>:null}
   <fieldset className="visibility-fieldset" disabled={!ready||busy}>
    <legend className="visibility-sr-only">Issue type visibility switches</legend>
    <div className="visibility-options-toolbar"><span>{enabled} of {issueVisibilityOptions.length} types enabled{changed?' · Unsaved changes':''}</span><button type="button" className="secondary-btn" disabled={enabled===issueVisibilityOptions.length} onClick={()=>setDraft({...defaultIssueVisibility})}>Show all issue types</button></div>
    <div className="visibility-options">{issueVisibilityOptions.map(option=><div className="visibility-option" key={option.key}>
     <div><strong id={`visibility-${option.key}`}>{option.label}</strong><p id={`visibility-help-${option.key}`}>{option.description}</p></div>
     <div className="visibility-toggle"><span aria-hidden="true">{draft[option.key]?'Shown':'Hidden'}</span><button type="button" className="visibility-switch" role="switch" aria-checked={draft[option.key]} aria-labelledby={`visibility-${option.key}`} aria-describedby={`visibility-help-${option.key}`} onClick={()=>setDraft(current=>({...current,[option.key]:!current[option.key]}))}><span/></button></div>
    </div>)}</div>
   </fieldset>
   <p className="visibility-explanation">Hidden findings remain in the saved analysis with their losses, notes, and review decisions. These preferences filter what you see; they do not change detection or calculations. Visible totals and exports follow your saved choices.</p>
   {saveError&&<p className="visibility-load-notice" role="alert">{saveError}</p>}
   <footer className="form-actions"><button type="button" className="secondary-btn" disabled={busy||!changed} onClick={()=>{setDraft(value);setSaveError('');}}>Discard changes</button><button className="primary-btn save-btn" disabled={!ready||busy||!changed}>{busy?'Saving…':'Save issue visibility'}<span aria-hidden="true">✓</span></button></footer>
  </form></div>
 </section>;
}
