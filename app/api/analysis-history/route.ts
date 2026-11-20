import { analysisJsonResponse } from "../performance-summary/checkpoint-storage";
import { savedAnalysis, listAnalysisHistory } from "./service";
import { assessAnalysisFreshness } from "../performance-data/analysis";
import { deleteSavedAnalysis, AnalysisDeletionError, validAnalysisId } from "./deletion";

const headers = { "Cache-Control": "private, no-store" };
export async function DELETE(request: Request) {
  try {
    const query = new URL(request.url).searchParams, siteId = query.get("siteId"), runId = query.get("runId");
    if (query.getAll("siteId").length !== 1 || query.getAll("runId").length !== 1 || !validAnalysisId(siteId) || !validAnalysisId(runId)) {
      throw new AnalysisDeletionError("INVALID_ANALYSIS_ID", "Choose a valid site and saved analysis.", 400);
    }
    return Response.json(await deleteSavedAnalysis(siteId, runId), { headers });
  } catch (error) {
    return Response.json(error instanceof AnalysisDeletionError ? { error: error.message, code: error.code } :
      { error: "Unable to delete the saved analysis. Refresh and try again.", code: "ANALYSIS_STORAGE_ERROR" },
      { status: error instanceof AnalysisDeletionError ? error.status : 500, headers });
  }
}
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
          lossPercent:issue.lossUnknown?null:issue.lossPercent,
          expectedEnergyKwh:issue.expectedUnknown?null:issue.expectedEnergyKwh,
          actualEnergyKwh:issue.productionUnknown?null:issue.actualEnergyKwh,evidence:undefined})),issueLossThresholdKwh:null},
        historical:true,dataFreshness:assessAnalysisFreshness(siteId,runId)}, {headers});
    }
    return Response.json(await listAnalysisHistory(siteId,query.get("before")||""),{headers});
  } catch (error) {
    return Response.json({error:error instanceof Error?error.message:"Unable to load analysis history."},{status:404,headers});
  }
}
