import { getManualVcomRuntime, type VcomNativeJob, type VcomWindowReference } from '../../../db/manual-vcom';
import { getBucketBinding } from '../../../db/binding';
import type { VcomAction, VcomManualJob, VcomSettingsPublic, VcomWorkspace } from '../../manual-vcom-types';
import type { PerformancePreview } from '../../../db/performance-store';
import { createVcomClient, discoverVcom, planVcomImport, normalizeVcomWindow, validateVcomMappings } from '../../../selfhost/vcom-provider.mjs';
import { PerformanceValidationError, type IncomingReading } from '../../performance-ingest';
import { loadPerformanceContext, assertPerformanceWritable, previewPerformanceProvider, commitPerformancePreview,
  PerformanceConflictError, requiredText, performanceJson, type PerformanceContext } from '../performance-data/service';

const WINDOW_BYTES=32*1024*1024;
function generation(value:unknown):number { if(!Number.isSafeInteger(value)||Number(value)<0)throw new PerformanceValidationError('A valid saved generation is required.');return Number(value); }
function settingsFor(context:PerformanceContext):VcomSettingsPublic {
  const settings=getManualVcomRuntime().store.settings(context.siteId);
  const validation=settings.discovery?validateVcomMappings({discovery:settings.discovery,mappings:settings.mappings,
    selectedPoaSourceId:settings.selectedPoaSourceId,equipment:context.equipment}):{ready:false,issues:['Discover the saved system before mapping its sources.']};
  const issues=[...(!settings.hasCredentials?['Save credentials before connecting.']:[]),...validation.issues];
  return {...settings,ready:settings.hasCredentials&&validation.ready,issues};
}
function authoritativePreview(context:PerformanceContext,job:VcomNativeJob):PerformancePreview|null {
  if(!job.stageId)return null;
  try{return context.store.preview(job.stageId);}catch(error){if(['STAGE_EXPIRED','STAGE_NOT_FOUND'].includes(String((error as {code?:string})?.code)))return job.preview;throw error;}
}
function publicJob(context:PerformanceContext,job:VcomNativeJob):VcomManualJob {
  const preview=authoritativePreview(context,job),receipt=preview?.status==='committed'?preview.result:null;
  // Whitelist the public contract; plans, auth, leases and private state stay native.
  return {id:job.id,siteId:job.siteId,requestId:job.requestId,generation:job.generation,fromDate:job.fromDate,throughDate:job.throughDate,
    status:receipt?'committed':job.status,createdAt:job.createdAt,updatedAt:job.updatedAt,nextAttemptAt:receipt?null:job.nextAttemptAt,
    completedRequests:job.completedRequests,totalRequests:job.totalRequests,message:receipt?'Imported. Run analysis manually when ready.':job.message,
    errorCode:receipt?null:job.errorCode,stageId:job.stageId,preview,result:receipt||job.result,quality:job.quality};
}
export async function manualVcomWorkspace(siteId:string,jobId?:string):Promise<VcomWorkspace> {
  const context=await loadPerformanceContext(requiredText(siteId,'site ID')),store=getManualVcomRuntime().store;
  return {settings:settingsFor(context),jobs:store.jobs(siteId).map(job=>publicJob(context,job)),...(jobId?{job:publicJob(context,store.job(siteId,requiredText(jobId,'job ID')))}:{})};
}
function compatible(context:PerformanceContext,job:VcomNativeJob) {
  getManualVcomRuntime().store.cas(job.siteId,job.generation);
  if(context.modelRevision!==job.plan.modelRevision)throw new PerformanceConflictError('The array model changed. Start a new explicit import.','stale-model');
  if(context.dataset.revision!==job.plan.datasetRevision)throw new PerformanceConflictError('Saved readings changed. Start a new explicit import.','stale-dataset');
}
function reconcile(context:PerformanceContext,job:VcomNativeJob):boolean {
  if(!job.stageId)return false;
  // Cached public previews cannot authorize releasing an unfinished job slot.
  let preview:PerformancePreview;
  try{preview=context.store.preview(job.stageId);}catch(error){if(['STAGE_EXPIRED','STAGE_NOT_FOUND'].includes(String((error as {code?:string})?.code)))return false;throw error;}
  if(preview?.status==='committed'&&preview.result){getManualVcomRuntime().store.reconcile(job.siteId,job.id,preview);return true;}
  return false;
}
function cancelInvalidatedPreviews(context:PerformanceContext) {
  for(const job of getManualVcomRuntime().store.jobs(context.siteId)) {
    if(job.status==='failed'&&job.errorCode==='stale-configuration'&&job.stageId) {
      try { const preview=context.store.preview(job.stageId);if(preview.status!=='committed')context.store.cancel(job.stageId); }
      catch { /* Expired/removed temporary previews require no further cleanup. */ }
    }
  }
}
export async function mutateManualVcom(payload:Record<string,unknown>,actor:string):Promise<VcomWorkspace> {
  const siteId=requiredText(payload.siteId,'site ID'),context=await loadPerformanceContext(siteId),runtime=getManualVcomRuntime(),store=runtime.store;
  const action=payload as VcomAction;let jobId:string|undefined;
  if(action.action==='configure'){
    store.configure(siteId,generation(action.expectedGeneration),requiredText(action.systemKey,'exact system key',128),action.credentials);
  }else if(action.action==='discover'){
    const saved=store.cas(siteId,generation(action.expectedGeneration));
    if(!saved.systemKey)throw new PerformanceValidationError('Save an exact system key first.');
    const discovery=await discoverVcom({client:createVcomClient({auth:store.credentials(siteId)}),systemKey:saved.systemKey});
    store.saveDiscovery(siteId,saved.generation,discovery);
  }else if(action.action==='mappings'){
    const saved=store.cas(siteId,generation(action.expectedGeneration));
    if(!saved.discovery)throw new PerformanceValidationError('Discover this saved system first.');
    if(!Array.isArray(action.mappings)||action.mappings.length>10000)throw new PerformanceValidationError('Supply the complete explicit source mapping.');
    const selected=action.selectedPoaSourceId===''?null:action.selectedPoaSourceId;
    if(selected!==null&&typeof selected!=='string')throw new PerformanceValidationError('Explicitly choose a POA source or no POA fallback.');
    const validation=validateVcomMappings({discovery:saved.discovery,mappings:action.mappings,selectedPoaSourceId:selected,equipment:context.equipment});
    if(!validation.ready)throw new PerformanceValidationError(validation.issues.join(' ').slice(0,2000)||'The complete source mapping is not ready.');
    // Recheck the exact live model after any asynchronous context loading.
    const fresh=await loadPerformanceContext(siteId);
    if(fresh.modelRevision!==context.modelRevision)throw new PerformanceConflictError('The model changed while saving mappings. Reload and review.','stale-model');
    store.saveMappings(siteId,saved.generation,action.mappings,selected);
  }else if(action.action==='start'){
    const input={siteId,generation:generation(action.expectedGeneration),requestId:requiredText(action.requestId,'request ID',128),fromDate:requiredText(action.fromDate,'start date',10),throughDate:requiredText(action.throughDate,'through date',10),actor:requiredText(actor,'authenticated actor')};
    const previous=store.byRequest(siteId,input.requestId);
    if(previous){jobId=store.identity(previous,input).id;return manualVcomWorkspace(siteId,jobId);}
    store.cas(siteId,input.generation);const settings=settingsFor(context);
    if(!settings.ready||!settings.discovery)throw new PerformanceValidationError('Discover and confirm every source mapping before starting a download.');
    await assertPerformanceWritable(context);
    const plan=planVcomImport({siteId,discovery:settings.discovery,mappings:settings.mappings,selectedPoaSourceId:settings.selectedPoaSourceId,
      fromDate:input.fromDate,throughDate:input.throughDate,modelRevision:context.modelRevision,datasetRevision:context.dataset.revision});
    const fresh=await loadPerformanceContext(siteId);
    if(fresh.modelRevision!==context.modelRevision||fresh.dataset.revision!==context.dataset.revision)throw new PerformanceConflictError('The site changed while planning. Start again.','stale-preview');
    // An earlier Apply may have committed before its shared receipt write failed.
    // Repair only that exact receipt on this explicit mutation; GET stays read-only.
    const active=store.activeJob(siteId);if(active)reconcile(fresh,active);
    // Immutable plan is saved before the server is allowed to make any request.
    jobId=store.createJob({...input,plan}).id;runtime.wake();
  }else if(action.action==='cancel'||action.action==='retry'||action.action==='apply'){
    jobId=requiredText(action.jobId,'job ID');const job=store.job(siteId,jobId);
    if(action.action==='apply'){
      const stageId=requiredText(action.stageId,'stage ID');
      if(stageId!==job.stageId)throw new PerformanceConflictError('Approve the exact stage belonging to this job.','stale-vcom-approval');
      if(typeof action.approveOverlap!=='boolean')throw new PerformanceValidationError('approveOverlap must explicitly be true or false.');
      await commitPerformancePreview({siteId,stageId,previewToken:action.previewToken,approveOverlap:action.approveOverlap,manualVcomJobId:jobId},actor);
      // The per-site receipt is authoritative; this shared write is reconciliation,
      // not a cross-database transaction. GET can read it after a lost response.
      store.reconcile(siteId,jobId,context.store.preview(stageId));
    }else if(!reconcile(context,job)){
      if(action.action==='cancel'){
        store.cancel(siteId,jobId);
        if(job.stageId)try{context.store.cancel(job.stageId);}catch{/* Expired temporary payloads need no cancellation. */}
      }else{
        compatible(context,job);await assertPerformanceWritable(context);
        if(job.status==='awaiting_approval'){
          let live:PerformancePreview|null=null;try{live=context.store.preview(job.stageId!);}catch(error){if(!['STAGE_EXPIRED','STAGE_NOT_FOUND'].includes(String((error as {code?:string})?.code)))throw error;}
          if(live?.status==='preview'&&Date.parse(live.expiresAt)>Date.now())throw new PerformanceConflictError('This preview is still available. Apply or cancel it.','preview-active');
        }
        if(job.stageId)try{context.store.cancel(job.stageId);}catch{/* Expired previews are restaged from the original chunks. */}
        store.retry(siteId,jobId);runtime.wake();
      }
    }
  }else throw new PerformanceValidationError('Choose a supported manual VCOM action.');
  if(['configure','discover','mappings'].includes(action.action))cancelInvalidatedPreviews(context);
  return manualVcomWorkspace(siteId,jobId);
}
async function digest(text:string):Promise<string> {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');
}
async function immutableObject(key:string,text:string) {
  const bucket=getBucketBinding(),previous=await bucket.get(key);
  if(previous){if(await previous.text()!==text)throw new PerformanceConflictError('The saved source manifest does not match this job.','source-mismatch');return;}
  await bucket.put(key,text,{httpMetadata:{contentType:'application/json'}});
}
async function readWindow(reference:VcomWindowReference):Promise<{readings:IncomingReading[]}> {
  const object=await getBucketBinding().get(reference.key);
  if(!object||object.size!==reference.bytes||object.size>WINDOW_BYTES)throw new PerformanceConflictError('A normalized source window is unavailable.','source-mismatch');
  const text=await object.text();if(await digest(text)!==reference.sha256)throw new PerformanceConflictError('A normalized source window changed.','source-mismatch');
  const data=JSON.parse(text);if(!Array.isArray(data.readings)||data.readings.length!==reference.readings)throw new PerformanceConflictError('The saved window count changed.','source-mismatch');return data;
}
const localCodes=new Set(['stale-configuration','stale-generation','stale-model','stale-dataset','stale-preview','stale-lease','stale-vcom-approval','limit','stage-retry-limit','credential-key-unavailable','invalid-credentials','credentials-required','source-mismatch','chunk-unavailable','chunk-mismatch','validation','maintenance','migration-required','request-id-conflict','job-active','job-not-found','job-not-retryable','discovery-mismatch','receipt-missing','receipt-mismatch','preview-active','runtime-unavailable']);
function safeFailure(error:unknown) {
  const value=error as {code?:string;retryable?:boolean;retryAt?:number|string;status?:number;statusCode?:number};
  const code=String(value?.code||'');
  // Provider error bodies/messages are never reflected or persisted.
  return {code:localCodes.has(code)||/^VCOM_[A-Z_]{1,48}$/.test(code)?code:'provider-failure',retryable:value?.retryable===true,
    retryAt:typeof value?.retryAt==='number'?value.retryAt:typeof value?.retryAt==='string'?Date.parse(value.retryAt):null};
}
export function manualVcomError(error:unknown) {
  const value=error as {code?:string;status?:number;statusCode?:number};
  const raw=value?.status||value?.statusCode||(error instanceof SyntaxError?400:500),proposed=value?.code==='STAGE_EXPIRED'?409:value?.code==='STAGE_NOT_FOUND'?400:raw===502?503:raw;
  const status=[400,401,403,409,429,500,503].includes(proposed)?proposed:500;
  const safe=safeFailure(error);
  const message=error instanceof PerformanceValidationError||error instanceof PerformanceConflictError?error.message:
    safe.code==='credential-key-unavailable'?'The VCOM credential key is unavailable. Restore the original private key.':
    status===401?'VCOM authentication failed. Check the saved credentials.':status===409?'This manual import changed or conflicts with saved state. Reload the workspace.':
    status===400?'The manual import request is invalid. Review its fields and saved configuration.':status===429?'VCOM is rate limited. Retry after the indicated wait.':'Unable to complete the manual VCOM operation. No provider error body is exposed.';
  return performanceJson({error:message,code:safe.code},status);
}
/** One bounded request or one normalization window per invocation; GET is never a worker. */
export async function workManualVcom(signal?:AbortSignal) {
  const store=getManualVcomRuntime().store,job=store.claim();if(!job)return {worked:false};const token=job.leaseToken!;
  try{
    const context=await loadPerformanceContext(job.siteId);compatible(context,job);await assertPerformanceWritable(context);
    const current=()=>{signal?.throwIfAborted();store.heartbeat(job.id,token);};current();
    if(job.completedRequests<job.totalRequests){
      const chunk=await createVcomClient({auth:store.credentials(job.siteId)}).get(job.plan.requests[job.completedRequests],{signal});
      current();const fresh=await loadPerformanceContext(job.siteId);compatible(fresh,job);store.completeChunk(job.id,token,chunk);
    }else{
      const references=job.state.windowObjects||[],window=job.plan.windows[references.length];
      if(window){
        const result=normalizeVcomWindow({plan:job.plan,windowStartUtc:window.startUtc,windowEndUtc:window.endUtc,rawChunks:store.windowChunks(job,window)});
        const text=JSON.stringify({version:1,planHash:job.plan.planHash,windowStartUtc:window.startUtc,windowEndUtc:window.endUtc,...result}),bytes=new TextEncoder().encode(text).byteLength;
        if(bytes>WINDOW_BYTES)throw new PerformanceValidationError('A normalized provider window exceeds its safety limit.');
        const sha256=await digest(text),key=`manual-vcom/${job.id}/window-${references.length}-${sha256}.json`;await immutableObject(key,text);current();
        store.checkpointWindow(job.id,token,{key,sha256,bytes,readings:result.readings.length,windowStartUtc:window.startUtc,windowEndUtc:window.endUtc},result.summary);
      }else{
        const manifestKey=`manual-vcom/${job.id}/manifest.json`,manifest=JSON.stringify({version:1,provider:'vcom',jobId:job.id,siteId:job.siteId,generation:job.generation,plan:job.plan,chunks:store.chunkManifest(job),windows:references,quality:job.quality});
        if(new TextEncoder().encode(manifest).byteLength>8*1024*1024)throw new PerformanceValidationError('The source manifest exceeds its safety limit.');
        await immutableObject(manifestKey,manifest);current();store.beginStage(job.id,token);
        async function* batches(){for(const reference of references){current();const window=await readWindow(reference);for(let index=0;index<window.readings.length;index+=2000){current();yield window.readings.slice(index,index+2000);}}}
        const preview=await previewPerformanceProvider(context,{timezone:job.plan.timezone,gridTimestamp:job.plan.startUtc,sourceImportId:`vcom:${job.id}`,originalObjectKey:manifestKey},batches(),current);
        try{current();store.finishStage(job.id,token,preview);}catch(error){context.store.cancel(preview.stageId);throw error;}
      }
    }
    return {worked:true};
  }catch(error){
    const failure=signal?.aborted?{code:'worker-interrupted',retryable:true,retryAt:null}:safeFailure(error);
    try{store.failJob(job.id,token,failure);}catch(fence){if(String((fence as {code?:string})?.code)!=='stale-lease')throw fence;}
    return {worked:true};
  }
}
