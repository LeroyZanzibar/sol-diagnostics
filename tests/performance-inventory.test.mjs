import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './source-module.mjs';

function inventory(manager) {
  const sites=[{id:'canonical',name:'Canonical site'},{id:'empty',name:'Empty site'},{id:'legacy',name:'Legacy site'}];
  const route=loadSource('app/api/site-settings/route.ts',[],{
    Error,asc:value=>value,siteSettings:{name:'name'},telemetryImports:{siteId:'site_id'},
    getDb:()=>({select:()=>({from:()=>({orderBy:async()=>sites})}),selectDistinct:()=>({from:async()=>[{siteId:'legacy'}]})}),
    optionalPerformanceStoreManager:()=>manager,
  });
  return {sites,get:route.GET};
}

test('site inventory includes canonical datasets and retained legacy imports, not empty sites',async()=>{
  const calls=[],f=inventory({hasData:id=>{calls.push(id);return id==='canonical';}}),before=JSON.stringify(f.sites);
  const response=await f.get();assert.equal(response.status,200);const body=await response.json();
  assert.deepEqual(body.sitesWithPerformanceData,['canonical','legacy']);
  assert.deepEqual(calls,['canonical','empty'],'Do not open stores for sites already covered by a retained legacy import');
  assert.equal(JSON.stringify(f.sites),before);
});

test('legacy-only runtime keeps compatibility and datastore failure is not reported as an empty site',async()=>{
  let response=await inventory(undefined).get();assert.equal(response.status,200);assert.deepEqual((await response.json()).sitesWithPerformanceData,['legacy']);
  response=await inventory({hasData:()=>{throw new Error('Synthetic incompatible site database');}}).get();
  assert.equal(response.status,500);assert.match((await response.json()).error,/incompatible site database/);
});
