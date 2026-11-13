import type { CsvRequest } from "./csv-worker-client";
import { parseCsvStream, calculateValidation, capacityValidation, mappedCsvFile } from "./telemetry-csv";

let file: File | null = null;
let headers: string[] = [];
let rows: string[][] = [];
let queue = Promise.resolve();

self.onmessage = (event: MessageEvent<CsvRequest & { id: number }>) => {
  const request = event.data;
  // Serialize operations so validation can never overtake a file load.
  queue = queue.then(async () => {
    try {
      let value: unknown;
      if (request.kind === "load") {
        file = request.file;
        headers = [];
        rows = [];
        await parseCsvStream(file.stream(), row => {
          if (!headers.length) headers = row.map((header, index) => header || `Column ${index + 1}`);
          else rows.push(row);
        });
        if (!rows.length) throw new Error("The CSV needs a header row and at least one data row.");
        value = { headers, rows: rows.slice(0, 1000), rowCount: rows.length };
      } else if (!file) {
        throw new Error("Choose a CSV file first.");
      } else if (request.kind === "validate") {
        const base = calculateValidation(headers, rows, request.mapping, request.signals, request.timezone, request.timestampConvention);
        const capacity = capacityValidation(headers, rows, request.mapping, request.signals, request.equipment, request.timezone);
        value = { ...base, ...capacity, warnings: base.warnings + capacity.capacityExceededRows + (capacity.capacityCheckReady ? 0 : 1) };
      } else {
        value = mappedCsvFile(file, headers, rows, request.mapping, request.signals);
      }
      self.postMessage({ id: request.id, value });
    } catch (error) {
      self.postMessage({ id: request.id, error: error instanceof Error ? error.message : "Unable to process the CSV." });
    }
  });
};
