import type { IncomingReading, IngestEquipment } from '../app/performance-ingest';
import type { VcomCredentialsInput, VcomDiscovery, VcomMapping, VcomQualitySummary } from '../app/manual-vcom-types';

export type VcomMeasurementKind = 'simulation' | 'satellite' | 'inverterBulk' | 'meter' | 'poa';
export type VcomRequestDescriptor = {
  requestId: string;
  kind: VcomMeasurementKind;
  deviceId: string | null;
  abbreviation: string | null;
  path: string;
  query: Record<string, string>;
  ownedStartUtc: string;
  ownedEndUtcExclusive: string;
  sourceTimestampConvention: 'start' | 'end';
  conventionId: string;
};
export type VcomDiscoveryDescriptor = { requestId: string; path: string; query: Record<string, never> };
export type Descriptor = VcomRequestDescriptor;
export type VcomRawChunk = {
  version: 1;
  requestId: string;
  descriptor: VcomRequestDescriptor | VcomDiscoveryDescriptor;
  fetchedAt: string;
  payloadSha256: string;
  payload: Record<string, unknown>;
  decodedBodyByteLength: number;
  /** Safe canonical UTC quota/retry deadline for the next network request.
   * Omitted or null means no provider deadline; never contains raw headers. */
  nextRequestAt?: string | null;
};
export type RawChunk = VcomRawChunk;
export type VcomWindow = { startUtc: string; endUtc: string };
/** JSON-persistable; the returned plan and every nested value are frozen. */
export type VcomPlan = {
  readonly version: 1;
  readonly siteId: string;
  readonly systemKey: string;
  readonly timezone: string;
  readonly fromDate: string;
  readonly throughDate: string;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly modelRevision: string;
  readonly datasetRevision: number;
  readonly discovery: VcomDiscovery;
  readonly mappings: VcomMapping[];
  readonly selectedPoaSourceId: string | null;
  readonly requests: VcomRequestDescriptor[];
  readonly windows: VcomWindow[];
  readonly planHash: string;
  readonly readingCount: number;
};
export type Plan = VcomPlan;
export type HourQuality = {
  timestampStartUtc: string;
  sourceId: string;
  requestIds: string[];
  sourceTimestampConvention: 'start' | 'end';
  unitBasis: 'accepted-workflow-convention' | 'abbreviation-metadata';
  conventionId: string;
  state: 'complete' | 'partial' | 'missing';
  expectedSamples: number;
  presentSamples: number;
  validSamples: number;
  nullSamples: number;
  absentSamples: number;
  missingValueSamples: number;
  explicitNullSamples: number;
  emptySamples: number;
  negative: boolean;
  cadenceProved?: boolean;
  partialExpectedKwh?: number | null;
  originalSatellite?: number | null;
  originalPoa?: number | null;
  selectedPoa?: number | null;
  selectedPoaSourceId?: string | null;
  chosenIrradianceSource?: 'satellite' | 'poa' | 'missing';
  satellitePresent?: boolean;
  poaPresent?: boolean;
  originalValue?: number | null;
  sourceUnit?: string;
  aggregation?: string;
};
export class VcomError extends Error {
  constructor(code: string, message: string, status?: number, retryable?: boolean, retryAt?: string | null);
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  /** ISO UTC time, or null when there is no retry allowance. */
  readonly retryAt: string | null;
}
export interface VcomClient {
  get(descriptor: VcomRequestDescriptor | VcomDiscoveryDescriptor, options?: { signal?: AbortSignal }): Promise<VcomRawChunk>;
}
export function createVcomClient(options: {
  auth: VcomCredentialsInput;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  minSpacingMs?: number;
}): VcomClient;
export function discoverVcom(options: { client: VcomClient; systemKey: string; signal?: AbortSignal }): Promise<VcomDiscovery>;
export function validateVcomMappings(options: {
  discovery: VcomDiscovery | null;
  mappings: readonly VcomMapping[];
  selectedPoaSourceId?: string | null;
  /** Planner checks identity/collisions; controller supplies exact current equipment. */
  equipment?: readonly IngestEquipment[];
}): { valid: boolean; ready: boolean; issues: string[] };
export function planVcomImport(options: {
  siteId: string;
  discovery: VcomDiscovery;
  mappings: readonly VcomMapping[];
  selectedPoaSourceId?: string | null;
  fromDate: string;
  throughDate: string;
  modelRevision: string;
  datasetRevision: number;
  now?: number;
}): VcomPlan;
export function normalizeVcomWindow(options: {
  plan: VcomPlan;
  windowStartUtc: string;
  windowEndUtc: string;
  rawChunks: readonly VcomRawChunk[];
}): { readings: IncomingReading[]; quality: HourQuality[]; summary: VcomQualitySummary };
