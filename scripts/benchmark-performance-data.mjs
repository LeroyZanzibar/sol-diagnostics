import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {PerformanceStoreManager} from '../selfhost/performance-store.mjs';

// Synthetic benchmark only. Never opens an existing app or site directory.
const timestampCount=Number(process.argv[2]||10000),channelCount=Number(process.argv[3]||12);
if(!Number.isSafeInteger(timestampCount)||timestampCount<2||timestampCount>1000000||!Number.isSafeInteger(channelCount)||channelCount<1||channelCount>1000)throw Error('Use 2..1000000 timestamps and 1..1000 channels.');
const directory=mkdtempSync(join(tmpdir(),'sol-performance-benchmark-'));
const manager=new PerformanceStoreManager(directory);
const base=Date.parse('2026-01-01T00:00:00.000Z');
const channels=Array.from({length:channelCount},(_,index)=>({id:`energy-${index}`,equipmentId:`inverter-${index}`,measurement:'Energy',unit:'kWh'}));
const metadata={source:'api',fileName:'synthetic-benchmark',timezone:'UTC',intervalMinutes:5,modelRevision:'synthetic-benchmark-model-v1'};
function* readings(){for(let index=0;index<timestampCount;index++){const timestamp=new Date(base+index*300000).toISOString();for(let channel=0;channel<channelCount;channel++)yield{timestamp,channel:channels[channel],value:((index+channel)%120)/10};}}
function* corrections(){for(let index=0;index<Math.min(timestampCount,1000);index++)yield{timestamp:new Date(base+index*300000).toISOString(),channel:channels[0],value:100};}
try {
  const store=manager.site('synthetic-benchmark');
  let started=performance.now();const preview=await store.stage(metadata,readings());const stageMs=performance.now()-started;
  assert.equal(store.describe().revision,0);
  started=performance.now();const first=store.commit(preview.stageId,{previewToken:preview.previewToken,approveOverlap:false,modelRevision:metadata.modelRevision,actor:'benchmark'});const commitMs=performance.now()-started;
  const dataset=store.describe();assert.equal(dataset.readingCount,timestampCount*channelCount);
  let count=0,sum=0;started=performance.now();for(const reading of store.rows(first.revision)){count++;sum+=reading.value;}const readMs=performance.now()-started;
  assert.equal(count,timestampCount*channelCount);
  const scope={start:dataset.timestampStart,end:dataset.timestampEnd,measurements:['Energy']};
  started=performance.now();const originalHash=store.fingerprint(first.revision,scope);const fingerprintMs=performance.now()-started;
  const correction=await store.stage({...metadata,fileName:'synthetic-corrections'},corrections());
  started=performance.now();const second=store.commit(correction.stageId,{previewToken:correction.previewToken,approveOverlap:true,modelRevision:metadata.modelRevision,actor:'benchmark'});const correctionCommitMs=performance.now()-started;
  assert.equal(store.fingerprint(first.revision,scope),originalHash,'Pinned revision changed after corrections');
  assert.notEqual(store.fingerprint(second.revision,scope),originalHash);
  let retainedSum=0;for(const reading of store.rows(first.revision))retainedSum+=reading.value;
  assert.equal(retainedSum,sum);
  const timings={stageMs,commitMs,readMs,fingerprintMs,correctionCommitMs};
  console.log(JSON.stringify({timestamps:timestampCount,channels:channelCount,readings:count,correctionReadings:correction.readingCount,
    timingsMs:Object.fromEntries(Object.entries(timings).map(([key,value])=>[key,Number(value.toFixed(2))])),
    maximumRssBytes:process.resourceUsage().maxRSS*1024,pinnedRevisionVerified:true,syntheticOnly:true},null,2));
} finally {manager.close();rmSync(directory,{recursive:true,force:true});}
