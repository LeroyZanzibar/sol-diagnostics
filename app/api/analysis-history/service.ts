import { readCheckpoint } from "../performance-summary/checkpoint-storage";
import { getBucketBinding, getDatabaseBinding } from "../../../db/binding";
import { issueEventKey, issueEvidenceSignature, defaultConfidence } from "../../issue-review";
export async function savedAnalysis(siteId:string,runId:string,reviewOnly=false){
  const row=await getDatabaseBinding().prepare("SELECT analysis_object_key, status, parser_version, model_revision FROM analysis_runs WHERE id = ? AND site_id = ?").bind(runId,siteId).first<{analysis_object_key:string;status:string;parser_version:number;model_revision:string}>();
  if(!row||row.status!=="completed")throw new Error("Saved analysis not found.");
  const bucket=getBucketBinding();
  const index=reviewOnly&&row.analysis_object_key.endsWith('/result.json')?await bucket.get(row.analysis_object_key.replace(/result\.json$/,'review-index.json')):null;
  const object=index||await bucket.get(row.analysis_object_key);if(!object)throw new Error("The retained analysis file is unavailable.");
  const payload=await readCheckpoint<Record<string,any>>(object);
  payload.reviewCalculationBasis={calculationVersion:row.parser_version,modelRevision:row.model_revision};
  if(payload.siteId&&payload.siteId!==siteId)throw new Error("Saved analysis site mismatch.");
  if(payload.issueDatabase?.analysisRunId&&payload.issueDatabase.analysisRunId!==runId)throw new Error("This legacy analysis was overwritten before immutable history was available.");
  for(const issue of payload.analysis.issues){issue.eventKey ||= await issueEventKey(siteId,issue);issue.evidenceSignature ||= await issueEvidenceSignature(issue);issue.confidenceDetail ||= defaultConfidence(issue);}
  return payload;
}
