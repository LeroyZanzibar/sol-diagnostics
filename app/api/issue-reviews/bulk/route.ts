import {getDatabaseBinding} from '../../../../db/binding';
import {savedAnalysis} from '../../analysis-history/service';
import {assessReviews,effectiveReviews} from '../service';
import {blankReview,operationalCauses,type ReviewState} from '../../../issue-review';
async function hash(value:unknown){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export async function POST(request:Request){try{
 const p=await request.json(),items=p.items,patch=p.patch;
 if(typeof p.siteId!=='string'||typeof p.runId!=='string'||typeof p.operationId!=='string'||!/^[\w-]{16,100}$/.test(p.operationId))throw new Error('Invalid bulk review request.');
 if(!Array.isArray(items)||!items.length||items.length>25||new Set(items.map(i=>i.issueId)).size!==items.length)throw new Error('Explicitly select 1–25 distinct findings per batch.');
 if(!patch||typeof patch.confirm!=='boolean'||typeof patch.note!=='string'||patch.note.length>10000||typeof patch.classification!=='string'||patch.classification&&!operationalCauses.includes(patch.classification)||(!patch.confirm&&!patch.classification&&!patch.note.trim()))throw new Error('Choose confirmation, a classification, or a note.');
 const payload=await savedAnalysis(p.siteId,p.runId,true),byId=new Map<string,any>(payload.analysis.issues.map((i:any)=>[i.id,i]));
 const selected=items.map((item:any)=>{const issue=byId.get(item.issueId);if(!issue||!issue.eventKey||issue.evidenceSignature!==item.evidenceSignature||!Number.isInteger(item.baseVersion)||item.baseVersion<0)throw new Error('A selected finding is unavailable or changed. Reload the analysis.');return {...item,issue};});
 if(new Set(selected.map(i=>i.issue.eventKey)).size!==selected.length)throw new Error('Duplicate event selection.');
 const db=getDatabaseBinding(),keys=selected.map(i=>i.issue.eventKey),marks=keys.map(()=>'?').join(',');
 const rows=await db.prepare(`SELECT r.event_key,r.version,r.state,r.updated_at,(SELECT c.run_id FROM issue_review_changes c WHERE c.site_id=r.site_id AND c.event_key=r.event_key AND c.version=r.version) AS run_id FROM issue_event_reviews r WHERE r.site_id=? AND r.event_key IN (${marks})`).bind(p.siteId,...keys).all();
 const existing=new Map<string,any>(rows.results.map((r:any)=>[r.event_key,r]));
 const inherited=payload.analysis.recurringIssues?.length?new Map((await effectiveReviews(db,p.siteId,p.runId,payload,keys)).filter(r=>r.inheritedFrom).map(r=>[r.eventKey,r])):new Map<string,any>();
 const actor=request.headers.get('oai-authenticated-user-email')||request.headers.get('oai-authenticated-user-id')||'Site service / local preview';
 const changeIds=await Promise.all(selected.map(item=>hash([p.siteId,p.runId,p.operationId,item.issue.eventKey,item.baseVersion,item.evidenceSignature,patch])));
 const prior=await db.prepare(`SELECT id FROM issue_review_changes WHERE site_id=? AND id IN (${changeIds.map(()=>'?').join(',')})`).bind(p.siteId,...changeIds).all();
 const applied=new Set(prior.results.map((r:any)=>r.id));
 const now=new Date().toISOString(),results:any[]=[],writes:any[]=[],pending:any[]=[];
 for(const [index,item] of selected.entries()){
  const key=item.issue.eventKey,old=existing.get(key),changeId=changeIds[index];
  if(applied.has(changeId)){results.push({issueId:item.issueId,eventKey:key,replayed:true});continue;}
  if((old?.version||0)!==item.baseVersion){results.push({issueId:item.issueId,eventKey:key,error:'Another analyst updated this finding. Reload before applying changes.'});continue;}
  const state:ReviewState=old?JSON.parse(old.state):inherited.get(key)?.state||blankReview(item.issue,item.issue.evidenceSignature);
  state.evidenceRunId=state.evidenceRunId||old?.run_id||p.runId;
  if(patch.confirm){state.status='Confirmed';state.dismissalReason='';state.evidenceRunId=p.runId;state.evidenceSignature=item.issue.evidenceSignature;state.issue=blankReview(item.issue,item.issue.evidenceSignature).issue;}
  if(patch.classification)state.classification=patch.classification;
  state.changeId=changeId;state.bulkOperationId=p.operationId;
  const json=JSON.stringify(state),version=item.baseVersion+1;
  writes.push(db.prepare(`INSERT INTO issue_event_reviews (id,site_id,event_key,version,state,updated_at) SELECT ?,?,?,?,?,? WHERE ?=0 OR EXISTS (SELECT 1 FROM issue_event_reviews WHERE site_id=? AND event_key=? AND version=?) ON CONFLICT(site_id,event_key) DO UPDATE SET version=excluded.version,state=excluded.state,updated_at=excluded.updated_at WHERE issue_event_reviews.version=?`).bind(crypto.randomUUID(),p.siteId,key,version,json,now,item.baseVersion,p.siteId,key,item.baseVersion,item.baseVersion));
  writes.push(db.prepare(`INSERT INTO issue_review_changes (id,site_id,event_key,run_id,version,state,note,actor,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM issue_event_reviews WHERE site_id=? AND event_key=? AND version=? AND state=?) ON CONFLICT(id) DO NOTHING`).bind(changeId,p.siteId,key,p.runId,version,json,patch.note.trim(),actor,now,p.siteId,key,version,json));
  pending.push({...item,changeId});
 }
 if(writes.length)await db.batch(writes);
 const current=await db.prepare(`SELECT r.event_key,r.version,r.state,r.updated_at,(SELECT c.run_id FROM issue_review_changes c WHERE c.site_id=r.site_id AND c.event_key=r.event_key AND c.version=r.version) AS run_id FROM issue_event_reviews r WHERE r.site_id=? AND r.event_key IN (${marks})`).bind(p.siteId,...keys).all();
 const assessed=await assessReviews(p.siteId,p.runId,payload,current.results.map((r:any)=>({eventKey:r.event_key,version:r.version,state:JSON.parse(r.state),updatedAt:r.updated_at,runId:r.run_id})));
 for(const item of pending){const review=assessed.find(r=>r.eventKey===item.issue.eventKey);results.push({issueId:item.issueId,eventKey:item.issue.eventKey,...(review?.state.changeId===item.changeId?{}:{error:'Another analyst updated this finding. Reload before applying changes.'})});}
 return Response.json({results:results.map(item=>({...item,review:assessed.find(r=>r.eventKey===item.eventKey)})),retrievedAt:now},{headers:{'Cache-Control':'private, no-store'}});
}catch(e){return Response.json({error:e instanceof Error?e.message:'Unable to save bulk review.'},{status:409});}}
