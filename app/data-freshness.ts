"use client";
import {useEffect,useRef,useState} from 'react';

export type DataFreshnessStatus='current'|'older'|'unknown';
export type DataFreshnessFilter='all'|'current'|'older';
export type DataFreshnessAssessment={runId:string;status:DataFreshnessStatus;assessedAt:string;comparedRevision:number|null;reasons:string[];dependencyScope:'analysis-range'};
export const freshnessOptions=[{value:'all',label:'All items'},{value:'current',label:'Current data only'},{value:'older',label:'Based on older data'}] as const;
export function freshnessLabel(status:DataFreshnessStatus){return status==='current'?'Current data':status==='older'?'Based on older data':'Unknown data freshness';}
export function matchesDataFreshness(filter:DataFreshnessFilter,status:DataFreshnessStatus,ready=true){return filter==='all'||(ready&&status!=='unknown'&&filter===status);}
export function unknownFreshness(runId:string,reason='Source-data provenance is unavailable.'):DataFreshnessAssessment{return {runId,status:'unknown',assessedAt:'',comparedRevision:null,reasons:[reason],dependencyScope:'analysis-range'};}
export function useDataFreshness(siteId:string,runId:string,revision:string|number=''){
 const key=JSON.stringify([siteId,runId,revision]),generation=useRef({key,version:0});
 if(generation.current.key!==key)generation.current={key,version:generation.current.version+1};
 const scope=JSON.stringify([key,generation.current.version]);
 const [result,setResult]=useState<{scope:string;assessment:DataFreshnessAssessment;error:string}|null>(null);
 const request=useRef(0),currentScope=useRef(scope);currentScope.current=scope;
 useEffect(()=>{
  const controller=new AbortController(),id=++request.current;
  if(!siteId||!runId)return()=>controller.abort();
  void (async()=>{
   try{
    const response=await fetch(`/api/analysis-freshness?siteId=${encodeURIComponent(siteId)}&runId=${encodeURIComponent(runId)}`,{cache:'no-store',signal:controller.signal});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'Unable to assess data freshness.');
    if(data.runId!==runId||!['current','older','unknown'].includes(data.status)||data.dependencyScope!=='analysis-range'||!Array.isArray(data.reasons)||!data.reasons.every((reason:unknown)=>typeof reason==='string')||typeof data.assessedAt!=='string'||!Number.isFinite(Date.parse(data.assessedAt))||((data.status==='current'||data.status==='older')&&data.comparedRevision===null)||!(data.comparedRevision===null||(Number.isInteger(data.comparedRevision)&&data.comparedRevision>=0)))throw new Error('The freshness assessment was invalid.');
    if(!controller.signal.aborted&&request.current===id&&currentScope.current===scope)setResult({scope,assessment:data,error:''});
   }catch(reason){if(!controller.signal.aborted&&request.current===id&&currentScope.current===scope){const error=reason instanceof Error?reason.message:'Unable to assess data freshness.';setResult({scope,assessment:unknownFreshness(runId,error),error});}}
  })();
  return()=>controller.abort();
 },[siteId,runId,scope]);
 const ready=!!result&&result.scope===scope;
 return {assessment:ready?result.assessment:unknownFreshness(runId,runId?'Assessment pending.':'No analysis selected.'),ready,loading:!!runId&&!ready,error:ready?result.error:''};
}
