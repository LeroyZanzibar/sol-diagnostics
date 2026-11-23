// UI-only deterministic hook runner. Production components and model are source-loaded;
// only React scheduling, DOM focus, data-hook transport and view HTTP are controlled here.
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadSource} from './source-module.mjs';
import * as domain from '../app/monthly-domain.mjs';

export const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree, ...nodes(tree.props?.children)];
export const html = tree => renderToStaticMarkup(tree);
export const button = (tree, label) => nodes(tree).find(n => n.type === 'button' && (n.props['aria-label'] === label || html(n).replace(/<[^>]+>/g, '') === label));
export const field = (tree, label) => nodes(tree).find(n => ['input', 'select'].includes(n.type) && n.props['aria-label'] === label);
export const event = value => ({target:{value},preventDefault(){},stopPropagation(){}});
export const settle = async () => {for(let i=0;i<10;i++) await new Promise(resolve => setImmediate(resolve));};
export const settings = {start:'2026-01',end:'2026-03',type:'line',comparisonYears:0,metrics:['utilityTotal','projectedProduction','actualInsolation']};
export function snapshot(siteId='site') {
  const metric = value => ({value:value===null?null:domain.fraction(value),state:value===null?'missing':'complete',coveredMilliseconds:2678400000,partialIntervals:0,unknownQualityIntervals:0,negativeIntervals:0});
  const utility = (onPeak,revenue) => ({onPeak,offPeak:null,unpaidEnergy:null,revenue,energyUsed:null,invoiceCost:null});
  const s = {siteId,revision:1,configuration:domain.emptyConfiguration(),utility:{'2025-01':utility('8','-5'),'2026-01':utility('10','-12'),'2026-02':utility(null,'0'),'2026-03':utility('0','14')},projections:['2026-01','2026-02','2026-03','2049-12'].map(month => ({month,days:31,operationalDays:31,production:domain.fraction('9'),revenue:domain.fraction('11'),insolation:domain.fraction('2')})),capacity:{dcKwp:domain.fraction('2'),unavailableReason:null},telemetry:{state:'current',sourceRevision:3,timezone:'America/New_York',selectedChannelId:'irradiance-channel',selectionRequired:false,expectedChannelId:'expected-channel',expectedUnavailableReason:null,candidates:[],months:{'2026-01':{expected:metric('11'),insolation:{...metric('2'),state:'partial',unknownQualityIntervals:1,source:'Imported irradiance; satellite/POA provenance unknown'},expectedMilliseconds:2678400000}}}};
  s.calculated=domain.calculatedRows(s.projections,s.utility,s.telemetry,s.capacity);
  return s;
}
export function harness({data={snapshot:snapshot(),refreshing:false,error:'',reload:async()=>{}},fetch=async()=>Response.json({views:[]}),plotOnly=false}={}) {
  let current, cursor=0, dirty=false, tree, props, nextId=0;
  const frames=new Map(), queue=new Set(), dom=new Map(), components=[], listeners=new Map(), listenerSets=new Map();
  const doc={activeElement:null,addEventListener(name,fn){const handlers=listenerSets.get(name)??new Set();handlers.add(fn);listenerSets.set(name,handlers);listeners.set(name,event=>{for(const handler of [...handlers])handler(event);});},removeEventListener(name,fn){const handlers=listenerSets.get(name);handlers?.delete(fn);if(!handlers?.size)listeners.delete(name);}};
  const slot=init=>{const i=cursor++;if(!current.slots[i])current.slots[i]=init();return current.slots[i];};
  const memo=(fn,deps)=>{const s=slot(()=>({}));if(!s.deps||!deps||deps.some((d,i)=>d!==s.deps[i])){s.value=fn();s.deps=deps;}return s.value;};
  const hooks={
    useState(init){const s=slot(()=>({value:typeof init==='function'?init():init}));return [s.value,next=>{const value=typeof next==='function'?next(s.value):next;if(value!==s.value){s.value=value;dirty=true;}}];},
    useRef(init){return slot(()=>({current:init}));},
    useMemo:memo,useCallback:(fn,deps)=>memo(()=>fn,deps),useId:()=>slot(()=>({id:`ui-${++nextId}`})).id,
    useEffect(fn,deps){const s=slot(()=>({}));if(!s.deps||!deps||deps.some((d,i)=>d!==s.deps[i])){s.deps=deps;s.fn=fn;queue.add(s);}},
  };
  class FixedDate extends Date {constructor(...args){super(...(args.length?args:['2026-11-23T12:00:00Z']));}}
  const bindings={React,...hooks,Date:FixedDate,Error,TypeError,AbortController,structuredClone,fetch,document:doc,window:{addEventListener(){},removeEventListener(){}},ResizeObserver:undefined};
  const model=loadSource('app/monthly-chart-model.ts',[],{...domain,Error,TypeError,RangeError});
  const plot=loadSource('app/MonthlyChartPlot.tsx',[],{...bindings,...model});
  const ui=plotOnly?null:loadSource('app/MonthlyCharts.tsx',[],{...bindings,...model,MonthlyChartPlot:plot.default,chartSeriesColor:plot.chartSeriesColor,useMonthlyChartData:()=>data});
  const root=plotOnly?plot.default:ui.default;
  function renderNode(n,path='root') {
    if(Array.isArray(n))return n.map((c,i)=>renderNode(c,`${path}.${c?.key??i}`));
    if(!n||typeof n!=='object')return n;
    if(n.type===React.Fragment)return renderNode(n.props.children,`${path}.f`);
    if(typeof n.type==='function'){
      components.push(n);current=frames.get(path)??{slots:[]};frames.set(path,current);cursor=0;
      return renderNode(n.type(n.props),`${path}.c`);
    }
    // Every reconstructed child gets a deterministic harness key; otherwise this
    // host-only SSR rebuild loses React's original static-child/key bookkeeping.
    const out=React.createElement(n.type,{...n.props,key:n.key??path,children:renderNode(n.props.children,`${path}.h`)});
    const host=dom.get(path)??{path,open:false,clientWidth:700,focus(){doc.activeElement=this;this.props.onFocus?.({currentTarget:this});},scrollIntoView(){},contains(target){return this===target||!!target?.path?.startsWith(`${this.path}.`);},querySelector(selector){return this.querySelectorAll(selector)[0]??null;},querySelectorAll(selector){return [...dom.values()].filter(el=>el.path.startsWith(`${this.path}.`)&&(selector==='[data-month-details]'?el.props?.['data-month-details']!==undefined:selector.includes('[data-view-entry]')?el.props?.['data-view-entry']!==undefined:selector==='summary'?el.type==='summary':selector.startsWith('[data-chart-hit=')?selector.includes(`"${el.props?.['data-chart-hit']}"`):false));}};
    host.type=n.type;host.props=n.props;dom.set(path,host);if(n.props.open!==undefined)host.open=n.props.open;
    if(typeof n.props.ref==='object'&&n.props.ref)n.props.ref.current=host;
    if(typeof n.props.ref==='function')n.props.ref(host);
    return out;
  }
  const h={data,model,plot,document:doc,dom,listeners,get tree(){return tree},components,
    render(next=props){props=next??{};dirty=false;components.length=0;tree=renderNode(React.createElement(root,props));return tree;},
    async flush(){for(let i=0;i<15;i++){for(const s of [...queue]){queue.delete(s);s.cleanup?.();s.cleanup=s.fn();}await settle();if(dirty)h.render();if(!queue.size&&!dirty)break;}return tree;},
    dispose(){for(const f of frames.values())for(const s of f.slots)s.cleanup?.();},
  };
  assert.equal(typeof root,'function');return h;
}
export const props={sites:[{id:'site',name:'Synthetic UI site',location:'Test location'},{id:'other',name:'Other UI site',location:''}],siteId:'site',onSiteChange:()=>{}};
