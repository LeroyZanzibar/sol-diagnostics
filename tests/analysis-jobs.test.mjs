import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { loadSource , modelCapacityBindings} from "./source-module.mjs";

const checkpointStorage = loadSource("app/api/performance-summary/checkpoint-storage.ts");
const storedData = async object => JSON.parse(JSON.stringify(await checkpointStorage.readCheckpoint({...object,body:new Response(object.text).body,json:async()=>JSON.parse(object.text)})));
const time = loadSource("app/telemetry-time.ts");
const causes = { ...time, ...loadSource("app/api/performance-summary/causes.ts", [], time) };
Object.assign(causes, loadSource("app/api/performance-summary/peer-comparison.ts", [], {...modelCapacityBindings(),...time}));
Object.assign(causes, loadSource("app/api/performance-summary/telemetry-events.ts", [], {...modelCapacityBindings(),...(causes)}), loadSource("app/meter-mapping.ts"));
const errors = loadSource("app/api/performance-summary/database-errors.ts");
const cleanup = loadSource("db/depot-performance-cleanup.ts");
const jobs = loadSource("app/api/performance-summary/jobs.ts", [], {...errors,...cleanup});
function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("drizzle").filter(f => f.endsWith(".sql")).sort())
    sqlite.exec(readFileSync(`drizzle/${file}`, "utf8"));
  const statement = (sql, values = []) => ({ sql, values,
    bind(...next) { return statement(sql, next); },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
    async first() { return sqlite.prepare(sql).get(...values) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...values) }; },
  });
  return { sqlite, prepare: statement, async batch(items) {
    sqlite.exec("BEGIN");
    try { const results = []; for (const item of items) results.push(await item.run()); sqlite.exec("COMMIT"); return results; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  } };
}
async function start(db, id = "job") {
  const job = await jobs.getOrCreateJob(db, id, "site", "import");
  return { job, token: await jobs.claimJob(db, job) };
}

test("progress persists exact work counts and excludes concurrent workers", async () => {
  const db = database(); const { job, token } = await start(db);
  assert.equal(await jobs.claimJob(db, job), null);
  await jobs.reportProgress(db, job, token, "read", 250, 1000);
  const restored = await jobs.readJob(db, job.id);
  assert.equal(restored.percent, 6);
  assert.equal(restored.completed, 250);
  assert.equal(restored.attempt_id, job.attempt_id);
  await jobs.reportProgress(db, job, token, "equipment", 0, 76, true);
  const next = await jobs.readJob(db, job.id);
  assert.equal(next.percent, 25);
  assert.ok(await jobs.claimJob(db, next));
  await assert.rejects(jobs.reportProgress(db, job, token, "read", 999, 1000));
});

test("cancel during work is acknowledged at checkpoint; retry fences the old attempt", async () => {
  const db = database(); const { job, token } = await start(db);
  const canceling = await jobs.controlJob(db, "site", job.attempt_id, "cancel");
  assert.equal(canceling.status, "canceling");
  await assert.rejects(jobs.reportProgress(db, job, token, "equipment", 42, 76));
  await jobs.stopJob(db, job, token, new jobs.AnalysisStopped());
  assert.equal((await jobs.readJob(db, job.id)).status, "canceled");
  const retry = await jobs.controlJob(db, "site", job.attempt_id, "retry");
  assert.equal(retry.status, "processing");
  assert.notEqual(retry.attempt_id, job.attempt_id);
  assert.equal(await jobs.controlJob(db, "site", job.attempt_id, "cancel"), null);
  await assert.rejects(jobs.reportProgress(db, job, token, "save", 999, 1000));
  assert.equal(await jobs.controlJob(db, "other-site", retry.attempt_id, "cancel"), null);
});

test("expired requests release locks and acknowledge abandoned cancellation", async () => {
  for (const canceled of [false, true]) {
    const db = database(); const { job } = await start(db);
    if (canceled) await jobs.controlJob(db, "site", job.attempt_id, "cancel");
    db.sqlite.prepare("UPDATE analysis_jobs SET lease_until = 1 WHERE id = ?").run(job.id);
    const recovered = await jobs.readJob(db, job.id);
    assert.equal(recovered.status, canceled ? "canceled" : "interrupted");
    assert.equal(recovered.lease_token, "");
  }
});

test("publication and cancellation are atomic; partial results never replace saved results", async () => {
  for (const cancelFirst of [false, true]) {
    const db = database(); const { job, token } = await start(db);
    db.sqlite.prepare("INSERT INTO performance_summaries VALUES (?, ?, ?, ?)").run("old", "site", "old-pointer", "today");
    if (cancelFirst) {
      await jobs.controlJob(db, "site", job.attempt_id, "cancel");
      await assert.rejects(jobs.publishJob(db, job, token, "new-pointer", "new-object", 123));
      assert.equal(db.sqlite.prepare("SELECT summary FROM performance_summaries").get().summary, "old-pointer");
      assert.notEqual((await jobs.readJob(db, job.id)).percent, 100);
    } else {
      await jobs.publishJob(db, job, token, "new-pointer", "new-object", 123);
      const finished = await jobs.controlJob(db, "site", job.attempt_id, "cancel");
      assert.equal(finished.status, "completed");
      assert.equal(finished.percent, 100);
      assert.equal(db.sqlite.prepare("SELECT summary FROM performance_summaries").get().summary, "new-pointer");
    }
  }
});

// Integration: use the real CSV parser, detector, persistence, leases and result
// publication across multiple HTTP requests, with SQLite/R2 test adapters.
export async function analysisApi(csvText, equipment, record, manifest = null) {
  const db = database(); const objects = new Map([[record.objectKey, { text: csvText }]]);
  const io = { gets: [], puts: [], deletes: [] };
  const bucket = {
    async head(key) { const o = objects.get(key); return o ? { ...o, etag: key } : null; },
    async get(key) { io.gets.push(key); const o = objects.get(key); return o ? { ...o, etag: key, body: new Response(o.text).body,
      text: async () => o.text, json: async () => JSON.parse(o.text) } : null; },
    async put(key, text, options = {}) { io.puts.push(key); objects.set(key, { text, ...options }); return { etag: key }; },
    async delete(key) { for(const item of Array.isArray(key)?key:[key]){io.deletes.push(item);objects.delete(item);} },
  };
  const tables = { sites: [{ id: record.siteId }], imports: [record], equipment };
  const orm = { select() { return { from(table) {
    const rows = table === "pointers" ? db.sqlite.prepare("SELECT import_id AS importId, site_id AS siteId, summary FROM performance_summaries").all() : tables[table];
    return { where: () => Object.assign(Promise.resolve(rows), { orderBy: () => ({ limit: async () => rows }), limit: async () => rows }) };
  } }; } };
  const persistence = loadSource("app/api/performance-summary/persistence.ts", [], errors);
  const history = loadSource("app/data-history.ts", [], {...time,...loadSource("app/csv-stream.ts")});
  const api = loadSource("app/api/performance-summary/route.ts", ["buildSummary", "buildAnalysis", "alignWithArrayModel"], {...modelCapacityBindings(),...({
    ...loadSource("app/api/performance-summary/checkpoint-storage.ts"), ...history, readManifest:async()=>manifest, ...errors, ...jobs, ...persistence, ...loadSource("app/issue-review.ts"), ...loadSource("app/api/performance-summary/analysis-storage.ts"), currentAnalysisInput:async()=>record, getDatabaseBinding: () => db, getBucketBinding: () => bucket, getDb: () => orm,
    ...causes, monthlyLosses: loadSource("app/issue-periods.ts", [], time).monthlyLosses,
    siteSettings: "sites", equipmentAssets: "equipment", telemetryImports: "imports", performanceSummaries: "pointers", eq() {}, desc() {},
  })});
  const request = () => api.GET(new Request(`https://test/api/performance-summary?siteId=${record.siteId}`));
  return { db, objects, api, request, io };
}

test("staged analysis resumes across requests and serves only the completed saved JSON", async () => {
  const equipment = [
    { id: "meter", name: "Meter", type: "revenue_meter", parentId: null, externalId: "meter", aliases: "[]" },
    { id: "inv", name: "Inverter", type: "inverter", parentId: "meter", externalId: "inv", acRatedCapacityKw: "100", aliases: "[]" },
  ];
  const rows = ["time,meter,inv,sun"];
  for (let i = 0; i < 48; i++) rows.push(`2026-01-${i < 24 ? "01" : "02"}T${String(i % 24).padStart(2,"0")}:00:00,${i % 3 ? 40 : 0},${i % 3 ? 40 : 0},600`);
  const record = { id: "import", siteId: "site", objectKey: "upload.csv", rowCount: 48, timezone: "UTC", validation: JSON.stringify({ interval: "Hourly" }),
    mapping: JSON.stringify({ roles: { timestamp: "time" }, equipment: { signals: [
      { column: "meter", equipmentId: "meter", measurement: "Energy" }, { column: "inv", equipmentId: "inv", measurement: "Energy" },
      { column: "sun", equipmentId: "meter", measurement: "POA irradiance" }] } }) };
  const fixture = await analysisApi(rows.join("\n"), equipment, record);
  const seen = []; let result;
  for (let i = 0; i < 20; i++) {
    const response = await fixture.request(); result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    if (response.status !== 202) break;
    seen.push(result.progress.stage);
    assert.equal(fixture.db.sqlite.prepare("SELECT COUNT(*) AS count FROM performance_summaries").get().count, result.progress.status === "completed" ? 1 : 0);
  }
  assert.ok(result.hasData, JSON.stringify(result));
  assert.deepEqual(seen, ["read", "equipment", "reconcile", "save", "finalize", "complete"]);
  const stored = await (await fixture.request()).json();
  assert.equal(stored.cacheStatus, "stored");
  assert.equal(stored.analysis.totalLossKwh, result.analysis.totalLossKwh);
  assert.ok([...fixture.objects.keys()].some(key => key.endsWith("result.json")));
  assert.ok(![...fixture.objects.keys()].some(key => key.endsWith("/summary.json")));
});

 test("retry keeps a failed save checkpoint and fences the expired lease", async () => {
  const db = database(); const { job, token } = await start(db);
  await jobs.reportProgress(db, job, token, "save", 4500, 7112);
  await jobs.stopJob(db, job, token, new errors.DatabaseWriteError("batch", new Error("D1_ERROR: unavailable")));
  const retry = await jobs.controlJob(db, "site", job.attempt_id, "retry");
  assert.equal(retry.attempt_id, job.attempt_id);
  assert.equal(retry.stage, "save");
  assert.equal(retry.completed, 4500);
  assert.equal(retry.status, "processing");
  assert.equal(retry.error, "");
  await assert.rejects(jobs.reportProgress(db, job, token, "save", 5400, 7112));
  assert.ok(await jobs.claimJob(db, retry));
});

test("separate attempts for one upload persist safely and replay without duplicate occurrences", async () => {
  const db = database();
  const persistence = loadSource("app/api/performance-summary/persistence.ts", [], errors);
  const issue = { id: "finding", equipmentId: "inverter", equipmentName: "Inverter", equipmentType: "inverter",
    equipmentExternalId: "inverter", name: "Inverter offline", type: "offline", category: "outage", confidence: "high",
    severity: "high", description: "Offline", startDateTime: "2026-01-01T10:00:00", endDateTime: "2026-01-01T11:00:00",
    durationMinutes: 60, durationDays: 1, estimatedLossKwh: 40, lossPercent: 100, siteImpactPercent: 10,
    actualEnergyKwh: 0, expectedEnergyKwh: 40 };
  const args = { database: db, siteId: "site", importId: "import", parserVersion: 20, modelRevision: "model",
    analysisObjectKey: "result", issues: [issue], append: true };
  await persistence.persistPerformanceIssues({ ...args, runIdOverride: "first" });
  const originalBatch = db.batch.bind(db);
  let failAfterCommit = true;
  db.batch = async items => {
    const result = await originalBatch(items);
    if (failAfterCommit) { failAfterCommit = false; throw new Error("D1_ERROR: connection reset"); }
    return result;
  };
  await persistence.persistPerformanceIssues({ ...args, runIdOverride: "retry" });
  await persistence.persistPerformanceIssues({ ...args, runIdOverride: "retry" });
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_runs").get().n, 2);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM performance_issue_occurrences").get().n, 2);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM performance_issues").get().n, 1);
});

test("snow import runs through staged detection, hierarchy, persistence, and cached display with assumptions snapshot", async () => {
  const equipment = [
    {id:'meter',name:'Meter',type:'revenue_meter',parentId:null,externalId:'meter',aliases:'[]'},
    {id:'inv',name:'Inverter',type:'inverter',parentId:'meter',externalId:'inv',acRatedCapacityKw:'100',aliases:'[]'},
    {id:'snow',name:'Snow sensor',type:'weather_sensor',externalId:'snow',aliases:'[]'},
    {id:'modules',name:'Modules',type:'module_group',parentId:'inv',externalId:'modules',moduleRatedCapacityW:'400',quantity:250,aliases:'[]'},
  ];
  const csv='time,meter,inv,sun,expected,snow\n2026-01-01T00:00:00,0,0,0,0,60\n2026-01-01T10:00:00,40,40,600,40,60\n2026-01-02T10:00:00,20,20,600,40,60\n2026-01-02T23:59:00,,,,,70\n2026-01-03T10:00:00,20,20,600,40,60\n2026-01-03T23:00:00,0,0,0,0,60';
  const record={id:'snow-import',siteId:'site',objectKey:'upload.csv',rowCount:6,timezone:'America/New_York',validation:JSON.stringify({interval:'60 minutes'}),mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[
    {column:'meter',equipmentId:'meter',measurement:'Energy'},{column:'inv',equipmentId:'inv',measurement:'Energy'},
    {column:'sun',equipmentId:'meter',measurement:'POA irradiance'},{column:'snow',equipmentId:'snow',measurement:'Snow code'},
  ]}})};
  const fixture=await analysisApi(csv,equipment,record);
  let result;
  for(let i=0;i<12;i++) {const response=await fixture.request();result=await response.json();assert.ok(response.ok,JSON.stringify(result));if(response.status!==202)break;}
  assert.ok(result.hasData);
  assert.equal(result.analysis.causeAnalysis.snowDays[0],'2026-01-02');
  assert.equal(result.analysis.expectedProductionAssumptions.snow,'not_included');
  assert.equal(result.analysis.expectedProductionAssumptions.shading,'not_included');
  const snowIssues=result.analysis.issues.filter(issue=>issue.suspectedCause==='Snow');
  assert.equal(snowIssues.length,1,JSON.stringify(result.analysis.issues));
  assert.equal(snowIssues[0].equipmentId,'inv');
  assert.equal(snowIssues[0].estimatedLossKwh,20);
  assert.equal(result.analysis.totalLossKwh,20);
  assert.equal(snowIssues[0].startDateTime,'2026-01-02T15:00:00.000Z');
  assert.equal(snowIssues[0].timezone,'America/New_York');
  const stored=await(await fixture.request()).json();
  assert.equal(stored.cacheStatus,'stored');
  assert.equal(stored.analysis.issues[0].suspectedCause,'Snow');
  const persistence=loadSource('app/api/performance-summary/persistence.ts',[],errors);
  const run=fixture.db.sqlite.prepare('SELECT id FROM analysis_runs').get();
  const rows=await persistence.readPersistedPerformanceIssues(fixture.db,run.id);
  assert.equal(rows[0].suspectedCause,'Snow');
  assert.equal(rows[0].evidence.expectedProductionAssumptions.snow,'not_included');
  assert.match(rows[0].causeExplanation,/recorded 70/);
});

test('all-blank analysis persists unknown loss, remains visible above thresholds, and survives reload', async()=>{
  const equipment=[{id:'meter',name:'Meter',type:'revenue_meter',externalId:'meter',aliases:'[]'}, {id:'inv',name:'Inv',type:'inverter',parentId:'meter',externalId:'inv',acRatedCapacityKw:'100',aliases:'[]'}];
  const record={id:'unknown-import',siteId:'site',objectKey:'upload.csv',rowCount:3,timezone:'America/New_York',validation:JSON.stringify({interval:'1 hour'}),mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[{column:'meter',equipmentId:'meter',measurement:'Energy'},{column:'inv',equipmentId:'inv',measurement:'Energy'},{column:'sun',equipmentId:'meter',measurement:'POA irradiance'}]}})};
  const fixture=await analysisApi('time,meter,inv,sun,expected\n2026-06-01T10:00:00,,,600,50\n2026-06-01T11:00:00,,,600,50\n2026-06-01T12:00:00,,,600,50',equipment,record);
  let result;
  for(let i=0;i<12;i++){const r=await fixture.request();result=await r.json();assert.ok(r.ok,JSON.stringify(result));if(r.status!==202)break;}
  assert.ok(result.hasData);assert.equal(result.analysis.issues.length,1);assert.equal(result.analysis.issues[0].name,'Site telemetry outage');assert.equal(result.analysis.issues[0].estimatedLossKwh,null);assert.equal(result.analysis.issues[0].actualEnergyKwh,null);assert.equal(result.analysis.totalLossKwh,0);
  assert.equal(fixture.db.sqlite.prepare('SELECT estimated_loss_kwh FROM performance_issue_occurrences').get().estimated_loss_kwh,null);
  const stored=await(await fixture.request()).json();assert.equal(stored.analysis.issues[0].estimatedLossKwh,null);assert.equal(stored.analysis.issues[0].summaryPeriods[0].estimatedLossKwh,null);
  const oldPointer=fixture.db.sqlite.prepare('SELECT summary FROM performance_summaries').get().summary;
  const started=await fixture.api.POST(new Request('https://test/api/performance-summary',{method:'POST',body:JSON.stringify({siteId:'site',action:'reanalyze'})}));assert.equal(started.status,202);
  assert.equal(fixture.db.sqlite.prepare('SELECT summary FROM performance_summaries').get().summary,oldPointer);
  assert.equal((await fixture.request()).status,202);
  for(let i=0;i<12;i++){const r=await fixture.request();if(r.status!==202)break;}
  assert.notEqual(fixture.db.sqlite.prepare('SELECT summary FROM performance_summaries').get().summary,oldPointer);
  const latest=await(await fixture.request()).json();assert.equal(latest.analysis.issues[0].estimatedLossKwh,null);
});

test('staged transformer analysis retains branch settings and capped-expectation methodology',async()=>{
  const equipment=[
    {id:'meter',type:'revenue_meter'},
    {id:'tx',type:'transformer',parentId:'meter',nameplateKva:'150',pvCeilingOverrideEnabled:true,pvCeilingOverrideKw:'175'},
    ...[0,1].flatMap(i=>[{id:`i${i}`,type:'inverter',parentId:'tx',acRatedCapacityKw:'100'},{id:`m${i}`,type:'module_group',parentId:`i${i}`,moduleRatedCapacityW:'500',quantity:250}]),
  ].map(a=>({name:a.id,externalId:a.id,aliases:'[]',...a}));
  const record={id:'transformer-import',siteId:'site',objectKey:'transformer.csv',rowCount:4,timezone:'UTC',validation:JSON.stringify({interval:'1 hour'}),
    mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[
      {column:'meter',equipmentId:'meter',measurement:'Energy'},
      {column:'i0',equipmentId:'i0',measurement:'Energy'},
      {column:'i1',equipmentId:'i1',measurement:'Energy'},
      {column:'sun',equipmentId:'meter',measurement:'POA irradiance'},
    ]}})};
  const csv=['time,meter,i0,i1,sun,expected',...[10,11,12,13].map(h=>`2026-06-01T${h}:00:00Z,0,0,0,600,200`)].join('\n');
  const f=await analysisApi(csv,equipment,record);let result;
  for(let i=0;i<12;i++){const r=await f.request();result=await r.json();assert.ok(r.ok,JSON.stringify(result));if(r.status!==202)break;}
  assert.equal(result.analysis.totalLossKwh,700);
  assert.equal(result.methodology.calculationVersion,28);
  assert.equal(result.methodology.transformerLimits.gridExportCeilingKw,175);
  assert.equal(result.methodology.transformerLimits.excludedExpectedKwh,100);
  assert.equal(result.methodology.equipmentModel.find(a=>a.id==='tx').nameplateKva,'150');
  const saved=await (await f.request()).json();assert.equal(saved.cacheStatus,'stored');
  assert.equal(saved.methodology.transformerLimits.branches[0].overrideEnabled,true);
  assert.equal(f.objects.get(record.objectKey).text,csv);
});

// Seed the real save checkpoint with many distinct findings so this checks the
// storage pipeline independently of how many anomalies a small CSV generates.
async function saveFixture(count, legacy = false) {
  const record = { id: "save-import", siteId: "site", objectKey: "upload.csv", rowCount: 4,
    timezone: "UTC", validation: JSON.stringify({ interval: "1 hour" }),
    mapping: JSON.stringify({ roles: { timestamp: "time", expectedProduction: "expected" }, equipment: { signals: [
      { column: "meter", equipmentId: "meter", measurement: "Energy" },
      { column: "inv", equipmentId: "inv", measurement: "Energy" },
      { column: "sun", equipmentId: "meter", measurement: "POA irradiance" },
    ] } }) };
  const equipment = [
    {id:"meter",name:"Meter",type:"revenue_meter",externalId:"meter",aliases:"[]"},
    {id:"inv",name:"Inverter",type:"inverter",parentId:"meter",externalId:"inv",acRatedCapacityKw:"100",aliases:"[]"},
  ];
  const fixture = await analysisApi("time,meter,inv,sun,expected\n2026-01-01T09:00:00,40,40,600,40\n2026-01-01T10:00:00,0,0,600,40\n2026-01-01T11:00:00,40,40,600,40\n2026-01-01T12:00:00,40,40,600,40", equipment, record);
  for (let i = 0; i < 4; i++) assert.equal((await fixture.request()).status, 202);
  const job = fixture.db.sqlite.prepare("SELECT * FROM analysis_jobs").get();
  assert.equal(job.stage, "save");
  const root = `analysis/site/jobs/${job.attempt_id}`;
  const source = await storedData(fixture.objects.get(`${root}/analysis.json`));
  assert.ok(source.analysis.issues.length);
  const template = source.analysis.issues[0];
  source.analysis.issues = Array.from({ length: count }, (_, i) => {
    const start = Date.UTC(2026, 0, 1) + i * 3600000;
    return { ...template, id: `finding-${i}`, equipmentId: `inv-${i % 48}`,
      startDateTime: new Date(start).toISOString(), endDateTime: new Date(start + 3600000).toISOString(),
      evidence: { ...template.evidence, intervalLosses: Array.from({ length: 12 }, (_, j) => ({
        timestamp: new Date(start + j * 300000).toISOString(), intervalMinutes: 5,
        lossKwh: 3, countedLossKwh: 3, actualKwh: 0, expectedKwh: 3,
      })) } };
  });
  const expected = source.analysis.issues;
  fixture.objects.set(`${root}/analysis.json`, { text: JSON.stringify(source) });
  fixture.objects.delete(`${root}/save-manifest.json`);
  if (legacy) fixture.objects.delete(`${root}/save.json`);
  else fixture.objects.set(`${root}/save.json`, { text: JSON.stringify(
    loadSource("app/api/performance-summary/analysis-storage.ts").issueSaveIndex(expected, `${root}/result.json`)) });
  fixture.db.sqlite.prepare("UPDATE analysis_jobs SET total = ?").run(count);
  fixture.io.gets.length = 0; fixture.io.puts.length = 0;
  return { ...fixture, root, job, source, expected };
}

test("2,850 findings save in ten bounded requests with no per-issue evidence writes", async t => {
  const fixture = await saveFixture(2850);
  const started = performance.now();
  const batch = fixture.db.batch.bind(fixture.db), sizes = [];
  fixture.db.batch = items => { sizes.push(items.length); return batch(items); };
  let saves = 0;
  while (fixture.db.sqlite.prepare("SELECT stage FROM analysis_jobs").get().stage === "save") {
    const response = await fixture.request();
    const data = await response.json();
    assert.equal(response.status, 202, JSON.stringify(data));
    assert.equal(data.progress.status, "processing", JSON.stringify(data));
    saves++;
    assert.ok(saves <= 10);
    assert.equal(fixture.db.sqlite.prepare("SELECT COUNT(*) n FROM performance_summaries").get().n, 0);
  }
  assert.equal(saves, 10);
  assert.ok(sizes.every(n => n <= 60));
  assert.equal(fixture.io.puts.length, 0, "save stage must not write evidence objects");
  assert.equal(fixture.io.gets.filter(k => k.endsWith("/analysis.json")).length, 0, "save stage must not reload full evidence");
  assert.equal(fixture.io.gets.filter(k => k.endsWith("/save.json")).length, 10);
  const rows = fixture.db.sqlite.prepare("SELECT evidence FROM performance_issue_occurrences").all();
  assert.equal(rows.length, 2850);
  for (const row of rows) {
    const evidence = JSON.parse(row.evidence);
    assert.equal(evidence.evidenceKey, `${fixture.root}/result.json`);
    assert.equal(evidence.intervalLosses, undefined);
  }
  assert.equal((await fixture.request()).status, 202);
  const response = await fixture.request();
  assert.equal(response.status, 200);
  const display = await response.json();
  assert.equal(display.analysis.issues.length, 2850);
  const stored = await storedData(fixture.objects.get(`${fixture.root}/result.json`));
  assert.equal(stored.analysis.issues[2849].evidence.intervalLosses, undefined);
  assert.deepEqual(stored.analysis.issues[2849].intervalLosses, fixture.expected[2849].evidence.intervalLosses);
  const expectedSignature = await loadSource("app/issue-review.ts").issueEvidenceSignature(fixture.expected[2849]);
  assert.equal(stored.analysis.issues[2849].evidenceSignature, expectedSignature);
  fixture.io.gets.length = 0;
  const detail = await (await fixture.api.GET(new Request("https://test/api/performance-summary?siteId=site&issueId=finding-2849"))).json();
  assert.deepEqual(detail.issue.evidence.intervalLosses, fixture.expected[2849].evidence.intervalLosses);
  assert.equal(fixture.io.gets.filter(k => k === `${fixture.root}/result.json`).length, 1);
  assert.ok(!fixture.io.gets.some(k => k.includes("/evidence/")));
  assert.ok(!fixture.objects.has(`${fixture.root}/save.json`));
  assert.ok(!fixture.objects.has(`${fixture.root}/analysis.json`));
  t.diagnostic(`2,850 synthetic findings: ${saves} save requests; zero per-issue R2 writes; local save/finalize/detail ${(performance.now() - started).toFixed(0)} ms (in-memory storage, not production latency).`);
});

test("older 40-issue checkpoints and partially committed batches resume without losing evidence", async () => {
  const fixture = await saveFixture(650, true);
  const persistence = loadSource("app/api/performance-summary/persistence.ts", [], errors);
  const oldIssues = fixture.expected.slice(0, 40).map((issue, i) => {
    const evidenceKey = `${fixture.root}/evidence/${i}.json`;
    fixture.objects.set(evidenceKey, { text: JSON.stringify(issue.evidence) });
    return { ...issue, evidence: { ...issue.evidence, evidenceKey } };
  });
  await persistence.persistPerformanceIssues({ database: fixture.db, siteId: "site", importId: "save-import",
    parserVersion: fixture.source.parserVersion, modelRevision: fixture.source.modelRevision,
    analysisObjectKey: `${fixture.root}/result.json`, issues: oldIssues, runIdOverride: fixture.job.attempt_id, append: true });
  fixture.db.sqlite.prepare("UPDATE analysis_jobs SET completed = 40").run();
  const batch = fixture.db.batch.bind(fixture.db);
  let batches = 0;
  fixture.db.batch = async items => {
    const result = await batch(items);
    if (++batches === 2) throw new Error("D1_ERROR: simulated lost response after commit");
    return result;
  };
  const failed = await (await fixture.request()).json();
  assert.equal(failed.progress.status, "failed");
  assert.equal(failed.progress.completed, 40);
  assert.ok(fixture.db.sqlite.prepare("SELECT COUNT(*) n FROM performance_issue_occurrences").get().n > 40);
  fixture.db.batch = batch;
  const retry = await jobs.controlJob(fixture.db, "site", fixture.job.attempt_id, "retry");
  assert.equal(retry.attempt_id, fixture.job.attempt_id);
  let saves = 0;
  while (fixture.db.sqlite.prepare("SELECT stage FROM analysis_jobs").get().stage === "save") {
    const response = await fixture.request();
    assert.equal(response.status, 202);
    assert.equal((await response.json()).progress.status, "processing");
    assert.ok(++saves <= 3);
  }
  assert.equal(saves, 3);
  assert.equal(fixture.io.gets.filter(k => k.endsWith("/analysis.json")).length, 1);
  assert.equal(fixture.io.puts.filter(k => k.endsWith("/save.json")).length, 1);
  assert.ok(!fixture.io.puts.some(k => k.includes("/evidence/")));
  assert.equal(fixture.db.sqlite.prepare("SELECT COUNT(*) n FROM performance_issue_occurrences").get().n, 650);
  assert.equal((await fixture.request()).status, 202);
  assert.equal((await fixture.request()).status, 200);
  for (const i of [0, 39, 40, 649]) {
    const detail = await (await fixture.api.GET(new Request(`https://test/api/performance-summary?siteId=site&issueId=finding-${i}`))).json();
    assert.deepEqual(detail.issue.evidence.intervalLosses, fixture.expected[i].evidence.intervalLosses);
  }
});

test("previously completed analyses still load their separate evidence files", async () => {
  const fixture = await saveFixture(1);
  assert.equal((await fixture.request()).status, 202);
  assert.equal((await fixture.request()).status, 202);
  assert.equal((await fixture.request()).status, 200);
  const result = fixture.objects.get(`${fixture.root}/result.json`);
  const stored = await storedData(result), key = `${fixture.root}/evidence/0.json`;
  delete stored.analysis.issues[0].evidence.evidenceFormat;
  stored.analysis.issues[0].evidence.evidenceKey = key;
  fixture.objects.set(`${fixture.root}/result.json`, { ...result, customMetadata:{...result.customMetadata,checkpointFormat:undefined}, text: JSON.stringify(stored) });
  fixture.objects.set(key, { text: JSON.stringify({ ...fixture.expected[0].evidence, legacyMarker: true }) });
  const detail = await (await fixture.api.GET(new Request("https://test/api/performance-summary?siteId=site&issueId=finding-0"))).json();
  assert.equal(detail.issue.evidence.legacyMarker, true);
  assert.deepEqual(detail.issue.evidence.intervalLosses, fixture.expected[0].evidence.intervalLosses);
});

test('capacity-matched peer findings and recurring thresholds survive staged saving and evidence reload', async () => {
  const equipment=[{id:'meter',name:'Meter',type:'revenue_meter',externalId:'meter',aliases:'[]'}];
  for(let i=0;i<4;i++)equipment.push({id:`inv${i}`,name:`Inv ${i}`,type:'inverter',parentId:'meter',externalId:`inv${i}`,acRatedCapacityKw:'100',aliases:'[]'},
    {id:`modules${i}`,name:'Modules',type:'module_group',parentId:`inv${i}`,externalId:`modules${i}`,moduleRatedCapacityW:'500',quantity:250,aliases:'[]'});
  const rows=['time,meter,inv0,inv1,inv2,inv3,sun,expected'];
  for(let d=1;d<=6;d++)for(let h=8;h<=16;h++)rows.push(`2026-06-${String(d).padStart(2,'0')}T${String(h).padStart(2,'0')}:00:00,${h===9?228:240},${h===9?48:60},60,60,60,600,240`);
  const record={id:'peer-import',siteId:'site',objectKey:'upload.csv',rowCount:54,timezone:'UTC',validation:JSON.stringify({interval:'1 hour'}),mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[
    ...['meter','inv0','inv1','inv2','inv3'].map(id=>({column:id,equipmentId:id,measurement:'Energy'})),{column:'sun',equipmentId:'meter',measurement:'POA irradiance'}]}})};
  const fixture=await analysisApi(rows.join('\n'),equipment,record);
  fixture.db.sqlite.prepare("INSERT INTO user_settings (id,minimum_issue_loss_kwh) VALUES ('primary-user','50')").run();
  let result;
  for(let i=0;i<12;i++){const response=await fixture.request();result=await response.json();assert.ok(response.ok,JSON.stringify(result));if(response.status!==202)break;}
  const findings=result.analysis.issues.filter(i=>i.equipmentId==='inv0'&&i.type==='Underperformance');
  assert.equal(findings.length,6);assert.equal(result.analysis.totalLossKwh,72);
  assert.ok(findings.every(i=>i.recurringLossKwh===72&&i.recurringIssueCount===6));
  assert.equal(result.analysis.recurringIssues.length,1);
  const episode=result.analysis.recurringIssues[0];assert.equal(episode.members.length,6);assert.equal(episode.activeMinutes,360);assert.equal(episode.estimatedLossKwh,72);assert.ok(episode.eventKey&&episode.evidenceSignature);assert.ok(findings.every(i=>i.recurringId===episode.id));
  const reviewIndex=await storedData([...fixture.objects].find(([key])=>key.endsWith('/review-index.json'))[1]);assert.deepEqual(reviewIndex.analysis.recurringIssues,[episode]);assert.equal(fixture.db.sqlite.prepare('SELECT count(*) n FROM performance_issue_occurrences').get().n,result.analysis.issues.length);
  assert.equal(result.methodology.calculationVersion,28);
  assert.equal(result.methodology.peerComparison.minimumDeficitPercent,10);
  assert.equal(result.methodology.inverterExpectation.version,1);
  assert.equal(result.methodology.inverterExpectation.coverage.invertersWithRepeatedDeficits,1);
  const detail=await(await fixture.api.GET(new Request(`https://test/api/performance-summary?siteId=site&issueId=${encodeURIComponent(findings[0].id)}`))).json();
  const ledger=detail.issue.evidence.intervalLosses;
  assert.equal(detail.issue.evidence.peerComparison.dcRatedCapacityKw,125);
  assert.ok(ledger.every(p=>detail.issue.evidence.peerReferenceSets[p.peerSetIndex].length===3));
  assert.ok(Object.values(detail.issue.evidence.peerReferenceSets).every(ids=>!ids.includes('inv0')));
  assert.ok(ledger.every(p=>p.detectionBasis==='derived_inverter_expectation_v1'&&p.derivedInverterExpectedKwh===60&&p.peerCorroborated));
  assert.equal(detail.issue.evidence.peerReferenceQualification.records.length,3);
  const cached=await(await fixture.request()).json();assert.equal(cached.cacheStatus,'stored');assert.equal(cached.analysis.totalLossKwh,72);
});

test('shared site evidence survives staged publication without inflating database or review indexes',async()=>{
 const equipment=[{id:'meter',name:'Meter',type:'revenue_meter',externalId:'meter',aliases:'[]'}];
 for(let i=0;i<4;i++)equipment.push({id:`inv${i}`,name:`Inv ${i}`,type:'inverter',parentId:'meter',externalId:`inv${i}`,acRatedCapacityKw:'100',aliases:'[]'},
  {id:`modules${i}`,name:'Modules',externalId:`modules${i}`,type:'module_group',parentId:`inv${i}`,moduleRatedCapacityW:'500',quantity:250,aliases:'[]'});
 const rows=['time,meter,inv0,inv1,inv2,inv3,sun,expected'];
 for(let d=1;d<=3;d++)for(let h=8;h<=16;h++)rows.push(`2026-06-0${d}T${String(h).padStart(2,'0')}:00:00,174,30,48,48,48,600,240`);
 const record={id:'shared-import',siteId:'site',objectKey:'upload.csv',rowCount:27,timezone:'UTC',validation:JSON.stringify({interval:'1 hour'}),mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[
  ...['meter','inv0','inv1','inv2','inv3'].map(id=>({column:id,equipmentId:id,measurement:'Energy'})),{column:'sun',equipmentId:'meter',measurement:'POA irradiance'}]}})};
 const f=await analysisApi(rows.join('\n'),equipment,record);let result;
 for(let i=0;i<12;i++){const response=await f.request();result=await response.json();assert.ok(response.ok,JSON.stringify(result));if(response.status!==202)break;}
 assert.equal(result.analysis.totalLossKwh,27*66);
 assert.ok(result.analysis.issues.filter(i=>i.equipmentType==='inverter').every(i=>i.equipmentId==='inv0'));
 assert.equal(result.methodology.sharedReduction.minimumEligibleCapacityPercent,90);
 const stored=await storedData([...f.objects].find(([key])=>key.endsWith('/result.json'))[1]);
 const site=stored.analysis.issues.find(i=>i.evidence.rule==='shared_site_reduction_v1');assert.equal(site.sharedSourceEvents.length,4);
 const {sharedEvidencePage}=loadSource('app/shared-reduction-evidence.ts');
 const evidence=sharedEvidencePage(site);assert.equal(evidence.rows.length,4);assert.equal(evidence.rows.reduce((s,p)=>s+p.sharedLossKwh,0),site.estimatedLossKwh);
 const index=await storedData([...f.objects].find(([key])=>key.endsWith('/review-index.json'))[1]);
 assert.ok(index.analysis.issues.every(i=>!i.intervalLosses&&!i.sharedSourceEvents&&!i.evidence?.sharedSourceEvents));
 assert.ok(index.analysis.issues.some(i=>i.hasSharedReduction));
 for(const row of f.db.sqlite.prepare('SELECT evidence FROM performance_issue_occurrences').all()){
  assert.ok(!row.evidence.includes('sharedContributors'));assert.ok(!row.evidence.includes('sharedSourceEvents'));
 }
 assert.ok(result.analysis.issues.every(i=>!i.sharedSourceEvents&&i.intervalLosses.every(p=>!p.sharedContributors)));
});

test('indexed history feeds the existing analysis with identical production, expected values and blank readings',async()=>{
 const history=loadSource('app/data-history.ts',[],{...time,...loadSource('app/csv-stream.ts')});
 const equipment=[{id:'meter',name:'Meter',type:'revenue_meter',parentId:null,externalId:'meter',aliases:'[]'},
  {id:'inv',name:'Inverter',type:'inverter',parentId:'meter',externalId:'inv',acRatedCapacityKw:'100',aliases:'[]'},
  {id:'sun',name:'Irradiance',type:'weather_sensor',externalId:'sun',aliases:'[]'}];
 const csv='time,meter,inv,sun,expected\n2026-01-01T12:00Z,20,21,600,25\n2026-01-01T13:00Z,0,0,500,25\n2026-01-01T14:00Z,,,600,\n';
 const record={id:'source',siteId:'site',objectKey:'upload.csv',fileName:'upload.csv',createdAt:'now',rowCount:3,timezone:'UTC',validation:JSON.stringify({intervalMinutes:60,timestampConvention:'start'}),
  mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[{column:'meter',equipmentId:'meter',measurement:'Energy'},{column:'inv',equipmentId:'inv',measurement:'Energy'},{column:'sun',equipmentId:'sun',measurement:'Irradiance'}]}})};
 const month=await history.normalizeHistoryMonth(new Response(csv).body,record,equipment,'2026-01','UTC');
 const manifest={parts:{'2026-01':{key:'jan'}}};
 const retained={...record,id:'history',rowCount:month.cells.length,validation:JSON.stringify({datasetManifest:true,intervalMinutes:60,timestampConvention:'start'}),mapping:JSON.stringify({roles:{timestamp:'Timestamp',equipment:'Equipment',measurement:'Measurement',value:'Value',unit:'Unit',expectedProduction:'Expected Production'},equipment:{signals:[]}})};
 const raw=await analysisApi(csv,equipment,record),indexed=await analysisApi('',equipment,retained,manifest);
 indexed.objects.set('jan',{text:JSON.stringify(history.encodeHistoryCells(month.cells))});
 const original=await raw.api.buildSummary(record,equipment),roundtrip=await indexed.api.buildSummary(retained,equipment);
 for(const summary of [original,roundtrip])summary.equipmentProduction.sort((a,b)=>a.equipmentId.localeCompare(b.equipmentId));
 assert.deepEqual(JSON.parse(JSON.stringify(roundtrip)),JSON.parse(JSON.stringify(original)));
});

test('equipment batches resume an interrupted attempt and preserve the full calculation and interval losses',async()=>{
 const equipment=[{id:'meter',name:'Meter',type:'revenue_meter',externalId:'meter',aliases:'[]'}];
 for(let i=0;i<20;i++)equipment.push({id:`inv${i}`,name:`Inv ${i}`,type:'inverter',parentId:'meter',externalId:`inv${i}`,acRatedCapacityKw:'100',aliases:'[]'},
 {id:`mod${i}`,name:`Modules ${i}`,externalId:`mod${i}`,type:'module_group',parentId:`inv${i}`,moduleRatedCapacityW:'500',quantity:250,aliases:'[]'});
 const ids=Array.from({length:20},(_,i)=>`inv${i}`),rows=[['time','meter',...ids,'sun','expected'].join(',')];
 for(let day=1;day<=4;day++)for(let hour=8;hour<=16;hour++){
  const values=ids.map((_,i)=>i===0?30:60);rows.push([`2026-06-0${day}T${hour.toString().padStart(2,'0')}:00:00`,values.reduce((a,b)=>a+b,0),...values,600,1200].join(','));
 }
 const record={id:'batch-import',siteId:'site',objectKey:'upload.csv',rowCount:36,timezone:'UTC',validation:JSON.stringify({intervalMinutes:60}),mapping:JSON.stringify({roles:{timestamp:'time',expectedProduction:'expected'},equipment:{signals:[...['meter',...ids].map(id=>({column:id,equipmentId:id,measurement:'Energy'})),{column:'sun',equipmentId:'meter',measurement:'POA irradiance'}]}})};
 const f=await analysisApi(rows.join('\n'),equipment,record);
 const summary=f.api.alignWithArrayModel(await f.api.buildSummary(record,equipment),equipment);summary.causeContext={latitude:'',longitude:'',timeZone:'UTC',assumptions:causes.expectedAssumptions({})};
 const expected=JSON.parse(JSON.stringify(f.api.buildAnalysis(summary,equipment)));
 for(let i=0;i<3;i++)assert.equal((await f.request()).status,202);
 const job=f.db.sqlite.prepare('SELECT * FROM analysis_jobs').get();assert.equal(job.stage,'equipment');assert.equal(job.completed,16);
 f.db.sqlite.prepare("UPDATE analysis_jobs SET status='interrupted',completed=19").run();
 const resumed=await jobs.controlJob(f.db,'site',job.attempt_id,'retry');assert.equal(resumed.attempt_id,job.attempt_id);assert.equal(resumed.completed,19);
 assert.equal((await f.request()).status,202);assert.equal(f.db.sqlite.prepare('SELECT stage FROM analysis_jobs').get().stage,'reconcile');
 await f.request();const root=`analysis/site/jobs/${job.attempt_id}`;
 const actual=await storedData(f.objects.get(`${root}/analysis.json`));assert.deepEqual(actual.analysis,expected);
 const before=f.io.gets.length;await f.request();const reads=f.io.gets.slice(before);
 assert.ok(reads.includes(`${root}/save-0.json`));assert.ok(!reads.includes(`${root}/analysis.json`));assert.ok(!reads.includes(`${root}/save.json`));
});

test('streamed checkpoint storage round-trips nested ledgers and legacy JSON',async()=>{
 const input={meta:{name:'Shared text',empty:[],missing:undefined},analysis:{issues:Array.from({length:90},(_,i)=>({id:`issue-${i}`,name:'Shared text',loss:i===0?0:i/3,intervalLosses:[{timestamp:'2026-01-01T00:00:00Z',loss:i}]}))}};
 let stored;await checkpointStorage.writeCheckpoint({async put(key,bytes,options){stored={...options,text:bytes};}},'checkpoint',input);
 assert.ok(stored.text.length<JSON.stringify(input).length);assert.deepEqual(await storedData(stored),JSON.parse(JSON.stringify(input)));
 assert.deepEqual(await storedData({text:JSON.stringify(input)}),JSON.parse(JSON.stringify(input)));
 assert.deepEqual(await checkpointStorage.analysisJsonResponse(input).json(),JSON.parse(JSON.stringify(input)));
});
