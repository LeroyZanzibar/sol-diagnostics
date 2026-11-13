import { analysisJsonResponse } from "../performance-summary/checkpoint-storage";
import { getDatabaseBinding } from "../../../db/binding";
import { savedAnalysis } from "./service";
export async function GET(request:Request){try{const q=new URL(request.url).searchParams,siteId=q.get("siteId")||"",runId=q.get("runId");if(!siteId)return Response.json({error:"Choose a site."},{status:400});
  if(runId){const p=await savedAnalysis(siteId,runId);return analysisJsonResponse({hasData:true,...p,analysis:{...p.analysis,issues:p.analysis.issues.map((i:Record<string,any>)=>({...i,intervalLosses:i.intervalLosses||i.evidence?.intervalLosses||[],estimatedLossKwh:i.lossUnknown?null:i.estimatedLossKwh,actualEnergyKwh:i.productionUnknown?null:i.actualEnergyKwh,evidence:undefined})),issueLossThresholdKwh:null},historical:true},{headers:{"Cache-Control":"private, no-store"}});}
  const before=q.get("before")||"9999";
  const rows=await getDatabaseBinding().prepare("SELECT id,import_id,parser_version,model_revision,issue_count,completed_at FROM analysis_runs WHERE site_id = ? AND status = 'completed' AND completed_at < ? ORDER BY completed_at DESC LIMIT 51").bind(siteId,before).all();
  return Response.json({runs:rows.results.slice(0,50),next:rows.results.length>50?rows.results[49].completed_at:null});
}catch(e){return Response.json({error:e instanceof Error?e.message:"Unable to load analysis history."},{status:404});}}
