import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as XLSX from 'xlsx';
import {loadSource} from './source-module.mjs';

const time=loadSource('app/telemetry-time.ts'),periods=loadSource('app/issue-periods.ts',[],time),dates=loadSource('app/issue-date-format.ts',[],time);
const review=loadSource('app/issue-review.ts'),visibility=loadSource('app/issue-visibility.ts'),recurring=loadSource('app/recurring-issues.ts',[],{...time,...periods});
const noop=()=>{};
function harness(path,initial={},bindings={}){
 const parsed=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true),names=[],defaults={};
 for(const node of parsed.statements){if(ts.isImportDeclaration(node)){const c=node.importClause;if(c?.name)defaults[c.name.text]=()=>null;for(const n of c?.namedBindings?.elements||[])defaults[n.name.text]=()=>null;}}
 function visit(n){if(ts.isVariableDeclaration(n)&&ts.isArrayBindingPattern(n.name)&&ts.isCallExpression(n.initializer)&&n.initializer.expression.getText(parsed)==='useState')names.push(n.name.elements[0].getText(parsed));ts.forEachChild(n,visit);}visit(parsed);
 const state={...initial},refs=[],effects=[],queued=[];let index=0,refIndex=0,effectIndex=0;
 const module=loadSource(path,[],{...defaults,...loadSource('app/monthly-client.ts'),React,Fragment:React.Fragment,...time,...periods,...dates,...review,...visibility,...recurring,...loadSource('app/data-freshness.ts'),
  AbortController,fetch:async()=>Response.json({}),window:{scrollTo:noop,setTimeout:noop},useMemo:fn=>fn(),useCallback:fn=>fn,
  useState:value=>{const name=names[index++];if(!(name in state))state[name]=typeof value==='function'?value():value;return [state[name],next=>{state[name]=typeof next==='function'?next(state[name]):next;}];},
  useRef:value=>refs[refIndex++]??(refs[refIndex-1]={current:value}),
  useEffect:(fn,deps)=>{const i=effectIndex++,previous=effects[i];if(!previous||!deps||deps.some((d,j)=>d!==previous.deps[j])){effects[i]={deps,fn,cleanup:previous?.cleanup};queued.push(i);}},...bindings});
 return {state,module,render(props={}){index=0;refIndex=0;effectIndex=0;return module.default(props);},call(name,...args){index=0;refIndex=0;effectIndex=0;return module[name](...args);},effects,
  async flush(){while(queued.length){const i=queued.shift(),e=effects[i];e.cleanup?.();e.cleanup=e.fn();}for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));},
  dispose(){for(const e of effects)e.cleanup?.();},
 };
}
function nodes(tree){if(!tree||typeof tree!=='object')return [];return [tree,...React.Children.toArray(tree.props?.children).flatMap(nodes)];}
const button=(tree,label)=>nodes(tree).find(n=>n.type==='button'&&renderToStaticMarkup(n).includes(label));
const html=tree=>renderToStaticMarkup(tree);
const finding=(id,patch={})=>({id,eventKey:id,evidenceSignature:id,name:`Finding ${id}`,type:'Equipment outage',category:'Performance',confidence:'model-based',severity:'high',equipmentId:'inverter',equipmentName:'Inverter',equipmentType:'inverter',equipmentExternalId:'INV',timezone:'UTC',startDateTime:'2026-06-01T08:00:00Z',endDateTime:'2026-06-01T09:00:00Z',durationMinutes:60,estimatedLossKwh:10,actualEnergyKwh:90,expectedEnergyKwh:100,lossPercent:10,siteImpactPercent:10,description:'Synthetic finding',...patch});
const assessment=(status='current')=>({runId:'run',status,assessedAt:'2026-11-16T12:00:00Z',comparedRevision:3,reasons:status==='older'?['Changed source readings']:[],dependencyScope:'analysis-range'});
function home(initial={},status='current',ready=true,bindings={}){
 const fresh=loadSource('app/data-freshness.ts');
 const method=loadSource('app/report-methodology.ts',[],{...review,...visibility,...fresh,XLSX});let book;
 const issues=[finding('shown'),finding('dismissed'),finding('hidden',{type:'Data gap',category:'Data quality'})];
 const performance={hasData:true,issueDatabase:{analysisRunId:'run'},methodology:{analysisId:'run'},summary:{dailyProduction:[],readingCount:3,latestDate:'2026-06-01'},analysis:{issues,recurringIssues:[],analyzedDays:1,analyzedIntervals:1,analysisIntervalMinutes:60,skippedLowIrradianceIntervals:0},import:{fileName:'cumulative',createdAt:'2026-06-01'},capacityKw:100};
 const h=harness('app/page.tsx',{view:'issues',activeSiteId:'site',configs:{site:{id:'site',name:'Synthetic site',city:'Test',state:'',arrayModelVerified:true}},performance,userSettingsReady:true,reviewScope:'site:run',reviewsRetrievedAt:'now',reviews:{dismissed:{state:{...review.blankReview(issues[1],'dismissed'),status:'Dismissed'},needsReview:false}},user:{firstName:'Test',lastName:'User',theme:'default',issueVisibility:visibility.defaultIssueVisibility},...initial},{...method,...fresh,
  ...loadSource('app/themes.ts'),useDataFreshness:()=>({assessment:assessment(status),ready,loading:!ready,error:''}),
  useMobileNavigation:()=>({isMobile:false,mobileMenuOpen:false,setMobileMenuOpen:noop,navigationRef:{current:null},menuButtonRef:{current:null}}),
  useMaintenanceWindows:()=>({windows:[],retrievedAt:'now',error:''}),XLSX:{...XLSX,writeFile:b=>{book=b;}},...bindings,
 });return {...h,getBook:()=>book};
}
const dataset={siteId:'site',revision:2,revisionId:'rev2',timezone:'UTC',intervalMinutes:60,timestampStart:'2026-06-01T00:00:00Z',timestampEnd:'2026-06-30T23:00:00Z',timestampCount:720,readingCount:1400,channelCount:2,createdAt:'2026-06-01',updatedAt:'2026-07-01'};
const preview={siteId:'site',stageId:'stage',previewToken:'token',baseRevision:2,status:'preview',counts:{added:2,overlapping:3,changed:1,identical:2,blankPreserved:1},timestampStart:'2026-06-01T00:00:00Z',timestampEnd:'2026-06-01T01:00:00Z',readingCount:5,channelCount:1,metadata:{fileName:'correction.csv',source:'csv',timezone:'UTC',intervalMinutes:60},samples:[],createdAt:'2026-11-16',expiresAt:'2026-11-17'};
const uploadProps={sites:[{id:'site',name:'Synthetic site',location:'Test'}],initialSiteId:'site',onBack:noop,notify:noop,onImported:noop};
function uploads(initial={},bindings={}){const csv=loadSource('app/telemetry-csv.ts',[],{...time});return harness('app/TelemetryUploads.tsx',{siteId:'site',dataset,datasetLoading:false,...initial},{...csv,...bindings});}

test('first analysis is explicit and a saved unpublished run is accessible without restarting it',async()=>{
 const calls=[],h=home({},'unknown',true,{fetch:async(url,options)=>{calls.push([url,options]);return Response.json({processing:true});}});
 h.state.performance={...h.state.performance,hasData:false,analysisRequired:true};
 let tree=h.render();assert.equal(calls.length,0);const start=button(tree,'Run analysis');assert.ok(start,'A first canonical import must have an explicit analysis-start action');
 start.props.onClick();for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls.length,1);assert.deepEqual(JSON.parse(calls[0][1].body),{siteId:'site',action:'reanalyze'});assert.equal(h.state.performanceRevision,1);
 const saved=home();saved.state.performance={...saved.state.performance,hasData:false,publicationSkipped:true,runId:'retained-run',reason:'Saved without replacing the published result.'};
 tree=saved.render();assert.match(html(tree),/Analysis saved in history/);const open=button(tree,'View saved analysis');assert.ok(open);open.props.onClick();assert.equal(saved.state.analysisSelection.siteId,'site');assert.equal(saved.state.analysisSelection.runId,'retained-run');
 const historical=home({analysisSelection:{siteId:'site',runId:'old'}},'current',true,{fetch:async(...args)=>{calls.push(args);return Response.json({});}});tree=historical.render();const restart=button(tree,'Reanalyze current data');assert.equal(restart.props.disabled,true);restart.props.onClick();assert.equal(calls.length,1,'A disabled historical action must also be guarded in its handler');
});

for(const status of ['failed','canceled','interrupted'])test(`stopped first ${status} analysis offers one current-input action with a distinct pinned Retry`,()=>{
 const progress={attemptId:'original',status,stage:'read',label:'Reading telemetry',completed:0,total:1,percent:0,updatedAt:1,error:''};
 const h=home({analysisState:progress},'unknown');h.state.performance={...h.state.performance,hasData:false,analysisRequired:true};
 const tree=h.render(),markup=html(tree);assert.equal(button(tree,'Run analysis').props.disabled,false);assert.equal(button(tree,'Retry analysis').props.disabled,false);
 assert.equal(nodes(tree).filter(n=>n.type==='button'&&html(n).includes('Run analysis')).length,1,'Use the existing top action, not competing fresh-start controls');
 assert.match(markup,/Run analysis.*current data and model/);assert.match(markup,/Retry analysis.*original saved data and model/);
 const noSource=home({analysisState:progress},'unknown');noSource.state.performance={...noSource.state.performance,hasData:false};assert.equal(button(noSource.render(),'Run analysis'),undefined);
});

test('fresh-analysis and Retry controls guard historical, active and pending states in their actual handlers',async()=>{
 const calls=[],progress={attemptId:'original',status:'failed',stage:'read',label:'Reading telemetry',completed:0,total:1,percent:0,updatedAt:1,error:''};
 const bindings={fetch:async(...args)=>{calls.push(args);return Response.json({});}};
 const historical=home({analysisState:progress,analysisSelection:{siteId:'site',runId:'old'}},'unknown',true,bindings);
 historical.state.performance={...historical.state.performance,hasData:false,analysisRequired:true};
 const tree=historical.render();for(const label of ['Run analysis','Retry analysis']){const control=button(tree,label);assert.equal(control.props.disabled,true);await control.props.onClick();}
 for(const status of ['processing','canceling']){
  const active=home({analysisState:{...progress,status}},'unknown',true,bindings);active.state.performance={...active.state.performance,hasData:false,analysisRequired:true};
  const tree=active.render(),start=button(tree,'Run analysis');assert.equal(start.props.disabled,true);await start.props.onClick();assert.equal(button(tree,'Retry analysis'),undefined);
 }
 for(const analysisAction of ['retry','cancel']){
  const pending=home({analysisState:progress,analysisAction},'unknown',true,bindings);pending.state.performance={...pending.state.performance,hasData:false,analysisRequired:true};
  const tree=pending.render();for(const label of ['Run analysis','Retry analysis']){const control=button(tree,label);assert.equal(control.props.disabled,true);await control.props.onClick();}
 }
 assert.equal(calls.length,0,'Disabled actions must not send requests even if their handler is invoked');
});

test('stopped reruns keep published findings visible and offer retry of the stopped attempt',async()=>{
 for(const status of ['canceled','failed','interrupted']){
  const calls=[],lastAttempt={attemptId:'stopped-attempt',status,stage:'equipment',label:'Analyzing equipment',completed:1,total:2,percent:50,updatedAt:1,error:status==='failed'?'Synthetic failure':''};
  const h=home({},'current',true,{fetch:async(url,options)=>{calls.push([url,JSON.parse(options.body)]);return Response.json({progress:{...lastAttempt,status:'processing',attemptId:'resumed-attempt'}});}});h.state.performance={...h.state.performance,lastAttempt};
  let tree=h.render(),markup=html(tree);assert.match(markup,new RegExp(`Latest analysis ${status}`));assert.match(markup,/previous published analysis is still shown/);assert.match(markup,/Finding shown/);assert.doesNotMatch(markup,/Analysis could not complete/);
  assert.equal(nodes(tree).find(n=>n.props?.originals).props.readOnly,false,'Published review identity remains editable');
  await button(tree,'Retry analysis').props.onClick();await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(calls,[['/api/performance-summary',{siteId:'site',attemptId:'stopped-attempt',action:'retry'}]]);assert.equal(h.state.performanceRevision,1);
  const historical=home({analysisSelection:{siteId:'site',runId:'old'}});historical.state.performance={...historical.state.performance,lastAttempt};assert.doesNotMatch(html(historical.render()),/Latest analysis|Retry analysis/);
 }
});

test('reselecting the current or historical analysis is idempotent and preserves the loaded report',()=>{
 for(const runId of ['', 'old']){
  const h=home({view:'manage-analyses',analysisSelection:{siteId:'site',runId}}),before=h.state.performance;
  const manager=nodes(h.render()).find(n=>n.props?.onFindings);
  manager.props.onChange(runId);
  assert.equal(h.state.performance,before,'The same selection must not clear a report without changing its reload dependencies');
  assert.equal(h.state.analysisSelection.runId,runId);assert.equal(h.state.performanceRevision,0);
  manager.props.onFindings();const markup=html(h.render());assert.doesNotMatch(markup,/Loading saved analysis/);
 }
});

test('navigation uses Analysis, Findings and Data management; history management is not in Findings',()=>{
 const h=home(),tree=h.render(),markup=html(tree);
 assert.match(markup,/> Analysis</);assert.match(markup,/Data management/);assert.match(markup,/Manage Analyses/);assert.match(markup,/>Findings</);
 assert.doesNotMatch(markup,/Performance issues|Data uploads|Current performance file/);assert.doesNotMatch(markup,/Active analysis|Published current analysis/);assert.match(markup,/Data freshness/);
 const manage=button(tree,'Manage Analyses');manage.props.onClick();assert.equal(h.state.view,'manage-analyses');
});

test('Visuals navigation opens Charts with the selected site and closes the mobile menu',()=>{
 const closed=[],h=home({},'current',true,{
  useMobileNavigation:()=>({isMobile:false,mobileMenuOpen:true,setMobileMenuOpen:value=>closed.push(value),navigationRef:{current:null},menuButtonRef:{current:null}}),
 });
 let tree=h.render();assert.match(html(tree),/> Visuals</);
 const charts=button(tree,'Charts');assert.ok(charts);charts.props.onClick();
 assert.equal(h.state.view,'charts');assert.equal(h.state.activeSiteId,'site');assert.equal(closed.at(-1),false);
 tree=h.render();const workspace=nodes(tree).find(n=>n.props?.siteId==='site'&&typeof n.props.onSiteChange==='function'&&Array.isArray(n.props.sites));
 assert.ok(workspace,'The actual Charts component must be mounted, not just a navigation label');
 assert.equal(workspace.props.sites[0].id,'site');workspace.props.onSiteChange('other');assert.equal(h.state.activeSiteId,'other');
 assert.match(html(tree),/aria-current="page"[^>]*>[\s\S]*?Charts/);
});

test('Charts navigation preserves monthly dirty/busy guards and existing menus',()=>{
 const h=home({view:'settings'},'current',true,{confirmMonthlyNavigation:()=>false});
 const tree=h.render(),charts=button(tree,'Charts');assert.ok(charts);charts.props.onClick();assert.equal(h.state.view,'settings');
 assert.match(html(tree),/Data management/);assert.match(html(tree),/Site configuration/);assert.match(html(tree),/User Settings/);
});

test('Visuals navigation expands from a collapsed sidebar and Charts handles an empty site list',()=>{
 const h=home({sidebarCollapsed:true,visualsMenuOpen:false}),parent=button(h.render(),'Visuals');
 assert.ok(parent);parent.props.onClick();assert.equal(h.state.sidebarCollapsed,false);assert.equal(h.state.visualsMenuOpen,true);
 const empty=home({view:'charts',activeSiteId:'',configs:{}}),tree=empty.render();
 const workspace=nodes(tree).find(n=>n.props?.siteId===''&&typeof n.props.onSiteChange==='function'&&Array.isArray(n.props.sites));
 assert.ok(workspace);assert.equal(workspace.props.sites.length,0);
});

test('freshness filters precede totals, hidden and dismissed audits, summary/timeline membership and XLSX',()=>{
 for(const status of ['current','older','unknown'])for(const filter of ['all','current','older']){
  const h=home({freshnessFilter:filter},status),tree=h.render(),allowed=filter==='all'||filter===status;
  const work=nodes(tree).find(n=>n.props?.visible&&n.props?.originals);assert.ok(work);assert.equal(work.props.visible.length,allowed?2:0);
  button(tree,'Export XLSX').props.onClick();const book=h.getBook();assert.ok(book);
  assert.equal(XLSX.utils.sheet_to_json(book.Sheets['Findings']).length,allowed?2:0);
  const m=new Map(XLSX.utils.sheet_to_json(book.Sheets.Methodology,{header:1}));assert.equal(m.get('Data freshness status'),status);assert.equal(m.get('Data freshness compared revision'),3);assert.equal(m.get('Data freshness assessed at (UTC)'),assessment().assessedAt);
  if(!allowed){assert.equal(m.get('Reporting period detected loss (kWh, before table filters)'),0);assert.equal(book.Sheets['Dismissed findings'],undefined);}
  h.state.view='summaries';let report=nodes(h.render()).find(n=>n.props?.reportContext);assert.equal(report.props.issues.length,allowed?2:0);
  h.state.view='timeline';report=nodes(h.render()).find(n=>n.props?.maintenanceRevision!==undefined&&n.props?.issues);assert.equal(report.props.issues.length,allowed?2:0);
 }
 const pending=home({freshnessFilter:'current'},'current',false),tree=pending.render();assert.equal(button(tree,'Export XLSX').props.disabled,true);button(tree,'Export XLSX').props.onClick();assert.equal(pending.getBook(),undefined);
 assert.match(html(home({},'older').render()),/Based on older data/);assert.match(html(home({},'unknown').render()),/Unknown data freshness/);
 const historical=home({analysisSelection:{siteId:'site',runId:'old'}});const historicTree=historical.render();assert.doesNotMatch(html(historicTree),/Selected historical snapshot/);assert.equal(button(historicTree,'Reanalyze current data').props.disabled,true);button(historicTree,'Manage Analyses').props.onClick();const manager=nodes(historical.render()).find(n=>n.props?.onFindings);assert.equal(manager.props.runId,'old');manager.props.onChange('');assert.equal(historical.state.analysisSelection.runId,'');assert.equal(historical.state.performance,null);
});

test('shared freshness selection resets selected rows and page without rewriting saved review state',()=>{
 const h=home({selectedFindings:['shown'],issuePage:4}),tree=h.render(),before=JSON.stringify(h.state.reviews);
 const control=nodes(tree).find(n=>n.type==='select'&&n.props['aria-label']==='Data freshness');assert.ok(control);control.props.onChange({target:{value:'older'}});
 assert.equal(h.state.freshnessFilter,'older');assert.equal(h.state.issuePage,0);assert.equal(h.state.selectedFindings.length,0);assert.equal(JSON.stringify(h.state.reviews),before);
 h.state.view='summaries';assert.equal(nodes(h.render()).find(n=>n.props?.reportContext).props.reportContext.freshnessFilter,'older');
});

test('Manage Analyses distinguishes published current from selected snapshot and paginates opaque cursors',async()=>{
 const calls=[],selected=[],runs=[{id:'run',completed_at:'2026-11-16T12:00:00Z',status:'completed',issue_count:4,source_revision:3,is_current:true,data_freshness:'current',timestamp_start:'2026-06-01',timestamp_end:'2026-06-30'},{id:'old',completed_at:'2026-11-15T12:00:00Z',issue_count:2,source_revision:1,is_current:false,data_freshness:'older'}];
 const h=harness('app/ManageAnalyses.tsx',{}, {fetch:async(url,options)=>{calls.push([url,options]);return Response.json(calls.length===1?{runs,next:'opaque/+=='}:{runs:[{id:'legacy',completed_at:'bad',issue_count:0}],next:null});}});
 const props={sites:uploadProps.sites,siteId:'site',runId:'old',revision:'run',onSiteChange:noop,onChange:id=>selected.push(id),onFindings:noop};
 assert.match(html(h.render(props)),/Loading analyses/);await h.flush();let tree=h.render(props);assert.match(html(tree),/Published current/);assert.match(html(tree),/Selected snapshot/);assert.match(html(tree),/Based on older data/);assert.match(html(tree),/Delete/);assert.doesNotMatch(html(tree),/Archive/);
 const selectedButton=button(tree,'Selected snapshot');assert.equal(selectedButton.props.disabled,true);selectedButton.props.onClick();assert.deepEqual(selected,[]);
 button(tree,'Use published current').props.onClick();assert.deepEqual(selected,['']);
 await button(tree,'Older analyses').props.onClick();tree=h.render(props);assert.match(calls[1][0],/before=opaque%2F%2B%3D%3D/);assert.match(html(tree),/Unknown/);assert.doesNotMatch(html(tree),/Invalid Date/);h.dispose();
});

test('staged preview shows preservation and counts, cannot apply overlap without explicit approval or to another site',async()=>{
 const calls=[],h=uploads({pendingPreview:preview},{fetch:async(...args)=>{calls.push(args);return Response.json({});}});let tree=h.render(uploadProps),markup=html(tree);
 assert.match(markup,/Cumulative performance dataset/);assert.match(markup,/omitted timestamps and channels/i);assert.match(markup,/blank.*null/i);assert.match(markup,/overlap/i);assert.match(markup,/identical/i);assert.doesNotMatch(markup,/complete performance dataset|One performance file per site/);
 const apply=button(tree,'Apply');assert.ok(apply);assert.equal(apply.props.disabled,true);await apply.props.onClick();assert.equal(calls.length,0);
 const consent=nodes(tree).find(n=>n.type==='input'&&n.props.type==='checkbox');assert.equal(consent.props.checked,false);consent.props.onChange({target:{checked:true}});tree=h.render(uploadProps);assert.equal(button(tree,'Apply').props.disabled,false);
 h.state.siteId='other';tree=h.render(uploadProps);const wrong=button(tree,'Apply');if(wrong)await wrong.props.onClick();assert.equal(calls.length,0);
});

test('Apply uses same stage/token and verifies committed readback before notifying; conflict never replays',async()=>{
 const calls=[],notifications=[],imports=[];let committed=false;
 const h=uploads({pendingPreview:preview,approveOverlap:true},{fetch:async(url,options={})=>{calls.push([url,options]);if(options.method==='POST'){committed=true;throw new Error('lost acknowledgement');}if(String(url).includes('stageId='))return Response.json({preview:{...preview,status:committed?'committed':'preview',result:{revision:3}}});return Response.json({dataset:{...dataset,revision:3},imports:[]});}});
 const props={...uploadProps,notify:m=>notifications.push(m),onImported:id=>imports.push(id)};await button(h.render(props),'Apply').props.onClick();assert.equal(calls.filter(c=>c[1].method==='POST').length,1);assert.equal(JSON.parse(calls[0][1].body).previewToken,'token');assert.deepEqual(imports,['site']);assert.equal(notifications.length,1);assert.equal(h.state.pendingPreview,null);
 const rejected=uploads({pendingPreview:preview,approveOverlap:true},{fetch:async()=>Response.json({error:'Preview stale; preview again.'},{status:409})});await button(rejected.render(uploadProps),'Apply').props.onClick();assert.match(html(rejected.render(uploadProps)),/stale/i);assert.equal(rejected.state.pendingPreview.stageId,'stage');assert.equal(button(rejected.render(uploadProps),'Apply').props.disabled,true);
});

test('legacy site requires retained-file preview and does not present a canonical dataset until Apply',async()=>{
 let count=0;const h=uploads({dataset:{...dataset,revision:0},requiresMigration:true,currentFile:{id:'legacy',fileName:'retained.csv',rowCount:10,createdAt:'2026-01-01'}},{fetch:async(url,options)=>{count++;assert.equal(JSON.parse(options.body).action,'previewLegacy');return Response.json({preview:{...preview,baseRevision:0,metadata:{...preview.metadata,source:'migration'}}});}});
 let tree=h.render(uploadProps);assert.match(html(tree),/Migration required/);await button(tree,'Preview retained file').props.onClick();assert.equal(count,1);assert.equal(h.state.dataset.revision,0);assert.equal(h.state.pendingPreview.metadata.source,'migration');
});

test('freshness hook fences late site/run responses, uses no-store and treats failures/malformed assessments as unknown',async()=>{
 const requests=[];const h=harness('app/data-freshness.ts',{}, {fetch:(url,options)=>new Promise(resolve=>requests.push({url,options,resolve}))});
 assert.equal(h.call('useDataFreshness','site','old').ready,false);await h.flush();h.call('useDataFreshness','site','run');await h.flush();assert.equal(requests[0].options.signal.aborted,true);assert.equal(requests[1].options.cache,'no-store');
 requests[1].resolve(Response.json(assessment('older')));await h.flush();assert.equal(h.call('useDataFreshness','site','run').assessment.status,'older');
 requests[0].resolve(Response.json({...assessment('current'),runId:'old'}));await h.flush();assert.equal(h.call('useDataFreshness','site','run').assessment.status,'older');
 h.call('useDataFreshness','other','run');await h.flush();requests[2].resolve(Response.json({error:'Unavailable'},{status:503}));await h.flush();let result=h.call('useDataFreshness','other','run');assert.equal(result.ready,true);assert.equal(result.assessment.status,'unknown');assert.match(result.error,/Unavailable/);
 h.call('useDataFreshness','third','run');await h.flush();requests[3].resolve(Response.json({...assessment(),assessedAt:'not-a-date'}));await h.flush();result=h.call('useDataFreshness','third','run');assert.equal(result.assessment.status,'unknown');h.dispose();
});

test('Manage Analyses supports empty/error states and discards old-site pagination acknowledgements',async()=>{
 const requests=[],h=harness('app/ManageAnalyses.tsx',{}, {fetch:(url,options)=>new Promise(resolve=>requests.push({url,options,resolve}))});
 const props={sites:uploadProps.sites,siteId:'site',runId:'',revision:'run',onSiteChange:noop,onChange:noop,onFindings:noop};
 h.render(props);await h.flush();requests[0].resolve(Response.json({runs:[],next:null}));await h.flush();assert.match(html(h.render(props)),/No saved analyses/);
 h.render({...props,revision:'new'});await h.flush();requests[1].resolve(Response.json({error:'History unavailable'},{status:503}));await h.flush();assert.match(html(h.render({...props,revision:'new'})),/History unavailable/);
 h.render({...props,revision:'next'});await h.flush();requests[2].resolve(Response.json({runs:[{id:'first'}],next:'cursor'}));await h.flush();const more=button(h.render({...props,revision:'next'}),'Older analyses').props.onClick();
 h.render({...props,siteId:'other',revision:'next'});await h.flush();assert.equal(requests[3].options.signal.aborted,true);requests[4].resolve(Response.json({runs:[{id:'other-site-run'}],next:null}));await h.flush();requests[3].resolve(Response.json({runs:[{id:'stale-site-run'}],next:null}));await more;
 const markup=html(h.render({...props,siteId:'other',revision:'next'}));assert.match(markup,/other-site-run/);assert.doesNotMatch(markup,/stale-site-run/);h.dispose();
});

test('actual Summaries and Timeline render only freshness-selected membership; summary workbook matches rendered groups',()=>{
 const fresh=loadSource('app/data-freshness.ts'),method=loadSource('app/report-methodology.ts',[],{...review,...visibility,...fresh,XLSX});
 for(const [status,filter,allowed] of [['older','current',false],['older','older',true],['unknown','all',true],['unknown','current',false]]){
  const parent=home({view:'summaries',freshnessFilter:filter},status),child=nodes(parent.render()).find(n=>n.props?.reportContext);let book;
  const h=harness('app/IssueSummaries.tsx',{}, {...method,XLSX:{...XLSX,writeFile:b=>{book=b;}}});const tree=h.render(child.props),markup=html(tree);
  assert.equal((markup.match(/class="summary-group"/g)||[]).length,allowed?2:0);button(tree,'Export XLSX').props.onClick();
  const children=XLSX.utils.sheet_to_json(book.Sheets.Summaries).filter(row=>row['Row type']==='Child issue');assert.deepEqual(children.map(row=>row['Source issue ID']).sort(),allowed?['hidden','shown']:[]);
  parent.state.view='timeline';const timeline=nodes(parent.render()).find(n=>n.props?.maintenanceRevision!==undefined&&n.props?.issues);
  const t=harness('app/IssueTimeline.tsx',{}, {...loadSource('app/timeline-axis.ts',[],{...time,...periods}),useTimelineMaintenance:()=>({days:[],timezone:'UTC',loading:false,error:null}),TimelineMaintenance:()=>null});
  assert.equal((html(t.render(timeline.props)).match(/class="timeline-issue-label timeline-parent-label"/g)||[]).length,allowed?2:0);
 }
});

test('freshness changes hidden/dismissed totals without resurrecting legacy recurring exports or changing saved state',()=>{
 const parent=home({freshnessFilter:'older'},'older'),prefs={...visibility.defaultIssueVisibility,equipmentOutage:false};parent.state.user={...parent.state.user,issueVisibility:prefs};
 let tree=parent.render();button(tree,'Export XLSX').props.onClick();let book=parent.getBook(),m=new Map(XLSX.utils.sheet_to_json(book.Sheets.Methodology,{header:1}));assert.equal(m.get('Findings hidden by issue visibility'),1);assert.equal(m.get('Known loss hidden by issue visibility (kWh)'),10);
 parent.state.freshnessFilter='current';tree=parent.render();button(tree,'Export XLSX').props.onClick();m=new Map(XLSX.utils.sheet_to_json(parent.getBook().Sheets.Methodology,{header:1}));assert.equal(m.get('Findings hidden by issue visibility'),0);assert.equal(m.get('Reporting period dismissed loss (kWh, before table filters)'),0);
 const fresh=loadSource('app/data-freshness.ts'),method=loadSource('app/report-methodology.ts',[],{...review,...visibility,...fresh,XLSX}),shown=finding('shown'),outside=finding('outside');
 const context={freshnessFilter:'older',dataFreshness:assessment('older'),freshnessReady:true,reviewFilter:'Exclude dismissed',reviews:{},reviewRetrievedAt:'now',issues:[shown],recurringIssues:[{id:'episode',members:[shown,outside],activeMinutes:120,estimatedLossKwh:20}]};const before=JSON.stringify(context);book=XLSX.utils.book_new();method.appendReportMethodology(book,context);
 assert.equal(book.Sheets['Recurring occurrences'],undefined);assert.equal(book.Sheets['Recurring issues'],undefined);assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets['Analyst reviews']).map(r=>r.issueId),['shown']);assert.equal(JSON.stringify(context),before);
});

test('CSV wizard stages mapped data only, passes saved cadence for single-timestamp corrections and never auto-applies',async()=>{
 const calls=[],notifications=[],validation={errors:0,warnings:0,totalRows:1,checkedRows:1,validRows:1,timezone:'UTC',timestampConvention:'start',signalColumns:['inv'],intervalMinutes:60,interval:'60 minutes',inconsistentIntervals:0,exportCapacityKw:100,start:'2026-06-01T00:00:00Z',end:'2026-06-01T00:00:00Z'},mapping={timestamp:'timestamp',expectedProduction:'',equipment:'',measurement:'',value:'',unit:''};
 let validated,prepared;const file=new File(['timestamp,inv,unused\n2026-06-01T00:00:00Z,1,2'],'one.csv',{type:'text/csv'});
 const h=uploads({timezone:'UTC',equipmentLoading:false,equipment:[{id:'inv',name:'INV',externalId:'inv',type:'inverter',aliases:[]},{id:'meter',name:'Meter',externalId:'meter',type:'revenue_meter',aliases:[]}]},{FormData,CsvProcessor:class{async load(){return {headers:['timestamp','inv','unused'],rows:[['2026-06-01T00:00:00Z','1','2']],rowCount:1};}async validate(...args){validated=args;return validation;}async prepare(...args){prepared=args;return new File(['timestamp,inv\n2026-06-01T00:00:00Z,1'],'mapped.csv');}close(){}},fetch:async(url,options)=>{calls.push([url,options]);return Response.json({preview});}});
 const props={...uploadProps,notify:m=>notifications.push(m),onImported:m=>notifications.push(m)};let tree=h.render(props);const fileInput=nodes(tree).find(n=>n.type==='input'&&n.props.type==='file');fileInput.props.onChange({target:{files:[file]}});for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
 h.state.mapping=mapping;h.state.signalMappings=[{column:'inv',equipmentId:'inv',measurement:'Energy',confidence:'high'},{column:'unused',equipmentId:'',measurement:'Other',confidence:'low'}];
 await button(h.render(props),'Continue').props.onClick();await button(h.render(props),'Continue').props.onClick();assert.equal(h.state.step,3);assert.equal(validated.at(-1),60);await button(h.render(props),'Continue').props.onClick();
 tree=h.render(props);assert.match(html(tree),/1 unmapped column excluded/);await button(tree,'Create import preview').props.onClick();assert.equal(calls.length,1);assert.equal(calls[0][0],'/api/telemetry-imports');assert.equal(calls[0][1].body.get('replacesImportId'),null);assert.equal(JSON.parse(calls[0][1].body.get('equipmentMapping')).signals.length,1);assert.equal(prepared[0].timestamp,'timestamp');assert.equal(h.state.dataset.revision,2);assert.equal(h.state.pendingPreview.stageId,'stage');assert.equal(notifications.length,0);assert.equal(h.state.approveOverlap,false);
});

test('changing source timezone or site invalidates a preview and late staging cannot install it for another site',async()=>{
 const h=uploads({pendingPreview:preview,approveOverlap:true});let tree=h.render(uploadProps);nodes(tree).find(n=>n.type==='input'&&n.props['aria-label']==='Source timezone').props.onChange({target:{value:'America/New_York'}});assert.equal(h.state.pendingPreview,null);assert.equal(h.state.approveOverlap,false);
 h.state.pendingPreview=preview;h.state.approveOverlap=true;tree=h.render(uploadProps);nodes(tree).find(n=>n.type==='select'&&n.props.value==='site').props.onChange({target:{value:'other'}});assert.equal(h.state.pendingPreview,null);assert.equal(h.state.dataset,null);
 let resolve;const delayed=uploads({requiresMigration:true,dataset:{...dataset,revision:0}},{fetch:()=>new Promise(r=>{resolve=r;})});tree=delayed.render(uploadProps);const staging=button(tree,'Preview retained file').props.onClick();nodes(tree).find(n=>n.type==='select'&&n.props.value==='site').props.onChange({target:{value:'other'}});resolve(Response.json({preview}));await staging;assert.equal(delayed.state.pendingPreview,null);
});

test('unverified Apply stays pending and explicit readback recovers without replaying the write',async()=>{
 const calls=[],notifications=[];let readable=false;
 const h=uploads({pendingPreview:preview,approveOverlap:true},{fetch:async(url,options={})=>{calls.push([url,options]);if(options.method==='POST')return Response.json({committed:true,result:{revision:3},dataset:{...dataset,revision:3}});if(!readable)throw new Error('Readback unavailable');if(String(url).includes('stageId='))return Response.json({preview:{...preview,status:'committed',result:{revision:3}}});return Response.json({dataset:{...dataset,revision:3},imports:[]});}});
 const props={...uploadProps,notify:m=>notifications.push(m),onImported:m=>notifications.push(m)};await button(h.render(props),'Apply').props.onClick();assert.equal(h.state.dataset.revision,2);assert.equal(h.state.pendingPreview.stageId,'stage');assert.equal(h.state.commitUncertain,true);assert.equal(notifications.length,0);assert.match(html(h.render(props)),/outcome is uncertain/);
 readable=true;await button(h.render(props),'Check import status').props.onClick();assert.equal(calls.filter(c=>c[1].method==='POST').length,1);assert.equal(h.state.dataset.revision,3);assert.equal(h.state.pendingPreview,null);assert.equal(notifications.length,2);assert.ok(calls.filter(c=>!c[1].method).every(c=>c[1].cache==='no-store'));
});

test('cancel requires stage readback and never changes cumulative data or triggers import success',async()=>{
 let canceled=false;const calls=[],notifications=[],h=uploads({pendingPreview:preview,approveOverlap:true},{fetch:async(url,options={})=>{calls.push([url,options]);return Response.json({preview:{...preview,status:options.method==='POST'||canceled?'canceled':'preview'}});}}),props={...uploadProps,notify:m=>notifications.push(m),onImported:m=>notifications.push(m)};
 await button(h.render(props),'Discard preview').props.onClick();assert.equal(h.state.pendingPreview.stageId,'stage');assert.match(html(h.render(props)),/Cancellation has not been confirmed/);assert.equal(h.state.dataset.revision,2);
 canceled=true;await button(h.render(props),'Discard preview').props.onClick();assert.equal(h.state.pendingPreview,null);assert.equal(h.state.dataset.revision,2);assert.equal(notifications.length,0);assert.equal(JSON.parse(calls[0][1].body).action,'cancel');assert.match(calls[1][0],/siteId=site&stageId=stage/);
});

test('a returned wrong-site stage or missing token cannot be applied, and migration cannot be bypassed by CSV controls',async()=>{
 for(const badPreview of [{...preview,siteId:'other'},{...preview,previewToken:''},{...preview,counts:{...preview.counts,overlapping:undefined}},{...preview,baseRevision:-1}]){
  const h=uploads({requiresMigration:true},{fetch:async()=>Response.json({preview:badPreview})});await button(h.render(uploadProps),'Preview retained file').props.onClick();assert.equal(h.state.pendingPreview,null);assert.match(html(h.render(uploadProps)),/valid preview for this site/);
 }
 let writes=0;const h=uploads({requiresMigration:true,step:4,timezone:'UTC',file:new File(['x'],'file.csv'),validation:{errors:0,warnings:0,totalRows:1,exportCapacityKw:0,timezone:'UTC',timestampConvention:'start'}},{fetch:async()=>{writes++;return Response.json({preview});}});const tree=h.render(uploadProps);assert.equal(button(tree,'Create import preview').props.disabled,true);await button(tree,'Create import preview').props.onClick();assert.equal(writes,0);
});

test('pagination and finding selection reset on reporting filters while the current analysis sentinel remains unchanged',()=>{
 const h=home({selectedFindings:['shown'],issuePage:5});h.render();const effect=h.effects.find(e=>e.deps?.some(d=>d===h.state.filters)&&e.deps?.includes(h.state.freshnessFilter));assert.ok(effect);effect.fn();assert.equal(h.state.issuePage,0);assert.equal(h.state.selectedFindings.length,0);assert.equal(h.state.analysisSelection.runId,'');
});

test('chunked CSV finalization produces a preview rather than a committed import',async()=>{
 const posts=[],chunks=[],notifications=[],file=new File(['timestamp,inv\n'+'2026-06-01T00:00:00Z,1\n'.repeat(30000)],'chunked.csv'),checked={errors:0,warnings:0,totalRows:30000,exportCapacityKw:100,timezone:'UTC',timestampConvention:'start'};
 const h=uploads({timezone:'UTC'},{FormData,CsvProcessor:class{async load(){return {headers:['timestamp','inv'],rows:[],rowCount:30000};}async prepare(){return file;}close(){}},uploadCsvParts:async(...args)=>{chunks.push(args);return 2;},fetch:async(url,options)=>{posts.push([url,options]);return Response.json({preview});}}),props={...uploadProps,notify:m=>notifications.push(m),onImported:m=>notifications.push(m)};
 nodes(h.render(props)).find(n=>n.type==='input'&&n.props.type==='file').props.onChange({target:{files:[file]}});for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));h.state.step=4;h.state.validation=checked;h.state.signalMappings=[{column:'inv',equipmentId:'inv',measurement:'Energy'}];await button(h.render(props),'Create import preview').props.onClick();
 assert.equal(chunks.length,1);assert.equal(posts.length,1);assert.equal(posts[0][0],'/api/telemetry-imports/finalize');assert.equal(JSON.parse(posts[0][1].body).totalChunks,2);assert.equal(h.state.pendingPreview.stageId,'stage');assert.equal(h.state.dataset.revision,2);assert.equal(notifications.length,0);
});

test('an already committed legacy migration is recovered by exact-stage and dataset readback',async()=>{
 const calls=[],imports=[],saved={...preview,status:'committed',result:{revision:1},metadata:{...preview.metadata,source:'migration'}};
 const h=uploads({requiresMigration:true,dataset:{...dataset,revision:0}},{fetch:async(url,options={})=>{calls.push([url,options]);return Response.json(options.method==='POST'||String(url).includes('stageId=')?{preview:saved}:{dataset:{...dataset,revision:1},imports:[],requiresMigration:false});}});
 await button(h.render({...uploadProps,onImported:id=>imports.push(id)}),'Preview retained file').props.onClick();assert.equal(calls.length,3);assert.equal(calls.filter(c=>c[1].method==='POST').length,1);assert.match(calls[1][0],/stageId=stage/);assert.deepEqual(imports,['site']);assert.equal(h.state.requiresMigration,false);assert.equal(h.state.dataset.revision,1);
});
