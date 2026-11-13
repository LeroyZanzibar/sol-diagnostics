import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './source-module.mjs';
const { monthlyLosses, splitIssue } = loadSource('app/issue-periods.ts');
const issue = { id: 'outage', startDateTime: '2026-06-29T06:00:00', endDateTime: '2026-07-06T14:00:00', estimatedLossKwh: 100,
  evidence: { intervalLosses: [{ timestamp: '2026-06-30T23:00:00', lossKwh: 20 }, { timestamp: '2026-07-01T00:00:00', lossKwh: 80 }] } };
test('monthly and quarterly portions conserve evidence loss; annual remains one issue', () => {
  const saved = { ...issue, summaryIssueNumber: '#042', summaryPeriods: monthlyLosses(issue, 60) };
  for (const grouping of ['monthly', 'quarterly']) {
    const parts = splitIssue(saved, grouping);
    assert.deepEqual(Array.from(parts, p => p.estimatedLossKwh), [20, 80]);
    assert.equal(parts[0].endDateTime, '2026-07-01T00:00:00');
    assert.equal(parts[1].startDateTime, parts[0].endDateTime);
    assert.ok(parts.every(p => p.id === issue.id && p.summaryIssueNumber === '#042' && p.portionCount === 2));
    assert.equal(new Set(parts.map(p => p.id)).size, 1);
  }
  const annual = splitIssue(saved, 'annual');
  assert.equal(annual.length, 1); assert.equal(annual[0].estimatedLossKwh, 100);
});
test('exclusive ends, year boundaries, leap days and zero-loss portions', () => {
  const value = { ...issue, startDateTime: '2024-02-29T12:00:00', endDateTime: '2024-03-01T00:00:00', estimatedLossKwh: 0 };
  assert.equal(monthlyLosses(value, 60).length, 1);
  const parts = splitIssue({ ...value, startDateTime: '2025-12-31T23:00:00', endDateTime: '2026-01-01T01:00:00' }, 'annual');
  assert.equal(parts.length, 2); assert.ok(parts.every(p => p.estimatedLossKwh === 0));
});
test('uses hierarchy-counted losses and divides only a boundary-straddling interval', () => {
  const value = { ...issue, estimatedLossKwh: 10, evidence: { intervalLosses: [
    { timestamp: '2026-06-30T23:30:00', lossKwh: 40, countedLossKwh: 10 },
    { timestamp: '2026-07-01T01:00:00', lossKwh: 50, countedLossKwh: 0 },
  ] } };
  assert.deepEqual(Array.from(monthlyLosses(value, 60), p => p.estimatedLossKwh), [5, 5]);
});
test('missing or inconsistent evidence is explicit, never time-prorated', () => {
  for (const value of [{ ...issue, evidence: undefined }, { ...issue, estimatedLossKwh: 110 }]) {
    assert.ok(monthlyLosses(value, 60).every(p => p.estimatedLossKwh === null));
    assert.equal(splitIssue(value, 'annual')[0].estimatedLossKwh, value.estimatedLossKwh);
  }
});

test('unknown telemetry loss remains unknown in summary portions and exported rows', () => {
  const helpers = loadSource('app/issue-periods.ts');
  const gap = { ...issue, estimatedLossKwh: null, lossUnknown: true, name: 'Site telemetry outage',
    category: 'Communications', severity: 'high', equipmentName: 'Meter', affectedEquipment: [{ id: 'inv', name: 'Inverter 1' }] };
  gap.summaryPeriods = monthlyLosses(gap, 60);
  assert.ok(splitIssue(gap, 'monthly').every(part => part.estimatedLossKwh === null));
  let workbook;
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const XLSX = { utils: { aoa_to_sheet: rows => ({ rows }), book_new: () => ({}), book_append_sheet: (book, sheet) => { book.sheet = sheet; } }, writeFile: book => { workbook = book; } };
  const { default: Component } = loadSource('app/IssueSummaries.tsx', [], { React, XLSX, ...helpers,
    ...loadSource('app/issue-date-format.ts'), useMemo: fn => fn(), useState: value => [value, () => {}] });
  const nodes = tree => [tree, ...(tree?.children || []).flatMap(child => child && typeof child === 'object' ? nodes(child) : [])];
  const list = nodes(Component({ issues: [gap], siteName: 'Example', onBack() {} }));
  assert.ok(list.some(node => node.children.includes('Unknown')));
  list.find(node => node.type === 'button' && node.props.title?.startsWith('Export')).props.onClick();
  const rows = workbook.sheet.rows.filter(row => row[0] === 'Child issue');
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row[11] === 'Unknown' && row[19] === 'Inverter 1'));
});

test('summary UI and workbook share clipped portions, identifiers, and related-row selection', () => {
  const helpers = loadSource('app/issue-periods.ts');
  let states = [], cursor = 0, captured;
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }) };
  const XLSX = { utils: { aoa_to_sheet: rows => ({ rows }), book_new: () => ({}), book_append_sheet: (book, sheet) => { book.sheet = sheet; } }, writeFile: book => { captured = book.sheet; } };
  const { default: Component } = loadSource('app/IssueSummaries.tsx', [], { React, XLSX, ...helpers, ...loadSource("app/issue-date-format.ts"),
    useMemo: fn => fn(), useState: initial => { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; } });
  const saved = { ...issue, summaryIssueNumber: '#042', summaryPeriods: monthlyLosses(issue, 60), name: 'Site outage', category: 'Performance', severity: 'critical', equipmentId: 'meter', equipmentName: 'Meter', equipmentExternalId: 'MTR-001' };
  const render = () => { cursor = 0; return Component({ issues: [saved], siteName: 'Example', onBack() {} }); };
  const nodes = tree => [tree, ...(tree?.children || []).flatMap(child => child && typeof child === 'object' ? nodes(child) : [])];
  let tree = render(), list = nodes(tree);
  const badges = list.filter(node => node.props.className === 'issue-link-badge');
  assert.equal(badges.length, 2);
  assert.ok(badges.every(node => node.children.includes('#042')));
  badges[0].props.onClick(); list = nodes(render());
  assert.equal(list.filter(node => node.props.className === 'related-issue-selected').length, 2);
  assert.equal(list.filter(node => node.type === 'details' && node.props.open).length, 2);
  list.find(node => node.type === 'button' && node.props.title?.startsWith('Export')).props.onClick();
  const children = captured.rows.filter(row => row[0] === 'Child issue');
  assert.equal(children.length, 2);
  assert.deepEqual(Array.from(children, row => row[11]).sort((a,b) => a-b), [20,80]);
  assert.ok(children.every(row => row[12] === '#042' && row[16] === 'outage'));
  const june = children.find(row => row[1] === 'Jun 2026'), july = children.find(row => row[1] === 'Jul 2026');
  assert.equal(june[8], july[7]);
  list.find(node => node.props['aria-label'] === 'Filter summary period').props.onChange({target:{value:'Jun'}});
  list = nodes(render());
  assert.equal(list.filter(node => node.props.className === 'issue-link-badge').length, 1);
  assert.ok(list.find(node => node.props.className === 'issue-link-badge').children.includes('#042'));
});
