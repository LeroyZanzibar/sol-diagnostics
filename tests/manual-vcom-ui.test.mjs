import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadSource} from './source-module.mjs';

// Offline synthetic fixtures. These tests execute the real component handlers;
// they do not claim production HTTP, provider, or browser integration coverage.
const noop=()=>{};
const TEST_NOW=Date.parse('2026-11-19T12:00:00Z');
class FixtureDate extends Date { constructor(...args){super(...(args.length?args:[TEST_NOW]));} static now(){return TEST_NOW;} }
const time=loadSource('app/telemetry-time.ts');
function harness(path,initial={},bindings={}) {
  const source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true),states=[],refs=[],effects=[],queue=[],defaults={};
  for(const n of source.statements) if(ts.isImportDeclaration(n)) {
    if(n.importClause?.name) defaults[n.importClause.name.text]=()=>null;
    for(const item of n.importClause?.namedBindings?.elements||[]) defaults[item.name.text]=()=>null;
  }
  function visit(n) {
    if(ts.isVariableDeclaration(n)&&ts.isArrayBindingPattern(n.name)&&n.initializer&&ts.isCallExpression(n.initializer)&&n.initializer.expression.getText(source)==='useState') states.push(n.name.elements[0].getText(source));
    ts.forEachChild(n,visit);
  }
  visit(source);
  const state={...initial},callbacks=[];let si=0,ri=0,ei=0,ci=0;
  const module=loadSource(path,[],{...defaults,React,Fragment:React.Fragment,...time,Error,TypeError,AbortController,Date:FixtureDate,
    useState:value=>{const key=states[si++];assert.ok(key,'Every useState has an AST-derived name');if(!(key in state))state[key]=typeof value==='function'?value():value;return [state[key],next=>{state[key]=typeof next==='function'?next(state[key]):next;}];},
    useRef:value=>refs[ri++]??(refs[ri-1]={current:value}),useMemo:fn=>fn(),useCallback:(fn,deps)=>{const i=ci++,old=callbacks[i];if(!old||deps.some((d,j)=>d!==old.deps[j]))callbacks[i]={fn,deps};return callbacks[i].fn;},
    useEffect:(fn,deps)=>{const i=ei++,old=effects[i];if(!old||deps?.some((d,j)=>d!==old.deps[j])){effects[i]={fn,deps,cleanup:old?.cleanup};queue.push(i);}},
    fetch:async()=>Response.json({}),...bindings});
  return {state,module,render(props){si=ri=ei=ci=0;return module.default(props);},
    async flush(){while(queue.length){const e=effects[queue.shift()];e.cleanup?.();e.cleanup=e.fn();}for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));},
    dispose(){for(const e of effects)e.cleanup?.();}};
}
function nodes(tree){if(Array.isArray(tree))return tree.flatMap(nodes);return !tree||typeof tree!=='object'?[]:[tree,...nodes(tree.props?.children)];}
const html=tree=>renderToStaticMarkup(tree);
const button=(tree,label)=>nodes(tree).find(n=>n.type==='button'&&html(n).includes(label));
const field=(tree,label)=>nodes(tree).find(n=>['input','select'].includes(n.type)&&n.props['aria-label']===label);
const source=(id,kind,measurement,unit='kWh')=>({id,kind,measurement,unit,sourceUnit:unit,aggregation:'SUM',deviceId:id,name:`Synthetic ${id}`,eligible:true,reason:null});
const discovery={systemKey:'exact-system',systemName:'Synthetic system',timezone:'America/New_York',discoveredAt:'2026-11-18T12:00:00Z',metadataDigest:'synthetic-digest',sources:[source('simulation:expected','simulation','Expected Production'),source('irradiance:combined','irradiance','Irradiance','W/m²'),source('inverter:1:E_INT','inverter','Energy'),source('meter:2:M_E_INT_EXP','meter-export','Energy'),source('meter:2:M_E_INT_IMP','meter-import','Other')],poaSensors:[source('poa:5','poa','Irradiance','W/m²')],excludedMeters:[],warnings:[]};
const mappings=discovery.sources.map((s,i)=>({sourceId:s.id,measurement:s.measurement,equipmentId:['@site','weather','inverter','meter','meter'][i]}));
const settings={siteId:'site / exact',generation:3,systemKey:discovery.systemKey,authMode:'basic',hasCredentials:true,discovery,mappings,selectedPoaSourceId:null,ready:true,issues:[],updatedAt:'2026-11-18T12:00:00Z'};
const counts={added:5,overlapping:3,changed:1,identical:2,blankPreserved:1};
const dataset={siteId:settings.siteId,revision:2,revisionId:'revision-2',timezone:discovery.timezone,intervalMinutes:60,timestampStart:'2026-10-01T04:00:00Z',timestampEnd:'2026-10-31T23:00:00Z',timestampCount:10,readingCount:20,channelCount:2,createdAt:'2026-10-01',updatedAt:'2026-11-01'};
const preview={siteId:settings.siteId,stageId:'synthetic-stage',previewToken:'synthetic-token',baseRevision:2,status:'preview',counts,timestampStart:'2026-10-01T04:00:00Z',timestampEnd:'2026-10-02T03:00:00Z',readingCount:8,channelCount:5,metadata:{source:'api',sourceImportId:'vcom:synthetic-job',fileName:'synthetic-vcom.csv',timezone:discovery.timezone,intervalMinutes:60,modelRevision:'synthetic-model'},samples:[],createdAt:'2026-11-18T12:00:00Z',expiresAt:'2026-11-20T12:00:00Z'};
const job={id:'synthetic-job',siteId:settings.siteId,requestId:'synthetic-request',generation:3,fromDate:'2026-10-01',throughDate:'2026-10-02',status:'awaiting_approval',createdAt:'2026-11-18T12:00:00Z',updatedAt:'2026-11-18T12:00:00Z',nextAttemptAt:null,completedRequests:4,totalRequests:4,message:'Ready for review.',errorCode:null,stageId:preview.stageId,preview,result:null,quality:{hours:48,sources:5,missingReadings:4,partialSimulationHours:2,missingSimulationHours:1,satelliteGaps:3,poaFilled:0,remainingIrradianceGaps:3,warnings:['Synthetic quality warning']}};
const receipt={siteId:settings.siteId,stageId:preview.stageId,revision:3,revisionId:'revision-3',committedAt:'2026-11-18T13:00:00Z',counts};
const committed={...job,status:'committed',result:receipt,preview:{...preview,status:'committed',result:receipt}};
const workspace={settings,jobs:[job],job};
const equipment=[{id:'weather',type:'weather_sensor',name:'Synthetic weather'},{id:'inverter',type:'inverter',name:'Synthetic inverter'},{id:'meter',type:'revenue_meter',name:'Synthetic meter'}];
const props={siteId:settings.siteId,activeTab:'data',equipment,equipmentLoading:false,dataset,datasetLoading:false,datasetError:'',requiresMigration:false,refreshRevision:0,imports:[],csvBusy:false,csvFileName:null,onChooseCsv:noop,onSelectTab:noop,onTimezone:noop,onVerifiedImport:noop,notify:noop};
function ui(initial={},bindings={}){const w=initial.workspace||workspace,j=w.job||w.jobs[0],p=j?.preview;const approvalIdentity=initial.approveOverlap&&p?JSON.stringify([w.settings.siteId,j.id,p.stageId,p.previewToken,p.baseRevision,w.settings.generation]):null;return harness('app/VcomWorkspace.tsx',{workspace,loading:false,systemKey:settings.systemKey,authMode:'basic',configGeneration:3,mappingGeneration:3,mappingDraft:mappings,selectedPoaSourceId:null,selectedJobId:job.id,fromDate:'2026-10-01',throughDate:'2026-10-02',approvalIdentity,...initial},bindings);}
const parse=options=>JSON.parse(options.body);

 test('date defaults use seven prior site-local dates and calendar-year inclusive bounds',()=>{
  const {defaultVcomRange,vcomRangeIssue}=ui().module;
  assert.deepEqual(JSON.parse(JSON.stringify(defaultVcomRange('America/New_York',new Date('2026-11-19T02:00:00Z')))),{fromDate:'2026-11-11',throughDate:'2026-11-17'});
  assert.equal(defaultVcomRange(''),null);
  assert.equal(vcomRangeIssue('2024-02-29','2025-02-27','2026-11-19'),'');
  assert.match(vcomRangeIssue('2024-02-29','2025-02-28','2026-11-19'),/calendar year/);
  assert.equal(vcomRangeIssue('2023-03-01','2024-02-29','2026-11-19'),'');
  assert.match(vcomRangeIssue('2026-02-30','2026-03-02','2026-11-19'),/valid/);
  assert.match(vcomRangeIssue('2026-11-19','2026-11-20','2026-11-19'),/today/);
});

test('initial null configuration, loading and failed reads render without fake connected state',async()=>{
  const empty={...settings,generation:0,systemKey:'',hasCredentials:false,discovery:null,mappings:[],ready:false,issues:['Save configuration'],updatedAt:null};
  const h=harness('app/VcomWorkspace.tsx',{}, {fetch:async()=>Response.json({settings:empty,jobs:[]})});
  assert.match(html(h.render(props)),/Loading/);await h.flush();let tree=h.render({...props,activeTab:'setup'});
  assert.equal(field(tree,'VCOM API key').props.value,'');assert.equal(h.state.selectedPoaSourceId,null);assert.equal(button(tree,'Test saved connection').props.disabled,true);h.dispose();
  const fail=harness('app/VcomWorkspace.tsx',{}, {fetch:async()=>Response.json({error:'Service unavailable'},{status:503})});fail.render(props);await fail.flush();assert.match(html(fail.render(props)),/Service unavailable/);assert.ok(button(fail.render(props),'Refresh connection'));fail.dispose();
});

test('configuration preserves omitted secrets, then uses saved discovery explicitly with exact generation',async()=>{
  const calls=[];let saved={...settings,generation:4,systemKey:'changed-system',discovery:null,ready:false};
  const h=ui({systemKey:'changed-system'}, {fetch:async(url,options={})=>{calls.push([url,options]);return Response.json({settings:saved,jobs:[]});}});
  await button(h.render({...props,activeTab:'setup'}),'Save configuration').props.onClick();
  assert.deepEqual(parse(calls[0][1]),{action:'configure',siteId:settings.siteId,expectedGeneration:3,systemKey:'changed-system'});
  assert.equal(calls.filter(c=>c[1].method==='POST').length,1);assert.equal(calls[1][1].cache,'no-store');assert.equal(h.state.apiKey,'');
  saved={...saved,generation:5,discovery:{...discovery,systemKey:'changed-system'}};
  await button(h.render({...props,activeTab:'setup'}),'Test saved connection').props.onClick();assert.equal(parse(calls[2][1]).action,'discover');assert.equal(parse(calls[2][1]).expectedGeneration,4);
});

test('bearer credentials use exact payload, clear after save and are never echoed from readback',async()=>{
  const calls=[],h=ui({authMode:'bearer',apiKey:'synthetic-secret-key',accessToken:'synthetic-secret-token'},{fetch:async(url,options={})=>{calls.push([url,options]);return Response.json({settings:{...settings,authMode:'bearer',generation:4},jobs:[]});}});
  await button(h.render({...props,activeTab:'setup'}),'Save configuration').props.onClick();
  assert.deepEqual(parse(calls[0][1]).credentials,{mode:'bearer',apiKey:'synthetic-secret-key',accessToken:'synthetic-secret-token'});
  assert.equal(h.state.apiKey,'');assert.equal(h.state.accessToken,'');assert.doesNotMatch(html(h.render({...props,activeTab:'setup'})),/synthetic-secret/);
});

test('mapping shows every source, fixed IMP Other and separate explicit nullable POA; validates actual handler',async()=>{
  const calls=[],h=ui({}, {fetch:async(url,options={})=>{calls.push([url,options]);return Response.json({settings:{...settings,generation:4},jobs:[]});}});
  let tree=h.render({...props,activeTab:'mapping'}),markup=html(tree);
  assert.match(markup,/meter:2:M_E_INT_IMP/);assert.match(markup,/Other/);assert.match(markup,/Partial|partial|Satellite|satellite/);
  assert.equal(field(tree,'POA fallback source').props.value,'');
  await button(tree,'Save mappings').props.onClick();assert.equal(parse(calls[0][1]).selectedPoaSourceId,null);assert.equal(parse(calls[0][1]).mappings[4].measurement,'Other');
  const unsupported=ui({workspace:{settings:{...settings,discovery:{...discovery,sources:[...discovery.sources,{...source('unsupported','inverter','Energy'),eligible:false,reason:'Missing E_INT'}]}},jobs:[]}}, {fetch:async()=>{throw Error('Must not write');}});
  tree=unsupported.render({...props,activeTab:'mapping'});assert.match(html(tree),/Missing E_INT/);assert.equal(button(tree,'Save mappings').props.disabled,true);await button(tree,'Save mappings').props.onClick();
});

test('manual start uses exact inclusive dates/request identity, stops for review and never applies or analyzes',async()=>{
  const calls=[],queued={...job,status:'queued',stageId:null,preview:null,requestId:'test-request'};
  const h=ui({workspace:{settings,jobs:[]},selectedJobId:null}, {crypto:{randomUUID:()=>queued.requestId},fetch:async(url,options={})=>{calls.push([url,options]);return Response.json({settings,jobs:[queued],job:queued},{status:options.method==='POST'?202:200});}});
  await button(h.render(props),'Download range').props.onClick();
  assert.deepEqual(parse(calls[0][1]),{action:'start',siteId:settings.siteId,expectedGeneration:3,requestId:'test-request',fromDate:'2026-10-01',throughDate:'2026-10-02'});
  assert.equal(calls.filter(c=>c[1].method==='POST').length,1);assert.ok(calls.some(c=>String(c[0]).includes('jobId=synthetic-job')));assert.doesNotMatch(JSON.stringify(calls),/performance-summary|reanalyze|scheduler/);
});

test('API review has quality and all overlap counts; disabled Apply has an actual approval guard',async()=>{
  const calls=[],h=ui({}, {fetch:async(...args)=>{calls.push(args);return Response.json(workspace);}});
  let tree=h.render(props);for(const word of ['Added','Overlapping','Changed','Identical','Blank','Partial simulation','unscaled'])assert.match(html(tree),new RegExp(word));
  const apply=button(tree,'Apply API import');assert.equal(apply.props.disabled,true);await apply.props.onClick();assert.equal(calls.length,0);
  const consent=field(tree,'Approve API overlap');consent.props.onChange({target:{checked:true}});tree=h.render(props);assert.equal(button(tree,'Apply API import').props.disabled,false);
});

test('lost Apply acknowledgement verifies exact job, stage, receipt and dataset before import callback',async()=>{
  const calls=[],verified=[],notices=[];
  const h=ui({approveOverlap:true},{fetch:async(url,options={})=>{calls.push([url,options]);if(options.method==='POST')throw Error('Synthetic lost acknowledgement');if(String(url).startsWith('/api/manual-vcom'))return Response.json({settings,jobs:[committed],job:committed});if(String(url).includes('stageId='))return Response.json({preview:committed.preview});return Response.json({dataset:{...dataset,revision:3,revisionId:'revision-3'},imports:[{...receipt,metadata:preview.metadata,actor:'synthetic',overlapApproved:true}],requiresMigration:false});}});
  await button(h.render({...props,onVerifiedImport:(...a)=>verified.push(a),notify:m=>notices.push(m)}),'Apply API import').props.onClick();
  assert.equal(calls.filter(c=>c[1].method==='POST').length,1);assert.deepEqual(parse(calls[0][1]),{action:'apply',siteId:settings.siteId,jobId:job.id,stageId:preview.stageId,previewToken:preview.previewToken,approveOverlap:true});
  assert.ok(calls.some(c=>String(c[0]).includes('stageId=synthetic-stage')));assert.equal(verified.length,1);assert.equal(notices.length,1);assert.ok(calls.filter(c=>!c[1].method).every(c=>c[1].cache==='no-store'));
});

test('unreadable Apply stays uncertain; explicit check recovers with no POST replay',async()=>{
  const calls=[],verified=[];let readable=false;
  const h=ui({approveOverlap:true},{fetch:async(url,options={})=>{calls.push([url,options]);if(options.method==='POST')return Response.json({settings,jobs:[committed],job:committed});if(!readable)throw Error('Synthetic read failure');if(String(url).startsWith('/api/manual-vcom'))return Response.json({settings,jobs:[committed],job:committed});if(String(url).includes('stageId='))return Response.json({preview:committed.preview});return Response.json({dataset:{...dataset,revision:3,revisionId:'revision-3'},imports:[{...receipt,metadata:preview.metadata}]});}});
  const p={...props,onVerifiedImport:(...args)=>verified.push(args)};await button(h.render(p),'Apply API import').props.onClick();assert.equal(verified.length,0);assert.ok(h.state.uncertain);assert.equal(button(h.render(p),'Apply API import').props.disabled,true);
  readable=true;await button(h.render(p),'Check request status').props.onClick();assert.equal(verified.length,1);assert.equal(calls.filter(c=>c[1].method==='POST').length,1);
});

test('wrong-stage receipt cannot notify or replace the dataset',async()=>{
  const verified=[],h=ui({approveOverlap:true},{fetch:async(url,options={})=>Response.json(String(url).startsWith('/api/manual-vcom')?{settings,jobs:[committed],job:committed}:{preview:{...committed.preview,result:{...receipt,stageId:'wrong'}}})});
  await button(h.render({...props,onVerifiedImport:(...a)=>verified.push(a)}),'Apply API import').props.onClick();assert.equal(verified.length,0);assert.ok(h.state.uncertain);assert.match(html(h.render(props)),/receipt|stage/i);
});

test('late workspace and mutation responses cannot install data or secrets after site change',async()=>{
  const requests=[],verified=[],h=harness('app/VcomWorkspace.tsx',{}, {fetch:(url,options={})=>new Promise(resolve=>requests.push({url,options,resolve}))});
  h.render(props);await h.flush();h.render({...props,siteId:'different-site'});await h.flush();requests[0].resolve(Response.json(workspace));await h.flush();assert.notEqual(h.state.workspace?.settings.siteId,settings.siteId);h.dispose();
  let release,hold=false;const m=ui({approveOverlap:true},{fetch:()=>hold?new Promise(r=>{release=r;}):Promise.resolve(Response.json(workspace))});
  const p={...props,onVerifiedImport:(...a)=>verified.push(a)};m.render(p);await m.flush();field(m.render(p),'Approve API overlap').props.onChange({target:{checked:true}});hold=true;
  const pending=button(m.render(p),'Apply API import').props.onClick();assert.equal(typeof release,'function','Mutation is actually in flight before unmount');m.dispose();release(Response.json({settings,jobs:[committed],job:committed}));await pending;assert.equal(verified.length,0);
});

test('polling exists only for active server-owned jobs and cleans up on unmount',async()=>{
  const timers=[],cleared=[],bindings={setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length;},clearTimeout:id=>cleared.push(id),fetch:async()=>Response.json(workspace)};
  const idle=ui({},bindings);idle.render(props);await idle.flush();assert.equal(timers.length,0);idle.dispose();
  const active=ui({workspace:{settings,jobs:[{...job,status:'downloading',preview:null}],job:{...job,status:'downloading',preview:null}}},bindings);active.render(props);await active.flush();assert.equal(timers.length,1);active.dispose();assert.equal(cleared.length,1);
});

test('retry/cancel require explicit actions and stale-generation retry is guarded',async()=>{
  const calls=[],failed={...job,status:'failed'},h=ui({workspace:{settings,jobs:[failed],job:failed}}, {fetch:async(url,options={})=>{calls.push([url,options]);return Response.json({settings,jobs:[{...failed,status:'queued'}],job:{...failed,status:'queued'}});}});
  await button(h.render({...props,activeTab:'activity'}),'Retry download').props.onClick();assert.deepEqual(parse(calls[0][1]),{action:'retry',siteId:settings.siteId,jobId:job.id});
  const stale=ui({workspace:{settings:{...settings,generation:4},jobs:[failed],job:failed}},{fetch:async()=>{throw Error('Must not write');}});const retry=button(stale.render({...props,activeTab:'activity'}),'Retry download');assert.equal(retry.props.disabled,true);await retry.props.onClick();
});

test('parent has four keyboard-accessible tabs, one site picker and a stable site-keyed API controller',()=>{
  const csv=loadSource('app/telemetry-csv.ts',[],time),h=harness('app/TelemetryUploads.tsx',{siteId:settings.siteId,dataset,datasetLoading:false,pendingPreview:preview,file:new File(['synthetic'],'synthetic.csv')},csv);
  const p={sites:[{id:settings.siteId,name:'Synthetic site',location:'Test'}],initialSiteId:settings.siteId,onBack:noop,notify:noop};
  let tree=h.render(p),tabs=nodes(tree).filter(n=>n.props?.role==='tab');assert.deepEqual(tabs.map(n=>html(n).replace(/<[^>]+>/g,'')),['Data','API setup','Field mapping','Activity']);
  const component=nodes(tree).find(n=>n.props?.onVerifiedImport);assert.ok(component);assert.equal(component.key,settings.siteId);
  const before=h.state.pendingPreview;tabs[1].props.onClick();tree=h.render(p);assert.equal(h.state.pendingPreview,before);assert.equal(h.state.file.name,'synthetic.csv');assert.equal(nodes(tree).find(n=>n.props?.['data-csv-controller']).props.hidden,true);
  assert.equal(nodes(tree).filter(n=>n.type==='select'&&n.props['aria-label']==='Site').length,1);
  let focused=false;tabs=nodes(tree).filter(n=>n.props?.role==='tab');tabs[1].props.onKeyDown({key:'ArrowRight',preventDefault:noop,currentTarget:{parentElement:{querySelector:()=>({focus:()=>{focused=true;}})}}});assert.equal(h.state.activeTab,'mapping');assert.equal(focused,true);
  assert.doesNotMatch(readFileSync('app/VcomWorkspace.tsx','utf8'),/localStorage|sessionStorage|setInterval|\/api\/performance-summary/);
});

test('stored coverage/export are real, manual analysis note is honest and export is disabled without applied data',()=>{
  const csv=loadSource('app/telemetry-csv.ts',[],time),h=harness('app/TelemetryUploads.tsx',{siteId:settings.siteId,dataset,datasetLoading:false,imports:[{...receipt,metadata:preview.metadata}]},csv),p={sites:[{id:settings.siteId,name:'Synthetic site',location:'Test'}],onBack:noop,notify:noop};
  let tree=h.render(p),link=nodes(tree).find(n=>n.type==='a'&&html(n).includes('Export CSV'));assert.ok(link);assert.equal(link.props.href,`/api/performance-data/export?siteId=${encodeURIComponent(settings.siteId)}`);assert.match(link.props.title,/apostrophe/);assert.match(html(tree),/Manual analysis/);assert.match(html(tree),/VCOM API/);
  h.state.dataset={...dataset,revision:0,readingCount:0};tree=h.render(p);assert.equal(button(tree,'Export CSV').props.disabled,true);assert.doesNotMatch(html(tree),/No unresolved gaps|Auto-analyzes|Automatic API updates|Try sample|Preview state/);
});

test('default onboarding executes Save, explicit Discover and explicit complete mapping with no implicit POA',async()=>{
  const calls=[];let saved={settings:{...settings,generation:0,systemKey:'',hasCredentials:false,ready:false,discovery:null,mappings:[],selectedPoaSourceId:null},jobs:[]};
  const h=harness('app/VcomWorkspace.tsx',{}, {fetch:async(url,options={})=>{
    calls.push([url,options]);if(options.method==='POST'){
      const action=parse(options);assert.equal(action.expectedGeneration,saved.settings.generation);
      if(action.action==='configure')saved={...saved,settings:{...saved.settings,generation:1,systemKey:action.systemKey,authMode:action.credentials.mode,hasCredentials:true}};
      else if(action.action==='discover')saved={...saved,settings:{...saved.settings,generation:2,discovery}};
      else if(action.action==='mappings')saved={...saved,settings:{...saved.settings,generation:3,mappings:action.mappings,selectedPoaSourceId:action.selectedPoaSourceId,ready:true}};
      else assert.fail('Only onboarding actions are authorized');
    }return Response.json(saved);
  }});
  const p={...props,activeTab:'setup'};h.render(p);await h.flush();
  for(const [name,value] of [['VCOM system key',discovery.systemKey],['VCOM API key','synthetic-api-secret'],['VCOM username','synthetic-account'],['VCOM password','synthetic-password-secret']])field(h.render(p),name).props.onChange({target:{value}});
  await button(h.render(p),'Save configuration').props.onClick();assert.equal(calls.filter(c=>c[1].method==='POST').length,1);assert.equal(h.state.workspace.settings.discovery,null);assert.equal(h.state.password,'');
  await button(h.render(p),'Test saved connection').props.onClick();let tree=h.render({...p,activeTab:'mapping'});await h.flush();assert.equal(h.state.mappingDraft[0].equipmentId,'@site');assert.equal(h.state.selectedPoaSourceId,null);
  assert.equal(button(tree,'Save mappings').props.disabled,true);await button(tree,'Save mappings').props.onClick();assert.equal(calls.filter(c=>c[1].method==='POST').length,2);
  for(const mapping of mappings.slice(1))field(h.render({...p,activeTab:'mapping'}),`Destination for ${mapping.sourceId}`).props.onChange({target:{value:mapping.equipmentId}});
  await button(h.render({...p,activeTab:'mapping'}),'Save mappings').props.onClick();assert.equal(h.state.workspace.settings.ready,true);assert.equal(parse(calls.filter(c=>c[1].method==='POST').at(-1)[1]).selectedPoaSourceId,null);assert.equal(calls.filter(c=>c[1].method==='POST').length,3);h.dispose();
});

test('incomplete credentials, invalid date ranges and wrong destination types are guarded in handlers',async()=>{
  const calls=[],bindings={fetch:async(...args)=>{calls.push(args);return Response.json(workspace);}};
  const h=ui({apiKey:'synthetic-only-key'},bindings);await button(h.render({...props,activeTab:'setup'}),'Save configuration').props.onClick();assert.match(html(h.render(props)),/complete replacement/);
  for(const dates of [{fromDate:'2026-10-03',throughDate:'2026-10-01'},{fromDate:'2026-02-30',throughDate:'2026-03-02'},{fromDate:'2024-02-29',throughDate:'2025-02-28'}]){
    const invalid=ui({...dates,workspace:{settings,jobs:[]}},bindings),control=button(invalid.render(props),'Download range');assert.equal(control.props.disabled,true);await control.props.onClick();
  }
  const wrong=ui({mappingDraft:mappings.map(m=>m.sourceId==='irradiance:combined'?{...m,equipmentId:'inverter'}:m)},bindings),save=button(wrong.render({...props,activeTab:'mapping'}),'Save mappings');assert.equal(save.props.disabled,true);await save.props.onClick();assert.equal(calls.length,0);
});

test('settings conflict is not falsely acknowledged after a newer generation is read',async()=>{
  const h=ui({}, {fetch:async(url,options={})=>options.method==='POST'?Response.json({error:'Generation changed'},{status:409}):Response.json({settings:{...settings,generation:4},jobs:[]})});
  await button(h.render({...props,activeTab:'mapping'}),'Save mappings').props.onClick();assert.match(h.state.error,/Generation changed/);assert.equal(h.state.message,'');assert.equal(h.state.mappingGeneration,3);assert.equal(button(h.render({...props,activeTab:'mapping'}),'Save mappings').props.disabled,true);
});

test('uncertain start stays fenced through server failure and resolves by exact request readback, never a new POST',async()=>{
  const calls=[];let visible=false;const queued={...job,status:'queued',stageId:null,preview:null};
  const h=ui({workspace:{settings,jobs:[]},selectedJobId:null},{crypto:{randomUUID:()=>job.requestId},fetch:async(url,options={})=>{calls.push([url,options]);return options.method==='POST'?Response.json({error:'Response unavailable'},{status:503}):Response.json({settings,jobs:visible?[queued]:[],...(visible?{job:queued}:{})});}});
  await button(h.render(props),'Download range').props.onClick();assert.equal(h.state.uncertain.requestId,job.requestId);const disabled=button(h.render(props),'Download range');assert.equal(disabled.props.disabled,true);await disabled.props.onClick();assert.equal(calls.filter(c=>c[1].method==='POST').length,1);
  visible=true;await button(h.render(props),'Check request status').props.onClick();assert.equal(h.state.uncertain,null);assert.equal(h.state.selectedJobId,job.id);assert.equal(calls.filter(c=>c[1].method==='POST').length,1);
});

test('an expired preview cannot Apply and offers explicit same-job Retry to restage retained chunks',async()=>{
  const expired={...job,preview:{...preview,expiresAt:'2000-01-01T00:00:00Z'}},calls=[];
  const h=ui({workspace:{settings,jobs:[expired],job:expired},approveOverlap:true},{fetch:async(url,options={})=>{calls.push([url,options]);return Response.json({settings,jobs:[{...expired,status:'queued'}],job:{...expired,status:'queued'}});}});
  const tree=h.render(props),apply=button(tree,'Apply API import');assert.equal(apply.props.disabled,true);await apply.props.onClick();assert.equal(calls.length,0);
  const retry=button(tree,'Retry download');assert.ok(retry);await retry.props.onClick();assert.deepEqual(parse(calls[0][1]),{action:'retry',siteId:settings.siteId,jobId:job.id});
});

test('cancel is acknowledged only from exact job readback and does not report import success',async()=>{
  const calls=[],verified=[];let canceled=false;
  const h=ui({}, {fetch:async(url,options={})=>{calls.push([url,options]);return Response.json({settings,jobs:[job],job:options.method==='POST'||canceled?{...job,status:'canceled'}:job});}});
  const p={...props,onVerifiedImport:(...args)=>verified.push(args)};await button(h.render(p),'Cancel download').props.onClick();assert.ok(h.state.uncertain);assert.match(h.state.error,/Cancellation is not confirmed/);assert.equal(verified.length,0);
  canceled=true;await button(h.render(p),'Check request status').props.onClick();assert.equal(h.state.uncertain,null);assert.equal(calls.filter(c=>c[1].method==='POST').length,1);assert.equal(verified.length,0);
});

test('external CSV refresh queues behind an in-flight configuration write and reads the new state afterward',async()=>{
  const calls=[];let release,saved=workspace;
  const h=ui({}, {fetch:async(url,options={})=>{calls.push([url,options]);if(options.method==='POST')return new Promise(resolve=>{release=()=>{saved={settings:{...settings,generation:4,systemKey:'synthetic-new-system'},jobs:[]};resolve(Response.json(saved));};});return Response.json(saved);}});
  const p={...props,activeTab:'setup'};h.render(p);await h.flush();h.state.systemKey='synthetic-new-system';const changing=button(h.render(p),'Save configuration').props.onClick();assert.equal(typeof release,'function');
  h.render({...p,refreshRevision:1});await h.flush();assert.equal(calls.length,2,'External refresh waits instead of racing the mutation');release();await changing;await h.flush();assert.equal(calls.length,4,'Mutation readback plus queued external refresh');assert.equal(h.state.workspace.settings.generation,4);h.dispose();
});

test('a captured old-site Apply handler and wrong-site GET cannot write or install another site state',async()=>{
  const calls=[],h=ui({approveOverlap:true},{fetch:async(...args)=>{calls.push(args);return Response.json(workspace);}});let currentSite=settings.siteId;
  const p={...props,isSiteCurrent:id=>id===currentSite};const stale=button(h.render(p),'Apply API import');currentSite='other exact site';h.render({...p,siteId:currentSite});await stale.props.onClick();assert.equal(calls.length,0);
  const bad=harness('app/VcomWorkspace.tsx',{}, {fetch:async()=>Response.json({...workspace,settings:{...settings,siteId:'other exact site'}})});bad.render(props);await bad.flush();assert.equal(bad.state.workspace,null);assert.match(bad.state.error,/does not match/);bad.dispose();
});

test('overlap approval is bound to the exact preview even before a new-stage effect is flushed',async()=>{
  const calls=[],h=ui({}, {fetch:async(...args)=>{calls.push(args);return Response.json(workspace);}});
  field(h.render(props),'Approve API overlap').props.onChange({target:{checked:true}});assert.equal(button(h.render(props),'Apply API import').props.disabled,false);
  const changed={...job,preview:{...preview,previewToken:'synthetic-new-token'}};h.state.workspace={settings,jobs:[changed],job:changed};
  const tree=h.render(props);assert.equal(button(tree,'Apply API import').props.disabled,true);assert.equal(field(tree,'Approve API overlap').props.checked,false);await button(tree,'Apply API import').props.onClick();assert.equal(calls.length,0);
});
