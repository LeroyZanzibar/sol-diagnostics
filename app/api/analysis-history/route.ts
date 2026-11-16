import { analysisJsonResponse } from "../performance-summary/checkpoint-storage";
import { savedAnalysis, listAnalysisHistory } from "./service";
import { assessAnalysisFreshness } from "../performance-data/analysis";

const headers = { "Cache-Control": "private, no-store" };
export async function GET(request:Request) {
  try {
    const query=new URL(request.url).searchParams,siteId=query.get("siteId")||"",runId=query.get("runId");
    if (!siteId) return Response.json({error:"Choose a site."},{status:400,headers});
    if (runId) {
      const payload=await savedAnalysis(siteId,runId);
      return analysisJsonResponse({hasData:true,...payload,
        analysis:{...payload.analysis,issues:payload.analysis.issues.map((issue:Record<string,any>)=>({...issue,
          intervalLosses:issue.intervalLosses||issue.evidence?.intervalLosses||[],
          estimatedLossKwh:issue.lossUnknown?null:issue.estimatedLossKwh,
          actualEnergyKwh:issue.productionUnknown?null:issue.actualEnergyKwh,evidence:undefined})),issueLossThresholdKwh:null},
        historical:true,dataFreshness:assessAnalysisFreshness(siteId,runId)}, {headers});
    }
    return Response.json(await listAnalysisHistory(siteId,query.get("before")||""),{headers});
  } catch (error) {
    return Response.json({error:error instanceof Error?error.message:"Unable to load analysis history."},{status:404,headers});
  }
}
