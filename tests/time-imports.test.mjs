import test from "node:test";
import assert from "node:assert/strict";
import { loadSource , modelCapacityBindings} from "./source-module.mjs";

const time = loadSource("app/telemetry-time.ts");
const csv = loadSource("app/telemetry-csv.ts", [], {...modelCapacityBindings(),...(time)});
const mapping = { timestamp: "Timestamp", expectedProduction: "", equipment: "", measurement: "", value: "", unit: "" };
const signals = [{ column: "Energy", equipmentId: "meter", measurement: "Energy", confidence: "high", reason: "test" }];

test("naive source timestamps become UTC without rounding native seconds or milliseconds", () => {
  assert.equal(time.parseTelemetryTimestamp("2026-07-01 12:05:17.125", "America/New_York"), "2026-07-01T16:05:17.125Z");
  assert.equal(time.parseTelemetryTimestamp("07/01/2026 12:05:17 PM", "America/New_York"), "2026-07-01T16:05:17.000Z");
  assert.equal(time.parseTelemetryTimestamp("2026-07-01 12:05:00", "Asia/Kathmandu"), "2026-07-01T06:20:00.000Z");
});

test("repeated daylight-saving wall time requires an offset and explicit instants stay distinct", () => {
  assert.equal(time.inspectTelemetryTimestamp("2026-11-01 01:30:00", "America/New_York").reason, "ambiguous");
  const first = time.parseTelemetryTimestamp("2026-11-01T01:30:00-04:00", "America/New_York");
  const second = time.parseTelemetryTimestamp("2026-11-01T01:30:00-05:00", "America/New_York");
  assert.equal(first, "2026-11-01T05:30:00.000Z");
  assert.equal(second, "2026-11-01T06:30:00.000Z");
  assert.notEqual(first, second);
  assert.equal(time.localTimestamp(first, "America/New_York"), "2026-11-01T01:30:00");
  assert.equal(time.localTimestamp(second, "America/New_York"), "2026-11-01T01:30:00");
});

test("nonexistent spring-forward time and invalid calendar dates are rejected", () => {
  assert.equal(time.inspectTelemetryTimestamp("2026-03-08 02:30:00", "America/New_York").reason, "nonexistent");
  assert.equal(time.parseTelemetryTimestamp("2026-02-30 12:00", "UTC"), "");
  assert.equal(time.parseTelemetryTimestamp("2026-02-30T12:00:00Z", "UTC"), "");
  assert.equal(time.parseTelemetryTimestamp("2026-01-01 25:00", "UTC"), "");
  assert.equal(time.parseTelemetryTimestamp("2026-01-01 12:00", "not/a-zone"), "");
});

test("half-hour daylight-saving transitions are also disambiguated", () => {
  assert.equal(time.inspectTelemetryTimestamp("2026-04-05 01:45:00", "Australia/Lord_Howe").reason, "ambiguous");
  assert.equal(time.inspectTelemetryTimestamp("2026-10-04 02:15:00", "Australia/Lord_Howe").reason, "nonexistent");
});

test("native five-minute cadence and interval-end convention survive validation", () => {
  const checked = csv.calculateValidation(["Timestamp", "Energy"], [["2026-07-01 12:00", "8"], ["2026-07-01 12:05", "8"], ["2026-07-01 12:10", "8"]], mapping, signals, "America/New_York", "end");
  assert.equal(checked.intervalMinutes, 5);
  assert.equal(checked.interval, "5 min");
  assert.equal(checked.start, "2026-07-01T16:00:00.000Z");
  assert.equal(checked.timestampConvention, "end");
  assert.equal(checked.timezone, "America/New_York");
  assert.equal(checked.errors, 0);
});

test("validation recalculates cached timestamps when the selected source timezone changes", () => {
  const rows = [["2026-07-01 12:00", "8"], ["2026-07-01 13:00", "8"]];
  const utc = csv.calculateValidation(["Timestamp", "Energy"], rows, mapping, signals, "UTC");
  const eastern = csv.calculateValidation(["Timestamp", "Energy"], rows, mapping, signals, "America/New_York");
  assert.equal(Date.parse(eastern.start) - Date.parse(utc.start), 4 * 3600000);
});

test("DST validation reports ambiguous and nonexistent rows as blocking errors", () => {
  const checked = csv.calculateValidation(["Timestamp", "Energy"], [["2026-03-08 02:30", "8"], ["2026-11-01 01:30", "8"]], mapping, signals, "America/New_York");
  assert.equal(checked.ambiguousTimestamps, 1);
  assert.equal(checked.nonexistentTimestamps, 1);
  assert.equal(checked.invalidTimestamps, 2);
  assert.equal(checked.errors, 2);
});

test("offset-aware repeated hours are not duplicate intervals and retain hourly cadence", () => {
  const checked = csv.calculateValidation(["Timestamp", "Energy"], [["2026-11-01T01:30:00-04:00", "8"], ["2026-11-01T01:30:00-05:00", "9"]], mapping, signals, "America/New_York");
  assert.equal(checked.duplicateTimestamps, 0);
  assert.equal(checked.intervalMinutes, 60);
  assert.equal(checked.errors, 0);
});

test("cumulative meter registers are distinguished and blocked until converted to interval energy", () => {
  assert.equal(csv.suggestedMeasurement("cumulative meter kWh"), "Cumulative energy");
  assert.equal(csv.suggestedMeasurement("Energy register kWh"), "Cumulative energy");
  const checked = csv.calculateValidation(["Timestamp", "Energy"], [["2026-07-01 12:00", "1000"], ["2026-07-01 13:00", "1100"]], mapping, [{ ...signals[0], measurement: "Cumulative energy" }], "UTC");
  assert.equal(checked.cumulativeEnergySignals, 1);
  assert.equal(checked.errors, 1);
});

test("irregular cadence is blocked before upload but missing whole intervals are allowed", () => {
  const irregular = csv.calculateValidation(["Timestamp", "Energy"], [["2026-07-01 12:00", "8"], ["2026-07-01 12:05", "8"], ["2026-07-01 12:11", "8"]], mapping, signals, "UTC");
  assert.equal(irregular.inconsistentIntervals, 1);
  assert.equal(irregular.errors, 1);
  const gaps = csv.calculateValidation(["Timestamp", "Energy"], [["2026-07-01 12:00", "8"], ["2026-07-01 12:05", "8"], ["2026-07-01 12:15", "8"]], mapping, signals, "UTC");
  assert.equal(gaps.intervalMinutes, 5);
  assert.equal(gaps.inconsistentIntervals, 0);
  assert.equal(gaps.errors, 0);
});

test("one unique timestamp cannot silently invent an interval duration", () => {
  const checked = csv.calculateValidation(["Timestamp", "Energy"], [["2026-07-01 12:00", "8"]], mapping, signals, "UTC");
  assert.equal(checked.intervalMinutes, 0);
  assert.equal(checked.errors, 1);
});

test("asynchronous snow/status observations do not change the interval-meter cadence", () => {
  const checked = csv.calculateValidation(["Timestamp", "Energy", "Snow"], [["2026-07-01 12:00", "8", ""], ["2026-07-01 13:00", "8", ""], ["2026-07-01 23:59", "", "70"]], mapping, [...signals, { column: "Snow", equipmentId: "snow", measurement: "Snow code", confidence: "high", reason: "test" }], "UTC");
  assert.equal(checked.intervalMinutes, 60);
  assert.equal(checked.inconsistentIntervals, 0);
  assert.equal(checked.errors, 0);
});

test("asynchronous long-format status rows do not become energy interval boundaries", () => {
  const checked = csv.calculateValidation(["Timestamp", "Equipment", "Measurement", "Value"], [["2026-07-01 12:00", "meter", "Energy", "8"], ["2026-07-01 13:00", "meter", "Energy", "8"], ["2026-07-01 23:59", "snow", "Snow code", "70"]], { ...mapping, equipment: "Equipment", measurement: "Measurement", value: "Value" }, [], "UTC");
  assert.equal(checked.intervalMinutes, 60);
  assert.equal(checked.inconsistentIntervals, 0);
  assert.equal(checked.errors, 0);
});
