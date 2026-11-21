"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {type MonthlyConfiguration,type UtilityValues,validateUtilityRows,validateConfiguration} from './monthly-domain.mjs';
import type {MonthlySnapshot,MonthlyPreview} from './monthly-types';

const guards=new Map<symbol,()=> 'busy'|'dirty'|false>();
export function confirmMonthlyNavigation(){
  const states=[...guards.values()].map(check=>check());
  if(states.includes('busy')){window.alert('Wait for the monthly operation to finish before leaving.');return false;}
  return !states.includes('dirty')||window.confirm('Discard unsaved monthly changes?');
}
export async function monthlyRequest(siteId:string,body?:Record<string,unknown>){
  const response=await fetch(body?'/api/monthly-data':`/api/monthly-data?siteId=${encodeURIComponent(siteId)}`,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify({...body,siteId}):undefined,cache:'no-store'});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{throw Error(`Monthly response unavailable (${response.status}).`);}
  if(!response.ok)throw Object.assign(Error(data.error||'Monthly request failed.'),{status:response.status});
  if(data.siteId!==siteId)throw Error('Monthly response belongs to a different site.');return data;
}
export function useMonthly(siteId:string){
  const [snapshot,setSnapshot]=useState<MonthlySnapshot|null>(null),[editing,setEditing]=useState(false),[refreshing,setRefreshing]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [configuration,setConfiguration]=useState<MonthlyConfiguration|null>(null),[utility,setUtility]=useState<Record<string,UtilityValues>>({}),[preview,setPreview]=useState<MonthlyPreview|null>(null),[uncertain,setUncertain]=useState(false);
  const live=useRef(true),request=useRef(0),lock=useRef(false),draft=useRef(false),dirty=useRef(false);
  useEffect(()=>{dirty.current=editing&&!!snapshot&&(JSON.stringify(configuration)!==JSON.stringify(snapshot.configuration)||JSON.stringify(utility)!==JSON.stringify(snapshot.utility));},[editing,snapshot,configuration,utility]);
  const accept=useCallback((data:MonthlySnapshot)=>{setSnapshot(data);setConfiguration(structuredClone(data.configuration));setUtility(structuredClone(data.utility));},[]);
  const load=useCallback(async()=>{const seq=++request.current;setRefreshing(true);try{const data=await monthlyRequest(siteId);if(live.current&&seq===request.current&&!draft.current){accept(data);setError('');}}catch(reason){if(live.current&&seq===request.current)setError(reason instanceof Error?reason.message:'Unable to load monthly data.');}finally{if(live.current&&seq===request.current)setRefreshing(false);}},[siteId,accept]);
  useEffect(()=>{
    live.current=true;const id=Symbol(siteId);guards.set(id,()=>lock.current?'busy':dirty.current?'dirty':false);
    const leave=(event:BeforeUnloadEvent)=>{if(dirty.current||lock.current){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',leave);void Promise.resolve().then(load);const timer=window.setInterval(()=>{if(!draft.current&&!lock.current)void load();},15000);
    return ()=>{live.current=false;guards.delete(id);window.removeEventListener('beforeunload',leave);window.clearInterval(timer);};
    // Exact site identity is also the parent's component key.
  },[siteId,load]);
  function edit(){if(!snapshot||lock.current)return;request.current++;setRefreshing(false);draft.current=true;setEditing(true);setError('');setNotice('');setPreview(null);setUncertain(false);}
  function cancel(){if(lock.current||dirty.current&&!window.confirm('Discard unsaved monthly changes?'))return;if(snapshot)accept(snapshot);draft.current=false;dirty.current=false;setEditing(false);setPreview(null);setError('');setUncertain(false);}
  function updateConfiguration(next:MonthlyConfiguration){if(lock.current)return;dirty.current=true;setConfiguration(next);setPreview(null);}
  function updateUtility(month:string,field:keyof UtilityValues,value:string){if(lock.current)return;dirty.current=true;setUtility(current=>({...current,[month]:{...(current[month]||{onPeak:null,offPeak:null,unpaidEnergy:null,revenue:null,energyUsed:null,invoiceCost:null}),[field]:value||null}}));}
  async function review(){if(!snapshot||!configuration||lock.current)return;lock.current=true;setBusy(true);setError('');try{const config=validateConfiguration(configuration);const p=await monthlyRequest(siteId,{action:'preview',revision:snapshot.revision,configuration:config});if(live.current)setPreview(p);}catch(reason){if(live.current)setError(reason instanceof Error?reason.message:'Unable to review changes.');}finally{lock.current=false;if(live.current)setBusy(false);}}
  async function save(kind:'utility'|'configuration'){
    if(!snapshot||!configuration||lock.current||uncertain||kind==='configuration'&&!preview)return;
    const revision=snapshot.revision;
    let rows:Array<UtilityValues&{month:string}>=[],config:MonthlyConfiguration;
    try{config=validateConfiguration(configuration);if(kind==='utility'){
      rows=Object.entries(utility).filter(([month,row])=>JSON.stringify(row)!==JSON.stringify(snapshot.utility[month])).map(([month,row])=>({month,...row}));
      if(!rows.length){draft.current=false;dirty.current=false;setEditing(false);setNotice('No changes to save.');return;}rows=validateUtilityRows(rows);
    }}catch(reason){setError(reason instanceof Error?reason.message:'Invalid monthly input.');return;}
    lock.current=true;setBusy(true);setError('');setNotice('');request.current++;
    try{
      let acknowledgement:unknown;
      try{acknowledgement=await monthlyRequest(siteId,kind==='utility'?{action:kind,revision,rows}:{action:kind,revision,configuration:config,previewToken:preview!.token});}
      catch(reason){const status=(reason as {status?:number}).status;if(status&&status>=400&&status<500)throw reason;}
      const readback=await monthlyRequest(siteId) as MonthlySnapshot;
      const matches=kind==='utility'?rows.every(({month,...values})=>JSON.stringify(readback.utility[month])===JSON.stringify(values)):JSON.stringify(readback.configuration)===JSON.stringify(config);
      if(!matches||readback.revision!==revision+1)throw Object.assign(Error(acknowledgement?'Saved state changed before verification. Reload before making further edits.':'Save outcome is uncertain. Reload saved data before retrying; do not assume rollback.'),{uncertain:true});
      if(live.current){accept(readback);draft.current=false;dirty.current=false;setEditing(false);setPreview(null);setUncertain(false);setNotice('Saved and verified from storage.');}
    }catch(reason){if(live.current){const status=(reason as {status?:number}).status;setUncertain(!status||status>=500);setError(`${reason instanceof Error?reason.message:'Unable to verify saved data.'}${!status||status>=500?' Save outcome may be unknown; reload saved data to check.':''}`);}}
    finally{lock.current=false;if(live.current)setBusy(false);}
  }
  async function reload(){if(lock.current||dirty.current&&!window.confirm('Discard this draft and reload authoritative saved data?'))return;draft.current=false;dirty.current=false;setEditing(false);setPreview(null);setUncertain(false);await load();}
  return {snapshot,editing,refreshing,busy,error,notice,configuration,utility,preview,uncertain,edit,cancel,review,save,reload,updateConfiguration,updateUtility,setPreview};
}
