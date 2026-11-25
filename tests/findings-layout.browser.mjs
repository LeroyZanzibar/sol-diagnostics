// Offline Chromium geometry regression using the actual page render and production CSS.
// Run after npm run build:
// CHROMIUM=/path/to/chrome node tests/findings-layout.browser.mjs /absolute/evidence/path
// This fixture does not hydrate, fetch, or write application data. Handler behavior is
// exercised separately in findings-layout.test.mjs and the existing UI suites.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {home,html,loadSource,React,periods,groups,visibility} from './outage-only-ui-harness.mjs';

const executable=process.env.CHROMIUM;
assert.ok(executable,'Set CHROMIUM to the installed Chromium executable');
const out=resolve(process.argv[2]||join(tmpdir(),'findings-layout-evidence'));
mkdirSync(out,{recursive:true});
const css=readdirSync('dist/client/assets').filter(n=>n.endsWith('.css')).map(n=>readFileSync(join('dist/client/assets',n),'utf8')).join('\n').replaceAll('/fonts/',pathToFileURL(resolve('public/fonts')).href+'/');
assert.ok(css.includes('.findings-actions'),'Build the current application before running browser checks');
const ReportingPeriod=loadSource('app/ReportingPeriod.tsx',[],{React,...periods}).default;
const ReviewWorkbench=loadSource('app/ReviewWorkbench.tsx',[],{React,useState:React.useState,...groups,reviewEnergy:loadSource('app/BulkReviewDialog.tsx').reviewEnergy,BulkReviewDialog:()=>null}).default;
for(const [name,range] of Object.entries({empty:{from:'',through:''},bounded:{from:'2026-06-01',through:'2026-06-30'},invalid:{from:'2026-07-01',through:'2026-06-30'}})){
 const h=home({reportRange:range,userSettingsError:'Synthetic preference error',user:{firstName:'Test',lastName:'User',theme:'default',issueVisibility:{...visibility.defaultIssueVisibility,equipmentOutage:false}}},{ReportingPeriod,ReviewWorkbench,useDataFreshness:()=>({assessment:{runId:'run',status:'current',reasons:[],dependencyScope:'analysis-range',comparedRevision:null},ready:true,loading:false,error:''})});
 writeFileSync(join(out,`${name}.html`),`<!doctype html><html data-theme="default"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${html(h.render())}</body></html>`);
}
const profile=mkdtempSync(join(tmpdir(),'findings-chromium-'));
const chrome=spawn(executable,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let socket;
try {
 for(let i=0;i<100&&!existsSync(join(profile,'DevToolsActivePort'));i++)await sleep(100);
 const port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];
 const target=await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
 socket=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
 let seq=0;const pending=new Map();
 socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(message.error):p.resolve(message.result);}}};
 const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.equal(r.exceptionDetails,undefined,JSON.stringify(r.exceptionDetails));return r.result.value;};
 const results=[];
 for(const theme of loadSource('app/themes.ts').themes.map(t=>t.id))for(const state of ['empty','bounded','invalid'])for(const width of [1440,1200,1024,768,390,320]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:pathToFileURL(join(out,`${state}.html`)).href});
  for(let i=0;i<50;i++){if(await evaluate('document.readyState === "complete" && !!document.querySelector(".findings-actions")'))break;await sleep(30);}
  await evaluate(`document.querySelectorAll('[data-theme]').forEach(el=>el.dataset.theme=${JSON.stringify(theme)})`);
  await evaluate('document.fonts.ready.then(() => true)');
  await sleep(250);
  const measured=await evaluate(`(() => {
   const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,bottom:r.bottom,right:r.right,width:r.width,height:r.height};};
   return {viewport:innerWidth,scroll:document.documentElement.scrollWidth,site:rect('.findings-actions select'),from:rect('[aria-label="Reporting period from"]'),through:rect('[aria-label="Reporting period through"]'),reanalyze:rect('.findings-reanalyze'),help:rect('.reporting-period-help'),removed:document.querySelectorAll('.active-analysis,.issue-visibility-notice,.maintenance-panel').length,error:!!document.querySelector('.reporting-period-error'),retry:!!document.querySelector('.preferences-load-error button'),reset:[...document.querySelectorAll('.findings-actions button')].some(b=>b.textContent==='All dates')};
  })()`);
  writeFileSync(join(out,'last-measurement.json'),JSON.stringify({theme,state,width,...measured},null,2));
  const currentShot=await cdp('Page.captureScreenshot',{format:'png'});writeFileSync(join(out,'last-measurement.png'),Buffer.from(currentShot.data,'base64'));
  assert.equal(measured.viewport,width);
  assert.equal(measured.removed,0);
  assert.equal(measured.error,state==='invalid');assert.equal(measured.retry,true);assert.equal(measured.reset,state!=='empty');
  for(const key of ['site','from','through','reanalyze','help']){
   assert.ok(measured[key].width>0,`${theme}/${state}/${width}: ${key} visible`);
   assert.ok(measured[key].x>=0&&measured[key].right<=width+1,`${theme}/${state}/${width}: ${key} within viewport ${JSON.stringify(measured[key])}`);
  }
  assert.ok(measured.scroll<=width+1,`${theme}/${state}/${width}: document overflow ${measured.scroll}`);
  if(width>1100){
   for(const key of ['from','through','reanalyze']){
    assert.ok(Math.abs(measured.site.y-measured[key].y)<1,`${theme}/${state}/${width}: ${key} top aligned`);
    assert.ok(Math.abs(measured.site.bottom-measured[key].bottom)<1,`${theme}/${state}/${width}: ${key} bottom aligned`);
   }
   assert.ok(measured.site.right<=measured.from.x&&measured.from.right<=measured.through.x&&measured.through.right<=measured.reanalyze.x);
  }
  results.push({theme,state,width,...measured});
  if(state==='bounded'&&[1440,390].includes(width)){
   const shot=await cdp('Page.captureScreenshot',{format:'png'});writeFileSync(join(out,`${theme}-${width}.png`),Buffer.from(shot.data,'base64'));
  }
 }
 writeFileSync(join(out,'geometry.json'),JSON.stringify(results,null,2));
 console.log(`PASS: ${results.length} real Chromium layout cases; evidence: ${out}`);
}finally{
 socket?.close();chrome.kill('SIGTERM');await new Promise(r=>chrome.exitCode!==null?r():chrome.once('exit',r));rmSync(profile,{recursive:true,force:true});
}
