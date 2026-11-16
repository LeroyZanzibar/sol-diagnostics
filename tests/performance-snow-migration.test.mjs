import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {drizzle} from 'drizzle-orm/d1';
import {sql} from 'drizzle-orm';
import * as sqliteCore from 'drizzle-orm/sqlite-core';
import {LocalDatabase,LocalBucket} from '../selfhost/storage.mjs';
import {PerformanceStoreManager} from '../selfhost/performance-store.mjs';
import {loadSource,modelCapacityBindings} from './source-module.mjs';
import {analysisCsvFixture,performanceBindings} from './performance-analysis-fixture.mjs';

const time=loadSource('app/telemetry-time.ts');
const bindings={...modelCapacityBindings(),...time,...loadSource('app/meter-mapping.ts'),
 ...loadSource('app/api/performance-summary/causes.ts',[],time),
 ...loadSource('app/api/performance-summary/peer-comparison.ts',[],{...modelCapacityBindings(),...time}),
 ...loadSource('app/api/performance-summary/telemetry-events.ts',[],{...modelCapacityBindings(),...time})};
const ingest=loadSource('app/performance-ingest.ts',[],{...time,...loadSource('app/telemetry-csv.ts',[],bindings)});
const schema=loadSource('db/schema.ts',[],{sql,...sqliteCore});
const plain=value=>JSON.parse(JSON.stringify(value));
function comparableSummary(summary) {
 const result=plain(summary);
 // Canonical data already uses interval starts; equivalent legacy end-labelled
 // inputs retain their source convention in metadata, not their calculations.
 result.timestampConvention='start';
 result.equipmentProduction.sort((a,b)=>a.equipmentId.localeCompare(b.equipmentId));
 return result;
}

for(const {timezone,date,timestamp} of [
 {timezone:'UTC',date:'2026-06-01',timestamp:'2026-06-01T00:00:00Z'},
 {timezone:'America/New_York',date:'2026-03-08',timestamp:'2026-03-08T05:17:00Z'},
]) for(const measurement of ['Snow code','Status','Other']) {
 test(`retained ${measurement} snow migration preserves full analysis in ${timezone}`,async t=>{
  const root=mkdtempSync(join(tmpdir(),'sol-snow-migration-'));
  const db=new LocalDatabase(join(root,'shared.sqlite'),'drizzle');
  const bucket=new LocalBucket(db,join(root,'objects'));
  const manager=new PerformanceStoreManager(join(root,'performance'));
  t.after(()=>{manager.close();db.close();rmSync(root,{recursive:true,force:true});});
  const fixture=await analysisCsvFixture({timezone,date,measurement:'GHI irradiance',deficitKwh:30,snow:[{timestamp,value:70}]});
  const record=plain(fixture.record),mapping=JSON.parse(record.mapping);
  mapping.equipment.signals.find(signal=>signal.equipmentId==='snow').measurement=measurement;
  record.mapping=JSON.stringify(mapping);
  const orm=drizzle(db);
  await orm.insert(schema.siteSettings).values({id:'site',name:'Synthetic snow migration'});
  await orm.insert(schema.equipmentAssets).values(fixture.equipment.map(asset=>({...asset,siteId:'site'})));
  await orm.insert(schema.telemetryImports).values({...record,fileName:'retained.csv',fileSize:Buffer.byteLength(fixture.source),validRows:record.rowCount,detectedTypes:'[]'});
  await bucket.put(record.objectKey,fixture.source);
  const service=loadSource('app/api/performance-data/service.ts',[],{...time,...ingest,
   ...loadSource('db/depot-performance-cleanup.ts'),getDatabaseBinding:()=>db,getBucketBinding:()=>bucket,getPerformanceStoreManager:()=>manager});
  const store=manager.site('site');
  const helpers=loadSource('app/api/performance-data/analysis.ts',[],performanceBindings(store));
  const route=loadSource('app/api/performance-summary/route.ts',['buildSummary','buildAnalysis'],{...bindings,...helpers,getBucketBinding:()=>bucket});
  const legacy=await route.buildSummary(record,fixture.equipment);
  assert.ok(legacy.snowDays.includes(date));
  const legacyAnalysis=route.buildAnalysis(plain(legacy),fixture.equipment);
  assert.ok(legacyAnalysis.issues.some(issue=>issue.suspectedCause==='Snow'));

  const preview=await service.previewLegacyPerformance('site');
  assert.equal(store.describe().revision,0);
  assert.equal(preview.metadata.source,'migration');
  const committed=await service.commitPerformancePreview({siteId:'site',stageId:preview.stageId,previewToken:preview.previewToken,approveOverlap:false},'synthetic-test');
  assert.equal(committed.committed,true);
  assert.equal(store.describe().revision,1);
  assert.equal(await(await bucket.get(record.objectKey)).text(),fixture.source);
  const observations=[...store.rows()].filter(row=>row.channel.equipmentId==='snow'&&row.value!==null);
  assert.equal(observations.length,1);
  assert.equal(observations[0].timestamp,new Date(timestamp).toISOString());
  assert.equal(observations[0].channel.measurement,measurement);
  const canonical=await route.buildSummary(helpers.performanceAnalysisInput('site'),fixture.equipment);
  assert.deepEqual(comparableSummary(canonical),comparableSummary(legacy));
  assert.deepEqual(plain(route.buildAnalysis(plain(canonical),fixture.equipment)),plain(legacyAnalysis));
 });
}
