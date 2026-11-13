import { readCheckpoint, writeCheckpoint, analysisJsonResponse } from "./checkpoint-storage";
import {buildRecurringIssues,splitRecurringGaps,RECURRING_POLICY} from "../../recurring-issues";
import { sharedReductionIntervals, allocateSharedReductions, SHARED_REDUCTION_METHOD } from "./shared-underperformance";
import { arrayCapacityModel } from "../../array-capacity";
import { inverterExpectationContext, INVERTER_EXPECTATION_METHOD, type InverterExpectationContext } from "./inverter-expectation";
import { transformerAnalysisContext, transformerIntervalTotals, transformerPeerExclusions, limitTransformerLosses } from "./transformer-limits";
import { meterMappingError } from "../../meter-mapping";
import { compareCapacityPeers, PEER_METHOD, type PeerFinding, type PeerInterval } from "./peer-comparison";
import { packSummary, unpackSummary, compactIssueEvidence, issueSaveIndex } from "./analysis-storage";
import { currentAnalysisInput, readManifest } from "../data-history/service";
import { historyCsv, decodeHistoryCells, type HistoryCell } from "../../data-history";
import { issueEventKey, issueEvidenceSignature, defaultConfidence } from "../../issue-review";
import { prepareTelemetry, reconcileTelemetry } from "./telemetry-events";
import { attributeCauses, expectedAssumptions, type CauseSummary, type SuspectedCause } from "./causes";
import { databaseErrorDetails } from "./database-errors";
import { monthlyLosses } from "../../issue-periods";
import { parseTelemetryTimestamp, inspectTelemetryTimestamp, localDate, isValidTimezone } from "../../telemetry-time";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { getBucketBinding, getDatabaseBinding } from "../../../db/binding";
import {
  equipmentAssets,
  performanceSummaries,
  siteSettings,
  telemetryImports,
} from "../../../db/schema";
import {
  persistPerformanceIssues,
  readPerformanceIssueReferences,
} from "./persistence";

import { analysisJobKey, getOrCreateJob, restartJob, readJob, claimJob, reportProgress, stopJob, publishJob, controlJob, jobProgress, AnalysisStopped, type AnalysisJob, type AnalysisStage } from "./jobs";

type StoredMapping = {
  roles?: Record<string, string>;
  equipment?: {
    signals?: Array<{
      column?: string;
      equipmentId?: string;
      measurement?: string;
    }>;
  };
};
type DailyPoint = { date: string; energyKwh: number };
type IrradiancePoint = {
  date: string;
  insolationKwhM2: number;
  peakWm2: number;
  readingCount: number;
};
type IntervalPoint = { timestamp: string; energyKwh: number };
type IntervalIrradiancePoint = {
  timestamp: string;
  insolationKwhM2: number;
  averageWm2: number;
  peakWm2: number;
  readingCount: number;
};
type RevenueMeterFallbackPoint = {
  timestamp: string;
  energyKwh: number;
  inverterAggregateEnergyKwh: number;
  wasMissing: boolean;
};
type Source = "interval_energy" | "active_power" | "";
type EquipmentProduction = {
  equipmentId: string;
  equipmentName: string;
  equipmentType: string;
  externalId: string;
  capacityKw: number;
  intervalProduction?: IntervalPoint[];
  dailyProduction: DailyPoint[];
  readingCount: number;
  source: Source;
};
type TelemetrySummary = Omit<CauseSummary, "intervalIrradiance" | "equipmentProduction"> & {
  parserVersion?: number;
  timezone?: string;
  timestampConvention?: "start" | "end";
  intervalMinutes?: number;
  timestamps?: string[];
  telemetryQuality?: Record<string, unknown>;
  dailyProduction: DailyPoint[];
  dailyIrradiance?: IrradiancePoint[];
  intervalIrradiance?: IntervalIrradiancePoint[];
  expectedProduction?: IntervalPoint[];
  equipmentProduction?: EquipmentProduction[];
  revenueMeterFallback?: {
    equipmentId: string;
    points: RevenueMeterFallbackPoint[];
  };
  totalEnergyKwh: number;
  latestDate: string;
  latestDayEnergyKwh: number;
  readingCount: number;
  source: Source;
};
type PublicTelemetrySummary = {
  timezone?: string;
  dailyProduction: DailyPoint[];
  totalEnergyKwh: number;
  latestDate: string;
  latestDayEnergyKwh: number;
  readingCount: number;
  source: Source;
};
type IssueType =
  | "Site outage"
  | "Partial site outage"
  | "Site telemetry outage"
  | "Equipment telemetry issue"
  | "Equipment outage"
  | "Underperformance"
  | "Data gap"
  | "Communication issue";
type IssueCategory = "Performance" | "Data quality" | "Communications";
type IssueConfidence = "confirmed" | "model-based";
type Severity = "critical" | "high" | "medium";
type TimeWindow = { start: number; end: number };
type IntervalAssessment = {
  timestamp: string;
  actualKwh: number;
  expectedKwh: number;
  lossKwh: number;
  ratio: number;
  type: IssueType;
  severity: Severity;
  rule?: string;
  peer?: PeerInterval;
  derivedExpectedKwh?: number;
};
type PerformanceIssue = {
  eventKey?:string;evidenceSignature?:string;confidenceDetail?:ReturnType<typeof defaultConfidence>;
  id: string;
  timezone?: string;
  recurringId?:string;
  detectionBasis?:string;
  intervalMinutes?: number;
  intervalLosses?: IntervalLossEvidence[];
  sharedSourceEvents?: unknown;
  lossUnknown?: boolean;
  productionUnknown?: boolean;
  affectedEquipment?: { id: string; name: string }[];
  suspectedCause?: SuspectedCause;
  causeExplanation?: string;
  databaseId?: string;
  status?: string;
  name: string;
  type: IssueType;
  category: IssueCategory;
  confidence: IssueConfidence;
  severity: Severity;
  equipmentId: string;
  equipmentName: string;
  equipmentType: string;
  equipmentExternalId: string;
  startDateTime: string;
  endDateTime: string;
  durationMinutes: number;
  durationDays: number;
  estimatedLossKwh: number;
  lossPercent: number;
  siteImpactPercent: number;
  actualEnergyKwh: number;
  expectedEnergyKwh: number;
  description: string;
  evidence?: Record<string, unknown>;
};
type IrradianceAccumulator = { sumWm2: number; count: number; peakWm2: number };
type Accumulator = {
  energy: Map<string, number>;
  power: Map<string, number>;
  expectedProduction: Map<string, number>;
  poaIrradiance: Map<string, IrradianceAccumulator>;
  irradiance: Map<string, IrradianceAccumulator>;
  energyReadings: number;
  powerReadings: number;
  poaIrradianceReadings: number;
  irradianceReadings: number;
  productionSignalSeen: boolean;
};

const PARSER_VERSION = 28;
// Recalculate current results once for five-day recurring issue grouping. Immutable
// older analyses remain accessible through analysis history.
const supportedParser = (version: unknown) => Number(version) === PARSER_VERSION;
const MIN_IRRADIANCE_WM2 = 50;

function safeJson<T>(value: string, fallback: T) {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
function normalized(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function measurementFrom(value: string) {
  const text = value.toLowerCase();
  if (/snow/.test(text)) return "Snow code";
  if (/\bpoa\b|plane.?of.?array/.test(text)) return "POA irradiance";
  if (/\bghi\b|irradi|pyranometer/.test(text)) return "Irradiance";
  if (/cumulative|totaliz|energy.?register|register.*energy/.test(text))
    return "Cumulative energy";
  if (/energy|kwh|mwh|interval.*(export|deliv|fourn)/.test(text))
    return "Energy";
  if (/dc.*power|power.*dc|\b[mk]?w\s*dc\b/.test(text)) return "DC power";
  if (/(?:active|ac).*power|power|kw|mw/.test(text)) return "Active power";
  return "Other";
}
function toKwh(raw: string, unit: string, header: string) {
  if (!raw.trim()) return null;
  const value = Number(raw.replace(/,/g, "").trim());
  if (!Number.isFinite(value)) return null;
  const hint = `${unit} ${header}`.toLowerCase();
  if (/\bmwh\b/.test(hint)) return value * 1000;
  if (/\bwh\b/.test(hint) && !/\b[mk]wh\b/.test(hint)) return value / 1000;
  return value;
}
function toKw(raw: string, unit: string, header: string) {
  if (!raw.trim()) return null;
  const value = Number(raw.replace(/,/g, "").trim());
  if (!Number.isFinite(value)) return null;
  const hint = `${unit} ${header}`.toLowerCase();
  if (/\bmw(?:ac)?\b/.test(hint)) return value * 1000;
  if (/\bw(?:ac)?\b/.test(hint) && !/\b[mk]w(?:ac)?\b/.test(hint))
    return value / 1000;
  return value;
}
function toWm2(raw: string, unit: string, header: string) {
  if (!raw.trim()) return null;
  const value = Number(raw.replace(/,/g, "").trim());
  if (!Number.isFinite(value)) return null;
  const hint = `${unit} ${header}`.toLowerCase();
  return Math.max(0, /kw\s*\/?\s*m(?:2|²)/.test(hint) ? value * 1000 : value);
}
function intervalHours(value: unknown) {
  const text = String(value || "").toLowerCase();
  const amount = Number(text.match(/[\d.]+/)?.[0] || 0);
  if (!amount) return 0;
  if (/hour/.test(text)) return amount;
  return amount / 60;
}
function nativeIntervalMinutes(timestamps: Set<string>, validation: Record<string, unknown>) {
  const ordered = [...timestamps].map(intervalNumber).sort((a, b) => a - b);
  const gaps = ordered.slice(1).map((moment, index) => moment - ordered[index]).filter(gap => gap > 0);
  const frequencies = new Map<number, number>();
  for (const gap of gaps) frequencies.set(gap, (frequencies.get(gap) || 0) + 1);
  const detected = [...frequencies].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  const declared = Number(validation.intervalMinutes);
  const legacyCadence = intervalHours(validation.interval) * 3600000;
  const fits = (cadence: number) => cadence > 0 && gaps.every(gap => gap >= cadence - 1 && Math.abs(gap - Math.round(gap / cadence) * cadence) <= 1);
  // Sparse exports may skip many intervals. Honor a declared native cadence when
  // it fits, while repairing old validation labels that rounded 90 minutes to 2 hours.
  const cadence = declared > 0 ? declared * 60000 : fits(legacyCadence) ? legacyCadence : detected || legacyCadence;
  if (!Number.isFinite(cadence) || cadence <= 0)
    throw new Error("An interval duration could not be determined. Supply at least two timestamps with a consistent cadence.");
  if (gaps.some(gap => gap < cadence - 1 || Math.abs(gap - Math.round(gap / cadence) * cadence) > 1))
    throw new Error("The timestamps have inconsistent interval lengths. Convert all signals to one explicit cadence before importing; gaps may be whole multiples of that cadence.");
  return cadence / 60000;
}
function calendarInterval(raw: string, dateFormatter: Intl.DateTimeFormat) {
  return parseTelemetryTimestamp(raw, dateFormatter.resolvedOptions().timeZone);
}
function intervalNumber(value: string) {
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`);
}
function timestampAt(moment: number, reference: string) {
  const iso = new Date(moment).toISOString();
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(reference) ? iso : iso.slice(0, 19);
}
function siteDate(timestamp: string, timezone?: string) {
  return timezone && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp) ? localDate(timestamp, timezone) : timestamp.slice(0, 10);
}
function dayNumber(value: string) {
  return Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
}
function addMinutes(value: string, minutes: number) {
  return timestampAt(intervalNumber(value) + minutes * 60000, value);
}
function median(values: number[]) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}
function gapContainsOnlyLowIrradiance(
  previousTimestamp: string,
  nextTimestamp: string,
  irradiance: Map<string, IntervalIrradiancePoint>,
  intervalMinutes: number,
) {
  const intervalMs = intervalMinutes * 60000;
  const end = intervalNumber(nextTimestamp);
  for (
    let moment = intervalNumber(previousTimestamp) + intervalMs;
    moment < end;
    moment += intervalMs
  ) {
    const timestamp = timestampAt(moment, previousTimestamp);
    const point = irradiance.get(timestamp);
    if (!point || point.averageWm2 >= MIN_IRRADIANCE_WM2) return false;
  }
  return true;
}
function affectedDayCount(issues: PerformanceIssue[]) {
  const dates = new Set<string>();
  issues.forEach((issue) => {
    const start = Date.parse(`${siteDate(issue.startDateTime, issue.timezone)}T00:00:00Z`);
    const endExclusive = Math.max(
      intervalNumber(issue.startDateTime) + 1,
      intervalNumber(issue.endDateTime),
    );
    const finalDay = Date.parse(
      siteDate(timestampAt(endExclusive - 1, issue.endDateTime), issue.timezone) + "T00:00:00Z",
    );
    for (let day = start; day <= finalDay; day += 86400000)
      dates.add(new Date(day).toISOString().slice(0, 10));
  });
  return dates.size;
}

async function parseCsv(
  stream: ReadableStream<Uint8Array>,
  onRow: (row: string[]) => void | Promise<void>,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let cell = "",
    row: string[] = [],
    quoted = false,
    pendingQuote = false,
    skipLf = false;
  const consume = async (text: string, final = false) => {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (pendingQuote) {
        pendingQuote = false;
        if (char === '"') {
          cell += '"';
          continue;
        }
        quoted = false;
      }
      if (skipLf) {
        skipLf = false;
        if (char === "\n") continue;
      }
      if (char === '"') {
        if (quoted) {
          if (index + 1 < text.length) {
            if (text[index + 1] === '"') {
              cell += '"';
              index += 1;
            } else quoted = false;
          } else if (final) quoted = false;
          else pendingQuote = true;
        } else if (!cell) quoted = true;
        else cell += char;
      } else if (char === "," && !quoted) {
        row.push(cell.trim());
        cell = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        row.push(cell.trim());
        cell = "";
        if (row.some((value) => value !== "")) { const pending = onRow(row); if (pending) await pending; }
        row = [];
        if (char === "\r") skipLf = true;
      } else cell += char;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    await consume(decoder.decode(value, { stream: true }));
  }
  await consume(decoder.decode(), true);
  if (cell || row.length) {
    row.push(cell.trim());
    if (row.some((value) => value !== "")) { const pending = onRow(row); if (pending) await pending; }
  }
}

function equipmentCapacity(
  asset: typeof equipmentAssets.$inferSelect,
  equipment: (typeof equipmentAssets.$inferSelect)[],
) {
  if (asset.type === "revenue_meter") return gridCapacity(equipment);
  if (asset.type === "transformer") return arrayCapacityModel(equipment).branches.find(b=>b.id===asset.id)?.modeledCeilingKw || 0;
  if (asset.type === "inverter")
    return Math.max(0, Number(asset.acRatedCapacityKw) || 0);
  if (asset.type === "module_group")
    return Math.max(
      0,
      ((Number(asset.moduleRatedCapacityW) || 0) * asset.quantity) / 1000,
    );
  return 0;
}
function moduleGroupCapacity(asset: typeof equipmentAssets.$inferSelect) {
  return Math.max(
    0,
    ((Number(asset.moduleRatedCapacityW) || 0) * asset.quantity) / 1000,
  );
}
function inverterModeledCapacity(
  inverter: typeof equipmentAssets.$inferSelect,
  equipment: (typeof equipmentAssets.$inferSelect)[],
) {
  const dc = equipment
    .filter(
      (item) => item.type === "module_group" && item.parentId === inverter.id,
    )
    .reduce((total, item) => total + moduleGroupCapacity(item), 0);
  return Math.min(dc, Math.max(0, Number(inverter.acRatedCapacityKw) || 0));
}
function grossArrayCapacity(
  equipment: (typeof equipmentAssets.$inferSelect)[],
) {
  if(equipment.some(a=>a.type==="transformer"))return arrayCapacityModel(equipment).modeledGrossKw || 0;
  return equipment
    .filter((item) => item.type === "inverter")
    .reduce(
      (sum, inverter) => sum + inverterModeledCapacity(inverter, equipment),
      0,
    );
}
function equipmentSiteImpactPercent(
  equipmentId: string,
  equipment: (typeof equipmentAssets.$inferSelect)[],
) {
  const asset = equipment.find((item) => item.id === equipmentId);
  if (!asset) return 0;
  if (asset.type === "revenue_meter") return 100;
  if(equipment.some(a=>a.type==="transformer")) {
    const model=arrayCapacityModel(equipment),gross=model.modeledGrossKw||0;
    let contribution=model.impactByInverter.get(asset.id)||0;
    if(asset.type==="transformer")contribution=model.branches.find(b=>b.id===asset.id)?.modeledCeilingKw||0;
    if(asset.type==="module_group"&&asset.parentId){const dc=model.dcByInverter.get(asset.parentId)||0;contribution=dc>0?(model.impactByInverter.get(asset.parentId)||0)*moduleGroupCapacity(asset)/dc:0;}
    return gross>0?Math.min(100,contribution/gross*100):0;
  }
  const gross = grossArrayCapacity(equipment);
  if (gross <= 0) return 0;
  let contribution = 0;
  if (asset.type === "inverter")
    contribution = inverterModeledCapacity(asset, equipment);
  else if (asset.type === "module_group") {
    const parent = equipment.find(
      (item) => item.id === asset.parentId && item.type === "inverter",
    );
    if (parent) {
      const parentGroups = equipment.filter(
        (item) => item.type === "module_group" && item.parentId === parent.id,
      );
      const parentDc = parentGroups.reduce(
        (sum, item) => sum + moduleGroupCapacity(item),
        0,
      );
      if (parentDc > 0)
        contribution =
          (inverterModeledCapacity(parent, equipment) *
            moduleGroupCapacity(asset)) /
          parentDc;
    }
  }
  return Math.min(100, Math.max(0, (contribution / gross) * 100));
}
function gridCapacity(equipment: (typeof equipmentAssets.$inferSelect)[]) {
  const meter = equipment.find((item) => item.type === "revenue_meter");
  const gross = grossArrayCapacity(equipment);
  const line = Math.min(
    100,
    Math.max(0, Number(meter?.acLineLossPercent) || 0),
  );
  const transformer = Math.min(
    100,
    Math.max(0, Number(meter?.transformerLossPercent) || 0),
  );
  return gross * (1 - line / 100) * (1 - transformer / 100);
}
function siteDeliveryFactor(
  equipment: (typeof equipmentAssets.$inferSelect)[],
) {
  const meter = equipment.find((item) => item.type === "revenue_meter");
  const line = Math.min(
    100,
    Math.max(0, Number(meter?.acLineLossPercent) || 0),
  );
  const transformer = Math.min(
    100,
    Math.max(0, Number(meter?.transformerLossPercent) || 0),
  );
  return (1 - line / 100) * (1 - transformer / 100);
}
function applyRevenueMeterFallback(
  production: EquipmentProduction[],
  equipment: (typeof equipmentAssets.$inferSelect)[],
): {
  production: EquipmentProduction[];
  revenueMeterFallback?: {
    equipmentId: string;
    points: RevenueMeterFallbackPoint[];
  };
} {
  const meter = production.find(
    (item) => item.equipmentType === "revenue_meter",
  );
  if (!meter) return { production, revenueMeterFallback: undefined };
  const inverterProduction = production.filter(
    (item) => item.equipmentType === "inverter",
  );
  if (!inverterProduction.length)
    return { production, revenueMeterFallback: undefined };
  const inverterAggregate = new Map<string, number>();
  inverterProduction.forEach((item) =>
    (item.intervalProduction || []).forEach((point) =>
      inverterAggregate.set(
        point.timestamp,
        (inverterAggregate.get(point.timestamp) || 0) + point.energyKwh,
      ),
    ),
  );
  const factor = siteDeliveryFactor(equipment);
  const meterValues = new Map(
    (meter.intervalProduction || []).map((point) => [
      point.timestamp,
      point.energyKwh,
    ]),
  );
  const fallbackPoints = [...inverterAggregate.entries()]
    .filter(([, energyKwh]) => energyKwh > 0)
    .flatMap(([timestamp, energyKwh]) => {
      const meterValue = meterValues.get(timestamp);
      return meterValue === undefined || meterValue <= 0
        ? [
            {
              timestamp,
              energyKwh: energyKwh * factor,
              inverterAggregateEnergyKwh: energyKwh,
              wasMissing: meterValue === undefined,
            },
          ]
        : [];
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (!fallbackPoints.length)
    return { production, revenueMeterFallback: undefined };
  const substituted = new Map(meterValues);
  fallbackPoints.forEach((point) =>
    substituted.set(point.timestamp, point.energyKwh),
  );
  const intervalProduction = [...substituted.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([timestamp, energyKwh]) => ({ timestamp, energyKwh }));
  const source: Source =
    meter.source ||
    inverterProduction.find((item) => item.source)?.source ||
    "";
  const nextMeter: EquipmentProduction = {
    ...meter,
    intervalProduction,
    dailyProduction: dailyFromIntervals(intervalProduction),
    source,
  };
  return {
    production: production.map((item) =>
      item.equipmentId === meter.equipmentId ? nextMeter : item,
    ),
    revenueMeterFallback: {
      equipmentId: meter.equipmentId,
      points: fallbackPoints,
    },
  };
}

function analyzeEquipment(
  production: EquipmentProduction,
  irradiance: Map<string, IntervalIrradiancePoint>,
  intervalMinutes: number,
  siteImpactPercent: number,
  importedExpected: Map<string, number>,
  siteTotalAcKw: number,
  excludedWindows: TimeWindow[] = [],
  synchronizedSiteDropTimestamps: Set<string> = new Set(),
  sortedSun?: IntervalIrradiancePoint[],
  snowDays: Set<string> = new Set(),
  timezone?: string,
  peerFinding?: PeerFinding,
  expectationContext?: InverterExpectationContext,
  blocked: Set<string> = new Set(),
) {
  const points = production.intervalProduction || [];
  if (points.length < 5) return [] as PerformanceIssue[];
  const values = new Map(
    points.map((point) => [point.timestamp, point.energyKwh]),
  );
  const first = points[0].timestamp;
  const last = points.at(-1)?.timestamp || first;
  const qualifiedSun = sortedSun || [...irradiance.values()]
    .filter(point => point.averageWm2 >= MIN_IRRADIANCE_WM2)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const bound = (timestamp: string, inclusive: boolean) => {
    let low = 0, high = qualifiedSun.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (qualifiedSun[middle].timestamp < timestamp ||
          (inclusive && qualifiedSun[middle].timestamp === timestamp)) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const candidateSun = qualifiedSun.slice(bound(first, false), bound(last, true));
  const yieldsByDay = new Map<string, number[]>();
  points.forEach((point) => {
    const sun = irradiance.get(point.timestamp);
    if (
      point.energyKwh <= 0 ||
      !sun ||
      sun.averageWm2 < MIN_IRRADIANCE_WM2 ||
      sun.insolationKwhM2 <= 0
    )
      return;
    const date = siteDate(point.timestamp, timezone);
    const yields = yieldsByDay.get(date) || [];
    yields.push(point.energyKwh / sun.insolationKwhM2);
    yieldsByDay.set(date, yields);
  });
  const dailyYields = [...yieldsByDay.entries()].map(([date, yields]) => ({
    date,
    moment: dayNumber(date),
    yield: median(yields),
  })).sort((a, b) => a.moment - b.moment);
  const allDailyYields = dailyYields.map((item) => item.yield);
  const globalYield =
    median(allDailyYields) ||
    (production.capacityKw > 0 ? production.capacityKw * 0.8 : 0);
  const baselineByDay = new Map<string, number>();
  let windowStart = 0, windowEnd = 0;
  new Set(candidateSun.map((point) => siteDate(point.timestamp, timezone))).forEach(
    (date) => {
      const moment = dayNumber(date);
      const radius = 14 * 86400000;
      while (windowStart < dailyYields.length && dailyYields[windowStart].moment < moment - radius) windowStart++;
      windowEnd = Math.max(windowEnd, windowStart);
      while (windowEnd < dailyYields.length && dailyYields[windowEnd].moment <= moment + radius) windowEnd++;
      const nearby = dailyYields.slice(windowStart, windowEnd).map(item => item.yield);
      baselineByDay.set(
        date,
        (nearby.length >= 4 ? median(nearby) : globalYield) || globalYield,
      );
    },
  );
  const capacityLimit =
    production.capacityKw > 0
      ? production.capacityKw * (intervalMinutes / 60)
      : Number.POSITIVE_INFINITY;
  const expectedFor = (sun: IntervalIrradiancePoint) =>
    Math.min(
      (baselineByDay.get(siteDate(sun.timestamp, timezone)) || globalYield) *
        sun.insolationKwhM2,
      capacityLimit,
    );
  const derived = production.equipmentType === "inverter" ? expectationContext : undefined;
  const derivedInverter = derived?.model.inverters.get(production.equipmentId);
  const eligibleDerived = (sun: IntervalIrradiancePoint, value: number | undefined, point: ReturnType<InverterExpectationContext["at"]>) =>
    !!point && !!derivedInverter && Number.isFinite(value) && value! > 0 &&
    sun.averageWm2 >= INVERTER_EXPECTATION_METHOD.minimumIrradianceWm2 &&
    point.expectedKwh >= derivedInverter.acKw * (intervalMinutes / 60) * INVERTER_EXPECTATION_METHOD.minimumExpectedAcFraction &&
    !point.capacityLimited && value! < derivedInverter.acKw * (intervalMinutes / 60) * INVERTER_EXPECTATION_METHOD.maximumLoadingFraction &&
    !blocked.has(sun.timestamp) && !snowDays.has(siteDate(sun.timestamp, timezone));
  const derivedDeficitDays = new Set<string>();
  let derivedDeficitIntervals = 0;
  // Persistence is tested independently for each inverter, without a peer prerequisite.
  if (derived) for (const sun of candidateSun) {
    const point = derived.at(production.equipmentId, sun.timestamp), value = values.get(sun.timestamp);
    if (eligibleDerived(sun, value, point) && value! / point!.expectedKwh <= 1 - INVERTER_EXPECTATION_METHOD.minimumDeficitPercent / 100 + 1e-9) {
      derivedDeficitDays.add(siteDate(sun.timestamp, timezone)); derivedDeficitIntervals++;
    }
  }
  const derivedDeficitHours = derivedDeficitIntervals * intervalMinutes / 60;
  const persistentDerivedDeficit = derivedDeficitDays.size >= INVERTER_EXPECTATION_METHOD.minimumDays &&
    derivedDeficitHours + 1e-9 >= INVERTER_EXPECTATION_METHOD.minimumDeficitHours;
  if (derived && persistentDerivedDeficit) derived.coverage.invertersWithRepeatedDeficits++;
  const assessments: IntervalAssessment[] = [];
  candidateSun.forEach((sun) => {
    const start = intervalNumber(sun.timestamp),
      end = start + intervalMinutes * 60000;
    if (
      excludedWindows.some((window) => start < window.end && end > window.start)
    )
      return;
    const importedValue = importedExpected.get(sun.timestamp);
    const derivedStatus = derived?.rates.get(sun.timestamp)?.status;
    const siteExpectedValue = importedValue !== undefined && Number.isFinite(importedValue) && importedValue >= 0 &&
      derivedStatus !== "invalid" && derivedStatus !== "capacityConflict" ? importedValue : undefined;
    const importedEquipmentExpected = siteExpectedValue === undefined ? undefined : production.equipmentType === "revenue_meter"
      ? Math.min(siteExpectedValue, capacityLimit) : production.equipmentType === "inverter" && siteTotalAcKw > 0
        ? Math.min(siteExpectedValue * production.capacityKw / siteTotalAcKw, capacityLimit) : undefined;
    const derivedPoint = derived?.at(production.equipmentId, sun.timestamp);
    const onSnowDay = snowDays.has(siteDate(sun.timestamp, timezone));
    const detectionExpected = derivedPoint ? derivedPoint.expectedKwh : onSnowDay && importedEquipmentExpected !== undefined
      ? importedEquipmentExpected : expectedFor(sun);
    const actual = values.get(sun.timestamp);
    if (derived) {
      if (!derivedPoint) derived.coverage.fallbackInverterIntervals++;
      else if (blocked.has(sun.timestamp)) derived.coverage.telemetryBlockedInverterIntervals++;
      else if (onSnowDay) derived.coverage.snowInverterIntervals++;
      else if (derivedPoint.capacityLimited || actual! >= capacityLimit * INVERTER_EXPECTATION_METHOD.maximumLoadingFraction) derived.coverage.capacityLimitedInverterIntervals++;
      else if (eligibleDerived(sun, actual, derivedPoint)) derived.coverage.comparedInverterIntervals++;
      else derived.coverage.lowLightInverterIntervals++;
    }
    if (detectionExpected <= 0) return;
    if (actual === undefined) {
      assessments.push({
        timestamp: sun.timestamp,
        actualKwh: 0,
        expectedKwh: detectionExpected,
        lossKwh: detectionExpected,
        ratio: 0,
        type: "Data gap",
        severity: "high",
      });
      return;
    }
    const ratio = actual / detectionExpected;
    const peer = peerFinding?.intervals.get(sun.timestamp);
    const outage =
      production.equipmentType === "inverter" ? actual <= 0 : ratio <= 0.05;
    if (derivedPoint) {
      if (!outage && !(onSnowDay ? ratio < .7 : persistentDerivedDeficit && eligibleDerived(sun, actual, derivedPoint) &&
        ratio <= 1 - INVERTER_EXPECTATION_METHOD.minimumDeficitPercent / 100 + 1e-9)) return;
    } else if (ratio >= .7) return;
    const type = outage
      ? production.equipmentType === "revenue_meter"
        ? "Site outage"
        : "Equipment outage"
      : "Underperformance";
    const siteExpected = siteExpectedValue;
    const lossExpected =
      derivedPoint ? derivedPoint.expectedKwh :
      type === "Underperformance" && importedEquipmentExpected !== undefined ? importedEquipmentExpected :
      type === "Site outage" && siteExpected !== undefined
        ? siteExpected
        : type === "Equipment outage" &&
            production.equipmentType === "inverter" &&
            siteExpected !== undefined &&
            siteTotalAcKw > 0
          ? (siteExpected * production.capacityKw) / siteTotalAcKw
          : detectionExpected;
    assessments.push({
      timestamp: sun.timestamp,
      actualKwh: actual,
      expectedKwh: lossExpected,
      lossKwh: Math.max(0, lossExpected - actual),
      ratio,
      peer,
      derivedExpectedKwh: derivedPoint?.expectedKwh,
      rule: derivedPoint ? "derived_inverter_expectation_v1" : undefined,
      type,
      severity: outage ? "critical" : ratio < 0.4 ? "high" : "medium",
    });
  });
  if (production.equipmentType === "revenue_meter") {
    assessments.forEach((assessment, index) => {
      if (assessment.type !== "Site outage") return;
      const previous = assessments[index - 1];
      if (
        !previous ||
        previous.type !== "Underperformance" ||
        intervalNumber(assessment.timestamp) -
          intervalNumber(previous.timestamp) !==
          intervalMinutes * 60000
      )
        return;
      const siteExpected = importedExpected.get(previous.timestamp);
      const expectedKwh = siteExpected ?? previous.expectedKwh;
      previous.type = "Site outage";
      previous.expectedKwh = expectedKwh;
      previous.lossKwh = Math.max(0, expectedKwh - previous.actualKwh);
    });
    const candidateTimestamps = new Set(
      candidateSun.map((point) => point.timestamp),
    );
    const assessmentByTimestamp = new Map(
      assessments.map((assessment) => [assessment.timestamp, assessment]),
    );
    assessments.forEach((assessment) => {
      if (
        assessment.type !== "Underperformance" ||
        !synchronizedSiteDropTimestamps.has(assessment.timestamp)
      )
        return;
      const previousTimestamp = addMinutes(
        assessment.timestamp,
        -intervalMinutes,
      );
      const nextTimestamp = addMinutes(assessment.timestamp, intervalMinutes);
      const healthyBefore =
        candidateTimestamps.has(previousTimestamp) &&
        !assessmentByTimestamp.has(previousTimestamp);
      const healthyAfter =
        candidateTimestamps.has(nextTimestamp) &&
        !assessmentByTimestamp.has(nextTimestamp);
      if (!healthyBefore || !healthyAfter) return;
      const siteExpected = importedExpected.get(assessment.timestamp);
      const expectedKwh = siteExpected ?? assessment.expectedKwh;
      assessment.type = "Site outage";
      assessment.severity = "critical";
      assessment.expectedKwh = expectedKwh;
      assessment.lossKwh = Math.max(0, expectedKwh - assessment.actualKwh);
      assessment.rule = "isolated_synchronized_site_drop";
    });
  }
  const groups: IntervalAssessment[][] = [];
  assessments.forEach((item) => {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (
      group &&
      previous?.type === item.type &&
      gapContainsOnlyLowIrradiance(
        previous.timestamp,
        item.timestamp,
        irradiance,
        intervalMinutes,
      )
    )
      group.push(item);
    else groups.push([item]);
  });
  return groups.map((group, index) => {
    const expected = group.reduce((sum, item) => sum + item.expectedKwh, 0);
    const actual = group.reduce((sum, item) => sum + item.actualKwh, 0);
    const loss = Math.max(0, expected - actual);
    const severity = group.some((item) => item.severity === "critical")
      ? "critical"
      : group.some((item) => item.severity === "high")
        ? "high"
        : "medium";
    const start = group[0].timestamp;
    const end = addMinutes(group.at(-1)?.timestamp || start, intervalMinutes);
    const durationMinutes = Math.max(
      intervalMinutes,
      (intervalNumber(end) - intervalNumber(start)) / 60000,
    );
    const descriptions: Partial<Record<IssueType, string>> = {
      "Site outage":
        "Site production fell to 5% or less of its irradiance-adjusted expectation during these intervals.",
      "Equipment outage":
        "Equipment production fell to 5% or less of its irradiance-adjusted expectation during these intervals.",
      Underperformance:
        "Production was materially below this equipment's irradiance-normalized interval baseline.",
      "Data gap":
        "No valid production reading was available while irradiance indicated expected production.",
    };
    const type = group[0].type as Exclude<IssueType, "Communication issue">;
    const name =
      production.equipmentType === "inverter" && type === "Equipment outage"
        ? `Inverter ${production.equipmentName} offline`
        : production.equipmentType === "inverter" && type === "Underperformance"
          ? `Inverter ${production.equipmentName} underperformance`
          : type;
    return {
      id: `${production.equipmentId}-${type.toLowerCase().replace(/\s+/g, "-")}-${start}-${index}`,
      name,
      type,
      category: type === "Data gap" ? "Data quality" : "Performance",
      confidence: "model-based",
      severity,
      equipmentId: production.equipmentId,
      equipmentName: production.equipmentName,
      equipmentType: production.equipmentType,
      equipmentExternalId: production.externalId,
      startDateTime: start,
      endDateTime: end,
      durationMinutes,
      durationDays: durationMinutes / 1440,
      estimatedLossKwh: loss,
      lossPercent: expected ? Math.min(100, (loss / expected) * 100) : 0,
      siteImpactPercent,
      actualEnergyKwh: actual,
      expectedEnergyKwh: expected,
      description: group.some(p => p.rule === "derived_inverter_expectation_v1")
        ? (type === "Underperformance" ? "Production is below the inverter expectation derived from site Expected Production and configured array capacities. " : "Inverter outage loss uses the expectation derived from site Expected Production and configured array capacities. ") + "Peer evidence is optional; the physical cause is not established."
        : descriptions[type] || type,
      evidence: {
        rule:
          group.find((item) => item.rule)?.rule ||
          "irradiance_adjusted_baseline",
        intervalCount: group.length,
        intervalLosses: group.map((item) => ({
          timestamp: item.timestamp,
          lossKwh: item.lossKwh,
          actualKwh: item.actualKwh,
          expectedKwh: item.expectedKwh,
          ...(item.derivedExpectedKwh !== undefined ? { derivedInverterExpectedKwh: item.derivedExpectedKwh, detectionBasis: "derived_inverter_expectation_v1", peerCorroborated: !!item.peer } : {}),
          ...(item.peer ? { peerExpectedKwh: item.peer.expectedKwh, peerSetIndex: item.peer.peerSetIndex, peerCount: item.peer.peerCount,
            actualToPeerRatio: item.peer.actualToPeerRatio, detectionBasis: item.rule || "irradiance_adjusted_baseline" } : {}),
        })),
        ...(derived && derivedInverter && group.some(p => p.derivedExpectedKwh !== undefined) ? { derivedInverterExpectation: {
          methodVersion: INVERTER_EXPECTATION_METHOD.version, acRatedCapacityKw: derivedInverter.acKw, dcRatedCapacityKw: derivedInverter.dcKw,
          qualifiedDays: derivedDeficitDays.size, deficitHours: derivedDeficitHours, siteDeliveryFactor: derived.model.deliveryFactor,
          peerCorroboratedIntervals: group.filter(p => p.peer).length, lossBasis: "Derived inverter expectation; optional peers do not set the loss amount." } } : {}),
        ...(peerFinding && group.some(p => p.peer) ? { peerComparison: { acRatedCapacityKw: peerFinding.group.acKw,
          dcRatedCapacityKw: peerFinding.group.dcKw, groupKey: peerFinding.group.key,
          qualifiedDays: peerFinding.qualifiedDays, deficitHours: peerFinding.deficitHours, methodVersion: PEER_METHOD.version } } : {}),
        minimumIrradianceWm2: MIN_IRRADIANCE_WM2,
        actualToExpectedRatio: expected ? actual / expected : 0,
      },
    } satisfies PerformanceIssue;
  });
}

function revenueMeterCommunicationIssues(
  summary: TelemetrySummary,
  equipment: (typeof equipmentAssets.$inferSelect)[],
  irradiance: Map<string, IntervalIrradiancePoint>,
  intervalMinutes: number,
) {
  const fallback = summary.revenueMeterFallback;
  if (!fallback?.points.length) return [] as PerformanceIssue[];
  const meter = equipment.find(
    (item) => item.id === fallback.equipmentId && item.type === "revenue_meter",
  );
  if (!meter) return [] as PerformanceIssue[];
  const groups: RevenueMeterFallbackPoint[][] = [];
  fallback.points.forEach((point) => {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    const adjacent =
      previous &&
      intervalNumber(point.timestamp) - intervalNumber(previous.timestamp) ===
        intervalMinutes * 60000;
    if (
      group &&
      previous &&
      (adjacent ||
        gapContainsOnlyLowIrradiance(
          previous.timestamp,
          point.timestamp,
          irradiance,
          intervalMinutes,
        ))
    )
      group.push(point);
    else groups.push([point]);
  });
  const importedExpected = new Map(
    (summary.expectedProduction || []).map((point) => [
      point.timestamp,
      point.energyKwh,
    ]),
  );
  return groups.map((group, index) => {
    const start = group[0].timestamp;
    const end = addMinutes(group.at(-1)?.timestamp || start, intervalMinutes);
    const durationMinutes = Math.max(
      intervalMinutes,
      (intervalNumber(end) - intervalNumber(start)) / 60000,
    );
    const substitutedEnergyKwh = group.reduce(
      (sum, point) => sum + point.energyKwh,
      0,
    );
    const expectedEnergyKwh = group.reduce(
      (sum, point) =>
        sum + (importedExpected.get(point.timestamp) ?? point.energyKwh),
      0,
    );
    const estimatedLossKwh = Math.max(
      0,
      expectedEnergyKwh - substitutedEnergyKwh,
    );
    const inverterAggregateEnergyKwh = group.reduce(
      (sum, point) => sum + point.inverterAggregateEnergyKwh,
      0,
    );
    const missingIntervals = group.filter((point) => point.wasMissing).length;
    const zeroIntervals = group.length - missingIntervals;
    const condition =
      missingIntervals && zeroIntervals
        ? "was missing or reported zero"
        : missingIntervals
          ? "was missing"
          : "reported zero";
    const lineLossPercent = Math.min(
      100,
      Math.max(0, Number(meter.acLineLossPercent) || 0),
    );
    const transformerLossPercent = Math.min(
      100,
      Math.max(0, Number(meter.transformerLossPercent) || 0),
    );
    return {
      id: `${meter.id}-communication-issue-${start}-${index}`,
      name: "Revenue meter communication issue",
      type: "Communication issue",
      category: "Communications",
      confidence: "confirmed",
      severity: "high",
      equipmentId: meter.id,
      equipmentName: meter.name,
      equipmentType: meter.type,
      equipmentExternalId: meter.externalId,
      startDateTime: start,
      endDateTime: end,
      durationMinutes,
      durationDays: durationMinutes / 1440,
      estimatedLossKwh,
      lossPercent: expectedEnergyKwh
        ? Math.min(100, (estimatedLossKwh / expectedEnergyKwh) * 100)
        : 0,
      siteImpactPercent: 100,
      actualEnergyKwh: substitutedEnergyKwh,
      expectedEnergyKwh,
      description: `The revenue meter ${condition} while the inverter fleet recorded production. Estimated loss uses Expected Production minus the inverter aggregate, adjusted for configured line and transformer losses.`,
      evidence: {
        rule: "expected_production_minus_inverter_aggregate",
        intervalLosses: group.map((point) => ({
          timestamp: point.timestamp,
          lossKwh: Math.max(
            0,
            (importedExpected.get(point.timestamp) ?? point.energyKwh) -
              point.energyKwh,
          ),
        })),
        missingIntervalCount: missingIntervals,
        zeroIntervalCount: zeroIntervals,
        inverterAggregateEnergyKwh,
        substitutedSiteEnergyKwh: substitutedEnergyKwh,
        lineLossPercent,
        transformerLossPercent,
        siteDeliveryFactor: siteDeliveryFactor(equipment),
      },
    } satisfies PerformanceIssue;
  });
}

function descendantIds(
  equipment: (typeof equipmentAssets.$inferSelect)[],
  rootIds: Set<string>,
) {
  const descendants = new Set(rootIds);
  let changed = true;
  while (changed) {
    changed = false;
    equipment.forEach((asset) => {
      if (
        asset.parentId &&
        descendants.has(asset.parentId) &&
        !descendants.has(asset.id)
      ) {
        descendants.add(asset.id);
        changed = true;
      }
    });
  }
  rootIds.forEach((id) => descendants.delete(id));
  return descendants;
}

type IntervalLossEvidence = {
  timestamp: string;
  lossKwh: number;
  countedLossKwh?: number;
  intervalMinutes?: number;
  actualKwh?: number;
  expectedKwh?: number;
  attributedInverterLossKwh?: number;
  residualLossKwh?: number;
};

function applyInverterLossAttribution(
  meterIssues: PerformanceIssue[],
  equipmentIssues: PerformanceIssue[],
  equipment: (typeof equipmentAssets.$inferSelect)[],
  intervalMinutes: number,
) {
  const deliveryFactor = siteDeliveryFactor(equipment);
  const inverterIntervals = new Map<
    string,
    Array<{
      issueId: string;
      equipmentId: string;
      deliveredLossKwh: number;
    }>
  >();
  equipmentIssues.forEach((issue) => {
    if (issue.equipmentType !== "inverter") return;
    const intervals = Array.isArray(issue.evidence?.intervalLosses)
      ? (issue.evidence.intervalLosses as IntervalLossEvidence[])
      : [];
    intervals.forEach((interval) => {
      const deliveredLossKwh =
        Math.max(0, interval.lossKwh) * deliveryFactor;
      if (deliveredLossKwh <= 0) return;
      const contributors = inverterIntervals.get(interval.timestamp) || [];
      contributors.push({ issueId: issue.id, equipmentId: issue.equipmentId, deliveredLossKwh });
      inverterIntervals.set(interval.timestamp, contributors);
    });
  });

  const allocatedInverterLoss = new Map<string, number>();
  const attributedMeterIssues = meterIssues.flatMap((issue) => {
    if (issue.type !== "Underperformance") return [issue];
    const intervals = Array.isArray(issue.evidence?.intervalLosses)
      ? (issue.evidence.intervalLosses as IntervalLossEvidence[])
      : [];
    const contributingInverters = new Set<string>();
    let attributedLossKwh = 0;
    let originalLossKwh = 0;
    const residualIntervals = intervals.map((interval) => {
      const siteLossKwh = Math.max(0, interval.lossKwh);
      originalLossKwh += siteLossKwh;
      const contributors = inverterIntervals.get(interval.timestamp) || [];
      const deliveredInverterLossKwh = contributors.reduce(
        (sum, contributor) => sum + contributor.deliveredLossKwh,
        0,
      );
      const explainedLossKwh = Math.min(
        siteLossKwh,
        deliveredInverterLossKwh,
      );
      // Attribution changes where loss is reported, never how much is counted.
      // Even a small unexplained remainder must survive reconciliation.
      const residualLossKwh = Math.max(0, siteLossKwh - explainedLossKwh);
      attributedLossKwh += explainedLossKwh;
      const allocationScale = deliveredInverterLossKwh
        ? explainedLossKwh / deliveredInverterLossKwh
        : 0;
      contributors.forEach((contributor) => {
        contributingInverters.add(contributor.equipmentId);
        const key = `${contributor.issueId}\u0000${interval.timestamp}`;
        allocatedInverterLoss.set(
          key,
          (allocatedInverterLoss.get(key) || 0) +
            contributor.deliveredLossKwh * allocationScale,
        );
      });
      return {
        ...interval,
        attributedInverterLossKwh: explainedLossKwh,
        residualLossKwh,
        lossKwh: residualLossKwh,
      };
    });
    const retainedIntervals = residualIntervals.filter(
      (interval) => interval.lossKwh > 0,
    );
    if (!retainedIntervals.length) return [];
    const estimatedLossKwh = retainedIntervals.reduce(
      (sum, interval) => sum + interval.lossKwh,
      0,
    );
    const actualEnergyKwh = retainedIntervals.reduce(
      (sum, interval) => sum + Math.max(0, interval.actualKwh || 0),
      0,
    );
    const startDateTime = retainedIntervals[0].timestamp;
    const endDateTime = addMinutes(
      retainedIntervals.at(-1)?.timestamp || startDateTime,
      intervalMinutes,
    );
    const durationMinutes = Math.max(
      intervalMinutes,
      (intervalNumber(endDateTime) - intervalNumber(startDateTime)) / 60000,
    );
    return [
      {
        ...issue,
        name: "Unexplained site underperformance",
        startDateTime,
        endDateTime,
        durationMinutes,
        durationDays: durationMinutes / 1440,
        estimatedLossKwh,
        actualEnergyKwh,
        expectedEnergyKwh: actualEnergyKwh + estimatedLossKwh,
        lossPercent:
          actualEnergyKwh + estimatedLossKwh > 0
            ? Math.min(
                100,
                (estimatedLossKwh /
                  (actualEnergyKwh + estimatedLossKwh)) *
                  100,
              )
            : 0,
        description:
          "The inverter fleet explains part of the measured site loss. This issue contains only the remaining unattributed revenue-meter underperformance.",
        evidence: {
          ...issue.evidence,
          rule: "residual_after_inverter_loss_attribution",
          intervalLosses: residualIntervals,
          originalSiteLossKwh: originalLossKwh,
          attributedInverterLossKwh: attributedLossKwh,
          residualSiteLossKwh: estimatedLossKwh,
          inverterExplainedPercent: originalLossKwh
            ? Math.min(100, (attributedLossKwh / originalLossKwh) * 100)
            : 0,
          contributingInverterIds: [...contributingInverters],
          siteDeliveryFactor: deliveryFactor,
        },
      },
    ];
  });

  const attributedEquipmentIssues = equipmentIssues.map((issue) => {
    if (issue.equipmentType !== "inverter") return issue;
    const intervals = Array.isArray(issue.evidence?.intervalLosses)
      ? (issue.evidence.intervalLosses as IntervalLossEvidence[])
      : [];
    let changed = false;
    const attributedIntervals = intervals.map((interval) => {
      const allocated = allocatedInverterLoss.get(
        `${issue.id}\u0000${interval.timestamp}`,
      );
      const derivedInterval = (interval as IntervalLossEvidence & { derivedInverterExpectedKwh?: number }).derivedInverterExpectedKwh !== undefined;
      if (allocated === undefined && !derivedInterval) return interval;
      changed = true;
      const delivered = allocated ?? interval.lossKwh * deliveryFactor;
      return {
        ...interval,
        lossKwh: delivered,
        ...(derivedInterval ? { lossBoundary: "meter_poi", inverterTerminalLossKwh: interval.lossKwh,
          actualKwh: (interval.actualKwh || 0) * deliveryFactor,
          expectedKwh: (interval.expectedKwh || 0) * deliveryFactor }
          : { originalLossKwh: interval.lossKwh, siteDeliveredLossKwh: delivered }),
      };
    });
    if (!changed) return issue;
    const estimatedLossKwh = attributedIntervals.reduce(
      (sum, interval) => sum + Math.max(0, interval.lossKwh),
      0,
    );
    const expectedEnergyKwh = attributedIntervals.reduce((sum, p) => sum + (p.expectedKwh || 0), 0);
    const actualEnergyKwh = attributedIntervals.reduce((sum, p) => sum + (p.actualKwh || 0), 0);
    return {
      ...issue,
      estimatedLossKwh,
      expectedEnergyKwh,
      actualEnergyKwh,
      lossPercent: expectedEnergyKwh
        ? Math.min(100, (estimatedLossKwh / expectedEnergyKwh) * 100)
        : 0,
      evidence: {
        ...issue.evidence,
        intervalLosses: attributedIntervals,
        originalEstimatedLossKwh: issue.estimatedLossKwh,
        siteDeliveredAttributedLossKwh: estimatedLossKwh,
        siteDeliveryFactor: deliveryFactor,
      },
    };
  });
  return {
    meterIssues: attributedMeterIssues,
    equipmentIssues: attributedEquipmentIssues,
  };
}

function applyHierarchyLossPriority(
  issues: PerformanceIssue[],
  equipment: (typeof equipmentAssets.$inferSelect)[],
) {
  const parentById = new Map(equipment.map((asset) => [asset.id, asset.parentId]));
  const ancestorIds = (equipmentId: string) => {
    const ancestors = new Set<string>();
    let parentId = parentById.get(equipmentId);
    while (parentId && !ancestors.has(parentId)) {
      ancestors.add(parentId);
      parentId = parentById.get(parentId);
    }
    return ancestors;
  };
  const outagesByEquipment = new Map<string, TimeWindow[]>();
  issues.forEach(issue => {
    if (issue.type !== "Site outage" || issue.estimatedLossKwh <= 0) return;
    const windows = outagesByEquipment.get(issue.equipmentId) || [];
    windows.push({ start: intervalNumber(issue.startDateTime), end: intervalNumber(issue.endDateTime) });
    outagesByEquipment.set(issue.equipmentId, windows);
  });
  const coverageByEquipment = new Map<string, TimeWindow[]>();
  const coverageFor = (equipmentId: string) => {
    const cached = coverageByEquipment.get(equipmentId);
    if (cached) return cached;
    const windows = [...ancestorIds(equipmentId)].flatMap(id => outagesByEquipment.get(id) || [])
      .sort((a, b) => a.start - b.start);
    const merged: TimeWindow[] = [];
    windows.forEach(window => {
      const previous = merged.at(-1);
      if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end);
      else merged.push({ ...window });
    });
    coverageByEquipment.set(equipmentId, merged);
    return merged;
  };
  return issues.map((issue) => {
    const coverage = coverageFor(issue.equipmentId);
    if (!coverage.length) return issue;
    const intervalLosses = Array.isArray(issue.evidence?.intervalLosses)
      ? (issue.evidence.intervalLosses as IntervalLossEvidence[])
      : [];
    if (!intervalLosses.length) return issue;
    let suppressedLossKwh = 0;
    const allocatedIntervals = intervalLosses.map((interval) => {
      const moment = intervalNumber(interval.timestamp);
      let low = 0, high = coverage.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (coverage[middle].start <= moment) low = middle + 1;
        else high = middle;
      }
      const covered = low > 0 && moment < coverage[low - 1].end;
      if (covered) suppressedLossKwh += Math.max(0, interval.lossKwh);
      return { ...interval, countedLossKwh: covered ? 0 : interval.lossKwh };
    });
    const estimatedLossKwh = Math.max(
      0,
      allocatedIntervals.reduce(
        (sum, interval) => sum + Math.max(0, interval.countedLossKwh),
        0,
      ),
    );
    return {
      ...issue,
      estimatedLossKwh,
      lossPercent: issue.expectedEnergyKwh
        ? Math.min(100, (estimatedLossKwh / issue.expectedEnergyKwh) * 100)
        : 0,
      evidence: {
        ...issue.evidence,
        intervalLosses: allocatedIntervals,
        originalEstimatedLossKwh: issue.estimatedLossKwh,
        hierarchySuppressedLossKwh: suppressedLossKwh,
      },
    };
  });
}

function* buildAnalysisSteps(
  summary: TelemetrySummary,
  equipment: (typeof equipmentAssets.$inferSelect)[],
  batch?: { offset: number; limit: number; issues: PerformanceIssue[]; coverage?: InverterExpectationContext["coverage"] },
) {
  // Preserve the source expectation for qualification: transformer capping must not hide a model mismatch.
  let referenceExpected = summary.expectedProduction;
  const transformerContext=transformerAnalysisContext(summary,equipment);
  const telemetryPlan = prepareTelemetry(summary, equipment);
  const transformerTotals=transformerIntervalTotals(summary,transformerContext.model);
  const inverterContext = inverterExpectationContext(summary, equipment, referenceExpected);
  if(batch?.coverage)Object.assign(inverterContext.coverage,batch.coverage);
  referenceExpected = undefined;
  const inverterBlocked = transformerPeerExclusions(transformerContext.model,transformerTotals,transformerContext.hours,telemetryPlan.blocked);
  const peerPlan = compareCapacityPeers(summary, equipment, inverterBlocked, undefined, inverterContext);
  const production = summary.equipmentProduction || [];
  const snowDays = new Set(summary.snowSensorConfigured ? summary.snowDays || [] : []);
  const intervalMinutes = summary.intervalMinutes || 60;
  const timezone = summary.timezone || summary.causeContext?.timeZone;
  const irradiance = new Map(
    (summary.intervalIrradiance || []).map((point) => [point.timestamp, point]),
  );
  const sortedSun = [...irradiance.values()]
    .filter(point => point.averageWm2 >= MIN_IRRADIANCE_WM2)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const importedExpected = new Map(
    (summary.expectedProduction || []).map((point) => [
      point.timestamp,
      point.energyKwh,
    ]),
  );
  const totalAcKw = equipment
    .filter((item) => item.type === "inverter")
    .reduce(
      (sum, item) => sum + Math.max(0, Number(item.acRatedCapacityKw) || 0),
      0,
    );
  const meterIds = new Set(
    equipment
      .filter((item) => item.type === "revenue_meter")
      .map((item) => item.id),
  );
  const meterProduction = production.filter((item) =>
    meterIds.has(item.equipmentId),
  );
  const communicationIssues: PerformanceIssue[] = [];
  const equipmentIssues: PerformanceIssue[] = batch?.issues || [];
  // Transformer nodes constrain branches; fault detection continues at monitored inverters and the meter.
  const analyzable = irradiance.size ? production.filter(item=>item.equipmentType!=="transformer") : [];
  let processed = batch?.offset || 0;
  const inverterItems = analyzable.filter(item => !meterIds.has(item.equipmentId));
  yield { stage: "equipment" as AnalysisStage, completed: processed, total: analyzable.length };
  for (const item of inverterItems.slice(processed)) {
    equipmentIssues.push(...analyzeEquipment(item, irradiance, intervalMinutes,
      equipmentSiteImpactPercent(item.equipmentId, equipment), importedExpected,
      totalAcKw, [], new Set(), sortedSun, snowDays, timezone, peerPlan.findings.get(item.equipmentId), inverterContext, inverterBlocked.get(item.equipmentId)));
    yield { stage: "equipment" as AnalysisStage, completed: ++processed, total: analyzable.length };
    if (batch && (processed - batch.offset >= batch.limit || processed === inverterItems.length)) {
      yield { stage: (processed === inverterItems.length ? "reconcile" : "equipment") as AnalysisStage, completed: processed, total: inverterItems.length, equipmentCheckpoint: {issues:equipmentIssues,coverage:inverterContext.coverage} };
    }
  }
  const sharedIntervals = sharedReductionIntervals(summary, equipmentIssues, inverterContext, inverterBlocked,
    timestamp => snowDays.has(siteDate(timestamp, timezone)));
  // Branch clipping adds temporary sets for each inverter. The shared telemetry
  // exclusions are still needed below, but the branch copies are not.
  if (inverterBlocked !== telemetryPlan.blocked) inverterBlocked.clear();
  const inverterProduction = production.filter(
    (item) => item.equipmentType === "inverter",
  );
  const monitoredInverterCounts = new Map<string, number>();
  inverterProduction.forEach((item) =>
    (item.intervalProduction || []).forEach((point) =>
      monitoredInverterCounts.set(
        point.timestamp,
        (monitoredInverterCounts.get(point.timestamp) || 0) + 1,
      ),
    ),
  );
  const inverterIssueCounts = new Map<string, Set<string>>();
  equipmentIssues.forEach((issue) => {
    if (issue.equipmentType !== "inverter") return;
    const intervalLosses = Array.isArray(issue.evidence?.intervalLosses)
      ? (issue.evidence.intervalLosses as IntervalLossEvidence[])
      : [];
    intervalLosses.forEach((interval) => {
      const affected = inverterIssueCounts.get(interval.timestamp) || new Set();
      affected.add(issue.equipmentId);
      inverterIssueCounts.set(interval.timestamp, affected);
    });
  });
  const synchronizedSiteDropTimestamps = new Set(
    [...inverterIssueCounts.entries()]
      .filter(
        ([timestamp, affected]) => {
          const monitored = monitoredInverterCounts.get(timestamp) || 0;
          return monitored > 0 && affected.size / monitored >= 0.8;
        },
      )
      .map(([timestamp]) => timestamp),
  );
  monitoredInverterCounts.clear();
  inverterIssueCounts.clear();
  const communicationTimestamps = new Set(
    (summary.revenueMeterFallback?.points || []).map(
      (point) => point.timestamp,
    ),
  );
  communicationTimestamps.forEach((timestamp) =>
    synchronizedSiteDropTimestamps.delete(timestamp),
  );
  const meterIssues: PerformanceIssue[] = [];
  for (const item of irradiance.size ? meterProduction : []) {
    meterIssues.push(...analyzeEquipment(item, irradiance, intervalMinutes,
      equipmentSiteImpactPercent(item.equipmentId, equipment), importedExpected,
      totalAcKw, [], synchronizedSiteDropTimestamps, sortedSun, snowDays, timezone));
    yield { stage: "equipment" as AnalysisStage, completed: ++processed, total: analyzable.length };
  }
  // All inverter evidence now owns the few values it needs; release the shared
  // interval baseline before reconciling and serializing the full-year ledger.
  inverterContext.rates.clear();
  yield { stage: "reconcile" as AnalysisStage, completed: 0, total: 1 };
  const attributed = applyInverterLossAttribution(
    meterIssues,
    limitTransformerLosses(equipmentIssues,transformerContext.model,transformerTotals,transformerContext.hours),
    equipment,
    intervalMinutes,
  );
  equipmentIssues.length = 0;
  meterIssues.length = 0;
  transformerTotals.clear();
  const reconciledIssues = applyHierarchyLossPriority(
    [
      ...communicationIssues,
      ...attributed.meterIssues,
      ...attributed.equipmentIssues,
    ],
    equipment,
  )
    // A downstream finding that is completely covered by an active ancestor
    // is not a separate actionable issue. Hierarchy allocation sets its loss
    // to zero; remove the row as well so the table reflects the array model.
    .filter(
      (issue) =>
        issue.category === "Communications" || issue.estimatedLossKwh > 0,
    )
    .sort(
    (a, b) =>
      b.estimatedLossKwh - a.estimatedLossKwh ||
      a.startDateTime.localeCompare(b.startDateTime),
  );
  attributed.equipmentIssues.length = 0;
  attributed.meterIssues.length = 0;
  const telemetryIssues = reconcileTelemetry(reconciledIssues, telemetryPlan);
  const meter = equipment.find(item => item.type === "revenue_meter");
  const sharedIssues = meter ? allocateSharedReductions(telemetryIssues, sharedIntervals, meter, intervalMinutes,
    (a, b) => gapContainsOnlyLowIrradiance(a, b, irradiance, intervalMinutes), addMinutes) : telemetryIssues;
  sharedIntervals.clear();
  const issues: PerformanceIssue[] = splitRecurringGaps(attributeCauses(sharedIssues, summary, peerPlan).map(issue => ({ ...issue, timezone, intervalMinutes, detectionBasis:String(issue.evidence?.rule||"legacy") }))).sort((a, b) => b.estimatedLossKwh - a.estimatedLossKwh || a.startDateTime.localeCompare(b.startDateTime));
  reconciledIssues.length = 0;
  const peerDeficitCount = peerPlan.findings.size;
  // Optional support is now in the issue ledgers. Its working maps can be
  // large for a fleet with repeated deficits and must not survive serialization.
  peerPlan.findings.clear();
  peerPlan.recoveryDays.clear();
  const primary =
    production.find((item) => item.equipmentType === "revenue_meter") ||
    production[0];
  const first = primary?.intervalProduction?.[0]?.timestamp || "",
    last = primary?.intervalProduction?.at(-1)?.timestamp || first;
  const irradianceInRange = [...irradiance.values()].filter(
    (point) => !first || (point.timestamp >= first && point.timestamp <= last),
  );
  const qualified = irradianceInRange.filter(
    (point) => point.averageWm2 >= MIN_IRRADIANCE_WM2,
  );
  const analyzedDays = new Set(
    qualified.map((point) => siteDate(point.timestamp, timezone)),
  ).size;
  const affectedDays = affectedDayCount(issues);
  const recurringIssues = buildRecurringIssues(issues,summary);
  return {
    issues,
    recurringIssues,
    recurringPolicy: RECURRING_POLICY,
    timezone,
    expectedProductionAssumptions: summary.causeContext?.assumptions,
    telemetryQuality: summary.telemetryQuality,
    inverterExpectation: inverterContext.methodology(),
    sharedReduction: SHARED_REDUCTION_METHOD,
    ...(transformerContext.model.hasTransformers ? {transformerLimits: transformerContext.methodology} : {}),
    peerComparison: { ...PEER_METHOD, configuredGroups: new Set(peerPlan.groups.values()).size, invertersWithRepeatedDeficits: peerDeficitCount, referenceSets: peerPlan.referenceSets, referenceQualification: peerPlan.referenceQualification },
    causeAnalysis: { version: 2, snowSensorConfigured: Boolean(summary.snowSensorConfigured), snowReadingCount: summary.snowReadingCount || 0, snowDays: summary.snowDays || [], shadingMethod: "Recurring solar-position losses with same-day recovery and capacity-matched peers; suspected only." },
    totalLossKwh: issues.reduce(
      (sum, issue) => sum + issue.estimatedLossKwh,
      0,
    ),
    affectedDays,
    analyzedDays,
    analyzedIntervals: qualified.length,
    analysisIntervalMinutes: intervalMinutes,
    irradianceAvailable: irradiance.size > 0,
    irradianceDays: new Set(
      irradianceInRange.map((point) => siteDate(point.timestamp, timezone)),
    ).size,
    skippedLowIrradianceDays: new Set(
      irradianceInRange
        .filter((point) => point.averageWm2 < MIN_IRRADIANCE_WM2)
        .map((point) => siteDate(point.timestamp, timezone)),
    ).size,
    skippedLowIrradianceIntervals: irradianceInRange.length - qualified.length,
    lowIrradianceThresholdWm2: MIN_IRRADIANCE_WM2,
    baselineMethod: irradiance.size
      ? (transformerContext.model.hasTransformers ? transformerContext.methodology.method+" Imported site expected energy is capped at the modeled export ceiling for the interval; source imports remain unchanged. Peer comparison excludes a branch at or above 95% of its transformer ceiling. " : "") + `Missing readings are preserved. Site telemetry gaps have unknown loss and are excluded from quantified totals. Nighttime missing readings contribute zero only when solar position confirms darkness; missing flags are retained. Meter fallback requires complete inverter capacity coverage. Shared partial outages require at least three inverters and 20% AC capacity, a synchronized onset, and meter corroboration. Covered child intervals are removed from displayed dates and losses. The site historical detector and inverter fallback use each equipment node's 28-day irradiance-normalized yield at the imported ${intervalMinutes}-minute cadence. Inverter underperformance primarily uses an expectation derived from site Expected Production at the meter / POI, assumed to have no shading allowance. Configured delivery losses are undone and a common output per kWdc is solved subject to each inverter AC ceiling and each transformer branch ceiling. Measured inverter production does not fit this expectation. A deficit of at least 10% must occur on at least three local dates and total at least three hours. Qualified intervals require irradiance at least 200 W/m², expected output at least 10% of inverter AC capacity, and expected and actual output below 95% of inverter and transformer ceilings. Existing inverter outage and onsite-snow rules remain separate. Missing, invalid or capacity-inconsistent expected data, or an incomplete allocation model, uses the historical detector as a labeled fallback. Optional corroboration uses equal configured AC and summed module DC ratings. References must agree within 10% of derived expected output, remain above the 10% deficit threshold, and agree in at least 80% of eligible intervals totaling three hours on three dates within each local month and hour. At least two independently qualified peers must also agree at the comparison timestamp; the target is excluded. Missing peers never suppress primary model-derived findings and peer evidence never adds energy loss. Derived inverter losses are limited by transformer headroom, converted to delivered energy using configured losses, and reconciled once with meter findings. Orientation, tilt, tracking and inverter-specific response differences remain unmodeled. A shared deficit is detectable but does not prove that the site expected-production model is correct. Shared site reduction attribution: ${SHARED_REDUCTION_METHOD.basis} ${SHARED_REDUCTION_METHOD.exclusions} ${SHARED_REDUCTION_METHOD.allocation} Historical fallback retains its existing imported AC-share loss basis when allocation is incomplete; invalid or capacity-inconsistent expectations cannot supply fallback inverter losses. Suspected causes partition existing losses without adding to their total. For inverter findings, expected interval energy is capped at the inverter's AC rating multiplied by the interval duration. Intervals below ${MIN_IRRADIANCE_WM2} W/m², and intervals without mapped irradiance, are excluded from issue and loss calculations. Revenue-meter underperformance is reconciled interval by interval against inverter losses adjusted by the configured site delivery factor. Inverter issues receive the attributable delivered loss. Every remaining kWh is retained as unexplained site underperformance; the meter finding is removed only when its loss is fully attributed, so attribution never changes the total quantified shortfall. When a revenue-meter site outage begins, one immediately preceding adjacent underperformance interval is included in the outage so a partial first-interval loss is captured. After telemetry reconciliation, adjoining quantified site-outage segments for the same meter are combined into one event with the original detector evidence retained and each interval loss counted once; healthy intervals, telemetry gaps, and unknown-loss segments remain boundaries. An isolated reduced revenue-meter interval is classified as a model-based site outage when its immediately preceding and following qualified intervals are healthy and at least 80% of monitored inverters show a synchronized reduction in that interval. When the revenue meter is missing or zero while the inverter aggregate is positive, a confirmed communications issue is logged and the inverter aggregate is adjusted for configured line and transformer losses and substituted as site production for those intervals. No other communication classification is applied. Consecutive findings of the same type can span nights and low-light intervals; a qualified healthy interval ends the occurrence. Inverter underperformance is additionally split at any local date with no active loss interval. Successive affected local dates no more than five calendar days apart form a recurring review record with the original active intervals underneath; larger gaps start a new record. Multi-day duration spans the full start-to-end period, while estimated loss includes qualified irradiance intervals only. Site impact is calculated separately as the affected equipment's share of total modeled array capacity: each inverter contributes the lesser of connected DC and AC rated capacity, module groups receive their proportional share of the parent inverter, and revenue-meter findings affect 100% of the site. Timestamps preserve source resolution and are stored as UTC instants, displayed in the source timezone. Issue start/end times describe measured interval boundaries, not exact within-interval failure times; the preceding partial-loss interval is included without inventing an exact outage onset. During a revenue-meter site outage, overlapping findings for downstream array-model equipment are suppressed. Telemetry issues with unknown production do not add energy loss; complete inverter fallback can quantify the site shortfall.`
      : "No performance issues or losses are generated until POA or GHI irradiance is mapped to a configured sensor. Revenue-meter communication issues can still be confirmed when the meter is missing or zero while the inverter fleet records production.",
  };
}

// The same generator drives synchronous calculation tests and checkpointed jobs.
function buildAnalysis(summary: TelemetrySummary, equipment: (typeof equipmentAssets.$inferSelect)[]) {
  const steps = buildAnalysisSteps(summary, equipment);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}

async function buildSummary(
  record: typeof telemetryImports.$inferSelect,
  equipment: (typeof equipmentAssets.$inferSelect)[],
  progress?: (completed: number, total: number) => Promise<void>,
) {
  const capacityModel=arrayCapacityModel(equipment);
  if(capacityModel.hasTransformers&&!capacityModel.complete)throw new Error(`Complete the transformer model before analysis: ${capacityModel.issues.join(" ")}`);
  const historyMetadata = safeJson<Record<string, unknown>>(record.validation, {});
  const object = historyMetadata.datasetManifest ? { body: historyCsv(await readManifest(record.siteId,record.id), async key => {
    const part=await getBucketBinding().get(key);if(!part)throw new Error("A retained history partition is unavailable.");return decodeHistoryCells(await part.json<Parameters<typeof decodeHistoryCells>[0]>());
  }) } : await getBucketBinding().get(record.objectKey);
  if (!object) throw new Error("The retained CSV could not be found.");
  const stored = safeJson<StoredMapping>(record.mapping, {});
  const roles = stored.roles || {};
  const signals = (stored.equipment?.signals || []).filter(
    (signal) => signal.column && signal.equipmentId,
  );
  if (signals.some(signal => signal.measurement === "Cumulative energy")) {
    throw new Error("Cumulative energy readings must be converted to interval energy (kWh) before import. Map interval readings as Energy.");
  }
  const mappingError = meterMappingError(equipment, roles, signals);
  if (mappingError) throw new Error(mappingError);
  const validation = safeJson<Record<string, unknown>>(record.validation, {});
  const timezone = record.timezone;
  if (!isValidTimezone(timezone)) throw new Error("Choose a valid IANA source timezone before analysis.");
  const timestampConvention = validation.timestampConvention === "end" ? "end" : "start";
  const assetsById = new Map(equipment.map((asset) => [asset.id, asset]));
  const identityMap = new Map<string, string>();
  equipment.forEach((asset) =>
    [
      asset.id,
      asset.externalId,
      asset.name,
      ...safeJson<string[]>(asset.aliases, []),
    ].forEach((identity) => {
      const key = normalized(identity);
      if (key && !identityMap.has(key)) identityMap.set(key, asset.id);
    }),
  );
  const snowSensorIds = new Set(equipment.filter(asset => asset.type === "weather_sensor" && asset.name.trim().toLowerCase() === "snow sensor").map(asset => asset.id));
  const snowTimestamps = new Set<string>();
  let snowReadingCount = 0;
  const accumulators = new Map<string, Accumulator>();
  const siteExpectedProduction = new Map<string, number>();
  const accumulatorFor = (equipmentId: string) => {
    let accumulator = accumulators.get(equipmentId);
    if (!accumulator) {
      accumulator = {
        energy: new Map(),
        power: new Map(),
        expectedProduction: new Map(),
        poaIrradiance: new Map(),
        irradiance: new Map(),
        energyReadings: 0,
        powerReadings: 0,
        poaIrradianceReadings: 0,
        irradianceReadings: 0,
        productionSignalSeen: false,
      };
      accumulators.set(equipmentId, accumulator);
    }
    return accumulator;
  };
  const addReading = (
    equipmentId: string,
    measurement: string,
    raw: string,
    unit: string,
    header: string,
    timestamp: string,
  ) => {
    if (!assetsById.has(equipmentId)) return;
    if (snowSensorIds.has(equipmentId)) {
      // Codes are categorical: never average or add them, and never carry them forward.
      if (["Snow code", "Status", "Other"].includes(measurement) && raw.trim() !== "" && Number.isFinite(Number(raw.trim()))) {
        snowReadingCount++;
        if (Number(raw.trim()) === 70) snowTimestamps.add(timestamp);
      }
      return;
    }
    const accumulator = accumulatorFor(equipmentId);
    if (measurement === "Cumulative energy") {
      throw new Error("Cumulative energy readings must be converted to interval energy (kWh) before import. Map interval readings as Energy.");
    } else if (measurement === "Expected Production") {
      const value = toKwh(raw, "kWh", header);
      if (value !== null)
        accumulator.expectedProduction.set(timestamp, Math.max(0, value));
    } else if (measurement === "Energy") {
      accumulator.productionSignalSeen = true;
      const value = toKwh(raw, unit, header);
      if (value !== null) {
        accumulator.energy.set(
          timestamp,
          (accumulator.energy.get(timestamp) || 0) + value,
        );
        accumulator.energyReadings += 1;
      }
    } else if (measurement === "Active power") {
      // DC input is the same energy flow before conversion, not additional AC
      // output. It stays in the retained source data and is never production.
      accumulator.productionSignalSeen = true;
      {
        const value = toKw(raw, unit, header);
        if (value !== null) {
          accumulator.power.set(
            timestamp,
            (accumulator.power.get(timestamp) || 0) + value,
          );
          accumulator.powerReadings += 1;
        }
      }
    } else if (/irradiance/i.test(measurement)) {
      const value = toWm2(raw, unit, header);
      if (value !== null) {
        const poa =
          /\bpoa\b|plane.?of.?array/i.test(measurement) ||
          /\bpoa\b|plane.?of.?array/i.test(header);
        const target = poa ? accumulator.poaIrradiance : accumulator.irradiance;
        const current = target.get(timestamp) || {
          sumWm2: 0,
          count: 0,
          peakWm2: 0,
        };
        target.set(timestamp, {
          sumWm2: current.sumWm2 + value,
          count: current.count + 1,
          peakWm2: Math.max(current.peakWm2, value),
        });
        if (poa) accumulator.poaIrradianceReadings += 1;
        else accumulator.irradianceReadings += 1;
      }
    }
  };
  let headers: string[] = [];
  let indexes: Record<string, number> = {};
  let rowsRead = 0;
  // Expanded history has one row per signal. Bound progress writes independently
  // of signal count so a large site does not make thousands of database calls.
  const progressStride = Math.max(250, Math.ceil(record.rowCount / 50 / 250) * 250);
  const timestamps = new Set<string>();
  const canonicalTimestamps=new Map<string,string>();
  await progress?.(0, record.rowCount);
  await parseCsv(object.body, (row) => {
    if (!headers.length) {
      headers = row.map((value, index) =>
        index === 0 ? value.replace(/^\uFEFF/, "") : value,
      );
      indexes = Object.fromEntries(
        headers.map((header, index) => [header, index]),
      );
      return;
    }
    rowsRead += 1;
    const report = () => rowsRead % progressStride === 0 ? progress?.(rowsRead, record.rowCount) : undefined;
    const rawTimestamp = row[indexes[roles.timestamp]] || "";
    const parsed = inspectTelemetryTimestamp(rawTimestamp, timezone);
    const parsedTimestamp = parsed.timestamp;
    const timestamp = parsedTimestamp ? canonicalTimestamps.get(parsedTimestamp)||parsedTimestamp : null;
    if (!timestamp) throw new Error(`Invalid timestamp on CSV row ${rowsRead + 1}${parsed.reason === "ambiguous" || parsed.reason === "nonexistent" ? ": daylight-saving times require an explicit UTC offset" : ": check the date and source timezone"}.`);
    canonicalTimestamps.set(timestamp,timestamp);
    // Snow/status events may arrive asynchronously; they do not establish a production interval.
    const longId = roles.equipment ? identityMap.get(normalized(row[indexes[roles.equipment]] || "")) : undefined;
    const longMeasurement = roles.measurement ? measurementFrom(row[indexes[roles.measurement]] || "") : "";
    const intervalMeasurement = (measurement: string) => ["Energy", "Active power", "Expected Production"].includes(measurement) || /irradiance/i.test(measurement);
    const hasLongValue = Boolean(roles.value && row[indexes[roles.value]]?.trim());
    const categorical = (measurement: string) => ["Snow code", "Status", "Other", "Availability"].includes(measurement);
    const hasCategoricalValue = Boolean(longId && (snowSensorIds.has(longId) || categorical(longMeasurement)) && hasLongValue) ||
      signals.some(signal => (snowSensorIds.has(signal.equipmentId!) || categorical(signal.measurement || measurementFrom(signal.column!))) && row[indexes[signal.column!]]?.trim());
    const hasIntervalValue = Boolean(roles.expectedProduction && row[indexes[roles.expectedProduction]]?.trim()) ||
      Boolean(longId && !snowSensorIds.has(longId) && intervalMeasurement(longMeasurement) && hasLongValue) ||
      signals.some(signal => !snowSensorIds.has(signal.equipmentId!) && intervalMeasurement(signal.measurement || measurementFrom(signal.column!)) && row[indexes[signal.column!]]?.trim());
    if (!hasCategoricalValue || hasIntervalValue) timestamps.add(timestamp);
    if (roles.expectedProduction) {
      const expected = toKwh(
        row[indexes[roles.expectedProduction]] || "",
        "kWh",
        roles.expectedProduction,
      );
      if (expected !== null)
        siteExpectedProduction.set(timestamp, Math.max(0, expected));
    }
    const unit = roles.unit ? row[indexes[roles.unit]] || "" : "";
    if (roles.equipment && roles.measurement && roles.value) {
      const equipmentId = identityMap.get(
        normalized(row[indexes[roles.equipment]] || ""),
      );
      if (equipmentId)
        addReading(
          equipmentId,
          measurementFrom(row[indexes[roles.measurement]] || ""),
          row[indexes[roles.value]] || "",
          unit,
          row[indexes[roles.measurement]] || "",
          timestamp,
        );
    }
    signals.forEach((signal) => {
      const column = signal.column as string;
      addReading(
        signal.equipmentId as string,
        signal.measurement || measurementFrom(column),
        row[indexes[column]] || "",
        unit,
        column,
        timestamp,
      );
    });
    return report();
  });
  await progress?.(rowsRead, record.rowCount);
  const intervalMinutes = nativeIntervalMinutes(timestamps, validation);
  const hours = intervalMinutes / 60;
  // Normalize the interval boundary once, identically for production, weather and expectations.
  const intervalStart = (timestamp: string) => timestampConvention === "end" ? addMinutes(timestamp, -intervalMinutes) : timestamp;
  const shiftMap = <T,>(values: Map<string, T>) => new Map([...values].map(([timestamp, value]) => [intervalStart(timestamp), value]));
  for (const accumulator of accumulators.values()) {
    accumulator.energy = shiftMap(accumulator.energy);
    accumulator.power = new Map([...accumulator.power].map(([timestamp, kw]) => [intervalStart(timestamp), kw * hours]));
    accumulator.expectedProduction = shiftMap(accumulator.expectedProduction);
    accumulator.poaIrradiance = shiftMap(accumulator.poaIrradiance);
    accumulator.irradiance = shiftMap(accumulator.irradiance);
  }
  const snowDays = new Set([...snowTimestamps].map(timestamp => localDate(timestamp, timezone)));
  const rawEquipmentProduction = [...accumulators.entries()]
    .filter(([, accumulator]) => accumulator.productionSignalSeen)
    .map(([equipmentId, accumulator]) => {
      const asset = assetsById.get(equipmentId)!;
      const source: Source = accumulator.energyReadings
        ? "interval_energy"
        : accumulator.powerReadings
          ? "active_power"
          : "";
      const selected = accumulator.energyReadings
        ? accumulator.energy
        : accumulator.power;
      const intervalProduction = [...selected.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([timestamp, energyKwh]) => ({
          timestamp,
          energyKwh: Math.max(0, energyKwh),
        }));
      const dailyProduction = dailyFromIntervals(intervalProduction, timezone);
      return {
        equipmentId,
        equipmentName: asset.name,
        equipmentType: asset.type,
        externalId: asset.externalId,
        capacityKw: equipmentCapacity(asset, equipment),
        intervalProduction,
        dailyProduction,
        readingCount: accumulator.energyReadings || accumulator.powerReadings,
        source,
      } satisfies EquipmentProduction;
    });
  const missingMeter = equipment.find(asset => asset.type === "revenue_meter" && !rawEquipmentProduction.some(p => p.equipmentId === asset.id));
  if (missingMeter) throw new Error(`No mapped Energy or Active power readings were found for revenue meter ${missingMeter.name}. Review the upload mapping.`);
  const equipmentProduction = rawEquipmentProduction;
  const usePoa = [...accumulators.values()].some(
    (item) => item.poaIrradianceReadings > 0,
  );
  const irradianceByInterval = new Map<
    string,
    {
      insolation: number;
      averageWm2: number;
      sensors: number;
      peakWm2: number;
      readingCount: number;
    }
  >();
  accumulators.forEach((accumulator) => {
    const selected = usePoa
      ? accumulator.poaIrradiance
      : accumulator.irradiance;
    selected.forEach((reading, timestamp) => {
      const current = irradianceByInterval.get(timestamp) || {
        insolation: 0,
        averageWm2: 0,
        sensors: 0,
        peakWm2: 0,
        readingCount: 0,
      };
      const averageWm2 = reading.sumWm2 / Math.max(1, reading.count);
      const insolation = averageWm2 * hours / 1000;
      irradianceByInterval.set(timestamp, {
        insolation: current.insolation + insolation,
        averageWm2: current.averageWm2 + averageWm2,
        sensors: current.sensors + 1,
        peakWm2: Math.max(current.peakWm2, reading.peakWm2),
        readingCount: current.readingCount + reading.count,
      });
    });
  });
  const intervalIrradiance = [...irradianceByInterval.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([timestamp, value]) => ({
      timestamp,
      insolationKwhM2: value.insolation / Math.max(1, value.sensors),
      averageWm2: value.averageWm2 / Math.max(1, value.sensors),
      peakWm2: value.peakWm2,
      readingCount: value.readingCount,
    }));
  const irradianceByDay = new Map<
    string,
    { insolation: number; peakWm2: number; readingCount: number }
  >();
  intervalIrradiance.forEach((point) => {
    const date = siteDate(point.timestamp, timezone);
    const current = irradianceByDay.get(date) || {
      insolation: 0,
      peakWm2: 0,
      readingCount: 0,
    };
    irradianceByDay.set(date, {
      insolation: current.insolation + point.insolationKwhM2,
      peakWm2: Math.max(current.peakWm2, point.peakWm2),
      readingCount: current.readingCount + point.readingCount,
    });
  });
  const dailyIrradiance = [...irradianceByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({
      date,
      insolationKwhM2: value.insolation,
      peakWm2: value.peakWm2,
      readingCount: value.readingCount,
    }));
  const expectedProductionMap = shiftMap(siteExpectedProduction);
  accumulators.forEach((accumulator) =>
    accumulator.expectedProduction.forEach((value, timestamp) => {
      if (!expectedProductionMap.has(timestamp))
        expectedProductionMap.set(timestamp, value);
    }),
  );
  const expectedProduction = [...expectedProductionMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([timestamp, energyKwh]) => ({ timestamp, energyKwh }));
  const meterProduction = equipmentProduction.find(
    (item) => item.equipmentType === "revenue_meter",
  );
  const inverterProduction = equipmentProduction.filter(
    (item) => item.equipmentType === "inverter",
  );
  const fallbackProduction = inverterProduction.length
    ? inverterProduction
    : equipmentProduction.filter(
        (item) => item.equipmentType !== "weather_sensor",
      );
  const dailyProduction =
    meterProduction?.dailyProduction ||
    combineProduction(fallbackProduction.map((item) => item.dailyProduction));
  const latest = dailyProduction.at(-1);
  const source = meterProduction?.source || fallbackProduction[0]?.source || "";
  const readingCount =
    meterProduction?.readingCount ||
    fallbackProduction.reduce((sum, item) => sum + item.readingCount, 0);
  return {
    parserVersion: PARSER_VERSION,
    timezone, timestampConvention,
    snowSensorConfigured: snowSensorIds.size > 0, snowReadingCount, snowDays: [...snowDays].sort(),
    intervalMinutes,
    dailyProduction,
    dailyIrradiance,
    intervalIrradiance,
    expectedProduction,
    equipmentProduction,
    timestamps: [...timestamps].map(intervalStart).sort(),
    totalEnergyKwh: dailyProduction.reduce(
      (sum, item) => sum + item.energyKwh,
      0,
    ),
    latestDate: latest?.date || "",
    latestDayEnergyKwh: latest?.energyKwh || 0,
    readingCount,
    source,
  } satisfies TelemetrySummary;
}

function dailyFromIntervals(points: IntervalPoint[], timezone?: string) {
  const daily = new Map<string, number>();
  points.forEach((point) => {
    const date = siteDate(point.timestamp, timezone);
    daily.set(date, (daily.get(date) || 0) + point.energyKwh);
  });
  return [...daily.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, energyKwh]) => ({ date, energyKwh }));
}
function combineProduction(series: DailyPoint[][]) {
  const combined = new Map<string, number>();
  series
    .flat()
    .forEach((point) =>
      combined.set(
        point.date,
        (combined.get(point.date) || 0) + point.energyKwh,
      ),
    );
  return [...combined.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, energyKwh]) => ({ date, energyKwh }));
}
function alignWithArrayModel(
  summary: TelemetrySummary,
  equipment: (typeof equipmentAssets.$inferSelect)[],
) {
  const assets = new Map(equipment.map((asset) => [asset.id, asset]));
  return {
    ...summary,
    equipmentProduction: (summary.equipmentProduction || []).flatMap((item) => {
      const asset = assets.get(item.equipmentId);
      return asset
        ? [
            {
              ...item,
              equipmentName: asset.name,
              equipmentType: asset.type,
              externalId: asset.externalId,
              capacityKw: equipmentCapacity(asset, equipment),
            },
          ]
        : [];
    }),
  } satisfies TelemetrySummary;
}
function compactSummary(summary: TelemetrySummary) {
  return {
    timezone: summary.timezone,
    dailyProduction: summary.dailyProduction,
    totalEnergyKwh: summary.totalEnergyKwh,
    latestDate: summary.latestDate,
    latestDayEnergyKwh: summary.latestDayEnergyKwh,
    readingCount: summary.readingCount,
    source: summary.source,
  } satisfies PublicTelemetrySummary;
}
async function arrayModelRevision(
  equipment: (typeof equipmentAssets.$inferSelect)[],
  site?: Record<string,unknown>,
) {
  const serialized = JSON.stringify(
    [...equipment]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((asset) => ({
        id: asset.id,
        parentId: asset.parentId,
        type: asset.type,
        name: asset.name,
        externalId: asset.externalId,
        capacityKw: asset.capacityKw,
        acRatedCapacityKw: asset.acRatedCapacityKw,
        maxDcCapacityKw: asset.maxDcCapacityKw,
        moduleRatedCapacityW: asset.moduleRatedCapacityW,
        acLineLossPercent: asset.acLineLossPercent,
        transformerLossPercent: asset.transformerLossPercent,
        nameplateKva: asset.nameplateKva,
        pvCeilingOverrideEnabled: asset.pvCeilingOverrideEnabled,
        pvCeilingOverrideKw: asset.pvCeilingOverrideKw,
        quantity: asset.quantity,
        updatedAt: asset.updatedAt,
      })),
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serialized + (site && [site.latitude,site.longitude,site.expectedShading,site.expectedSnow,site.expectedProductionNotes].some(Boolean)?JSON.stringify([site.latitude,site.longitude,site.expectedShading,site.expectedSnow,site.expectedProductionNotes]):"")),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
type PerformanceAnalysis = ReturnType<typeof buildAnalysis>;
type CachedPerformancePointer = {
  parserVersion: number;
  modelRevision: string;
  objectKey: string;
};
type CachedPerformancePayload = {
  methodology?: Record<string, unknown>;
  schemaVersion?: number;
  siteId?: string;
  importId?: string;
  parserVersion: number;
  modelRevision: string;
  generatedAt?: string;
  summary: PublicTelemetrySummary;
  analysis: PerformanceAnalysis;
  capacityKw?: number;
  validation?: Record<string, unknown>;
  timeZone?: string;
  import?: {
    id: string;
    fileName: string;
    createdAt: string;
    timestampStart: string | null;
    timestampEnd: string | null;
  };
  issueDatabase?: {
    analysisRunId: string;
    persistedIssueCount: number;
  };
};
type UserThresholdRow = { minimum_issue_loss_kwh: string };
function applyLossThreshold(analysis: PerformanceAnalysis, value: string) {
  const parsed = value.trim() === "" ? null : Number(value);
  if (parsed === null || !Number.isFinite(parsed))
    return {
      ...analysis,
      issueLossThresholdKwh: null,
      suppressedByLossThreshold: 0,
      unfilteredTotalLossKwh: analysis.totalLossKwh,
      thresholdExcludedLossKwh: 0,
    };
  const recurringKey = (issue: PerformanceIssue) => issue.type === "Underperformance" && issue.category === "Performance" && issue.equipmentType === "inverter" && issue.equipmentId
    ? JSON.stringify([issue.equipmentId, issue.category, issue.type, issue.suspectedCause || ""]) : "";
  const recurring = new Map<string, { lossKwh: number; count: number }>();
  for (const issue of analysis.issues) {
    const key = recurringKey(issue);
    if (!key || issue.lossUnknown) continue;
    const group = recurring.get(key) || { lossKwh: 0, count: 0 };
    group.lossKwh += issue.estimatedLossKwh; group.count++; recurring.set(key, group);
  }
  const issues = analysis.issues.filter(
    (issue) =>
      issue.category === "Communications" || issue.lossUnknown ||
      issue.estimatedLossKwh > parsed || (recurring.get(recurringKey(issue))?.lossKwh || 0) > parsed,
  ).map(issue => {
    const group = recurring.get(recurringKey(issue));
    return group && group.count > 1 ? { ...issue, recurringLossKwh: group.lossKwh, recurringIssueCount: group.count } : issue;
  });
  const lossEligibleIssues = issues.filter(
    (issue) => issue.category !== "Communications",
  );
  const filteredTotalLossKwh = issues.reduce(
    (sum, issue) => sum + issue.estimatedLossKwh,
    0,
  );
  return {
    ...analysis,
    issues,
    totalLossKwh: filteredTotalLossKwh,
    unfilteredTotalLossKwh: analysis.totalLossKwh,
    thresholdExcludedLossKwh: Math.max(0, analysis.totalLossKwh - filteredTotalLossKwh),
    affectedDays: affectedDayCount(issues),
    issueLossThresholdKwh: parsed,
    suppressedByLossThreshold:
      analysis.issues.filter((issue) => issue.category !== "Communications")
        .length - lossEligibleIssues.length,
  };
}

// The full current.json remains the evidence record. This derivative is disposable.
function displayPayload(payload: CachedPerformancePayload): CachedPerformancePayload {
  const numbers = new Map([...payload.analysis.issues].sort((a, b) => a.id.localeCompare(b.id)).map((issue, index) => [issue.id, `#${String(index + 1).padStart(3, "0")}`]));
  const timezone = payload.timeZone || payload.analysis.timezone || payload.summary.timezone;
  const intervalMinutes = payload.analysis.analysisIntervalMinutes;
  return {
    ...payload,
    analysis: {
      ...payload.analysis,
      issues: payload.analysis.issues.map(({ evidence, sharedSourceEvents, ...issue }) => ({
        ...issue,
        timezone,
        intervalMinutes,
        intervalLosses: ((evidence?.intervalLosses || issue.intervalLosses || []) as IntervalLossEvidence[]).map(point => ({
          timestamp: point.timestamp, lossKwh: point.lossKwh,
          countedLossKwh: point.countedLossKwh, intervalMinutes: point.intervalMinutes || intervalMinutes,
          actualKwh: point.actualKwh, expectedKwh: point.expectedKwh,
        })),
        summaryIssueNumber: numbers.get(issue.id),
        summaryPeriods: monthlyLosses({ ...issue, timezone, evidence }, intervalMinutes),
      })),
    },
  };
}
function publicIssue(issue: PerformanceIssue) {
  return { ...issue, estimatedLossKwh: issue.lossUnknown ? null : issue.estimatedLossKwh,
    lossPercent: issue.lossUnknown ? null : issue.lossPercent, actualEnergyKwh: issue.productionUnknown ? null : issue.actualEnergyKwh };
}
async function responseTag(sourceEtag: string, threshold: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    JSON.stringify(["display-v5-recurring", sourceEtag, threshold]),
  ));
  return '"' + [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("") + '"';
}

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const siteId = searchParams.get("siteId")?.trim();
    const statusOnly = searchParams.get("statusOnly") === "1";
    const issueId = searchParams.get("issueId");
    if (!siteId)
      return Response.json({ error: "A site is required." }, { status: 400 });
    if (searchParams.get("progressOnly") === "1") {
      const attemptId = searchParams.get("attemptId");
      if (!attemptId) return Response.json({ error: "An analysis attempt is required." }, { status: 400 });
      const database = getDatabaseBinding();
      const row = await database.prepare("SELECT id FROM analysis_jobs WHERE site_id = ? AND attempt_id = ?")
        .bind(siteId, attemptId).first<{ id: string }>();
      if (!row) return Response.json({ error: "Analysis attempt not found." }, { status: 404 });
      return analysisJobResponse((await readJob(database, row.id))!);
    }
    const db = getDb();
    const [site] = await db
      .select()
      .from(siteSettings)
      .where(eq(siteSettings.id, siteId))
      .limit(1);
    if (!site)
      return Response.json(
        { error: "This site is not available." },
        { status: 404 },
      );
    const record = await currentAnalysisInput(siteId,Number(searchParams.get("year")||2026));
    if (!record)
      return Response.json({
        hasData: false,
        reason: "No telemetry import is available.",
      });
    const bucket = getBucketBinding();
    const database = getDatabaseBinding();
    let analysisObjectKey = `analysis/${record.siteId}/current.json`;
    const displayObjectKey = `analysis/${record.siteId}/display.json`;
    const [equipment, rawCachedRows, thresholdRow, initialStableObject] = await Promise.all([
      db.select().from(equipmentAssets).where(eq(equipmentAssets.siteId, siteId)),
      db.select().from(performanceSummaries).where(eq(performanceSummaries.siteId, siteId)),
      database.prepare("SELECT minimum_issue_loss_kwh FROM user_settings WHERE id = ? LIMIT 1")
        .bind("primary-user").first<UserThresholdRow>(),
      bucket.head(analysisObjectKey),
    ]);
    const cachedRows: (typeof performanceSummaries.$inferSelect)[] = rawCachedRows;
    const modelRevision = await arrayModelRevision(equipment,site);
    const cached = cachedRows.find(item => item.importId === record.id);
    const pointer = cached ? safeJson<CachedPerformancePointer | null>(cached.summary, null) : null;
    const threshold = thresholdRow?.minimum_issue_loss_kwh || "";
    const pendingJob = await readJob(database, await analysisJobKey(record.id, PARSER_VERSION, modelRevision));
    const refreshing = Boolean(pendingJob && pendingJob.status !== "completed" && !pointer?.objectKey?.includes(pendingJob.attempt_id));
    // New jobs publish an immutable result through an atomic database pointer.
    let stableObject = initialStableObject;
    if (pointer && supportedParser(pointer.parserVersion) && pointer.modelRevision === modelRevision && pointer.objectKey) {
      analysisObjectKey = pointer.objectKey;
      if (analysisObjectKey !== `analysis/${record.siteId}/current.json`) stableObject = await bucket.head(analysisObjectKey);
    }
    let sourceEtag = stableObject?.etag || "";
    const stableMetadataMatches = !refreshing &&
      stableObject?.customMetadata?.siteId === record.siteId &&
      stableObject.customMetadata.importId === record.id &&
      supportedParser(stableObject.customMetadata.parserVersion) &&
      stableObject.customMetadata.modelRevision === modelRevision;
    const legacyPointerMatches = !refreshing && pointer &&
      supportedParser(pointer.parserVersion) &&
      pointer.modelRevision === modelRevision &&
      Boolean(pointer.objectKey);
    if (statusOnly)
      return Response.json({
        cacheStatus:
          stableMetadataMatches || legacyPointerMatches ? "stored" : "stale",
      });

    const responseHeaders = new Headers({ "Cache-Control": "private, no-cache", Vary: "Cookie, Authorization" });
    if (stableMetadataMatches && !issueId) {
      responseHeaders.set("ETag", await responseTag(sourceEtag, threshold));
      if (request.headers.get("if-none-match") === responseHeaders.get("ETag"))
        return new Response(null, { status: 304, headers: responseHeaders });
    }
    let payload: CachedPerformancePayload | null = null;
    let cacheStatus: "stored" | "generated" = "stored";
    let loadedDisplay = false;
    if (stableMetadataMatches && !issueId) {
      const compact = await bucket.get(displayObjectKey);
      if (compact?.customMetadata?.sourceEtag === sourceEtag && compact.customMetadata.displayVersion === "4") {
        const candidate = await readCheckpoint<CachedPerformancePayload>(compact);
        if (candidate?.siteId === siteId && candidate.importId === record.id &&
            candidate.modelRevision === modelRevision && supportedParser(candidate.parserVersion) && candidate.issueDatabase) {
          payload = candidate;
          loadedDisplay = true;
        }
      }
    }
    if (!payload && stableMetadataMatches) {
      const object = await bucket.get(analysisObjectKey);
      if (object) {
        const candidate = await readCheckpoint<CachedPerformancePayload>(object);
        if (
          candidate?.siteId === record.siteId &&
          candidate.importId === record.id &&
          candidate && supportedParser(candidate.parserVersion) &&
          candidate.modelRevision === modelRevision &&
          candidate.issueDatabase
        )
          payload = candidate;
      }
    }
    if (!payload && legacyPointerMatches && pointer) {
      const object = await bucket.get(pointer.objectKey);
      if (object) {
        const candidate = await readCheckpoint<CachedPerformancePayload>(object);
        if (
          candidate && supportedParser(candidate.parserVersion) &&
          candidate.modelRevision === modelRevision
        )
          payload = candidate;
      }
    }

    if (!payload?.issueDatabase || payload.importId !== record.id) {
      payload = null;
      const key = await analysisJobKey(record.id, PARSER_VERSION, modelRevision);
      let job = await readJob(database, key);
      if (!job) {
        job = await getOrCreateJob(database, key, siteId, record.id);
        return analysisJobResponse(job);
      }
      if (job.status !== "processing") return analysisJobResponse(job);
      const token = await claimJob(database, job);
      if (!token) return analysisJobResponse((await readJob(database, key))!, true);
      const root = `analysis/${siteId}/jobs/${job.attempt_id}`;
      const resultKey = `${root}/result.json`;
      const report = (stage: AnalysisStage, completed = 0, total = 0, release = false) =>
        reportProgress(database, job!, token, stage, completed, total, release);
      const readSnapshot = async <T,>(name: string): Promise<T> => {
        const object = await bucket.get(`${root}/${name}.json`);
        if (!object) throw new Error("Analysis checkpoint is unavailable.");
        return await readCheckpoint<T>(object);
      };
      try {
        if (job.stage === "read") {
          const summary = alignWithArrayModel(await buildSummary(record, equipment,
            (completed, total) => report("read", completed, total)), equipment);
          summary.causeContext = { latitude: site.latitude || "", longitude: site.longitude || "", timeZone: record.timezone,
            assumptions: expectedAssumptions(site) };
          await report("read", record.rowCount, record.rowCount);
          await bucket.put(`${root}/summary.json`, JSON.stringify(packSummary(summary)));
          await report("equipment", 0, summary.equipmentProduction?.length || 0, true);
        } else if (job.stage === "equipment" || job.stage === "reconcile") {
          // Progress may be ahead of the last durable batch when a request dies.
          let retained = await bucket.get(`${root}/equipment-final.json`);
          for(let offset=Math.floor(job.completed/16)*16;!retained&&offset>=16;offset-=16)
            retained=await bucket.get(`${root}/equipment-${offset}.json`);
          const previous = retained ? await readCheckpoint<{offset:number;issues:PerformanceIssue[];coverage?:InverterExpectationContext["coverage"]}>(retained) : {offset:0,issues:[]};
          const summary = unpackSummary<TelemetrySummary>(await readSnapshot("summary"));
          const steps = buildAnalysisSteps(summary, equipment, {offset:previous.offset,limit:16,issues:previous.issues,coverage:previous.coverage});
          let next = steps.next();
          while (!next.done) {
            if ("equipmentCheckpoint" in next.value && next.value.equipmentCheckpoint) {
              const checkpointName = next.value.stage === "reconcile" ? "equipment-final" : `equipment-${next.value.completed}`;
              await report("equipment", next.value.completed, next.value.total);
              await writeCheckpoint(bucket, `${root}/${checkpointName}.json`, {offset:next.value.completed,...next.value.equipmentCheckpoint});
              await report(next.value.stage, next.value.stage === "reconcile" ? 0 : next.value.completed,
                next.value.stage === "reconcile" ? 1 : next.value.total, true);
              return analysisJobResponse((await readJob(database,key))!);
            }
            await report(next.value.stage, next.value.completed, next.value.total);
            next = steps.next();
          }
          const source: CachedPerformancePayload = { parserVersion: PARSER_VERSION,
            modelRevision, summary: compactSummary(summary), analysis: next.value };
          await report("reconcile", 1, 1);
          await writeCheckpoint(bucket, `${root}/analysis.json`, source);
          // Save requests fetch only their own 300 records, not the entire fleet's index.
          for (let offset=0;offset<source.analysis.issues.length;offset+=1800) {
            const starts=Array.from({length:Math.min(6,Math.ceil((source.analysis.issues.length-offset)/300))},(_,i)=>offset+i*300);
            await Promise.all(starts.map(start=>writeCheckpoint(bucket, `${root}/save-${start}.json`,
              issueSaveIndex(source.analysis.issues.slice(start,start+300),resultKey))));
            await report("reconcile",1,1);
          }
          await bucket.put(`${root}/save-manifest.json`,JSON.stringify({count:source.analysis.issues.length}));
          await report("save", 0, source.analysis.issues.length, true);
        } else if (job.stage === "save") {
          const manifest = await bucket.get(`${root}/save-manifest.json`);
          const start = job.completed;
          if (manifest) {
            const {count} = await manifest.json<{count:number}>();
            const issues = count ? await readSnapshot<PerformanceIssue[]>(`save-${start}`) : [];
            await persistPerformanceIssues({database,siteId,importId:record.id,parserVersion:PARSER_VERSION,modelRevision,
              analysisObjectKey:resultKey,issues,runIdOverride:job.attempt_id,append:true,checkpoint:()=>report("save",start,count)});
            const end=Math.min(start+issues.length,count);
            await report(end===count?"finalize":"save",end===count?0:end,end===count?1:count,true);
            return analysisJobResponse((await readJob(database,key))!);
          }
          const index = await bucket.get(`${root}/save.json`);
          let issues: PerformanceIssue[];
          if (index) {
            issues = await index.json<PerformanceIssue[]>();
          } else {
            // Jobs started before this optimization retain their saved offset.
            const source = await readSnapshot<CachedPerformancePayload>("analysis");
            issues = issueSaveIndex(source.analysis.issues, resultKey);
            await bucket.put(`${root}/save.json`, JSON.stringify(issues));
          }
          // A request saves a bounded slice, then releases its lease. Browser
          // refreshes and retries resume after the last fully saved slice.
          const end = Math.min(start + 300, issues.length);
          await persistPerformanceIssues({ database, siteId, importId: record.id,
            parserVersion: PARSER_VERSION, modelRevision, analysisObjectKey: resultKey,
            issues: issues.slice(start, end), runIdOverride: job.attempt_id,
            append: true, checkpoint: () => report("save", start, issues.length) });
          await report(end === issues.length ? "finalize" : "save",
            end === issues.length ? 0 : end,
            end === issues.length ? 1 : issues.length, true);
        } else if (job.stage === "finalize") {
          await report("finalize", 0, 1);
          const source = await readSnapshot<CachedPerformancePayload>("analysis");
          const persisted = await readPerformanceIssueReferences(database, job.attempt_id);
          const byId = new Map(persisted.map(issue => [issue.id, issue]));
          if (byId.size !== source.analysis.issues.length || source.analysis.issues.some(issue => !byId.has(issue.id)))
            throw new Error("Analysis issue records are incomplete.");
          const issues = source.analysis.issues;
          for(let offset=0;offset<issues.length;offset+=100){
            await Promise.all(issues.slice(offset,offset+100).map(async issue=>{
              const saved=byId.get(issue.id),evidence=issue.evidence;
              Object.assign(issue,{hasSharedReduction:evidence?.rule==="shared_site_reduction_v1",databaseId:saved?.databaseId,
                eventKey:await issueEventKey(siteId,issue),evidenceSignature:await issueEvidenceSignature(issue),confidenceDetail:defaultConfidence(issue),
                intervalLosses:(evidence?.intervalLosses||[]) as IntervalLossEvidence[],sharedSourceEvents:evidence?.sharedSourceEvents,
                evidence:{...compactIssueEvidence(evidence,resultKey),sourceIssueId:issue.id,analysisRunId:job.attempt_id}});
            }));
            if(offset%1000===0)await report("finalize",offset,issues.length);
          }
          const memberIndex=new Map(issues.map(i=>[i.id,i]));
          const recurringIssues=await Promise.all((source.analysis.recurringIssues||[]).map(async episode=>{
            const members=episode.members.map(m=>{const i=memberIndex.get(m.id)!;return {id:i.id,eventKey:i.eventKey,evidenceSignature:i.evidenceSignature};});
            const hash=async(value:unknown)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value))))].map(b=>b.toString(16).padStart(2,"0")).join("");
            return {...episode,members,eventKey:await hash([siteId,"recurring-v1",episode.id]),evidenceSignature:await hash(members.map(m=>[m.eventKey,m.evidenceSignature]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))};
          }));
          payload = { ...source, schemaVersion: 1, siteId, importId: record.id,
            generatedAt: new Date().toISOString(), analysis: { ...source.analysis, issues, recurringIssues },
            capacityKw: gridCapacity(equipment), validation: safeJson<Record<string, unknown>>(record.validation, {}),
            timeZone: record.timezone, import: { id: record.id, fileName: record.fileName,
              createdAt: record.createdAt, timestampStart: record.timestampStart, timestampEnd: record.timestampEnd },
            issueDatabase: { analysisRunId: job.attempt_id, persistedIssueCount: issues.length },
            methodology:{analysisId:job.attempt_id,generatedAt:new Date().toISOString(),calculationVersion:PARSER_VERSION,modelRevision,
              equipmentModel:equipment,siteSettings:site,timezone:record.timezone,intervalMinutes:source.analysis.analysisIntervalMinutes,
              partitionHashes:safeJson<Record<string,unknown>>(record.validation,{}).partitionHashes||null,
              timestampConvention:safeJson<Record<string,unknown>>(record.validation,{}).timestampConvention||"start",
              sourceImports:safeJson<Record<string,unknown>>(record.validation,{}).sourceImports||[{id:record.id,fileName:record.fileName,createdAt:record.createdAt}],
              datasetRevision:safeJson<Record<string,unknown>>(record.validation,{}).datasetManifest?record.id:null,thresholdAtAnalysis:threshold,thresholdMethod:"Individual issue or recurring inverter underperformance total, grouped by equipment/category/type/suspected cause across the full analysis period; strict greater-than threshold.",peerComparison:source.analysis.peerComparison,inverterExpectation:source.analysis.inverterExpectation,sharedReduction:source.analysis.sharedReduction,recurringPolicy:RECURRING_POLICY,transformerLimits:source.analysis.transformerLimits,
              exclusions:source.analysis.baselineMethod,lowIrradianceThresholdWm2:MIN_IRRADIANCE_WM2} };
          await report("finalize", 0, 1);
          await writeCheckpoint(bucket,`${root}/review-index.json`,{siteId,issueDatabase:payload.issueDatabase,analysis:{recurringIssues,issues:issues.map(({evidence,intervalLosses,sharedSourceEvents,...issue})=>issue)}});
          const saved = await writeCheckpoint(bucket, resultKey, payload, {
            httpMetadata: { contentType: "application/json" },
            customMetadata: { siteId, importId: record.id, parserVersion: String(PARSER_VERSION), modelRevision },
          });
          await publishJob(database, job, token, JSON.stringify({ parserVersion: PARSER_VERSION,
            modelRevision, objectKey: resultKey }), resultKey, issues.length);
          sourceEtag = saved?.etag || "";
          cacheStatus = "generated";
          // Intermediate checkpoints are disposable once the complete result is published.
          const disposable=[`${root}/summary.json`,`${root}/analysis.json`,`${root}/save.json`,`${root}/save-manifest.json`,`${root}/equipment-final.json`];
          for(let offset=16;offset<equipment.filter((e:typeof equipmentAssets.$inferSelect)=>e.type==="inverter").length;offset+=16)disposable.push(`${root}/equipment-${offset}.json`);
          for(let offset=0;offset<issues.length;offset+=300)disposable.push(`${root}/save-${offset}.json`);
          await bucket.delete(disposable).catch(()=>undefined);
          // Serve the display in its own request; finalization has already used its CPU budget.
          return Response.json({processing:true,hasData:false,progress:jobProgress((await readJob(database,key))!),retryAfterMs:250},
            {status:202,headers:{"Cache-Control":"private, no-store"}});
        }
      } catch (error) {
        if (!(error instanceof AnalysisStopped)) console.error("Analysis stage failed", JSON.stringify({
          siteId, attemptId: job.attempt_id, stage: job.stage, completed: job.completed,
          error: databaseErrorDetails(error),
        }));
        await stopJob(database, job, token, error);
        return analysisJobResponse((await readJob(database, key))!);
      }
      if (!payload) return analysisJobResponse((await readJob(database, key))!);
    }
    if (!payload) throw new Error("The saved analysis could not be loaded.");
    if (issueId) {
      const issue = payload.analysis.issues.find(item => item.id === issueId || item.databaseId === issueId);
      if (issue?.evidence?.evidenceFormat === "analysis-result") {
        // This request already loaded the full saved analysis. Reattach its
        // ledger for the detail view without another storage request.
        issue.evidence = { ...issue.evidence, intervalLosses: issue.intervalLosses || [] };
      } else if (issue?.evidence?.evidenceKey) {
        // Analyses saved by the previous release use one evidence file per issue.
        const stored = await bucket.get(String(issue.evidence.evidenceKey));
        if (stored) issue.evidence = await stored.json<Record<string, unknown>>();
      }
      if (issue?.evidence?.peerComparison && payload.analysis.peerComparison?.referenceSets) {
        const indexes = new Set(((issue.evidence.intervalLosses || []) as Record<string, unknown>[])
          .map(p => p.peerSetIndex).filter((id): id is number => typeof id === "number"));
        issue.evidence.peerReferenceSets = Object.fromEntries([...indexes].map(id => [id, payload!.analysis.peerComparison.referenceSets[id]]));
        const referenceIds = new Set([...indexes].flatMap(id => payload!.analysis.peerComparison.referenceSets[id] || []));
        const qualification = payload.analysis.peerComparison.referenceQualification;
        if (qualification) issue.evidence.peerReferenceQualification = { method: payload.analysis.peerComparison.qualification, deliveryFactor: qualification.deliveryFactor, records: qualification.records.filter(r => referenceIds.has(r.equipmentId)) };
      }
      return Response.json(issue ? { issue: publicIssue(issue) } : { error: "Issue not found." }, {
        status: issue ? 200 : 404, headers: { "Cache-Control": "private, no-store" },
      });
    }
    if (!loadedDisplay) {
      payload = displayPayload(payload);
      // A failed derivative write must not prevent serving the authoritative analysis.
      if (sourceEtag) await writeCheckpoint(bucket, displayObjectKey, payload, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { sourceEtag, displayVersion: "4" },
      }).catch(() => undefined);
    }
    if (sourceEtag) responseHeaders.set("ETag", await responseTag(sourceEtag, threshold));
    const summary = payload.summary;
    const analysis = applyLossThreshold(
      payload.analysis,
      threshold,
    );
    return analysisJsonResponse({
      hasData: Boolean(summary.dailyProduction.length || analysis.issues.length),
      reason: summary.dailyProduction.length
        ? ""
        : "The latest import does not contain a mapped interval Energy or Active power signal for configured equipment. DC power is not AC production.",
      summary,
      analysis: { ...analysis, issues: analysis.issues.map(publicIssue) },
      issueDatabase: payload.issueDatabase,
      methodology: payload.methodology,
      cacheStatus,
      capacityKw: payload.capacityKw ?? gridCapacity(equipment),
      validation:
        payload.validation ||
        safeJson<Record<string, unknown>>(record.validation, {}),
      timeZone: payload.timeZone || record.timezone,
      import: payload.import || {
        id: record.id,
        fileName: record.fileName,
        createdAt: record.createdAt,
        timestampStart: record.timestampStart,
        timestampEnd: record.timestampEnd,
      },
    }, { headers: responseHeaders });
  } catch (error) {
    console.error("Performance analysis failed.", error);
    const message = error instanceof Error ? error.message : "";
    const safe = /retained CSV|revenue meter|mapped/.test(message)
      ? message
      : "Unable to analyze the latest production import.";
    return Response.json({ hasData: false, error: safe }, { status: 500 });
  }
}

function analysisJobResponse(job: AnalysisJob, waiting = false) {
  const processing = job.status === "processing" || job.status === "canceling";
  return Response.json({ processing, hasData: false, progress: jobProgress(job), waiting,
    retryAfterMs: waiting ? 1500 : 250,
    error: job.status === "canceled" ? "Analysis canceled. Your uploaded file is retained." : job.error,
  }, { status: processing ? 202 : 200, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  try {
    const { siteId, attemptId, action } = await request.json() as Record<string, string>;
    if (siteId && action === "reanalyze") {
      const db=getDb();
      const [site]=await db.select().from(siteSettings).where(eq(siteSettings.id,siteId)).limit(1);
      if (!site) return Response.json({error:"This site is not available."},{status:404});
      const record=await currentAnalysisInput(siteId,2026);
      if (!record) return Response.json({error:"Upload performance data first."},{status:400});
      const equipment=await db.select().from(equipmentAssets).where(eq(equipmentAssets.siteId,siteId));
      const revision=await arrayModelRevision(equipment,site);
      return analysisJobResponse(await restartJob(getDatabaseBinding(),await analysisJobKey(record.id,PARSER_VERSION,revision),siteId,record.id));
    }
    if (!siteId || !attemptId || !["cancel", "retry"].includes(action))
      return Response.json({ error: "A site, analysis attempt, and valid action are required." }, { status: 400 });
    const job = await controlJob(getDatabaseBinding(), siteId, attemptId, action as "cancel" | "retry");
    if (!job) return Response.json({ error: "Analysis attempt not found." }, { status: 404 });
    return analysisJobResponse(job);
  } catch (error) {
    console.error("Analysis control failed", error);
    return Response.json({ error: "Unable to update the analysis. Please try again." }, { status: 500 });
  }
}
