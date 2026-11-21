import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {loadSource,modelCapacityBindings} from '../source-module.mjs';
import {LocalDatabase,LocalBucket} from '../../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../../selfhost/performance-store.mjs';
import {MonthlyService} from '../../selfhost/monthly-rollups.mjs';
import {formatValue} from '../../app/monthly-domain.mjs';

const time=loadSource('app/telemetry-time.ts');
const csv=loadSource('app/telemetry-csv.ts',[],{...modelCapacityBindings(),...time});
const ingest=loadSource('app/performance-ingest.ts',[],{...time,...csv});
const options={equipment:[{id:'weather',name:'Weather station',type:'weather_sensor'}],timezone:'UTC',timestampConvention:'start',intervalMinutes:60};
const expectedId=id=>JSON.stringify(['@site','Expected Production',id]);
function readings(id){return [12,24].flatMap((value,i)=>{
 const timestamp=`2026-01-01T${12+i}:00:00Z`;
 return [{timestamp,equipmentId:'@site',measurement:'Expected Production',value,unit:'kWh',...(id===null?{}:{channelId:id})},{timestamp,equipmentId:'weather',measurement:'Irradiance',value:500,unit:'W/m²'}];
});}
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'monthly-expected-channel-'));let db,performance,service;
 function open(){db=new LocalDatabase(join(root,'shared.sqlite'),resolve('drizzle'));performance=new PerformanceStoreManager(join(root,'performance'));service=new MonthlyService({database:db,bucket:new LocalBucket(db,join(root,'objects')),performance});}
 async function close(){await service.stop();performance.close();db.close();}
 open();db.sqlite.prepare('INSERT INTO site_settings(id,name) VALUES (?,?)').run('site','Synthetic expected channel');
 t.after(close);
 return {root,get db(){return db;},get service(){return service;},get store(){return performance.site('site');},async reopen(){await close();open();}};
}
async function apply(f,prepared,source='api'){
 const preview=await f.store.stage({source,fileName:'Synthetic expected intervals',timezone:'UTC',intervalMinutes:prepared.intervalMinutes,modelRevision:'synthetic-model'},prepared.readings);
 return f.store.commit(preview.stageId,{previewToken:preview.previewToken,approveOverlap:true,modelRevision:'synthetic-model',actor:'synthetic-test'});
}
const json=(f,rows)=>apply(f,ingest.prepareJsonImport({...options,readings:rows}));
const expectedRows=(f,revision)=>Array.from(f.store.reportingRows(revision)).filter(r=>r.channel.measurement==='Expected Production');

for(const id of [null,'forecast'])test(`actual importer/native monthly reports sole ${id===null?'default':'named'} Expected Production without scaling`,async t=>{
 const f=fixture(t),receipt=await json(f,readings(id)),retained=expectedRows(f,receipt.revision);
 assert.deepEqual(retained.map(r=>[r.channel.id,r.value]),[[expectedId(id),12],[expectedId(id),24]]);
 const result=await f.service.read('site'),month=result.telemetry.months['2026-01'];
 // Retain genuine response/cache evidence, including the pre-fix missing result.
 writeFileSync(join(f.root,'observation.json'),JSON.stringify({id,receipt,retained,result},null,2));t.diagnostic(`Synthetic importer readback: ${f.root}`);
 assert.equal(formatValue(month.insolation.value,2),'1.00');
 assert.equal(formatValue(month.expected.value),'36');
 assert.equal(result.telemetry.expectedUnavailableReason??null,null);
 assert.equal(month.expected.coveredMilliseconds,7200000);assert.equal(month.expected.state,'partial');assert.equal(month.expected.unknownQualityIntervals,0);
});

test('named expected long-CSV historical correction retains exact identity, pinned values and effective ownership',async t=>{
 const f=fixture(t);await json(f,readings('forecast'));
 const text='time,equipment,measurement,value,unit,channel\n2026-01-01T12:00:00Z,@site,Expected Production,18,kWh,forecast\n';
 const prepared=await ingest.prepareCsvImport(()=>new Response(text).body,{...options,mapping:{timestamp:'time',equipment:'equipment',measurement:'measurement',value:'value',unit:'unit',channelId:'channel'},signals:[]});
 await apply(f,prepared,'csv');
 assert.deepEqual(expectedRows(f,1).map(r=>[r.channel.id,r.value]),[[expectedId('forecast'),12],[expectedId('forecast'),24]]);
 assert.deepEqual(expectedRows(f,2).map(r=>[r.channel.id,r.value,r.owner.revision]),[[expectedId('forecast'),18,2],[expectedId('forecast'),24,1]]);
 let result=await f.service.read('site');assert.equal(formatValue(result.telemetry.months['2026-01'].expected.value),'42');
 await json(f,[{...readings('forecast')[0],value:null}]);await f.reopen();
 result=await f.service.read('site');assert.equal(result.telemetry.sourceRevision,3);assert.equal(result.telemetry.expectedChannelId,expectedId('forecast'));
 assert.equal(formatValue(result.telemetry.months['2026-01'].expected.value),'42');assert.equal(result.telemetry.months['2026-01'].expected.coveredMilliseconds,7200000);
 assert.deepEqual(expectedRows(f,3).map(r=>[r.value,r.owner.revision]),[[18,2],[24,1]]);
});

test('competing eligible expected series fail closed without suppressing insolation or manual editing',async t=>{
 const f=fixture(t);await json(f,[...readings(null),...readings('forecast').filter(r=>r.measurement==='Expected Production')]);
 const result=await f.service.read('site'),month=result.telemetry.months['2026-01'];
 assert.equal(month.expected.value,null);assert.equal(month.expected.state,'missing');assert.equal(month.expected.coveredMilliseconds,0);
 assert.equal(result.telemetry.expectedChannelId,null);assert.match(result.telemetry.expectedUnavailableReason,/multiple.*Expected Production channels/i);
 assert.equal(formatValue(month.insolation.value,2),'1.00');assert.equal(result.telemetry.selectionRequired,false);
 f.service.inputs.saveUtility('site',0,[{month:'2026-01',onPeak:'5.1250',offPeak:null,revenue:null,energyUsed:null,invoiceCost:null}]);
 assert.equal((await f.service.read('site')).utility['2026-01'].onPeak,'5.1250');assert.equal(expectedRows(f,1).length,4);
});

test('reopened version-1 named-channel cache is recomputed without a new import',async t=>{
 const f=fixture(t);await json(f,readings('forecast'));const initial=await f.service.read('site');
 const retained=expectedRows(f,1),dataset=f.store.describe();
 // A deliberately old private-cache fixture; not a schema/data migration.
 const legacy=structuredClone(initial.telemetry);legacy.calculationVersion=1;delete legacy.expectedChannelId;delete legacy.expectedUnavailableReason;
 legacy.months['2026-01'].expected={value:null,coveredMilliseconds:0,partialIntervals:0,unknownQualityIntervals:0,negativeIntervals:0,state:'missing'};
 f.db.sqlite.prepare('UPDATE monthly_rollups SET calculation_version=1,payload_json=? WHERE site_id=?').run(JSON.stringify(legacy),'site');
 await f.reopen();assert.equal(f.db.sqlite.prepare('SELECT calculation_version FROM monthly_rollups').get().calculation_version,1);
 const result=await f.service.read('site'),cached=f.db.sqlite.prepare('SELECT * FROM monthly_rollups WHERE site_id=?').get('site');
 assert.equal(formatValue(result.telemetry.months['2026-01'].expected.value),'36');assert.equal(result.telemetry.expectedChannelId,expectedId('forecast'));
 assert.equal(cached.calculation_version,2);assert.equal(JSON.parse(cached.payload_json).calculationVersion,2);
 assert.equal(cached.source_revision,1);assert.deepEqual(f.store.describe(),dataset);assert.deepEqual(expectedRows(f,1),retained);
});
