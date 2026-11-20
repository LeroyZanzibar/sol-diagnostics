import test from "node:test";
import assert from "node:assert/strict";
import { loadSource , modelCapacityBindings} from "./source-module.mjs";

const routePath = "app/api/performance-summary/route.ts";
const equipment = [
  { id: "meter", name: "Meter", type: "revenue_meter", externalId: "meter", aliases: "[]", acLineLossPercent: "0", transformerLossPercent: "0" },
  { id: "inv", name: "Inverter", type: "inverter", externalId: "inv", parentId: "meter", acRatedCapacityKw: "100", aliases: "[]" },
  { id: "modules", externalId: "modules", name: "Modules", type: "module_group", parentId: "inv", moduleRatedCapacityW: "400", quantity: 250, aliases: "[]" },
];
const mapping = loadSource("app/meter-mapping.ts");
const time = loadSource("app/telemetry-time.ts");

async function summarize(text, signals, interval = "1 hour", roles = {}) {
  const api = loadSource(routePath, ["buildSummary"], {...modelCapacityBindings(),...({
    ...mapping, ...time,
    getBucketBinding: () => ({ get: async () => ({ body: new Response(text).body }) }),
  })});
  return api.buildSummary({ objectKey: "test.csv", timezone: "UTC", rowCount: 2,
    mapping: JSON.stringify({ roles: { timestamp: "time", ...roles }, equipment: { signals } }),
    validation: JSON.stringify({ interval }),
  }, equipment);
}

test("AC power fallback excludes DC input and conserves interval energy", async () => {
  for (const [interval, hours] of [["1 hour", 1], ["15 min", 0.25], ["5 min", 1 / 12]]) {
    const summary = await summarize("time,meter,ac,dc\n2026-06-01T12:00:00Z,80,80,85\n", [
      { column: "meter", equipmentId: "meter", measurement: "Active power" },
      { column: "ac", equipmentId: "inv", measurement: "Active power" },
      { column: "dc", equipmentId: "inv", measurement: "DC power" },
    ], interval);
    const inverter = summary.equipmentProduction.find(item => item.equipmentId === "inv");
    assert.equal(inverter.source, "active_power");
    assert.ok(Math.abs(inverter.intervalProduction[0].energyKwh - 80 * hours) < 1e-9);
  }
});

test("valid interval energy takes precedence over both AC and DC power", async () => {
  const summary = await summarize("time,meter,energy,ac,dc\n2026-06-01T12:00:00Z,77,77,80,85\n", [
    { column: "meter", equipmentId: "meter", measurement: "Energy" },
    { column: "energy", equipmentId: "inv", measurement: "Energy" },
    { column: "ac", equipmentId: "inv", measurement: "Active power" },
    { column: "dc", equipmentId: "inv", measurement: "DC power" },
  ]);
  const inverter = summary.equipmentProduction.find(item => item.equipmentId === "inv");
  assert.equal(inverter.source, "interval_energy");
  assert.equal(inverter.intervalProduction[0].energyKwh, 77);
});

test("measured zero energy stays zero while an entirely blank Energy series can use AC power", async () => {
  for (const [energy, expected, source] of [["0", 0, "interval_energy"], ["", 80, "active_power"]]) {
    const summary = await summarize(`time,meter,energy,ac,dc\n2026-06-01T12:00:00Z,80,${energy},80,85\n`, [
      { column: "meter", equipmentId: "meter", measurement: "Energy" },
      { column: "energy", equipmentId: "inv", measurement: "Energy" },
      { column: "ac", equipmentId: "inv", measurement: "Active power" },
      { column: "dc", equipmentId: "inv", measurement: "DC power" },
    ]);
    const inverter = summary.equipmentProduction.find(item => item.equipmentId === "inv");
    assert.equal(inverter.source, source);
    assert.equal(inverter.intervalProduction[0].energyKwh, expected);
  }
});

test("DC-only inverter measurements do not become AC production", async () => {
  const summary = await summarize("time,meter,dc\n2026-06-01T12:00:00Z,80,85\n", [
    { column: "meter", equipmentId: "meter", measurement: "Energy" },
    { column: "dc", equipmentId: "inv", measurement: "DC power" },
  ]);
  assert.ok(!summary.equipmentProduction.some(item => item.equipmentId === "inv"));
});

test("long-format DC signals retain their measurement meaning", async () => {
  const summary = await summarize("time,equipment,measurement,value\n2026-06-01T12:00:00Z,meter,Energy,80\n2026-06-01T12:00:00Z,inv,AC power,80\n2026-06-01T12:00:00Z,inv,DC power,85\n", [], "1 hour", {
    equipment: "equipment", measurement: "measurement", value: "value",
  });
  const inverter = summary.equipmentProduction.find(item => item.equipmentId === "inv");
  assert.equal(inverter.intervalProduction[0].energyKwh, 80);
});

test("cumulative energy is rejected rather than counted as interval production", async () => {
  await assert.rejects(summarize("time,meter\n2026-06-01T12:00:00Z,500000\n", [
    { column: "meter", equipmentId: "meter", measurement: "Cumulative energy" },
  ]), /converted to interval energy/);
  await assert.rejects(summarize("time,equipment,measurement,value\n2026-06-01T12:00:00Z,meter,Cumulative energy,500000\n", [], "1 hour", {
    equipment: "equipment", measurement: "measurement", value: "value",
  }), /converted to interval energy/);
});

const attribution = loadSource(routePath, ["applyInverterLossAttribution", "applyLossThreshold", "applyHierarchyLossPriority"], {...modelCapacityBindings(),...(time)});
function issue(id, equipmentType, loss, timestamp = "2026-06-01T12:00:00") {
  return { id, equipmentId: equipmentType === "inverter" ? "inv" : "meter", equipmentType,
    type: equipmentType === "inverter" ? "Equipment outage" : "Site outage", category: "Performance", name: id, estimatedLossKwh: loss, actualEnergyKwh: 100,
    expectedEnergyKwh: 100 + loss, startDateTime: timestamp, endDateTime: "2026-06-01T13:00:00",
    evidence: { intervalLosses: [{ timestamp, lossKwh: loss, actualKwh: 100, expectedKwh: 100 + loss }] } };
}

test("standalone inverter outage losses convert to delivered energy exactly once", () => {
  const adjusted=equipment.map(a=>a.type==='revenue_meter'?{...a,acLineLossPercent:'10',transformerLossPercent:'2'}:a);
  for(const loss of [0,79,80,85,99.999,100,120]){
    const original=issue('inverter','inverter',loss),before=JSON.stringify(original);
    const result=attribution.applyInverterLossAttribution([], [original], adjusted, 60);
    assert.equal(result.meterIssues.length,0);assert.equal(result.equipmentIssues.length,1);
    const converted=result.equipmentIssues[0];assert.ok(Math.abs(converted.estimatedLossKwh-loss*.9*.98)<1e-9);
    assert.equal(converted.evidence.intervalLosses[0].inverterTerminalLossKwh,loss);
    assert.equal(converted.evidence.intervalLosses[0].lossBoundary,'meter_poi');assert.equal(JSON.stringify(original),before);
  }
});

test("site priority removes covered child dates and preserves independent delivered loss", () => {
  const telemetry=loadSource('app/api/performance-summary/telemetry-events.ts',[],{...modelCapacityBindings(),...time});
  const parent=issue('site','revenue_meter',100),child=issue('inverter','inverter',200);
  child.endDateTime='2026-06-01T14:00:00';child.evidence.intervalLosses=[
    {timestamp:'2026-06-01T12:00:00',lossKwh:100,actualKwh:0,expectedKwh:100},
    {timestamp:'2026-06-01T13:00:00',lossKwh:100,actualKwh:0,expectedKwh:100},
  ];
  const adjusted=equipment.map(a=>a.type==='revenue_meter'?{...a,acLineLossPercent:'10'}:a);
  const converted=attribution.applyInverterLossAttribution([parent],[child],adjusted,60);
  const prioritized=attribution.applyHierarchyLossPriority([...converted.meterIssues,...converted.equipmentIssues],adjusted);
  const visible=telemetry.reconcileTelemetry(prioritized,{events:[],blocked:new Map(),inferred:new Map(),minutes:60,assets:adjusted});
  const retained=visible.find(i=>i.equipmentType==='inverter');assert.equal(retained.startDateTime,'2026-06-01T13:00:00');assert.equal(retained.endDateTime,'2026-06-01T14:00:00');
  assert.equal(retained.estimatedLossKwh,90);assert.equal(visible.reduce((s,i)=>s+i.estimatedLossKwh,0),190);
});

test("loss thresholds preserve the unfiltered quantified shortfall separately from visible totals", () => {
  const issues = [issue("site", "revenue_meter", 15), issue("inverter", "inverter", 85)]
    .map(item => ({ ...item, category: "Performance" }));
  for (const [threshold, visible, excluded] of [["", 100, 0], ["20", 85, 15], ["100", 0, 100]]) {
    const result = attribution.applyLossThreshold({ issues, totalLossKwh: 100 }, threshold);
    assert.equal(result.totalLossKwh, visible);
    assert.equal(result.unfilteredTotalLossKwh, 100);
    assert.equal(result.thresholdExcludedLossKwh, excluded);
    assert.equal(result.totalLossKwh + result.thresholdExcludedLossKwh, result.unfilteredTotalLossKwh);
  }
});


test('mapped site expectation blanks and invalid values never borrow another expected channel or become zero',async()=>{
 for(const raw of ['', 'NaN', 'Infinity', '-1', '0', '37']){
  const summary=await summarize(`time,meter,inv,siteExpected,otherExpected\n2026-06-01T12:00Z,0,0,${raw},99\n`,[
   {column:'meter',equipmentId:'meter',measurement:'Energy'}, {column:'inv',equipmentId:'inv',measurement:'Energy'},
   {column:'otherExpected',equipmentId:'meter',measurement:'Expected Production'},
  ],'1 hour',{expectedProduction:'siteExpected'});
  const point=summary.expectedProduction[0];
  if(['','NaN','Infinity'].includes(raw))assert.equal(point,undefined,raw);
  else assert.equal(point.energyKwh,Number(raw));
 }
});
