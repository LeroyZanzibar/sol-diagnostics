import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource , modelCapacityBindings} from './source-module.mjs';

const time = loadSource('app/telemetry-time.ts');
const causes = loadSource('app/api/performance-summary/causes.ts', [], time);
const events = loadSource('app/api/performance-summary/telemetry-events.ts', [], {...modelCapacityBindings(),...({ ...time, ...causes })});
const zone = 'America/New_York';
const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' });

test('UTC solar position uses the instant directly and matches equivalent legacy local wall time', () => {
  for (const [local, utc] of [['2026-06-01T12:00:00','2026-06-01T16:00:00.000Z'], ['2026-01-01T12:00:00','2026-01-01T17:00:00.000Z']]) {
    const old = causes.solarPosition(local, 40, -75, formatter);
    const current = causes.solarPosition(utc, 40, -75, formatter);
    assert.ok(Math.abs(old.elevation - current.elevation) < 1e-10);
    assert.ok(Math.abs(old.azimuth - current.azimuth) < 1e-10);
  }
});

function telemetryFixture(timestamps, production = 20) {
  const assets = [{ id:'meter', name:'Meter', externalId:'meter', type:'revenue_meter' }, ...['a','b'].map(id => ({ id, name:id, externalId:id, type:'inverter', acRatedCapacityKw:'100' }))];
  const summary = { timezone:zone, intervalMinutes:60, timestamps,
    expectedProduction: timestamps.map(timestamp => ({timestamp, energyKwh:20})),
    intervalIrradiance: timestamps.map(timestamp => ({timestamp, averageWm2:600})),
    equipmentProduction: assets.map(a => ({ equipmentId:a.id, equipmentName:a.name, equipmentType:a.type, externalId:a.id, capacityKw:100, source:'interval_energy', readingCount:timestamps.length, dailyProduction:[], intervalProduction:timestamps.map(timestamp => ({timestamp, energyKwh:a.type === 'revenue_meter' ? production : production / 2})) })),
    dailyProduction:[], totalEnergyKwh:0, latestDate:'', latestDayEnergyKwh:0 };
  return { assets, summary };
}

test('repeated autumn local hour stays two distinct UTC readings and a two-hour outage', () => {
  const timestamps = ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'];
  const { assets, summary } = telemetryFixture(timestamps, 0);
  const plan = events.prepareTelemetry(summary, assets);
  assert.equal(summary.equipmentProduction[0].intervalProduction.length, 2);
  assert.equal(plan.events.length, 2);
  const issues = events.reconcileTelemetry([], plan);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].startDateTime, timestamps[0]);
  assert.equal(issues[0].endDateTime, '2026-11-01T07:30:00.000Z');
  assert.equal(issues[0].durationMinutes, 120);
  assert.equal(issues[0].estimatedLossKwh, 40);
});

test('daily production and latest date are grouped in site timezone', () => {
  const { assets, summary } = telemetryFixture(['2026-06-02T02:00:00.000Z','2026-06-02T03:00:00.000Z']);
  events.prepareTelemetry(summary, assets);
  assert.equal(summary.dailyProduction.length, 1);
  assert.equal(summary.dailyProduction[0].date, '2026-06-01');
  assert.equal(summary.dailyProduction[0].energyKwh, 40);
  assert.equal(summary.latestDate, '2026-06-01');
});

test('native five-minute outage grouping preserves every reading and exact elapsed duration', () => {
  const timestamps = Array.from({length:6}, (_, index) => new Date(Date.UTC(2026,5,1,16,index*5)).toISOString());
  const { assets, summary } = telemetryFixture(timestamps, 0);
  summary.intervalMinutes = 5;
  for (const point of summary.expectedProduction) point.energyKwh = 2;
  const plan = events.prepareTelemetry(summary, assets);
  assert.equal(plan.events.length, 6);
  const issues = events.reconcileTelemetry([], plan);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].startDateTime, '2026-06-01T16:00:00.000Z');
  assert.equal(issues[0].endDateTime, '2026-06-01T16:30:00.000Z');
  assert.equal(issues[0].durationMinutes, 30);
  assert.equal(issues[0].estimatedLossKwh, 12);
  assert.equal(issues[0].evidence.intervalLosses.length, 6);
});

function issue(timestamp, minutes, loss) {
  return { id:'original', type:'Underperformance', category:'Performance', equipmentId:'a', equipmentType:'inverter',
    startDateTime:timestamp, endDateTime:new Date(Date.parse(timestamp)+minutes*60000).toISOString(), durationMinutes:minutes, durationDays:minutes/1440,
    actualEnergyKwh:loss, expectedEnergyKwh:loss*2, estimatedLossKwh:loss, lossPercent:50,
    evidence:{intervalLosses:[{timestamp, lossKwh:loss, countedLossKwh:loss, actualKwh:loss, expectedKwh:loss*2}]} };
}
const causeSummary = { timezone:zone, snowSensorConfigured:true, causeContext:{latitude:'',longitude:'',timeZone:zone,assumptions:causes.expectedAssumptions({})} };

test('UTC intervals split at site-local midnight for snow attribution without losing energy', () => {
  const source = issue('2026-02-01T04:30:00.000Z', 60, 20);
  const rows = causes.attributeCauses([source], {...causeSummary, intervalMinutes:60, snowDays:['2026-02-01']});
  assert.deepEqual(Array.from(rows, r => r.suspectedCause), ['', 'Snow']);
  assert.deepEqual(Array.from(rows, r => r.estimatedLossKwh), [10, 10]);
  assert.equal(rows[0].endDateTime, '2026-02-01T05:00:00.000Z');
  assert.equal(rows[1].startDateTime, '2026-02-01T05:00:00.000Z');
  assert.deepEqual(Array.from(rows[1].evidence.causeLocalDates), ['2026-02-01']);
});

test('local-day cause split respects a 25-hour daylight-saving day', () => {
  const source = issue('2026-11-01T03:30:00.000Z', 27*60, 270);
  const rows = causes.attributeCauses([source], {...causeSummary, intervalMinutes:27*60, snowDays:['2026-11-01']});
  assert.deepEqual(Array.from(rows, r => r.suspectedCause), ['', 'Snow', '']);
  assert.deepEqual(Array.from(rows, r => r.estimatedLossKwh), [5, 250, 15]);
  assert.equal(rows[1].durationMinutes, 25*60);
  assert.equal(rows.reduce((total, row) => total + row.estimatedLossKwh, 0), 270);
});

test('native five-minute cause interval is not rounded when it crosses local midnight', () => {
  const source = issue('2026-02-01T04:58:00.000Z', 5, 5);
  const rows = causes.attributeCauses([source], {...causeSummary, intervalMinutes:5, snowDays:['2026-02-01']});
  assert.deepEqual(Array.from(rows, r => r.suspectedCause), ['', 'Snow']);
  assert.deepEqual(Array.from(rows, r => r.estimatedLossKwh), [2, 3]);
  assert.equal(rows[0].startDateTime, '2026-02-01T04:58:00.000Z');
  assert.equal(rows[0].endDateTime, '2026-02-01T05:00:00.000Z');
  assert.equal(rows[1].endDateTime, '2026-02-01T05:03:00.000Z');
});
