import test from 'node:test';
import assert from 'node:assert/strict';
import {monthlyFixture} from './monthly-fixture.mjs';
import {seedMonthlyLossRun,saveLossReview,lossRequest} from './monthly-confirmed-loss-fixture.mjs';
import {loadChartModel,plain} from '../monthly-chart-model-fixture.mjs';
import {harness,props,nodes,field,button,html} from '../monthly-charts-ui-fixture.mjs';

test('built HTTP accepts confirmed-loss saved metric, reopens it in UI, and charts authoritative reviewed publication',{timeout:180000},async t=>{
 const f=await monthlyFixture(t);await seedMonthlyLossRun(f);await seedMonthlyLossRun(f,{runId:'history-not-published',publish:false});await f.start();
 await saveLossReview(f,'monthly-current','january','Confirmed');await saveLossReview(f,'monthly-current','boundary','Confirmed');
 const get=()=>lossRequest(f,`/api/monthly-data?siteId=${f.siteId}`),model=loadChartModel();
 const settings={start:'2026-01',end:'2026-05',type:'table',comparisonYears:2,metrics:['confirmedLoss']};
 const snapshot=await get(),points=model.buildChartSeries(snapshot,settings)[0].points;
 assert.equal(snapshot.confirmedLoss.analysisRunId,'monthly-current');assert.deepEqual(plain(points[0].raw),{n:'267',d:'2'});assert.equal(points[0].display,'134');assert.equal(points[1].plotValue,30.25);assert.equal(points[2].plotValue,0);assert.equal(points[4].plotValue,null);
 const {view}=await lossRequest(f,'/api/chart-views',{body:{name:'Confirmed loss HTTP',settings},status:201});assert.deepEqual(view.settings,settings);
 assert.deepEqual((await lossRequest(f,'/api/chart-views')).views,[view]);
 await lossRequest(f,'/api/chart-views',{body:{name:'Reject invented source',settings:{...settings,metrics:['confirmedLossHistorical']}},status:400});
 const bytes=f.inspect(db=>db.prepare('SELECT settings_json FROM chart_views WHERE id=?').get(view.id).settings_json);
 await f.stop();await f.start();assert.deepEqual((await lossRequest(f,'/api/chart-views')).views,[view]);assert.equal(f.inspect(db=>db.prepare('SELECT settings_json FROM chart_views WHERE id=?').get(view.id).settings_json),bytes);
 const h=harness({realData:true,fetch:(url,options={})=>fetch(f.base+url,{...options,headers:{...options.headers,Authorization:f.authorization}})});t.after(()=>h.dispose());
 h.render({...props,siteId:f.siteId,sites:[{id:f.siteId,name:'Synthetic published loss',location:''}]});
 for(let i=0;i<100;i++){await h.flush();if(nodes(h.tree).some(n=>n.props?.['data-view-entry']===view.id)&&h.components.some(n=>n.props?.series))break;await new Promise(resolve=>setTimeout(resolve,20));}
 assert.ok(nodes(h.tree).some(n=>n.props?.['data-view-entry']===view.id),html(h.tree));
 nodes(h.tree).find(n=>n.props?.['data-view-entry']===view.id).props.onClick();h.render();await h.flush();assert.equal(field(h.tree,'Confirmed estimated loss').props.checked,true);assert.equal(button(h.tree,'Table').props['aria-pressed'],true);assert.equal(field(h.tree,'Chart site').props.value,f.siteId);assert.match(html(h.tree),/134/);assert.match(html(h.tree),/monthly-current/);
 await saveLossReview(f,'monthly-current','unknown','Confirmed');const unknown=model.buildChartSeries(await get(),settings)[0].points[1];assert.equal(unknown.plotValue,null);assert.match(unknown.reason,/unknown|unavailable|quantif/i);
 console.log('Confirmed-loss chart HTTP fixture:',f.directory);
});
