import { localDate, parseTelemetryTimestamp } from "../../telemetry-time";
import type { PeerPlan } from "./peer-comparison";

export type SuspectedCause = "" | "Shading" | "Snow";
export type ExpectedAssumptions = { shading: "included" | "not_included" | "unknown"; snow: "included" | "not_included" | "unknown"; notes: string };
export function expectedAssumptions(site: { expectedShading?: string; expectedSnow?: string; expectedProductionNotes?: string }): ExpectedAssumptions {
  const value = (input?: string) => input === "included" || input === "unknown" ? input : "not_included";
  return { shading: value(site.expectedShading), snow: value(site.expectedSnow), notes: site.expectedProductionNotes || "" };
}
type Interval = { timestamp: string; lossKwh: number; countedLossKwh?: number; actualKwh?: number; expectedKwh?: number; [key: string]: unknown };
type CauseIssue = { id: string; type: string; category: string; equipmentId: string; equipmentType: string; startDateTime: string; endDateTime: string;
  estimatedLossKwh: number; actualEnergyKwh: number; expectedEnergyKwh: number; durationMinutes: number; durationDays: number; lossPercent: number;
  suspectedCause?: SuspectedCause; causeExplanation?: string; evidence?: Record<string, unknown> };
export type CauseSummary = {
  timezone?: string; intervalMinutes?: number; snowDays?: string[]; snowSensorConfigured?: boolean; snowReadingCount?: number;
  causeContext?: { latitude: string; longitude: string; timeZone: string; assumptions: ExpectedAssumptions };
  expectedProduction?: { timestamp: string; energyKwh: number }[];
  intervalIrradiance?: { timestamp: string; averageWm2: number; insolationKwhM2: number }[];
  equipmentProduction?: { equipmentId: string; equipmentType: string; capacityKw: number; intervalProduction?: { timestamp: string; energyKwh: number }[] }[];
};
const hasZone = (value: string) => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
const wallTime = (value: string) => Date.parse(hasZone(value) ? value : value + "Z");
const stamp = (value: number, reference: string) => hasZone(reference) ? new Date(value).toISOString() : new Date(value).toISOString().slice(0, 19);
// Legacy analyses contain local wall times; new analyses contain UTC instants.
const siteDay = (value: string, timezone: string) => hasZone(value) ? localDate(value, timezone) : value.slice(0, 10);

function nextLocalMidnight(moment: number, reference: string, timezone: string) {
  const date = new Date(`${siteDay(stamp(moment, reference), timezone)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  const nextWall = date.toISOString().slice(0, 10) + "T00:00:00";
  if (!hasZone(reference)) return wallTime(nextWall);
  const next = Date.parse(parseTelemetryTimestamp(nextWall, timezone));
  if (Number.isFinite(next) && next > moment) return next;
  // A few zones change their clocks at midnight. Find the first instant in the
  // next local day instead of guessing an offset or creating a nonexistent time.
  const today = siteDay(stamp(moment, reference), timezone);
  let low = moment, high = moment + 48 * 3600000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (siteDay(stamp(mid, reference), timezone) === today) low = mid;
    else high = mid;
  }
  return high;
}
const radians = Math.PI / 180;

// Approximate NOAA solar-position equations, adequate for coarse suspected-shade
// bins, not a substitute for a surveyed shading model.
// https://gml.noaa.gov/grad/solcalc/solareqns.PDF
export function solarPosition(timestamp: string, latitude: number, longitude: number, formatter: Intl.DateTimeFormat) {
  const wall = wallTime(timestamp);
  let utc = wall;
  for (let i = 0; !hasZone(timestamp) && i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(utc)).map(p => [p.type, p.value]));
    const projected = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    utc += wall - projected;
  }
  const date = new Date(utc), year = date.getUTCFullYear();
  const days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
  const fractionalDay = (utc - Date.UTC(year, 0, 1)) / 86400000;
  const gamma = 2 * Math.PI / days * (fractionalDay - 0.5);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const solarMinutes = ((date.getUTCHours() * 60 + date.getUTCMinutes() + eq + 4 * longitude) % 1440 + 1440) % 1440;
  const hourAngle = (solarMinutes / 4 - 180) * radians, lat = latitude * radians;
  const elevation = Math.asin(Math.max(-1, Math.min(1, Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)))) / radians;
  const azimuth = (Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) / radians + 180 + 360) % 360;
  return { elevation, azimuth };
}

export function shadingCandidates(summary: CauseSummary, issues: CauseIssue[], peers?: PeerPlan) {
  const result = new Set<string>();
  if (!peers) return result;
  const candidateIds = new Set(issues.filter(issue => issue.type === "Underperformance" && issue.category === "Performance" && issue.equipmentType === "inverter").map(issue => issue.equipmentId));
  if (!candidateIds.size) return result;
  const context = summary.causeContext;
  if (!context || context.latitude.trim() === "" || context.longitude.trim() === "") return result;
  const latitude = Number(context.latitude), longitude = Number(context.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return result;
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-US", { timeZone: context.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); }
  catch { return result; }
  const snowDays = new Set(summary.snowDays || []);
  const timezone = summary.timezone || context.timeZone;
  const sun = new Map((summary.intervalIrradiance || []).filter(p => p.averageWm2 >= 200 && p.insolationKwhM2 > 0 && !snowDays.has(siteDay(p.timestamp, timezone))).map(p => [p.timestamp, p]));
  const bins = new Map<string, string>();
  for (const timestamp of sun.keys()) {
    const position = solarPosition(timestamp, latitude, longitude, formatter);
    if (position.elevation >= 10) bins.set(timestamp, `${Math.floor(position.azimuth / 20)}:${Math.floor(position.elevation / 10)}`);
  }
  const normalized = new Map<string, Map<string, number>>();
  const healthyAt = new Map<string, number>();
  const healthyDays = new Map<string, Set<string>>();
  const hours = (summary.intervalMinutes || 60) / 60;
  for (const equipment of summary.equipmentProduction || []) {
    if (equipment.equipmentType !== "inverter" || equipment.capacityKw <= 0) continue;
    const peerGroup = peers.groups.get(equipment.equipmentId);
    if (!peerGroup) continue;
    const points = (equipment.intervalProduction || []).filter(p => sun.has(p.timestamp) && p.energyKwh > 0 && p.energyKwh < equipment.capacityKw * hours * 0.95);
    const yields = points.map(p => p.energyKwh / sun.get(p.timestamp)!.insolationKwhM2).sort((a, b) => a - b);
    if (yields.length < 20) continue;
    const reference = yields[Math.floor((yields.length - 1) * 0.75)];
    if (!(reference > 0)) continue;
    const ratios = new Map<string, number>();
    const days = new Set<string>();
    for (const point of points) {
      const ratio = point.energyKwh / sun.get(point.timestamp)!.insolationKwhM2 / reference;
      if (candidateIds.has(equipment.equipmentId)) ratios.set(point.timestamp, ratio);
      if (ratio >= 0.85 && ratio <= 1.2) {
        const key = `${peerGroup.key}|${point.timestamp}`;
        healthyAt.set(key, (healthyAt.get(key) || 0) + 1);
        days.add(siteDay(point.timestamp, timezone));
      }
    }
    if (candidateIds.has(equipment.equipmentId)) {
      normalized.set(equipment.equipmentId, ratios);
      healthyDays.set(equipment.equipmentId, days);
    }
  }
  const issueTimes = new Map<string, Set<string>>();
  for (const issue of issues) {
    if (issue.type !== "Underperformance" || issue.category !== "Performance") continue;
    const times = issueTimes.get(issue.equipmentId) || new Set<string>();
    for (const interval of (issue.evidence?.intervalLosses || []) as Interval[])
      if ((interval.countedLossKwh ?? interval.lossKwh) > 0) times.add(interval.timestamp);
    issueTimes.set(issue.equipmentId, times);
  }
  for (const [id, ratios] of normalized) {
    const peerGroup = peers.groups.get(id)!;
    const observations = new Map<string, { all: Set<string>; affected: Set<string>; timestamps: string[] }>();
    for (const [timestamp, ratio] of ratios) {
      const bin = bins.get(timestamp), day = siteDay(timestamp, timezone);
      // Require recovery elsewhere in the day and at least three healthy peers.
      const ownHealthy = ratio >= 0.85 && ratio <= 1.2 ? 1 : 0;
      if (!bin || !healthyDays.get(id)?.has(day) || !peers.recoveryDays.get(id)?.has(day) ||
          (healthyAt.get(`${peerGroup.key}|${timestamp}`) || 0) - ownHealthy < 3) continue;
      const group = observations.get(bin) || { all: new Set<string>(), affected: new Set<string>(), timestamps: [] };
      group.all.add(day);
      if (peers.findings.get(id)?.intervals.has(timestamp) && issueTimes.get(id)?.has(timestamp)) { group.affected.add(day); group.timestamps.push(timestamp); }
      observations.set(bin, group);
    }
    for (const group of observations.values()) {
      if (group.affected.size < 5 || group.affected.size / group.all.size < 0.6) continue;
      for (const timestamp of group.timestamps) result.add(`${id}|${timestamp}`);
    }
  }
  return result;
}

export function attributeCauses<T extends CauseIssue>(issues: T[], summary: CauseSummary, peers?: PeerPlan): T[] {
  const snowDays = new Set(summary.snowSensorConfigured ? summary.snowDays || [] : []);
  const shading = shadingCandidates(summary, issues, peers);
  const minutes = summary.intervalMinutes || 60;
  const timezone = summary.timezone || summary.causeContext?.timeZone || "UTC";
  const midnightBoundaries = new Map<string, number>();
  const assumptions = summary.causeContext?.assumptions;
  const importedExpectedTimes = new Set((summary.expectedProduction || []).map(point => point.timestamp));
  return issues.flatMap(issue => {
    if (issue.category !== "Performance" || issue.type !== "Underperformance") return [{ ...issue, suspectedCause: "" as SuspectedCause, causeExplanation: "" }];
    const source = issue.evidence?.intervalLosses;
    if (!Array.isArray(source) || !source.length) return [{ ...issue, suspectedCause: "" as SuspectedCause }];
    const original = source as Interval[];
    const total = original.reduce((sum, p) => sum + Math.max(0, p.countedLossKwh ?? p.lossKwh), 0);
    if (Math.abs(total - issue.estimatedLossKwh) > Math.max(0.01, total * 1e-8)) return [{ ...issue, suspectedCause: "" as SuspectedCause }];
    // Split at local midnight as well as cause boundaries. This also handles
    // non-hourly intervals that cross into a different snow-presence day.
    const groups: { cause: SuspectedCause; intervals: Interval[] }[] = [];
    for (const interval of original) {
      const start = wallTime(interval.timestamp), end = start + Number(interval.intervalMinutes || minutes) * 60000;
      for (let cursor = start; cursor < end;) {
        const day = siteDay(stamp(cursor, interval.timestamp), timezone);
        const boundaryKey = `${hasZone(interval.timestamp)}|${day}`;
        let boundary = midnightBoundaries.get(boundaryKey);
        if (boundary === undefined) {
          boundary = nextLocalMidnight(cursor, interval.timestamp, timezone);
          midnightBoundaries.set(boundaryKey, boundary);
        }
        const to = Math.min(end, boundary), weight = (to - cursor) / (end - start), timestamp = stamp(cursor, interval.timestamp);
        const loss = Math.max(0, interval.countedLossKwh ?? interval.lossKwh) * weight;
        const cause: SuspectedCause = loss > 0 && snowDays.has(day) ? "Snow" : loss > 0 && shading.has(`${issue.equipmentId}|${interval.timestamp}`) ? "Shading" : "";
        const item = { ...interval, timestamp, importedExpectedAvailable: importedExpectedTimes.has(interval.timestamp), intervalMinutes: (to - cursor) / 60000, lossKwh: loss, countedLossKwh: loss,
          actualKwh: (interval.actualKwh || 0) * weight, expectedKwh: (interval.expectedKwh || 0) * weight };
        const previous = groups.at(-1);
        if (previous?.cause === cause) previous.intervals.push(item); else groups.push({ cause, intervals: [item] });
        cursor = to;
      }
    }
    if (groups.length === 1 && !groups[0].cause) return [{ ...issue, suspectedCause: "" as SuspectedCause, causeExplanation: "" }];
    return groups.flatMap((group, index) => {
      const loss = group.intervals.reduce((sum, p) => sum + p.lossKwh, 0);
      if (loss <= 0) return [];
      const actual = group.intervals.reduce((sum, p) => sum + (p.actualKwh || 0), 0);
      const expected = group.intervals.reduce((sum, p) => sum + (p.expectedKwh || 0), 0);
      const first = group.intervals[0], last = group.intervals.at(-1)!;
      const startDateTime = groups.length === 1 ? issue.startDateTime : first.timestamp;
      const endDateTime = groups.length === 1 ? issue.endDateTime : stamp(wallTime(last.timestamp) + Number(last.intervalMinutes) * 60000, last.timestamp);
      const durationMinutes = (wallTime(endDateTime) - wallTime(startDateTime)) / 60000;
      const assumption = group.cause === "Snow" ? assumptions?.snow : group.cause === "Shading" ? assumptions?.shading : undefined;
      const importedExpectedAvailable = group.intervals.every(interval => interval.importedExpectedAvailable);
      const usesPeerBaseline = group.intervals.some(interval => interval.detectionBasis === "capacity_matched_peers_v1" || interval.detectionBasis === "capacity_matched_peers_v2");
      const usesDerivedBaseline = group.intervals.some(interval => interval.detectionBasis === "derived_inverter_expectation_v1" || interval.detectionBasis === "additional_inverter_deficit_v1");
      const additionalOnly = group.intervals.some(interval => interval.detectionBasis === "additional_inverter_deficit_v1");
      const basis = additionalOnly ? "Loss includes only the material inverter-specific shortfall beyond a shared site reduction. The healthy expectation derived from site Expected Production remains unchanged; the shared component is counted separately at site level." : usesDerivedBaseline ? "Loss is the shortfall against the inverter expectation derived from site Expected Production, constrained by transformer headroom and adjusted to the meter / POI delivery boundary. Peer evidence is supporting only; no shading allowance is included in this derived expectation." : usesPeerBaseline ? "Peer-detected intervals estimate the shortfall against capacity-matched peer production. Imported expected-production allowances are not applied to those intervals; shared peer losses may remain undetected."
        : !importedExpectedAvailable ? "Imported expected production is missing for some intervals; the irradiance-based estimate cannot isolate any model allowance already included." : assumption === "included" ? "Loss is the additional shortfall beyond the allowance already included in expected production."
        : assumption === "unknown" ? "The expected-production allowance is unknown; cause-specific loss is uncertain."
        : "Loss is the attributed production shortfall; no allowance for this cause is included in expected production.";
      const explanation = group.cause === "Snow" ? `Snow sensor recorded 70 at least once on each attributed local date. Underperformance on those dates is attributed to suspected snow. ${basis}`
        : group.cause === "Shading" ? `Recurring losses in similar solar-position bins on at least five days, with recovery against capacity-matched peers elsewhere in the day and at least three healthy peer inverters with the same AC and DC ratings. This is a suspected pattern, not a confirmed obstruction. ${basis}` : "";
      return [{ ...issue, id: groups.length === 1 ? issue.id : `${issue.id}-cause-${index}`, startDateTime, endDateTime, durationMinutes, durationDays: durationMinutes / 1440,
        estimatedLossKwh: loss, actualEnergyKwh: actual, expectedEnergyKwh: expected, lossPercent: expected > 0 ? Math.min(100, loss / expected * 100) : 0,
        suspectedCause: group.cause, causeExplanation: explanation,
        evidence: { ...issue.evidence, intervalLosses: group.intervals, intervalCount: group.intervals.length, suspectedCause: group.cause, causeExplanation: explanation,
          causeRule: group.cause === "Snow" ? "onsite_snow_code_70_local_day" : group.cause === "Shading" ? "capacity_matched_solar_position_pattern_v2" : "",
          causeLocalDates: [...new Set(group.intervals.filter(p => p.lossKwh > 0).map(p => siteDay(p.timestamp, timezone)))],
          expectedProductionAssumptions: assumptions, originalIssueId: issue.id } }];
    });
  });
}
