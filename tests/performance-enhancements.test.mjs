import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadSource, makeAnalysisFixture , modelCapacityBindings} from "./source-module.mjs";

const checkpointStorage = loadSource("app/api/performance-summary/checkpoint-storage.ts");
const time = loadSource("app/telemetry-time.ts");
const causes = { ...time, ...loadSource("app/api/performance-summary/causes.ts", [], time) };
Object.assign(causes, loadSource("app/api/performance-summary/peer-comparison.ts", [], {...modelCapacityBindings(),...time}));
Object.assign(causes, loadSource("app/api/performance-summary/telemetry-events.ts", [], {...modelCapacityBindings(),...(causes)}), loadSource("app/meter-mapping.ts"));
const routePath = "app/api/performance-summary/route.ts";
const analysis = loadSource(routePath, ["buildAnalysis", "arrayModelRevision"], {...modelCapacityBindings(),...(causes)});
const csv = loadSource("app/telemetry-csv.ts", [], {...modelCapacityBindings(),...(loadSource("app/telemetry-time.ts"))});

test("analysis regression covers gaps, outages, attribution and imported weather-adjusted expectations", () => {
  // Snapshots include cross-checked telemetry events and clipped child intervals.
  // Scenario tests verify classifications; these also enforce loss conservation.
  // Parser 28 groups recurring findings within five calendar days without changing loss.
  // Snapshots include the new attribution methodology. Meter/outage and
  // missing-reading scenarios are also checked independently in scenario tests.
  const cases = [
    [[3, 2, 0], "a028126768082d7a677e7f3fa59b94cd8c208a9aa71adc418bf53beaf5b3043b",1588.8],
    [[50, 4, 0], "c824064d78259013338789057e0ef490948f42aa36c0b5d0962fe66c1a26e923",31961.492352],
    [[90, 8, 3], "55f3f99c66c9a6fe45f162b9d25c41d3765e3dc8a9db6943297fec7cca8d6644",107160.88384492967],
  ];
  for (const [args, expected, total] of cases) {
    const fixture = makeAnalysisFixture(...args);
    const result = analysis.buildAnalysis(fixture.summary, fixture.equipment);
    const counted = result.issues.flatMap(issue => issue.evidence.intervalLosses)
      .reduce((sum, point) => sum + (point.countedLossKwh ?? point.lossKwh), 0);
    assert.ok(Math.abs(counted - result.totalLossKwh) < 1e-6);
    assert.ok(result.issues.filter(issue => issue.lossUnknown).every(issue => issue.estimatedLossKwh === 0));
    assert.ok(Math.abs(result.totalLossKwh-total)<1e-7);
    assert.equal(createHash("sha256").update(JSON.stringify(result)).digest("hex"), expected);
  }
});

async function storedApi(parserVersion = 28) {
  const { summary, equipment } = makeAnalysisFixture(20, 3);
  const revision = await analysis.arrayModelRevision(equipment);
  const record = { id: "import-1", siteId: "site-1", createdAt: "2026-01-01", timezone: "UTC", validation: "{}" };
  const payload = { siteId: "site-1", importId: record.id, parserVersion, modelRevision: revision, timeZone: "UTC",
    issueDatabase: { analysisRunId: "run-1", persistedIssueCount: 10 },
    summary: { dailyProduction: [{ date: "2026-01-01", energyKwh: 500 }], totalEnergyKwh: 500 },
    analysis: analysis.buildAnalysis(summary, equipment) };
  let threshold = "";
  const reads = [], writes = [];
  const objects = new Map();
  objects.set("analysis/site-1/current.json", { text: JSON.stringify(payload), etag: "full-1", customMetadata: {
    siteId: "site-1", importId: record.id, parserVersion: String(parserVersion), modelRevision: revision,
  } });
  const tables = { sites: [{ id: "site-1" }], imports: [record], equipment, pointers: [] };
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
    getDatabaseBinding: () => ({ prepare: () => ({ bind: () => ({ first: async () => ({ minimum_issue_loss_kwh: threshold }) }) }) }),
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
    readJob: async () => null,
    getOrCreateJob: async () => ({ status: "processing", stage: "read", attempt_id: "new-attempt" }),
    jobProgress: job => ({ status: job.status, stage: job.stage, percent: 0 }),
  })});
  const request = (query = "", etag = "") => api.GET(new Request(`https://example.test/api/performance-summary?siteId=site-1${query}`, {
    headers: etag ? { "If-None-Match": etag } : {},
  }));
  return { request, payload, record, equipment, objects, reads, writes, setThreshold(value) { threshold = value; } };
}

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
  assert.equal(api.objects.get("analysis/site-1/display.json").customMetadata.displayVersion, "4");
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

test("older cached analyses are invalidated before serving corrected calculations", async () => {
 for (const version of [19, 24]) {
  const api = await storedApi(version);
  const status = await (await api.request("&statusOnly=1")).json();
  assert.equal(status.cacheStatus, "stale");
  const response = await api.request();
  assert.equal(response.status, 202);
  assert.equal((await response.json()).progress.stage, "read");
  assert.ok(!api.reads.includes("analysis/site-1/current.json"));
  assert.equal(api.writes.length, 0);
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
  assert.equal(api.objects.get("analysis/site-1/display.json").customMetadata.displayVersion, "4");
});

test("threshold, import, model and source changes invalidate conditional results", async () => {
  const api = await storedApi();
  const tag = (await api.request()).headers.get("ETag");
  api.setThreshold("999999999");
  const filtered = await api.request("", tag);
  assert.equal(filtered.status, 200);
  assert.notEqual(filtered.headers.get("ETag"), tag);
  assert.ok((await filtered.json()).analysis.issues.every(issue => issue.category === "Communications"));
  api.record.id = "import-2";
  assert.equal((await api.request("", tag)).status, 202);
  api.record.id = "import-1";
  api.equipment[1].acRatedCapacityKw = "110";
  assert.equal((await api.request("", tag)).status, 202);
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
