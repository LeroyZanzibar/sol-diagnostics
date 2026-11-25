// Manual browser acceptance driver: production app, isolated synthetic storage.
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {monthlyFixture} from './monthly-fixture.mjs';
import {emptyConfiguration} from '../../app/monthly-domain.mjs';
import {seedMonthlyLossRun,saveLossReview,lossRequest} from './monthly-confirmed-loss-fixture.mjs';
const out=resolve(process.env.SOL_LOSS_BROWSER_EVIDENCE||'.hermes/evidence/monthly-confirmed-loss-browser');mkdirSync(out,{recursive:true});
const f=await monthlyFixture();await seedMonthlyLossRun(f);await f.start();
try{
 const config={...emptyConfiguration(),operationsStart:'2026-01-01',degradation:'0'};config.baselines[1]={production:'1000.125',revenue:'100.25',insolation:'15.125'};
 const post=body=>lossRequest(f,'/api/monthly-data',{body:{siteId:f.siteId,...body}});
 const preview=await post({action:'preview',revision:0,configuration:config});await post({action:'configuration',revision:0,configuration:config,previewToken:preview.token});
 await post({action:'utility',revision:1,rows:[{month:'2026-01',onPeak:'123.1234567890123456',offPeak:null,unpaidEnergy:null,revenue:'12.3450',energyUsed:'0',invoiceCost:null}]});
 await saveLossReview(f,'monthly-current','january','Confirmed');await saveLossReview(f,'monthly-current','boundary','Confirmed');
 const saved=await lossRequest(f,`/api/monthly-data?siteId=${f.siteId}`);
 // Known synthetic-only authentication, never user credentials or external origins.
 writeFileSync(join(out,'fixture.json'),JSON.stringify({syntheticOnly:true,base:f.base,authorization:f.authorization,directory:f.directory,siteId:f.siteId,runId:'monthly-current'},null,2),{mode:0o600});
 writeFileSync(join(out,'initial.json'),JSON.stringify(saved,null,2));
 console.log(JSON.stringify({ready:true,syntheticOnly:true,base:f.base,directory:f.directory,evidence:out}));
}catch(error){await f.stop();throw error;}
let closing=false;async function stop(){if(closing)return;closing=true;await f.stop();process.exit(0);}process.on('SIGTERM',stop);process.on('SIGINT',stop);setInterval(()=>{},60000);
