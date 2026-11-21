// Real built application, synthetic data only; browser fixture driver, not a test stub.
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {monthlyFixture} from './monthly-fixture.mjs';
import {emptyConfiguration} from '../../app/monthly-domain.mjs';
const out=resolve('.hermes/evidence/monthly/browser');mkdirSync(out,{recursive:true});
const f=await monthlyFixture();await f.start();
const config={...emptyConfiguration(),operationsStart:'2024-03-16',degradation:'0.5',baselines:Object.fromEntries(Array.from({length:12},(_,i)=>[i+1,{production:'3100.123456789012345',revenue:'310.1234567890123456',insolation:'31.12345678901234567'}]))};
const post=body=>f.request('/api/monthly-data',{siteId:f.siteId,...body});const p=await post({action:'preview',revision:0,configuration:config});await post({action:'configuration',revision:0,configuration:config,previewToken:p.token});
await post({action:'utility',revision:1,rows:[{month:'2024-03',onPeak:'123.1234567890123456',offPeak:null,unpaidEnergy:null,revenue:'-123.123456789012345',energyUsed:'0',invoiceCost:'000.01230'}]});
await f.request('/api/site-settings',{name:'Synthetic second site',country:'US'},201);
const readings=[];for(let h=0;h<24;h++)for(const [equipmentId,measurement,value,unit] of [['@site','Expected Production',12.25,'kWh'],['weather','Irradiance',500,'W/m²'],['weather','POA irradiance',600,'W/m²']])readings.push({timestamp:`2024-03-01T${String(h).padStart(2,'0')}:00:00Z`,equipmentId,measurement,value,unit});await f.commit(readings);
// This header is ONLY the known synthetic fixture credential; never a user login.
writeFileSync(resolve(out,'fixture.json'),JSON.stringify({syntheticOnly:true,base:f.base,authorization:f.authorization,siteId:f.siteId,directory:f.directory},null,2),{mode:0o600});
console.log(JSON.stringify({ready:true,base:f.base,directory:f.directory,siteId:f.siteId}));
let closing=false;async function stop(){if(closing)return;closing=true;await f.stop();process.exit(0);}process.on('SIGTERM',stop);process.on('SIGINT',stop);setInterval(()=>{},60000);
