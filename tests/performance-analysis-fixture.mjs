import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadSource, modelCapacityBindings } from './source-module.mjs';
const time = loadSource('app/telemetry-time.ts');
const plain = value => JSON.parse(JSON.stringify(value));

// Retained-revision adapter used by the real analysis HTTP pipeline tests.
export function versionedStore(initial, timezone = 'UTC') {
  let revision = 1; const versions = new Map([[1,plain(initial)]]), analyses = new Map(), calls = [];
  const store = {
    calls, versions, analyses,
    replace(rows) { versions.set(++revision,plain(rows)); return revision; },
    describe(n = revision) {
      const rows = versions.get(n); if (!rows) throw new Error('Revision unavailable');
      const timestamps = [...new Set(rows.map(r=>r.timestamp))].sort();
      return {siteId:'site',revision:n,revisionId:`site:revision:${n}`,timezone,intervalMinutes:60,timestampStart:timestamps[0]||null,timestampEnd:timestamps.at(-1)||null,timestampCount:timestamps.length,readingCount:rows.length,channelCount:new Set(rows.map(r=>r.channel.id)).size,createdAt:'2026-06-01T00:00:00Z',updatedAt:`2026-06-0${n}T00:00:00Z`};
    },
    *rows(n = revision, scope) { calls.push(['rows',n,plain(scope||{})]); for(const r of versions.get(n)) if(!scope || r.timestamp>=scope.start && r.timestamp<=scope.end && (!scope.equipmentIds || scope.equipmentIds.includes(r.channel.equipmentId)) && (!scope.measurements || scope.measurements.includes(r.channel.measurement))) yield plain(r); },
    fingerprint(n, scope) { calls.push(['fingerprint',n,plain(scope)]); return createHash('sha256').update(JSON.stringify([...store.rows(n,scope)].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex'); },
    analysis(id) { return analyses.has(id) ? plain(analyses.get(id)) : null; },
    recordAnalysis(id, provenance) { if(analyses.has(id)) assert.deepEqual(plain(provenance),analyses.get(id)); else analyses.set(id,plain(provenance)); },
  };
  return store;
}
export const performanceBindings = store => ({...time,optionalPerformanceStoreManager:()=>store ? {site:id=>{assert.equal(id,'site');return store;}} : undefined,getPerformanceStoreManager:()=>({site:()=>store})});

// Exercise the production CSV normalizer, summary parser and detector with the
// same synthetic source, rather than assembling a parallel summary algorithm.
export async function analysisCsvFixture({measurement='GHI irradiance', timezone='UTC', date='2026-06-01', days=6, snow=[], timestampConvention='end', deficitKwh=12}={}) {
  const asset=(id,type,parentId=null)=>({id,type,parentId,name:id,externalId:id,aliases:'[]'});
  const equipment=[asset('meter','revenue_meter'),asset('sun','weather_sensor'),{...asset('snow','weather_sensor'),name:'Snow sensor'}];
  for(let i=0;i<4;i++)equipment.push({...asset(`inv${i}`,'inverter','meter'),acRatedCapacityKw:'100'},
    {...asset(`modules${i}`,'module_group',`inv${i}`),moduleRatedCapacityW:'500',quantity:250});
  const signals=[{column:'meter Wh',equipmentId:'meter',measurement:'Energy'},
    ...Array.from({length:4},(_,i)=>({column:`inv${i} Wh`,equipmentId:`inv${i}`,measurement:'Energy'})),
    {column:'sun kW/m2',equipmentId:'sun',measurement},{column:'snow',equipmentId:'snow',measurement:'Snow code'}];
  const mapping={timestamp:'time',expectedProduction:'expected'},lines=['time,meter Wh,inv0 Wh,inv1 Wh,inv2 Wh,inv3 Wh,sun kW/m2,snow,expected'];
  for(let day=0;day<days;day++) {
    const localDay=new Date(Date.parse(`${date}T00:00:00Z`)+day*86400000).toISOString().slice(0,10);
    for(let hour=8;hour<=16;hour++) {
      const values=[hour===9?60-deficitKwh:60,60,60,60];
      const timestamp=time.parseTelemetryTimestamp(`${localDay}T${String(hour+(timestampConvention==='end'?1:0)).padStart(2,'0')}:00:00`,timezone);
      assert.ok(timestamp);
      lines.push([timestamp,values.reduce((a,b)=>a+b,0)*1000,...values.map(n=>n*1000),0.6,'',240].join(','));
    }
  }
  for(const observation of snow)lines.push([observation.timestamp,'','','','','','',observation.value??'',''].join(','));
  const source=lines.join('\n');
  const csv=loadSource('app/telemetry-csv.ts',[],{...modelCapacityBindings(),...time});
  const ingest=loadSource('app/performance-ingest.ts',[],{...time,...csv});
  const normalized=await ingest.prepareCsvImport(()=>new Response(source).body,{equipment:equipment.map(a=>({...a,aliases:[]})),timezone,timestampConvention,intervalMinutes:60,mapping,signals});
  const readings=[];for await(const row of normalized.readings)readings.push(plain(row));
  const record={id:'legacy',siteId:'site',objectKey:'raw',timezone,rowCount:lines.length-1,
    validation:JSON.stringify({intervalMinutes:60,timestampConvention}),mapping:JSON.stringify({roles:mapping,equipment:{signals}})};
  return {equipment,source,record,readings};
}
