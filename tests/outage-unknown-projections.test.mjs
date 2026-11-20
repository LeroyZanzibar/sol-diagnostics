import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {LocalDatabase, LocalBucket} from '../selfhost/storage.mjs';
import {loadSource} from './source-module.mjs';
import {home, harness, nodes, button, html, finding, performance, noop, XLSX} from './outage-only-ui-harness.mjs';

// Native Error identity is shared across every source-loaded service/route.
// Storage, availability guards, serialization, review assessment, render and XLSX
// dependencies are real; only runtime bindings and unrelated freshness are supplied.
const load=(path,bindings={},names=[],transform)=>loadSource(path,names,{Error,TypeError,...bindings},transform);
const plain=value=>JSON.parse(JSON.stringify(value));
const time=load('app/telemetry-time.ts');
const periods=load('app/issue-periods.ts',time);
const review=load('app/issue-review.ts');
const checkpoint=load('app/api/performance-summary/checkpoint-storage.ts');
const storage=load('app/api/performance-summary/analysis-storage.ts');
const availability=load('app/api/analysis-history/availability.ts');
const reviewTime=load('app/issue-review-time.ts',time);

// The review-index projection is inline in finalize. Execute its exact source
// expression, with an AST preflight, instead of copying its field allow/deny list.
const routePath='app/api/performance-summary/route.ts';
const projection=load(routePath,{...periods},['publicIssue','displayPayload','retainedReviewIndex'],source=>{
  const parsed=ts.createSourceFile(routePath,source,ts.ScriptTarget.Latest,true),matches=[];
  function visit(node){
    if(ts.isCallExpression(node)&&node.expression.getText(parsed)==='writeCheckpoint'&&node.arguments[1]?.getText(parsed).includes('/review-index.json'))matches.push(node.arguments[2].getText(parsed));
    ts.forEachChild(node,visit);
  }
  visit(parsed);
  assert.equal(matches.length,1,'exactly one production review-index writer must be found');
  return source+`\nfunction retainedReviewIndex(payload:any,siteId:string,issues:any[],recurringIssues:any[]){return ${matches[0]};}\n`;
});
const start='2026-09-30T23:00:00.000Z',midnight='2026-10-01T00:00:00.000Z',end='2026-10-01T01:00:00.000Z';
function outage(id,{actual=[3,4],expected=[0,0],loss=[0,0],lossUnknown=true,expectedUnknown=true,productionUnknown=false}={}){
  const intervalLosses=[start,midnight].map((timestamp,i)=>({timestamp,intervalMinutes:60,lossKwh:loss[i],countedLossKwh:loss[i],actualKwh:actual[i],expectedKwh:expected[i],lossUnknown,expectedUnknown}));
  return finding(id,{equipmentId:id,name:id,timezone:'UTC',intervalMinutes:60,startDateTime:start,endDateTime:end,durationMinutes:120,
    estimatedLossKwh:loss.reduce((a,b)=>a+b,0),actualEnergyKwh:actual.reduce((a,b)=>a+b,0),expectedEnergyKwh:expected.reduce((a,b)=>a+b,0),lossPercent:0,
    lossUnknown,expectedUnknown,productionUnknown,intervalLosses,evidence:{rule:'supplied_expected_outage_v1',lossUnknown,expectedUnknown,productionUnknown,intervalLosses}});
}
const cases=[
  {id:'missing-reference',input:outage('missing-reference'),expected:{actualEnergyKwh:7,expectedEnergyKwh:null,estimatedLossKwh:null,lossPercent:null}},
  {id:'known-zero',input:outage('known-zero',{actual:[0,0],lossUnknown:false,expectedUnknown:false}),expected:{actualEnergyKwh:0,expectedEnergyKwh:0,estimatedLossKwh:0,lossPercent:0}},
  {id:'known-reference-unknown-loss',input:outage('known-reference-unknown-loss',{expected:[10,20],expectedUnknown:false}),expected:{actualEnergyKwh:7,expectedEnergyKwh:30,estimatedLossKwh:null,lossPercent:null}},
  {id:'unknown-actual',input:outage('unknown-actual',{actual:[0,0],expected:[10,20],expectedUnknown:false,productionUnknown:true}),expected:{actualEnergyKwh:null,expectedEnergyKwh:30,estimatedLossKwh:null,lossPercent:null}},
  {id:'quantified',input:{...outage('quantified',{expected:[10,20],loss:[7,16],lossUnknown:false,expectedUnknown:false}),lossPercent:23/30*100},expected:{actualEnergyKwh:7,expectedEnergyKwh:30,estimatedLossKwh:23,lossPercent:23/30*100}},
];

async function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'sol-unknown-projections-')),filename=join(root,'shared.sqlite'),objects=join(root,'objects');
  let db=new LocalDatabase(filename,resolve('drizzle')),bucket=new LocalBucket(db,objects);
  t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  const bindings={...review,...checkpoint,...availability,getDatabaseBinding:()=>db,getBucketBinding:()=>bucket,
    savedAnalysisProvenance:()=>null,assessAnalysisFreshness:()=>({status:'unknown',reasons:[],dependencyScope:'analysis-range'})};
  const history=load('app/api/analysis-history/service.ts',bindings);
  const deletion=load('app/api/analysis-history/deletion.ts',bindings);
  const services=load('app/api/issue-reviews/service.ts',{...bindings,...history});
  const historyApi=load('app/api/analysis-history/route.ts',{...bindings,...history,...deletion});
  const reviewsApi=load('app/api/issue-reviews/route.ts',{...bindings,...history,...services,blankReview:review.blankReview,
    ...load('app/shared-reduction-evidence.ts')});
  const keys=[];
  async function save(runId,inputs=cases.map(c=>c.input)){
    const issues=await Promise.all(inputs.map(async input=>({...plain(input),eventKey:await review.issueEventKey('site',input),evidenceSignature:await review.issueEvidenceSignature(input)})));
    const payload={...performance(runId,issues),siteId:'site',timeZone:'UTC'};
    db.sqlite.prepare("INSERT INTO analysis_runs(id,site_id,import_id,parser_version,model_revision,status,analysis_object_key,issue_count) VALUES (?,'site','synthetic-input',29,'synthetic-model','completed',?,?)").run(runId,`analysis/site/jobs/${runId}/result.json`,issues.length);
    const resultKey=`analysis/site/jobs/${runId}/result.json`,indexKey=resultKey.replace('result.json','review-index.json');
    await checkpoint.writeCheckpoint(bucket,resultKey,payload);
    await checkpoint.writeCheckpoint(bucket,indexKey,projection.retainedReviewIndex(payload,'site',issues,[]));
    keys.push(resultKey,indexKey);
    return payload;
  }
  async function hashes(){const values=[];for(const key of keys){const object=await bucket.get(key);assert.ok(object,key);values.push([key,createHash('sha256').update(Buffer.from(await new Response(object.body).arrayBuffer())).digest('hex')]);}return values;}
  const get=async(api,query)=>{const response=await api.GET(new Request(`https://offline.invalid/api?siteId=site&${query}`));const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.match(response.headers.get('cache-control'),/private, no-store/);return body;};
  return {history,services,historyApi,reviewsApi,save,hashes,get,get db(){return db;},reopen(){db.close();db=new LocalDatabase(filename,resolve('drizzle'));bucket=new LocalBucket(db,objects);}};
}

for(const item of cases){
  test(`saved analysis matches current public unknown/zero projection: ${item.id}`,async t=>{
    const f=await fixture(t),saved=await f.save('run',[item.input]),before=await f.hashes();f.reopen();
    const loaded=await f.get(f.historyApi,'runId=run'),issue=loaded.analysis.issues[0];
    const current=projection.publicIssue(saved.analysis.issues[0]);
    for(const [key,value] of Object.entries(item.expected)){
      assert.equal(current[key],value,`current projection: ${key}`);
      assert.equal(issue[key],value,`saved projection: ${key}`);
    }
    for(const key of ['expectedUnknown','productionUnknown','lossUnknown'])assert.equal(issue[key],item.input[key],key);
    assert.equal(issue.intervalLosses[0].expectedUnknown,item.input.expectedUnknown);
    assert.equal(issue.evidence,undefined);
    assert.deepEqual(await f.hashes(),before,'public projection must not rewrite retained payloads');
  });
  test(`review detail projects independent actual/expected/loss values: ${item.id}`,async t=>{
    const f=await fixture(t);await f.save('run',[item.input]);const before=await f.hashes();f.reopen();
    const result=await f.get(f.reviewsApi,`runId=run&issueId=${item.id}`);
    for(const key of ['actualEnergyKwh','expectedEnergyKwh','estimatedLossKwh'])assert.equal(result.issueSummary[key],item.expected[key],key);
    for(const key of ['expectedUnknown','productionUnknown','lossUnknown'])assert.equal(result.issueSummary[key],item.input[key],key);
    assert.deepEqual(await f.hashes(),before);
  });
}

test('production compact indexes and display payload retain availability flags without changing full evidence',async t=>{
  const f=await fixture(t),saved=await f.save('run'),before=JSON.stringify(saved),hashes=await f.hashes();f.reopen();
  const compact=await f.history.savedAnalysis('site','run',true),full=await f.history.savedAnalysis('site','run');
  const saveIndex=storage.issueSaveIndex(saved.analysis.issues,'analysis/site/jobs/run/result.json');
  const display=projection.displayPayload(saved);
  for(let i=0;i<cases.length;i++){
    for(const key of ['expectedUnknown','productionUnknown','lossUnknown']){
      assert.equal(compact.analysis.issues[i][key],cases[i].input[key]);
      assert.equal(saveIndex[i][key],cases[i].input[key]);
      assert.equal(saveIndex[i].evidence[key],cases[i].input[key]);
      assert.equal(display.analysis.issues[i][key],cases[i].input[key]);
    }
    assert.equal(compact.analysis.issues[i].intervalLosses,undefined);
    assert.equal(compact.analysis.issues[i].evidence,undefined);
    assert.equal(saveIndex[i].evidence.intervalLosses,undefined);
    assert.equal(display.analysis.issues[i].intervalLosses[0].expectedUnknown,cases[i].input.expectedUnknown);
    assert.equal(full.analysis.issues[i].intervalLosses[0].expectedUnknown,cases[i].input.expectedUnknown);
  }
  assert.equal(JSON.stringify(saved),before);assert.deepEqual(await f.hashes(),hashes);
});

for(const id of ['missing-reference','known-zero','known-reference-unknown-loss','unknown-actual']){
  test(`real review dialog renders the persisted route response: ${id}`,async t=>{
    const f=await fixture(t),item=cases.find(c=>c.id===id);await f.save('run',[item.input]);const hashes=await f.hashes();
    let calls=0,pending;
    const h=harness('app/IssueReviewDialog.tsx',{}, {...reviewTime,document:{body:{style:{overflow:''}}},fetch:url=>{calls++;return pending=f.reviewsApi.GET(new Request(new URL(url,'https://offline.invalid')));}});
    t.after(()=>h.dispose());
    const props={siteId:'site',runId:'run',issueId:id,name:id,onClose:noop,onSaved:noop,readOnly:true};
    h.render(props);await h.flush();await pending;await h.flush();const markup=html(h.render(props));
    assert.equal(calls,1);assert.equal(h.state.error,'');assert.ok(h.state.summary,'route response populated the component');
    for(const [label,key] of [['Actual production','actualEnergyKwh'],['Expected production','expectedEnergyKwh'],['Estimated loss','estimatedLossKwh']]){
      const value=item.expected[key],text=value===null?'Unknown':`${value} kWh`;
      assert.ok(markup.includes(`<span>${label}</span><strong>${text}</strong>`),`${label}: expected ${text}`);
    }
    assert.deepEqual(await f.hashes(),hashes);
  });
}

test('saved history flows through real Findings/Summaries render and round-tripped XLSX without invented zero losses',async t=>{
  const f=await fixture(t);await f.save('run');const hashes=await f.hashes(),data=await f.get(f.historyApi,'runId=run'),source=JSON.stringify(data);
  for(const reportRange of [{from:'',through:''},{from:'2026-10-01',through:'2026-10-01'}]){
    const h=home({performance:data,reportRange});let tree=h.render();
    const work=nodes(tree).find(n=>n.props?.visible&&n.props?.originals);
    const unknown=work.props.visible.find(i=>i.id==='missing-reference');
    const known=work.props.visible.find(i=>i.id==='known-reference-unknown-loss');
    const rendered=html(tree);assert.match(rendered,/Unknown/);assert.doesNotMatch(rendered,/NaN/);
    button(tree,'Export XLSX').props.onClick();
    const workbook=XLSX.read(XLSX.write(h.getBook(),{type:'buffer',bookType:'xlsx'}));
    const rows=XLSX.utils.sheet_to_json(workbook.Sheets.Findings);
    assert.equal(rows.length,cases.length);
    for(const id of ['missing-reference','known-reference-unknown-loss','unknown-actual']){
      const row=rows.find(r=>r.Issue===id);assert.equal(row['Estimated loss (kWh)'],'Unknown');assert.equal(row['Loss vs. expected (%)'],'Unknown');
    }
    assert.equal(rows.find(r=>r.Issue==='known-zero')['Estimated loss (kWh)'],'0.000');
    assert.equal(unknown.actualEnergyKwh,reportRange.from?4:7);
    assert.equal(unknown.expectedEnergyKwh,null);assert.equal(unknown.lossPercent,null);
    assert.equal(known.actualEnergyKwh,reportRange.from?4:7);assert.equal(known.expectedEnergyKwh,reportRange.from?20:30);
    h.state.view='summaries';const props=nodes(h.render()).find(n=>n.props?.reportContext).props;
    let summaryBook;const summaries=harness('app/IssueSummaries.tsx',{}, {XLSX:{...XLSX,writeFile:book=>{summaryBook=book;}}});
    tree=summaries.render(props);assert.match(html(tree),/Unknown/);button(tree,'Export XLSX').props.onClick();
    const reopened=XLSX.read(XLSX.write(summaryBook,{type:'buffer',bookType:'xlsx'}));
    const children=XLSX.utils.sheet_to_json(reopened.Sheets.Summaries).filter(r=>r['Row type']==='Child issue');
    assert.deepEqual([...new Set(children.map(r=>r['Source issue ID']))].sort(),cases.map(c=>c.id).sort());
    for(const row of children.filter(r=>['missing-reference','known-reference-unknown-loss','unknown-actual'].includes(r['Source issue ID'])))assert.equal(row['Estimated loss (kWh)'],'Unknown');
    for(const row of children.filter(r=>r['Source issue ID']==='known-zero'))assert.equal(row['Estimated loss (kWh)'],0);
  }
  assert.equal(JSON.stringify(data),source);assert.deepEqual(await f.hashes(),hashes);
});

test('expectation availability transitions alter evidence identity but not event identity or legacy known-value hashes',async()=>{
  const known=outage('transition',{actual:[0,0],expectedUnknown:false});
  const unknown=outage('transition',{actual:[0,0]});
  const before=JSON.stringify([known,unknown]);
  assert.equal(await review.issueEventKey('site',known),await review.issueEventKey('site',unknown));
  assert.equal(await review.issueEvidenceSignature(known),'06745399e183b4e3f55ba9cc1416aee243edfb031c82c1805f6b9d9b1ebe6ed8','retain the pre-change known-value evidence signature');
  assert.notEqual(await review.issueEvidenceSignature(known),await review.issueEvidenceSignature(unknown));
  const legacy=plain(known);delete legacy.expectedUnknown;for(const point of legacy.intervalLosses)delete point.expectedUnknown;
  assert.equal(await review.issueEvidenceSignature(legacy),await review.issueEvidenceSignature(known));
  const basis={calculationVersion:29,modelRevision:'model'};
  assert.equal(review.assessReviewEvidence({...known,evidenceSignature:'retained'},{...unknown,evidenceSignature:'retained'},basis,basis).needsReview,true);
  const intervalTransition=plain(known);intervalTransition.intervalLosses[1].expectedUnknown=true;
  const a={...known,evidenceSignature:await review.issueEvidenceSignature(known)},b={...intervalTransition,evidenceSignature:await review.issueEvidenceSignature(intervalTransition)};
  assert.notEqual(a.evidenceSignature,b.evidenceSignature);
  assert.equal(review.assessReviewEvidence(a,b,basis,basis).needsReview,true);
  assert.equal(JSON.stringify([known,unknown]),before);
});

test('real review save/compact baseline assessment notices known-zero to unknown expectation and retains the decision/audit',async t=>{
  const f=await fixture(t);
  await f.save('before',[outage('transition',{actual:[0,0],expectedUnknown:false})]);
  await f.save('after',[outage('transition',{actual:[0,0]})]);
  const first=await f.get(f.reviewsApi,'runId=before&issueId=transition');
  const state={...first.review.state,status:'Confirmed'};
  const response=await f.reviewsApi.POST(new Request('https://offline.invalid/api/issue-reviews',{method:'POST',body:JSON.stringify({siteId:'site',runId:'before',issueId:'transition',baseVersion:0,state,note:'Retain this human decision and note.'})}));
  assert.equal(response.status,200,await response.clone().text());
  const rows=()=>plain({reviews:f.db.sqlite.prepare('SELECT * FROM issue_event_reviews').all(),audit:f.db.sqlite.prepare('SELECT * FROM issue_review_changes').all()});
  const retained=rows(),hashes=await f.hashes();assert.equal(retained.reviews.length,1);assert.equal(retained.audit.length,1);f.reopen();
  const current=await f.get(f.reviewsApi,'runId=after&issueId=transition');
  assert.equal(current.needsReview,true);assert.equal(current.review.state.status,'Confirmed');assert.equal(current.audit[0].note,'Retain this human decision and note.');
  assert.equal(current.review.state.evidenceRunId,'before');assert.equal(current.issueSummary.expectedEnergyKwh,null);
  assert.deepEqual(rows(),retained);assert.deepEqual(await f.hashes(),hashes);
});
