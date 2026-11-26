import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import * as sqliteCore from 'drizzle-orm/sqlite-core';
import * as monthlyDomain from '../app/monthly-domain.mjs';
import {LocalDatabase} from '../selfhost/storage.mjs';
import {loadSource} from './source-module.mjs';

const settings = () => ({start:'2025-11', end:'2026-04', type:'table', comparisonYears:2,
  metrics:['budgetRevenue', 'unpaidEnergy', 'actualInsolation']});
const payload = (name='Winter view') => ({name, settings:settings()});
const request = body => new Request('https://example.test/api/chart-views', {
  method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
});
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(), 'chart-views-api-'));
  const db=new LocalDatabase(join(root, 'shared.sqlite'), resolve('drizzle'));
  t.after(() => {db.close(); rmSync(root, {recursive:true, force:true});});
  // Source-module strips imports. Supply the real domain, validator, ORM and store;
  // shared JSON prevents cross-realm prototype checks from becoming false failures.
  const model=loadSource('app/monthly-chart-model.ts', [], {...monthlyDomain, JSON});
  const store=loadSource('db/chart-views.ts', [], {...sqliteCore, ...model, JSON, getDatabaseBinding:() => db});
  const api=loadSource('app/api/chart-views/route.ts', [], {...store, JSON});
  const rows=() => db.sqlite.prepare('SELECT * FROM chart_views ORDER BY id').all().map(row => ({...row}));
  const changes=() => db.sqlite.prepare('SELECT total_changes() AS n').get().n;
  return {db, model, store, api, rows, changes};
}
async function responseJson(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.match(response.headers.get('Content-Type'), /application\/json/);
  return response.json();
}
async function saved(api, body=payload()) {
  const result=await responseJson(await api.POST(request(body)), 201);
  assert.deepEqual(Object.keys(result), ['view']);
  assert.deepEqual(Object.keys(result.view).sort(), ['createdAt','id','name','settings']);
  return result.view;
}

// These tests call the actual route and production SQLite adapter, not SQL mocks.
test('chart views start empty without creating a user profile or changing unrelated data', async t => {
  const {db, api, changes}=fixture(t), before=changes();
  assert.deepEqual(await responseJson(await api.GET(), 200), {views:[]});
  assert.equal(changes(), before);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM user_settings').get().n, 0);
});

test('save returns exact settings and generated metadata; GET uses deterministic time/id order', async t => {
  const {db, api, model}=fixture(t);
  const body=payload('  Energy & revenue  '), view=await saved(api, body);
  assert.equal(view.name, 'Energy & revenue');
  assert.deepEqual(view.settings, body.settings);
  assert.match(view.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(new Date(view.createdAt).toISOString(), view.createdAt);
  const row=db.sqlite.prepare('SELECT * FROM chart_views WHERE id=?').get(view.id);
  assert.equal(row.user_id, 'primary-user');
  assert.equal(row.name_key, 'energy & revenue');
  assert.deepEqual(JSON.parse(row.settings_json), body.settings);
  assert.deepEqual(await responseJson(await api.GET(), 200), {views:[view]});
  const all={...settings(), type:'line', comparisonYears:0, metrics:model.chartMetrics.map(metric => metric.id)};
  assert.equal(all.metrics.length, 26);
  assert.deepEqual((await saved(api, {name:'Every metric', settings:all})).settings, plain(all));
  const insert=db.sqlite.prepare('INSERT INTO chart_views (id,user_id,name,name_key,settings_json,created_at) VALUES (?,?,?,?,?,?)');
  for (const id of ['order-z','order-a']) insert.run(id, 'primary-user', id, id, JSON.stringify(settings()), '2000-01-01T00:00:00.000Z');
  insert.run('other-scope', 'other-user', 'Hidden', 'hidden', JSON.stringify(settings()), '1999-01-01T00:00:00.000Z');
  const list=(await responseJson(await api.GET(), 200)).views;
  assert.deepEqual(list.slice(0,2).map(item => item.id), ['order-a','order-z']);
  assert.equal(list.some(item => item.id==='other-scope'), false);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM user_settings').get().n, 0);
});

test('valid settings boundaries, types, comparisons and Unicode names are retained', async t => {
  const {api}=fixture(t);
  const cases=[
    {...settings(), start:'1900-01', end:'1900-01', type:'line', comparisonYears:0},
    {...settings(), start:'9999-12', end:'9999-12', type:'bar', comparisonYears:1},
    {...settings(), start:'1900-01', end:'1949-12', type:'table', comparisonYears:2},
  ];
  for (const [i, value] of cases.entries()) assert.deepEqual((await saved(api, {name:`Boundary ${i}`, settings:value})).settings, value);
  assert.equal((await saved(api, payload('é'.repeat(60)))).name, 'é'.repeat(60));
  assert.equal((await saved(api, payload('日 🌞 “Revenue”'))).name, '日 🌞 “Revenue”');
});

test('unknown keys, invalid names and invalid shared settings reject without any writes', async t => {
  const {api, rows, changes}=fixture(t);
  await saved(api);
  const before=rows(), initialChanges=changes();
  const invalidNames=[undefined, null, false, 7, {}, [], '', '   ', 'x'.repeat(61), 'bad\nname', '\tname', 'bad\u0000name', 'bad\u007fname', 'bad\u0085name'];
  const invalidSettings=[undefined, null, false, [], {},
    {...settings(), extra:true}, {...settings(), siteId:'site'},
    {...settings(), start:'2026-5'}, {...settings(), start:'2026-00'}, {...settings(), end:'2026-13'},
    {...settings(), start:'1899-12'}, {...settings(), end:'10000-01'},
    {...settings(), start:'2026-05'}, {...settings(), start:'1900-01', end:'1950-01'},
    {...settings(), start:202601}, {...settings(), end:null},
    {...settings(), type:'pie'}, {...settings(), type:null},
    {...settings(), comparisonYears:-1}, {...settings(), comparisonYears:3},
    {...settings(), comparisonYears:'1'}, {...settings(), comparisonYears:1.5},
    {...settings(), metrics:[]}, {...settings(), metrics:null}, {...settings(), metrics:'revenue'},
    {...settings(), metrics:['revenue','revenue']}, {...settings(), metrics:['unknown']},
    {...settings(), metrics:['BudgetRevenue']}, {...settings(), metrics:[{}]},
  ];
  const cases=[null, [], true, 'view', {}, {settings:settings()}, {name:'Name'},
    {...payload(), siteId:'site'}, {...payload(), id:'chosen'}, {...payload(), createdAt:'chosen'},
    {...payload(), userId:'other-user'}, {...payload(), action:'update'},
    ...invalidNames.map(name => ({name, settings:settings()})),
    ...invalidSettings.map(value => ({name:'Invalid settings', settings:value}))];
  for (const body of cases) {
    const error=await responseJson(await api.POST(request(body)), 400);
    assert.equal(typeof error.error, 'string', JSON.stringify(body));
    assert.ok(error.error.length, JSON.stringify(body));
    assert.deepEqual(rows(), before, JSON.stringify(body));
    assert.equal(changes(), initialChanges, JSON.stringify(body));
  }
});

test('body parsing enforces the 32 KiB byte bound including streamed and malformed input', async t => {
  const {api, rows, changes}=fixture(t), before=changes();
  const raw=body => new Request('https://example.test/api/chart-views', {method:'POST', body});
  for (const body of ['', '{', 'null', '[]', new Uint8Array([0xff,0xfe]), JSON.stringify(payload())+' trailing']) {
    await responseJson(await api.POST(raw(body)), 400);
  }
  await responseJson(await api.POST(new Request('https://example.test/api/chart-views', {method:'POST'})), 400);
  let canceled=false, pulls=0;
  const stream=new ReadableStream({pull(controller) {pulls++;controller.enqueue(new TextEncoder().encode(' '.repeat(4096)));}, cancel() {canceled=true;}});
  await responseJson(await api.POST(new Request('https://example.test/api/chart-views', {method:'POST',body:stream,duplex:'half'})), 400);
  assert.equal(canceled, true); assert.ok(pulls<=10, `read ${pulls} chunks`);
  const multibyte=JSON.stringify(payload('é'))+' '.repeat(32768);
  await responseJson(await api.POST(raw(multibyte)), 400);
  await responseJson(await api.POST(new Request('https://example.test/api/chart-views', {
    method:'POST', headers:{'Content-Length':'32769'}, body:JSON.stringify(payload()),
  })), 400);
  assert.equal(changes(), before); assert.deepEqual(rows(), []);
  const exact=JSON.stringify(payload('Exact byte limit'));
  await responseJson(await api.POST(raw(exact+' '.repeat(32768-Buffer.byteLength(exact)))), 201);
  const oneOver=JSON.stringify(payload('Over by one'));
  await responseJson(await api.POST(raw(oneOver+' '.repeat(32769-Buffer.byteLength(oneOver)))), 400);
  assert.equal(rows().length, 1);
});

test('trimmed case-insensitive duplicate names conflict, never overwrite, and remain atomic', async t => {
  const {api, rows, changes}=fixture(t);
  const original=await saved(api, payload('  Revenue  ')), before=rows(), initialChanges=changes();
  for (const name of ['Revenue',' revenue ','REVENUE']) {
    const error=await responseJson(await api.POST(request({name, settings:{...settings(), type:'bar'}})), 409);
    assert.match(error.error, /name|already|exists/i);
    assert.deepEqual(rows(), before); assert.equal(changes(), initialChanges);
  }
  assert.deepEqual((await responseJson(await api.GET(), 200)).views, [original]);
  await saved(api, payload('ÉNERGIE'));
  await responseJson(await api.POST(request(payload(' énergie '))), 409);
  const results=await Promise.all(['Concurrent',' CONCURRENT ','concurrent'].map(name => api.POST(request(payload(name)))));
  assert.deepEqual(results.map(result => result.status).sort(), [201,409,409]);
  assert.equal(rows().filter(row => row.name_key==='concurrent').length, 1);
});

test('the 100-view primary profile limit is checked atomically with the create', async t => {
  const {api, db, rows, changes}=fixture(t);
  db.sqlite.prepare('INSERT INTO chart_views (id,user_id,name,name_key,settings_json,created_at) VALUES (?,?,?,?,?,?)')
    .run('other', 'other-user', 'Other view', 'other view', JSON.stringify(settings()), '2026-01-01T00:00:00.000Z');
  for (let i=0; i<99; i++) await saved(api, payload(`Saved ${i}`));
  const responses=await Promise.all(Array.from({length:6}, (_,i) => api.POST(request(payload(`Last ${i}`)))));
  assert.deepEqual(responses.map(result => result.status).sort(), [201,409,409,409,409,409]);
  assert.equal((await responseJson(await api.GET(), 200)).views.length, 100);
  const before=rows(), initialChanges=changes();
  const error=await responseJson(await api.POST(request(payload('Too many'))), 409);
  assert.match(error.error, /100/);
  assert.deepEqual(rows(), before); assert.equal(changes(), initialChanges);
});

test('malformed persisted records fail visibly instead of being hidden or repaired', async t => {
  const {api, db, rows, changes}=fixture(t);
  const view=await saved(api), original=rows()[0];
  const cases=[['settings_json','{'], ['settings_json','{}'],
    ['settings_json', JSON.stringify({...settings(), metrics:['removed-metric']})],
    ['settings_json', JSON.stringify({...settings(), siteId:'site'})],
    ['name',''], ['name','untrimmed '], ['name_key','WRONG'], ['created_at','not-a-date'], ['id','']];
  for (const [column, value] of cases) {
    db.sqlite.prepare(`UPDATE chart_views SET ${column}=?`).run(value);
    const before=rows(), initialChanges=changes();
    const error=await responseJson(await api.GET(), 500);
    assert.match(error.error, /saved|stored|read|load|record/i);
    assert.equal('views' in error, false);
    assert.deepEqual(rows(), before); assert.equal(changes(), initialChanges);
    db.sqlite.prepare(`UPDATE chart_views SET ${column}=?`).run(original[column]);
  }
  assert.deepEqual((await responseJson(await api.GET(), 200)).views, [view]);
});

test('verified readback failure rolls back the save rather than acknowledging changed settings', async t => {
  const {api, db, rows}=fixture(t);
  // A real trigger simulates corrupt storage/readback without replacing the adapter.
  db.sqlite.exec(`CREATE TRIGGER chart_views_bad_readback AFTER INSERT ON chart_views
    BEGIN UPDATE chart_views SET settings_json='{}' WHERE id=NEW.id; END;`);
  await responseJson(await api.POST(request(payload())), 500);
  assert.deepEqual(rows(), []);
  db.sqlite.exec('DROP TRIGGER chart_views_bad_readback');
  const changed=JSON.stringify({...settings(), type:'bar'}).replaceAll("'", "''");
  db.sqlite.exec(`CREATE TRIGGER chart_views_changed_readback AFTER INSERT ON chart_views
    BEGIN UPDATE chart_views SET settings_json='${changed}' WHERE id=NEW.id; END;`);
  await responseJson(await api.POST(request(payload())), 500);
  assert.deepEqual(rows(), []);
  db.sqlite.exec('DROP TRIGGER chart_views_changed_readback');
  await saved(api);
});

test('database failures are visible and private without returning raw SQL details', async t => {
  const {api, db}=fixture(t);
  db.sqlite.exec('DROP TABLE chart_views');
  for (const response of [await api.GET(), await api.POST(request(payload()))]) {
    const error=await responseJson(response, 500);
    assert.equal(typeof error.error, 'string');
    assert.doesNotMatch(error.error, /SELECT|INSERT|no such table/i);
  }
});
