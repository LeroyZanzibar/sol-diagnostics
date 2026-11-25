import {selectedPoa} from './monthly-poa-unit-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act,useCallback,useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadSource} from './source-module.mjs';
import * as domain from '../app/monthly-domain.mjs';

const blank={onPeak:null,offPeak:null,unpaidEnergy:null,revenue:null,energyUsed:null,invoiceCost:null};
const clone=value=>structuredClone(value);
function snapshot(siteId='loss-client-site',n='2469',d='2'){
  const configuration={...domain.emptyConfiguration(),operationsStart:'2026-01-01',degradation:'0'};
  const s={siteId,revision:7,configuration,utility:{'2026-01':{...blank,onPeak:'12.1250',offPeak:'3.2500',revenue:'-9.5000'}},
    projections:[{month:'2026-01',days:31,operationalDays:31,production:{n:'20',d:'1'},revenue:{n:'-10',d:'1'},insolation:{n:'5',d:'2'}}],
    capacity:{dcKwp:{n:'2',d:'1'},unavailableReason:null},
    telemetry:{poa:selectedPoa(),state:'current',sourceRevision:11,timezone:'UTC',selectedChannelId:null,selectionRequired:false,expectedChannelId:null,expectedUnavailableReason:null,candidates:[],months:{}},
    confirmedLoss:{state:'current',analysisRunId:`${siteId}-published`,timezone:'UTC',months:{'2026-01':{value:{n,d},state:'complete',confirmedCount:n==='0'?0:1,unknownCount:0,reason:null}},reason:null}};
  s.calculated=domain.calculatedRows(s.projections,s.utility,s.telemetry,s.capacity);return s;
}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const nodes=tree=>Array.isArray(tree)?tree.flatMap(nodes):!tree||typeof tree!=='object'?[]:[tree,...nodes(tree.props?.children)];
const field=(tree,label)=>nodes(tree).find(node=>['input','select'].includes(node.type)&&node.props['aria-label']===label);
const lossCell=html=>html.match(/<td\b[^>]*data-confirmed-loss[^>]*>[\s\S]*?<\/td>/)?.[0]??'';

async function harness(t,siteId='loss-client-site'){
  // The probe renders no host children, so this small host container suffices.
  // ReactDOM owns all hook scheduling/effects/cleanup; no simulated React hooks.
  // Only network responses, the interval clock and browser dialogs are controlled.
  const previousWindow=globalThis.window,previousAct=globalThis.IS_REACT_ACT_ENVIRONMENT;
  const timers=new Map(),listeners=new Map(),requests=[];let now=0,nextId=0,current,commits=0,unmounted=false;
  const window={HTMLIFrameElement:class{},confirm:()=>true,alert:()=>{},
    addEventListener(name,fn){const handlers=listeners.get(name)??new Set();handlers.add(fn);listeners.set(name,handlers);},
    removeEventListener(name,fn){listeners.get(name)?.delete(fn);},
    setInterval(fn,ms){const id=++nextId;timers.set(id,{fn,ms,next:now+ms});return id;},
    clearInterval(id){timers.delete(id);}};
  const noop=()=>{},doc={nodeType:9,addEventListener:noop,removeEventListener:noop,activeElement:null,defaultView:window};window.document=doc;
  const container={nodeType:1,tagName:'DIV',namespaceURI:'http://www.w3.org/1999/xhtml',ownerDocument:doc,addEventListener:noop,removeEventListener:noop,textContent:''};
  globalThis.window=window;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  const client=loadSource('app/monthly-client.ts',[],{useCallback,useEffect,useRef,useState,...domain,structuredClone,Error,TypeError,window,
    fetch(url,options){const response=deferred();requests.push({url,options,...response});return response.promise;}});
  const editor=loadSource('app/MonthlyWorkspace.tsx',[],{React,useState,...domain,useMonthly:()=>current,confirmMonthlyNavigation:client.confirmMonthlyNavigation});
  function Probe({siteId}){current=client.useMonthly(siteId);commits++;return null;}
  const root=createRoot(container);
  const h={requests,timers,listeners,window,client,get current(){return current;},get commits(){return commits;},
    tree(mode='comparison'){return editor.MonthlyEditor({siteId:current.snapshot?.siteId??siteId,mode});},
    html(mode='comparison'){return renderToStaticMarkup(React.createElement(editor.MonthlyEditor,{siteId:current.snapshot?.siteId??siteId,mode}));},
    // MonthlyWorkspace keys MonthlyEditor by site/tab/view; exercise the same
    // site-remount boundary, including cleanup of the old hook's live ref.
    async mount(nextSite){await act(async()=>root.render(React.createElement(Probe,{key:nextSite,siteId:nextSite})));},
    async respond(index,data,status=200){assert.ok(requests[index],`request ${index} is actually in flight`);await act(async()=>requests[index].resolve(Response.json(data,{status})));},
    async fail(index,reason=Error('Synthetic offline transport')){assert.ok(requests[index]);await act(async()=>requests[index].reject(reason));},
    async advance(ms){await act(async()=>{now+=ms;for(const timer of timers.values())while(timer.next<=now){timer.next+=timer.ms;timer.fn();}});},
    async run(fn){await act(fn);},
    async unmount(){if(!unmounted){unmounted=true;await act(async()=>root.unmount());}}
  };
  t.after(async()=>{try{await h.unmount();}finally{if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;if(previousAct===undefined)delete globalThis.IS_REACT_ACT_ENVIRONMENT;else globalThis.IS_REACT_ACT_ENVIRONMENT=previousAct;}});
  await h.mount(siteId);assert.equal(requests.length,1);return h;
}

async function loaded(t,s=snapshot()){
  const h=await harness(t,s.siteId);await h.respond(0,s);assert.equal(h.current.refreshing,false);return h;
}

test('real hook polls at 15 seconds and accepts changed review totals and new publications at unchanged monthly/telemetry revisions',async t=>{
  const original=snapshot(),h=await loaded(t,original),inputs=clone({configuration:h.current.configuration,utility:h.current.utility,projections:h.current.snapshot.projections});
  assert.equal(h.requests[0].url,'/api/monthly-data?siteId=loss-client-site');assert.equal(h.requests[0].options.method,'GET');assert.equal(h.requests[0].options.cache,'no-store');
  assert.match(lossCell(h.html()),/<span>1,235<\/span>/);
  await h.advance(14999);assert.equal(h.requests.length,1);await h.advance(1);assert.equal(h.requests.length,2);assert.equal(h.current.refreshing,true);
  assert.doesNotMatch(lossCell(h.html()),/1,235/,'in-flight checking must not look like a verified current total');
  const dismissed=clone(original);dismissed.confirmedLoss.months['2026-01']={value:{n:'0',d:'1'},state:'complete',confirmedCount:0,unknownCount:0,reason:null};
  await h.respond(1,dismissed);assert.deepEqual(clone(h.current.snapshot.confirmedLoss),dismissed.confirmedLoss);assert.match(lossCell(h.html()),/<span>0<\/span>/);
  await h.advance(15000);await h.respond(2,original);assert.match(lossCell(h.html()),/<span>1,235<\/span>/);
  const republished=snapshot('loss-client-site','777','2');republished.confirmedLoss.analysisRunId='replacement-publication';
  await h.advance(15000);await h.respond(3,republished);assert.match(lossCell(h.html()),/<span>389<\/span>/);
  assert.equal(h.current.snapshot.revision,original.revision);assert.equal(h.current.snapshot.telemetry.sourceRevision,original.telemetry.sourceRevision);
  assert.equal(h.current.snapshot.confirmedLoss.analysisRunId,'replacement-publication');
  assert.deepEqual(clone({configuration:h.current.configuration,utility:h.current.utility,projections:h.current.snapshot.projections}),inputs);
});

test('late overlapping poll response cannot replace a newer current publication or its total',async t=>{
  const h=await loaded(t);await h.advance(15000);await h.advance(15000);assert.equal(h.requests.length,3);
  const newest=snapshot('loss-client-site','42');newest.confirmedLoss.analysisRunId='newest-current';
  await h.respond(2,newest);const accepted=h.current.snapshot;
  await h.respond(1,snapshot('loss-client-site','999'));
  assert.equal(h.current.snapshot,accepted);assert.equal(h.current.snapshot.confirmedLoss.analysisRunId,'newest-current');assert.equal(h.current.error,'');assert.match(lossCell(h.html()),/<span>21<\/span>/);
});

test('entering edit while a poll is in flight protects exact utility/configuration drafts and suspends polling until cancel',async t=>{
  const original=snapshot(),h=await loaded(t,original);await h.advance(15000);assert.equal(h.requests.length,2);
  await h.run(async()=>h.current.edit());
  await h.run(async()=>{
    field(h.tree('utility'),'2026-01 On-peak production').props.onChange({target:{value:'77.6250'}});
    field(h.tree('baselines'),'Baseline 1 production').props.onChange({target:{value:'10.1230'}});
  });
  const draft=clone({configuration:h.current.configuration,utility:h.current.utility});assert.equal(h.current.editing,true);
  const oldPoll=snapshot('loss-client-site','999');oldPoll.utility['2026-01'].onPeak='999';
  await h.respond(1,oldPoll);assert.deepEqual(clone({configuration:h.current.configuration,utility:h.current.utility}),draft);assert.deepEqual(clone(h.current.snapshot),original);
  await h.advance(45000);assert.equal(h.requests.length,2,'draft mode does not start background reads');
  h.window.confirm=()=>false;assert.equal(h.client.confirmMonthlyNavigation(),false);
  let prevented=false;for(const listener of h.listeners.get('beforeunload'))listener({preventDefault(){prevented=true;},returnValue:undefined});assert.equal(prevented,true);
  await h.run(async()=>h.current.cancel());assert.equal(h.current.editing,true);assert.deepEqual(clone(h.current.utility),draft.utility);
  h.window.confirm=()=>true;await h.run(async()=>h.current.cancel());assert.equal(h.current.editing,false);assert.deepEqual(h.current.utility,original.utility);assert.deepEqual(h.current.configuration,original.configuration);
  await h.advance(15000);assert.equal(h.requests.length,3);const changed=snapshot('loss-client-site','0','1');await h.respond(2,changed);assert.match(lossCell(h.html()),/<span>0<\/span>/);
});

test('utility save omits loss fields, blocks later edits during POST/readback and accepts fresh loss only with verified saved inputs',async t=>{
  const original=snapshot(),h=await loaded(t,original);let save;
  await h.run(async()=>h.current.edit());
  await h.run(async()=>field(h.tree('utility'),'2026-01 On-peak production').props.onChange({target:{value:'77.6250'}}));
  const staleInput=field(h.tree('utility'),'2026-01 On-peak production'),staleBaseline=field(h.tree('baselines'),'Baseline 1 production');
  await h.run(async()=>{save=h.current.save('utility');staleInput.props.onChange({target:{value:'999.5'}});staleBaseline.props.onChange({target:{value:'999.5'}});});
  assert.equal(h.requests.length,2);assert.equal(h.requests[1].options.method,'POST');
  const posted=JSON.parse(h.requests[1].options.body);assert.deepEqual(Object.keys(posted).sort(),['action','revision','rows','siteId']);assert.equal(posted.rows[0].onPeak,'77.6250');assert.equal('confirmedLoss' in posted,false);
  assert.equal(h.current.busy,true);assert.equal(h.current.utility['2026-01'].onPeak,'77.6250');assert.equal(h.current.configuration.baselines[1].production,null);
  for(const mode of ['utility','baselines','settings']){
    const inputs=nodes(h.tree(mode)).filter(n=>['input','select'].includes(n.type));assert.ok(inputs.length);assert.ok(inputs.every(n=>n.props.disabled===true));assert.match(h.html(mode),/disabled=""/);
  }
  await h.advance(30000);assert.equal(h.requests.length,2);
  const saved=snapshot('loss-client-site','0','1');saved.revision=8;saved.utility['2026-01'].onPeak='77.6250';
  await h.respond(1,saved);assert.equal(h.requests.length,3,'successful POST must still read back authoritative data');assert.equal(h.current.busy,true);
  await h.run(async()=>{field(h.tree('utility'),'2026-01 On-peak production').props.onChange({target:{value:'888.5'}});h.current.cancel();});assert.equal(h.current.utility['2026-01'].onPeak,'77.6250');
  await h.advance(15000);assert.equal(h.requests.length,3);
  await h.respond(2,saved);await save;assert.equal(h.current.busy,false);assert.equal(h.current.editing,false);assert.match(h.current.notice,/Saved and verified/);assert.equal(h.current.utility['2026-01'].onPeak,'77.6250');assert.deepEqual(h.current.configuration,original.configuration);assert.match(lossCell(h.html()),/<span>0<\/span>/);
  await h.run(async()=>h.current.edit());assert.equal(field(h.tree('utility'),'2026-01 On-peak production').props.value,'77.6250');
});

test('poll transport failure and unavailable/deleted publication responses never leave apparently-current totals',async t=>{
  const original=snapshot(),h=await loaded(t,original);await h.advance(15000);await h.fail(1);
  assert.match(h.current.error,/Synthetic offline transport/);assert.equal(h.current.refreshing,false);assert.deepEqual(h.current.utility,original.utility);
  assert.match(lossCell(h.html()),/<span>Unavailable<\/span>/);assert.doesNotMatch(lossCell(h.html()),/1,235/);
  await h.advance(15000);await h.respond(2,original);assert.equal(h.current.error,'');assert.match(lossCell(h.html()),/<span>1,235<\/span>/);
  const unavailable=clone(original);unavailable.confirmedLoss.state='unavailable';unavailable.confirmedLoss.reason='Selected current publication cannot be read.';
  await h.advance(15000);await h.respond(3,unavailable);assert.equal(h.current.error,'');assert.match(lossCell(h.html()),/Unavailable/);assert.match(lossCell(h.html()),/Selected current publication cannot be read/);assert.doesNotMatch(lossCell(h.html()),/1,235/);
  const removed=clone(original);removed.confirmedLoss={state:'missing',analysisRunId:null,timezone:null,months:{},reason:'No current published analysis is available.'};
  await h.advance(15000);await h.respond(4,removed);assert.deepEqual(clone(h.current.snapshot.confirmedLoss),removed.confirmedLoss);assert.match(lossCell(h.html()),/<span>Missing<\/span>/);assert.doesNotMatch(lossCell(h.html()),/1,235/);assert.deepEqual(h.current.utility,original.utility);
});

test('keyed site switch and unmount clean up polling/guards and ignore late responses from the previous site',async t=>{
  const h=await harness(t,'site-a');assert.equal(h.timers.size,1);assert.equal(h.listeners.get('beforeunload').size,1);
  await h.mount('site-b');assert.equal(h.requests.length,2);assert.equal(h.current.snapshot,null);assert.equal(h.timers.size,1);assert.equal(h.listeners.get('beforeunload').size,1);
  const b=snapshot('site-b','0','1');await h.respond(1,b);const accepted=h.current.snapshot;
  await h.respond(0,snapshot('site-a','99999','1'));assert.equal(h.current.snapshot,accepted);assert.equal(h.current.snapshot.siteId,'site-b');assert.match(lossCell(h.html()),/<span>0<\/span>/);assert.doesNotMatch(lossCell(h.html()),/99,999/);
  await h.advance(15000);assert.equal(h.requests.length,3);assert.equal(h.requests[2].url,'/api/monthly-data?siteId=site-b');
  await h.unmount();assert.equal(h.timers.size,0);assert.equal(h.listeners.get('beforeunload').size,0);assert.equal(h.client.confirmMonthlyNavigation(),true);
  const commits=h.commits;await h.respond(2,snapshot('site-b','999','1'));await h.advance(30000);assert.equal(h.commits,commits);assert.equal(h.requests.length,3);
});
