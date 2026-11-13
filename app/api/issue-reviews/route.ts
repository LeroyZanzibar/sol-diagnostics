import {sharedEvidencePage} from "../../shared-reduction-evidence";
import { getDatabaseBinding } from "../../../db/binding";
import { savedAnalysis } from "../analysis-history/service";
import { reviewContext,saveReview,blankReview,assessReviews,effectiveReviews } from "./service";

export async function GET(request:Request){try{
 const q=new URL(request.url).searchParams,siteId=q.get('siteId')||'',runId=q.get('runId')||'';
 const db=getDatabaseBinding();if(!siteId)return Response.json({error:'Choose a site.'},{status:400});
 const headers={'Cache-Control':'private, no-store'};
 if(!q.get('issueId')){
  const p=await savedAnalysis(siteId,runId,true),allKeys=[...new Set<string>([...p.analysis.issues,...(p.analysis.recurringIssues||[])].map((i:any)=>i.eventKey))];
  const cursor=Math.max(0,Math.floor(Number(q.get('cursor')||0)||0)),keys=allKeys.slice(cursor,cursor+1000);
  const reviews=await effectiveReviews(db,siteId,runId,p,keys);
  return Response.json({next:cursor+1000<allKeys.length?cursor+1000:null,reviews,retrievedAt:new Date().toISOString()},{headers});
 }
 const {issue,eventKey,timezone,payload}=await reviewContext(siteId,runId,q.get('issueId')||'');
 if(q.get('sharedEvidence')==='1'){
  const full=await savedAnalysis(siteId,runId);const source=full.analysis.issues.find((i:any)=>i.id===issue.id);
  if(!source||source.evidence?.rule!=='shared_site_reduction_v1')return Response.json({error:'Shared inverter evidence is unavailable.'},{status:404,headers});
  const offset=Math.max(0,Math.floor(Number(q.get('offset'))||0));
  return Response.json(sharedEvidencePage(source,offset,q.get('event')||''),{headers});
 }
 const before=Number(q.get('before')||2147483647);
 const audit=await db.prepare('SELECT version,note,actor,created_at,state,run_id FROM issue_review_changes WHERE site_id = ? AND event_key = ? AND version < ? ORDER BY version DESC LIMIT 21').bind(siteId,eventKey,before).all();
 const related=await db.prepare("SELECT r.event_key,r.state,(SELECT c.note FROM issue_review_changes c WHERE c.site_id=r.site_id AND c.event_key=r.event_key AND c.note <> '' ORDER BY c.version DESC LIMIT 1) AS note FROM issue_event_reviews r WHERE r.site_id=? AND r.event_key<>? AND json_extract(r.state,'$.issue.equipmentId')=? AND json_extract(r.state,'$.issue.type')=? AND json_extract(r.state,'$.issue.startDateTime')<=? AND json_extract(r.state,'$.issue.endDateTime')>=? ORDER BY r.updated_at DESC LIMIT 10").bind(siteId,eventKey,issue.equipmentId,issue.type,issue.endDateTime,issue.startDateTime).all();
 let review:any={version:0,state:blankReview(issue,issue.evidenceSignature),updatedAt:'',needsReview:false};
 const assessed=await effectiveReviews(db,siteId,runId,payload,[eventKey]);if(assessed.length)review=assessed[0];
 const issueSummary={recurring:issue.isRecurring?{dates:issue.dates,activeMinutes:issue.activeMinutes,sequenceStatus:issue.sequenceStatus,occurrenceCount:issue.members.length}:undefined,hasSharedReduction:!!issue.hasSharedReduction||issue.evidence?.rule==='shared_site_reduction_v1',equipmentName:issue.equipmentName||issue.equipmentId,startDateTime:issue.startDateTime,endDateTime:issue.endDateTime,description:issue.description||'',actualEnergyKwh:issue.productionUnknown?null:issue.actualEnergyKwh,expectedEnergyKwh:issue.expectedEnergyKwh,estimatedLossKwh:issue.lossUnknown?null:issue.estimatedLossKwh,lossUnknown:!!issue.lossUnknown,productionUnknown:!!issue.productionUnknown,suspectedCause:issue.suspectedCause||'',causeExplanation:issue.causeExplanation||''};
 return Response.json({timezone,issueEndDateTime:issue.endDateTime,issueSummary,related:related.results.map((r:Record<string,unknown>)=>({...r,state:JSON.parse(String(r.state))})),eventKey,review,needsReview:review.needsReview,audit:audit.results.slice(0,20),next:audit.results.length>20?audit.results[19].version:null},{headers});
}catch(e){return Response.json({error:e instanceof Error?e.message:'Unable to load review.'},{status:404});}}

export async function POST(request:Request){try{
 const p=await request.json(),{issue,eventKey,payload}=await reviewContext(p.siteId,p.runId,p.issueId),input=p.state;
 const state={...(issue.isRecurring?{recurringId:issue.id,recurringBasis:payload.reviewCalculationBasis}:{}),status:input.status,resolution:input.resolution,classification:input.classification,resolvedAt:input.resolvedAt,resolutionNote:input.resolutionNote,dismissalReason:input.status==='Dismissed'?(input.dismissalReason||p.note||''):'',confidence:Object.fromEntries(['anomaly','cause','loss'].map(key=>[key,{level:input.confidence?.[key]?.level,reason:input.confidence?.[key]?.reason}])) as typeof input.confidence,evidenceRunId:p.runId,evidenceSignature:issue.evidenceSignature,issue:blankReview(issue,issue.evidenceSignature).issue};
 const actor=request.headers.get('oai-authenticated-user-email')||request.headers.get('oai-authenticated-user-id')||'Site service / local preview';
 const db=getDatabaseBinding();
 const saved=await saveReview(db,p.siteId,eventKey,p.runId,p.baseVersion,state,p.note||'',actor);
 const review={...saved,needsReview:false,assessment:{needsReview:false,evidenceChanged:false,changes:[]}};
 // Refresh only this decision and its complete saved membership. Server-side
 // inheritance preserves individual exceptions, including filtered-out findings.
 const reviews=issue.isRecurring
  ? await effectiveReviews(db,p.siteId,p.runId,payload,[...new Set<string>([eventKey,...issue.members.map((member:any)=>member.eventKey)])])
  : [{eventKey,...review}];
 return Response.json({eventKey,review,reviews,retrievedAt:new Date().toISOString()},{headers:{'Cache-Control':'private, no-store'}});
}catch(e){return Response.json({error:e instanceof Error?e.message:'Unable to save review.'},{status:409});}}
