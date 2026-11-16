import { readBoundedJson, PerformanceValidationError } from "../../performance-ingest";
import { loadPerformanceContext, previewPerformanceJson, previewLegacyPerformance, commitPerformancePreview,
  performanceJson, performanceError, requiredText } from "./service";

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    const context = await loadPerformanceContext(requiredText(query.get("siteId"), "site ID"));
    const stageId = query.get("stageId");
    if (stageId !== null) return performanceJson({ preview: context.store.preview(requiredText(stageId, "stage ID")) });
    return performanceJson({ dataset: context.dataset, imports: context.store.imports(), legacyImport: context.legacyImport, requiresMigration: context.requiresMigration });
  } catch (error) { return performanceError(error); }
}
export async function POST(request: Request) {
  try {
    const payload = await readBoundedJson(request);
    if (payload.action === "preview") return performanceJson({ preview: await previewPerformanceJson(payload) });
    if (payload.action === "previewLegacy") return performanceJson({ preview: await previewLegacyPerformance(requiredText(payload.siteId, "site ID")) });
    if (payload.action === "commit") {
      // The authenticated server/proxy supplies these headers. Never read an
      // actor from the JSON body; self-host strips caller identity headers.
      const actor = request.headers.get("oai-authenticated-user-email") || request.headers.get("oai-authenticated-user-id");
      if (!actor) return performanceJson({ error: "An authenticated actor is required to commit." }, 401);
      return performanceJson(await commitPerformancePreview(payload, actor));
    }
    if (payload.action === "cancel") {
      const context = await loadPerformanceContext(requiredText(payload.siteId, "site ID"));
      // Cancel only the stage. Retained sources, saved readings, analyses and
      // reviews are never deleted by an import cancellation.
      return performanceJson({ preview: context.store.cancel(requiredText(payload.stageId, "stage ID")) });
    }
    throw new PerformanceValidationError("Choose preview, previewLegacy, commit, or cancel.");
  } catch (error) { return performanceError(error); }
}
