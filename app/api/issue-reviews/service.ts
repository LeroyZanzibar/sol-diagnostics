import { getDatabaseBinding } from "../../../db/binding";
import { savedAnalysis } from "../analysis-history/service";
import { blankReview, validateReview, assessReviewEvidence, type ReviewState, type IssueReview } from "../../issue-review";
export async function reviewContext(siteId:string,runId:string,issueId:string){const p=await savedAnalysis(siteId,runId,true);const issue=[...p.analysis.issues,...(p.analysis.recurringIssues||[])].find((i:Record<string,any>)=>i.id===issueId);if(!issue)throw new Error("Issue not found in this saved analysis.");return {issue,eventKey:issue.eventKey as string,timezone:issue.timezone||p.timeZone||p.summary?.timezone||p.methodology?.timezone||"UTC",payload:p};}

type ReviewRecord=IssueReview & {eventKey:string;runId:string};
export async function assessReviews(siteId:string,runId:string,payload:Record<string,any>,records:ReviewRecord[]){
 const requested=new Set(records.map(r=>r.eventKey));
 const current=new Map<string,any>([...payload.analysis.issues,...(payload.analysis.recurringIssues||[])].filter((i:any)=>requested.has(i.eventKey)).map((i:any)=>[i.eventKey,i]));
 const pending=new Map<string,ReviewRecord[]>(),result:ReviewRecord[]=[];
 const attach=(record:ReviewRecord,assessment:ReturnType<typeof assessReviewEvidence>)=>result.push({...record,needsReview:assessment.needsReview,assessment});
 for(const input of records){
  const record={...input,runId:input.state.evidenceRunId||input.runId};
  const issue=current.get(record.eventKey);
  if(issue?.isRecurring){
   const changed=record.state.evidenceSignature!==issue.evidenceSignature||JSON.stringify(record.state.recurringBasis)!==JSON.stringify(payload.reviewCalculationBasis);
   attach(record,{needsReview:record.state.status!=='Unreviewed'&&changed,evidenceChanged:changed,changes:changed?['Occurrences or their evidence changed since the recurring issue was reviewed. New occurrences do not inherit the earlier decision.']:[]});continue;
  }
  if(record.state.status==='Unreviewed'||record.runId===runId&&record.state.evidenceSignature===issue?.evidenceSignature){attach(record,{needsReview:false,evidenceChanged:false,changes:[]});continue;}
  const group=pending.get(record.runId)||[];group.push(record);pending.set(record.runId,group);
 }
 let currentDetails:Map<string,any>|undefined;
 for(const [previousRun,group] of pending){
  try{
   if(!previousRun)throw new Error('Missing reviewed analysis');
   const old=previousRun===runId?payload:await savedAnalysis(siteId,previousRun,true);
   const oldIndex=new Map<string,any>(old.analysis.issues.map((i:any)=>[i.eventKey,i]));
   const detailed:ReviewRecord[]=[];
   for(const record of group){
    const before=oldIndex.get(record.eventKey),after=current.get(record.eventKey);
    if(!before||!after||before.evidenceSignature!==record.state.evidenceSignature){attach(record,{needsReview:true,evidenceChanged:true,changes:['The reviewed event evidence could not be matched; reassessment is required.']});continue;}
    const assessment=assessReviewEvidence(before,after,old.reviewCalculationBasis,payload.reviewCalculationBasis);
    if(assessment.changes.length===1&&assessment.changes[0]==='Interval coverage changed or retained interval evidence is unavailable.')detailed.push(record);
    else attach(record,assessment);
   }
   if(detailed.length){
    // Load retained ledgers only for changed evidence eligible for tolerance.
    // Reuse one current read and one prior read per run, never one read per event.
    if(!currentDetails){const p=await savedAnalysis(siteId,runId);currentDetails=new Map(p.analysis.issues.filter((i:any)=>current.has(i.eventKey)).map((i:any)=>[i.eventKey,{...i,intervalMinutes:i.intervalMinutes||p.analysis.analysisIntervalMinutes||p.summary?.intervalMinutes}]));}
    const p=previousRun===runId?null:await savedAnalysis(siteId,previousRun);
    const wanted=new Set(detailed.map(r=>r.eventKey));
    const previousDetails=p?new Map<string,any>(p.analysis.issues.filter((i:any)=>wanted.has(i.eventKey)).map((i:any)=>[i.eventKey,{...i,intervalMinutes:i.intervalMinutes||p.analysis.analysisIntervalMinutes||p.summary?.intervalMinutes}])):currentDetails;
    for(const record of detailed){const before=previousDetails.get(record.eventKey),after=currentDetails.get(record.eventKey);if(!before||!after)throw new Error('Missing event ledger');attach(record,assessReviewEvidence(before,after,old.reviewCalculationBasis,payload.reviewCalculationBasis));}
   }
  }catch{
   for(const record of group)if(!result.some(r=>r.eventKey===record.eventKey))attach(record,{needsReview:true,evidenceChanged:true,changes:['Prior evidence is unavailable for comparison. The previous decision and notes are retained.']});
  }
 }
 return result;
}
export async function saveReview(db:ReturnType<typeof getDatabaseBinding>,siteId:string,eventKey:string,runId:string,baseVersion:number,state:ReviewState,note:string,actor:string){
  validateReview(state,note);if(!Number.isInteger(baseVersion)||baseVersion<0)throw new Error("Invalid review version.");
  const now=new Date().toISOString(),changeId=crypto.randomUUID(),json=JSON.stringify({...state,changeId}),version=baseVersion+1;
  await db.batch([
    db.prepare(`INSERT INTO issue_event_reviews (id,site_id,event_key,version,state,updated_at)
      SELECT ?,?,?,?,?,? WHERE ? = 0 OR EXISTS (SELECT 1 FROM issue_event_reviews WHERE site_id = ? AND event_key = ? AND version = ?)
      ON CONFLICT(site_id,event_key) DO UPDATE SET version=excluded.version,state=excluded.state,updated_at=excluded.updated_at WHERE issue_event_reviews.version = ?`)
      .bind(crypto.randomUUID(),siteId,eventKey,version,json,now,baseVersion,siteId,eventKey,baseVersion,baseVersion),
    db.prepare(`INSERT INTO issue_review_changes (id,site_id,event_key,run_id,version,state,note,actor,created_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM issue_event_reviews WHERE site_id = ? AND event_key = ? AND version = ? AND state = ?)`)
      .bind(changeId,siteId,eventKey,runId,version,json,note.trim(),actor,now,siteId,eventKey,version,json),
  ]);
  const row=await db.prepare("SELECT version,state,updated_at FROM issue_event_reviews WHERE site_id = ? AND event_key = ?").bind(siteId,eventKey).first<{version:number;state:string;updated_at:string}>();
  if(!row||JSON.parse(row.state).changeId!==changeId)throw new Error("Another analyst updated this event. Reload its review before saving your changes.");
  return {version:row.version,state:JSON.parse(row.state),updatedAt:row.updated_at};
}
export { blankReview };

/** Fetch a bounded page plus its parent decisions. Explicit child reviews are always exceptions. */
export async function effectiveReviews(db:ReturnType<typeof getDatabaseBinding>,siteId:string,runId:string,payload:Record<string,any>,keys:string[]){
 const wanted=new Set(keys),episodes=payload.analysis.recurringIssues||[],parents=new Map<string,any>();
 for(const episode of episodes)for(const member of episode.members)if(wanted.has(member.eventKey))parents.set(member.eventKey,episode);
 const queryKeys=[...new Set([...keys,...[...parents.values()].map(e=>e.eventKey)])],rows:any[]=[];
 for(let i=0;i<queryKeys.length;i+=80){const batch=queryKeys.slice(i,i+80);const found=await db.prepare(`SELECT r.event_key,r.version,r.state,r.updated_at,(SELECT c.run_id FROM issue_review_changes c WHERE c.site_id=r.site_id AND c.event_key=r.event_key AND c.version=r.version LIMIT 1) AS run_id FROM issue_event_reviews r WHERE r.site_id=? AND r.event_key IN (${batch.map(()=>'?').join(',')})`).bind(siteId,...batch).all();rows.push(...found.results);}
 const records:ReviewRecord[]=rows.map(r=>({eventKey:r.event_key,version:r.version,state:JSON.parse(String(r.state)),updatedAt:r.updated_at,runId:r.run_id})),byKey=new Map(records.map(r=>[r.eventKey,r]));
 const selected=records.filter(r=>wanted.has(r.eventKey));
 const issues=new Map<string,any>(payload.analysis.issues.map((i:any)=>[i.eventKey,i]));
 // Membership remains in the immutable R2 analysis, not repeated in every D1
 // decision or inherited response. Load each previous review baseline at most once.
 const baselineRuns=new Map<string,Record<string,any>|null>([[runId,payload]]),membership=new Map<string,Map<string,any>>();
 for(const parent of new Map([...parents.values()].map(e=>[e.eventKey,e])).values()){
  const review=byKey.get(parent.eventKey);if(!review)continue;
  const baselineRun=review.state.evidenceRunId||review.runId;
  if(!baselineRuns.has(baselineRun)){try{baselineRuns.set(baselineRun,await savedAnalysis(siteId,baselineRun,true));}catch{baselineRuns.set(baselineRun,null);}}
  const baseline=baselineRuns.get(baselineRun)?.analysis.recurringIssues?.find((e:any)=>e.eventKey===parent.eventKey);
  membership.set(parent.eventKey,new Map((baseline?.members||review.state.recurringMembers||[]).map((m:any)=>[m.eventKey,m])));
 }
 for(const key of keys){if(byKey.has(key))continue;const parent=parents.get(key),review=parent?byKey.get(parent.eventKey):undefined,member=parent?membership.get(parent.eventKey)?.get(key):undefined,issue=issues.get(key);if(!review||!member||!issue)continue;
  const {recurringMembers,recurringBasis,recurringId,...state}=review.state;
  selected.push({eventKey:key,version:0,runId:review.runId,updatedAt:review.updatedAt,inheritedFrom:{id:parent.id,name:parent.name,eventKey:parent.eventKey,version:review.version},state:{...state,evidenceSignature:member.evidenceSignature,issue:blankReview(issue,member.evidenceSignature).issue}});
 }

 return assessReviews(siteId,runId,payload,selected);
}
