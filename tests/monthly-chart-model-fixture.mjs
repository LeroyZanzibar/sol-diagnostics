import {readFileSync} from 'node:fs';
import * as domain from '../app/monthly-domain.mjs';
import {loadSource} from './source-module.mjs';

// Expected fractions/display come from the existing independent Python oracle,
// not a second copy of the chart adapter or the domain's production arithmetic.
export const oracle = JSON.parse(readFileSync(new URL('./monthly-calculated-oracle.json', import.meta.url), 'utf8'));
export const metricIds = [
  'onPeak', 'offPeak', 'unpaidEnergy', 'utilityTotal', 'energyUsed',
  'projectedProduction', 'expectedProduction', 'revenue', 'invoiceCost',
  'budgetRevenue', 'actualInsolation', 'projectedInsolation',
  'budgetedSpecificYield', 'actualSpecificYield', 'specificYieldRatio',
  'budgetedPerformanceRatio', 'actualPerformanceRatio', 'performanceRatioRatio',
  'insolationRatio', 'productionProjectionRatio', 'productionExpectedRatio',
  'revenueRatio', 'iapr', 'iar',
];
export const telemetryIds = [
  'expectedProduction', 'actualInsolation', 'actualPerformanceRatio',
  'performanceRatioRatio', 'insolationRatio', 'productionExpectedRatio', 'iapr', 'iar',
];
export function loadChartModel() {
  return loadSource('app/monthly-chart-model.ts', [], {...domain, Error, TypeError, RangeError});
}
export function snapshot(c = oracle.cases[0], siteId = 'chart-site') {
  const metric = value => ({value, state: value === null ? 'missing' : 'complete', coveredMilliseconds: 2678400000,
    partialIntervals: 0, unknownQualityIntervals: 0, negativeIntervals: 0});
  const result = {
    siteId, revision: 7,
    configuration: {...domain.emptyConfiguration(), operationsStart: '2026-01-01', degradation: '0'},
    utility: {[c.month]: structuredClone(c.utility)},
    projections: [structuredClone(c.projection)],
    capacity: {dcKwp: structuredClone(c.capacity), unavailableReason: null},
    telemetry: {state: 'current', sourceRevision: 23, timezone: 'America/New_York',
      selectedChannelId: 'site|selected-irradiance', selectionRequired: false,
      expectedChannelId: 'site|named-expected', expectedUnavailableReason: null, candidates: [],
      months: {[c.month]: {expected: metric(c.expected), insolation: {...metric(c.insolation),
        source: 'Imported irradiance; satellite/POA provenance unknown'}, expectedMilliseconds: 2678400000}}},
  };
  result.calculated = domain.calculatedRows(result.projections, result.utility, result.telemetry, result.capacity);
  return result;
}
export function settings(overrides = {}) {
  return {start: '2026-01', end: '2026-01', type: 'line', comparisonYears: 0, metrics: [...metricIds], ...overrides};
}
export const plain = value => JSON.parse(JSON.stringify(value));
export const emptyUtility = () => ({onPeak: null, offPeak: null, unpaidEnergy: null, revenue: null, energyUsed: null, invoiceCost: null});
export function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freezeDeep(item);
  }
  return value;
}
