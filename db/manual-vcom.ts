import type { VcomSettingsPublic, VcomManualJob, VcomCredentialsInput, VcomDiscovery, VcomMapping, VcomQualitySummary } from '../app/manual-vcom-types';
import type { PerformancePreview } from './performance-store';
import type { planVcomImport, createVcomClient } from '../selfhost/vcom-provider.mjs';
export type VcomPlan = ReturnType<typeof planVcomImport>;
export type VcomRawChunk = Awaited<ReturnType<ReturnType<typeof createVcomClient>['get']>>;
export type VcomWindowReference = { key: string; sha256: string; bytes: number; readings: number; windowStartUtc: string; windowEndUtc: string };
export type VcomNativeJob = VcomManualJob & {
  actor: string; plan: VcomPlan; leaseToken: string | null; leaseUntil: number | null;
  rawBytes: number; attempts: number; stageAttempts: number;
  state: { windowObjects?: VcomWindowReference[]; readingCount?: number; normalizedBytes?: number; stagingStarted?: number | null };
};
export type VcomSavedSettings = Omit<VcomSettingsPublic,'ready'|'issues'>;
export interface ManualVcomStore {
  settings(siteId: string): VcomSavedSettings;
  credentials(siteId: string): VcomCredentialsInput;
  cas(siteId: string, generation: number): VcomSavedSettings;
  configure(siteId: string, generation: number, systemKey: string, credentials?: VcomCredentialsInput): VcomSavedSettings;
  saveDiscovery(siteId: string, generation: number, discovery: VcomDiscovery): VcomSavedSettings;
  saveMappings(siteId: string, generation: number, mappings: VcomMapping[], selectedPoaSourceId: string | null): VcomSavedSettings;
  job(siteId: string,id: string): VcomNativeJob;
  jobs(siteId: string): VcomNativeJob[];
  activeJob(siteId: string): VcomNativeJob | null;
  byRequest(siteId: string, requestId: string): VcomNativeJob | null;
  identity(job: VcomNativeJob, input: {generation:number;fromDate:string;throughDate:string}): VcomNativeJob;
  createJob(input: {siteId:string;generation:number;requestId:string;fromDate:string;throughDate:string;actor:string;plan:VcomPlan}): VcomNativeJob;
  claim(): VcomNativeJob | null;
  fenced(id:string,token:string): VcomNativeJob;
  heartbeat(id:string,token:string): void;
  completeChunk(id:string,token:string,chunk:VcomRawChunk): VcomNativeJob;
  windowChunks(job:VcomNativeJob, window:{startUtc:string;endUtc:string}): VcomRawChunk[];
  chunkManifest(job:VcomNativeJob): unknown[];
  checkpointWindow(id:string,token:string,reference:VcomWindowReference,quality:VcomQualitySummary): VcomNativeJob;
  beginStage(id:string,token:string): void;
  finishStage(id:string,token:string,preview:PerformancePreview): VcomNativeJob;
  failJob(id:string,token:string,error:{code:string;retryable?:boolean;retryAt?:number|null}): VcomNativeJob;
  pendingDelay(): number | null;
  cancel(siteId:string,id:string): VcomNativeJob;
  retry(siteId:string,id:string): VcomNativeJob;
  reconcile(siteId:string,id:string,preview:PerformancePreview): VcomNativeJob;
}
export interface ManualVcomRuntime {
  store: ManualVcomStore;
  wake(): void;
  verifyWorker(token:string|null): boolean;
  runWork?<T>(operation:()=>Promise<T>): Promise<T>;
}
export function getManualVcomRuntime(): ManualVcomRuntime {
  const value=(globalThis as unknown as Record<symbol,{manualVcom?:ManualVcomRuntime}|undefined>)[Symbol.for('sol-diagnostics.runtime')]?.manualVcom;
  if(!value)throw Object.assign(new Error('Manual VCOM imports require the self-hosted runtime.'),{status:503,code:'runtime-unavailable'});
  return value;
}
