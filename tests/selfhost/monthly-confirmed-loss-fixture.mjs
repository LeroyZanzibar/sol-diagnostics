// Synthetic-only setup for built HTTP/browser tests. No application imports this file.
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {LocalDatabase,LocalBucket} from '../../selfhost/storage.mjs';
import {loadSource} from '../source-module.mjs';
const review=loadSource('app/issue-review.ts');
export const lossTimezone='America/New_York';
export function monthlyLossIssues(){
 const issue=(id,start,end,loss,patch={})=>({id,equipmentId:'inv1',equipmentName:'Inverter 1',equipmentType:'inverter',type:'Equipment outage',category:'Availability',name:'Inverter outage',description:'Synthetic monthly loss fixture',confidence:'confirmed',startDateTime:start,endDateTime:end,durationMinutes:(Date.parse(end)-Date.parse(start))/60000,estimatedLossKwh:loss,actualEnergyKwh:0,expectedEnergyKwh:loss,intervalMinutes:30,...patch});
 return [
  issue('january','2026-01-15T17:00:00.000Z','2026-01-15T17:30:00.000Z',123.25),
  issue('boundary','2026-02-01T04:30:00.000Z','2026-02-01T05:30:00.000Z',40.5,{intervalLosses:[
   {timestamp:'2026-02-01T04:30:00.000Z',intervalMinutes:30,lossKwh:10.25,countedLossKwh:10.25,actualKwh:0,expectedKwh:10.25},
   {timestamp:'2026-02-01T05:00:00.000Z',intervalMinutes:30,lossKwh:100.25,countedLossKwh:30.25,actualKwh:0,expectedKwh:100.25},
  ]}),
  issue('unreviewed','2026-01-20T17:00:00.000Z','2026-01-20T17:30:00.000Z',999),
  issue('unknown','2026-02-15T17:00:00.000Z','2026-02-15T17:30:00.000Z',null,{lossUnknown:true,expectedUnknown:true}),
 ];
}
export async function seedMonthlyLossRun(f,{runId='monthly-current',issues=monthlyLossIssues(),publish=true}={}){
 const db=new LocalDatabase(join(f.directory,'sol-diagnostics.sqlite'),resolve('drizzle'));
 try{
  const importId=`monthly-loss-input-${f.siteId}`,objectKey=`analysis/${f.siteId}/jobs/${runId}/result.json`;
  for(const issue of issues){issue.eventKey=await review.issueEventKey(f.siteId,issue);issue.evidenceSignature=await review.issueEvidenceSignature(issue);}
  db.sqlite.prepare(`INSERT OR IGNORE INTO telemetry_imports(id,site_id,file_name,object_key,file_size,row_count,valid_rows,timezone,mapping,detected_types,validation,timestamp_start,timestamp_end) VALUES(?,?,?,?,0,0,0,?,'{}','{}',?,?,?)`).run(importId,f.siteId,'synthetic-monthly-loss.csv','synthetic-retained-input',lossTimezone,JSON.stringify({intervalMinutes:30,timestampConvention:'start'}),'2026-01-01T05:00:00.000Z','2026-04-01T03:30:00.000Z');
  db.sqlite.prepare(`INSERT INTO analysis_runs(id,site_id,import_id,parser_version,model_revision,status,issue_count,analysis_object_key,completed_at) VALUES(?,?,?,28,'synthetic-monthly-model','completed',?,?,?)`).run(runId,f.siteId,importId,issues.length,objectKey,'2026-04-02T00:00:00.000Z');
  const payload={siteId:f.siteId,importId,parserVersion:28,modelRevision:'synthetic-monthly-model',timeZone:lossTimezone,generatedAt:'2026-04-02T00:00:00.000Z',
   import:{id:importId,fileName:'synthetic-monthly-loss.csv',createdAt:'2026-04-01T12:00:00.000Z',timestampStart:'2026-01-01T05:00:00.000Z',timestampEnd:'2026-04-01T03:30:00.000Z'},
   validation:{intervalMinutes:30,timestampConvention:'start'},summary:{timezone:lossTimezone},issueDatabase:{analysisRunId:runId,persistedIssueCount:issues.length},
   analysis:{timezone:lossTimezone,analysisIntervalMinutes:30,issues,recurringIssues:[]}};
  await new LocalBucket(db,join(f.directory,'objects')).put(objectKey,JSON.stringify(payload));
  if(publish)db.sqlite.prepare('INSERT OR REPLACE INTO performance_summaries(import_id,site_id,summary,processed_at) VALUES(?,?,?,?)').run(importId,f.siteId,JSON.stringify({analysisRunId:runId,objectKey,parserVersion:28,modelRevision:'synthetic-monthly-model'}),'2026-04-02T00:00:00.000Z');
  return payload;
 }finally{db.close();}
}
export async function lossRequest(f,path,{body,method=body===undefined?'GET':'POST',status=200}={}){
 const response=await fetch(f.base+path,{method,headers:{Authorization:f.authorization,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 const text=await response.text();assert.equal(response.status,status,text);assert.match(response.headers.get('content-type')||'',/application\/json/);return JSON.parse(text);
}
export async function saveLossReview(f,runId,issueId,status,extra={}){
 const path=`/api/issue-reviews?siteId=${encodeURIComponent(f.siteId)}&runId=${encodeURIComponent(runId)}&issueId=${encodeURIComponent(issueId)}`;
 const before=await lossRequest(f,path),state={...before.review.state,...extra,status};
 if(status==='Dismissed')state.dismissalReason='Synthetic test dismissal';
 const saved=await lossRequest(f,'/api/issue-reviews',{body:{siteId:f.siteId,runId,issueId,baseVersion:before.review.version,state,note:'Synthetic monthly automatic-update check'}});
 const after=await lossRequest(f,path);assert.equal(after.review.state.status,status);assert.equal(after.review.version,saved.review.version);return after;
}
