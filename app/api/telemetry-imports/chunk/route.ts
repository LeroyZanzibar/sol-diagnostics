import { getBucketBinding } from "../../../../db/binding";
import { PerformanceValidationError } from "../../../performance-ingest";
import { performanceJson, performanceError } from "../../performance-data/service";
import { chunkKey, MAX_CHUNK_SIZE, MAX_CHUNKS, uploadIdIsValid } from "../shared";

export async function PUT(request: Request) {
  try {
    const url = new URL(request.url), uploadId = url.searchParams.get("uploadId") || "", part = Number(url.searchParams.get("part"));
    if (!uploadIdIsValid(uploadId) || !Number.isInteger(part) || part < 1 || part > MAX_CHUNKS) throw new PerformanceValidationError("Invalid upload chunk.");
    if (Number(request.headers.get("content-length") || 0) > MAX_CHUNK_SIZE) return performanceJson({ error: "Upload chunks cannot exceed 512 KB." }, 413);
    if (!request.body) throw new PerformanceValidationError("An upload chunk body is required.");
    const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_CHUNK_SIZE) throw new PerformanceValidationError("Upload chunks cannot exceed 512 KB.");
        chunks.push(next.value);
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    finally { reader.releaseLock(); }
    if (!size) throw new PerformanceValidationError("Upload chunks must be between 1 byte and 512 KB.");
    const body = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    await getBucketBinding().put(chunkKey(uploadId, part), body, { httpMetadata: { contentType: "application/octet-stream" } });
    return performanceJson({ part, size }, 201);
  } catch (error) { return performanceError(error); }
}
export async function DELETE(request: Request) {
  try {
    const uploadId = new URL(request.url).searchParams.get("uploadId") || "";
    if (!uploadIdIsValid(uploadId)) throw new PerformanceValidationError("Invalid upload identifier.");
    const bucket = getBucketBinding(); let cursor: string | undefined; const keys: string[] = [];
    do { const page = await bucket.list({ prefix: `upload-parts/${uploadId}/`, cursor }); keys.push(...page.objects.map((item: { key: string }) => item.key)); cursor = page.truncated ? page.cursor : undefined; } while (cursor);
    if (keys.length) await bucket.delete(keys);
    return performanceJson({ deleted: keys.length });
  } catch (error) { return performanceError(error); }
}
