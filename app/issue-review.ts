export const reviewStatuses = ["Unreviewed", "Confirmed", "Dismissed"] as const;
export const operationalCauses = [
  "Unknown", "Curtailment", "Snow", "Maintenance", "Connectors or Wiring", "Vandalism",
  "Weather or Environmental Damage", "Soiling", "Inverter Fault", "Module Failure",
  "DC Ground Fault", "Communication Error", "Monitoring Equipment Failure", "Utility or Grid Issue",
  "Combiner Failure", "Single-Axis Tracker Failure", "Dual-Axis Tracker Failure", "Breaker Tripped",
  "Breaker Failure", "Fuse Failure", "Racking Problem", "Transformer Failure",
  "Non-System Related Site Work", "Low Performance", "DAS Failure", "EPC issue", "Engine Fault", "Other",
] as const;
export const confidenceLevels = ["Unknown", "Low", "Moderate", "High"] as const;
export type ConfidenceDetail = Record<"anomaly" | "cause" | "loss", { level: string; reason: string }>;
export type ReviewState = { status: string; resolution: string; resolvedAt: string; resolutionNote: string; classification: string; dismissalReason?:string;
  confidence: ConfidenceDetail; evidenceSignature: string; evidenceRunId?:string; recurringId?:string; recurringMembers?:{id:string;eventKey:string;evidenceSignature:string}[]; recurringBasis?:{calculationVersion?:number;modelRevision?:string}; bulkOperationId?:string; issue: { equipmentId: string; type: string; name: string; startDateTime: string; endDateTime: string }; changeId?:string };
export type ReviewAssessment = { needsReview: boolean; evidenceChanged: boolean; changes: string[]; retained?: boolean };
export type IssueReview = { inheritedFrom?:{id:string;name:string;eventKey:string;version:number}; version: number; state: ReviewState; updatedAt: string; needsReview?: boolean; assessment?: ReviewAssessment };
export type SavedIssueReview = { eventKey:string; review:IssueReview; reviews:(IssueReview&{eventKey:string})[]; retrievedAt:string };
type Issue = { equipmentId:string; type:string; name?:string; category?:string; startDateTime:string; endDateTime:string; confidence?:string; suspectedCause?:string;
  estimatedLossKwh:number|null; actualEnergyKwh?:number|null; expectedEnergyKwh?:number|null; lossUnknown?:boolean; evidence?:Record<string,unknown>; intervalLosses?:unknown[]; eventKey?:string; evidenceSignature?:string };
async function digest(value:unknown){const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)));return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join("");}
export async function issueEventKey(siteId:string,issue:Issue){return digest([siteId,issue.equipmentId,issue.type,issue.category,issue.startDateTime]);}
export async function issueEvidenceSignature(issue:Issue){
 const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?Math.round(v*1e6)/1e6:null;
 const ledger=(issue.intervalLosses||issue.evidence?.intervalLosses||[]) as Record<string,unknown>[];
 const intervals=ledger.map(p=>[p.timestamp,number(p.lossKwh),number(p.countedLossKwh??p.lossKwh),number(p.actualKwh),number(p.expectedKwh)]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
 return digest([issue.type,issue.startDateTime,issue.endDateTime,number(issue.estimatedLossKwh),number(issue.actualEnergyKwh),number(issue.expectedEnergyKwh),!!issue.lossUnknown,intervals]);
}
export function defaultConfidence(issue:Issue):ConfidenceDetail{return {
  anomaly:{level:issue.confidence==="confirmed"?"High":"Moderate",reason:issue.confidence==="confirmed"?"The detection rule found corroborating telemetry.":"The detection rule compares observed readings with an estimated production baseline."},
  cause:{level:issue.suspectedCause?"Low":"Unknown",reason:issue.suspectedCause?`${issue.suspectedCause} is a suggested explanation, awaiting operational evidence.`:"No operational cause has been established."},
  loss:{level:issue.lossUnknown||issue.estimatedLossKwh===null?"Unknown":"Moderate",reason:issue.lossUnknown||issue.estimatedLossKwh===null?"Available readings do not support a quantified loss.":"Loss depends on expected production and the available or substituted readings; no statistical uncertainty range is established."},
};}
export function blankReview(issue:Issue,signature:string):ReviewState{return {status:"Unreviewed",resolution:"Open",resolvedAt:"",resolutionNote:"",classification:"Unknown",confidence:defaultConfidence(issue),evidenceSignature:signature,issue:{equipmentId:issue.equipmentId,type:issue.type,name:issue.name||issue.type,startDateTime:issue.startDateTime,endDateTime:issue.endDateTime}};}
export function validateReview(state:ReviewState,note:string){
  if(!reviewStatuses.includes(state.status as typeof reviewStatuses[number])||!["Open","Resolved"].includes(state.resolution)||!operationalCauses.includes(state.classification as typeof operationalCauses[number]))throw new Error("Choose valid review, resolution, and classification values.");
  if(typeof note!=="string"||note.length>10000)throw new Error("Notes may contain up to 10,000 characters.");
  if(state.dismissalReason!==undefined&&(typeof state.dismissalReason!=='string'||state.dismissalReason.length>10000))throw new Error("Provide a valid dismissal reason.");
  if(state.status==="Dismissed"&&!state.dismissalReason?.trim()&&!note.trim())throw new Error("Explain why this finding is being dismissed.");
  if(state.resolution==="Resolved"&&(!state.resolutionNote?.trim()||!Number.isFinite(Date.parse(state.resolvedAt))))throw new Error("Record the resolution time and a resolution note.");
  if(typeof state.resolutionNote!=="string"||state.resolutionNote.length>5000||typeof state.resolvedAt!=="string"||state.resolvedAt.length>40)throw new Error("Provide a valid resolution note and time.");
  for(const key of ["anomaly","cause","loss"] as const){const c=state.confidence?.[key];if(!c||!confidenceLevels.includes(c.level as typeof confidenceLevels[number])||typeof c.reason!=="string"||!c.reason.trim()||c.reason.length>2000)throw new Error("Each confidence assessment needs a level and a short explanation.");}
}

export const dismissalReasons = ["Detection is not supported by the evidence", "Source data is incorrect", "Expected-production baseline is incorrect", "Duplicate finding", "Other"] as const;
export const resolutionReasons = ["Production recovery verified", "Repair completed", "Operational restriction ended", "Other"] as const;
export const REVIEW_TOLERANCE = "Numerical changes must remain within both 1% and 1 kWh, for each energy total and the sum of absolute interval changes. Every interval must also remain within 1%. Event boundaries, coverage, zero/missing readings, detection basis and calculation/model versions must be unchanged. Comparisons use the last human-reviewed analysis, so small changes cannot accumulate unnoticed.";

export function effectiveReviewStatus(issue:{evidenceSignature?:string},review?:IssueReview){
 if(!review||review.state.status==='Unreviewed')return 'Unreviewed';
 return (review.needsReview ?? (review.state.evidenceSignature!==issue.evidenceSignature))?'Needs review':review.state.status;
}
export function matchesReviewFilter(issue:{evidenceSignature?:string},review:IssueReview|undefined,filter:string){
 const status=effectiveReviewStatus(issue,review);
 return filter==='All findings'||filter==='Exclude dismissed'&&status!=='Dismissed'||filter===status;
}
export function nextReviewFinding<T extends {id:string;eventKey?:string;evidenceSignature?:string}>(issues:T[],currentId:string,reviews:Record<string,IssueReview>):T|undefined{
 const index=issues.findIndex(i=>i.id===currentId);
 const ordered=[...issues.slice(index+1),...issues.slice(0,Math.max(0,index))];
 return ordered.find(i=>i.id!==currentId&&['Unreviewed','Needs review'].includes(effectiveReviewStatus(i,i.eventKey?reviews[i.eventKey]:undefined)));
}
export function reviewLossSummary(issues:{eventKey?:string;evidenceSignature?:string;estimatedLossKwh?:number|null}[],reviews:Record<string,IssueReview>){
 let detected=0,dismissed=0,provisional=0;
 for(const issue of issues){const loss=issue.estimatedLossKwh??0,status=effectiveReviewStatus(issue,issue.eventKey?reviews[issue.eventKey]:undefined);detected+=loss;if(status==='Dismissed')dismissed+=loss;else if(status==='Unreviewed'||status==='Needs review')provisional+=loss;}
 return {detected,dismissed,adjusted:detected-dismissed,provisional};
}

type ReviewEvidenceIssue = Issue & { productionUnknown?:boolean; intervalMinutes?:number; affectedEquipment?:{id:string}[] };
type CalculationBasis = { calculationVersion?:number; modelRevision?:string };
// Read-only assessment against immutable evidence. Never rewrite a human decision
// or advance its baseline when an automatic comparison accepts a small change.
export function assessReviewEvidence(before:ReviewEvidenceIssue,after:ReviewEvidenceIssue,previousBasis?:CalculationBasis,currentBasis?:CalculationBasis):ReviewAssessment{
 const changes:string[]=[];
 const changed=before.evidenceSignature!==after.evidenceSignature;
 const changedField=(label:string,a:unknown,b:unknown)=>{if(JSON.stringify(a??null)!==JSON.stringify(b??null))changes.push(label);};
 changedField('Event start changed.',before.startDateTime,after.startDateTime);
 changedField('Event end changed.',before.endDateTime,after.endDateTime);
 changedField('Equipment or finding type changed.',[before.equipmentId,before.type,before.category],[after.equipmentId,after.type,after.category]);
 changedField('Calculation version or array-model configuration changed.',previousBasis,currentBasis);
 changedField('Data availability, detection confidence or suspected cause changed.',[!!before.lossUnknown,!!before.productionUnknown,before.confidence,before.suspectedCause||''],[!!after.lossUnknown,!!after.productionUnknown,after.confidence,after.suspectedCause||'']);
 changedField('Affected equipment changed.',(before.affectedEquipment||[]).map(i=>i.id).sort(),(after.affectedEquipment||[]).map(i=>i.id).sort());
 if(changes.length||!changed)return {needsReview:!!changes.length,evidenceChanged:changed||!!changes.length,changes};
 const result=(message:string):ReviewAssessment=>({needsReview:true,evidenceChanged:true,changes:[message]});
 if(!previousBasis?.calculationVersion||!currentBasis?.calculationVersion)return result('The prior calculation basis is unavailable; check the changed evidence.');
 const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
 const close=(a:unknown,b:unknown)=>{
  if(a==null||b==null)return a==null&&b==null;
  if(!finite(a)||!finite(b))return false;
  if((a===0)!==(b===0))return false;
  if(Math.abs(a-b)<=1e-6)return true;
  return a!==0&&b!==0&&Math.abs(a-b)<=Math.min(1,Math.abs(a)*.01);
 };
 for(const [key,label] of [['estimatedLossKwh','Estimated loss'],['actualEnergyKwh','Actual energy'],['expectedEnergyKwh','Expected energy']] as const){
  if(!close(before[key],after[key]))changes.push(`${label} changed from ${before[key]??'Unknown'} to ${after[key]??'Unknown'} kWh.`);
 }
 if(changes.length)return {needsReview:true,evidenceChanged:true,changes};
 const a=(before.intervalLosses||before.evidence?.intervalLosses||[]) as Record<string,any>[],b=(after.intervalLosses||after.evidence?.intervalLosses||[]) as Record<string,any>[];
 if(!a.length||a.length!==b.length)return result('Interval coverage changed or retained interval evidence is unavailable.');
 const sorted=(points:Record<string,any>[])=>[...points].sort((x,y)=>String(x.timestamp).localeCompare(String(y.timestamp)));
 const left=sorted(a),right=sorted(b);
 const energy=(p:Record<string,any>)=>[p.lossKwh,p.countedLossKwh??p.lossKwh,p.actualKwh,p.expectedKwh];
 const difference=[0,0,0,0],previous=[0,0,0,0];
 changedField('Detection rule or loss basis changed.',[before.evidence?.rule,(before.evidence?.derivedInverterExpectation as any)?.lossBasis], [after.evidence?.rule,(after.evidence?.derivedInverterExpectation as any)?.lossBasis]);
 for(let i=0;i<left.length;i++){
  const x=left[i],y=right[i];
  if(!Number.isFinite(Date.parse(x.timestamp))||x.timestamp!==y.timestamp||(i&&x.timestamp===left[i-1].timestamp)||(x.intervalMinutes||before.intervalMinutes||60)!==(y.intervalMinutes||after.intervalMinutes||60))return result('Interval timestamps, coverage or cadence changed.');
  if(JSON.stringify([x.detectionBasis,!!x.peerCorroborated])!==JSON.stringify([y.detectionBasis,!!y.peerCorroborated]))return result('Interval detection basis or corroborating evidence changed.');
  const xv=energy(x),yv=energy(y);
  for(let k=0;k<4;k++){
   if(!finite(xv[k])||!finite(yv[k])||xv[k]<0||yv[k]<0||!close(xv[k],yv[k]))return result('Interval energy changed materially, or a zero/missing reading changed.');
   difference[k]+=Math.abs(xv[k]-yv[k]);previous[k]+=Math.abs(xv[k]);
  }
 }
 if(difference.some((value,i)=>value>Math.max(1e-6,Math.min(1,previous[i]*.01))))return result('The cumulative interval changes exceed the review tolerance.');
 return {needsReview:!!changes.length,evidenceChanged:true,changes:changes.length?changes:['Small numerical changes only; the previous decision still applies.'],retained:!changes.length};
}
