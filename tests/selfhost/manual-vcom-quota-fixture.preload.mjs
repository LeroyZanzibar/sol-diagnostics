// TEST ONLY: explicit Node preload intercepts the fixed official origin.
// No application import, arbitrary-origin configuration, or live credentials.
import {appendFileSync,existsSync,readFileSync} from 'node:fs';
import {createSyntheticVcomFetch} from './manual-vcom-fixture.preload.mjs';

const mode=process.env.SOL_TEST_VCOM_QUOTA_FIXTURE;
if(mode){
 if(!['success-first','429-first','success-final'].includes(mode))throw Error('Unsupported synthetic quota fixture mode.');
 const trace=process.env.SOL_TEST_VCOM_TRACE;if(!trace)throw Error('Synthetic quota fixture requires a trace file.');
 const offline=createSyntheticVcomFetch();
 // Persist the injection count across real server restarts, not in a client.
 let count=existsSync(trace)?readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).length:0;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  const response=await offline(input,init);
  if(url.origin!=='https://api.meteocontrol.de'||!url.searchParams.has('from'))return response;
  const headers=new Headers(response.headers),now=Date.now();let status=response.status,nextRequestAt=null;
  count++;
  if(response.ok&&((count===1&&mode!=='success-final')||(mode==='success-final'&&url.pathname.endsWith('/meters/201/abbreviations/M_E_INT_IMP/measurements')))){
   if(mode==='429-first'){
    status=429;headers.set('Retry-After','3600');nextRequestAt=new Date(now+3600000).toISOString();
   }else{
    const reset=new Date(now+3600000).toUTCString();
    headers.set('Retry-After','120');
    headers.set('X-RateLimit-Remaining-Minute','0');headers.set('X-RateLimit-Reset-Minute',new Date(now+60000).toUTCString());
    headers.set('X-RateLimit-Remaining-Day','0');headers.set('X-RateLimit-Reset-Day',reset);
    nextRequestAt=new Date(Date.parse(reset)).toISOString();
   }
  }
  appendFileSync(trace,JSON.stringify({synthetic:true,path:url.pathname,query:Object.fromEntries(url.searchParams),at:new Date(now).toISOString(),status,nextRequestAt})+'\n',{mode:0o600});
  return new Response(response.body,{status,headers});
 };
}
