import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {fixture,harness,adapter,configured,field,nodes} from './monthly-client-fixture.mjs';
import {emptyConfiguration,utilityTotal} from '../app/monthly-domain.mjs';

function gate(){let release,enter;const held=new Promise(r=>release=r),reached=new Promise(r=>enter=r);return {release,reached,async wait(){enter();await held;}};}
async function editing(t,fetch){const h=harness(fetch);t.after(()=>h.dispose());h.render();await h.flush();h.render().edit();h.render();return h;}
function attemptEdits(h){
 field(h.tree('utility'),'2024-04 Off-peak production').props.onChange({target:{value:'456.875'}});
 field(h.tree('utility'),'2024-04 Unpaid energy').props.onChange({target:{value:'12.6250'}});
 field(h.tree('settings'),'Operations start date').props.onChange({target:{value:'2025-01-01'}});
 field(h.tree('settings'),'Annual degradation (%)').props.onChange({target:{value:'9'}});
 field(h.tree('baselines'),'Baseline 3 production').props.onChange({target:{value:'987.625'}});
 field(h.tree('baselines'),'Reporting irradiance channel').props.onChange({target:{value:'later-channel'}});
}
function assertDisabled(h){for(const mode of ['utility','settings','baselines']){
 const controls=nodes(h.tree(mode)).filter(n=>['input','select'].includes(n.type));assert.ok(controls.length);
 assert.ok(controls.every(n=>n.props.disabled===true),`${mode} fields must visibly disable while busy`);
}}

for(const stage of ['post','readback'])test(`SPEC-B1 utility ${stage}: committed checkpoint, blocked fields and synchronous guard`,{timeout:15000},async t=>{
 const f=fixture(t);configured(f);const hold=gate();let committed=false;
 const h=await editing(t,adapter(f,{afterCommit:async()=>{committed=true;if(stage==='post')await hold.wait();},afterRead:async()=>{if(committed&&stage==='readback')await hold.wait();}}));
 field(h.tree('utility'),'2024-03 On-peak production').props.onChange({target:{value:'123.125'}});h.render();await h.flush();
 const before=JSON.stringify({configuration:h.current.configuration,utility:h.current.utility});
 const pending=h.current.save('utility');t.after(async()=>{hold.release();await pending;});
 // Deliberately invoke stale rendered handlers before React can expose busy.
 attemptEdits(h);await hold.reached;
 assert.equal(f.service.inputs.read('review-site').utility['2024-03'].onPeak,'123.125');
 console.log(JSON.stringify({checkpoint:stage,committed:true,beforeRerender:true}));
 h.render();assert.equal(h.current.busy,true);
 assert.equal(JSON.stringify({configuration:h.current.configuration,utility:h.current.utility}),before,'Synchronous lock must reject stale input handlers before rerender');
 assertDisabled(h);attemptEdits(h);h.render();
 assert.equal(JSON.stringify({configuration:h.current.configuration,utility:h.current.utility}),before);
 assert.equal(h.module.confirmMonthlyNavigation(),false);h.current.cancel();h.render();assert.equal(h.current.editing,true);
 hold.release();await pending;h.render();assert.equal(h.current.editing,false);assert.match(h.current.notice,/Saved and verified/);
 assert.equal(f.service.inputs.read('review-site').utility['2024-04'],undefined);
 h.current.edit();h.render();assert.equal(field(h.tree('utility'),'2024-04 Off-peak production').props.disabled,false);
 field(h.tree('utility'),'2024-04 Off-peak production').props.onChange({target:{value:'456.875'}});h.render();assert.equal(h.current.utility['2024-04'].offPeak,'456.875');
});

for(const stage of ['review','post','readback'])test(`SPEC-B1 configuration ${stage}: baseline/settings/source lock and recovery`,{timeout:15000},async t=>{
 const f=fixture(t);configured(f);const hold=gate();let committed=false;
 const h=await editing(t,adapter(f,{afterPreview:async()=>{if(stage==='review')await hold.wait();},afterCommit:async()=>{committed=true;if(stage==='post')await hold.wait();},afterRead:async()=>{if(committed&&stage==='readback')await hold.wait();}}));
 field(h.tree('baselines'),'Baseline 3 production').props.onChange({target:{value:'123.125'}});h.render();
 if(stage!=='review'){await h.current.review();h.render();assert.ok(h.current.preview);}
 const before=JSON.stringify(h.current.configuration),pending=stage==='review'?h.current.review():h.current.save('configuration');
 t.after(async()=>{hold.release();await pending;});attemptEdits(h);await hold.reached;h.render();
 console.log(JSON.stringify({checkpoint:`configuration-${stage}`,committed:stage!=='review',revision:f.service.inputs.read('review-site').revision}));
 assert.equal(h.current.busy,true);assert.equal(JSON.stringify(h.current.configuration),before,'All configuration setters must respect the synchronous lock');assertDisabled(h);
 attemptEdits(h);h.render();assert.equal(JSON.stringify(h.current.configuration),before);
 assert.equal(h.module.confirmMonthlyNavigation(),false);hold.release();await pending;h.render();assert.equal(h.current.busy,false);
 if(stage==='review'){assert.ok(h.current.preview);assert.equal(f.service.inputs.read('review-site').revision,1);}else{assert.equal(h.current.editing,false);h.current.edit();h.render();}
 field(h.tree('settings'),'Annual degradation (%)').props.onChange({target:{value:'0.2500'}});h.render();assert.equal(h.current.configuration.degradation,'0.2500');
});

test('SPEC-B1 known review/save failures release controls without losing submitted draft',async t=>{
 const f=fixture(t);configured(f);let fail=true;const real=adapter(f);
 const h=await editing(t,async(url,options)=>fail&&options.method==='POST'?Response.json({error:'Synthetic known rejection'},{status:409}):real(url,options));
 field(h.tree('settings'),'Annual degradation (%)').props.onChange({target:{value:'0.1250'}});h.render();await h.current.review();h.render();
 assert.equal(h.current.busy,false);assert.equal(h.current.editing,true);assert.match(h.current.error,/Synthetic known rejection/);
 assert.notEqual(field(h.tree('settings'),'Annual degradation (%)').props.disabled,true);assert.equal(h.current.configuration.degradation,'0.1250');
 fail=false;await h.current.review();h.render();fail=true;await h.current.save('configuration');h.render();
 assert.equal(h.current.uncertain,false);assert.equal(h.current.busy,false);assert.equal(h.current.editing,true);
 field(h.tree('baselines'),'Baseline 3 production').props.onChange({target:{value:'42.5'}});h.render();assert.equal(h.current.configuration.baselines[3].production,'42.5');
});

test('SPEC-B2 no-record UI and utility-only save/reopen keep absent degradation',async t=>{
 const f=fixture(t),fresh=await f.service.read('review-site');
 assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM monthly_configuration').get().n,0);
 const h=await editing(t,adapter(f));h.current.cancel();h.render();const html=renderToStaticMarkup(h.tree('settings'));
 console.log(JSON.stringify({checkpoint:'no-record',degradation:fresh.configuration.degradation,renderedZero:html.includes('<strong>0%</strong>')}));
 assert.equal(fresh.configuration.degradation,null);assert.ok(!html.includes('<strong>0%</strong>'));assert.match(html,/Not configured/);
 h.current.edit();h.render();assert.equal(field(h.tree('settings'),'Annual degradation (%)').props.value,'');
 h.current.updateUtility('2024-03','onPeak','123.125');h.render();await h.current.save('utility');h.render();assert.match(h.current.notice,/Saved and verified/);
 await f.reopen();assert.equal(f.service.inputs.read('review-site').configuration.degradation,null);assert.equal(f.service.inputs.read('review-site').utility['2024-03'].onPeak,'123.125');
});

test('SPEC-B2 real editor saves partial baseline/start, zero, precise rate and intentional clearing',async t=>{
 const f=fixture(t),h=await editing(t,adapter(f));
 async function save(){await h.current.review();h.render();assert.ok(h.current.preview,h.current.error);await h.current.save('configuration');h.render();assert.match(h.current.notice,/Saved and verified/);}
 field(h.tree('baselines'),'Baseline 3 insolation').props.onChange({target:{value:'31.1250'}});h.render();await save();
 assert.equal(h.current.configuration.operationsStart,null);assert.equal(h.current.configuration.degradation,null);
 h.current.edit();h.render();field(h.tree('settings'),'Operations start date').props.onChange({target:{value:'2024-03-16'}});h.render();await save();
 assert.equal(h.current.snapshot.projections.length,300);assert.equal(h.current.snapshot.projections[0].production,null);assert.ok(h.current.snapshot.projections[0].insolation);
 assert.match(renderToStaticMarkup(h.tree('comparison')),/degradation.*not configured/i);
 for(const rate of ['0','0.123456789012345678','']){
  h.current.edit();h.render();field(h.tree('settings'),'Annual degradation (%)').props.onChange({target:{value:rate}});h.render();await save();
  await f.reopen();assert.equal(f.service.inputs.read('review-site').configuration.degradation,rate||null);
  h.current.edit();h.render();assert.equal(field(h.tree('settings'),'Annual degradation (%)').props.value,rate);h.current.cancel();h.render();
 }
 assert.equal(h.current.configuration.baselines[3].insolation,'31.1250');
});

test('SPEC-06 negative control: near-bound raw value, reopen, unchanged save and exact total',async t=>{
 const f=fixture(t);configured(f);const value='999999999998.9999999';
 f.service.inputs.saveUtility('review-site',1,[{month:'2024-03',onPeak:value,offPeak:'0.000000000000000001',unpaidEnergy:null,revenue:null,energyUsed:null,invoiceCost:'000.0100'}]);await f.reopen();
 const h=await editing(t,adapter(f));assert.equal(field(h.tree('utility'),'2024-03 On-peak production').props.value,value);
 await h.current.save('utility');h.render();assert.equal(f.service.inputs.read('review-site').utility['2024-03'].onPeak,value);
 assert.deepEqual(utilityTotal(value,'0.000000000000000001'),{n:'999999999998999999900000000001',d:'1000000000000000000'});
 assert.equal(emptyConfiguration().operationsStart,null);
});
