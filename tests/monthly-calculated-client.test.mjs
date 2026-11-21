import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {harness,nodes} from './monthly-client-fixture.mjs';
import {emptyConfiguration,calculatedRows} from '../app/monthly-domain.mjs';
const oracle=JSON.parse(readFileSync(new URL('./monthly-calculated-oracle.json',import.meta.url),'utf8'));
const labels=['Budgeted specific yield','Actual specific yield','Actual / budgeted specific yield','Budgeted performance ratio','Actual performance ratio','Actual / budgeted performance ratio','Actual / projected insolation','Utility actual production total / projected production','Utility actual production total / expected production','Utility actual revenue / budgeted revenue','IAPR','IAR'];
function snapshot(c=oracle.cases[0]){
 const metric=value=>({value,state:'complete',coveredMilliseconds:2678400000,partialIntervals:0,unknownQualityIntervals:0,negativeIntervals:0});
 const s={siteId:'review-site',revision:1,configuration:{...emptyConfiguration(),operationsStart:'2026-01-01',degradation:'0'},utility:{[c.month]:c.utility},projections:[c.projection],capacity:{dcKwp:c.capacity,unavailableReason:null},telemetry:{state:'current',sourceRevision:1,timezone:'UTC',selectedChannelId:'selected-irradiance',selectionRequired:false,expectedChannelId:'expected',expectedUnavailableReason:null,candidates:[],months:{[c.month]:{expected:metric(c.expected),insolation:{...metric(c.insolation),source:'Imported irradiance; satellite/POA provenance unknown'}}}}};
 s.calculated=calculatedRows(s.projections,s.utility,s.telemetry,s.capacity);return s;
}
async function rendered(t,s){const h=harness(async()=>Response.json(s));t.after(()=>h.dispose());h.render();await h.flush();h.render();return h;}
const cells=h=>nodes(h.tree('comparison')).filter(n=>n.type==='td'&&n.props['data-calculated-field']);

test('real comparison component renders twelve ordered read-only columns, complete labels/formulas, all exact display formats',async t=>{
 for(const c of [...oracle.cases,...oracle.combinedCases]){const h=await rendered(t,snapshot(c)),tree=h.tree('comparison'),html=renderToStaticMarkup(tree),computed=cells(h);
  assert.deepEqual(computed.map(n=>n.props['data-calculated-field']),oracle.keys);
  for(const [i,cell] of computed.entries())assert.match(renderToStaticMarkup(cell).replaceAll(',',''),new RegExp(`<span[^>]*>${c.formatted[oracle.keys[i]].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}</span>`),oracle.keys[i]);
  const headers=nodes(tree).filter(n=>n.type==='th'&&n.props['data-calculated-field']);assert.equal(headers.length,12);
  for(const [i,header] of headers.entries()){assert.equal(header.props.scope,'col');assert.ok(header.props.title.includes(' / '));assert.match(renderToStaticMarkup(header),new RegExp(labels[i]));assert.ok(nodes(header).some(n=>n.props?.tabIndex===0&&n.props['aria-label']?.includes(header.props.title)));}
  assert.ok(!nodes(tree).some(n=>n.type==='input'||n.type==='select'),'comparison is read-only');
  assert.match(html,/kWh\/kWp/);assert.match(html,/POA/);assert.match(html,/1 kW\/m²/);assert.match(html,/provenance unknown/);assert.match(html,/utility.*total/i);
  assert.ok(nodes(tree).some(n=>n.props?.className?.includes('comparison-scroll')&&n.props.tabIndex===0));
 }
});

test('real cells visibly mark partial/missing reasons; browser refresh/failure suppresses stale telemetry-derived figures only',async t=>{
 const s=snapshot();s.telemetry.months['2026-01'].insolation.state='partial';s.telemetry.months['2026-01'].insolation.unknownQualityIntervals=1;
 s.capacity={dcKwp:null,unavailableReason:'DC capacity is unavailable: missing module wattage.'};s.calculated=calculatedRows(s.projections,s.utility,s.telemetry,s.capacity);
 const h=await rendered(t,s);let computed=cells(h);const byKey=key=>renderToStaticMarkup(computed.find(n=>n.props['data-calculated-field']===key));
 assert.match(byKey('actualSpecificYield'),/—/);assert.match(byKey('actualSpecificYield'),/missing module wattage/);
 assert.match(byKey('iapr'),/partial/);assert.match(byKey('iapr'),/quality unknown/);assert.match(byKey('iapr'),/120%/);
 for(const [property,value,reason] of [['refreshing',true,/refreshing/i],['error','Synthetic reload failure',/freshness/i]]){
  h.state[property]=value;h.render();computed=cells(h);assert.match(byKey('iapr'),/—/);assert.match(byKey('iapr'),reason);assert.doesNotMatch(byKey('iapr'),/120%/);
  assert.match(byKey('revenueRatio'),/120%/);h.state[property]=property==='refreshing'?false:'';h.render();
 }
});
