import { getBucketBinding } from "../../../../db/binding";
import { readBoundedJson, PerformanceValidationError } from "../../../performance-ingest";
import { performanceJson, performanceError } from "../../performance-data/service";
import { chunkKey, MAX_CHUNKS, MAX_FILE_SIZE, retainImport, uploadIdIsValid, validateImport, type ImportMetadata } from "../shared";

type FinalizeRequest = ImportMetadata & { uploadId: string; totalChunks: number };
type CsvPart = { body: ReadableStream<Uint8Array>; size: number };
function concatenate(parts: CsvPart[]) {
  let index = 0, reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (index < parts.length) {
        const active = reader ?? parts[index].body.getReader(); reader = active; const next = await active.read();
        if (!next.done) { controller.enqueue(next.value); return; }
        active.releaseLock(); reader = null; index++;
      }
      controller.close();
    },
    async cancel(reason) {
      if (reader) { await reader.cancel(reason); reader.releaseLock(); index++; }
      await Promise.all(parts.slice(index).map(part => part.body.cancel(reason).catch(() => undefined)));
    },
  });
}
export async function POST(request: Request) {
  let temporaryKeys: string[] = [];
  let upload: ReadableStream<Uint8Array> | undefined;
  const parts: CsvPart[] = [];
  try {
    const payload = await readBoundedJson(request, 1024 * 1024) as unknown as FinalizeRequest;
    if (!uploadIdIsValid(payload.uploadId) || !Number.isInteger(payload.totalChunks) || payload.totalChunks < 1 || payload.totalChunks > MAX_CHUNKS) throw new PerformanceValidationError("Invalid chunked upload.");
    if (!Number.isSafeInteger(payload.fileSize) || payload.fileSize < 1 || payload.fileSize > MAX_FILE_SIZE) throw new PerformanceValidationError("CSV files must be between 1 byte and 100 MB.");
    const bucket = getBucketBinding();
    temporaryKeys = Array.from({ length: payload.totalChunks }, (_, index) => chunkKey(payload.uploadId, index + 1));
    // A header/UTF-8 character may span chunks. Validate it with the full
    // streaming parser after retention, never from a truncated first part.
    const uploadedHeaders: string[] = [];
    const validationError = await validateImport(payload, uploadedHeaders);
    if (validationError) throw new PerformanceValidationError(validationError);
    let totalSize = 0;
    for (const key of temporaryKeys) {
      const part = await bucket.get(key);
      if (!part) throw new PerformanceValidationError("One or more CSV chunks are missing. Retry the import.");
      parts.push(part); totalSize += part.size;
      if (totalSize > MAX_FILE_SIZE) throw new PerformanceValidationError("CSV exceeds the 100 MB limit.");
    }
    if (totalSize !== payload.fileSize) throw new PerformanceValidationError("The uploaded CSV size did not match the source file. Retry the import.");
    upload = concatenate(parts);
    const preview = await retainImport(payload, upload, uploadedHeaders);
    return performanceJson({ preview }, 201);
  } catch (error) { return performanceError(error); }
  finally {
    if (upload && !upload.locked) await upload.cancel().catch(() => undefined);
    await Promise.all(parts.filter(part => !part.body.locked).map(part => part.body.cancel().catch(() => undefined)));
    if (temporaryKeys.length) await getBucketBinding().delete(temporaryKeys).catch(() => undefined);
  }
}
