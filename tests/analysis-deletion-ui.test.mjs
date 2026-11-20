import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,home,nodes,button,html,performance,noop,tick} from './outage-only-ui-harness.mjs';
const runs=[{id:'run',is_current:true,status:'completed',timestamp_start:'2026-06-01',timestamp_end:'2026-06-30',completed_at:'2026-11-01T12:00:00Z'},{id:'older',status:'completed',timestamp_start:'2026-05-01',timestamp_end:'2026-05-31'}];
const props={sites:[{id:'site',name:'Synthetic site'},{id:'other',name:'Other site'}],siteId:'site',runId:'',revision:'1',onSiteChange:noop,onChange:noop,onFindings:noop,onDeleted:noop};
const row=(tree,id)=>nodes(tree).find(n=>n.type==='tr'&&nodes(n).some(x=>x.type==='strong'&&x.props.children===id));
async function setup(fetch,patch={}){const h=harness('app/ManageAnalyses.tsx',{}, {fetch});const p={...props,...patch};h.render(p);await h.flush();return {h,p};}

test('per-run confirmation names site/run/range, warns for current, and cancel sends no DELETE',async()=>{
 const calls=[],{h,p}=await setup(async(url,o={})=>{calls.push([url,o]);return Response.json({runs,next:null});});
 let tree=h.render(p),del=button(row(tree,'run'),'Delete');assert.ok(del,'Each completed analysis must expose Delete');del.props.onClick();tree=h.render(p);
 const dialog=nodes(tree).find(n=>n.props?.role==='alertdialog');assert.ok(dialog);const text=html(dialog);assert.match(text,/Synthetic site/);assert.match(text,/run/);assert.match(text,/2026/);assert.match(text,/published current/i);assert.match(text,/source readings/i);assert.match(text,/review evidence/i);assert.doesNotMatch(text,/secure erase|reclaim|recover.*space/i);
 button(dialog,'Cancel').props.onClick();assert.equal(nodes(h.render(p)).some(n=>n.props?.role==='alertdialog'),false);assert.equal(calls.filter(c=>c[1].method==='DELETE').length,0);h.dispose();
});

test('confirmed deletion is single-flight, bodyless, verified by exact target readback before callback',async()=>{
 const calls=[],deleted=[];let resolveDelete,removed=false;
 const {h,p}=await setup(async(url,o={})=>{calls.push([url,o]);if(o.method==='DELETE'){removed=true;return new Promise(r=>{resolveDelete=r;});}return Response.json({runs:removed?runs.filter(r=>r.id!=='run'):runs,next:null});},{onDeleted:(...args)=>deleted.push(args)});
 button(row(h.render(p),'run'),'Delete').props.onClick();let tree=h.render(p),confirm=button(nodes(tree).find(n=>n.props?.role==='alertdialog'),'Delete analysis');assert.ok(confirm);
 const action=confirm.props.onClick();confirm.props.onClick();await tick();assert.equal(calls.filter(c=>c[1].method==='DELETE').length,1);assert.equal(deleted.length,0);const sent=calls.find(c=>c[1].method==='DELETE');assert.equal(sent[0],'/api/analysis-history?siteId=site&runId=run');assert.equal(sent[1].body,undefined);
 resolveDelete(Response.json({deleted:true,siteId:'site',runId:'run',currentCleared:true}));await action;await tick();assert.deepEqual(deleted,[['site','run',true]]);assert.equal(calls.at(-1)[0],'/api/analysis-history?siteId=site');assert.notEqual(calls.at(-1)[1].method,'DELETE');assert.equal(row(h.render(p),'run'),undefined);h.dispose();
});

for(const code of ['ANALYSIS_IN_USE','ANALYSIS_NOT_COMPLETED','ANALYSIS_POINTER_CONFLICT'])test(`409 ${code} retains the row and explains refusal`,async()=>{
 const deleted=[],calls=[],{h,p}=await setup(async(url,o={})=>{calls.push([url,o]);return o.method==='DELETE'?Response.json({error:'Deletion refused for safety.',code},{status:409}):Response.json({runs,next:null});},{onDeleted:(...args)=>deleted.push(args)});
 button(row(h.render(p),'run'),'Delete').props.onClick();await button(nodes(h.render(p)).find(n=>n.props?.role==='alertdialog'),'Delete analysis').props.onClick();const tree=h.render(p);assert.ok(row(tree,'run'));assert.equal(deleted.length,0);assert.match(html(tree),/Deletion refused|in use|Only completed|analysis pointer/i);assert.equal(calls.filter(c=>c[1].method==='DELETE').length,1);h.dispose();
});

for(const failure of ['lost','plain','wrong identity'])test(`unknown ${failure} acknowledgement checks exact membership without replay`,async()=>{
 const calls=[],deleted=[];let removed=false;const {h,p}=await setup(async(url,o={})=>{calls.push([url,o]);if(o.method==='DELETE'){removed=true;if(failure==='lost')throw new Error('Lost reply');if(failure==='plain')return new Response('Unexpected proxy response',{status:502});return Response.json({deleted:true,siteId:'other',runId:'run',currentCleared:false});}return Response.json({runs:removed?runs.filter(r=>r.id!=='run'):runs,next:null});},{onDeleted:(...args)=>deleted.push(args)});
 button(row(h.render(p),'run'),'Delete').props.onClick();await button(nodes(h.render(p)).find(n=>n.props?.role==='alertdialog'),'Delete analysis').props.onClick();assert.equal(calls.filter(c=>c[1].method==='DELETE').length,1);assert.equal(deleted.length,1);assert.equal(deleted[0][0],'site');assert.equal(deleted[0][1],'run');h.dispose();
});

test('unverified deletion offers read-only recovery, safely handles plain auth and never claims success',async()=>{
 const calls=[],deleted=[];let readable=false,attempted=false;
 const {h,p}=await setup(async(url,o={})=>{calls.push([url,o]);if(o.method==='DELETE'){attempted=true;throw new Error('Lost reply');}if(attempted&&!readable)return new Response('Unauthorized',{status:401});return Response.json({runs:attempted?runs.filter(r=>r.id!=='run'):runs,next:null});},{onDeleted:(...args)=>deleted.push(args)});
 button(row(h.render(p),'run'),'Delete').props.onClick();await button(nodes(h.render(p)).find(n=>n.props?.role==='alertdialog'),'Delete analysis').props.onClick();assert.equal(deleted.length,0);let tree=h.render(p);assert.match(html(tree),/not.*verified|uncertain|could not verify/i);assert.ok(row(tree,'run'));assert.equal(button(row(tree,'run'),'Delete').props.disabled,true);
 readable=true;await button(tree,'Check deletion status').props.onClick();assert.equal(deleted.length,1);assert.equal(calls.filter(c=>c[1].method==='DELETE').length,1);h.dispose();
});

test('late cross-site delete and history responses cannot alter the newly selected site',async()=>{
 const requests=[],deleted=[];const {h,p}=await setup(async(url,o={})=>{if(o.method==='DELETE')return new Promise(resolve=>requests.push({url,o,resolve}));return Response.json({runs:url.includes('siteId=other')?[{id:'other-run'}]:runs,next:null});},{onDeleted:(...args)=>deleted.push(args)});
 button(row(h.render(p),'run'),'Delete').props.onClick();const pending=button(nodes(h.render(p)).find(n=>n.props?.role==='alertdialog'),'Delete analysis').props.onClick();await tick();assert.equal(requests.length,1);
 const other={...p,siteId:'other'};h.render(other);await h.flush();requests[0].resolve(Response.json({deleted:true,siteId:'site',runId:'run',currentCleared:true}));await pending;
 const tree=h.render(other);assert.ok(row(tree,'other-run'));assert.equal(row(tree,'run'),undefined);assert.equal(nodes(tree).some(n=>n.props?.role==='alertdialog'),false);assert.equal(deleted.length,0);h.dispose();
});

test('a verified delete finishing after navigation still invalidates its parent cache without changing another site',async()=>{
 for(const otherSite of [false,true]){
  const calls=[];let resolveDelete,removed=false;
  const fetch=async(url,o={})=>{calls.push([url,o]);if(o.method==='DELETE')return new Promise(r=>{resolveDelete=r;});return Response.json({runs:removed?[runs[1]]:runs,next:null});};
  const parent=home({view:'manage-analyses'},{fetch}),manager=nodes(parent.render()).find(n=>n.props?.onFindings),child=harness('app/ManageAnalyses.tsx',{}, {fetch});
  child.render(manager.props);await child.flush();button(row(child.render(manager.props),'run'),'Delete').props.onClick();const action=button(nodes(child.render(manager.props)).find(n=>n.props?.role==='alertdialog'),'Delete analysis').props.onClick();await tick();assert.equal(calls.filter(c=>c[1].method==='DELETE').length,1);
  parent.refs.performanceCacheRef.current.set('site',{data:performance()});parent.state.view='issues';if(otherSite){parent.state.activeSiteId='other';parent.state.performance=performance('other-run');}const displayed=parent.state.performance;parent.render();child.dispose();removed=true;resolveDelete(Response.json({deleted:true,siteId:'site',runId:'run',currentCleared:true}));await action;
  assert.equal(parent.state.performance,otherSite?displayed:null);assert.equal(parent.state.performanceRevision,otherSite?0:1);assert.equal(parent.refs.performanceCacheRef.current.has('site'),false);assert.equal(parent.state.view,'issues');parent.dispose();
 }
});

test('consumed or canceled confirmation handlers never authorize a replay, including uncertain outcomes',async()=>{
 for(const mode of ['canceled','verified','uncertain']){
  const calls=[],deleted=[];let attempted=false;
  const {h,p}=await setup(async(url,o={})=>{calls.push([url,o]);if(o.method==='DELETE'){attempted=true;return Response.json({deleted:true,siteId:'site',runId:'run',currentCleared:true});}if(attempted&&mode==='uncertain')throw new Error('Readback unavailable');return Response.json({runs:attempted?[runs[1]]:runs,next:null});},{onDeleted:(...args)=>deleted.push(args)});
  const originalDelete=button(row(h.render(p),'run'),'Delete');originalDelete.props.onClick();const dialog=nodes(h.render(p)).find(n=>n.props?.role==='alertdialog'),confirm=button(dialog,'Delete analysis');
  if(mode==='canceled')button(dialog,'Cancel').props.onClick();else await confirm.props.onClick();
  await confirm.props.onClick();await confirm.props.onClick();
  if(mode==='uncertain'){originalDelete.props.onClick();h.render(p);await confirm.props.onClick();}
  assert.equal(calls.filter(c=>c[1].method==='DELETE').length,mode==='canceled'?0:1);assert.equal(deleted.length,mode==='verified'?1:0);h.dispose();
 }
});

test('deletion verification follows every opaque history page and refuses malformed pagination',async()=>{
 for(const mode of ['absent','retained','malformed']){
  const calls=[],deleted=[];let attempted=false;
  const {h,p}=await setup(async(url,o={})=>{calls.push([url,o]);if(o.method==='DELETE'){attempted=true;return Response.json({deleted:true,siteId:'site',runId:'run',currentCleared:true});}if(!attempted)return Response.json({runs,next:null});if(url.includes('before='))return Response.json({runs:mode==='retained'?[runs[0]]:[],next:null});return Response.json(mode==='malformed'?{runs:[]}:{runs:[runs[1]],next:'opaque/+=='});},{onDeleted:(...args)=>deleted.push(args)});
  button(row(h.render(p),'run'),'Delete').props.onClick();await button(nodes(h.render(p)).find(n=>n.props?.role==='alertdialog'),'Delete analysis').props.onClick();
  assert.equal(deleted.length,mode==='absent'?1:0);assert.equal(calls.filter(c=>c[1].method==='DELETE').length,1);
  if(mode!=='malformed')assert.match(calls.at(-1)[0],/before=opaque%2F%2B%3D%3D/);
  if(mode==='retained'){assert.ok(row(h.render(p),'run'));assert.match(html(h.render(p)),/still in saved history/);}
  if(mode==='malformed')assert.match(html(h.render(p)),/uncertain/);h.dispose();
 }
});

test('plain authentication refusal is readable and cannot remove the row',async()=>{
 const calls=[],deleted=[],{h,p}=await setup(async(url,o={})=>{calls.push([url,o]);return o.method==='DELETE'?new Response('Unauthorized',{status:401}):Response.json({runs,next:null});},{onDeleted:(...args)=>deleted.push(args)});
 button(row(h.render(p),'run'),'Delete').props.onClick();await button(nodes(h.render(p)).find(n=>n.props?.role==='alertdialog'),'Delete analysis').props.onClick();assert.match(html(h.render(p)),/Access denied/);assert.ok(row(h.render(p),'run'));assert.equal(deleted.length,0);assert.equal(calls.length,2);h.dispose();
});

test('same-site list revisions cannot release a pending DELETE lock or discard its verified result',async()=>{
 const calls=[],deleted=[];let resolveDelete,removed=false;
 const {h,p}=await setup(async(url,o={})=>{calls.push([url,o]);if(o.method==='DELETE')return new Promise(r=>{resolveDelete=r;});return Response.json({runs:removed?[runs[1]]:runs,next:null});},{onDeleted:(...args)=>deleted.push(args)});
 button(row(h.render(p),'run'),'Delete').props.onClick();const confirm=button(nodes(h.render(p)).find(n=>n.props?.role==='alertdialog'),'Delete analysis');const action=confirm.props.onClick();await tick();
 const refreshed={...p,revision:'2'};h.render(refreshed);await h.flush();const tree=h.render(refreshed);assert.equal(button(row(tree,'run'),'Delete').props.disabled,true);confirm.props.onClick();assert.equal(calls.filter(c=>c[1].method==='DELETE').length,1);
 removed=true;resolveDelete(Response.json({deleted:true,siteId:'site',runId:'run',currentCleared:true}));await action;assert.deepEqual(deleted,[['site','run',true]]);assert.equal(row(h.render(refreshed),'run'),undefined);h.dispose();
});

for(const scenario of [{name:'published current',selected:'',target:'run',currentCleared:true,clear:true},{name:'selected history',selected:'run',target:'run',currentCleared:false,clear:true},{name:'other history',selected:'older',target:'run',currentCleared:true,clear:false},{name:'unselected history while current',selected:'',target:'older',currentCleared:false,clear:false}])test(`parent deletion callback invalidates exact caches and refreshes ${scenario.name}`,()=>{
 const data=performance(scenario.selected||'run');const h=home({view:'manage-analyses',analysisSelection:{siteId:'site',runId:scenario.selected},performance:data,selectedFindings:['outage'],reviewTarget:{id:'outage'}});
 const manager=nodes(h.render()).find(n=>n.props?.onFindings);assert.equal(typeof manager.props.onDeleted,'function');const cache=h.refs.performanceCacheRef.current;cache.set('site',{data});cache.set('site|run',{data});cache.set('site|older',{data});cache.set('other',{data});
 manager.props.onDeleted('site',scenario.target,scenario.currentCleared);
 assert.equal(cache.has('site'),false);assert.equal(cache.has(`site|${scenario.target}`),false);assert.equal(cache.has('other'),true);assert.equal(h.state.performanceRevision,1);assert.equal(h.state.analysisSelection.runId,scenario.clear?'':scenario.selected);
 if(scenario.clear){assert.equal(h.state.performance,null);assert.equal(h.state.reviewTarget,null);assert.equal(h.state.selectedFindings.length,0);}else{assert.equal(h.state.performance,data);assert.equal(h.state.selectedFindings.length,1);}
});

test('real Manage Analyses deletion callback reloads the already-current parent without promoting old history',async()=>{
 const calls=[];let removed=false;
 const fetch=async(url,o={})=>{calls.push([url,o]);if(o.method==='DELETE'){removed=true;return Response.json({deleted:true,siteId:'site',runId:'run',currentCleared:true});}if(url.startsWith('/api/analysis-history'))return Response.json({runs:removed?[runs[1]]:runs,next:null});if(url.startsWith('/api/performance-summary'))return Response.json({hasData:false,analysisRequired:true});return Response.json({});};
 const parent=home({view:'manage-analyses',selectedFindings:['outage'],reviewTarget:{id:'outage'}},{fetch}),manager=nodes(parent.render()).find(n=>n.props?.onFindings);
 const child=harness('app/ManageAnalyses.tsx',{}, {fetch});child.render(manager.props);await child.flush();button(row(child.render(manager.props),'run'),'Delete').props.onClick();await button(nodes(child.render(manager.props)).find(n=>n.props?.role==='alertdialog'),'Delete analysis').props.onClick();
 assert.equal(parent.state.performance,null);assert.equal(parent.state.performanceRevision,1);assert.equal(parent.state.analysisSelection.runId,'');assert.equal(parent.state.reviewTarget,null);
 parent.render();await parent.runEffect(e=>e.deps?.length===3&&e.deps[0]==='site'&&e.deps[1]===1&&e.deps[2]==='');
 assert.equal(calls.at(-1)[0],'/api/performance-summary?siteId=site');assert.equal(parent.state.performance.hasData,false);assert.equal(parent.state.performance.analysisRequired,true);assert.equal(parent.state.analysisSelection.runId,'');assert.equal(calls.some(c=>c[0].includes('runId=older')),false);child.dispose();parent.dispose();
});

test('parent stale-site callback cannot clear another site and pending deleted load cannot resurrect cached findings',async()=>{
 const requests=[],h=home({view:'manage-analyses'},{fetch:(url,o={})=>new Promise(resolve=>requests.push({url,o,resolve}))});
 let tree=h.render();const oldManager=nodes(tree).find(n=>n.props?.onFindings);await h.runEffect(e=>e.deps?.length===3&&e.deps[0]==='site'&&e.deps[1]===0&&e.deps[2]==='');assert.equal(requests.length,1);
 oldManager.props.onDeleted('site','run',true);requests[0].resolve(Response.json(performance(),{headers:{ETag:'old'}}));await tick();assert.equal(h.state.performance,null);assert.equal(h.refs.performanceCacheRef.current.has('site'),false);
 h.state.activeSiteId='other';h.state.performance=performance('other-run');h.state.selectedFindings=['other-finding'];h.render();const current=h.state.performance;oldManager.props.onDeleted('site','run',true);assert.equal(h.state.performance,current);assert.deepEqual(h.state.selectedFindings,['other-finding']);h.dispose();
});
