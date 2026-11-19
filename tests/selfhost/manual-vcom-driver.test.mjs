import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {ManualVcomDriver} from '../../selfhost/manual-vcom-driver.mjs';
test('server-owned loopback drain starts without browser, authenticates and remains single flight',async t=>{
 let remaining=3,inflight=0,maximum=0,calls=0;const done=Promise.withResolvers();
 const store={pendingDelay:()=>remaining?0:null};
 const driver=new ManualVcomDriver({store,username:'synthetic',password:'synthetic-password-long',spacingMs:1,deadlineMs:1000});
 const server=createServer(async(req,res)=>{
  inflight++;maximum=Math.max(maximum,inflight);calls++;
  assert.equal(req.url,'/api/manual-vcom/work');assert.equal(req.method,'POST');
  assert.equal(req.headers.authorization,'Basic '+Buffer.from('synthetic:synthetic-password-long').toString('base64'));
  assert.equal(driver.verifyWorker(req.headers['x-sol-vcom-worker']),true);
  assert.equal(driver.verifyWorker('attacker'),false);
  await new Promise(resolve=>setTimeout(resolve,10));remaining--;inflight--;res.end('{"worked":true}');if(!remaining)done.resolve();
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await driver.stop();await new Promise(resolve=>server.close(resolve));});
 driver.start(server);driver.wake();driver.wake();await done.promise;await driver.stop();assert.equal(calls,3);assert.equal(maximum,1);
});
test('graceful shutdown lets the bounded in-flight worker checkpoint finish instead of canceling its authorization',async()=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();let interrupted=false,done=false;
 const driver=new ManualVcomDriver({store:{pendingDelay:()=>done?null:0},username:'synthetic',password:'synthetic-password-long',deadlineMs:1000,spacingMs:0,fetchImpl:async(_url,init)=>{init.signal.addEventListener('abort',()=>{interrupted=true;});entered.resolve();await release.promise;done=true;return new Response('{"worked":true}');}});
 driver.start({address:()=>({address:'127.0.0.1',port:12345})});const active=driver.drain();await entered.promise;const stopping=driver.stop();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(interrupted,false);release.resolve();await active;await stopping;assert.equal(done,true);assert.equal(interrupted,false);
});
test('shutdown awaits actual route work, not just an aborted HTTP client',async()=>{
 const driver=new ManualVcomDriver({store:{pendingDelay:()=>null},username:'synthetic',password:'synthetic-password-long'}),pause=Promise.withResolvers();
 let stopped=false;const active=driver.runWork(()=>pause.promise),stopping=driver.stop().then(()=>{stopped=true;});
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(stopped,false);pause.resolve({worked:true});await active;await stopping;assert.equal(stopped,true);
 await assert.rejects(driver.runWork(async()=>({worked:true})),/stopping/);
});
