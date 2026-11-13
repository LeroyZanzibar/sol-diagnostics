import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {loadSource} from './source-module.mjs';

const visibility=loadSource('app/issue-visibility.ts'),themes=loadSource('app/themes.ts');
const json=value=>JSON.parse(JSON.stringify(value));
const migrations=readdirSync('drizzle').filter(file=>file.endsWith('.sql')).sort();
function fixture({legacy=false}={}){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of migrations.filter(file=>!file.startsWith('0016_')))sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
 if(legacy)sqlite.prepare("INSERT INTO user_settings (id,first_name,last_name,title,minimum_issue_loss_kwh,theme) VALUES ('primary-user','Taylor','Solar','Analyst','250','foundry')").run();
 sqlite.exec(readFileSync('drizzle/0016_issue_visibility.sql','utf8'));
 const prepare=(sql,values=[])=>({bind(...v){return prepare(sql,v)},async first(){return sqlite.prepare(sql).get(...values)||null},async run(){return sqlite.prepare(sql).run(...values)}});
 const api=loadSource('app/api/user-settings/route.ts',[],{...themes,...visibility,getDatabaseBinding:()=>({prepare})});
 return {sqlite,api};
}
const request=(method,body)=>new Request('https://example.test/api/user-settings',{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const read=async api=>(await(await api.GET()).json()).user;
const profile={firstName:'Jordan',lastName:'Field',title:'Asset Manager',minimumIssueLossKwh:'900',theme:'default'};

test('all issue types are enabled by default and underperformance visibility is equipment-specific',()=>{
 const {defaultIssueVisibility,issueVisibilityOptions,isIssueVisible,issueVisibilityKey,normalizeIssueVisibility}=visibility;
 assert.equal(issueVisibilityOptions.length,9);assert.equal(Object.values(defaultIssueVisibility).every(Boolean),true);
 const cases=[['Site outage','revenue_meter','siteOutage'],['Partial site outage','revenue_meter','partialSiteOutage'],['Equipment outage','inverter','equipmentOutage'],['Underperformance','inverter','inverterUnderperformance'],['Underperformance','revenue_meter','siteUnderperformance'],['Site telemetry outage','revenue_meter','siteTelemetryOutage'],['Equipment telemetry issue','inverter','equipmentTelemetryIssue'],['Data gap','inverter','dataGap'],['Communication issue','revenue_meter','communicationIssue']];
 for(const [type,equipmentType,key] of cases){const issue={type,equipmentType};assert.equal(issueVisibilityKey(issue),key);assert.equal(isIssueVisible(issue,defaultIssueVisibility),true);assert.equal(isIssueVisible(issue,{...defaultIssueVisibility,[key]:false}),false);}
 const off=normalizeIssueVisibility(Object.fromEntries(issueVisibilityOptions.map(option=>[option.key,false])));
 assert.equal(isIssueVisible({type:'New future detector',equipmentType:'inverter'},off),true);
 assert.equal(isIssueVisible({type:'Underperformance',equipmentType:'revenue_meter'},{...defaultIssueVisibility,inverterUnderperformance:false}),true);
 for(const invalid of [null,undefined,'bad',[],{inverterUnderperformance:'false'}])assert.deepEqual(json(normalizeIssueVisibility(invalid)),json(defaultIssueVisibility));
});

test('additive migration preserves an existing profile and legacy visibility defaults to all enabled',async()=>{
 const {sqlite,api}=fixture({legacy:true}),user=await read(api);
 assert.equal(sqlite.prepare("SELECT issue_visibility FROM user_settings WHERE id='primary-user'").get().issue_visibility,'{}');
 assert.equal(user.firstName,'Taylor');assert.equal(user.theme,'foundry');assert.equal(user.minimumIssueLossKwh,'250');assert.deepEqual(user.issueVisibility,json(visibility.defaultIssueVisibility));
 sqlite.prepare("UPDATE user_settings SET issue_visibility=? WHERE id='primary-user'").run('corrupt-json');
 assert.deepEqual((await read(api)).issueVisibility,json(visibility.defaultIssueVisibility));
});

test('visibility PATCH persists preferences without changing profile, theme or analysis threshold',async()=>{
 const {sqlite,api}=fixture({legacy:true});
 const response=await api.PATCH(request('PATCH',{issueVisibility:{inverterUnderperformance:false,communicationIssue:false}}));
 assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'private, no-store');
 const user=(await response.json()).user;
 assert.equal(user.firstName,'Taylor');assert.equal(user.lastName,'Solar');assert.equal(user.title,'Analyst');assert.equal(user.theme,'foundry');assert.equal(user.minimumIssueLossKwh,'250');
 assert.equal(user.issueVisibility.inverterUnderperformance,false);assert.equal(user.issueVisibility.communicationIssue,false);assert.equal(user.issueVisibility.siteUnderperformance,true);assert.equal(user.issueVisibility.equipmentOutage,true);
 assert.deepEqual(await read(api),user);
 for(const table of ['analysis_runs','performance_issues','performance_issue_occurrences','issue_event_reviews','issue_review_changes'])assert.equal(sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
});

test('profile PUT preserves omitted visibility and accepts validated explicit preferences',async()=>{
 const {api}=fixture();
 await api.PATCH(request('PATCH',{issueVisibility:{inverterUnderperformance:false}}));
 const updated=await api.PUT(request('PUT',profile));assert.equal(updated.status,200);let user=(await updated.json()).user;
 assert.equal(user.firstName,profile.firstName);assert.equal(user.theme,profile.theme);assert.equal(user.issueVisibility.inverterUnderperformance,false);
 const changed=await api.PUT(request('PUT',{...profile,issueVisibility:{siteTelemetryOutage:false}}));assert.equal(changed.status,200);user=(await changed.json()).user;
 assert.equal(user.issueVisibility.siteTelemetryOutage,false);assert.equal(user.issueVisibility.inverterUnderperformance,true);assert.deepEqual(await read(api),user);
});

test('visibility can be saved before profile setup, including all hidden and Show all reset',async()=>{
 const {api}=fixture();assert.equal((await read(api)).firstName,'Local');
 const hidden=Object.fromEntries(visibility.issueVisibilityOptions.map(option=>[option.key,false]));
 const saved=await api.PATCH(request('PATCH',{issueVisibility:hidden}));assert.equal(saved.status,200);assert.deepEqual((await read(api)).issueVisibility,hidden);
 assert.equal((await api.PATCH(request('PATCH',{issueVisibility:visibility.defaultIssueVisibility}))).status,200);assert.deepEqual((await read(api)).issueVisibility,json(visibility.defaultIssueVisibility));
});

test('invalid visibility submissions are rejected without altering saved preferences',async()=>{
 const {api}=fixture({legacy:true});await api.PATCH(request('PATCH',{issueVisibility:{inverterUnderperformance:false}}));const before=await read(api);
 for(const value of [null,[],false,'false',{inverterUnderperformance:'false'},{inverterUnderperformance:0},{inventedType:false}]){
  assert.equal((await api.PATCH(request('PATCH',{issueVisibility:value}))).status,400);
  assert.equal((await api.PUT(request('PUT',{...profile,issueVisibility:value}))).status,400);
 }
 for(const body of [{},{issueVisibility:{},firstName:'Overwrite'},null,[]])assert.equal((await api.PATCH(request('PATCH',body))).status,400);
 assert.equal((await api.PATCH(new Request('https://example.test/api/user-settings',{method:'PATCH',body:'broken json'}))).status,400);
 assert.deepEqual(await read(api),before);
});
