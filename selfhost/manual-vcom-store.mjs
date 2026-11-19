import {randomUUID} from 'node:crypto';
import {ManualVcomCredentials,ManualVcomError} from './manual-vcom-credentials.mjs';

export const MANUAL_VCOM_LIMITS=Object.freeze({planBytes:8*1024*1024,requests:10000,chunkBytes:17*1024*1024,rawBodyBytes:16*1024*1024,rawJobBytes:256*1024*1024,windowRawBytes:64*1024*1024,windowBytes:32*1024*1024,normalizedBytes:512*1024*1024,readings:2000000,stateBytes:2*1024*1024,leaseMs:120000,stageAttempts:3,retries:4});
const active="('queued','downloading','staging','awaiting_approval')";
const work="('queued','downloading','staging')";
const fail=(code,message,status=409)=>{throw new ManualVcomError(code,message,status);};
function json(value,maximum,label){const text=JSON.stringify(value);if(text===undefined||Buffer.byteLength(text)>maximum)fail('limit',`${label} exceeds the manual import safety limit.`,400);return text;}
function integer(value){if(!Number.isSafeInteger(value)||value<0)fail('validation','A valid saved generation is required.',400);return value;}
function nextRequestTime(chunk){
  if(!Object.hasOwn(chunk,'nextRequestAt')||chunk.nextRequestAt===null)return 0;
  const value=chunk.nextRequestAt;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))fail('validation','Invalid provider next-request deadline.',400);
  const time=Date.parse(value),year=Number(value.slice(0,4));
  if(!Number.isFinite(time)||year<1000||year>9998||new Date(time).toISOString()!==value)fail('validation','Invalid provider next-request deadline.',400);
  return time;
}
export class ManualVcomStore {
  constructor({database,dataDirectory,clock=()=>Date.now()}){
    this.database=database;this.sqlite=database.sqlite;this.clock=clock;this.vault=new ManualVcomCredentials(this.sqlite,dataDirectory);
    this.wake=()=>{};
  }
  transaction(operation){this.sqlite.exec('BEGIN IMMEDIATE');try{const result=operation();if(result&&typeof result.then==='function')throw Error('Manual VCOM transactions must be synchronous.');this.sqlite.exec('COMMIT');return result;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
  now(){return new Date(this.clock()).toISOString();}
  settings(siteId){
    const row=this.sqlite.prepare('SELECT site_id,generation,system_key,auth_mode,credentials IS NOT NULL AS has_credentials,discovery,mappings,selected_poa_source_id,updated_at FROM vcom_site_settings WHERE site_id=?').get(siteId);
    return row?{siteId:row.site_id,generation:row.generation,systemKey:row.system_key,authMode:row.auth_mode,hasCredentials:!!row.has_credentials,discovery:row.discovery?JSON.parse(row.discovery):null,mappings:JSON.parse(row.mappings),selectedPoaSourceId:row.selected_poa_source_id,updatedAt:row.updated_at}:{siteId,generation:0,systemKey:'',authMode:'basic',hasCredentials:false,discovery:null,mappings:[],selectedPoaSourceId:null,updatedAt:null};
  }
  credentials(siteId){const row=this.sqlite.prepare('SELECT credentials FROM vcom_site_settings WHERE site_id=?').get(siteId);if(!row?.credentials)fail('credentials-required','Save VCOM credentials first.',401);return this.vault.decrypt(siteId,row.credentials);}
  cas(siteId,generation){integer(generation);const saved=this.settings(siteId);if(saved.generation!==generation)fail('stale-generation','The saved configuration generation changed. Reload this workspace.');return saved;}
  invalidate(siteId){this.sqlite.prepare(`UPDATE vcom_manual_jobs SET status='failed',error_code='stale-configuration',message='The saved configuration changed. Start a new explicit import.',lease_token=NULL,lease_until=NULL,next_attempt_at=NULL,updated_at=? WHERE site_id=? AND status IN ('queued','downloading','staging','awaiting_approval','failed')`).run(this.now(),siteId);}
  configure(siteId,generation,systemKey,credentials){
    this.vault.assertAvailable();
    if(typeof systemKey!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(systemKey))fail('validation','A valid exact VCOM system key is required.',400);
    const encrypted=credentials===undefined?undefined:this.vault.encrypt(siteId,credentials);
    return this.transaction(()=>{
      const saved=this.cas(siteId,generation),row=this.sqlite.prepare('SELECT credentials FROM vcom_site_settings WHERE site_id=?').get(siteId),changed=saved.systemKey!==systemKey;
      this.sqlite.prepare(`INSERT INTO vcom_site_settings(site_id,generation,system_key,auth_mode,credentials,discovery,mappings,selected_poa_source_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET generation=excluded.generation,system_key=excluded.system_key,auth_mode=excluded.auth_mode,credentials=excluded.credentials,discovery=excluded.discovery,mappings=excluded.mappings,selected_poa_source_id=excluded.selected_poa_source_id,updated_at=excluded.updated_at`).run(siteId,generation+1,systemKey,credentials?.mode??saved.authMode,encrypted??row?.credentials??null,changed?null:saved.discovery?JSON.stringify(saved.discovery):null,changed?'[]':JSON.stringify(saved.mappings),changed?null:saved.selectedPoaSourceId,this.now());
      this.invalidate(siteId);return this.settings(siteId);
    });
  }
  saveDiscovery(siteId,generation,discovery){
    const encoded=json(discovery,2*1024*1024,'Discovery');
    return this.transaction(()=>{const saved=this.cas(siteId,generation);if(discovery?.systemKey!==saved.systemKey)fail('discovery-mismatch','Discovery does not match the saved system.');this.sqlite.prepare('UPDATE vcom_site_settings SET generation=generation+1,discovery=?,updated_at=? WHERE site_id=?').run(encoded,this.now(),siteId);this.invalidate(siteId);return this.settings(siteId);});
  }
  saveMappings(siteId,generation,mappings,selectedPoaSourceId){
    const encoded=json(mappings,1024*1024,'Mappings');
    return this.transaction(()=>{this.cas(siteId,generation);this.sqlite.prepare('UPDATE vcom_site_settings SET generation=generation+1,mappings=?,selected_poa_source_id=?,updated_at=? WHERE site_id=?').run(encoded,selectedPoaSourceId||null,this.now(),siteId);this.invalidate(siteId);return this.settings(siteId);});
  }
  decode(row){if(!row)return null;return {id:row.id,siteId:row.site_id,requestId:row.request_id,generation:row.generation,fromDate:row.from_date,throughDate:row.through_date,actor:row.actor,plan:JSON.parse(row.plan),status:row.status,createdAt:row.created_at,updatedAt:row.updated_at,nextAttemptAt:row.next_attempt_at===null?null:new Date(row.next_attempt_at).toISOString(),completedRequests:row.completed_requests,totalRequests:row.total_requests,rawBytes:row.raw_bytes,attempts:row.attempts,stageAttempts:row.stage_attempts,leaseToken:row.lease_token,leaseUntil:row.lease_until,message:row.message,errorCode:row.error_code,stageId:row.stage_id,preview:row.preview?JSON.parse(row.preview):null,result:row.result?JSON.parse(row.result):null,quality:row.quality?JSON.parse(row.quality):null,state:JSON.parse(row.state)};}
  job(siteId,id){const job=this.decode(this.sqlite.prepare('SELECT * FROM vcom_manual_jobs WHERE site_id=? AND id=?').get(siteId,id));if(!job)fail('job-not-found','This manual import job is not available.',400);return job;}
  jobs(siteId){return this.sqlite.prepare("SELECT id,site_id,request_id,generation,from_date,through_date,actor,'{}' AS plan,status,created_at,updated_at,next_attempt_at,completed_requests,total_requests,raw_bytes,attempts,stage_attempts,lease_token,lease_until,message,error_code,stage_id,preview,result,quality,'{}' AS state FROM vcom_manual_jobs WHERE site_id=? ORDER BY created_at DESC,id DESC LIMIT 50").all(siteId).map(row=>this.decode(row));}
  activeJob(siteId){return this.decode(this.sqlite.prepare(`SELECT * FROM vcom_manual_jobs WHERE site_id=? AND status IN ${active} LIMIT 1`).get(siteId));}
  byRequest(siteId,requestId){return this.decode(this.sqlite.prepare('SELECT * FROM vcom_manual_jobs WHERE site_id=? AND request_id=?').get(siteId,requestId));}
  identity(existing,input){if(existing.generation!==input.generation||existing.fromDate!==input.fromDate||existing.throughDate!==input.throughDate)fail('request-id-conflict','This request ID already belongs to a different manual import.');return existing;}
  createJob(input){
    const encoded=json(input.plan,MANUAL_VCOM_LIMITS.planBytes,'Request plan');
    if(!Array.isArray(input.plan.requests)||input.plan.requests.length>MANUAL_VCOM_LIMITS.requests||input.plan.readingCount>MANUAL_VCOM_LIMITS.readings)fail('limit','The manual request plan is too large.',400);
    return this.transaction(()=>{
      const previous=this.byRequest(input.siteId,input.requestId);if(previous)return this.identity(previous,input);
      this.cas(input.siteId,input.generation);
      if(this.sqlite.prepare(`SELECT 1 FROM vcom_manual_jobs WHERE site_id=? AND status IN ${active}`).get(input.siteId))fail('job-active','Finish or cancel the unfinished manual import before starting another.');
      const id=randomUUID(),now=this.now();this.sqlite.prepare(`INSERT INTO vcom_manual_jobs(id,site_id,request_id,generation,from_date,through_date,actor,plan,status,created_at,updated_at,total_requests,message) VALUES (?,?,?,?,?,?,?,?,'queued',?,?,?,'Manual download queued.')`).run(id,input.siteId,input.requestId,input.generation,input.fromDate,input.throughDate,input.actor,encoded,now,now,input.plan.requests.length);return this.job(input.siteId,id);
    });
  }
  pendingDelay(){const row=this.sqlite.prepare(`SELECT MIN(MAX(COALESCE(next_attempt_at,0),COALESCE(lease_until,0))) due FROM vcom_manual_jobs WHERE status IN ${work}`).get();return row.due===null?null:Math.max(0,row.due-this.clock());}
  claim(){
    return this.transaction(()=>{
      const now=this.clock(),row=this.sqlite.prepare(`SELECT * FROM vcom_manual_jobs WHERE status IN ${work} AND COALESCE(next_attempt_at,0)<=? AND COALESCE(lease_until,0)<=? ORDER BY created_at,id LIMIT 1`).get(now,now);if(!row)return null;
      const job=this.decode(row);if(this.settings(job.siteId).generation!==job.generation){this.invalidate(job.siteId);return null;}
      // An interrupted stage has no resumable loader. Wait for the store's TTL
      // rather than allocating loading-stage orphans on every server restart.
      if(job.state.stagingStarted&&job.state.stagingStarted+3601000>now){this.sqlite.prepare('UPDATE vcom_manual_jobs SET next_attempt_at=?,lease_token=NULL,lease_until=NULL,message=? WHERE id=?').run(job.state.stagingStarted+3601000,'Interrupted staging will retry after its temporary payload expires.',job.id);return null;}
      const token=randomUUID();this.sqlite.prepare('UPDATE vcom_manual_jobs SET lease_token=?,lease_until=?,next_attempt_at=NULL,updated_at=? WHERE id=?').run(token,now+MANUAL_VCOM_LIMITS.leaseMs,this.now(),job.id);return this.job(job.siteId,job.id);
    });
  }
  fenced(id,token){const row=this.sqlite.prepare('SELECT * FROM vcom_manual_jobs WHERE id=?').get(id),job=this.decode(row);if(!job||job.leaseToken!==token||job.leaseUntil<=this.clock()||!['queued','downloading','staging'].includes(job.status)||this.settings(job.siteId).generation!==job.generation)fail('stale-lease','This manual import lease was canceled or became stale.');return job;}
  heartbeat(id,token){
    // A staging batch must not reload an 8 MiB plan on each lease heartbeat.
    const saved=this.sqlite.prepare('SELECT j.lease_token,j.lease_until,j.status,j.generation,s.generation AS current_generation FROM vcom_manual_jobs j JOIN vcom_site_settings s ON s.site_id=j.site_id WHERE j.id=?').get(id);
    if(!saved||saved.lease_token!==token||saved.lease_until<=this.clock()||!['queued','downloading','staging'].includes(saved.status)||saved.generation!==saved.current_generation)fail('stale-lease','This manual import lease was canceled or became stale.');
    this.sqlite.prepare('UPDATE vcom_manual_jobs SET lease_until=? WHERE id=? AND lease_token=?').run(this.clock()+MANUAL_VCOM_LIMITS.leaseMs,id,token);
  }
  completeChunk(id,token,chunk){
    const nextRequestAt=nextRequestTime(chunk),raw=json(chunk,MANUAL_VCOM_LIMITS.chunkBytes,'Provider response'),bytes=Buffer.byteLength(raw);
    if(!Number.isSafeInteger(chunk.decodedBodyByteLength)||chunk.decodedBodyByteLength<0||chunk.decodedBodyByteLength>MANUAL_VCOM_LIMITS.rawBodyBytes)fail('limit','The provider response exceeds the byte limit.',400);
    return this.transaction(()=>{
      const job=this.fenced(id,token),descriptor=job.plan.requests[job.completedRequests];
      if(!descriptor||chunk.requestId!==descriptor.requestId||JSON.stringify(chunk.descriptor)!==JSON.stringify(descriptor))fail('chunk-mismatch','A provider response does not match the immutable request plan.');
      if(job.rawBytes+bytes>MANUAL_VCOM_LIMITS.rawJobBytes)fail('limit','The manual import exceeds its total raw response limit.',400);
      // Save success/cursor/deadline in the same transaction. A final response
      // retains quota provenance but cannot delay offline normalization for it.
      const nextAttemptAt=Math.max(this.clock()+2000,job.completedRequests+1<job.totalRequests?nextRequestAt:0);
      this.sqlite.prepare('INSERT INTO vcom_manual_chunks(job_id,request_index,request_id,plan_hash,payload_hash,raw,bytes) VALUES(?,?,?,?,?,?,?)').run(id,job.completedRequests,chunk.requestId,job.plan.planHash,chunk.payloadSha256,raw,bytes);
      this.sqlite.prepare("UPDATE vcom_manual_jobs SET completed_requests=completed_requests+1,raw_bytes=raw_bytes+?,status='downloading',attempts=0,lease_token=NULL,lease_until=NULL,next_attempt_at=?,message='Downloading saved request plan.',updated_at=? WHERE id=?").run(bytes,nextAttemptAt,this.now(),id);
      return this.job(job.siteId,id);
    });
  }
  chunk(id,index){const row=this.sqlite.prepare('SELECT raw,plan_hash FROM vcom_manual_chunks WHERE job_id=? AND request_index=?').get(id,index);if(!row)fail('chunk-unavailable','A saved provider response is unavailable.');return JSON.parse(row.raw);}
  windowChunks(job,window){
    const indices=job.plan.requests.map((r,i)=>r.ownedStartUtc<window.endUtc&&r.ownedEndUtcExclusive>window.startUtc?i:-1).filter(i=>i>=0);let bytes=0;
    return indices.map(i=>{const row=this.sqlite.prepare('SELECT raw,bytes,plan_hash FROM vcom_manual_chunks WHERE job_id=? AND request_index=?').get(job.id,i);if(!row||row.plan_hash!==job.plan.planHash)fail('chunk-unavailable','Saved provider responses do not match this plan.');bytes+=row.bytes;if(bytes>MANUAL_VCOM_LIMITS.windowRawBytes)fail('limit','One provider window exceeds the raw normalization limit.',400);return JSON.parse(row.raw);});
  }
  chunkManifest(job){return this.sqlite.prepare('SELECT request_index AS requestIndex,request_id AS requestId,plan_hash AS planHash,payload_hash AS payloadSha256,bytes FROM vcom_manual_chunks WHERE job_id=? ORDER BY request_index').all(job.id);}
  checkpointWindow(id,token,reference,quality){
    return this.transaction(()=>{
      const job=this.fenced(id,token),state={...job.state,windowObjects:[...(job.state.windowObjects||[]),reference],readingCount:(job.state.readingCount||0)+reference.readings,normalizedBytes:(job.state.normalizedBytes||0)+reference.bytes};
      if(state.readingCount>MANUAL_VCOM_LIMITS.readings||state.normalizedBytes>MANUAL_VCOM_LIMITS.normalizedBytes)fail('limit','The normalized manual import exceeds its safety limit.',400);
      const summary=job.quality?{...job.quality}:Object.fromEntries(Object.keys(quality).filter(k=>k!=='warnings').map(k=>[k,0]));
      for(const [key,value] of Object.entries(quality))if(typeof value==='number')summary[key]=key==='sources'?value:(summary[key]||0)+value;
      summary.warnings=[...new Set([...(job.quality?.warnings||[]),...(quality.warnings||[])])].slice(0,200);
      this.sqlite.prepare("UPDATE vcom_manual_jobs SET state=?,quality=?,status='staging',message='Preparing source and quality preview.',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(json(state,MANUAL_VCOM_LIMITS.stateBytes,'Job checkpoint'),json(summary,128*1024,'Quality summary'),this.now(),id);return this.job(job.siteId,id);
    });
  }
  beginStage(id,token){const job=this.fenced(id,token);if(job.stageAttempts>=MANUAL_VCOM_LIMITS.stageAttempts)fail('stage-retry-limit','This import exhausted its safe staging attempts. Cancel it and start a new explicit import.');this.sqlite.prepare("UPDATE vcom_manual_jobs SET status='staging',stage_attempts=stage_attempts+1,state=?,message='Staging the manual approval preview.',updated_at=? WHERE id=?").run(json({...job.state,stagingStarted:this.clock()},MANUAL_VCOM_LIMITS.stateBytes,'Job checkpoint'),this.now(),id);}
  finishStage(id,token,preview){return this.transaction(()=>{const job=this.fenced(id,token);this.sqlite.prepare("UPDATE vcom_manual_jobs SET status='awaiting_approval',stage_id=?,preview=?,state=?,message='Review this preview, then explicitly Apply.',error_code=NULL,lease_token=NULL,lease_until=NULL,next_attempt_at=NULL,updated_at=? WHERE id=?").run(preview.stageId,json(preview,2*1024*1024,'Approval preview'),json({...job.state,stagingStarted:null},MANUAL_VCOM_LIMITS.stateBytes,'Job checkpoint'),this.now(),id);return this.job(job.siteId,id);});}
  failJob(id,token,{code,retryable=false,retryAt=null}){
    return this.transaction(()=>{
      const job=this.fenced(id,token),attempts=job.attempts+1,retry=retryable&&attempts<=MANUAL_VCOM_LIMITS.retries;
      const requested=Number(retryAt),delay=Math.max(2000,Number.isFinite(requested)&&requested>this.clock()?requested-this.clock():2000*2**attempts);
      this.sqlite.prepare('UPDATE vcom_manual_jobs SET status=?,attempts=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,error_code=?,message=?,updated_at=? WHERE id=?').run(retry?'queued':'failed',attempts,retry?this.clock()+delay:null,code,retry?'Provider request delayed; the authorized job will retry.':'Manual import stopped. Review the safe error code before retrying.',this.now(),id);return this.job(job.siteId,id);
    });
  }
  cancel(siteId,id){return this.transaction(()=>{const job=this.job(siteId,id);if(job.status==='committed')return job;this.sqlite.prepare("UPDATE vcom_manual_jobs SET status='canceled',message='Manual import canceled; saved data is unchanged.',lease_token=NULL,lease_until=NULL,next_attempt_at=NULL,updated_at=? WHERE id=?").run(this.now(),id);return this.job(siteId,id);});}
  retry(siteId,id){return this.transaction(()=>{const job=this.job(siteId,id);if(job.status==='committed')return job;if(job.status!=='failed'&&job.status!=='awaiting_approval')fail('job-not-retryable','Only a failed or expired preview may be retried.');this.cas(siteId,job.generation);if(['stale-configuration','stale-model','stale-dataset'].includes(job.errorCode))fail(job.errorCode,'This import is stale. Start a new explicit import.');if(this.sqlite.prepare(`SELECT 1 FROM vcom_manual_jobs WHERE site_id=? AND id<>? AND status IN ${active}`).get(siteId,id))fail('job-active','Another unfinished manual import is active.');this.sqlite.prepare("UPDATE vcom_manual_jobs SET status='queued',stage_id=NULL,preview=NULL,attempts=0,error_code=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,message='Resuming the original saved plan.',updated_at=? WHERE id=?").run(this.now(),id);return this.job(siteId,id);});}
  reconcile(siteId,id,preview){
    if(preview.status!=='committed'||!preview.result)fail('receipt-missing','An authoritative commit receipt is required.');
    const job=this.job(siteId,id);if(preview.siteId!==siteId||preview.result.siteId!==siteId||job.stageId!==preview.stageId||preview.result.stageId!==job.stageId||preview.metadata.source!=='api'||preview.metadata.sourceImportId!==`vcom:${id}`)fail('receipt-mismatch','The commit receipt does not match this exact job and stage.');
    this.sqlite.prepare("UPDATE vcom_manual_jobs SET status='committed',result=?,preview=?,message='Imported. Run analysis manually when ready.',error_code=NULL,lease_token=NULL,lease_until=NULL,next_attempt_at=NULL,updated_at=? WHERE id=? AND site_id=?").run(json(preview.result,128*1024,'Receipt'),json(preview,2*1024*1024,'Committed preview'),this.now(),id,siteId);return this.job(siteId,id);
  }
}
