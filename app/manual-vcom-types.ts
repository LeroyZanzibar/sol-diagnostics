/** Public manual VCOM contract. No native imports or credential return values. */
import type { PerformancePreview, PerformanceCommit } from "../db/performance-store";

export type VcomAuthMode = "basic" | "bearer";
export type VcomCredentialsInput = { mode: "basic"; apiKey: string; username: string; password: string }
  | { mode: "bearer"; apiKey: string; accessToken: string };
export type VcomSourceKind = "simulation" | "irradiance" | "inverter" | "meter-export" | "meter-import" | "poa";
export type VcomSource = {
  id: string; name: string; kind: VcomSourceKind; deviceId: string | null;
  measurement: "Expected Production" | "Irradiance" | "Energy" | "Other";
  unit: string; sourceUnit: string; aggregation: string;
  eligible: boolean; reason: string | null;
};
export type VcomDiscovery = {
  systemKey: string; systemName: string; timezone: string; discoveredAt: string;
  sources: VcomSource[]; poaSensors: VcomSource[];
  excludedMeters: { id: string; name: string; reason: string }[];
  warnings: string[]; metadataDigest: string;
};
/** Missing/false preserves legacy inclusion; excluded rows keep no destination. */
export type VcomMapping = { sourceId: string; equipmentId: string; measurement: string; excluded?: boolean };
export type VcomSettingsPublic = {
  siteId: string; generation: number; systemKey: string; authMode: VcomAuthMode;
  hasCredentials: boolean; discovery: VcomDiscovery | null; mappings: VcomMapping[];
  selectedPoaSourceId: string | null; ready: boolean; issues: string[]; updatedAt: string | null;
};
export type VcomQualitySummary = {
  hours: number; sources: number; missingReadings: number;
  partialSimulationHours: number; missingSimulationHours: number;
  satelliteGaps: number; poaFilled: number; remainingIrradianceGaps: number; warnings: string[];
};
export type VcomManualJob = {
  id: string; siteId: string; requestId: string; generation: number;
  fromDate: string; throughDate: string;
  status: "queued" | "downloading" | "staging" | "awaiting_approval" | "committed" | "failed" | "canceled";
  createdAt: string; updatedAt: string; nextAttemptAt: string | null;
  completedRequests: number; totalRequests: number; message: string; errorCode: string | null;
  stageId: string | null; preview: PerformancePreview | null;
  result: PerformanceCommit | null; quality: VcomQualitySummary | null;
};
export type VcomWorkspace = { settings: VcomSettingsPublic; jobs: VcomManualJob[]; job?: VcomManualJob };
export type VcomAction =
  | { action: "configure"; siteId: string; expectedGeneration: number; systemKey: string; credentials?: VcomCredentialsInput }
  | { action: "discover"; siteId: string; expectedGeneration: number }
  | { action: "mappings"; siteId: string; expectedGeneration: number; mappings: VcomMapping[]; selectedPoaSourceId: string | null }
  | { action: "start"; siteId: string; expectedGeneration: number; requestId: string; fromDate: string; throughDate: string }
  | { action: "cancel" | "retry"; siteId: string; jobId: string }
  | { action: "apply"; siteId: string; jobId: string; stageId: string; previewToken: string; approveOverlap: boolean };
