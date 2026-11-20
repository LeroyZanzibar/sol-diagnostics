import { readCheckpoint, writeCheckpoint, analysisJsonResponse } from "./checkpoint-storage";
import { isCompletedAnalysisRun, publishedAnalysisAvailable } from "../analysis-history/availability";
import { arrayCapacityModel } from "../../array-capacity";
import { inverterExpectationContext, type InverterExpectationContext } from "./inverter-expectation";
import { transformerAnalysisContext, transformerIntervalTotals, limitTransformerLosses } from "./transformer-limits";
import { meterMappingError } from "../../meter-mapping";
import { packSummary, unpackSummary, compactIssueEvidence, issueSaveIndex } from "./analysis-storage";
import { currentAnalysisInput, readManifest } from "../data-history/service";
import { canonicalAnalysisCsv, captureAnalysisProvenance, resumeAnalysisProvenance, analysisRevisionIsCurrent, legacyAnalysisInputIsCurrent, assessAnalysisFreshness } from "../performance-data/analysis";
import type { PerformanceAnalysisProvenance } from "../../../db/performance-store";
import { historyCsv, decodeHistoryCells, type HistoryCell } from "../../data-history";
import { issueEventKey, issueEvidenceSignature, defaultConfidence } from "../../issue-review";
import { prepareTelemetry, reconcileTelemetry } from "./telemetry-events";
import { expectedAssumptions, type CauseSummary, type SuspectedCause } from "./causes";
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

import { analysisJobKey, restartJob, readJob, claimJob, reportProgress, stopJob, publishJob, controlJob, jobProgress, AnalysisStopped, type AnalysisJob, type AnalysisStage } from "./jobs";

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
  methodId?: string;
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
  expectedUnknown?: boolean;
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

const PARSER_VERSION = 29;
const OUTAGE_METHOD_ID = "outage-only-v2";
// Outage-only calculation identity. Completed older snapshots retain their identity.
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
function addMinutes(value: string, minutes: number) {
  return timestampAt(intervalNumber(value) + minutes * 60000, value);
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
  try {
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
  } finally {
    // Lease cancellation or a bad row must close a pinned database iterator too.
    await reader.cancel().catch(()=>undefined);
    reader.releaseLock();
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
/** Outages are observed production states; no historical fit or deficit training. */
function analyzeEquipment(
  production: EquipmentProduction,
  irradiance: Map<string, IntervalIrradiancePoint>,
  intervalMinutes: number,
  siteImpactPercent: number,
  importedExpected: Map<string, number>,
  expectationContext?: InverterExpectationContext,
  blocked: Set<string> = new Set(),
  siteOutageTimestamps: Set<string> = new Set(),
) {
  const assessments: Array<IntervalAssessment & { lossUnknown: boolean; expectedUnknown: boolean }> = [];
  for (const point of production.intervalProduction || []) {
    const { timestamp, energyKwh: actual } = point;
    if (!Number.isFinite(actual) || blocked.has(timestamp)) continue;
    const supplied = importedExpected.get(timestamp);
    const validExpected = supplied !== undefined && Number.isFinite(supplied) && supplied >= 0;
    const sun = irradiance.get(timestamp)?.averageWm2;
    if (!(sun !== undefined ? Number.isFinite(sun) && sun >= MIN_IRRADIANCE_WM2 : validExpected && supplied > 0)) continue;
    const inverter = production.equipmentType === "inverter";
    // Keep the supported partially affected interval immediately before a full
    // site outage. A positive deficit by itself is not an outage finding.
    const onset = production.equipmentType === "revenue_meter" && validExpected && supplied > 0 &&
      actual > 0 && actual / supplied < .7 && siteOutageTimestamps.has(addMinutes(timestamp, intervalMinutes));
    if (inverter ? actual !== 0 : !onset) continue;
    const allocation = inverter ? expectationContext?.at(production.equipmentId, timestamp) : undefined;
    const expected = inverter ? allocation?.expectedKwh : validExpected ? supplied : undefined;
    const unknown = expected === undefined;
    assessments.push({ timestamp, actualKwh: actual, expectedKwh: expected ?? 0,
      lossKwh: unknown ? 0 : Math.max(0, expected - actual), ratio: expected ? actual / expected : 0,
      type: inverter ? "Equipment outage" : "Site outage", severity: "critical",
      lossUnknown: unknown, expectedUnknown: unknown, derivedExpectedKwh: allocation?.expectedKwh,
      rule: inverter ? "outage_inverter_allocation_v2" : "supported_site_outage_onset_v2" });
  }
  const groups: typeof assessments[] = [];
  for (const item of assessments) {
    const group = groups.at(-1), previous = group?.at(-1);
    if (group && previous && previous.lossUnknown === item.lossUnknown &&
        gapContainsOnlyLowIrradiance(previous.timestamp, item.timestamp, irradiance, intervalMinutes)) group.push(item);
    else groups.push([item]);
  }
  return groups.map((group, index): PerformanceIssue => {
    const expected = group.reduce((sum, p) => sum + p.expectedKwh, 0);
    const actual = group.reduce((sum, p) => sum + p.actualKwh, 0);
    const loss = group.reduce((sum, p) => sum + p.lossKwh, 0);
    const first = group[0], start = first.timestamp, end = addMinutes(group.at(-1)!.timestamp, intervalMinutes);
    const durationMinutes = (intervalNumber(end) - intervalNumber(start)) / 60000;
    const description = production.equipmentType === "inverter"
      ? "The inverter reports zero production during qualified daylight. Loss uses its configured DC/AC share of the supplied site Expected Production, not measured peers."
      : "This partially affected interval directly precedes a supported full site outage. Loss uses the supplied Expected Production at the same timestamp.";
    return { id: `${production.equipmentId}-${first.type.toLowerCase().replace(/\s+/g, "-")}-${start}-${index}`,
      name: production.equipmentType === "inverter" ? `Inverter ${production.equipmentName} offline` : first.type,
      type: first.type, category: "Performance", confidence: "model-based", severity: "critical",
      equipmentId: production.equipmentId, equipmentName: production.equipmentName, equipmentType: production.equipmentType,
      equipmentExternalId: production.externalId, startDateTime: start, endDateTime: end, durationMinutes, durationDays: durationMinutes / 1440,
      estimatedLossKwh: loss, lossPercent: expected ? Math.min(100, loss / expected * 100) : 0,
      actualEnergyKwh: actual, expectedEnergyKwh: expected, siteImpactPercent,
      lossUnknown: first.lossUnknown, expectedUnknown: first.expectedUnknown, productionUnknown: false,
      description: description + (first.lossUnknown ? " Energy loss is unknown and excluded from quantified totals." : ""),
      evidence: { rule: first.rule, lossUnknown: first.lossUnknown, expectedUnknown: first.expectedUnknown, productionUnknown: false,
        intervalCount: group.length, minimumIrradianceWm2: MIN_IRRADIANCE_WM2,
        intervalLosses: group.map(p => ({ timestamp: p.timestamp, actualKwh: p.actualKwh, expectedKwh: p.expectedKwh,
          lossKwh: p.lossKwh, lossUnknown: p.lossUnknown, expectedUnknown: p.expectedUnknown,
          ...(p.derivedExpectedKwh !== undefined ? { derivedInverterExpectedKwh: p.derivedExpectedKwh } : {}) })) }
    };
  });
}

type IntervalLossEvidence = {
  timestamp: string;
  lossKwh: number;
  countedLossKwh?: number;
  intervalMinutes?: number;
  actualKwh?: number;
  expectedKwh?: number;
  lossUnknown?: boolean;
  expectedUnknown?: boolean;
  hierarchyCovered?: boolean;
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
  const attributedEquipmentIssues = equipmentIssues.map((issue) => {
    if (issue.equipmentType !== "inverter") return issue;
    const intervals = Array.isArray(issue.evidence?.intervalLosses)
      ? (issue.evidence.intervalLosses as IntervalLossEvidence[])
      : [];
    let changed = false;
    const attributedIntervals = intervals.map((interval) => {
      changed = true;
      // Known energy crosses the delivery boundary independently of loss coverage.
      const deliveredInterval = {
        ...interval,
        actualKwh: interval.actualKwh === undefined ? undefined : interval.actualKwh * deliveryFactor,
        expectedKwh: interval.expectedKwh === undefined ? undefined : interval.expectedKwh * deliveryFactor,
      };
      if (issue.lossUnknown || interval.lossUnknown) return deliveredInterval;
      const delivered = interval.lossKwh * deliveryFactor;
      return {
        ...deliveredInterval,
        lossKwh: delivered,
        lossBoundary: "meter_poi", inverterTerminalLossKwh: interval.lossKwh,
      };
    });
    if (!changed) return issue;
    const estimatedLossKwh = issue.lossUnknown ? issue.estimatedLossKwh : attributedIntervals.reduce(
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
        ...(!issue.lossUnknown ? {
          originalEstimatedLossKwh: issue.estimatedLossKwh,
          siteDeliveredAttributedLossKwh: estimatedLossKwh,
        } : {}),
        siteDeliveryFactor: deliveryFactor,
      },
    };
  });
  return {
    meterIssues,
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
    if (issue.type !== "Site outage") return;
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
      return { ...interval, hierarchyCovered: covered, countedLossKwh: covered ? 0 : interval.lossKwh };
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

const OUTAGE_METHOD = "Outages require measured zero production or corroborating telemetry during daylight. Site losses use supplied weather-adjusted Expected Production at each timestamp; inverter losses use the complete DC/AC model, transformer headroom and one delivery conversion. Missing references or required readings leave loss unknown, without hiding known production. Site outages take priority over covered inverter intervals, so overlapping loss is counted once.";

function* buildAnalysisSteps(
  summary: TelemetrySummary,
  equipment: (typeof equipmentAssets.$inferSelect)[],
  batch?: { offset: number; limit: number; issues: PerformanceIssue[] },
) {
  const transformerContext = transformerAnalysisContext(summary, equipment);
  const telemetryPlan = prepareTelemetry(summary, equipment);
  const transformerTotals = transformerIntervalTotals(summary, transformerContext.model);
  const inverterContext = inverterExpectationContext(summary, equipment);
  const production = summary.equipmentProduction || [];
  const intervalMinutes = summary.intervalMinutes || 60;
  const timezone = summary.timezone || summary.causeContext?.timeZone;
  const irradiance = new Map((summary.intervalIrradiance || []).map(p => [p.timestamp, p]));
  const importedExpected = new Map((summary.expectedProduction || []).map(p => [p.timestamp, p.energyKwh]));
  const inverterItems = production.filter(p => p.equipmentType === "inverter");
  const equipmentIssues: PerformanceIssue[] = batch?.issues || [];
  let processed = batch?.offset || 0;
  yield { stage: "equipment" as AnalysisStage, completed: processed, total: inverterItems.length };
  for (const item of inverterItems.slice(processed)) {
    equipmentIssues.push(...analyzeEquipment(item, irradiance, intervalMinutes,
      equipmentSiteImpactPercent(item.equipmentId, equipment), importedExpected, inverterContext, telemetryPlan.blocked.get(item.equipmentId)));
    yield { stage: "equipment" as AnalysisStage, completed: ++processed, total: inverterItems.length };
    if (batch && (processed - batch.offset >= batch.limit || processed === inverterItems.length)) {
      yield { stage: (processed === inverterItems.length ? "reconcile" : "equipment") as AnalysisStage,
        completed: processed, total: inverterItems.length, equipmentCheckpoint: { issues: equipmentIssues } };
    }
  }
  const siteOutageTimestamps = new Set(telemetryPlan.events.filter(e => e.type === "Site outage").map(e => e.timestamp));
  const meterIssues = production.filter(p => p.equipmentType === "revenue_meter").flatMap(item =>
    analyzeEquipment(item, irradiance, intervalMinutes, 100, importedExpected, undefined,
      telemetryPlan.blocked.get(item.equipmentId), siteOutageTimestamps));
  inverterContext.rates.clear();
  yield { stage: "reconcile" as AnalysisStage, completed: 0, total: 1 };
  const attributed = applyInverterLossAttribution(meterIssues,
    limitTransformerLosses(equipmentIssues, transformerContext.model, transformerTotals, transformerContext.hours), equipment, intervalMinutes);
  equipmentIssues.length = 0;
  transformerTotals.clear();
  const reconciled = applyHierarchyLossPriority([...attributed.meterIssues, ...attributed.equipmentIssues], equipment);
  const issues = reconcileTelemetry(reconciled, telemetryPlan).map(issue => ({ ...issue, timezone, intervalMinutes,
    detectionBasis: String(issue.evidence?.rule || "outage_only_v2") })).sort((a, b) =>
      b.estimatedLossKwh - a.estimatedLossKwh || a.startDateTime.localeCompare(b.startDateTime));
  const primary = production.find(p => p.equipmentType === "revenue_meter") || production[0];
  const first = summary.timestamps?.[0] || primary?.intervalProduction?.[0]?.timestamp || "";
  const last = summary.timestamps?.at(-1) || primary?.intervalProduction?.at(-1)?.timestamp || first;
  const timestamps = new Set([...(summary.timestamps || []), ...irradiance.keys(), ...importedExpected.keys()]);
  const inRange = [...timestamps].filter(t => !first || (t >= first && t <= last));
  const qualified = inRange.filter(t => { const sun = irradiance.get(t)?.averageWm2, expected = importedExpected.get(t);
    return sun !== undefined ? Number.isFinite(sun) && sun >= MIN_IRRADIANCE_WM2 : expected !== undefined && Number.isFinite(expected) && expected > 0; });
  const lowLight = [...irradiance.values()].filter(p => (!first || (p.timestamp >= first && p.timestamp <= last)) && p.averageWm2 < MIN_IRRADIANCE_WM2);
  return { issues, recurringIssues: [], timezone, telemetryQuality: summary.telemetryQuality,
    inverterExpectation: inverterContext.methodology(),
    ...(transformerContext.model.hasTransformers ? { transformerLimits: transformerContext.methodology } : {}),
    totalLossKwh: issues.reduce((sum, issue) => sum + (issue.lossUnknown ? 0 : issue.estimatedLossKwh), 0),
    affectedDays: affectedDayCount(issues), analyzedDays: new Set(qualified.map(t => siteDate(t, timezone))).size,
    analyzedIntervals: qualified.length, analysisIntervalMinutes: intervalMinutes, irradianceAvailable: irradiance.size > 0,
    irradianceDays: new Set([...irradiance.keys()].map(t => siteDate(t, timezone))).size,
    skippedLowIrradianceDays: new Set(lowLight.map(p => siteDate(p.timestamp, timezone))).size,
    skippedLowIrradianceIntervals: lowLight.length, lowIrradianceThresholdWm2: MIN_IRRADIANCE_WM2,
    baselineMethod: OUTAGE_METHOD };
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
  // Incomplete allocation must not block measured outages or telemetry findings.
  // Quantification still requires the full DC/AC model and branch readings.
  const historyMetadata = safeJson<Record<string, unknown>>(record.validation, {});
  const object = historyMetadata.performanceStore ? { body: canonicalAnalysisCsv(record, equipment) } : historyMetadata.datasetManifest ? { body: historyCsv(await readManifest(record.siteId,record.id), async key => {
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
  const resolveEquipment = (identity: string) => assetsById.has(identity) ? identity : identityMap.get(normalized(identity));
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
        accumulator.expectedProduction.set(timestamp, value);
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
  try { await progress?.(0, record.rowCount); }
  catch (error) { await object.body.cancel().catch(()=>undefined); throw error; }
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
    const longId = roles.equipment ? resolveEquipment(row[indexes[roles.equipment]] || "") : undefined;
    const rawMeasurement = roles.measurement ? row[indexes[roles.measurement]] || "" : "";
    const longMeasurement = historyMetadata.performanceStore ? rawMeasurement : measurementFrom(rawMeasurement);
    const intervalMeasurement = (measurement: string) => ["Energy", "Active power", "Expected Production"].includes(measurement) || /irradiance/i.test(measurement);
    const hasLongValue = Boolean(roles.value && row[indexes[roles.value]]?.trim());
    const categorical = (measurement: string) => ["Snow code", "Status", "Other", "Availability"].includes(measurement);
    const hasCategoricalValue = Boolean(longId && (snowSensorIds.has(longId) || categorical(longMeasurement)) && hasLongValue) ||
      signals.some(signal => (snowSensorIds.has(signal.equipmentId!) || categorical(signal.measurement || measurementFrom(signal.column!))) && row[indexes[signal.column!]]?.trim());
    const hasIntervalValue = Boolean(roles.expectedProduction && row[indexes[roles.expectedProduction]]?.trim()) ||
      Boolean(longId && !snowSensorIds.has(longId) && intervalMeasurement(longMeasurement) && hasLongValue) ||
      signals.some(signal => !snowSensorIds.has(signal.equipmentId!) && intervalMeasurement(signal.measurement || measurementFrom(signal.column!)) && row[indexes[signal.column!]]?.trim());
    if ((!hasCategoricalValue || hasIntervalValue) && !(historyMetadata.performanceStore && longId && snowSensorIds.has(longId))) timestamps.add(timestamp);
    if (roles.expectedProduction) {
      const expected = toKwh(
        row[indexes[roles.expectedProduction]] || "",
        "kWh",
        roles.expectedProduction,
      );
      if (expected !== null)
        siteExpectedProduction.set(timestamp, expected);
    }
    const unit = roles.unit ? row[indexes[roles.unit]] || "" : "";
    if (roles.equipment && roles.measurement && roles.value) {
      const equipmentId = resolveEquipment(row[indexes[roles.equipment]] || "");
      if (equipmentId)
        addReading(
          equipmentId,
          longMeasurement,
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
  // A selected site reference owns its missingness too. An equipment channel
  // must not fill its blanks or replace its invalid values.
  if (!roles.expectedProduction) accumulators.forEach((accumulator) => {
    accumulator.expectedProduction.forEach((value, timestamp) => {
      if (!expectedProductionMap.has(timestamp))
        expectedProductionMap.set(timestamp, value);
    });
  });
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
type PerformanceAnalysis = ReturnType<typeof buildAnalysis> & {
  peerComparison?: { referenceSets: Record<number, string[]>; qualification?: unknown;
    referenceQualification?: { deliveryFactor: number; records: Array<{ equipmentId: string }> } };
};
type CachedPerformancePointer = {
  parserVersion: number;
  modelRevision: string;
  objectKey: string;
  analysisRunId?: string;
};
type CachedPerformancePayload = {
  methodId?: string;
  provenance?: PerformanceAnalysisProvenance | null;
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
type AnalysisInputCheckpoint = {
  parserVersion: number;
  methodId: string;
  record: typeof telemetryImports.$inferSelect;
  equipment: (typeof equipmentAssets.$inferSelect)[];
  site: typeof siteSettings.$inferSelect;
  modelRevision: string;
  provenance?: PerformanceAnalysisProvenance | null;
};
class IncompatibleAnalysisCheckpoint extends Error {
  constructor() { super("This retained checkpoint uses an incompatible analysis method. Run a new analysis instead of retrying it."); }
}
function assertCompatibleCheckpoint(value: unknown) {
  const checkpoint = value as { parserVersion?: unknown; methodId?: unknown } | null;
  if (!checkpoint || !supportedParser(checkpoint.parserVersion) || checkpoint.methodId !== OUTAGE_METHOD_ID)
    throw new IncompatibleAnalysisCheckpoint();
}
function incompatibleCheckpointResponse() {
  return Response.json({ hasData: false, processing: false, analysisRequired: true,
    code: "incompatible_analysis_checkpoint", error: new IncompatibleAnalysisCheckpoint().message },
    { status: 409, headers: { "Cache-Control": "private, no-store" } });
}
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
  const issues = analysis.issues.filter(issue => issue.category === "Communications" || issue.lossUnknown || issue.estimatedLossKwh > parsed);
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
          actualKwh: point.actualKwh, expectedKwh: point.expectedKwh, lossUnknown: point.lossUnknown, expectedUnknown: point.expectedUnknown,
        })),
        summaryIssueNumber: numbers.get(issue.id),
        summaryPeriods: monthlyLosses({ ...issue, timezone, evidence }, intervalMinutes),
      })),
    },
  };
}
function publicIssue(issue: PerformanceIssue) {
  return { ...issue, estimatedLossKwh: issue.lossUnknown ? null : issue.estimatedLossKwh,
    lossPercent: issue.lossUnknown ? null : issue.lossPercent, actualEnergyKwh: issue.productionUnknown ? null : issue.actualEnergyKwh,
    expectedEnergyKwh: issue.expectedUnknown ? null : issue.expectedEnergyKwh };
}
async function responseTag(sourceEtag: string, threshold: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    JSON.stringify(["display-v6-outage-only", sourceEtag, threshold]),
  ));
  return '"' + [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("") + '"';
}

function unavailableAnalysisResponse(explicitAttempt: boolean) {
  return Response.json(explicitAttempt ? { error: "Analysis attempt not found." } :
    { hasData: false, analysisRequired: true, reason: "Run analysis to create a saved result." },
    { status: explicitAttempt ? 404 : 200, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(request: Request): Promise<Response> {
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
      if (!row) return unavailableAnalysisResponse(true);
      const job = await readJob(database, row.id);
      if(!job || (job.status === "completed" && !await isCompletedAnalysisRun(database, siteId, job.attempt_id,
          `analysis/${siteId}/jobs/${job.attempt_id}/result.json`))) return unavailableAnalysisResponse(true);
      return analysisJobResponse(job);
    }
    const db = getDb();
    let [site] = await db
      .select()
      .from(siteSettings)
      .where(eq(siteSettings.id, siteId))
      .limit(1);
    if (!site)
      return Response.json(
        { error: "This site is not available." },
        { status: 404 },
      );
    const bucket = getBucketBinding();
    const database = getDatabaseBinding();
    // A job continues with its own input/model checkpoint even if an import is
    // committed between HTTP stages. Merely browsing never creates a new job.
    const requestedAttempt = searchParams.get("attemptId");
    let selectedJob = requestedAttempt
      ? await database.prepare("SELECT * FROM analysis_jobs WHERE site_id = ? AND attempt_id = ?").bind(siteId, requestedAttempt).first<AnalysisJob>()
      : await database.prepare(`SELECT * FROM analysis_jobs WHERE site_id = ?
          ORDER BY CASE WHEN status IN ('processing','canceling') THEN 0 ELSE 1 END,
            updated_at DESC, id DESC LIMIT 1`).bind(siteId).first<AnalysisJob>();
    if (!selectedJob?.attempt_id) selectedJob = null;
    if (selectedJob) selectedJob = await readJob(database, selectedJob.id);
    if (requestedAttempt && !selectedJob) return unavailableAnalysisResponse(true);
    if(requestedAttempt && selectedJob?.status === "completed" && !await isCompletedAnalysisRun(database, siteId, requestedAttempt,
        `analysis/${siteId}/jobs/${requestedAttempt}/result.json`)) return unavailableAnalysisResponse(true);
    // Publication is independent of the latest attempt. A stopped rerun must
    // neither hide the published snapshot nor make its checkpoint a prerequisite
    // for browsing it. Explicit attempt/progress requests retain their controls.
    const stoppedJob = !requestedAttempt && selectedJob && ["canceled", "failed", "interrupted"].includes(selectedJob.status)
      ? selectedJob : null;
    const lastAttempt = stoppedJob ? jobProgress(stoppedJob) : undefined;
    if (!requestedAttempt && selectedJob && !["processing", "canceling"].includes(selectedJob.status)) selectedJob = null;
    const retainedInput = selectedJob ? await bucket.get(`analysis/${siteId}/jobs/${selectedJob.attempt_id}/input.json`) : null;
    const inputCheckpoint = retainedInput ? await readCheckpoint<AnalysisInputCheckpoint>(retainedInput) : null;
    if (selectedJob && selectedJob.status !== "completed") assertCompatibleCheckpoint(inputCheckpoint);
    if (inputCheckpoint && (inputCheckpoint.record.siteId !== siteId || inputCheckpoint.record.id !== selectedJob!.import_id)) throw new Error("Analysis input checkpoint mismatch.");
    let record = inputCheckpoint?.record || await currentAnalysisInput(siteId,Number(searchParams.get("year")||2026));
    if (selectedJob && record?.id !== selectedJob.import_id) {
      record = (await db.select().from(telemetryImports).where(eq(telemetryImports.id,selectedJob.import_id)).limit(1))[0];
      if (record?.id !== selectedJob.import_id || record?.siteId !== siteId) throw new Error("The pinned analysis input is unavailable.");
    }
    if (inputCheckpoint) site = inputCheckpoint.site;
    if (!record)
      return Response.json({
        hasData: false,
        reason: "No telemetry import is available.",
      });
    let analysisObjectKey = `analysis/${record.siteId}/current.json`;
    const displayObjectKey = `analysis/${record.siteId}/display.json`;
    const [equipment, rawCachedRows, thresholdRow, initialStableObject] = await Promise.all([
      inputCheckpoint ? Promise.resolve(inputCheckpoint.equipment) : db.select().from(equipmentAssets).where(eq(equipmentAssets.siteId, siteId)),
      db.select().from(performanceSummaries).where(eq(performanceSummaries.siteId, siteId)),
      database.prepare("SELECT minimum_issue_loss_kwh FROM user_settings WHERE id = ? LIMIT 1")
        .bind("primary-user").first<UserThresholdRow>(),
      bucket.head(analysisObjectKey),
    ]);
    const cachedRows: (typeof performanceSummaries.$inferSelect)[] = rawCachedRows;
    const modelRevision = inputCheckpoint?.modelRevision || await arrayModelRevision(equipment,site);
    const cached = cachedRows.find(item => item.importId === record.id);
    const pointer = cached ? safeJson<CachedPerformancePointer | null>(cached.summary, null) : null;
    // A retained older input may still own the sole published pointer. Never
    // search historical runs or fall back past an unavailable current pointer.
    const publishedRow = cached || (cachedRows.length === 1 ? cachedRows[0] : undefined);
    const publishedPointer = publishedRow ? safeJson<CachedPerformancePointer | null>(publishedRow.summary, null) : null;
    const publicationAvailable = !!publishedRow && await publishedAnalysisAvailable(database, siteId, publishedRow.importId, publishedPointer);
    const currentPublicationAvailable = publicationAvailable && publishedRow?.importId === record.id;
    const threshold = thresholdRow?.minimum_issue_loss_kwh || "";
    const pendingJob = selectedJob || stoppedJob;
    const refreshing = Boolean(selectedJob && selectedJob.status !== "completed" && !pointer?.objectKey?.includes(selectedJob.attempt_id));
    // New jobs publish an immutable result through an atomic database pointer.
    let stableObject = currentPublicationAvailable && pointer?.objectKey === analysisObjectKey ? initialStableObject : null;
    if (currentPublicationAvailable && pointer && supportedParser(pointer.parserVersion) && pointer.modelRevision === modelRevision && pointer.objectKey) {
      analysisObjectKey = pointer.objectKey;
      if (analysisObjectKey !== `analysis/${record.siteId}/current.json`) stableObject = await bucket.head(analysisObjectKey);
    }
    let sourceEtag = stableObject?.etag || "";
    const requestedPointerMatches = !requestedAttempt || pointer?.objectKey?.includes(`/jobs/${requestedAttempt}/`);
    const stableMetadataMatches = currentPublicationAvailable && !refreshing && requestedPointerMatches &&
      stableObject?.customMetadata?.siteId === record.siteId &&
      stableObject.customMetadata.importId === record.id &&
      supportedParser(stableObject.customMetadata.parserVersion) &&
      stableObject.customMetadata.modelRevision === modelRevision;
    const legacyPointerMatches = currentPublicationAvailable && !refreshing && requestedPointerMatches && pointer &&
      supportedParser(pointer.parserVersion) &&
      pointer.modelRevision === modelRevision &&
      Boolean(pointer.objectKey);
    if (statusOnly) {
      const available = !!publishedRow && await publishedAnalysisAvailable(database, siteId, publishedRow.importId, publishedPointer);
      if (requestedAttempt && pendingJob?.status === "completed" && !await isCompletedAnalysisRun(database, siteId, requestedAttempt,
          `analysis/${siteId}/jobs/${requestedAttempt}/result.json`)) return unavailableAnalysisResponse(true);
      return Response.json({
        cacheStatus:
          available && (stableMetadataMatches || legacyPointerMatches) ? "stored" : "stale",
        ...(!available ? {analysisRequired:true} : {}),
        ...(lastAttempt ? { lastAttempt } : {}),
      }, { headers: { "Cache-Control": "private, no-store" } });
    }

    const canonicalInput = Boolean(safeJson<Record<string,unknown>>(record.validation,{}).performanceStore);
    const responseHeaders = new Headers({ "Cache-Control": canonicalInput || lastAttempt ? "private, no-store" : "private, no-cache", Vary: "Cookie, Authorization" });
    if (stableMetadataMatches && !issueId && !canonicalInput && !lastAttempt) {
      responseHeaders.set("ETag", await responseTag(sourceEtag, threshold));
      if (request.headers.get("if-none-match") === responseHeaders.get("ETag")) {
        // Metadata and the tag digest may yield while deletion commits.
        if (!await publishedAnalysisAvailable(database, siteId, record.id, pointer))
          return unavailableAnalysisResponse(Boolean(requestedAttempt));
        return new Response(null, { status: 304, headers: responseHeaders });
      }
    }
    let payload: CachedPerformancePayload | null = null;
    let cacheStatus: "stored" | "generated" = "stored";
    let loadedDisplay = false;
    if (stableMetadataMatches && !issueId) {
      const compact = await bucket.get(displayObjectKey);
      if (compact?.customMetadata?.sourceEtag === sourceEtag && compact.customMetadata.displayVersion === "5") {
        const candidate = await readCheckpoint<CachedPerformancePayload>(compact);
        if (candidate?.siteId === siteId && candidate.importId === record.id &&
            candidate.modelRevision === modelRevision && supportedParser(candidate.parserVersion) && candidate.issueDatabase &&
            await isCompletedAnalysisRun(database, siteId, candidate.issueDatabase.analysisRunId, analysisObjectKey)) {
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
          candidate.issueDatabase && await isCompletedAnalysisRun(database, siteId, candidate.issueDatabase.analysisRunId, analysisObjectKey)
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
          candidate.siteId === siteId && candidate.importId === record.id && candidate.modelRevision === modelRevision &&
          candidate.issueDatabase && await isCompletedAnalysisRun(database, siteId, candidate.issueDatabase.analysisRunId, pointer.objectKey)
        )
          payload = candidate;
      }
    }

    let publishedSnapshot = false;
    if (!payload && !requestedAttempt && !refreshing && publicationAvailable && publishedRow && publishedPointer?.objectKey) {
      // Completed snapshot bytes retain their original calculation/method identity.
      const object = await bucket.get(publishedPointer.objectKey);
      if(object) {
        const candidate = await readCheckpoint<CachedPerformancePayload>(object);
        if(candidate.siteId === siteId && candidate.importId === publishedRow.importId && candidate.issueDatabase &&
            (!publishedPointer.analysisRunId || candidate.issueDatabase.analysisRunId === publishedPointer.analysisRunId) &&
            await isCompletedAnalysisRun(database, siteId, candidate.issueDatabase.analysisRunId, publishedPointer.objectKey)) {
          payload=candidate; sourceEtag=object.etag; analysisObjectKey=publishedPointer.objectKey; publishedSnapshot=true;
        }
      }
    }
    if (!payload && requestedAttempt && pendingJob?.status === "completed") {
      const object = await bucket.get(`analysis/${siteId}/jobs/${pendingJob.attempt_id}/result.json`);
      if (object) {
        const candidate = await readCheckpoint<CachedPerformancePayload>(object);
        if (candidate.siteId === siteId && candidate.importId === pendingJob.import_id && candidate.issueDatabase?.analysisRunId === pendingJob.attempt_id &&
            await isCompletedAnalysisRun(database, siteId, pendingJob.attempt_id, `analysis/${siteId}/jobs/${pendingJob.attempt_id}/result.json`)) {
          payload = candidate; sourceEtag = object.etag; analysisObjectKey=`analysis/${siteId}/jobs/${pendingJob.attempt_id}/result.json`; publishedSnapshot = true;
        }
      }
    }
    if (!payload?.issueDatabase || (payload.importId !== record.id && !publishedSnapshot)) {
      payload = null;
      const job = pendingJob;
      if (requestedAttempt && job?.status === "completed" && !await isCompletedAnalysisRun(database, siteId, requestedAttempt,
          `analysis/${siteId}/jobs/${requestedAttempt}/result.json`)) return unavailableAnalysisResponse(true);
      if (!job) {
        return Response.json({ hasData: false, analysisRequired: true, reason: "Performance data is available. Run analysis to create a saved result." }, { headers: { "Cache-Control": "private, no-store" } });
      }
      // A normal browse resolved a current input above, but has no publication.
      // Offer a fresh explicit start without changing the stopped checkpoint or
      // advertising current-input actions on an explicit attempt/progress read.
      if (job.status !== "processing") return analysisJobResponse(job, false, Boolean(stoppedJob));
      const key = job.id;
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
        let provenance = job.stage === "read" ? null : resumeAnalysisProvenance(job.attempt_id,record,inputCheckpoint?.provenance);
        if (job.stage === "read") {
          provenance = captureAnalysisProvenance(job.attempt_id, record, equipment);
          await writeCheckpoint(bucket, `${root}/input.json`, { parserVersion: PARSER_VERSION, methodId: OUTAGE_METHOD_ID, record, equipment, site, modelRevision, provenance });
          const summary = alignWithArrayModel(await buildSummary(record, equipment,
            (completed, total) => report("read", completed, total)), equipment);
          summary.causeContext = { latitude: site.latitude || "", longitude: site.longitude || "", timeZone: record.timezone,
            assumptions: expectedAssumptions(site) };
          await report("read", record.rowCount, record.rowCount);
          await bucket.put(`${root}/summary.json`, JSON.stringify({...packSummary(summary), methodId: OUTAGE_METHOD_ID}));
          await report("equipment", 0, summary.equipmentProduction?.length || 0, true);
        } else if (job.stage === "equipment" || job.stage === "reconcile") {
          // Progress may be ahead of the last durable batch when a request dies.
          let retained = await bucket.get(`${root}/equipment-final.json`);
          for(let offset=Math.floor(job.completed/16)*16;!retained&&offset>=16;offset-=16)
            retained=await bucket.get(`${root}/equipment-${offset}.json`);
          const previous = retained ? await readCheckpoint<{parserVersion:number;methodId:string;offset:number;issues:PerformanceIssue[]}>(retained) : {offset:0,issues:[]};
          if (retained) assertCompatibleCheckpoint(previous);
          const summary = unpackSummary<TelemetrySummary>(await readSnapshot("summary"));
          assertCompatibleCheckpoint(summary);
          const steps = buildAnalysisSteps(summary, equipment, {offset:previous.offset,limit:16,issues:previous.issues});
          let next = steps.next();
          while (!next.done) {
            if ("equipmentCheckpoint" in next.value && next.value.equipmentCheckpoint) {
              const checkpointName = next.value.stage === "reconcile" ? "equipment-final" : `equipment-${next.value.completed}`;
              await report("equipment", next.value.completed, next.value.total);
              await writeCheckpoint(bucket, `${root}/${checkpointName}.json`, {parserVersion:PARSER_VERSION,methodId:OUTAGE_METHOD_ID,offset:next.value.completed,...next.value.equipmentCheckpoint});
              await report(next.value.stage, next.value.stage === "reconcile" ? 0 : next.value.completed,
                next.value.stage === "reconcile" ? 1 : next.value.total, true);
              return analysisJobResponse((await readJob(database,key))!);
            }
            await report(next.value.stage, next.value.completed, next.value.total);
            next = steps.next();
          }
          const source: CachedPerformancePayload = { parserVersion: PARSER_VERSION, methodId: OUTAGE_METHOD_ID,
            modelRevision, provenance, summary: compactSummary(summary), analysis: next.value };
          await report("reconcile", 1, 1);
          await writeCheckpoint(bucket, `${root}/analysis.json`, source);
          // Save requests fetch only their own 300 records, not the entire fleet's index.
          for (let offset=0;offset<source.analysis.issues.length;offset+=1800) {
            const starts=Array.from({length:Math.min(6,Math.ceil((source.analysis.issues.length-offset)/300))},(_,i)=>offset+i*300);
            await Promise.all(starts.map(start=>writeCheckpoint(bucket, `${root}/save-${start}.json`,
              {parserVersion:PARSER_VERSION,methodId:OUTAGE_METHOD_ID,issues:issueSaveIndex(source.analysis.issues.slice(start,start+300),resultKey)})));
            await report("reconcile",1,1);
          }
          await bucket.put(`${root}/save-manifest.json`,JSON.stringify({parserVersion:PARSER_VERSION,methodId:OUTAGE_METHOD_ID,count:source.analysis.issues.length}));
          await report("save", 0, source.analysis.issues.length, true);
        } else if (job.stage === "save") {
          const manifest = await bucket.get(`${root}/save-manifest.json`);
          const start = job.completed;
          if (manifest) {
            const savedManifest = await manifest.json<{parserVersion:number;methodId:string;count:number}>();
            assertCompatibleCheckpoint(savedManifest);
            const {count} = savedManifest;
            const page = count ? await readSnapshot<{parserVersion:number;methodId:string;issues:PerformanceIssue[]}>(`save-${start}`) : null;
            if(page) assertCompatibleCheckpoint(page);
            const issues = page?.issues || [];
            await persistPerformanceIssues({database,siteId,importId:record.id,parserVersion:PARSER_VERSION,modelRevision,
              analysisObjectKey:resultKey,issues,runIdOverride:job.attempt_id,append:true,checkpoint:()=>report("save",start,count)});
            const end=Math.min(start+issues.length,count);
            await report(end===count?"finalize":"save",end===count?0:end,end===count?1:count,true);
            return analysisJobResponse((await readJob(database,key))!);
          }
          const index = await bucket.get(`${root}/save.json`);
          let issues: PerformanceIssue[];
          if (index) {
            const page = await index.json<{parserVersion:number;methodId:string;issues:PerformanceIssue[]}>();
            assertCompatibleCheckpoint(page);
            issues = page.issues;
          } else {
            // Same-method compact layouts can retain their saved offset.
            const source = await readSnapshot<CachedPerformancePayload>("analysis");
            assertCompatibleCheckpoint(source);
            issues = issueSaveIndex(source.analysis.issues, resultKey);
            await bucket.put(`${root}/save.json`, JSON.stringify({parserVersion:PARSER_VERSION,methodId:OUTAGE_METHOD_ID,issues}));
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
          assertCompatibleCheckpoint(source);
          provenance = resumeAnalysisProvenance(job.attempt_id,record,source.provenance);
          if (source.modelRevision !== modelRevision) throw new Error("The saved analysis model checkpoint does not match this attempt.");
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
          const recurringIssues: never[] = [];
          payload = { ...source, provenance, schemaVersion: 1, siteId, importId: record.id,
            generatedAt: new Date().toISOString(), analysis: { ...source.analysis, issues, recurringIssues },
            capacityKw: gridCapacity(equipment), validation: safeJson<Record<string, unknown>>(record.validation, {}),
            timeZone: record.timezone, import: { id: record.id, fileName: record.fileName,
              createdAt: record.createdAt, timestampStart: record.timestampStart, timestampEnd: record.timestampEnd },
            issueDatabase: { analysisRunId: job.attempt_id, persistedIssueCount: issues.length },
            methodology:{analysisId:job.attempt_id,generatedAt:new Date().toISOString(),calculationVersion:PARSER_VERSION,modelRevision,
              inputProvenance:provenance,dependencyScope:"analysis-range",
              equipmentModel:equipment,siteSettings:site,timezone:record.timezone,intervalMinutes:source.analysis.analysisIntervalMinutes,
              partitionHashes:safeJson<Record<string,unknown>>(record.validation,{}).partitionHashes||null,
              timestampConvention:safeJson<Record<string,unknown>>(record.validation,{}).timestampConvention||"start",
              sourceImports:safeJson<Record<string,unknown>>(record.validation,{}).sourceImports||[{id:record.id,fileName:record.fileName,createdAt:record.createdAt}],
              datasetRevision:provenance?.revision ?? (safeJson<Record<string,unknown>>(record.validation,{}).datasetManifest?record.id:null),thresholdAtAnalysis:threshold,thresholdMethod:"Each event must exceed the loss threshold; communications and unknown-loss events remain visible.",inverterExpectation:source.analysis.inverterExpectation,transformerLimits:source.analysis.transformerLimits,
              method:OUTAGE_METHOD,exclusions:source.analysis.baselineMethod,lowIrradianceThresholdWm2:MIN_IRRADIANCE_WM2} };
          await report("finalize", 0, 1);
          await writeCheckpoint(bucket,`${root}/review-index.json`,{siteId,provenance:payload.provenance,methodology:{inputProvenance:payload.provenance,dependencyScope:"analysis-range"},issueDatabase:payload.issueDatabase,analysis:{recurringIssues,issues:issues.map(({evidence,intervalLosses,sharedSourceEvents,...issue})=>issue)}});
          const saved = await writeCheckpoint(bucket, resultKey, payload, {
            httpMetadata: { contentType: "application/json" },
            customMetadata: { siteId, importId: record.id, parserVersion: String(PARSER_VERSION), modelRevision },
          });
          // Legacy publication also loses to a dataset which has since migrated.
          const latestInput = payload.provenance ? null : await currentAnalysisInput(siteId);
          const publication = await publishJob(database, job, token, JSON.stringify({ parserVersion: PARSER_VERSION,
            modelRevision, objectKey: resultKey, analysisRunId: job.attempt_id }), resultKey, issues.length,
            payload.provenance ? () => analysisRevisionIsCurrent(payload!.provenance!) : () => legacyAnalysisInputIsCurrent(siteId,record.id,latestInput?.id));
          sourceEtag = saved?.etag || "";
          cacheStatus = "generated";
          // Intermediate checkpoints are disposable once the complete result is published.
          const disposable=[`${root}/summary.json`,`${root}/analysis.json`,`${root}/save.json`,`${root}/save-manifest.json`,`${root}/equipment-final.json`];
          for(let offset=16;offset<equipment.filter((e:typeof equipmentAssets.$inferSelect)=>e.type==="inverter").length;offset+=16)disposable.push(`${root}/equipment-${offset}.json`);
          for(let offset=0;offset<issues.length;offset+=300)disposable.push(`${root}/save-${offset}.json`);
          await bucket.delete(disposable).catch(()=>undefined);
          if (!publication.published) return Response.json({ processing:false, hasData:false, runId:job.attempt_id, publicationSkipped:true,
            reason:"The analysis was saved in history. Newer site data prevented it from replacing the published result.",
            progress:jobProgress((await readJob(database,key))!) }, { headers:{"Cache-Control":"private, no-store"} });
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
        const stopped = (await readJob(database, key))!;
        if(error instanceof IncompatibleAnalysisCheckpoint)return incompatibleCheckpointResponse();
        // Resolve the published view immediately when this polling request fails;
        // do not require a manual reload after the progress panel stops polling.
        if (!requestedAttempt && ["canceled", "failed", "interrupted"].includes(stopped.status)) return GET(request);
        return analysisJobResponse(stopped);
      }
      if (!payload) return analysisJobResponse((await readJob(database, key))!);
    }
    if (!payload) throw new Error("The saved analysis could not be loaded.");
    if (!payload.issueDatabase || !await isCompletedAnalysisRun(database, siteId, payload.issueDatabase.analysisRunId, analysisObjectKey))
      return unavailableAnalysisResponse(Boolean(requestedAttempt));
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
        issue.evidence.peerReferenceSets = Object.fromEntries([...indexes].map(id => [id, payload!.analysis.peerComparison!.referenceSets[id]]));
        const referenceIds = new Set([...indexes].flatMap(id => payload!.analysis.peerComparison!.referenceSets[id] || []));
        const qualification = payload.analysis.peerComparison.referenceQualification;
        if (qualification) issue.evidence.peerReferenceQualification = { method: payload.analysis.peerComparison.qualification, deliveryFactor: qualification.deliveryFactor, records: qualification.records.filter(r => referenceIds.has(r.equipmentId)) };
      }
      if (!await isCompletedAnalysisRun(database, siteId, payload.issueDatabase.analysisRunId, analysisObjectKey))
        return unavailableAnalysisResponse(Boolean(requestedAttempt));
      return Response.json(issue ? { issue: publicIssue(issue) } : { error: "Issue not found." }, {
        status: issue ? 200 : 404, headers: { "Cache-Control": "private, no-store" },
      });
    }
    if (!loadedDisplay) {
      payload = displayPayload(payload);
      // A failed derivative write must not prevent serving the authoritative analysis.
      if (sourceEtag) await writeCheckpoint(bucket, displayObjectKey, payload, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { sourceEtag, displayVersion: "5" },
      }).catch(() => undefined);
    }
    if (payload.provenance) responseHeaders.set("Cache-Control","private, no-store");
    else if (sourceEtag && !lastAttempt) responseHeaders.set("ETag", await responseTag(sourceEtag, threshold));
    const summary = payload.summary;
    const analysis = applyLossThreshold(
      payload.analysis,
      threshold,
    );
    // Display writes and the final ETag digest must finish before admitting the
    // exact saved run to a public response. Retained payload bytes are not authority.
    if (!payload.issueDatabase || !await isCompletedAnalysisRun(database, siteId, payload.issueDatabase.analysisRunId, analysisObjectKey))
      return unavailableAnalysisResponse(Boolean(requestedAttempt));
    return analysisJsonResponse({
      hasData: Boolean(summary.dailyProduction.length || analysis.issues.length),
      // Transient attempt metadata is never written into the saved result or its
      // compact derivative. Keep the published run as the review/edit identity.
      ...(lastAttempt ? { processing: false, lastAttempt } : {}),
      reason: summary.dailyProduction.length
        ? ""
        : "The latest import does not contain a mapped interval Energy or Active power signal for configured equipment. DC power is not AC production.",
      summary,
      analysis: { ...analysis, issues: analysis.issues.map(publicIssue) },
      issueDatabase: payload.issueDatabase,
      methodology: payload.methodology,
      provenance: payload.provenance || null,
      ...(payload.provenance ? { dataFreshness: assessAnalysisFreshness(siteId, payload.issueDatabase!.analysisRunId, payload.provenance) } : {}),
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
    if(error instanceof IncompatibleAnalysisCheckpoint)return incompatibleCheckpointResponse();
    console.error("Performance analysis failed.", error);
    const message = error instanceof Error ? error.message : "";
    const safe = /retained CSV|revenue meter|mapped/.test(message)
      ? message
      : "Unable to analyze the latest production import.";
    return Response.json({ hasData: false, error: safe }, { status: 500 });
  }
}

function analysisJobResponse(job: AnalysisJob, waiting = false, analysisRequired = false) {
  const processing = job.status === "processing" || job.status === "canceling";
  return Response.json({ processing, hasData: false, progress: jobProgress(job), waiting,
    ...(analysisRequired ? { analysisRequired: true } : {}),
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
      const bucket=getBucketBinding();
      const job=await restartJob(getDatabaseBinding(),await analysisJobKey(record.id,PARSER_VERSION,revision),siteId,record.id,
        async attempt=>{await writeCheckpoint(bucket,`analysis/${siteId}/jobs/${attempt}/input.json`,{parserVersion:PARSER_VERSION,methodId:OUTAGE_METHOD_ID,record,equipment,site,modelRevision:revision,provenance:null});});
      return analysisJobResponse(job);
    }
    if (!siteId || !attemptId || !["cancel", "retry"].includes(action))
      return Response.json({ error: "A site, analysis attempt, and valid action are required." }, { status: 400 });
    const bucket=getBucketBinding();
    const previousInput=action === "retry" ? await bucket.get(`analysis/${siteId}/jobs/${attemptId}/input.json`) : null;
    const previousCheckpoint = previousInput ? await readCheckpoint<AnalysisInputCheckpoint>(previousInput) : null;
    if(action === "retry") assertCompatibleCheckpoint(previousCheckpoint);
    const job = await controlJob(getDatabaseBinding(), siteId, attemptId, action as "cancel" | "retry",async nextAttempt=>{
      if (previousCheckpoint) {
        const checkpoint=previousCheckpoint;
        await writeCheckpoint(bucket,`analysis/${siteId}/jobs/${nextAttempt}/input.json`,{...checkpoint,provenance:null});
      }
    });
    if (!job) return Response.json({ error: "Analysis attempt not found." }, { status: 404 });
    return analysisJobResponse(job);
  } catch (error) {
    if(error instanceof IncompatibleAnalysisCheckpoint)return incompatibleCheckpointResponse();
    console.error("Analysis control failed", error);
    return Response.json({ error: "Unable to update the analysis. Please try again." }, { status: 500 });
  }
}
