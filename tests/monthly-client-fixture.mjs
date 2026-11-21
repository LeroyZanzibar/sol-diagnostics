// Real source-loaded hook/component + production-migrated native SQLite.
// Deterministic offline adapter; HTTP/browser acceptance is separate.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import React from 'react';
import {loadSource} from './source-module.mjs';
import {LocalDatabase,LocalBucket} from '../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../selfhost/performance-store.mjs';
import {MonthlyService} from '../selfhost/monthly-rollups.mjs';
import * as domain from '../app/monthly-domain.mjs';
const noop=()=>{};
export function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'monthly-client-')),path=join(root,'shared.sqlite');
 let db=new LocalDatabase(path,resolve('drizzle')),performance=new PerformanceStoreManager(join(root,'performance'));
 db.sqlite.exec("INSERT INTO site_settings(id,name) VALUES ('review-site','Synthetic specification review')");
 let service=new MonthlyService({database:db,bucket:new LocalBucket(db,join(root,'objects')),performance});
 const f={root,get db(){return db},get service(){return service},async reopen(){await service.stop();performance.close();db.close();db=new LocalDatabase(path,resolve('drizzle'));performance=new PerformanceStoreManager(join(root,'performance'));service=new MonthlyService({database:db,bucket:new LocalBucket(db,join(root,'objects')),performance});}};
 t.after(async()=>{await service.stop();performance.close();db.close();});return f;
}
export function harness(fetch){
 const path='app/monthly-client.ts',source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true),names=[];
 function visit(n){if(ts.isVariableDeclaration(n)&&ts.isArrayBindingPattern(n.name)&&n.initializer&&ts.isCallExpression(n.initializer)&&n.initializer.expression.getText(source)==='useState')names.push(n.name.elements[0].getText(source));ts.forEachChild(n,visit);}visit(source);
 const state={},refs=[],effects=[],callbacks=[],queue=[];let si=0,ri=0,ei=0,ci=0,current;
 const client=loadSource(path,[],{...domain,structuredClone,Error,TypeError,fetch,window:{alert:noop,confirm:()=>true,addEventListener:noop,removeEventListener:noop,setInterval:()=>1,clearInterval:noop},
 useState(value){const key=names[si++];assert.ok(key);if(!(key in state))state[key]=typeof value==='function'?value():value;return [state[key],next=>{state[key]=typeof next==='function'?next(state[key]):next;}];},
 useRef(value){return refs[ri++]??(refs[ri-1]={current:value});},
 useCallback(fn,deps){const i=ci++,old=callbacks[i];if(!old||deps.some((d,j)=>d!==old.deps[j]))callbacks[i]={fn,deps};return callbacks[i].fn;},
 useEffect(fn,deps){const i=ei++,old=effects[i];if(!old||deps.some((d,j)=>d!==old.deps[j])){effects[i]={fn,deps,cleanup:old?.cleanup};queue.push(i);}}
 });
 const editor=loadSource('app/MonthlyWorkspace.tsx',[],{...domain,React,useMonthly:()=>current,confirmMonthlyNavigation:client.confirmMonthlyNavigation});
 return {state,module:client,get current(){return current},render(){si=ri=ei=ci=0;return current=client.useMonthly('review-site');},tree(mode){return editor.MonthlyEditor({siteId:'review-site',mode});},async flush(){while(queue.length){const e=effects[queue.shift()];e.cleanup?.();e.cleanup=e.fn();}for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));},dispose(){for(const e of effects)e.cleanup?.();}};
}
export function nodes(tree){if(Array.isArray(tree))return tree.flatMap(nodes);return !tree||typeof tree!=='object'?[]:[tree,...nodes(tree.props?.children)];}
export const field=(tree,label)=>nodes(tree).find(n=>['input','select'].includes(n.type)&&n.props['aria-label']===label);
export function adapter(f,{afterCommit=async()=>{},afterPreview=async()=>{},afterRead=async()=>{}}={}){
 return async(_url,options={})=>{
   if(options.method==='POST'){
     const body=JSON.parse(options.body);
     if(body.action==='utility')f.service.inputs.saveUtility(body.siteId,body.revision,body.rows);
     else if(body.action==='preview'){const result=f.service.inputs.preview(body.siteId,body.revision,body.configuration);await afterPreview(body);return Response.json(result);}
     else if(body.action==='configuration')f.service.inputs.saveConfiguration(body.siteId,body.revision,body.configuration,body.previewToken);
     else throw Error('Unexpected offline action');
     await afterCommit(body);
   }
   const result=await f.service.read('review-site');if(options.method!=='POST')await afterRead();return Response.json(result);
 };
}
export function configured(f){const c={...domain.emptyConfiguration(),operationsStart:'2024-03-16',degradation:'0.5'};const p=f.service.inputs.preview('review-site',0,c);f.service.inputs.saveConfiguration('review-site',0,c,p.token);}

