import { readCheckpoint } from "../performance-summary/checkpoint-storage";
import { getBucketBinding, getDatabaseBinding } from "../../../db/binding";
import { issueEventKey, issueEvidenceSignature, defaultConfidence } from "../../issue-review";
import { savedAnalysisProvenance, assessAnalysisFreshness } from "../performance-data/analysis";
import { isCompletedAnalysisRun, publishedAnalysisAvailable } from "./availability";
export async function savedAnalysis(siteId:string,runId:string,reviewOnly=false){
  const row=await getDatabaseBinding().prepare("SELECT analysis_object_key, status, parser_version, model_revision FROM analysis_runs WHERE id = ? AND site_id = ?").bind(runId,siteId).first<{analysis_object_key:string;status:string;parser_version:number;model_revision:string}>();
  if(!row||row.status!=="completed")throw new Error("Saved analysis not found.");
  const payload=await readAnalysisEvidence(siteId,runId,row,reviewOnly);
  // A bucket read can yield while deletion commits. Never return that late read.
  if(!await isCompletedAnalysisRun(getDatabaseBinding(),siteId,runId,row.analysis_object_key))throw new Error("Saved analysis not found.");
  return payload;
}

/** Internal review comparison only. Never use this as a public request target. */
export async function reviewedAnalysisBaseline(siteId:string,runId:string,reviewOnly=false){
  const row=await getDatabaseBinding().prepare("SELECT analysis_object_key,status,parser_version,model_revision FROM analysis_runs WHERE id = ? AND site_id = ? AND status IN ('completed','deleted')").bind(runId,siteId).first<{analysis_object_key:string;status:string;parser_version:number;model_revision:string}>();
  if(!row)throw new Error("Reviewed analysis baseline not found.");
  return readAnalysisEvidence(siteId,runId,row,reviewOnly);
}

async function readAnalysisEvidence(siteId:string,runId:string,row:{analysis_object_key:string;parser_version:number;model_revision:string},reviewOnly:boolean){
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

type HistoryRow = { id:string; import_id:string; parser_version:number; model_revision:string; issue_count:number; completed_at:string; analysis_object_key:string; timestamp_start:string|null; timestamp_end:string|null };

export async function listAnalysisHistory(siteId:string, before = "") {
  const db=getDatabaseBinding();
  let timestamp="9999", id="";
  if (before.startsWith("[")) {
    const cursor=JSON.parse(before);
    if (!Array.isArray(cursor) || cursor.length!==2 || cursor.some(value=>typeof value!=="string" || !value)) throw new Error("Invalid analysis history cursor.");
    [timestamp,id]=cursor;
  } else if (before) timestamp=before; // Compatibility with earlier timestamp-only links.
  const page=await db.prepare(`SELECT r.id,r.import_id,r.parser_version,r.model_revision,r.issue_count,r.completed_at,r.analysis_object_key,
    t.timestamp_start,t.timestamp_end FROM analysis_runs r LEFT JOIN telemetry_imports t ON t.id=r.import_id AND t.site_id=r.site_id
    WHERE r.site_id = ? AND r.status = 'completed' AND (r.completed_at < ? OR (r.completed_at = ? AND r.id < ?))
    ORDER BY r.completed_at DESC,r.id DESC LIMIT 51`).bind(siteId,timestamp,timestamp,id).all<HistoryRow>();
  const pointers=await db.prepare("SELECT import_id,summary FROM performance_summaries WHERE site_id = ?").bind(siteId).all<{import_id:string;summary:string}>();
  const current=new Set<string>();
  for (const row of pointers.results) {
    let pointer: {objectKey?:string;analysisRunId?:string;parserVersion?:number;modelRevision?:string};
    try { pointer=JSON.parse(row.summary); } catch { continue; }
    if (!await publishedAnalysisAvailable(db,siteId,row.import_id,pointer)) continue;
    // Resolve legacy pointers without fetching giant analysis JSON objects.
    const run=pointer.analysisRunId?{id:pointer.analysisRunId}:await db.prepare(`SELECT id FROM analysis_runs WHERE site_id = ? AND import_id = ? AND analysis_object_key = ?
      AND status = 'completed' LIMIT 1`).bind(siteId,row.import_id,pointer.objectKey).first<{id:string}>();
    if (run) current.add(run.id);
  }
  const hashes=new Map<string,string>();
  const ids=page.results.slice(0,50).map((row:HistoryRow)=>row.id);
  const stillCompleted=ids.length?await db.prepare(`SELECT id FROM analysis_runs WHERE site_id = ? AND status = 'completed' AND id IN (${ids.map(()=>'?').join(',')})`).bind(siteId,...ids).all<{id:string}>():{results:[]};
  const available=new Set(stillCompleted.results.map((row:{id:string})=>row.id));
  const runs=page.results.slice(0,50).filter((row:HistoryRow)=>available.has(row.id)).map(({analysis_object_key,...row}:HistoryRow)=>{
    const provenance=savedAnalysisProvenance(siteId,row.id);
    // Version 1 puts the primary interval domain first; auxiliary snow
    // dependencies may extend beyond the dates actually analyzed.
    const analyzedRange=provenance?.scopes[0];
    return {...row,
      timestamp_start:analyzedRange?.start || row.timestamp_start || null,
      timestamp_end:analyzedRange?.end || row.timestamp_end || null,
      source_revision:provenance?.revision ?? null,
      is_current:current.has(row.id),
      data_freshness:assessAnalysisFreshness(siteId,row.id,provenance,hashes),
    };
  });
  return {runs,next:page.results.length>50 ? JSON.stringify([page.results[49].completed_at,page.results[49].id]) : null};
}
