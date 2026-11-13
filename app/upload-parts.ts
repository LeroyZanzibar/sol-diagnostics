const CHUNK_SIZE = 512 * 1024;
const CONCURRENCY = 3;

// All in-flight requests settle before the caller removes temporary chunks.
export async function uploadCsvParts(file: File, uploadId: string, onProgress: (value: number) => void) {
  const total = Math.ceil(file.size / CHUNK_SIZE);
  let next = 0, completed = 0;
  let failure: Error | null = null;
  const upload = async () => {
    while (!failure && next < total) {
      const index = next++;
      const body = file.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
      try {
        for (let attempt = 0; ; attempt++) {
          let response: Response;
          try {
            response = await fetch(`/api/telemetry-imports/chunk?uploadId=${encodeURIComponent(uploadId)}&part=${index + 1}`, {
              method: "PUT", headers: { "content-type": "application/octet-stream" }, body,
            });
          } catch (error) {
            if (attempt >= 2 || failure) throw error;
            await new Promise(resolve => setTimeout(resolve, 400 * 2 ** attempt));
            continue;
          }
          if (response.ok) { await response.arrayBuffer(); break; }
          const message = await response.text();
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          if (!retryable || attempt >= 2 || failure) {
            let detail = `CSV upload failed (${response.status}). Please retry.`;
            try { detail = JSON.parse(message).error || detail; } catch { /* Keep a readable error for HTML responses. */ }
            throw new Error(detail);
          }
          await new Promise(resolve => setTimeout(resolve, 400 * 2 ** attempt));
        }
        completed++;
        onProgress(Math.round(completed / (total + 1) * 100));
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Unable to upload the CSV.");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, upload));
  if (failure) throw failure;
  return total;
}
