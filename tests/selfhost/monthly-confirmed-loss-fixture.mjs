// Synthetic-only setup for built HTTP/browser tests. No application imports this file.
import assert from 'node:assert/strict';
import {loadSource} from '../source-module.mjs';
import {monthlyLossIssues, seedMonthlyLossPublication} from '../../scripts/monthly-loss-persistence-smoke.mjs';
export {lossTimezone, monthlyLossIssues} from '../../scripts/monthly-loss-persistence-smoke.mjs';
const review=loadSource('app/issue-review.ts');
export async function seedMonthlyLossRun(f,{runId='monthly-current',issues=monthlyLossIssues(),publish=true}={}){
 for(const issue of issues){issue.eventKey=await review.issueEventKey(f.siteId,issue);issue.evidenceSignature=await review.issueEvidenceSignature(issue);}
 return seedMonthlyLossPublication(f,{runId,issues,publish});
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
