import { desc, eq, and } from "drizzle-orm";
import { getDb } from "../../../db";
import { telemetryImports } from "../../../db/schema";
import { PerformanceValidationError } from "../../performance-ingest";
import { performanceJson, performanceError } from "../performance-data/service";
import { csvHeaders, MAX_FILE_SIZE, retainImport, type ImportMetadata } from "./shared";

function text(value: FormDataEntryValue | null) { return typeof value === "string" ? value : ""; }
function parse(value: FormDataEntryValue | null, fallback: unknown) {
  if (!value) return fallback;
  if (typeof value !== "string" || value.length > 1024 * 1024) throw new PerformanceValidationError("CSV metadata is too large.");
  try { return JSON.parse(value); } catch { throw new PerformanceValidationError("Invalid CSV metadata JSON."); }
}
export async function GET(request: Request) {
  try {
    const siteId = new URL(request.url).searchParams.get("siteId");
    if (!siteId) return performanceJson({ error: "A site is required." }, 400);
    const imports = await getDb().select().from(telemetryImports).where(and(eq(telemetryImports.siteId, siteId), eq(telemetryImports.status, "imported"))).orderBy(desc(telemetryImports.createdAt), desc(telemetryImports.id)).limit(1);
    return performanceJson({ import: imports[0] || null, imports, next: null });
  } catch (error) { return performanceError(error); }
}
export async function POST(request: Request) {
  try {
    // Multipart framing and metadata get 2 MB beyond the 100 MB CSV budget.
    // Count actual wire bytes even if Content-Length is absent or misleading.
    const limit = MAX_FILE_SIZE + 2 * 1024 * 1024;
    if (!request.body || Number(request.headers.get("content-length") || 0) > limit) throw new PerformanceValidationError("CSV upload is too large or empty.");
    let bytes = 0;
    const stream = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      bytes += chunk.byteLength; if (bytes > limit) throw new PerformanceValidationError("CSV upload exceeds the 100 MB file and metadata limit."); controller.enqueue(chunk);
    } }));
    let form: FormData;
    try { form = await new Response(stream, { headers: { "Content-Type": request.headers.get("content-type") || "" } }).formData(); }
    catch (error) { if (error instanceof PerformanceValidationError) throw error; throw new PerformanceValidationError("Invalid multipart CSV upload."); }
    const file = form.get("file");
    if (!(file instanceof File)) throw new PerformanceValidationError("A site, timezone, and CSV file are required.");
    const metadata: ImportMetadata = { fileName: file.name, fileSize: file.size, siteId: text(form.get("siteId")), timezone: text(form.get("timezone")),
      mapping: parse(form.get("mapping"), {}) as ImportMetadata["mapping"], equipmentMapping: parse(form.get("equipmentMapping"), {}) as ImportMetadata["equipmentMapping"],
      detectedTypes: parse(form.get("detectedTypes"), []) as string[], validation: parse(form.get("validation"), {}) as Record<string, unknown> };
    if (form.has("intervalMinutes")) metadata.intervalMinutes = Number(text(form.get("intervalMinutes")));
    if (form.has("timestampConvention")) metadata.timestampConvention = text(form.get("timestampConvention")) as "start" | "end";
    const uploadedHeaders = csvHeaders(await file.slice(0, 1024 * 1024).text());
    const preview = await retainImport(metadata, file.stream(), uploadedHeaders);
    return performanceJson({ preview }, 201);
  } catch (error) { return performanceError(error); }
}
