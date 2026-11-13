import type { EquipmentAsset } from "./equipment";
import type { Mapping, SignalMapping, Validation } from "./telemetry-csv";
import type { TimestampConvention } from "./telemetry-time";

export type CsvRequest =
  | { kind: "load"; file: File }
  | { kind: "validate"; mapping: Mapping; signals: SignalMapping[]; equipment: EquipmentAsset[]; timezone: string; timestampConvention: TimestampConvention }
  | { kind: "prepare"; mapping: Mapping; signals: SignalMapping[] };

export class CsvProcessor {
  private worker = new Worker(new URL("./telemetry.worker.ts", import.meta.url), { type: "module" });
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private closed = false;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<{ id: number; value?: unknown; error?: string }>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      if (event.data.error) pending.reject(new Error(event.data.error));
      else pending.resolve(event.data.value);
    };
    this.worker.onerror = () => this.close("CSV processing failed. Choose the file again to retry.");
    this.worker.onmessageerror = () => this.close("The CSV result could not be read. Choose the file again.");
  }

  private request<T>(request: CsvRequest): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Choose the CSV file again."));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      try { this.worker.postMessage({ id, ...request }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  load(file: File) { return this.request<{ headers: string[]; rows: string[][]; rowCount: number }>({ kind: "load", file }); }
  validate(mapping: Mapping, signals: SignalMapping[], equipment: EquipmentAsset[], timezone: string, timestampConvention: TimestampConvention) {
    return this.request<Validation>({ kind: "validate", mapping, signals, equipment, timezone, timestampConvention });
  }
  prepare(mapping: Mapping, signals: SignalMapping[]) {
    return this.request<File>({ kind: "prepare", mapping, signals });
  }
  close(message = "CSV processing was cancelled.") {
    this.closed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }
}
