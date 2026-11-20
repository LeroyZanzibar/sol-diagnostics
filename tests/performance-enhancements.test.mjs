import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { loadSource, makeAnalysisFixture , modelCapacityBindings} from "./source-module.mjs";

const checkpointStorage = loadSource("app/api/performance-summary/checkpoint-storage.ts");
const {jobProgress} = loadSource("app/api/performance-summary/jobs.ts");
const time = loadSource("app/telemetry-time.ts");
const causes = { ...time, ...loadSource("app/api/performance-summary/causes.ts", [], time) };
Object.assign(causes, loadSource("app/api/performance-summary/peer-comparison.ts", [], {...modelCapacityBindings(),...time}));
Object.assign(causes, loadSource("app/api/performance-summary/telemetry-events.ts", [], {...modelCapacityBindings(),...(causes)}), loadSource("app/meter-mapping.ts"));
const routePath = "app/api/performance-summary/route.ts";
const analysis = loadSource(routePath, ["buildAnalysis", "arrayModelRevision"], {...modelCapacityBindings(),...(causes)});
const csv = loadSource("app/telemetry-csv.ts", [], {...modelCapacityBindings(),...(loadSource("app/telemetry-time.ts"))});

test("analysis regression covers gaps, outages, attribution and imported weather-adjusted expectations", () => {
  // Outage-only result snapshots follow independently asserted scenario and ledger-conservation tests.
  const cases = [
    [[3, 2, 0], "5d5b51af17990c539eae4c6939b13a22fc23ca79bc45692913ac15002dd9f12d", 1588.8],
    [[50, 4, 0], "fb2787e0c6438a9bd8f15ba23521547de41af09f169258c0c4f29f829ed28346", 22183.200000000004],
    [[90, 8, 3], "d64c38477895747c2008a5558936a4f798fd74dea2023f7679cfc1b24e80cc18", 72912],
  ];
  for (const [args, expected, total] of cases) {
    const fixture = makeAnalysisFixture(...args);
    const result = analysis.buildAnalysis(fixture.summary, fixture.equipment);
    const counted = result.issues.flatMap(issue => issue.evidence.intervalLosses)
      .reduce((sum, point) => sum + (point.countedLossKwh ?? point.lossKwh), 0);
    assert.ok(Math.abs(counted - result.totalLossKwh) < 1e-6);
    assert.ok(result.issues.filter(issue => issue.lossUnknown).every(issue => issue.estimatedLossKwh === 0));
    assert.ok(Math.abs(result.totalLossKwh-total)<1e-7);
    assert.equal(result.issues.some(issue=>issue.type==='Underperformance'),false);
    assert.equal(result.recurringIssues.length,0);
    assert.equal(createHash("sha256").update(JSON.stringify(result)).digest("hex"), expected);
  }
});

async function storedApi(parserVersion = 29) {
  const { summary, equipment } = makeAnalysisFixture(20, 3);
  const revision = await analysis.arrayModelRevision(equipment);
  const record = { id: "import-1", siteId: "site-1", createdAt: "2026-01-01", timezone: "UTC", validation: "{}" };
  const payload = { siteId: "site-1", importId: record.id, parserVersion, modelRevision: revision, timeZone: "UTC",
    issueDatabase: { analysisRunId: "run-1", persistedIssueCount: 10 },
    summary: { dailyProduction: [{ date: "2026-01-01", energyKwh: 500 }], totalEnergyKwh: 500 },
    methodology: {calculationVersion:parserVersion}, analysis: analysis.buildAnalysis(summary, equipment) };
  let threshold = "", job = null;
  const reads = [], writes = [];
  const objects = new Map();
  objects.set("analysis/site-1/current.json", { text: JSON.stringify(payload), etag: "full-1", customMetadata: {
    siteId: "site-1", importId: record.id, parserVersion: String(parserVersion), modelRevision: revision,
  } });
  const tables = { sites: [{ id: "site-1" }], imports: [record], equipment, pointers: [{importId:record.id,siteId:record.siteId,
    summary:JSON.stringify({parserVersion,modelRevision:revision,objectKey:'analysis/site-1/current.json',analysisRunId:'run-1'})}] };
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec("CREATE TABLE analysis_runs(id TEXT,site_id TEXT,import_id TEXT,status TEXT,analysis_object_key TEXT)");
  sqlite.prepare('INSERT INTO analysis_runs VALUES(?,?,?,?,?)').run('run-1','site-1',record.id,'completed','analysis/site-1/current.json');
  const database={prepare(query){const statement=(values=[])=>({bind(...next){return statement(next);},
    async first(){return query.includes('analysis_jobs')?job:query.includes('user_settings')?{minimum_issue_loss_kwh:threshold}:sqlite.prepare(query).get(...values)||null;},
    async all(){return {results:sqlite.prepare(query).all(...values)};}});return statement();}};
  const db = { select() {
    let table;
    const query = { from(value) { table = value; return query; }, where() { return query; }, orderBy() { return query; },
      limit() { return Promise.resolve(tables[table]); }, then(resolve, reject) { return Promise.resolve(tables[table]).then(resolve, reject); } };
    return query;
  } };
  const api = loadSource(routePath, [], {...modelCapacityBindings(),...({
    ...checkpointStorage, ...causes, monthlyLosses: loadSource("app/issue-periods.ts", [], time).monthlyLosses,
    siteSettings: "sites", telemetryImports: "imports", equipmentAssets: "equipment", performanceSummaries: "pointers",
    currentAnalysisInput:async()=>record, eq() {}, desc() {}, getDb: () => db,
    getDatabaseBinding: () => database,
    getBucketBinding: () => ({
      head: async key => objects.get(key) || null,
      get: async key => {
        reads.push(key);
        const stored = objects.get(key);
        return stored ? { ...stored, body: new Response(stored.text).body, text: async () => stored.text, json: async () => JSON.parse(stored.text) } : null;
      },
      put: async (key, text, options) => { writes.push(key); objects.set(key, { text, ...options }); return { etag: "derivative" }; },
    }),
    analysisJobKey: async () => "new-run",
    readJob: async () => job,
    getOrCreateJob: async () => ({ status: "processing", stage: "read", attempt_id: "new-attempt" }),
    jobProgress,
  })});
  const request = (query = "", etag = "") => api.GET(new Request(`https://example.test/api/performance-summary?siteId=site-1${query}`, {
    headers: etag ? { "If-None-Match": etag } : {},
  }));
  return { request, payload, record, equipment, objects, reads, writes, sqlite, pointers:tables.pointers, setThreshold(value) { threshold = value; }, setJob(value) { job = value; } };
}

test('terminal rerun metadata bypasses a prior result ETag without contaminating the retained compact snapshot',async()=>{
  const api=await storedApi(),first=await api.request(),tag=first.headers.get('ETag');await first.json();
  const full=api.objects.get('analysis/site-1/current.json').text,compact=api.objects.get('analysis/site-1/display.json').text;
  for(const status of ['canceled','failed','interrupted']) {
    const job={id:'new-run',site_id:'site-1',import_id:'import-1',attempt_id:`attempt-${status}`,status,stage:'equipment',completed:2,total:5,percent:41,updated_at:123,error:status==='canceled'?'':'Retained retry checkpoint.'};
    api.setJob(job);
    const response=await api.request('',tag),data=await response.json();
    assert.equal(response.status,200);assert.equal(data.hasData,true,JSON.stringify(data));assert.equal(data.issueDatabase.analysisRunId,'run-1');
    assert.deepEqual(data.lastAttempt,JSON.parse(JSON.stringify(jobProgress(job))));assert.equal(data.processing,false);assert.equal(data.progress,undefined);
    assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(response.headers.get('etag'),null);
    assert.equal(api.objects.get('analysis/site-1/current.json').text,full);assert.equal(api.objects.get('analysis/site-1/display.json').text,compact);
    const statusData=await(await api.request('&statusOnly=1')).json();assert.equal(statusData.cacheStatus,'stored');assert.deepEqual(statusData.lastAttempt,data.lastAttempt);
  }
  api.setJob(null);assert.equal((await api.request('',tag)).status,304);
});

test("compact results preserve totals, retain evidence on demand, and avoid full-object reads", async () => {
  const api = await storedApi();
  const first = await api.request();
  assert.equal(first.status, 200);
  const firstData = await first.json();
  assert.equal(firstData.analysis.totalLossKwh, api.payload.analysis.totalLossKwh);
  assert.ok(firstData.analysis.issues.length > 0);
  assert.ok(firstData.analysis.issues.every(issue => !("evidence" in issue)));
  assert.equal(firstData.timeZone, "UTC");
  for (const issue of firstData.analysis.issues) {
    const original = api.payload.analysis.issues.find(item => item.id === issue.id);
    assert.equal(issue.timezone, "UTC");
    assert.equal(issue.intervalMinutes, 60);
    assert.equal(issue.intervalLosses.length, original.evidence.intervalLosses.length);
    const total = issue.intervalLosses.reduce((sum, point) => sum + (point.countedLossKwh ?? point.lossKwh), 0);
    assert.ok(Math.abs(total - (issue.estimatedLossKwh ?? 0)) < 1e-6);
  }
  assert.deepEqual(api.writes, ["analysis/site-1/display.json"]);
  assert.equal(api.objects.get("analysis/site-1/display.json").customMetadata.displayVersion, "5");
  assert.ok(JSON.parse(api.objects.get("analysis/site-1/current.json").text).analysis.issues[0].evidence);
  api.reads.length = 0;
  await api.request();
  assert.deepEqual(api.reads, ["analysis/site-1/display.json"]);
  api.reads.length = 0;
  const cached = await api.request("", first.headers.get("ETag"));
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  assert.deepEqual(api.reads, []);
  const detail = await api.request(`&issueId=${encodeURIComponent(firstData.analysis.issues[0].id)}`);
  assert.ok((await detail.json()).issue.evidence.intervalLosses.length);
  assert.equal((await api.request("&issueId=nonexistent")).status, 404);
});

test("completed older snapshots remain readable without relabeling their method or modifying authoritative bytes", async () => {
 for (const version of [19, 24, 28]) {
  const api = await storedApi(version),before=api.objects.get('analysis/site-1/current.json').text;
  const status = await (await api.request("&statusOnly=1")).json();assert.equal(status.cacheStatus,"stale");
  const response = await api.request();assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.hasData,true);assert.equal(result.methodology.calculationVersion,version);
  assert.equal(result.issueDatabase.analysisRunId,'run-1');assert.equal(api.objects.get('analysis/site-1/current.json').text,before);
  assert.ok(api.writes.every(key=>key.endsWith('/display.json')));
 }
});

test("an older compact display is regenerated with interval reporting evidence", async () => {
  const api = await storedApi();
  await api.request();
  const compact = api.objects.get("analysis/site-1/display.json");
  compact.customMetadata.displayVersion = "3";
  const old = await checkpointStorage.readCheckpoint({...compact,body:new Response(compact.text).body,json:async()=>JSON.parse(compact.text)});
  delete compact.customMetadata.checkpointFormat;
  old.analysis.issues.forEach(issue => { delete issue.intervalLosses; delete issue.timezone; });
  compact.text = JSON.stringify(old);
  api.reads.length = 0;
  const data = await (await api.request()).json();
  assert.ok(api.reads.includes("analysis/site-1/current.json"));
  assert.ok(data.analysis.issues.every(issue => Array.isArray(issue.intervalLosses) && issue.timezone === "UTC"));
  assert.equal(api.objects.get("analysis/site-1/display.json").customMetadata.displayVersion, "5");
});

test("threshold, import, model and source changes invalidate conditional results", async () => {
  const api = await storedApi();
  const tag = (await api.request()).headers.get("ETag");
  api.setThreshold("999999999");
  const filtered = await api.request("", tag);
  assert.equal(filtered.status, 200);
  assert.notEqual(filtered.headers.get("ETag"), tag);
  assert.ok((await filtered.json()).analysis.issues.every(issue => issue.category === "Communications" || issue.lossUnknown));
  api.record.id = "import-2";
  const changedImport=await api.request("",tag);assert.equal(changedImport.status,200);
  assert.equal((await changedImport.json()).issueDatabase.analysisRunId,'run-1');
  api.record.id = "import-1";
  api.equipment[1].acRatedCapacityKw = "110";
  const changedModel=await api.request("",tag);assert.equal(changedModel.status,200);
  assert.equal((await changedModel.json()).methodology.calculationVersion,29);
  api.equipment[1].acRatedCapacityKw = "100";
  api.objects.get("analysis/site-1/current.json").etag = "full-2";
  api.reads.length = 0;
  assert.equal((await api.request("", tag)).status, 200);
  assert.ok(api.reads.includes("analysis/site-1/current.json"));
});

test("streaming CSV supports escaped quotes, quoted newlines, CRLF and split UTF-8", async () => {
  const bytes = new TextEncoder().encode('time,note\r\n"2026-01-01","é, ""quoted""\n😀"\r\n');
  for (const size of [1, 2, 3, 7, 64]) {
    let at = 0;
    const rows = [];
    await csv.parseCsvStream(new ReadableStream({ pull(controller) {
      if (at >= bytes.length) controller.close();
      else { controller.enqueue(bytes.slice(at, at + size)); at += size; }
    } }), row => rows.push([...row]));
    assert.deepEqual(rows, [["time", "note"], ["2026-01-01", 'é, "quoted"\n😀']]);
  }
});

test("worker returns a bounded preview while validating and preparing every row", async () => {
  const waiters = new Map();
  const self = { postMessage(message) { waiters.get(message.id)(message); } };
  loadSource("app/telemetry.worker.ts", [], { self, ...csv });
  let sequence = 0;
  const send = request => new Promise(resolve => { const id = ++sequence; waiters.set(id, resolve); self.onmessage({ data: { ...request, id } }); });
  const file = new File(["time,energy,excluded\n" + Array.from({ length: 2001 }, (_, index) =>
    `${new Date(Date.UTC(2026, 0, 1, 0, index * 15)).toISOString()},10,private`).join("\n")], "large.csv");
  const mapping = { timestamp: "time", value: "", expectedProduction: "", equipment: "", measurement: "", unit: "" };
  const signals = [{ column: "energy", equipmentId: "meter", measurement: "Energy" }];
  const load = send({ kind: "load", file });
  const validation = send({ kind: "validate", mapping, signals, equipment: [] });
  const preview = (await load).value;
  assert.equal(preview.rows.length, 1000);
  assert.equal(preview.rowCount, 2001);
  const result = (await validation).value;
  assert.equal(result.checkedRows, 2001);
  assert.equal(result.validRows, 2001);
  assert.equal(result.interval, "15 min");
  const output = (await send({ kind: "prepare", mapping, signals })).value;
  const text = await output.text();
  assert.equal(text.split("\r\n").length, 2002);
  assert.ok(!text.includes("private"));
  assert.ok(!text.includes("excluded"));
});

test("parallel upload retries transient errors and waits for all chunks before finalization", async () => {
  let active = 0, maximum = 0;
  const attempts = new Map(), completed = new Set(), progress = [];
  const upload = loadSource("app/upload-parts.ts", [], { fetch: async url => {
    const part = Number(new URL(url, "https://example.test").searchParams.get("part"));
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    const count = (attempts.get(part) || 0) + 1;
    attempts.set(part, count);
    if (part === 2 && count === 1) return new Response("retry", { status: 503 });
    completed.add(part);
    return Response.json({ ok: true });
  } });
  const total = await upload.uploadCsvParts(new File([new Uint8Array(2 * 1024 * 1024 + 1)], "data.csv"), "upload-id", value => progress.push(value));
  assert.equal(total, 5);
  assert.equal(completed.size, 5);
  assert.equal(active, 0);
  assert.equal(maximum, 3);
  assert.equal(attempts.get(2), 2);
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
});

test("failed uploads settle in-flight requests before cleanup and do not retry client errors", async () => {
  let active = 0, calls = 0;
  const upload = loadSource("app/upload-parts.ts", [], { fetch: async () => {
    const index = ++calls;
    active++;
    await new Promise(resolve => setTimeout(resolve, index === 1 ? 1 : 20));
    active--;
    return index === 1 ? Response.json({ error: "Invalid chunk" }, { status: 400 }) : Response.json({ ok: true });
  } });
  await assert.rejects(upload.uploadCsvParts(new File([new Uint8Array(4 * 1024 * 1024)], "data.csv"), "upload-id", () => {}), /Invalid chunk/);
  assert.equal(active, 0);
  assert.equal(calls, 3);
});


test('eligible legacy early 304 is fenced by completed-run authority before cached data or status is served',async()=>{
 for(const alteration of ['deleted','missing-pointer','wrong-import','ambiguous-legacy']){
  const api=await storedApi(),first=await api.request(),etag=first.headers.get('etag');assert.ok(etag);await first.json();
  assert.equal((await api.request('',etag)).status,304,'control genuinely exercises the early conditional branch');
  if(alteration==='deleted')api.sqlite.prepare("UPDATE analysis_runs SET status='deleted'").run();
  if(alteration==='missing-pointer')api.pointers.length=0;
  if(alteration==='wrong-import'){const pointer=JSON.parse(api.pointers[0].summary);pointer.analysisRunId='other';api.pointers[0].summary=JSON.stringify(pointer);api.sqlite.prepare('INSERT INTO analysis_runs VALUES(?,?,?,?,?)').run('other','site-1','foreign-import','completed',pointer.objectKey);}
  if(alteration==='ambiguous-legacy'){const pointer=JSON.parse(api.pointers[0].summary);delete pointer.analysisRunId;api.pointers[0].summary=JSON.stringify(pointer);api.sqlite.prepare('INSERT INTO analysis_runs VALUES(?,?,?,?,?)').run('alias','site-1','foreign-import','deleted',pointer.objectKey);}
  api.reads.length=0;
  const response=await api.request('',etag);assert.equal(response.status,200);assert.equal((await response.json()).analysisRequired,true,alteration);
  assert.equal(response.headers.get('etag'),null);assert.deepEqual(api.reads,[],'rejected authority cannot load a derivative or orphan current.json');
  assert.equal((await(await api.request('&statusOnly=1')).json()).cacheStatus,'stale');
  assert.equal((await(await api.request('&issueId=anything')).json()).analysisRequired,true);
 }
});
