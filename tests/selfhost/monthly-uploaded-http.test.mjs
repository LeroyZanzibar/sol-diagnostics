import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {monthlyFixture} from './monthly-fixture.mjs';
import {LocalDatabase} from '../../selfhost/storage.mjs';
import {harness,nodes,html} from '../monthly-charts-ui-fixture.mjs';

test('ordinary uploaded API → persisted local monthly totals → real chart caller and details, stale upgrade and restart',{timeout:90000},async t=>{
 const f=await monthlyFixture(t);await f.start();const get=()=>f.request(`/api/monthly-data?siteId=${f.siteId}`),post=body=>f.request('/api/monthly-data',{siteId:f.siteId,...body});
 const readings=[{timestamp:'2026-01-01T12:00:00Z',equipmentId:'weather',measurement:'POA irradiance',unit:'W/m²',value:1234.56},{timestamp:'2026-01-01T13:00:00Z',equipmentId:'weather',measurement:'POA irradiance',unit:'W/m²',value:0},{timestamp:'2026-02-01T12:00:00Z',equipmentId:'weather',measurement:'Irradiance',unit:'W/m²',value:2345.67}];
 await f.commit(readings);let current=await get();assert.equal(current.telemetry.candidates.length,1);assert.equal(current.telemetry.selectionRequired,false);
 const configuration={...current.configuration,operationsStart:'2026-01-01',degradation:'0.123456789012345678',irradianceChannelId:JSON.stringify(['weather','POA irradiance',null])};
 const preview=await post({action:'preview',revision:current.revision,configuration});assert.equal(preview.sourceChanged,true);await post({action:'configuration',revision:current.revision,configuration,previewToken:preview.token});
 current=await get();assert.deepEqual(current.telemetry.months['2026-01'].insolation.value,{n:'3858',d:'3125'});assert.deepEqual(current.telemetry.months['2026-02'].insolation.value,{n:'234567',d:'100000'});assert.equal(current.telemetry.months['2026-01'].insolation.coveredMilliseconds,7200000);
 const canonical=await f.request(`/api/performance-data?siteId=${f.siteId}`),h=harness({plotOnly:true});t.after(()=>h.dispose());
 const checkChart=snapshot=>{const series=h.model.buildChartSeries(snapshot,{start:'2026-01',end:'2026-02',type:'line',comparisonYears:0,metrics:['actualInsolation']});assert.equal(series[0].points[0].plotValue,1.23456);assert.equal(series[0].points[0].display,'1.23');assert.equal(series[0].points[1].display,'2.35');h.render({series,type:'line'});nodes(h.tree).find(n=>n.props?.['data-chart-hit']==='0:0').props.onPointerMove({pointerType:'mouse'});h.render();const popup=nodes(h.tree).find(n=>n.props?.['data-month-details']!==undefined);assert.ok(popup);assert.match(html(popup),/1.23/);};checkChart(current);
 const persisted=f.inspect(db=>db.prepare('SELECT * FROM monthly_rollups WHERE site_id=?').get(f.siteId));assert.deepEqual(JSON.parse(persisted.payload_json).months,current.telemetry.months);
 await f.stop();const db=new LocalDatabase(join(f.directory,'sol-diagnostics.sqlite'),resolve('drizzle'));try{const stale=structuredClone(current.telemetry);for(const m of Object.values(stale.months))m.insolation.value=null;db.sqlite.prepare('UPDATE monthly_rollups SET calculation_version=3,payload_json=? WHERE site_id=?').run(JSON.stringify(stale),f.siteId);}finally{db.close();}
 await f.start();const reopened=await get();assert.deepEqual(reopened,current);checkChart(reopened);assert.deepEqual(await f.request(`/api/performance-data?siteId=${f.siteId}`),canonical);
 await f.commit([{...readings[0],value:1500}]);const corrected=await get();assert.deepEqual(corrected.telemetry.months['2026-01'].insolation.value,{n:'3',d:'2'});assert.equal(h.model.buildChartSeries(corrected,{start:'2026-01',end:'2026-01',type:'line',comparisonYears:0,metrics:['actualInsolation']})[0].points[0].display,'1.50');assert.deepEqual(corrected.configuration,configuration);
});
