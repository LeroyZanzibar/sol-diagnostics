import test from 'node:test';
import assert from 'node:assert/strict';
import {loadChartModel, snapshot, settings, plain, freezeDeep} from './monthly-chart-model-fixture.mjs';
import {harness, props, nodes, html, button, field, event} from './monthly-charts-ui-fixture.mjs';

const metric=(value, extra={})=>({value,state:'complete',unconfirmedCount:2,unknownCount:0,reason:null,...extra});
function populated(siteId='site') {
 const s=snapshot(undefined,siteId);
 s.unconfirmedLoss={state:'current',analysisRunId:'published-only',timezone:'America/New_York',reason:null,months:{
  '2024-01':metric({n:'17',d:'2'}),'2025-01':metric({n:'41',d:'4'}),
  '2026-01':metric({n:'267',d:'2'}),'2026-02':metric({n:'0',d:'1'},{unconfirmedCount:0}),
  '2026-03':metric(null,{state:'partial',unknownCount:1,reason:'One Unconfirmed finding has unknown loss.'}),
 }};return s;
}
const setup=overrides=>settings({metrics:['unconfirmedLoss'],end:'2026-04',...overrides});
test('unconfirmed loss is a selectable kWh source adapter, with exact values, zero, unknown and uncovered gaps',()=>{
 const m=loadChartModel(),s=freezeDeep(populated()),before=JSON.stringify(s);
 const definition=m.chartMetrics.find(x=>x.id==='unconfirmedLoss');assert.ok(definition);assert.equal(definition.label,'Unconfirmed estimated loss');assert.equal(definition.unit,'kWh');assert.equal(definition.group,'Production');assert.equal(definition.telemetry,false);
 const [series]=m.buildChartSeries(s,setup());const [value,zero,unknown,outside]=series.points;
 assert.deepEqual(plain(value.raw),{n:'267',d:'2'});assert.equal(value.plotValue,133.5);assert.equal(value.display,'134');assert.equal(value.state,'available');
 assert.equal(zero.plotValue,0);assert.equal(zero.display,'0');assert.equal(unknown.plotValue,null);assert.equal(unknown.display,'—');assert.match(unknown.reason,/unknown/);
 assert.equal(outside.plotValue,null);assert.match(outside.reason,/coverage/);
 assert.match(value.details.join(' '),/published-only/);assert.match(value.details.join(' '),/America\/New_York/);assert.match(value.details.join(' '),/2 Unconfirmed/);assert.match(unknown.details.join(' '),/1 unknown/);
 assert.doesNotMatch(value.details.join(' '),/POA|Expected Production channel|On-peak/);assert.equal(JSON.stringify(s),before);
 const comparisons=m.buildChartSeries(s,setup({comparisonYears:2}));assert.deepEqual(plain(comparisons.map(x=>x.points[0].sourceMonth)),['2026-01','2025-01','2024-01']);assert.deepEqual(plain(comparisons.map(x=>x.points[0].plotValue)),[133.5,10.25,8.5]);
});
test('loss-only months participate in All and numeric observed ranges without projecting unknown loss',async t=>{
 const m=loadChartModel(),s=populated();s.utility={};s.projections=[];s.telemetry.months={};s.calculated={};
 assert.deepEqual(plain(m.defaultRange(s,'2026-11')),{start:'2025-03',end:'2026-02'});
 s.unconfirmedLoss.state='unavailable';assert.equal(m.defaultRange(s,'2026-11').end,'2026-11');s.unconfirmedLoss.state='current';
 const h=harness({data:{snapshot:s,refreshing:false,error:'',reload:async()=>{}}});t.after(()=>h.dispose());h.render(props);await h.flush();button(h.tree,'All').props.onClick();h.render();assert.equal(field(h.tree,'From month').props.value,'2024-01');assert.equal(field(h.tree,'To month').props.value,'2026-03');
});
test('loss hover is selected-only and comparisons stay compact while pinned details preserve provenance',async t=>{
 const h=harness({plotOnly:true});t.after(()=>h.dispose());
 for(const type of ['line','bar']) for(const comparisonYears of [0,1,2]) {
  const series=h.model.buildChartSeries(populated(),setup({comparisonYears}));h.render({series,type});await h.flush();
  const hit=()=>nodes(h.tree).find(n=>n.props?.['data-chart-hit']==='0:0');hit().props.onPointerMove({pointerType:'mouse'});h.render();
  const popup=()=>nodes(h.tree).find(n=>n.props?.['data-month-details']!==undefined);
  assert.equal(nodes(popup()).filter(n=>n.props?.className==='mc-detail-item').length,comparisonYears+1);assert.match(html(popup()).replace(/<[^>]*>/g,''),/134 kWh/);assert.doesNotMatch(html(popup()),/published-only|America\/New_York|Utility revenue|On-peak|mc-provenance/);
  if(comparisonYears>0)assert.match(html(popup()),/Jan 2025/);else assert.doesNotMatch(html(popup()),/Jan 2025/);
  if(comparisonYears===2)assert.match(html(popup()),/Jan 2024/);else assert.doesNotMatch(html(popup()),/Jan 2024/);
  const dom=[...h.dom.values()].find(n=>n.props?.['data-chart-hit']==='0:0');hit().props.onClick({currentTarget:dom});h.render();assert.match(html(popup()),/published-only/);assert.match(html(popup()),/2 Unconfirmed/);
  button(h.tree,'Dismiss month details').props.onClick();h.render();
  h.render({series:[],type});await h.flush();
 }
});
test('publication availability and failed reads suppress retained numbers, independently of telemetry',()=>{
 const m=loadChartModel();
 for(const state of ['refreshing','missing','unavailable']) {const s=populated();s.unconfirmedLoss.state=state;s.unconfirmedLoss.reason=`Publication ${state}`;const p=m.buildChartSeries(s,setup())[0].points[0];assert.equal(p.plotValue,null);assert.equal(p.display,'—');assert.match(p.reason,new RegExp(state));}
 for(const read of [{refreshing:true,error:''},{refreshing:false,error:'Read failed'}]) {const p=m.buildChartSeries(populated(),setup(),read)[0].points[0];assert.equal(p.plotValue,null);assert.equal(p.display,'—');assert.equal(p.state,'stale');}
 const s=populated();s.telemetry.state='missing';assert.equal(m.buildChartSeries(s,setup())[0].points[0].plotValue,133.5);
 for(const value of [metric({n:'999',d:'1'},{state:'partial'}),metric({n:'999',d:'1'},{unknownCount:1}),metric({n:'999',d:'1'},{state:'missing'})]) {s.unconfirmedLoss.months['2026-01']=value;assert.equal(m.buildChartSeries(s,setup())[0].points[0].plotValue,null);}
 delete s.unconfirmedLoss;assert.equal(m.buildChartSeries(s,setup())[0].points[0].plotValue,null);
});
test('real chart controls render loss line/bar/table, compare periods and save/reopen without fetching on settings',async t=>{
 const saved=[];let reads=0;
 const options={realData:true,fetch:async(url,o={})=>{
  if(url.startsWith('/api/monthly-data?')){reads++;return Response.json(populated());}
  if(o.method==='POST'){const view={...JSON.parse(o.body),id:'saved-loss',createdAt:'2026-11-26T12:00:00.000Z'};saved.push(view);return Response.json({view},{status:201});}
  return Response.json({views:saved});
 }};
 const h=harness(options);t.after(()=>h.dispose());h.render(props);await h.flush();
 const click=label=>{const b=button(h.tree,label);assert.ok(b,label);b.props.onClick(event());h.render();};
 const change=(label,value)=>{field(h.tree,label).props.onChange(event(value));h.render();};
 click('Clear');field(h.tree,'Unconfirmed estimated loss').props.onChange(event());h.render();change('From month','2026-01');change('To month','2026-04');click('YoY');click('Second prior year');
 assert.ok(nodes(h.tree).some(n=>n.type==='path'&&n.props['data-series']==='unconfirmedLoss:0'));
 click('Bar');assert.ok(nodes(h.tree).some(n=>n.type==='rect'&&n.props['data-value']===133.5));assert.ok(nodes(h.tree).some(n=>n.type==='line'&&n.props['data-value']===0));
 click('Table');assert.match(html(h.tree),/134/);assert.match(html(h.tree),/published-only/);assert.match(html(h.tree),/unknown loss/);
 click('Save current view');change('View name','Ununconfirmed loss review');await nodes(h.tree).find(n=>n.type==='form').props.onSubmit(event());await h.flush();assert.equal(saved.length,1);assert.deepEqual(saved[0].settings,setup({type:'table',comparisonYears:2}));assert.match(html(h.tree),/Saved.*Ununconfirmed loss review/);assert.equal(reads,1);
 h.dispose();const reopened=harness(options);t.after(()=>reopened.dispose());reopened.render(props);await reopened.flush();nodes(reopened.tree).find(n=>n.props?.['data-view-entry']==='saved-loss').props.onClick();reopened.render();await reopened.flush();assert.equal(field(reopened.tree,'Unconfirmed estimated loss').props.checked,true);assert.equal(button(reopened.tree,'Table').props['aria-pressed'],true);assert.equal(field(reopened.tree,'Chart site').props.value,'site');assert.match(html(reopened.tree),/134/);assert.equal(reads,2);
});
