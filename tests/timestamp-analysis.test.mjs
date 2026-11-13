import test from "node:test";
import assert from "node:assert/strict";
import { loadSource , modelCapacityBindings} from "./source-module.mjs";

const time = loadSource("app/telemetry-time.ts");
const mapping = loadSource("app/meter-mapping.ts");
const assets = [
  { id: "meter", type: "revenue_meter", name: "Meter", externalId: "meter", aliases: "[]" },
  { id: "sun", type: "weather_sensor", name: "POA", externalId: "sun", aliases: "[]" },
];
async function summarize(rows, validation = {}, timezone = "UTC", measurement = "Energy") {
  const csv = "time,actual,expected,poa\n" + rows.join("\n");
  const { buildSummary } = loadSource("app/api/performance-summary/route.ts", ["buildSummary"], {...modelCapacityBindings(),...({
    ...time, ...mapping, getBucketBinding: () => ({ get: async () => ({ body: new Response(csv).body }) }),
  })});
  return buildSummary({ timezone, objectKey: "fixture", rowCount: rows.length,
    validation: JSON.stringify(validation), mapping: JSON.stringify({ roles: { timestamp: "time", expectedProduction: "expected" },
      equipment: { signals: [{ column: "actual", equipmentId: "meter", measurement }, { column: "poa", equipmentId: "sun", measurement: "POA irradiance" }] } }),
  }, assets);
}

test("five-minute actual and expected energies stay separate and conserve totals", async () => {
  const summary = await summarize(["2026-06-01 12:00,1,2,600", "2026-06-01 12:05,3,4,600", "2026-06-01 12:10,5,6,600"]);
  assert.equal(summary.intervalMinutes, 5);
  assert.deepEqual(Array.from(summary.timestamps), ["2026-06-01T12:00:00.000Z", "2026-06-01T12:05:00.000Z", "2026-06-01T12:10:00.000Z"]);
  assert.equal(summary.totalEnergyKwh, 9);
  assert.equal(summary.expectedProduction.reduce((sum, p) => sum + p.energyKwh, 0), 12);
  assert.ok(Math.abs(summary.dailyIrradiance[0].insolationKwhM2 - .15) < 1e-9);
});

test("native cadence overrides rounded legacy interval text and missing rows do not extend power readings", async () => {
  const ninety = await summarize(["2026-06-01T00:00Z,80,100,600", "2026-06-01T01:30Z,80,100,600"], { interval: "2 hour" }, "UTC", "Active power");
  assert.equal(ninety.intervalMinutes, 90);
  assert.equal(ninety.totalEnergyKwh, 240);
  const gaps = await summarize(["2026-06-01T12:00Z,60,5,600", "2026-06-01T12:05Z,60,5,600", "2026-06-01T12:20Z,60,5,600"], {}, "UTC", "Active power");
  assert.equal(gaps.intervalMinutes, 5);
  assert.equal(gaps.totalEnergyKwh, 15);
});

test("repeated daylight-saving hours preserve distinct actual and expected readings", async () => {
  const summary = await summarize(["2026-11-01T01:30:00-04:00,10,20,100", "2026-11-01T01:30:00-05:00,30,40,100"], {}, "America/New_York");
  assert.equal(summary.timestamps.length, 2);
  assert.equal(summary.intervalMinutes, 60);
  assert.equal(summary.totalEnergyKwh, 40);
  assert.equal(summary.expectedProduction.reduce((sum, point) => sum + point.energyKwh, 0), 60);
  assert.equal(summary.dailyProduction[0].date, "2026-11-01");
});

test("end-labelled data shifts production, weather and expected energy together across local midnight", async () => {
  const summary = await summarize(["2026-10-01 00:00,10,20,600", "2026-10-01 01:00,30,40,600"], { timestampConvention: "end" }, "America/New_York");
  const expected = ["2026-10-01T03:00:00.000Z", "2026-10-01T04:00:00.000Z"];
  for (const series of [summary.expectedProduction, summary.intervalIrradiance, summary.equipmentProduction[0].intervalProduction])
    assert.deepEqual(Array.from(series, point => point.timestamp), expected);
  assert.deepEqual(Array.from(summary.dailyProduction, p => [p.date, p.energyKwh]), [["2026-09-30", 10], ["2026-10-01", 30]]);
});

test("analysis rejects ambiguous local times and inconsistent cadence rather than silently merging", async () => {
  await assert.rejects(summarize(["2026-11-01 01:30,10,20,600"], { interval: "1 hour" }, "America/New_York"), /explicit UTC offset/);
  await assert.rejects(summarize(["2026-06-01T12:00Z,1,2,600", "2026-06-01T12:05Z,1,2,600", "2026-06-01T12:12Z,1,2,600"]), /inconsistent interval lengths/);
});

test("native sub-minute issue bounds and duration retain source precision", () => {
  const { analyzeEquipment } = loadSource("app/api/performance-summary/route.ts", ["analyzeEquipment"], {...modelCapacityBindings(),...(time)});
  const points = Array.from({ length: 6 }, (_, index) => ({ timestamp: new Date(Date.UTC(2026, 5, 1, 12, 0, index * 30)).toISOString(), energyKwh: index === 3 ? .1 : .5 }));
  const sun = new Map(points.map(point => [point.timestamp, { timestamp: point.timestamp, averageWm2: 600, insolationKwhM2: .005 }]));
  const result = analyzeEquipment({ equipmentId: "inv", equipmentName: "Inverter", equipmentType: "inverter", capacityKw: 100, intervalProduction: points }, sun, .5, 100, new Map(), 100);
  assert.equal(result.length, 1);
  assert.equal(result[0].startDateTime, "2026-06-01T12:01:30.000Z");
  assert.equal(result[0].endDateTime, "2026-06-01T12:02:00.000Z");
  assert.equal(result[0].durationMinutes, .5);
});
