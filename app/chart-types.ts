import type {Fraction} from './monthly-domain.mjs';

export type ChartMetricId =
  | 'onPeak' | 'offPeak' | 'unpaidEnergy' | 'utilityTotal' | 'energyUsed'
  | 'projectedProduction' | 'expectedProduction' | 'confirmedLoss' | 'unconfirmedLoss' | 'revenue' | 'invoiceCost'
  | 'budgetRevenue' | 'actualInsolation' | 'projectedInsolation'
  | 'budgetedSpecificYield' | 'actualSpecificYield' | 'specificYieldRatio'
  | 'budgetedPerformanceRatio' | 'actualPerformanceRatio' | 'performanceRatioRatio'
  | 'insolationRatio' | 'productionProjectionRatio' | 'productionExpectedRatio'
  | 'revenueRatio' | 'iapr' | 'iar';
export type ChartUnit = 'kWh' | '$' | 'kWh/m²' | 'kWh/kWp' | '%';
export type ChartType = 'line' | 'bar' | 'table' | 'waterfall';
export type MonthRange = {start: string; end: string};
export type ChartSettings = MonthRange & {
  type: ChartType;
  comparisonYears: 0 | 1 | 2;
  metrics: ChartMetricId[];
};
export type SavedChartView = {id: string; name: string; settings: ChartSettings; createdAt: string};
export type ChartMetricDefinition = {
  id: ChartMetricId;
  label: string;
  unit: ChartUnit;
  group: 'Production' | 'Revenue' | 'Insolation' | 'Performance';
  description: string;
  telemetry: boolean;
  color: string;
};
export type ChartReadState = {refreshing: boolean; error: string};
export type ChartPoint = {
  anchorMonth: string;
  sourceMonth: string;
  raw: string | Fraction | null;
  plotValue: number | null;
  display: string;
  state: 'available' | 'partial' | 'missing' | 'stale';
  reason: string | null;
  details: string[];
};
export type ChartSeries = {
  id: string;
  metric: ChartMetricDefinition;
  yearOffset: 0 | 1 | 2;
  label: string;
  points: ChartPoint[];
};
export type ChartPanel = {units: ChartUnit[]; series: ChartSeries[]};
