import { loadPerformanceContext, performanceError, requiredText } from "../service";

/** Spreadsheet-safe text; numeric readings (including negatives) stay numeric.
 * Formula-like textual fields gain a leading apostrophe, disclosed by the UI. */
function cell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(request: Request) {
  try {
    const siteId = requiredText(new URL(request.url).searchParams.get("siteId"), "site ID");
    const { store, dataset } = await loadPerformanceContext(siteId);
    if (!dataset.revision || !dataset.readingCount) {
      return Response.json({ error: "No applied performance readings are available to export." },
        { status: 400, headers: { "Cache-Control": "private, no-store" } });
    }
    // Explicit revision plus immediate iterator creation protects even a download
    // that has not been consumed yet. No mutable head is consulted during export.
    const rows = store.rows(dataset.revision);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("Timestamp,Equipment ID,Measurement,Value,Unit,Channel ID\r\n"));
      },
      pull(controller) {
        try {
          let text = "", done = false;
          for (let count = 0; count < 500 && text.length < 65536; count++) {
            const next = rows.next();
            if (next.done) { done = true; break; }
            const { timestamp, channel, value } = next.value;
            text += [timestamp, channel.equipmentId, channel.measurement, value, channel.unit, channel.id].map(cell).join(",") + "\r\n";
          }
          if (text) controller.enqueue(encoder.encode(text));
          if (done) { rows.return?.(); controller.close(); }
        } catch (error) { rows.return?.(); controller.error(error); }
      },
      cancel() { rows.return?.(); },
    });
    return new Response(stream, { headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="performance-data-revision-${dataset.revision}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Data-Revision": String(dataset.revision),
      "X-CSV-Text-Safety": "formula-like text prefixed with apostrophe",
    } });
  } catch (error) { return performanceError(error); }
}
