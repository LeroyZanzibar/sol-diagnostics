import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as XLSX from 'xlsx';
import {loadSource} from './source-module.mjs';

export const time=loadSource('app/telemetry-time.ts');
export const periods=loadSource('app/issue-periods.ts',[],time);
export const dates=loadSource('app/issue-date-format.ts',[],time);
export const review=loadSource('app/issue-review.ts');
export const visibility=loadSource('app/issue-visibility.ts');
export const fresh=loadSource('app/data-freshness.ts');
export const groups=loadSource('app/review-groups.ts',[],{...time,...periods});
const recurring=loadSource('app/recurring-issues.ts',[],{...time,...periods});
const inverterReview=loadSource('app/inverter-review.ts',[],{...periods,...recurring,...groups});
export const method=loadSource('app/report-methodology.ts',[],{...review,...visibility,...fresh,XLSX});
export const noop=()=>{};
export const tick=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
export function harness(path,initial={},bindings={}){
 const parsed=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true),names=[],refNames=[],defaults={};
 for(const node of parsed.statements){if(ts.isImportDeclaration(node)){const c=node.importClause;if(c?.name)defaults[c.name.text]=()=>null;for(const n of c?.namedBindings?.elements||[])defaults[n.name.text]=()=>null;}}
 function visit(n){if(ts.isVariableDeclaration(n)&&n.initializer&&ts.isCallExpression(n.initializer)){
  if(ts.isArrayBindingPattern(n.name)&&n.initializer.expression.getText(parsed)==='useState')names.push(n.name.elements[0].getText(parsed));
  if(ts.isIdentifier(n.name)&&n.initializer.expression.getText(parsed)==='useRef')refNames.push(n.name.text);
 }ts.forEachChild(n,visit);}visit(parsed);
 const state={...initial},refs={},effects=[],queued=new Set(),memos=[];let index=0,refIndex=0,effectIndex=0,memoIndex=0;
 const memo=(fn,deps)=>{const i=memoIndex++,old=memos[i];if(!old||!deps||deps.some((d,j)=>d!==old.deps[j]))memos[i]={deps,value:fn()};return memos[i].value;};
 const module=loadSource(path,[],{...defaults,React,Fragment:React.Fragment,...time,...periods,...dates,...review,...visibility,...fresh,...groups,...method,...recurring,...inverterReview,
  Error,TypeError,AbortController,queueMicrotask,fetch:async()=>Response.json({}),document:{documentElement:{dataset:{}}},window:{scrollTo:noop,setTimeout:()=>0,clearTimeout:noop,setInterval:()=>0,clearInterval:noop,localStorage:{getItem:()=>null,setItem:noop}},
  useMemo:memo,useCallback:(fn,deps)=>memo(()=>fn,deps),
  useState:value=>{const name=names[index++];if(!(name in state))state[name]=typeof value==='function'?value():value;return [state[name],next=>{state[name]=typeof next==='function'?next(state[name]):next;}];},
  useRef:value=>{const name=refNames[refIndex++];return refs[name]??(refs[name]={current:value});},
  useEffect:(fn,deps)=>{const i=effectIndex++,previous=effects[i];if(!previous||!deps||deps.some((d,j)=>d!==previous.deps[j])){effects[i]={deps,fn,cleanup:previous?.cleanup};queued.add(i);}},...bindings});
 return {state,module,refs,effects,render(props={}){index=0;refIndex=0;effectIndex=0;memoIndex=0;return module.default(props);},
  async flush(){while(queued.size){const i=queued.values().next().value;queued.delete(i);const e=effects[i];e.cleanup?.();e.cleanup=e.fn();}await tick();},
  async runEffect(predicate){const i=effects.findIndex(predicate);if(i<0)throw new Error('Expected component effect not found');queued.delete(i);const e=effects[i];e.cleanup?.();e.cleanup=e.fn();await tick();},
  dispose(){for(const e of effects)e.cleanup?.();}
 };
}
export function nodes(tree){if(!tree||typeof tree!=='object')return [];return [tree,...React.Children.toArray(tree.props?.children).flatMap(nodes)];}
export const html=tree=>renderToStaticMarkup(tree);
export const button=(tree,label)=>nodes(tree).find(n=>n.type==='button'&&html(n).includes(label));
export const finding=(id,patch={})=>({id,eventKey:id,evidenceSignature:id,name:`Finding ${id}`,type:'Equipment outage',category:'Performance',confidence:'model-based',severity:'high',equipmentId:'inverter',equipmentName:'Inverter',equipmentType:'inverter',equipmentExternalId:'INV',timezone:'UTC',startDateTime:'2026-06-01T08:00:00Z',endDateTime:'2026-06-01T09:00:00Z',durationMinutes:60,estimatedLossKwh:10,actualEnergyKwh:0,expectedEnergyKwh:10,lossPercent:100,siteImpactPercent:10,description:'Synthetic finding',...patch});
export const performance=(runId='run',issues=[finding('outage')])=>({hasData:true,issueDatabase:{analysisRunId:runId},methodology:{analysisId:runId,calculationVersion:29},summary:{dailyProduction:[],readingCount:3,latestDate:'2026-06-01'},analysis:{issues,analyzedDays:1,analyzedIntervals:1,analysisIntervalMinutes:60,skippedLowIrradianceIntervals:0,baselineMethod:'Daylight outages use supplied Expected Production. Missing references leave loss unknown.'},import:{fileName:'cumulative',createdAt:'2026-06-01',timestampStart:'2026-06-01',timestampEnd:'2026-06-30'},capacityKw:100});
export function home(initial={},bindings={}){
 let book;
 const h=harness('app/page.tsx',{view:'issues',activeSiteId:'site',configs:{site:{id:'site',name:'Synthetic site',city:'Test',state:'',arrayModelVerified:true},other:{id:'other',name:'Other site',city:'',state:'',arrayModelVerified:true}},performance:performance(),userSettingsReady:true,reviewScope:'site:run',reviewsRetrievedAt:'now',reviews:{},user:{firstName:'Test',lastName:'User',theme:'default',issueVisibility:visibility.defaultIssueVisibility},...initial},{
  ...loadSource('app/themes.ts'),useDataFreshness:()=>({assessment:{runId:'run',status:'current',reasons:[],dependencyScope:'analysis-range'},ready:true,loading:false,error:''}),
  useMobileNavigation:()=>({isMobile:false,mobileMenuOpen:false,setMobileMenuOpen:noop,navigationRef:{current:null},menuButtonRef:{current:null}}),
  useMaintenanceWindows:()=>({windows:[],retrievedAt:'now',error:''}),XLSX:{...XLSX,writeFile:b=>{book=b;}},...bindings,
 });return {...h,getBook:()=>book};
}
export {React,XLSX,loadSource};
