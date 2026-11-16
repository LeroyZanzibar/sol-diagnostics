import { getDatabaseBinding } from "../../../db/binding";
import { assessAnalysisFreshness } from "../performance-data/analysis";

const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const siteId = query.get("siteId") || "", runId = query.get("runId") || "";
  if (!siteId || !runId) return Response.json({ error: "Choose a site and saved analysis." }, { status: 400, headers });
  try {
    const run = await getDatabaseBinding().prepare("SELECT id FROM analysis_runs WHERE id = ? AND site_id = ? AND status = 'completed'").bind(runId, siteId).first();
    if (!run) return Response.json({ error: "Saved analysis not found." }, { status: 404, headers });
    return Response.json(assessAnalysisFreshness(siteId, runId), { headers });
  } catch {
    return Response.json({ runId, status: "unknown", assessedAt: new Date().toISOString(), comparedRevision: null,
      reasons: ["The saved analysis could not be assessed."], dependencyScope: "analysis-range" }, { headers });
  }
}
