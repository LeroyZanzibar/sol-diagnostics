import {mkdirSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,timingSafeEqual} from 'node:crypto';
import {LocalDatabase,LocalBucket,LocalFixedLengthStream} from './storage.mjs';

const password=process.env.SOL_PASSWORD_FILE?readFileSync(process.env.SOL_PASSWORD_FILE,'utf8').trim():process.env.SOL_PASSWORD;
const username=process.env.SOL_USERNAME||'admin';
if(!password||password.length<16)throw Error('Set SOL_PASSWORD (at least 16 characters) or SOL_PASSWORD_FILE. Run ./setup.sh first.');
if(username.includes(':')||!username.trim())throw Error('SOL_USERNAME must be nonempty and cannot contain a colon.');
const credentialHash=createHash('sha256').update(`${username}:${password}`).digest();
const data=resolve(process.env.SOL_DATA_DIR||'./data');mkdirSync(data,{recursive:true,mode:0o700});
const database=new LocalDatabase(resolve(data,'sol-diagnostics.sqlite'),resolve('drizzle'));
const bucket=new LocalBucket(database,resolve(data,'objects'));await bucket.collectOrphans();
const runtime={database,bucket,cleanup:undefined};
globalThis[Symbol.for('sol-diagnostics.runtime')]=runtime;
globalThis.FixedLengthStream=LocalFixedLengthStream;
const {startProdServer}=await import('vinext/server/prod-server');
const {server}=await startProdServer({host:process.env.HOST||'0.0.0.0',port:Number(process.env.PORT||3080),outDir:resolve('dist')});
const handlers=server.listeners('request');server.removeAllListeners('request');
const failures=new Map();
const publicOrigin=process.env.SOL_PUBLIC_URL?new URL(process.env.SOL_PUBLIC_URL).origin:null;
server.on('request',(req,res)=>{
  if(req.url==='/healthz'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"status":"ok"}');return;}
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  const address=req.socket.remoteAddress||'',now=Date.now(),failure=failures.get(address);
  if(failure&&failure.until<=now)failures.delete(address);
  if(failure?.until>now&&failure.count>=30){res.writeHead(429,{'Retry-After':'300'});res.end('Too many sign-in attempts. Try again in five minutes.');return;}
  const auth=req.headers.authorization||'';
  const actual=auth.startsWith('Basic ')&&auth.length<4096?Buffer.from(auth.slice(6),'base64').toString('utf8'):'';
  if(!timingSafeEqual(createHash('sha256').update(actual).digest(),credentialHash)){
    // Initial browser challenges are not failed password attempts.
    if(auth){if(failures.size>1000)failures.clear();const previous=failures.get(address);failures.set(address,{count:(previous?.count||0)+1,until:previous?.until||now+300000});}
    res.writeHead(401,{'WWW-Authenticate':'Basic realm="Sol Diagnostics", charset="UTF-8"','Content-Type':'text/plain; charset=utf-8'});res.end('Sign in with your local Sol Diagnostics username and password.');return;
  }
  failures.delete(address);
  if(!['GET','HEAD','OPTIONS'].includes(req.method||'GET')){
    const origin=req.headers.origin;
    if(req.headers['sec-fetch-site']==='cross-site'||(origin&&origin!==publicOrigin&&origin!==`http://${req.headers.host}`&&origin!==`https://${req.headers.host}`)){
      res.writeHead(403);res.end('Cross-origin changes are not allowed.');return;
    }
  }
  // Caller-supplied hosted identity headers must never become audit actors.
  for(const key of Object.keys(req.headers))if(key.startsWith('oai-authenticated-'))delete req.headers[key];
  req.headers['oai-authenticated-user-id']=username;
  if(req.url?.startsWith('/api/telemetry-imports'))res.once('finish',()=>void cleanup());
  for(const handler of handlers)handler(req,res);
});
server.requestTimeout=10*60*1000;
let cleaning;
async function cleanup(){if(!runtime.cleanup||cleaning)return;cleaning=Promise.resolve(runtime.cleanup()).catch(error=>console.error('Deferred file cleanup:',error.message)).finally(()=>{cleaning=null;});await cleaning;}
const timer=setInterval(()=>void cleanup(),60000);timer.unref();
let closing=false;
function shutdown(){if(closing)return;closing=true;clearInterval(timer);server.close(async()=>{await cleaning;database.close();process.exit(0);});setTimeout(()=>process.exit(1),110000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
console.log(`Sol Diagnostics: local storage ready (${data}); password protection enabled.`);
