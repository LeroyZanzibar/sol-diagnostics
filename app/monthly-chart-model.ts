import {
  calculatedFields, formatCalculatedValue, formatValue, fraction, utilityFields, utilityTotal,
  type Fraction, type MonthlyCalculatedField, type ProjectionRow, type UtilityField,
} from './monthly-domain.mjs';
import type {MonthlyMetric, MonthlySnapshot} from './monthly-types';
import type {
  ChartMetricDefinition, ChartMetricId, ChartPanel, ChartPoint, ChartReadState,
  ChartSeries, ChartSettings, MonthRange,
} from './chart-types';

/** Source identities and units are stable across every renderer and saved view. */
export const chartMetrics: readonly ChartMetricDefinition[] = [
  {id: 'onPeak', label: 'On-peak production', unit: 'kWh', group: 'Production', telemetry: false, color: '#287a66', description: 'Saved utility on-peak production.'},
  {id: 'offPeak', label: 'Off-peak production', unit: 'kWh', group: 'Production', telemetry: false, color: '#4777aa', description: 'Saved utility off-peak production.'},
  {id: 'unpaidEnergy', label: 'Unpaid energy', unit: 'kWh', group: 'Production', telemetry: false, color: '#94743a', description: 'Saved utility unpaid production, included in the utility total.'},
  {id: 'utilityTotal', label: 'Utility actual production total', unit: 'kWh', group: 'Production', telemetry: false, color: '#23614f', description: 'On-peak + off-peak + unpaid energy; sums the present saved values without treating blanks as zero.'},
  {id: 'energyUsed', label: 'Utility energy used', unit: 'kWh', group: 'Production', telemetry: false, color: '#8c6199', description: 'Saved utility energy used, not generation.'},
  {id: 'projectedProduction', label: 'Projected production', unit: 'kWh', group: 'Production', telemetry: false, color: '#b3872f', description: 'Saved projection after operations-start proration and annual degradation.'},
  {id: 'expectedProduction', label: 'Expected Production', unit: 'kWh', group: 'Production', telemetry: true, color: '#5c81b3', description: 'Monthly total of imported hourly Expected Production, already weather-adjusted; not the budget projection.'},
  {id: 'revenue', label: 'Utility revenue', unit: '$', group: 'Revenue', telemetry: false, color: '#32736b', description: 'Saved utility revenue; signed values are retained.'},
  {id: 'invoiceCost', label: 'Invoice energy used cost', unit: '$', group: 'Revenue', telemetry: false, color: '#ab6051', description: 'Saved invoice energy used cost; signed values are retained.'},
  {id: 'budgetRevenue', label: 'Budgeted revenue', unit: '$', group: 'Revenue', telemetry: false, color: '#c18d49', description: 'Saved revenue projection after operations-start proration and annual degradation.'},
  {id: 'actualInsolation', label: 'Actual insolation', unit: 'kWh/m²', group: 'Insolation', telemetry: true, color: '#ae6e2d', description: 'Monthly uploaded POA interval energy: sum Wh/m² / 1000 by local month, regardless of source labels.'},
  {id: 'projectedInsolation', label: 'Projected insolation', unit: 'kWh/m²', group: 'Insolation', telemetry: false, color: '#8e8a35', description: 'Saved insolation projection, prorated for operations start but never degraded.'},
  {id: 'budgetedSpecificYield', label: 'Budgeted specific yield', unit: 'kWh/kWp', group: 'Performance', telemetry: false, color: '#526e9c', description: 'Projected production / saved connected module DC kWp.'},
  {id: 'actualSpecificYield', label: 'Actual specific yield', unit: 'kWh/kWp', group: 'Performance', telemetry: false, color: '#8466a8', description: 'Utility actual production total / saved connected module DC kWp.'},
  {id: 'specificYieldRatio', label: 'Actual / budgeted specific yield', unit: '%', group: 'Performance', telemetry: false, color: '#c07084', description: 'Actual specific yield / budgeted specific yield.'},
  {id: 'budgetedPerformanceRatio', label: 'Budgeted performance ratio', unit: '%', group: 'Performance', telemetry: false, color: '#607a45', description: 'Budgeted specific yield / projected insolation × reference irradiance (1 kW/m²). Conventional PR expects matching POA insolation.'},
  {id: 'actualPerformanceRatio', label: 'Actual performance ratio', unit: '%', group: 'Performance', telemetry: true, color: '#3d8c84', description: 'Actual specific yield / actual insolation × reference irradiance (1 kW/m²). Conventional PR expects matching POA insolation.'},
  {id: 'performanceRatioRatio', label: 'Actual / budgeted performance ratio', unit: '%', group: 'Performance', telemetry: true, color: '#9771b3', description: 'Actual performance ratio / budgeted performance ratio; actual insolation uses the selected uploaded POA series.'},
  {id: 'insolationRatio', label: 'Actual / projected insolation', unit: '%', group: 'Performance', telemetry: true, color: '#a59b43', description: 'Actual insolation / projected insolation.'},
  {id: 'productionProjectionRatio', label: 'Utility actual production total / projected production', unit: '%', group: 'Performance', telemetry: false, color: '#a45b83', description: 'Utility actual production total / projected production.'},
  {id: 'productionExpectedRatio', label: 'Utility actual production total / expected production', unit: '%', group: 'Performance', telemetry: true, color: '#587cb5', description: 'Utility actual production total / imported hourly Expected Production monthly total.'},
  {id: 'revenueRatio', label: 'Utility actual revenue / budgeted revenue', unit: '%', group: 'Performance', telemetry: false, color: '#a76942', description: 'Utility actual revenue / budgeted revenue.'},
  {id: 'iapr', label: 'IAPR', unit: '%', group: 'Performance', telemetry: true, color: '#358071', description: '(Utility actual production total / projected production) / (actual insolation / projected insolation).'},
  {id: 'iar', label: 'IAR', unit: '%', group: 'Performance', telemetry: true, color: '#98618b', description: '(Utility actual revenue / budgeted revenue) / (actual insolation / projected insolation).'},
];

export const quickViews: readonly {id: 'overview' | 'production' | 'revenue' | 'performance'; label: string; metrics: ChartMetricId[]}[] = [
  {id: 'overview', label: 'Overview', metrics: ['utilityTotal', 'projectedProduction', 'actualInsolation']},
  {id: 'production', label: 'Production', metrics: ['utilityTotal', 'projectedProduction', 'expectedProduction']},
  {id: 'revenue', label: 'Revenue', metrics: ['revenue', 'budgetRevenue']},
  {id: 'performance', label: 'Performance', metrics: ['iapr', 'iar', 'productionProjectionRatio']},
];

const metricsById = new Map(chartMetrics.map(metric => [metric.id, metric]));
const calculatedIds = new Set<string>(calculatedFields);
const utilityIds = new Set<string>(utilityFields);
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthIndex(month: string, selection = true): number {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || (selection && month < '1900-01')) {
    throw new Error('Use a calendar month from 1900-01 through 9999-12.');
  }
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;
}
function indexMonth(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 120000) throw new Error('Month shift is outside the supported calendar.');
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`;
}
function rangeLength(start: string, end: string): number {
  const length = monthIndex(end) - monthIndex(start) + 1;
  if (length < 1) throw new Error('The start month must not be after the end month.');
  if (length > 600) throw new Error('Choose a range of at most 600 inclusive months.');
  return length;
}
export function monthsInclusive(start: string, end: string): string[] {
  const length = rangeLength(start, end), first = monthIndex(start);
  return Array.from({length}, (_, offset) => indexMonth(first + offset));
}
export function shiftMonth(month: string, offset: number): string {
  if (!Number.isSafeInteger(offset)) throw new Error('Month offset must be a whole number.');
  // Comparison sources may precede 1900 even though selected ranges may not.
  return indexMonth(monthIndex(month, false) + offset);
}
export function formatChartMonth(month: string): string {
  const index = monthIndex(month, false);
  return `${monthNames[index % 12]} ${month.slice(0, 4)}`;
}

export function validateChartSettings(input: unknown, allowEmpty = false): ChartSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Chart settings must be an object.');
  const keys = ['start', 'end', 'type', 'comparisonYears', 'metrics'];
  if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || !keys.includes(key)) ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(input, key))) throw new Error('Supply only the required chart settings.');
  const value = input as Record<string, unknown>;
  if (typeof value.start !== 'string' || typeof value.end !== 'string') throw new Error('Choose a start and end month.');
  rangeLength(value.start, value.end);
  if (value.type !== 'line' && value.type !== 'bar' && value.type !== 'table') throw new Error('Choose a line, bar or table chart.');
  if (value.comparisonYears !== 0 && value.comparisonYears !== 1 && value.comparisonYears !== 2) throw new Error('Choose zero, one or two prior years.');
  if (!Array.isArray(value.metrics) || (!allowEmpty && !value.metrics.length) ||
      [...value.metrics].some(id => typeof id !== 'string' || !metricsById.has(id as ChartMetricId)) ||
      new Set(value.metrics).size !== value.metrics.length) throw new Error('Choose unique known metrics; a saved view needs at least one.');
  return {start: value.start, end: value.end, type: value.type, comparisonYears: value.comparisonYears, metrics: [...value.metrics] as ChartMetricId[]};
}

/** Validate without ever converting a large numerator or denominator to Number. */
function exactFraction(raw: string | Fraction | null): Fraction | null {
  if (raw === null) return null;
  if (typeof raw === 'string') {
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
    return fraction(raw);
  }
  if (!raw || typeof raw.n !== 'string' || typeof raw.d !== 'string' ||
      !/^-?\d+$/.test(raw.n) || !/^-?\d+$/.test(raw.d)) return null;
  const n = BigInt(raw.n), d = BigInt(raw.d);
  if (d === BigInt(0)) return null;
  // The domain formatter requires a positive denominator. Raw stays untouched.
  return {n: String(d < BigInt(0) ? -n : n), d: String(d < BigInt(0) ? -d : d)};
}

export function toPlotNumber(raw: string | Fraction | null, scale: 1 | 100 = 1): number | null {
  const value = exactFraction(raw);
  if (!value || (scale !== 1 && scale !== 100)) return null;
  let n = BigInt(value.n);
  const d = BigInt(value.d), negative = n < BigInt(0);
  if (n === BigInt(0)) return 0;
  if (negative) n = -n;
  const exponent = n.toString().length - d.toString().length;
  const scaleExponent = scale === 100 ? 2 : 0;
  if (exponent + scaleExponent > 309 || exponent + scaleExponent < -324) return null;
  // Eighteen significant decimal digits avoid Infinity/Infinity and retain
  // subnormals. Parse the final exponent together, not 10**-324 (which is zero).
  const power = 17 - exponent;
  const digits = power >= 0 ? n * BigInt(10) ** BigInt(power) / d : n / (d * BigInt(10) ** BigInt(-power));
  const number = Number(`${negative ? '-' : ''}${digits}e${exponent - 17 + scaleExponent}`);
  return Number.isFinite(number) && number !== 0 ? number : null;
}

export function defaultRange(snapshot: MonthlySnapshot, fallbackMonth: string): MonthRange {
  monthIndex(fallbackMonth);
  const observed = new Set<string>();
  const record = (month: string, numeric: boolean) => {
    if (numeric && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month >= '1900-01') observed.add(month);
  };
  for (const [month, row] of Object.entries(snapshot.utility)) {
    record(month, utilityFields.some(field => exactFraction(row[field] ?? null) !== null));
  }
  if (snapshot.telemetry.state === 'current') {
    for (const [month, row] of Object.entries(snapshot.telemetry.months)) {
      record(month, (['expected', 'insolation'] as const).some(kind => !telemetryBlock(snapshot, kind) &&
        row[kind]?.state !== 'missing' && exactFraction(row[kind]?.value ?? null) !== null));
    }
  }
  const end = [...observed].sort().at(-1) ?? fallbackMonth;
  // At the lower selection boundary there are fewer than twelve legal months.
  return {start: indexMonth(Math.max(monthIndex('1900-01'), monthIndex(end) - 11)), end};
}

type TelemetryKind = 'expected' | 'insolation';
type Dependencies = {utility?: boolean; projection?: boolean; capacity?: boolean; telemetry?: TelemetryKind};
const calculatedDependencies: Record<MonthlyCalculatedField, Dependencies> = {
  budgetedSpecificYield: {projection: true, capacity: true},
  actualSpecificYield: {utility: true, capacity: true},
  specificYieldRatio: {utility: true, projection: true, capacity: true},
  budgetedPerformanceRatio: {projection: true, capacity: true},
  actualPerformanceRatio: {utility: true, capacity: true, telemetry: 'insolation'},
  performanceRatioRatio: {utility: true, projection: true, capacity: true, telemetry: 'insolation'},
  insolationRatio: {projection: true, telemetry: 'insolation'},
  productionProjectionRatio: {utility: true, projection: true},
  productionExpectedRatio: {utility: true, telemetry: 'expected'},
  revenueRatio: {utility: true, projection: true},
  iapr: {utility: true, projection: true, telemetry: 'insolation'},
  iar: {utility: true, projection: true, telemetry: 'insolation'},
};
const projectionFields = {projectedProduction: 'production', budgetRevenue: 'revenue', projectedInsolation: 'insolation'} as const;

function telemetryBlock(snapshot: MonthlySnapshot, kind: TelemetryKind): string | null {
  if (kind === 'expected') return snapshot.telemetry.expectedUnavailableReason || null;
  return snapshot.telemetry.poa?.state === 'selected' ? null : snapshot.telemetry.poa?.reason || 'Select an available uploaded POA series for Actual insolation.';
}
function staleReason(snapshot: MonthlySnapshot, read: ChartReadState): string | null {
  if (read.error) return `Telemetry freshness is unavailable: ${read.error}`;
  if (read.refreshing) return 'Telemetry freshness is being checked while monthly data is refreshing.';
  if (snapshot.telemetry.state !== 'current') return `Telemetry is ${snapshot.telemetry.state}; freshness is not current.`;
  return null;
}
function telemetryDetails(snapshot: MonthlySnapshot, month: string, kind: TelemetryKind): string[] {
  const t = snapshot.telemetry, row = t.months[month], value = row?.[kind];
  const details = [
    `Telemetry state: ${t.state}; source revision: ${t.sourceRevision}.`,
    `Reporting timezone: ${t.timezone || 'unknown (not yet pinned)'}.`,
    kind === 'expected' ? `Expected Production channel: ${t.expectedChannelId || 'unavailable'}.` : `Uploaded POA series: ${t.selectedChannelId || 'unavailable'}.`,
  ];
  if (value) {
    details.push(`Coverage: ${value.coveredMilliseconds} / ${row.expectedMilliseconds} milliseconds (${value.state}).`,
      `Partial intervals: ${value.partialIntervals}; quality unknown intervals: ${value.unknownQualityIntervals}; negative intervals: ${value.negativeIntervals}.`);
    const sourceCounts = value as MonthlyMetric & Partial<Record<'satelliteIntervals' | 'poaIntervals' | 'unknownSourceIntervals', number>>;
    for (const [key, label] of [['satelliteIntervals', 'Satellite intervals'], ['poaIntervals', 'POA intervals'], ['unknownSourceIntervals', 'Unknown source intervals']] as const) {
      if (typeof sourceCounts[key] === 'number') details.push(`${label}: ${sourceCounts[key]}.`);
    }
  }
  if (value?.source) details.push(value.source);
  else if (kind === 'insolation') details.push('No uploaded readings from the selected POA series are available.');
  if (value?.reason) details.push(value.reason);
  if (kind === 'insolation') details.push('Actual insolation uses uploaded POA interval energy; conventional PR expects matching projected POA insolation.');
  else details.push('Imported Expected Production monthly total; not a budget projection or a newly calculated weather adjustment.');
  const blocked = telemetryBlock(snapshot, kind);
  if (blocked) details.push(blocked);
  return details;
}
function utilityDetails(snapshot: MonthlySnapshot, month: string): string[] {
  const row = snapshot.utility[month];
  return [
    'Saved utility entries are available when present; monthly coverage is not verified.',
    ...utilityFields.map(field => `${metricsById.get(field)!.label}: ${row?.[field] ?? 'missing'} ${metricsById.get(field)!.unit}.`),
  ];
}
function projectionDetails(projection: ProjectionRow | undefined): string[] {
  return projection ? [
    `Saved projection: ${projection.operationalDays} operational days / ${projection.days} calendar days.`,
    'Production and budget revenue use the saved prorated/degraded projection; insolation is not degraded.',
  ] : ['No saved projection exists for this source month.'];
}

function chartPoint(snapshot: MonthlySnapshot, metric: ChartMetricDefinition, anchorMonth: string, sourceMonth: string,
  projection: ProjectionRow | undefined, read: ChartReadState): ChartPoint {
  const id = metric.id, calculated = calculatedIds.has(id);
  const dependencies: Dependencies = calculated ? calculatedDependencies[id as MonthlyCalculatedField] :
    utilityIds.has(id) || id === 'utilityTotal' ? {utility: true} :
    id in projectionFields ? {projection: true} : {telemetry: id === 'expectedProduction' ? 'expected' : 'insolation'};
  const details = [`Source month: ${formatChartMonth(sourceMonth)} (${sourceMonth}).`, `Monthly input revision: ${snapshot.revision}.`, metric.description];
  if (dependencies.utility) details.push(...utilityDetails(snapshot, sourceMonth));
  if (dependencies.projection) details.push(...projectionDetails(projection));
  if (dependencies.capacity) details.push(snapshot.capacity.dcKwp ?
    `Saved connected module DC capacity: ${formatValue(snapshot.capacity.dcKwp, 2, true)} kWp; not AC limits or losses.` :
    snapshot.capacity.unavailableReason || 'Saved connected module DC capacity is unavailable.');
  if (dependencies.telemetry) details.push(...telemetryDetails(snapshot, sourceMonth, dependencies.telemetry));

  let raw: ChartPoint['raw'] = null;
  let state: ChartPoint['state'] = 'available';
  let reason: string | null = null;
  if (calculated) {
    const value = snapshot.calculated[sourceMonth]?.[id as MonthlyCalculatedField];
    raw = value?.value ?? null;
    state = value?.state ?? 'missing';
    reason = value?.reason ?? null;
  } else if (id === 'utilityTotal') {
    const row = snapshot.utility[sourceMonth];
    const components = [row?.onPeak, row?.offPeak, row?.unpaidEnergy];
    if (components.some(value => value !== null && value !== undefined && value !== '' && !exactFraction(value))) {
      reason = 'A saved utility component is not a valid numeric value.';
    } else raw = utilityTotal(row?.onPeak, row?.offPeak, row?.unpaidEnergy);
  } else if (utilityIds.has(id)) {
    raw = snapshot.utility[sourceMonth]?.[id as UtilityField] ?? null;
  } else if (id in projectionFields) {
    raw = projection?.[projectionFields[id as keyof typeof projectionFields]] ?? null;
    if (raw === null && id !== 'projectedInsolation' && snapshot.configuration.degradation === null) reason = 'Annual degradation is not configured; dependent projections are unavailable.';
  } else if (dependencies.telemetry) {
    const value = snapshot.telemetry.months[sourceMonth]?.[dependencies.telemetry];
    raw = value?.value ?? null;
    state = value?.state === 'complete' ? 'available' : value?.state ?? 'missing';
    reason = value?.reason ?? (state === 'partial' ? `${metric.label} has partial monthly coverage; numeric totals remain partial.` : null);
  }
  if (raw === '') raw = null;
  if (raw === null) {
    state = 'missing';
  }
  if (state === 'missing') reason ??= `${metric.label} is missing for ${formatChartMonth(sourceMonth)}.`;
  if (reason) details.push(`Source reason: ${reason}`);
  if (dependencies.telemetry) {
    const blocked = telemetryBlock(snapshot, dependencies.telemetry);
    if (blocked) {state = 'missing'; reason = blocked;}
    const stale = staleReason(snapshot, read);
    if (stale) {state = 'stale'; reason = stale;}
  }

  let plotValue: number | null = null, display = '—';
  if (state !== 'missing' && state !== 'stale' && raw !== null) {
    const exact = exactFraction(raw);
    if (!exact) {
      state = 'missing'; reason = 'The saved value is not a valid finite numeric value.';
    } else {
      display = calculated ? formatCalculatedValue(id as MonthlyCalculatedField, exact, true) :
        formatValue(exact, metric.unit === 'kWh/m²' || metric.unit === 'kWh/kWp' ? 2 : 0, true);
      plotValue = toPlotNumber(exact, metric.unit === '%' ? 100 : 1);
      if (plotValue === null) {
        state = 'missing'; reason = 'The nonzero value cannot be represented safely in finite chart geometry; the exact source and domain display are retained.';
      }
    }
  }
  if (reason && !details.includes(reason)) details.push(reason);
  return {anchorMonth, sourceMonth, raw, plotValue, display, state, reason, details};
}

export function buildChartSeries(snapshot: MonthlySnapshot, settings: ChartSettings,
  read: ChartReadState = {refreshing: false, error: ''}): ChartSeries[] {
  const validated = validateChartSettings(settings, true), anchors = monthsInclusive(validated.start, validated.end);
  const projections = new Map(snapshot.projections.map(row => [row.month, row]));
  const series: ChartSeries[] = [];
  for (const id of validated.metrics) {
    const metric = metricsById.get(id)!;
    for (let offset = 0; offset <= validated.comparisonYears; offset++) {
      const yearOffset = offset as 0 | 1 | 2;
      series.push({id: `${id}:${offset}`, metric, yearOffset,
        label: `${metric.label} · ${offset ? `${offset} year${offset === 1 ? '' : 's'} prior` : 'Selected period'}`,
        points: anchors.map(anchor => {
          const source = shiftMonth(anchor, -12 * offset);
          return chartPoint(snapshot, metric, anchor, source, projections.get(source), read);
        })});
    }
  }
  return series;
}

export function groupChartPanels(series: ChartSeries[]): ChartPanel[] {
  const units = [...new Set(series.map(item => item.metric.unit))];
  if (!units.length) return [];
  if (units.length <= 2) return [{units, series}];
  return units.map(unit => ({units: [unit], series: series.filter(item => item.metric.unit === unit)}));
}
export function chartSettingsEqual(a: ChartSettings, b: ChartSettings): boolean {
  const bMetrics = [...b.metrics].sort();
  return a.start === b.start && a.end === b.end && a.type === b.type && a.comparisonYears === b.comparisonYears &&
    a.metrics.length === b.metrics.length && [...a.metrics].sort().every((id, index) => id === bMetrics[index]);
}
