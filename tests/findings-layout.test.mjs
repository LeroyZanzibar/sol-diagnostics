import test from 'node:test';
import assert from 'node:assert/strict';
import {home,harness,nodes,html,button,loadSource,React,periods,visibility,noop} from './outage-only-ui-harness.mjs';

export const ReportingPeriod=loadSource('app/ReportingPeriod.tsx',[],{React,...periods}).default;
export function findingsHome(initial={}) { return home(initial,{ReportingPeriod}); }
const hasClass=(tree,name)=>nodes(tree).some(n=>n.props?.className?.split(' ').includes(name));

test('Findings places compact reporting dates between site and reanalysis and removes obsolete panels',()=>{
 const h=findingsHome({user:{firstName:'Test',lastName:'User',theme:'default',issueVisibility:{...visibility.defaultIssueVisibility,equipmentOutage:false}}}),tree=h.render(),header=nodes(tree).find(n=>n.type==='header'&&n.props.className?.includes('diagnostic-header'));
 const markup=html(header);
 assert.ok(markup.indexOf('ANALYSIS SITE')<markup.indexOf('Reporting period from'));
 assert.ok(markup.indexOf('Reporting period through')<markup.indexOf('Reanalyze current data'));
 assert.match(markup,/reporting-period-compact/);
 assert.equal(button(tree,'Import performance data'),undefined);
 assert.equal(hasClass(tree,'active-analysis'),false);
 assert.equal(hasClass(tree,'issue-visibility-notice'),false);
 assert.ok(hasClass(tree,'freshness-controls'));
 assert.ok(button(tree,'Issue visibility'));
});

test('Findings preference failure retains a working retry without the removed notice class',()=>{
 const h=findingsHome({userSettingsReady:false,userSettingsError:'offline'}),tree=h.render();
 assert.match(html(tree),/Unable to load saved user preferences: offline/);
 assert.equal(hasClass(tree,'issue-visibility-notice'),false);
 const before=h.state.userSettingsRevision;button(tree,'Retry loading preferences').props.onClick();
 assert.equal(h.state.userSettingsRevision,before+1);
});

test('Summaries and Timeline retain shared analysis and hidden findings notices and full reporting controls',()=>{
 for(const view of ['summaries','timeline']) {
  const h=findingsHome({view,user:{firstName:'Test',lastName:'User',theme:'default',issueVisibility:{...visibility.defaultIssueVisibility,equipmentOutage:false}}});
  const tree=h.render(),report=nodes(tree).find(n=>n.props?.reportingPeriod)?.props.reportingPeriod;
  assert.ok(report,view);assert.ok(hasClass(report,'active-analysis'),view);
  assert.ok(hasClass(report,'issue-visibility-notice'),view);
  assert.doesNotMatch(html(report),/reporting-period-compact/);
 }
});

test('ReportingPeriod preserves date updates, bounds, reset, help and validation in both variants',()=>{
 for(const compact of [false,true]){
  let changed;const range={from:'2026-06-30',through:'2026-06-01'};
  const tree=ReportingPeriod({range,timezone:'America/New_York',compact,onChange:value=>changed=value});
  const inputs=nodes(tree).filter(n=>n.type==='input');
  assert.equal(inputs[0].props.max,range.through);assert.equal(inputs[1].props.min,range.from);
  inputs[0].props.onChange({target:{value:'2026-05-01'}});assert.deepEqual({...changed},{...range,from:'2026-05-01'});
  inputs[1].props.onChange({target:{value:'2026-07-01'}});assert.deepEqual({...changed},{...range,through:'2026-07-01'});
  assert.match(html(tree),/Include overlapping issues and count losses within these dates/);
  assert.match(html(tree),/Dates use America\/New_York/);assert.match(html(tree),/role="alert"/);
  button(tree,'All dates').props.onClick();assert.deepEqual({...changed},{from:'',through:''});
 }
});

test('ReviewWorkbench retains bulk selection review but no maintenance controls or instructions',()=>{
 const h=harness('app/ReviewWorkbench.tsx'),tree=h.render({siteId:'site',runId:'run',visible:[],originals:[],reviews:{},selected:[],onClear:noop,onUpdated:noop,readOnly:false});
 assert.doesNotMatch(html(tree),/maintenance/i);
 assert.ok(button(tree,'Review selected'));assert.equal(button(tree,'Review selected').props.disabled,true);
});
