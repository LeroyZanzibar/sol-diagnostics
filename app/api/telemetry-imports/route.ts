import { UploadConflictError } from "../../../db/single-performance-file";
import { desc, eq, and } from "drizzle-orm";
import { getDb } from "../../../db";
import { telemetryImports } from "../../../db/schema";
import { csvHeaders, retainImport, validateImport, type ImportMetadata } from "./shared";

function clean(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function safeJson(value: string, fallback: unknown) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export async function GET(request:Request) {
  try {
    const siteId=new URL(request.url).searchParams.get("siteId")?.trim();
    if(!siteId)return Response.json({error:"A site is required."},{status:400});
    const db = getDb();
    const imports = await db.select().from(telemetryImports).where(and(eq(telemetryImports.siteId, siteId),eq(telemetryImports.status,"imported"))).orderBy(desc(telemetryImports.createdAt),desc(telemetryImports.id)).limit(1);
    return Response.json({ import:imports[0]||null,imports,next:null });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to load the current performance file" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const siteId = clean(form.get("siteId"));
    const timezone = clean(form.get("timezone"));
    const mappingText = clean(form.get("mapping"));
    const equipmentMappingText = clean(form.get("equipmentMapping"));
    const typesText = clean(form.get("detectedTypes"));
    const validationText = clean(form.get("validation"));
    if (!(file instanceof File)) return Response.json({ error: "A site, timezone, and CSV file are required." }, { status: 400 });

    const mapping = safeJson(mappingText, {}) as Record<string,string>;
    const equipmentMapping = safeJson(equipmentMappingText, { signals:[], unmatchedEquipmentIds:[] });
    const detectedTypes = safeJson(typesText, []) as string[];
    const validation = safeJson(validationText, {}) as Record<string,unknown>;
    const uploadedHeaders=csvHeaders(await file.slice(0,1024*1024).text());
    const metadata:ImportMetadata={fileName:file.name,fileSize:file.size,siteId,timezone,mapping,equipmentMapping:equipmentMapping as ImportMetadata["equipmentMapping"],detectedTypes,validation};
    if(form.has("replacesImportId"))metadata.replacesImportId=clean(form.get("replacesImportId"));
    const validationError=await validateImport(metadata,uploadedHeaders);
    if(validationError)return Response.json({error:validationError},{status:400});
    const record=await retainImport(metadata,file.stream(),uploadedHeaders);
    return Response.json({ import: record }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to import CSV" }, { status: error instanceof UploadConflictError ? 409 : 500 });
  }
}
