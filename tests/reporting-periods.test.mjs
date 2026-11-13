import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './source-module.mjs';

const time = loadSource('app/telemetry-time.ts');
const periods = loadSource('app/issue-periods.ts', [], time);
const { clipIssueToReport, monthlyLosses, splitIssue, periodKey } = periods;
const { formatDateTime } = loadSource('app/issue-date-format.ts', [], time);

const outage = {
  id: 'outage', timezone: 'America/New_York', intervalMinutes: 60,
  startDateTime: '2026-09-29T04:00:00.000Z', endDateTime: '2026-10-04T04:00:00.000Z',
  estimatedLossKwh: 150, expectedEnergyKwh: 200, actualEnergyKwh: 50,
  intervalLosses: [
    { timestamp: '2026-09-29T16:00:00.000Z', lossKwh: 10, actualKwh: 10, expectedKwh: 20 },
    { timestamp: '2026-09-30T16:00:00.000Z', lossKwh: 20, actualKwh: 10, expectedKwh: 30 },
    { timestamp: '2026-10-01T16:00:00.000Z', lossKwh: 30, actualKwh: 10, expectedKwh: 40 },
    { timestamp: '2026-10-02T16:00:00.000Z', lossKwh: 40, actualKwh: 10, expectedKwh: 50 },
    { timestamp: '2026-10-03T16:00:00.000Z', lossKwh: 50, actualKwh: 10, expectedKwh: 60 },
  ],
};

test('month report includes overlapping event and only its October interval energy', () => {
  const clipped = clipIssueToReport(outage, { from: '2026-10-01', through: '2026-10-31' });
  assert.equal(clipped.estimatedLossKwh, 120);
  assert.equal(clipped.actualEnergyKwh, 30);
  assert.equal(clipped.expectedEnergyKwh, 150);
  assert.equal(clipped.lossPercent, 80);
  assert.equal(clipped.startDateTime, '2026-10-01T04:00:00.000Z');
  assert.equal(clipped.originalStart, outage.startDateTime);
  assert.equal(clipped.intervalLosses.length, 3);
  assert.equal(splitIssue(clipped, 'monthly')[0].estimatedLossKwh, 120);
});

test('inclusive through date, exclusive event ends and one-sided report bounds', () => {
  assert.equal(clipIssueToReport(outage, { from: '', through: '2026-09-30' }).estimatedLossKwh, 30);
  assert.equal(clipIssueToReport(outage, { from: '2026-10-04', through: '' }), null);
  assert.equal(clipIssueToReport(outage, { from: '', through: '2026-09-28' }), null);
  assert.equal(clipIssueToReport(outage, { from: '2026-10-31', through: '2026-10-01' }), null);
  assert.equal(clipIssueToReport(outage, { from: '', through: '' }), outage);
});

test('hierarchy-counted losses are clipped and only boundary-straddling intervals are divided', () => {
  const issue = { ...outage, estimatedLossKwh: 10, startDateTime: '2026-10-01T03:30:00.000Z', endDateTime: '2026-10-01T04:30:00.000Z',
    intervalLosses: [{ timestamp: '2026-10-01T03:30:00.000Z', intervalMinutes: 60, lossKwh: 40, countedLossKwh: 10 }] };
  const clipped = clipIssueToReport(issue, { from: '2026-10-01', through: '2026-10-01' });
  assert.equal(clipped.estimatedLossKwh, 5);
  assert.equal(clipped.intervalLosses[0].intervalMinutes, 30);
  assert.equal(clipped.intervalLosses[0].timestamp, '2026-10-01T04:00:00.000Z');
  assert.equal(clipped.lossPercent, null);
});

test('missing/inconsistent/unknown evidence stays unknown when clipping, with no event-duration proration', () => {
  for (const issue of [{ ...outage, intervalLosses: undefined }, { ...outage, estimatedLossKwh: 999 }, { ...outage, estimatedLossKwh: null, lossUnknown: true }]) {
    const clipped = clipIssueToReport(issue, { from: '2026-10-01', through: '2026-10-31' });
    assert.equal(clipped.estimatedLossKwh, null);
    assert.equal(clipped.lossUnknown, true);
    assert.equal(clipped.summaryPeriods[0].estimatedLossKwh, null);
  }
});

test('local month allocation differs from UTC month allocation and conserves all losses', () => {
  const issue = { ...outage, startDateTime: '2026-10-01T03:00:00.000Z', endDateTime: '2026-10-01T05:00:00.000Z', estimatedLossKwh: 60,
    intervalLosses: [{ timestamp: '2026-10-01T03:00:00.000Z', lossKwh: 20 }, { timestamp: '2026-10-01T04:00:00.000Z', lossKwh: 40 }] };
  const parts = monthlyLosses(issue, 60);
  assert.deepEqual(Array.from(parts, part => part.estimatedLossKwh), [20, 40]);
  assert.equal(parts[0].endDateTime, '2026-10-01T04:00:00.000Z');
  assert.equal(periodKey(issue.startDateTime, 'monthly', issue.timezone), Date.UTC(2026, 8, 1));
});

test('reporting day during fall DST transition spans 25 hours and preserves both 1:30 intervals', () => {
  const issue = { ...outage, startDateTime: '2026-10-31T04:00:00.000Z', endDateTime: '2026-11-03T05:00:00.000Z', estimatedLossKwh: 30,
    intervalLosses: [{ timestamp: '2026-11-01T05:30:00.000Z', intervalMinutes: 30, lossKwh: 10 }, { timestamp: '2026-11-01T06:30:00.000Z', intervalMinutes: 30, lossKwh: 20 }] };
  const clipped = clipIssueToReport(issue, { from: '2026-11-01', through: '2026-11-01' });
  assert.equal(clipped.durationMinutes, 25 * 60);
  assert.equal(clipped.estimatedLossKwh, 30);
  assert.equal(clipped.startDateTime, '2026-11-01T04:00:00.000Z');
  assert.equal(clipped.endDateTime, '2026-11-02T05:00:00.000Z');
  const first = formatDateTime(issue.intervalLosses[0].timestamp, issue.timezone), second = formatDateTime(issue.intervalLosses[1].timestamp, issue.timezone);
  assert.match(first, /2026\/11\/01 1:30/);
  assert.match(second, /2026\/11\/01 1:30/);
  assert.notEqual(first, second);
});

test('legacy site-local saved times remain local and can use their interval evidence', () => {
  const legacy = { ...outage, startDateTime: '2026-09-29T00:00:00', endDateTime: '2026-10-04T00:00:00',
    intervalLosses: outage.intervalLosses.map(item => ({ ...item, timestamp: item.timestamp.slice(0, 19) })) };
  const clipped = clipIssueToReport(legacy, { from: '2026-10-01', through: '2026-10-31' });
  assert.equal(clipped.estimatedLossKwh, 120);
  assert.equal(clipped.startDateTime, '2026-10-01T00:00:00');
  assert.equal(formatDateTime(clipped.startDateTime, legacy.timezone), '2026/10/01 0:00');
});

test('calendar ranges handle zones whose daylight saving begins at midnight', () => {
  const from = periods.calendarDayMoment('2024-09-08', 'America/Santiago');
  const through = periods.calendarDayMoment('2024-09-09', 'America/Santiago');
  assert.equal(time.localTimestamp(new Date(from).toISOString(), 'America/Santiago'), '2024-09-08T01:00:00');
  assert.equal((through - from) / 3600000, 23);
});

test('summary UI/export use report-clipped amounts and site-local period labels', () => {
  const clipped = clipIssueToReport({ ...outage, name: 'Site outage', category: 'Performance', severity: 'critical', equipmentId: 'meter', equipmentName: 'Meter', equipmentExternalId: 'MTR' }, { from: '2026-10-01', through: '2026-10-31' });
  const sheets = {};
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const XLSX = { utils: { aoa_to_sheet: rows => ({ rows }), book_new: () => ({}), book_append_sheet: (_book, sheet, name) => { sheets[name] = sheet; } }, writeFile() {} };
  const { default: Component } = loadSource('app/IssueSummaries.tsx', [], { React, XLSX, ...periods, formatDateTime, useMemo: fn => fn(), useState: value => [value, () => {}] });
  const nodes = tree => [tree, ...(tree?.children || []).flatMap(child => child && typeof child === 'object' ? nodes(child) : [])];
  const list = nodes(Component({ issues: [clipped], siteName: 'Example', onBack() {}, reportRange: { from: '2026-10-01', through: '2026-10-31' }, timezone: outage.timezone }));
  list.find(node => node.type === 'button' && node.props.title?.startsWith('Export')).props.onClick();
  const row = sheets.Summaries.rows.find(row => row[0] === 'Child issue');
  assert.equal(row[1], 'Oct 2026');
  assert.equal(row[11], 120);
  assert.match(row[7], /^2026\/10\/01 0:00/);
  assert.equal(sheets['Reporting period'].rows[2][1], outage.timezone);
});
