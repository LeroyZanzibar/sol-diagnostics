import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import * as sqliteCore from 'drizzle-orm/sqlite-core';
import * as monthlyDomain from '../../app/monthly-domain.mjs';
import {LocalDatabase, LocalBucket} from '../../selfhost/storage.mjs';
import {loadSource} from '../source-module.mjs';

const migrations=resolve('drizzle');
const inventory=() => readdirSync(migrations).filter(name => /^\d+.*\.sql$/.test(name)).sort();
const hash=path => createHash('sha256').update(readFileSync(path)).digest('hex');
const settings={start:'2024-11', end:'2026-02', type:'bar', comparisonYears:2,
  metrics:['utilityTotal','budgetRevenue','actualInsolation','iapr','confirmedLoss','unconfirmedLoss']};
const waterfallSettings={start:'2026-04',end:'2026-06',type:'waterfall',comparisonYears:0,
  metrics:['projectedProduction','expectedProduction','confirmedLoss','utilityTotal']};
const plain=value => JSON.parse(JSON.stringify(value));
function modules(db) {
  const model=loadSource('app/monthly-chart-model.ts', [], {...monthlyDomain, JSON});
  const store=loadSource('db/chart-views.ts', [], {...sqliteCore, ...model, JSON, getDatabaseBinding:() => db});
  return {...store, api:loadSource('app/api/chart-views/route.ts', [], {...store, JSON})};
}
const quote=value => '"'+value.replaceAll('"','""')+'"';
function typedRows(db, table) {
  const columns=db.sqlite.prepare(`PRAGMA table_info(${quote(table)})`).all().map(column => column.name);
  return db.sqlite.prepare(`SELECT ${columns.flatMap(column => [quote(column), `typeof(${quote(column)}) AS ${quote(column+'__type')}`]).join(',')} FROM ${quote(table)} ORDER BY rowid`)
    .all().map(row => ({...row}));
}
function retained(db) {
  const tables=db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('__sol_migrations','chart_views') ORDER BY name").all().map(row => row.name);
  return Object.fromEntries(tables.map(table => [table,typedRows(db, table)]));
}
function ledger(db) {return db.sqlite.prepare('SELECT * FROM __sol_migrations ORDER BY name').all().map(row => ({...row}));}
function rootFor(t, label) {
  const root=mkdtempSync(join(tmpdir(), label));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  return root;
}

if (!isMainThread && workerData?.chartViewsWriter) {
  // Independent connections share the same production BEGIN IMMEDIATE guard.
  const db=new LocalDatabase(workerData.path, migrations);
  const {createChartView}=modules(db);
  parentPort.postMessage({ready:true});
  parentPort.once('message', ({name}) => {
    try {parentPort.postMessage({status:201, view:plain(createChartView({name,settings}))});}
    catch (error) {parentPort.postMessage({status:error.status || 500, error:error.message});}
    finally {db.close(); parentPort.close();}
  });
} else {
  test('fresh chart-view migration supplies exact schema, primary scope uniqueness and a complete ledger', t => {
    const root=rootFor(t, 'chart-views-fresh-'), db=new LocalDatabase(join(root,'shared.sqlite'), migrations);
    try {
      assert.deepEqual(ledger(db).map(row => row.name), inventory());
      assert.ok(inventory().includes('0023_chart_views.sql'));
      const columns=db.sqlite.prepare('PRAGMA table_info(chart_views)').all().map(row => ({name:row.name,type:row.type.toUpperCase(),notnull:row.notnull,pk:row.pk}));
      assert.deepEqual(columns, ['id','user_id','name','name_key','settings_json','created_at'].map((name,i) => ({name,type:'TEXT',notnull:1,pk:i===0?1:0})));
      assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_list(chart_views)').all(), []);
      const indexes=db.sqlite.prepare('PRAGMA index_list(chart_views)').all();
      assert.ok(indexes.some(index => index.name==='chart_views_user_name_key_unique' && index.unique===1));
      assert.deepEqual(db.sqlite.prepare('PRAGMA index_info(chart_views_user_name_key_unique)').all().map(row => row.name), ['user_id','name_key']);
      // Schema inspection does not call storage or the pending model dependency.
      const schema=loadSource('db/chart-views.ts', [], {...sqliteCore});
      const config=sqliteCore.getTableConfig(schema.chartViews);
      assert.equal(config.name, 'chart_views');
      assert.deepEqual(config.columns.map(column => ({name:column.name,type:column.getSQLType().toUpperCase(),notnull:Number(column.notNull),pk:Number(column.primary)})), columns);
      assert.deepEqual(config.indexes.map(index => ({name:index.config.name,unique:index.config.unique,columns:index.config.columns.map(column => column.name)})),
        [{name:'chart_views_user_name_key_unique',unique:true,columns:['user_id','name_key']}]);
      const insert=db.sqlite.prepare('INSERT INTO chart_views (id,user_id,name,name_key,settings_json,created_at) VALUES (?,?,?,?,?,?)');
      insert.run('one','primary-user','One','one',JSON.stringify(settings),'2026-01-01T00:00:00.000Z');
      assert.throws(() => insert.run('duplicate','primary-user','ONE','one',JSON.stringify(settings),'2026-01-01T00:00:00.000Z'), /UNIQUE/);
      insert.run('other','other-user','One','one',JSON.stringify(settings),'2026-01-01T00:00:00.000Z');
      assert.equal(db.sqlite.prepare('SELECT count(*) n FROM user_settings').get().n, 0);
      assert.equal(db.sqlite.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {db.close();}
  });

  test('chronological 0022 upgrade preserves every old typed row and ledger; saved views survive repeated reopen', async t => {
    const root=rootFor(t, 'chart-views-upgrade-'), previous=join(root,'through-0022');
    mkdirSync(previous);
    const names=inventory(), prefix=names.filter(name => name<'0023');
    assert.equal(prefix.at(-1), '0022_unpaid_energy.sql');
    const historicalFiles=[...prefix.map(name => join(migrations,name)),
      ...readdirSync(join(migrations,'meta')).filter(name => /^\d{4}_snapshot\.json$/.test(name) && name<'0023').map(name => join(migrations,'meta',name))];
    const historicalHashes=Object.fromEntries(historicalFiles.map(path => [path,hash(path)]));
    for (const name of prefix) copyFileSync(join(migrations,name), join(previous,name));
    const path=join(root,'shared.sqlite'); let db=new LocalDatabase(path, previous);
    try {
      assert.equal(db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='chart_views'").get(), undefined);
      db.sqlite.exec("INSERT INTO site_settings(id,name,expected_production_notes) VALUES ('retained','Synthetic retained','unchanged assumptions'),('other','Other',''); INSERT INTO maintenance_tasks VALUES ('retained-task','deleting','2024-01-01');");
      db.sqlite.prepare('INSERT INTO user_settings (id,first_name,last_name,title,minimum_issue_loss_kwh,theme,issue_visibility,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run('primary-user','Local','Analyst','Asset Manager','123.456','foundry','{"communicationIssue":false}','2024-01-01');
      const configuration={...monthlyDomain.emptyConfiguration(),operationsStart:'2024-03-16',degradation:'0.123456789012345678'};
      configuration.baselines[3]={production:'3100.1250',revenue:'310.50',insolation:'31.1250'};
      db.sqlite.prepare('INSERT INTO monthly_configuration VALUES (?,?,?,?)').run('retained',7,JSON.stringify(configuration),'2024-04-01');
      const utility=db.sqlite.prepare('INSERT INTO monthly_utility (site_id,month,on_peak,off_peak,revenue,energy_used,invoice_cost,unpaid_energy) VALUES (?,?,?,?,?,?,?,?)');
      utility.run('retained','2024-03','123.1234567890123456',null,'-12.3450','0','000.01230','17.00000000000000001');
      utility.run('other','2020-01',null,null,null,null,null,null);
      db.sqlite.prepare('INSERT INTO monthly_rollups VALUES (?,?,?,?,?,?)').run('retained',9,'null',2,'{"retained":"telemetry bytes"}','2024-04-01');
      db.sqlite.prepare('INSERT INTO analysis_runs(id,site_id,import_id,parser_version,model_revision,analysis_object_key) VALUES (?,?,?,?,?,?)').run('retained-run','retained','retained-import',28,'retained-model','analysis/retained.json');
      db.sqlite.prepare('INSERT INTO issue_event_reviews(id,site_id,event_key,version,state,updated_at) VALUES (?,?,?,?,?,?)').run('retained-review','retained','retained-event',1,'{"status":"confirmed"}','2024-04-01');
      db.sqlite.prepare('INSERT INTO performance_summaries VALUES (?,?,?,?)').run('retained-import','retained','{"objectKey":"analysis/retained.json"}','2024-04-01');
      const objectBytes='{"synthetic":"unchanged saved result"}';
      await new LocalBucket(db,join(root,'objects')).put('analysis/retained.json', objectBytes);
      const before=retained(db), oldLedger=ledger(db);
      assert.deepEqual(oldLedger.map(row => row.name), prefix);
      db.close(); db=null;
      let persisted, persistedBytes;
      for (let reopen=0; reopen<3; reopen++) {
        db=new LocalDatabase(path, migrations);
        assert.deepEqual(ledger(db).map(row => row.name), names);
        assert.deepEqual(ledger(db).slice(0,oldLedger.length), oldLedger);
        assert.deepEqual(retained(db), {...before,monthly_unconfirmed_loss:[]});
        const {api}=modules(db);
        if (reopen===0) {
          assert.deepEqual(await (await api.GET()).json(), {views:[]});
          const response=await api.POST(new Request('https://example.test/api/chart-views', {
            method:'POST',body:JSON.stringify({name:'  Reopen exact view  ',settings}),
          }));
          assert.equal(response.status,201); persisted=(await response.json()).view;
          assert.deepEqual(persisted.settings, settings);
          assert.equal(persisted.name, 'Reopen exact view');
        }
        assert.deepEqual(await (await api.GET()).json(), {views:[persisted]});
        const stored=db.sqlite.prepare('SELECT * FROM chart_views').get();
        assert.equal(stored.id,persisted.id); assert.equal(stored.created_at,persisted.createdAt);
        if (reopen===0) persistedBytes=stored.settings_json;
        assert.equal(stored.settings_json,persistedBytes);
        assert.deepEqual(JSON.parse(stored.settings_json),settings);
        assert.deepEqual(retained(db), {...before,monthly_unconfirmed_loss:[]}, 'save/reopen never changes user settings, sites, inputs, summaries, reviews or object metadata');
        assert.equal(await (await new LocalBucket(db,join(root,'objects')).get('analysis/retained.json')).text(), objectBytes);
        assert.equal(db.sqlite.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
        db.close(); db=null;
      }
      assert.deepEqual(Object.fromEntries(historicalFiles.map(path => [path,hash(path)])), historicalHashes);
    } finally {db?.close();}
  });

  test('waterfall settings round-trip through the real API and reopened SQLite without changing legacy views', async t => {
    const root=rootFor(t, 'chart-views-waterfall-'), path=join(root,'shared.sqlite');
    let db=new LocalDatabase(path,migrations);
    try {
      const {api}=modules(db), baseline=retained(db), migrationLedger=ledger(db);
      const post=(name, settings)=>api.POST(new Request('https://example.test/api/chart-views',{method:'POST',body:JSON.stringify({name,settings})}));
      const previous=await post('Legacy bar',settings);
      assert.equal(previous.status,201);
      const legacy=(await previous.json()).view;
      const stored=await post('Quarterly waterfall',waterfallSettings);
      assert.equal(stored.status,201);
      const waterfall=(await stored.json()).view;
      assert.deepEqual(waterfall.settings,waterfallSettings);
      for (const invalid of [{...waterfallSettings,comparisonYears:1},{...waterfallSettings,metrics:['revenue']},
        {...waterfallSettings,metrics:[...waterfallSettings.metrics].reverse()},{...waterfallSettings,siteId:'not-a-view-field'}]) {
        assert.equal((await post('Invalid waterfall',invalid)).status,400);
      }
      const storedRows=typedRows(db,'chart_views');
      assert.equal(storedRows.length,2);
      assert.equal(storedRows.find(row=>row.id===waterfall.id).settings_json,JSON.stringify(waterfallSettings));
      db.close();db=new LocalDatabase(path,migrations);
      const read=await modules(db).api.GET();
      assert.equal(read.status,200);
      const {views}=await read.json();
      assert.deepEqual(views.sort((a,b)=>a.name.localeCompare(b.name)),[legacy,waterfall]);
      assert.deepEqual(typedRows(db,'chart_views'),storedRows);
      assert.deepEqual(retained(db),baseline);
      assert.deepEqual(ledger(db),migrationLedger);
    } finally {db.close();}
  });

  async function simultaneous(t, path, names) {
    const workers=names.map(() => new Worker(new URL(import.meta.url), {workerData:{chartViewsWriter:true,path}}));
    t.after(async () => {await Promise.all(workers.map(worker => worker.terminate()));});
    const next=worker => new Promise((resolve,reject) => {
      const timer=setTimeout(() => reject(Error('Chart-view worker timed out')), 20000);
      worker.once('message', message => {clearTimeout(timer);resolve(message);});
      worker.once('error', error => {clearTimeout(timer);reject(error);});
    });
    const ready=await Promise.all(workers.map(next));
    assert.ok(ready.every(result => result.ready===true));
    const completed=workers.map(next);
    workers.forEach((worker,i) => worker.postMessage({name:names[i]}));
    return Promise.all(completed);
  }

  test('independent SQLite connections cannot race past duplicate or capacity checks', async t => {
    for (const mode of ['duplicate','capacity']) await t.test(mode, async t => {
      const root=rootFor(t, 'chart-views-concurrent-'), path=join(root,'shared.sqlite');
      let db=new LocalDatabase(path,migrations);
      try {
        const {createChartView}=modules(db);
        if (mode==='capacity') for (let i=0;i<99;i++) createChartView({name:`Existing ${i}`,settings});
        const baseline=retained(db);
        const names=mode==='duplicate'?[' Shared name ','SHARED NAME']:['Final one','Final two'];
        const results=await simultaneous(t,path,names);
        assert.deepEqual(results.map(result => result.status).sort(), [201,409]);
        const success=results.find(result => result.status===201).view;
        assert.deepEqual(success.settings, settings);
        assert.equal(db.sqlite.prepare('SELECT count(*) n FROM chart_views').get().n, mode==='capacity'?100:1);
        assert.deepEqual(retained(db),baseline);
        db.close();db=new LocalDatabase(path,migrations);
        const stored=plain(await modules(db).listChartViews());
        assert.deepEqual(stored.find(view => view.id===success.id),success);
        assert.equal(stored.length,mode==='capacity'?100:1);
        assert.deepEqual(retained(db),baseline);
      } finally {db?.close();}
    });
  });
}
