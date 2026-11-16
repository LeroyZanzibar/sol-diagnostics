/** Server-side contract for isolated, versioned site performance databases. */
export type PerformanceValue = number | string | null;
export type PerformanceChannel = {
  id: string;
  equipmentId: string;
  measurement: string;
  unit: string;
};
export type PerformanceReading = {
  timestamp: string;
  channel: PerformanceChannel;
  value: PerformanceValue;
};
export type PerformanceImportMetadata = {
  source: "csv" | "api" | "migration";
  fileName: string;
  timezone: string;
  intervalMinutes: number;
  modelRevision: string;
  sourceImportId?: string;
  originalObjectKey?: string;
  sourceTimestampConvention?: "start" | "end";
};
export type PerformanceImportCounts = {
  added: number;
  overlapping: number;
  changed: number;
  identical: number;
  blankPreserved: number;
};
export type PerformanceDataset = {
  siteId: string;
  revision: number;
  revisionId: string;
  timezone: string;
  intervalMinutes: number;
  timestampStart: string | null;
  timestampEnd: string | null;
  timestampCount: number;
  readingCount: number;
  channelCount: number;
  createdAt: string;
  updatedAt: string;
};
export type PerformanceCommit = {
  siteId: string;
  stageId: string;
  revision: number;
  revisionId: string;
  committedAt: string;
  counts: PerformanceImportCounts;
};
export type PerformancePreview = {
  siteId: string;
  stageId: string;
  previewToken: string;
  baseRevision: number;
  status: "preview" | "committed" | "canceled";
  counts: PerformanceImportCounts;
  timestampStart: string | null;
  timestampEnd: string | null;
  readingCount: number;
  channelCount: number;
  metadata: PerformanceImportMetadata;
  samples: { timestamp: string; channel: PerformanceChannel; previous: PerformanceValue; incoming: PerformanceValue }[];
  createdAt: string;
  expiresAt: string;
  result?: PerformanceCommit;
};
export type PerformanceInputScope = {
  start: string;
  end: string;
  equipmentIds?: string[];
  measurements?: string[];
};
export type PerformanceAnalysisProvenance = {
  version: 1;
  siteId: string;
  revision: number;
  revisionId: string;
  scopes: PerformanceInputScope[];
  hashes: string[];
  dependencyScope: "analysis-range";
};
export type PerformanceImportAudit = PerformanceCommit & {
  metadata: PerformanceImportMetadata;
  actor: string;
  overlapApproved: boolean;
};
export interface SitePerformanceStore {
  describe(revision?: number): PerformanceDataset;
  stage(metadata: PerformanceImportMetadata, readings: Iterable<PerformanceReading> | AsyncIterable<PerformanceReading>, options?: { expectedRevision: number }): Promise<PerformancePreview>;
  preview(stageId: string): PerformancePreview;
  commit(stageId: string, options: { previewToken: string; approveOverlap: boolean; modelRevision: string; actor: string }): PerformanceCommit;
  cancel(stageId: string): PerformancePreview;
  rows(revision?: number, scope?: PerformanceInputScope): IterableIterator<PerformanceReading>;
  fingerprint(revision: number, scope: PerformanceInputScope): string;
  imports(limit?: number): PerformanceImportAudit[];
  recordAnalysis(runId: string, provenance: PerformanceAnalysisProvenance): void;
  analysis(runId: string): PerformanceAnalysisProvenance | null;
  close(): void;
}
export interface PerformanceStoreManager {
  /** Check committed data without creating a database for an absent site. */
  hasData(siteId: string): boolean;
  site(siteId: string): SitePerformanceStore;
  close(): void;
}
let testManager: PerformanceStoreManager | undefined;
export function optionalPerformanceStoreManager(): PerformanceStoreManager | undefined {
  return testManager || (globalThis as unknown as Record<symbol, { performance?: PerformanceStoreManager } | undefined>)[Symbol.for("sol-diagnostics.runtime")]?.performance;
}
export function getPerformanceStoreManager(): PerformanceStoreManager {
  const manager = optionalPerformanceStoreManager();
  if (!manager) throw new Error("The site performance database service is unavailable.");
  return manager;
}
export function setPerformanceStoreManagerForTests(manager?: PerformanceStoreManager) {
  testManager = manager;
}
