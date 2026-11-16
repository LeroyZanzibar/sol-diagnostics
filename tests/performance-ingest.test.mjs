import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource,modelCapacityBindings} from './source-module.mjs';
const time=loadSource('app/telemetry-time.ts');
const csv=loadSource('app/telemetry-csv.ts',[],{...modelCapacityBindings(),...time});
const ingest=loadSource('app/performance-ingest.ts',[],{...time,...csv});
const equipment=[{id:'meter',name:'Revenue meter',externalId:'MTR-1',aliases:['main']},{id:'inv',name:'Inverter',externalId:'INV-1',aliases:[]},{id:'weather',name:'Weather',externalId:'WS-1',aliases:[]}];
const options={equipment,timezone:'UTC',timestampConvention:'start'};
const reading=(timestamp,value,patch={})=>({timestamp,equipmentId:'meter',measurement:'Energy',value,...patch});
const normalize=(readings,extra={})=>ingest.prepareJsonImport({...options,readings,...extra});
const collect=async iterator=>{const values=[];for await(const value of iterator)values.push(value);return values;};
const stream=text=>()=>new Response(text).body;
const mapping={timestamp:'time'};
const signals=[{column:'energy',equipmentId:'meter',measurement:'Energy'}];

test('partial API readings retain null, zero and negative values without inventing omitted channels',()=>{
 const result=normalize([reading('2026-01-01T00:00Z',0),reading('2026-01-01T01:00Z',null),reading('2026-01-01T02:00Z',-2)]);
 assert.equal(result.intervalMinutes,60);assert.deepEqual(Array.from(result.readings,x=>x.value),[0,null,-2]);
 assert.deepEqual(Array.from(result.readings,x=>x.channel.equipmentId),['meter','meter','meter']);
});
test('canonical units and channel identity ignore source labels, units and order',()=>{
 const a=normalize([reading('2026-01-01T00:00Z',1,{unit:'MWh'})],{intervalMinutes:60});
 const b=normalize([reading('2026-01-01T00:00Z',1000,{unit:'kWh'})],{intervalMinutes:60});
 assert.equal(a.readings[0].value,1000);assert.equal(a.readings[0].channel.unit,'kWh');assert.equal(a.readings[0].channel.id,b.readings[0].channel.id);
 const c=normalize([reading('2026-01-01T00:00Z',-1000,{measurement:'Active power',unit:'W'}),reading('2026-01-01T01:00Z',1.2,{measurement:'POA irradiance',equipmentId:'weather',unit:'kW/m²'})]);
 assert.deepEqual(Array.from(c.readings,x=>x.value),[-1,1200]);
});
test('invalid nonblank numeric values, cumulative registers, unknown IDs and foreign site expected IDs fail',()=>{
 for(const value of ['not numeric','NaN','Infinity','0x20',{},false])assert.throws(()=>normalize([reading('2026-01-01T00:00Z',value)],{intervalMinutes:60}),/numeric|value/i);
 assert.throws(()=>normalize([reading('2026-01-01T00:00Z',1,{equipmentId:'MTR-1'})],{intervalMinutes:60}),/equipment/i);
 assert.throws(()=>normalize([reading('2026-01-01T00:00Z',1,{measurement:'Cumulative energy'})],{intervalMinutes:60}),/cumulative/i);
 assert.throws(()=>normalize([reading('2026-01-01T00:00Z',1,{equipmentId:'@site'})],{intervalMinutes:60}),/Expected Production/i);
});
test('expected production is a dedicated site channel; mapped Status and Other values survive',()=>{
 const result=normalize([reading('2026-01-01T00:00Z',2,{equipmentId:'@site',measurement:'Expected Production',unit:'MWh'}),reading('2026-01-01T00:00Z','fault',{equipmentId:'inv',measurement:'Status'}),reading('2026-01-01T01:00Z','operator note',{equipmentId:'inv',measurement:'Other'})]);
 assert.equal(result.readings[0].value,2000);assert.equal(result.readings[0].channel.equipmentId,'@site');assert.equal(result.readings[1].value,'fault');assert.equal(result.readings[2].value,'operator note');
});
test('DST instants normalize once and snow events retain observation time',()=>{
 const result=normalize([reading('2026-11-01T01:30-04:00',1),reading('2026-11-01T01:30-05:00',2),reading('2026-11-01T02:17-05:00',70,{equipmentId:'weather',measurement:'Snow code'})],{timezone:'America/New_York',timestampConvention:'end'});
 assert.deepEqual(Array.from(result.readings,x=>x.timestamp),['2026-11-01T04:30:00.000Z','2026-11-01T05:30:00.000Z','2026-11-01T07:17:00.000Z']);
 for(const timestamp of ['2026-11-01 01:30','2026-03-08 02:30'])assert.throws(()=>normalize([reading(timestamp,1)],{timezone:'America/New_York',intervalMinutes:60}),/ambiguous|nonexistent/i);
});
test('one timestamp needs known or explicit cadence; mismatched cadence and grid fail',()=>{
 const readings=[reading('2026-01-01T01:00Z',1)];assert.throws(()=>normalize(readings),/cadence|interval/i);
 assert.equal(normalize(readings,{knownIntervalMinutes:60}).intervalMinutes,60);
 assert.equal(normalize(readings,{intervalMinutes:60}).intervalMinutes,60);
 assert.throws(()=>normalize(readings,{intervalMinutes:15,knownIntervalMinutes:60}),/cadence|interval/i);
 assert.throws(()=>normalize([reading('2026-01-01T01:05Z',1)],{knownIntervalMinutes:60,gridTimestamp:'2026-01-01T00:00:00Z'}),/grid|cadence/i);
 assert.throws(()=>normalize([reading('2026-01-01T00:00Z',1),reading('2026-01-01T00:05Z',1),reading('2026-01-01T00:11Z',1)]),/cadence|interval/i);
});
test('conflicting duplicates fail, identical canonical duplicates dedupe, explicit channel IDs stay separate',()=>{
 const first=reading('2026-01-01T00:00Z',1,{unit:'MWh'});
 assert.equal(normalize([first,{...first,value:1000,unit:'kWh'}],{intervalMinutes:60}).readings.length,1);
 assert.throws(()=>normalize([first,{...first,value:2}],{intervalMinutes:60}),/duplicate|conflict/i);
 assert.throws(()=>normalize([first,{...first,value:null}],{intervalMinutes:60}),/duplicate|conflict/i);
 assert.equal(normalize([first,{...first,value:2,channelId:'second'}],{intervalMinutes:60}).readings.length,2);
});
test('streaming wide CSV validates every row and preserves blank cells and expected production',async()=>{
 const result=await ingest.prepareCsvImport(stream('time,energy,expected,status\r\n2026-01-01T00:00Z,0,1,ok\r\n2026-01-01T01:00Z,,2,"alarm, quoted"\r\n'),{...options,mapping:{...mapping,expectedProduction:'expected'},signals:[...signals,{column:'status',equipmentId:'inv',measurement:'Status'}]});
 const readings=await collect(result.readings);assert.equal(readings.length,6);assert.equal(readings.filter(x=>x.value===null).length,1);assert.equal(readings.find(x=>x.value==='alarm, quoted').channel.measurement,'Status');
 await assert.rejects(ingest.prepareCsvImport(stream('time,energy\n2026-01-01T00:00Z,1\n2026-01-01T01:00Z,broken'),{...options,mapping,signals,validation:{errors:0,validRows:9999}}),/numeric/i);
});
test('CSV long/hybrid uses unambiguous aliases, preserves mapped Other, rejects alias collisions',async()=>{
 const text='time,device,metric,value,unit,energy\n2026-01-01T00:00Z,INV-1,Status,offline,,1\n2026-01-01T01:00Z,main,Other,note,,2';
 const opts={...options,mapping:{...mapping,equipment:'device',measurement:'metric',value:'value',unit:'unit'},signals};
 const readings=await collect((await ingest.prepareCsvImport(stream(text),opts)).readings);assert.equal(readings.length,4);assert.ok(readings.some(x=>x.value==='note'));
 await assert.rejects(ingest.prepareCsvImport(stream(text),{...opts,equipment:[...equipment,{id:'extra',name:'Extra',externalId:'main',aliases:[]}]}),/ambiguous/i);
});
test('CSV parser handles arbitrary UTF-8/quote/CRLF chunk boundaries and rejects malformed records',async()=>{
 const text='\uFEFFtime,energy,status\r\n2026-01-01T00:00Z,1,"héllo\r\n""world"""\r\n2026-01-01T01:00Z,2,ok';
 const bytes=new TextEncoder().encode(text),open=()=>new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}});
 const opts={...options,mapping,signals:[...signals,{column:'status',equipmentId:'inv',measurement:'Status'}]};
 const rows=await collect((await ingest.prepareCsvImport(open,opts)).readings);assert.ok(rows.some(x=>x.value==='héllo\r\n"world"'));
 for(const bad of ['time,energy\n2026-01-01T00:00Z,"1','time,energy\n2026-01-01T00:00Z,1,2','time,energy,energy\n2026-01-01T00:00Z,1,1'])await assert.rejects(ingest.prepareCsvImport(stream(bad),{...options,mapping,signals,knownIntervalMinutes:60}),/CSV|header|column|quote/i);
});
test('advisory validation accepts a one-row correction only with known cadence',()=>{
 const m={timestamp:'time',expectedProduction:'',equipment:'',measurement:'',value:'',unit:''};
 assert.equal(csv.calculateValidation(['time','energy'],[['2026-01-01T00:00Z','1']],m,signals,'UTC','start',60).errors,0);
 assert.equal(csv.calculateValidation(['time','energy'],[['2026-01-01T00:00Z','1']],m,signals,'UTC','start').errors,1);
});
test('canonical temperature, wind and availability conversions preserve out-of-range source values',()=>{
 const rows=[reading('2026-01-01T00:00Z',14,{equipmentId:'weather',measurement:'Module temperature',unit:'°F'}),reading('2026-01-01T01:00Z',36,{equipmentId:'weather',measurement:'Wind speed',unit:'km/h'}),reading('2026-01-01T02:00Z',1.4,{equipmentId:'inv',measurement:'Availability',unit:'fraction'})];
 assert.deepEqual(Array.from(normalize(rows).readings,x=>x.value),[-10,10,140]);
 assert.throws(()=>normalize([reading('2026-01-01T00:00Z',1,{unit:'bananas'})],{intervalMinutes:60}),/unit/i);
 assert.throws(()=>normalize(Array(100001).fill(rows[0]),{intervalMinutes:60}),/100000/);
});
test('CSV irradiance units, explicit long channel IDs and blank coverage are preserved',async()=>{
 const wide=await ingest.prepareCsvImport(stream('time,POA kW/m²\n2026-01-01T00:00Z,1.2\n2026-01-01T01:00Z,'),{...options,mapping,signals:[{column:'POA kW/m²',equipmentId:'weather',measurement:'POA irradiance'}]});
 assert.deepEqual(Array.from(await collect(wide.readings),x=>x.value),[1200,null]);
 const long=await ingest.prepareCsvImport(stream('time,device,metric,value,channel\n2026-01-01T00:00Z,MTR-1,energy,1,export\n2026-01-01T00:00Z,MTR-1,energy,2,import'),{...options,intervalMinutes:60,mapping:{...mapping,equipment:'device',measurement:'metric',value:'value',channelId:'channel'},signals:[]});
 const readings=await collect(long.readings);assert.notEqual(readings[0].channel.id,readings[1].channel.id);
});
test('invalid UTF-8 and overlong cells are rejected and input streams are canceled on failure',async()=>{
 let canceled=false;const open=()=>new ReadableStream({start(controller){controller.enqueue(Uint8Array.of(0xff));},cancel(){canceled=true;}});
 await assert.rejects(ingest.prepareCsvImport(open,{...options,mapping,signals,intervalMinutes:60}),/UTF-8/);assert.equal(canceled,true);
 await assert.rejects(ingest.prepareCsvImport(stream('time,energy\n2026-01-01T00:00Z,'+'1'.repeat(65537)),{...options,mapping,signals,intervalMinutes:60}),/cell.*long/i);
});
test('blank CSV records with actual fields are validated rather than silently skipped',async()=>{
 for(const missing of [',','"",','""'])await assert.rejects(ingest.prepareCsvImport(stream(`time,energy\n2026-01-01T00:00Z,1\n${missing}\n2026-01-01T01:00Z,2`),{...options,mapping,signals}),/timestamp|column/i);
});

test('canonical ingestion rejects original invalid dates instead of Date.parse rollover',()=>{
 for(const timestamp of ['02/30/2026 00:00:00 GMT','2026/02/30 00:00 UTC','02/29/1900 00:00 GMT','2100-02-29T00:00Z','2026-04-31T00:00+05:45','2026-00-01','2026-01-00','2026-13-01','2026-01-01T24:00Z','2026-01-01T00:60Z','2026-01-01T00:00:60Z','01/01/2026 00:00 AM','01/01/2026 13:00 PM']){
  assert.throws(()=>normalize([reading(timestamp,1)],{intervalMinutes:60}),/timestamp|calendar/i,timestamp);
 }
});
test('canonical ingestion rejects all sub-millisecond precision before duplicate detection',()=>{
 for(const timestamp of ['2026-01-01T00:00:00.0001Z','2026-01-01T00:00:00.0002Z','2026-01-01T00:00:00.000001Z','2026-01-01T00:00:00.000002Z','2026-01-01T00:00:00.0000Z','2026-01-01T00:00:00.123456+05:45','01/01/2026 00:00:00.1234 GMT','2026-01-01 00:00:00.0001']){
  assert.throws(()=>normalize([reading(timestamp,1)],{intervalMinutes:60}),/timestamp|precision/i,timestamp);
 }
});
test('canonical timestamp grammar remains bounded and rejects malformed offsets and trailing syntax',()=>{
 for(const timestamp of ['2026-01-01T00:00+24:00','2026-01-01T00:00+05:60','2026-01-01T00:00+5:00','2026-01-01T00:00+05','2026-01-01T00:00Z junk','2026-01-01T00:00 GMT+05:00','2026/01-01 00:00','2026-01-01TT00:00Z','2026-01-01\n00:00Z','1'.repeat(101)]){
  assert.throws(()=>normalize([reading(timestamp,1)],{intervalMinutes:60}),/timestamp/i,timestamp);
 }
});
test('supported calendar forms, valid leap years, offsets and milliseconds retain exact instants',()=>{
 for(const [timestamp,timezone,expected] of [
  ['2000-02-29T12:00Z','UTC','2000-02-29T12:00:00.000Z'],
  ['2024-02-29','UTC','2024-02-29T00:00:00.000Z'],
  ['2026/7/1 12:05:17.125','America/New_York','2026-07-01T16:05:17.125Z'],
  ['07/01/2026 12:05:17 PM','America/New_York','2026-07-01T16:05:17.000Z'],
  ['07.01.2026 12:05:17 AM','UTC','2026-07-01T00:05:17.000Z'],
  ['02/29/2024 12:05:17.12 GMT','UTC','2024-02-29T12:05:17.120Z'],
  ['2026-07-01T12:05:17.1+0545','UTC','2026-07-01T06:20:17.100Z'],
  ['2026-07-01T12:05:17.123-03:30','UTC','2026-07-01T15:35:17.123Z'],
  ['2026-07-01 12:05:17.125','Asia/Kathmandu','2026-07-01T06:20:17.125Z'],
  ['2026-01-01T00:00:00.001Z','UTC','2026-01-01T00:00:00.001Z'],
  ['2026-01-01T00:00:00.002Z','UTC','2026-01-01T00:00:00.002Z'],
 ])assert.equal(normalize([reading(timestamp,0)],{timezone,intervalMinutes:60}).readings[0].timestamp,expected,timestamp);
});
for (const measurement of ['Snow code','Status','Other']) {
 test(`designated snow ${measurement} observations do not shift or establish JSON cadence`,()=>{
  const configured=[...equipment,{id:'snow',type:'weather_sensor',name:' Snow Sensor ',aliases:[]}];
  const observation=reading('2026-11-01T00:17-04:00',70,{equipmentId:'snow',measurement});
  const result=normalize([observation,reading('2026-11-01T01:30-04:00',1),reading('2026-11-01T01:30-05:00',2)],{equipment:configured,timezone:'America/New_York',timestampConvention:'end'});
  assert.equal(result.intervalMinutes,60);
  assert.equal(result.readings.find(row=>row.channel.equipmentId==='snow').timestamp,new Date(observation.timestamp).toISOString());
  assert.deepEqual(Array.from(result.readings.filter(row=>row.channel.equipmentId==='meter'),row=>row.timestamp),['2026-11-01T04:30:00.000Z','2026-11-01T05:30:00.000Z']);
 });
 test(`wide CSV ${measurement} snow-only rows do not create blank production coverage`,async()=>{
  const configured=[...equipment,{id:'snow',type:'weather_sensor',name:'Snow sensor',aliases:[]}];
  const text='time,energy,snow\n2026-06-01T00:17Z,,70\n2026-06-01T01:00Z,1,\n2026-06-01T02:00Z,2,';
  const result=await ingest.prepareCsvImport(stream(text),{...options,equipment:configured,timestampConvention:'end',mapping,signals:[...signals,{column:'snow',equipmentId:'snow',measurement}]});
  const rows=await collect(result.readings);assert.equal(result.intervalMinutes,60);
  assert.equal(rows.find(row=>row.channel.equipmentId==='snow'&&row.value!==null).timestamp,'2026-06-01T00:17:00.000Z');
  assert.deepEqual(rows.filter(row=>row.channel.equipmentId==='meter').map(row=>[row.timestamp,row.value]),[['2026-06-01T00:00:00.000Z',1],['2026-06-01T01:00:00.000Z',2]]);
  assert.equal(rows.filter(row=>row.channel.equipmentId==='snow'&&row.value===null).length,2);
 });
 test(`long CSV ${measurement} snow events retain their observation timestamps`,async()=>{
  const configured=[...equipment,{id:'snow',type:'weather_sensor',name:'Snow sensor',externalId:'SNOW',aliases:[]}];
  const text=`time,device,metric,value\n2026-06-01T00:17Z,SNOW,${measurement},70\n2026-06-01T01:00Z,MTR-1,Energy,1\n2026-06-01T02:00Z,MTR-1,Energy,2`;
  const result=await ingest.prepareCsvImport(stream(text),{...options,equipment:configured,timestampConvention:'end',mapping:{timestamp:'time',equipment:'device',measurement:'metric',value:'value'},signals:[]});
  const rows=await collect(result.readings);assert.equal(result.intervalMinutes,60);assert.equal(rows.length,3);
  assert.equal(rows.find(row=>row.channel.equipmentId==='snow').timestamp,'2026-06-01T00:17:00.000Z');
 });
}
test('snow alias timing requires both the configured sensor type and designated name',()=>{
 for(const asset of [{id:'sensor',type:'inverter',name:'Snow sensor'},{id:'sensor',type:'weather_sensor',name:'Weather'}]) {
  const result=normalize([reading('2026-06-01T01:00Z','70',{equipmentId:'sensor',measurement:'Status'})],{equipment:[...equipment,asset],intervalMinutes:60,timestampConvention:'end'});
  assert.equal(result.readings[0].timestamp,'2026-06-01T00:00:00.000Z');
 }
});

test('strict canonical timestamp validation does not alter the legacy analyzer parser',()=>{
 assert.equal(time.inspectTelemetryTimestamp('02/30/2026 00:00:00 GMT','UTC').timestamp,'2026-03-02T00:00:00.000Z');
 assert.equal(time.inspectTelemetryTimestamp('2026-01-01T00:00:00.0001Z','UTC').timestamp,'2026-01-01T00:00:00.000Z');
});
