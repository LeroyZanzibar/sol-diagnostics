import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {fixture,harness,adapter,configured,field} from './monthly-client-fixture.mjs';
import {seedMeasuredPoa} from './selfhost/monthly-poa-fixture.mjs';
import {snapshot,loadChartModel,settings} from './monthly-chart-model-fixture.mjs';
import {calculatedRows} from '../app/monthly-domain.mjs';

test('uploaded series settings preview/save/readback preserves legacy identity and precise inputs',async t=>{
 const f=fixture(t);configured(f);
 await seedMeasuredPoa({database:f.db,bucket:f.service.bucket,performance:f.service.performance,root:f.root,siteId:'review-site',samples:[{timestamp:'2024-03-01T00:00:00.000Z',satellite:900,poa:600,expected:12}]});
 await f.service.read('review-site'); // Warm the native evidence scan before the hook scheduler fixture.
 const h=harness(adapter(f));t.after(()=>h.dispose());h.render();await h.flush();h.render().edit();h.render();
 let source=field(h.tree('settings'),'Uploaded POA series');assert.ok(source);assert.equal(source.props.disabled,false);
 const id=h.current.snapshot.telemetry.poa.selectedSourceId;
 source.props.onChange({target:{value:id}});h.render();
 field(h.tree('settings'),'Annual degradation (%)').props.onChange({target:{value:'0.123456789012345678'}});h.render();
 await h.current.review();h.render();assert.equal(h.current.preview.sourceChanged,true);assert.equal(f.service.inputs.read('review-site').configuration.poaSourceId,null);
 await h.current.save('configuration');h.render();assert.equal(h.current.error,'');assert.equal(h.current.editing,false);assert.equal(h.current.configuration.irradianceChannelId,id);assert.equal(h.current.configuration.degradation,'0.123456789012345678');assert.equal(h.current.configuration.poaSourceId,null);
 await f.reopen();assert.deepEqual(f.service.inputs.read('review-site').configuration,h.current.configuration);
 h.current.edit();h.render();assert.equal(field(h.tree('settings'),'Uploaded POA series').props.value,id);assert.equal(field(h.tree('settings'),'Annual degradation (%)').props.value,'0.123456789012345678');
});

test('domain, chart and comparison fail closed on POA state even when legacy channel fields and numbers look selected',async t=>{
 const s=snapshot(),m=loadChartModel();s.telemetry.selectionRequired=false;s.telemetry.selectedChannelId='misleading-POA';s.telemetry.poa={state:'unavailable',selectedSourceId:null,candidates:[],reason:'Measured POA evidence unavailable: missing sensor window.'};
 s.calculated=calculatedRows(s.projections,s.utility,s.telemetry,s.capacity);
 for(const key of ['actualPerformanceRatio','performanceRatioRatio','insolationRatio','iapr','iar'])assert.equal(s.calculated['2026-01'][key].value,null);
 assert.notEqual(s.calculated['2026-01'].productionExpectedRatio.value,null);assert.notEqual(s.calculated['2026-01'].revenueRatio.value,null);
 const series=m.buildChartSeries(s,settings({metrics:['actualInsolation','iapr','utilityTotal']}));assert.equal(series[0].points[0].plotValue,null);assert.match(series[0].points[0].reason,/missing sensor window/);assert.notEqual(series[2].points[0].plotValue,null);
 s.siteId='review-site';const h=harness(async()=>Response.json(s));t.after(()=>h.dispose());h.render();await h.flush();h.render();
 const html=renderToStaticMarkup(h.tree('comparison'));assert.match(html,/missing sensor window/);assert.match(html,/uploaded POA interval energy/);assert.doesNotMatch(html,/satellite-first with selected POA gap filling/);
});
