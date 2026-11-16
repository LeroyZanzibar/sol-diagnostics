import { getBucketBinding } from "../../../db/binding";
import { isValidTimezone } from "../../telemetry-time";
import { PerformanceValidationError, type CsvSignal } from "../../performance-ingest";
import { loadPerformanceContext, assertPerformanceWritable, previewPerformanceCsv } from "../performance-data/service";

export const MAX_FILE_SIZE = 100 * 1024 * 1024;
export const MAX_CHUNKS = 256;
export const MAX_CHUNK_SIZE = 512 * 1024;
export type ImportMetadata = {
  fileName: string; fileSize: number; siteId: string; timezone: string; mapping: Record<string, string>;
  equipmentMapping: { signals?: CsvSignal[]; unmatchedEquipmentIds?: unknown[] };
  detectedTypes: string[]; validation: Record<string, unknown>;
  intervalMinutes?: number; timestampConvention?: "start" | "end";
  /** Retained for old transports only: never means replace/delete saved data. */
  replacesImportId?: string;
};
export function csvHeaders(text: string) {
  const headers: string[] = []; let cell = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') { if (quoted && text[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted; }
    else if (char === "," && !quoted) { headers.push(cell.trim()); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) { headers.push(cell.trim()); cell = ""; break; }
    else cell += char;
  }
  if (cell) headers.push(cell.trim());
  if (headers[0]) headers[0] = headers[0].replace(/^\uFEFF/, "");
  return headers;
}
export function uploadIdIsValid(value: string) { return typeof value === "string" && /^[a-f0-9-]{20,64}$/i.test(value); }
export function chunkKey(uploadId: string, part: number) { return `upload-parts/${uploadId}/${String(part).padStart(6, "0")}`; }
export async function validateImport(metadata: ImportMetadata, uploadedHeaders: string[]) {
  if (!metadata || typeof metadata !== "object") return "Valid CSV metadata is required.";
  const { fileName, fileSize, siteId, timezone, mapping, equipmentMapping } = metadata;
  if (typeof fileName !== "string" || !fileName || fileName.length > 256 || typeof siteId !== "string" || !siteId || typeof timezone !== "string" || !timezone) return "A site, timezone, and CSV file are required.";
  if (!isValidTimezone(timezone)) return "Choose a valid IANA source timezone, such as America/New_York or UTC.";
  if (!fileName.toLowerCase().endsWith(".csv")) return "Only CSV files can be imported.";
  if (!Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > MAX_FILE_SIZE) return "CSV files must be between 1 byte and 100 MB.";
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || !mapping.timestamp || Object.values(mapping).some(value => typeof value !== "string")) return "A valid timestamp and column mapping are required.";
  if (!equipmentMapping || typeof equipmentMapping !== "object" || Array.isArray(equipmentMapping) || (equipmentMapping.signals !== undefined && !Array.isArray(equipmentMapping.signals))) return "Valid equipment mappings are required.";
  const validation = metadata.validation || {};
  const convention = metadata.timestampConvention ?? validation.timestampConvention;
  if (convention !== undefined && convention !== "start" && convention !== "end") return "Select whether timestamps represent interval start or interval end.";
  const signals = equipmentMapping.signals || [];
  if (signals.some(signal => !signal || typeof signal !== "object")) return "Valid signal mappings are required.";
  if (signals.some(signal => signal.equipmentId && signal.measurement === "Cumulative energy")) return "Cumulative energy readings must be converted to interval Energy before import.";
  const allowed = [...Object.values(mapping).filter(Boolean), ...signals.filter(signal => signal.equipmentId).map(signal => signal.column)];
  if (allowed.some(column => !column || (uploadedHeaders.length && !uploadedHeaders.includes(column)))) return "One or more mapped columns are missing from the filtered CSV.";
  if (new Set(uploadedHeaders).size !== uploadedHeaders.length || new Set(allowed).size !== allowed.length) return "CSV headers and column mappings must be unique.";
  if (uploadedHeaders.some(header => !allowed.includes(header))) return "The CSV contains unmapped columns. Review mappings before upload.";
  const context = await loadPerformanceContext(siteId);
  const known = new Set(context.equipment.map(item => item.id));
  if (signals.some(signal => signal.equipmentId && !known.has(signal.equipmentId) && !(signal.equipmentId === "@site" && signal.measurement === "Expected Production"))) return "One or more equipment assignments no longer exist in this site configuration.";
  // Partial imports need not supply every revenue meter. Browser row/error/
  // cadence counts are advisory; the server revalidates the entire source.
  return "";
}
function boundedCsvBody(body: ReadableStream<Uint8Array>, expectedBytes: number) {
  const reader = body.getReader(); let bytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          reader.releaseLock();
          if (bytes !== expectedBytes) throw new PerformanceValidationError("The uploaded CSV size does not match the declared file size.");
          controller.close(); return;
        }
        bytes += next.value.byteLength;
        if (bytes > MAX_FILE_SIZE || bytes > expectedBytes) throw new PerformanceValidationError("CSV exceeds its declared size or the 100 MB stream limit.");
        controller.enqueue(next.value);
      } catch (error) { await reader.cancel().catch(() => undefined); reader.releaseLock(); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  });
}
export async function retainImport(metadata: ImportMetadata, body: ReadableStream<Uint8Array>, uploadedHeaders: string[]) {
  const validationError = await validateImport(metadata, uploadedHeaders);
  if (validationError) throw new PerformanceValidationError(validationError);
  const context = await loadPerformanceContext(metadata.siteId);
  await assertPerformanceWritable(context);
  const id = crypto.randomUUID(), date = new Date();
  const safeName = metadata.fileName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-120);
  const objectKey = `mapped/${metadata.siteId}/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${id}-${safeName}`;
  const bucket = getBucketBinding();
  // Source retention is not a canonical commit and does not enter the legacy
  // replacement cleanup queue. Dataset+audit are authoritative in the site DB.
  try {
    await bucket.put(objectKey, boundedCsvBody(body, metadata.fileSize), { httpMetadata: { contentType: "text/csv" },
      customMetadata: { siteId: metadata.siteId, sourceId: id, timezone: metadata.timezone } });
    return await previewPerformanceCsv(context, metadata, objectKey);
  } catch (error) {
    // Only this newly allocated, uncommitted source is ours to remove. A
    // successful preview/cancel never deletes sources or existing site data.
    await bucket.delete(objectKey).catch(() => undefined);
    throw error;
  }
}
