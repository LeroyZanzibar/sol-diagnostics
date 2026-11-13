// D1 errors often put the useful message in `cause`; logging the Error object
// alone can retain only its stack in hosted logs.
export function databaseErrorDetails(error: unknown) {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current) && messages.length < 6) {
    seen.add(current);
    if (typeof current === "object") {
      const value = current as { name?: string; message?: string; cause?: unknown };
      if (value.message) messages.push(`${value.name || "Error"}: ${value.message}`);
      current = value.cause;
    } else { messages.push(String(current)); break; }
  }
  return messages.join(" | ") || "Unknown database error";
}

export function transientDatabaseError(error: unknown) {
  const details = databaseErrorDetails(error);
  if (/SQLITE_(FULL|CONSTRAINT|MISMATCH|TOOBIG)|quota|storage limit|database.*full|disk.*full|maximum.*size|exceeded.*limit/i.test(details)) return false;
  return /SQLITE_(BUSY|LOCKED)|overloaded|temporar|unavailable|internal error|network|connection|reset|timed?\s*out|timeout|try again/i.test(details);
}

export class DatabaseWriteError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`Database write failed (${operation})`, { cause });
    this.name = "DatabaseWriteError";
  }
}

// Only call for idempotent writes. Check the lease/cancellation before retries.
export async function retryDatabaseWrite<T>(operation: string, write: () => Promise<T>, checkpoint?: () => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    if (attempt) await checkpoint?.();
    try { return await write(); }
    catch (error) {
      if (attempt >= 3 || !transientDatabaseError(error)) throw new DatabaseWriteError(operation, error);
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

export function analysisFailureMessage(error: unknown) {
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : "";
  // Import-correction errors are actionable for retained uploads too. Do not turn
  // them into a generic retry loop, or expose arbitrary internal exception text.
  if (/^Invalid timestamp on CSV row \d+: (daylight-saving times require an explicit UTC offset|check the date and source timezone)\.$/.test(message) || [
    "Choose a valid IANA source timezone before analysis.",
    "An interval duration could not be determined. Supply at least two timestamps with a consistent cadence.",
    "The timestamps have inconsistent interval lengths. Convert all signals to one explicit cadence before importing; gaps may be whole multiples of that cadence.",
    "Cumulative energy readings must be converted to interval energy (kWh) before import. Map interval readings as Energy.",
  ].includes(message)) return `${message} Correct the source file or import settings and upload again.`;
  const details = databaseErrorDetails(error);
  if (/SQLITE_FULL|storage limit|database.*full|disk.*full|maximum.*size/i.test(details))
    return "The database has reached its storage limit. Your upload and analysis checkpoint are retained. Database capacity must be resolved before retrying.";
  if (/quota|exceeded.*limit/i.test(details))
    return "The database has reached a service limit. Your upload and analysis checkpoint are retained. Retry after the limit is resolved.";
  if (/SQLITE_CONSTRAINT/i.test(details))
    return "The database rejected an analysis record because of a data constraint. Your upload is retained; the detailed error has been logged for investigation.";
  if (error instanceof DatabaseWriteError || /D1_|SQLITE_/i.test(details))
    return "The database could not save the analysis. Your upload and completed save checkpoints are retained. Retry to resume saving.";
  return "Analysis could not complete. Retry using the retained upload.";
}
