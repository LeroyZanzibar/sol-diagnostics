import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {loadSource} from './source-module.mjs';
import * as domain from '../app/monthly-domain.mjs';
import {harness,props,nodes,html,button,field,event,settings,snapshot,settle} from './monthly-charts-ui-fixture.mjs';


const selected=h=>nodes(h.tree).filter(n=>n.type==='input'&&n.props['data-metric-id']&&n.props.checked).map(n=>n.props['data-metric-id']);
async function mount(t,options={},p=props){const h=harness(options);t.after(()=>h.dispose());h.render(p);await h.flush();return h;}
function change(h,label,value){const input=field(h.tree,label);assert.ok(input,`Input ${label}`);input.props.onChange(event(value));h.render();}
function click(h,label){const b=button(h.tree,label);assert.ok(b,`Button ${label}`);const result=b.props.onClick(event());h.render();return result;}
const view={id:'saved-ui-view',name:'Revenue review',settings:{...settings,type:'bar',comparisonYears:2,metrics:['revenue','budgetRevenue']},createdAt:'2026-11-23T12:00:00Z'};
function saveForm(h,name){click(h,'Save current view');change(h,'View name',name);return nodes(h.tree).find(n=>n.type==='form');}

test('compact real UI has immediate controls, real sites, closed native views and no duplicate app navigation',async t=>{
 const h=await mount(t);assert.match(html(h.tree),/Monthly charts/);assert.equal(field(h.tree,'Chart site').props.value,'site');
 assert.deepEqual(['Overview','Production','Revenue','Performance','12M','24M','YTD','All','Line','Bar','Table','Timeline','YoY'].map(label=>Boolean(button(h.tree,label))),Array(13).fill(true));
 assert.equal(nodes(h.tree).find(n=>n.type==='details'&&n.props['data-my-views']).props.open,undefined);
 assert.equal(nodes(h.tree).some(n=>n.type==='aside'||n.type==='nav'),false);assert.equal(button(h.tree,'Apply'),undefined);
 assert.match(html(h.tree),/app profile/i);assert.doesNotMatch(html(h.tree),/session-only|sample site.*East/i);
});

test('presets change only metrics, selector groups/search/clear/chips change rendered data immediately',async t=>{
 const h=await mount(t);change(h,'From month','2026-01');change(h,'To month','2026-03');click(h,'Bar');click(h,'YoY');click(h,'Second prior year');
 click(h,'Revenue');assert.deepEqual(selected(h),['revenue','budgetRevenue']);assert.equal(field(h.tree,'From month').props.value,'2026-01');assert.equal(field(h.tree,'To month').props.value,'2026-03');
 assert.equal(button(h.tree,'Bar').props['aria-pressed'],true);assert.equal(button(h.tree,'Second prior year').props['aria-pressed'],true);
 assert.ok(nodes(h.tree).some(n=>n.type==='rect'&&n.props['data-value']<0));
 change(h,'Search metrics','insolation');assert.equal(nodes(h.tree).some(n=>n.type==='input'&&n.props['data-metric-id']==='revenue'),false);
 click(h,'Select all');change(h,'Search metrics','');assert.equal(selected(h).length,24);click(h,'Clear');assert.match(html(h.tree),/Choose at least one metric/i);assert.equal(nodes(h.tree).some(n=>n.type==='svg'),false);
 click(h,'Overview');click(h,'Remove Actual insolation');assert.equal(selected(h).includes('actualInsolation'),false);
});

test('default observed range initializes once per site; polls never undo explicit dates; YTD and All differ',async t=>{
 const h=await mount(t);assert.equal(field(h.tree,'To month').props.value,'2026-03');change(h,'From month','2025-02');change(h,'To month','2026-02');
 h.data.snapshot={...snapshot(),revision:2};h.render();await h.flush();assert.equal(field(h.tree,'From month').props.value,'2025-02');assert.equal(field(h.tree,'To month').props.value,'2026-02');
 click(h,'YTD');assert.equal(field(h.tree,'From month').props.value,'2026-01');assert.equal(field(h.tree,'To month').props.value,'2026-11');
 click(h,'All');assert.equal(field(h.tree,'From month').props.value,'2025-01');assert.equal(field(h.tree,'To month').props.value,'2049-12');
 click(h,'Revenue');h.data.snapshot=snapshot('other');h.render({...props,siteId:'other'});await h.flush();assert.equal(field(h.tree,'To month').props.value,'2026-03');assert.deepEqual(selected(h),['revenue','budgetRevenue']);
});

test('invalid ranges, no metrics, initial loading, no-site and errors do not show misleading plots',async t=>{
 const h=await mount(t);change(h,'From month','2027-01');assert.match(html(h.tree),/start|from|range/i);assert.equal(nodes(h.tree).some(n=>n.type==='svg'),false);
 change(h,'From month','');assert.equal(nodes(h.tree).some(n=>n.type==='svg'),false);
 const loading=await mount(t,{data:{snapshot:null,refreshing:true,error:'',reload:async()=>{}}});assert.match(html(loading.tree),/Loading saved monthly data/);
 loading.data.error='Synthetic read failed';loading.data.refreshing=false;loading.render();assert.match(html(loading.tree),/Synthetic read failed/);assert.ok(button(loading.tree,'Retry'));
 const empty=await mount(t,{}, {...props,sites:[],siteId:''});assert.match(html(empty.tree),/No sites|Choose a site/);assert.equal(nodes(empty.tree).some(n=>n.type==='svg'),false);
});

test('saved view restoration preserves current site, closes menu, and edits mark recalled setup modified',async t=>{
 const changes=[],h=await mount(t,{fetch:async()=>Response.json({views:[view]})},{...props,onSiteChange:id=>changes.push(id)});
 const restore=nodes(h.tree).find(n=>n.props?.['data-view-entry']===view.id);assert.ok(restore);restore.props.onClick();h.render();await h.flush();
 assert.deepEqual(selected(h),['revenue','budgetRevenue']);assert.equal(field(h.tree,'From month').props.value,'2026-01');assert.equal(field(h.tree,'Chart site').props.value,'site');assert.deepEqual(changes,[]);assert.equal(button(h.tree,'Bar').props['aria-pressed'],true);
 assert.match(html(h.tree),/Revenue review/);click(h,'Line');assert.match(html(h.tree),/Revenue review \(modified\)/);
 h.data.snapshot={...snapshot(),revision:2};h.render();await h.flush();assert.equal(field(h.tree,'From month').props.value,'2026-01');
});

test('save validates blank/duplicate names; single-flight POST requires exact GET readback before success',async t=>{
 let release,posted;const calls=[];
 const h=await mount(t,{fetch:async(url,o={})=>{calls.push([url,o]);if(o.method==='POST'){posted=JSON.parse(o.body);return new Promise(resolve=>{release=resolve;});}return Response.json({views:posted?[view,{id:'new-ui-view',...posted,createdAt:view.createdAt}]:[view]});}});
 let form=saveForm(h,'  ');await form.props.onSubmit(event());h.render();assert.match(html(h.tree),/name/i);assert.equal(calls.filter(c=>c[1].method==='POST').length,0);
 change(h,'View name',' revenue REVIEW ');form=nodes(h.tree).find(n=>n.type==='form');await form.props.onSubmit(event());h.render();assert.match(html(h.tree),/already exists|already.*name/i);assert.equal(calls.filter(c=>c[1].method==='POST').length,0);
 change(h,'View name','New setup');form=nodes(h.tree).find(n=>n.type==='form');const action=form.props.onSubmit(event());form.props.onSubmit(event());await settle();h.render();
 assert.equal(calls.filter(c=>c[1].method==='POST').length,1);assert.equal(field(h.tree,'View name').props.disabled,true);assert.doesNotMatch(html(h.tree),/Saved “New setup”/);
 assert.deepEqual(Object.keys(posted).sort(),['name','settings']);assert.deepEqual(Object.keys(posted.settings).sort(),['comparisonYears','end','metrics','start','type']);
 release(Response.json({view:{id:'new-ui-view',...posted,createdAt:view.createdAt}},{status:201}));await action;await h.flush();
 assert.equal(calls.at(-1)[1].method,'GET');assert.equal(calls.at(-1)[1].cache,'no-store');assert.match(html(h.tree),/Saved.*New setup/);
});

test('acknowledged save with mismatched readback never claims success or repeats POST',async t=>{
 let posted;const calls=[];
 const h=await mount(t,{fetch:async(url,o={})=>{calls.push([url,o]);if(o.method==='POST'){posted=JSON.parse(o.body);return Response.json({view:{id:'new-ui-view',...posted,createdAt:view.createdAt}},{status:201});}return Response.json({views:posted?[{id:'wrong-id',...posted,createdAt:view.createdAt}]:[]});}});
 const form=saveForm(h,'Unverified setup');await form.props.onSubmit(event());h.render();assert.match(html(h.tree),/verif|readback/i);assert.doesNotMatch(html(h.tree),/Saved “Unverified setup”/);assert.equal(calls.filter(c=>c[1].method==='POST').length,1);
});

test('real SVG/table use model points: null path breaks, zero/negative grouped bars, percent beyond 100 and two-axis grouping',async t=>{
 const h=await mount(t,{plotOnly:true},{series:[],type:'line'});const selectedSettings={...settings,metrics:['utilityTotal','revenue'],comparisonYears:1};const series=h.model.buildChartSeries(snapshot(),selectedSettings,{refreshing:false,error:''});
 h.render({series,type:'line'});await h.flush();const paths=nodes(h.tree).filter(n=>n.type==='path'&&n.props['data-series']);const utility=paths.find(n=>n.props['data-series']==='utilityTotal:0');assert.equal((utility.props.d.match(/M/g)||[]).length,2);assert.equal(nodes(h.tree).filter(n=>n.type==='svg').length,1);assert.match(html(h.tree),/kWh/);assert.match(html(h.tree),/\$/);
 h.render({series,type:'bar'});const negative=nodes(h.tree).find(n=>n.type==='rect'&&n.props['data-value']===-12);assert.ok(negative);assert.ok(negative.props.height>0);assert.ok(nodes(h.tree).some(n=>n.type==='line'&&n.props['data-value']===0));
 const bars=nodes(h.tree).filter(n=>n.type==='rect'&&n.props['data-anchor']==='2026-01');assert.equal(new Set(bars.map(n=>n.props.x)).size,bars.length,'bars are grouped, not stacked');
 h.render({series,type:'table'});assert.match(html(h.tree),/Jan 2025/);for(const s of series)for(const point of s.points)assert.ok(html(h.tree).includes(point.display.replaceAll('&','&amp;')));
 const performance=h.model.buildChartSeries(snapshot(),{...settings,metrics:['productionProjectionRatio']});h.render({series:performance,type:'line'});assert.ok(nodes(h.tree).some(n=>n.props?.['data-axis-value']>100));
 const three=h.model.buildChartSeries(snapshot(),{...settings,metrics:['utilityTotal','revenue','actualInsolation']});h.render({series:three,type:'line'});assert.equal(nodes(h.tree).filter(n=>n.type==='svg').length,3);
});

const monthPopup = h => nodes(h.tree).find(n=>n.props?.['data-month-details']!==undefined);
const visibleText = tree => html(tree).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
function hoverMonth(h,index=0){nodes(h.tree).find(n=>n.props?.['data-chart-hit']===`0:${index}`).props.onPointerMove({pointerType:'mouse'});h.render();}
function assertCompactPopup(h,series,index=0){
 const popup=monthPopup(h);assert.ok(popup,'hover popup remains open');
 const items=nodes(popup).filter(n=>n.props?.className==='mc-detail-item');assert.equal(items.length,series.length);
 items.forEach((item,i)=>{
   const s=series[i],point=s.points[index];
   assert.equal(visibleText(nodes(item).find(n=>n.type==='strong')),s.label);
   const unit=s.metric.unit==='%'&&point.display.endsWith('%')?'':s.metric.unit;
   assert.equal(visibleText(nodes(item).find(n=>n.props?.className==='mc-detail-value')),`${point.display} ${unit}`.trim());
   assert.ok(visibleText(item).includes(`Source month: ${h.model.formatChartMonth(point.sourceMonth)}`));
 });
 assert.equal(nodes(popup).some(n=>n.props?.className==='mc-provenance'),false,'hover must not expose other metrics through provenance');
 assert.doesNotMatch(visibleText(popup),/Monthly input revision|Saved projection:|On-peak production:|Off-peak production:|Invoice energy used cost:/);
}

test('mouse hover shows only the selected metric, not other utility values in its provenance',async t=>{
 const h=await mount(t,{plotOnly:true},{series:[],type:'line'}),series=h.model.buildChartSeries(snapshot(),{...settings,metrics:['utilityTotal']});
 assert.ok(series[0].points[0].details.includes('Utility revenue: -12 $.'),'real model fixture contains the unselected revenue');
 for(const type of ['line','bar']){
   h.render({series,type});hoverMonth(h);assertCompactPopup(h,series);
   assert.match(visibleText(monthPopup(h)),/10 kWh/);assert.doesNotMatch(visibleText(monthPopup(h)),/Utility revenue|-12/);
 }
});

test('mouse hover retains multiple selected values, units and only enabled YoY source months',async t=>{
 const h=await mount(t,{plotOnly:true},{series:[],type:'line'});
 for(const comparisonYears of [1,2]){
   const series=h.model.buildChartSeries(snapshot(),{...settings,metrics:['utilityTotal','revenue','productionProjectionRatio'],comparisonYears});
   assert.ok(series.some(s=>s.points[0].details.some(detail=>detail.startsWith('Saved projection:'))));
   h.render({series,type:'line'});hoverMonth(h);assertCompactPopup(h,series);
   const text=visibleText(monthPopup(h));assert.match(text,/-12 \$/);assert.match(text,/111%/);assert.match(text,/Jan 2025/);
   if(comparisonYears===1)assert.doesNotMatch(text,/Jan 2024|2 years prior/);else assert.match(text,/Jan 2024/);
   assert.doesNotMatch(text,/%\s+%/);
 }
});

test('open mouse hover follows metric and comparison selection updates immediately',async t=>{
 const h=await mount(t,{plotOnly:true},{series:[],type:'line'});
 h.render({series:h.model.buildChartSeries(snapshot(),settings),type:'line'});hoverMonth(h);
 // Keep the plot instance open while its selected-series props change. The parent
 // UI also remounts on settings changes; that existing dismissal is unchanged.
 for(const selection of [
   {metrics:['utilityTotal'],comparisonYears:0},
   {metrics:['revenue','budgetRevenue'],comparisonYears:1},
   {metrics:['budgetRevenue'],comparisonYears:0},
 ]){
   const series=h.model.buildChartSeries(snapshot(),{...settings,...selection});
   h.render({series,type:'line'});assertCompactPopup(h,series);
 }
 assert.doesNotMatch(visibleText(monthPopup(h)),/Utility revenue|Utility actual production total|Actual insolation|year prior/);
 h.render({series:[],type:'line'});assert.equal(monthPopup(h),undefined);
});

test('explicit pin, keyboard focus and table retain full source details for a selected metric',async t=>{
 const h=await mount(t,{plotOnly:true},{series:[],type:'line'}),series=h.model.buildChartSeries(snapshot(),{...settings,metrics:['utilityTotal']});
 h.render({series,type:'line'});hoverMonth(h);
 let hit=nodes(h.tree).find(n=>n.props?.['data-chart-hit']==='0:0'),dom=[...h.dom.values()].find(n=>n.props?.['data-chart-hit']==='0:0');
 hit.props.onClick({currentTarget:dom});h.render();assert.match(visibleText(monthPopup(h)),/Utility revenue: -12 \$/);
 hoverMonth(h,1);assert.match(visibleText(monthPopup(h)),/pinned details/);assert.match(visibleText(monthPopup(h)),/Utility revenue: -12 \$/);
 click(h,'Dismiss month details');hit=nodes(h.tree).find(n=>n.props?.['data-chart-hit']==='0:0');hit.props.onFocus({currentTarget:dom});h.render();assert.match(visibleText(monthPopup(h)),/Utility revenue: -12 \$/);
 h.render({series,type:'table'});const details=nodes(h.tree).filter(n=>n.type==='details'&&n.props.className==='mc-cell-details');assert.ok(details.length);assert.match(visibleText(details[0]),/Source details.*Utility revenue: -12 \$/);
});

test('month details expose source/quality and support focus, arrows, touch pinning and dismissal',async t=>{
 const h=await mount(t,{plotOnly:true},{series:[],type:'line'});const series=h.model.buildChartSeries(snapshot(),{...settings,metrics:['actualInsolation'],comparisonYears:1});h.render({series,type:'line'});await h.flush();
 let hit=nodes(h.tree).find(n=>n.props?.['data-chart-hit']==='0:0');assert.equal(hit.props.tabIndex,0);const dom=[...h.dom.values()].find(n=>n.props?.['data-chart-hit']==='0:0');
 hit.props.onFocus({currentTarget:dom});h.render();assert.match(html(h.tree),/Measured POA/);assert.match(html(h.tree),/partial/i);assert.match(html(h.tree),/Jan 2025/);
 hit=nodes(h.tree).find(n=>n.props?.['data-chart-hit']==='0:0');hit.props.onKeyDown({...event(),key:'ArrowRight',currentTarget:dom});h.render();assert.equal(h.document.activeElement.props['data-chart-hit'],'0:1');
 hit=nodes(h.tree).find(n=>n.props?.['data-chart-hit']==='0:0');hit.props.onClick({currentTarget:dom});h.render();assert.ok(button(h.tree,'Dismiss month details'));click(h,'Dismiss month details');assert.equal(nodes(h.tree).some(n=>n.props?.['data-month-details']),false);
});

test('first-touch initiation suppresses compatibility focus until a completed click without blocking mouse or keyboard focus',async t=>{
 const h=await mount(t,{plotOnly:true},{series:[],type:'line'}),series=h.model.buildChartSeries(snapshot(),settings);h.render({series,type:'line'});await h.flush();
 const hit=nodes(h.tree).find(n=>n.props?.['data-chart-hit']==='0:0'),dom=[...h.dom.values()].find(n=>n.props?.['data-chart-hit']==='0:0');
 let touchCancelled=false;hit.props.onPointerDown?.({pointerType:'touch',preventDefault(){touchCancelled=true;}});
 assert.equal(touchCancelled,true,'first touch must not focus/open an overlay before its click');
 assert.equal(nodes(h.tree).some(n=>n.props?.['data-month-details']!==undefined),false,'pointerdown alone is not a completed tap or a pin');
 let mouseCancelled=false;hit.props.onPointerDown?.({pointerType:'mouse',preventDefault(){mouseCancelled=true;}});assert.equal(mouseCancelled,false);
 hit.props.onClick({currentTarget:dom});h.render();assert.equal(nodes(h.tree).find(n=>n.props?.['data-chart-hit']==='0:0').props['aria-pressed'],true);assert.match(html(h.tree),/pinned details/);
 click(h,'Dismiss month details');assert.equal(nodes(h.tree).some(n=>n.props?.['data-month-details']!==undefined),false);
 nodes(h.tree).find(n=>n.props?.['data-chart-hit']==='0:0').props.onFocus({currentTarget:dom});h.render();assert.ok(nodes(h.tree).some(n=>n.props?.['data-month-details']!==undefined),'keyboard focus still exposes details');
});

test('native My views arrows reach entries, Escape restores summary focus, outside pointer dismisses without focus theft',async t=>{
 const second={...view,id:'second-ui-view',name:'Other view'},h=await mount(t,{fetch:async()=>Response.json({views:[view,second]})});
 const popup=nodes(h.tree).find(n=>n.props?.['data-my-views']),element=[...h.dom.values()].find(n=>n.props?.['data-my-views']!==undefined),summary=element.querySelector('summary');
 popup.props.onKeyDown({...event(),key:'ArrowDown',target:summary});assert.equal(element.open,true);assert.equal(h.document.activeElement.props['data-view-entry'],view.id);
 popup.props.onKeyDown({...event(),key:'ArrowDown',target:h.document.activeElement});assert.equal(h.document.activeElement.props['data-view-entry'],second.id);
 popup.props.onKeyDown({...event(),key:'Escape',target:h.document.activeElement});assert.equal(element.open,false);assert.equal(h.document.activeElement,summary);
 element.open=true;h.listeners.get('pointerdown')({target:element.querySelectorAll('[data-view-entry]')[0]});assert.equal(element.open,true,'inside pointer is not an outside dismissal');
 const elsewhere={};h.document.activeElement=elsewhere;h.listeners.get('pointerdown')({target:elsewhere});assert.equal(element.open,false);assert.equal(h.document.activeElement,elsewhere);
});

test('hover and focus details have real IDs, survive pointer entry, and Escape dismisses anywhere',async t=>{
 const h=await mount(t,{plotOnly:true},{series:[],type:'line'}),series=h.model.buildChartSeries(snapshot(),settings);h.render({series,type:'line'});await h.flush();
 const hit=nodes(h.tree).find(n=>n.props?.['data-chart-hit']==='0:0');hit.props.onPointerMove({pointerType:'mouse'});h.render();await h.flush();
 const details=nodes(h.tree).find(n=>n.props?.['data-month-details']!==undefined),current=nodes(h.tree).find(n=>n.props?.['data-chart-hit']==='0:0');assert.ok(details.props.id);assert.equal(current.props['aria-describedby'],details.props.id);assert.equal(details.props.role,'region');
 const wrapper=nodes(h.tree).find(n=>n.props?.className==='mc-chart-result');assert.equal(details.props.onPointerLeave,undefined,'detail contents do not dismiss themselves');
 h.listeners.get('keydown')({key:'Escape'});h.render();assert.equal(nodes(h.tree).some(n=>n.props?.['data-month-details']!==undefined),false);
 current.props.onFocus({currentTarget:[...h.dom.values()].find(n=>n.props?.['data-chart-hit']==='0:0')});h.render();assert.equal(wrapper.props.onPointerLeave,undefined,'moving through any gap into the detail region does not dismiss it');assert.ok(nodes(h.tree).some(n=>n.props?.['data-month-details']!==undefined));
});

test('an acknowledged but unverified save retries GET only and preserves edits made while the save was pending',async t=>{
 let release,posted,verify=false;const calls=[];
 const h=await mount(t,{fetch:async(url,o={})=>{calls.push([url,o]);if(o.method==='POST'){posted=JSON.parse(o.body);return new Promise(resolve=>{release=resolve;});}return Response.json({views:verify?[{id:'new-ui-view',...posted,createdAt:view.createdAt}]:[]});}});
 const form=saveForm(h,'Pending setup'),action=form.props.onSubmit(event());await settle();click(h,'Revenue');
 release(Response.json({view:{id:'new-ui-view',...posted,createdAt:view.createdAt}},{status:201}));await action;h.render();assert.ok(button(h.tree,'Retry verification'));assert.deepEqual(selected(h),['revenue','budgetRevenue']);
 verify=true;click(h,'Retry verification');await h.flush();assert.equal(calls.filter(c=>c[1].method==='POST').length,1);assert.match(html(h.tree),/Saved.*Pending setup/);assert.match(html(h.tree),/Pending setup \(modified\)/);assert.deepEqual(selected(h),['revenue','budgetRevenue']);
});

test('GET and 409 errors are visible, and invalid/empty current setups never POST',async t=>{
 const calls=[];let failRead=true;
 const h=await mount(t,{fetch:async(url,o={})=>{calls.push([url,o]);if(o.method==='POST')return Response.json({error:'A view with that name already exists.'},{status:409});if(failRead)return new Response('Unauthorized',{status:401});return Response.json({views:[]});}});
 assert.match(html(h.tree),/401/);failRead=false;click(h,'Retry views');await h.flush();
 const form=saveForm(h,'Server duplicate');await form.props.onSubmit(event());h.render();assert.match(html(h.tree),/already exists/);
 change(h,'View name','Empty setup');click(h,'Clear');await nodes(h.tree).find(n=>n.type==='form').props.onSubmit(event());h.render();assert.match(html(h.tree),/at least one|current chart/i);assert.equal(calls.filter(c=>c[1].method==='POST').length,1);
 click(h,'Overview');change(h,'From month','2027-01');await nodes(h.tree).find(n=>n.type==='form').props.onSubmit(event());h.render();assert.equal(calls.filter(c=>c[1].method==='POST').length,1);
});

test('24M clips to the legal 1900 boundary instead of producing an invalid shortcut',async t=>{
 const s=snapshot();s.utility={'1900-01':s.utility['2026-01']};s.telemetry.months={};s.projections=[];s.calculated={};
 const h=await mount(t,{data:{snapshot:s,refreshing:false,error:'',reload:async()=>{}}});click(h,'24M');assert.equal(field(h.tree,'From month').props.value,'1900-01');assert.equal(field(h.tree,'To month').props.value,'1900-01');assert.equal(field(h.tree,'From month').props['aria-invalid'],false);
});

test('domain percentages are not suffixed twice in table or accessible point labels',async t=>{
 const h=await mount(t,{plotOnly:true},{series:[],type:'line'}),series=h.model.buildChartSeries(snapshot(),{...settings,metrics:['productionProjectionRatio']});
 h.render({series,type:'table'});assert.doesNotMatch(html(h.tree).replace(/<[^>]*>/g,' ').replace(/\s+/g,' '),/%\s+%/);
 h.render({series,type:'line'});assert.doesNotMatch(html(h.tree).replace(/<[^>]*>/g,' ').replace(/\s+/g,' '),/%\s+%/);
});

test('real React server rendering exercises native hooks and renderer without the scheduling harness',()=>{
 const model=loadSource('app/monthly-chart-model.ts',[],{...domain,Error,TypeError,RangeError});
 const plot=loadSource('app/MonthlyChartPlot.tsx',[],{React,...React,...model});
 const series=model.buildChartSeries(snapshot(),{...settings,metrics:['utilityTotal','revenue'],comparisonYears:2});
 for(const type of ['line','bar','table']){
   const output=html(React.createElement(plot.default,{series,type}));assert.match(output,type==='table'?/<table/:/<svg/);assert.match(output,/Source|source/);assert.doesNotMatch(output,/NaN|Infinity/);
 }
 const ui=loadSource('app/MonthlyCharts.tsx',[],{React,...React,...model,MonthlyChartPlot:plot.default,chartSeriesColor:plot.chartSeriesColor,useMonthlyChartData:()=>({snapshot:null,refreshing:true,error:'',reload:async()=>{}})});
 assert.match(html(React.createElement(ui.default,props)),/Loading saved monthly data/);
});
