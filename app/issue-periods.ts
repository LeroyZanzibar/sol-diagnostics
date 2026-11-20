import { localTimestamp, parseTelemetryTimestamp } from "./telemetry-time";

/** New records are UTC instants; legacy records are site-local wall times. */
export const hasTimeZone = (value: string) => /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
export const localMoment = (value: string) => Date.parse(hasTimeZone(value) ? value : `${value}Z`);
export const siteWallTime = (value: string, timezone = "UTC") => hasTimeZone(value) ? localTimestamp(value, timezone) : value;
const stamp = (value: number, zoned: boolean) => zoned ? new Date(value).toISOString() : new Date(value).toISOString().slice(0, 19);
/** Calendar boundaries use the first instant of the local day, including midnight DST changes. */
export function calendarDayMoment(day: string, timezone = "UTC", zoned = true): number {
  const wall = `${day}T00:00:00`;
  if (!zoned) return localMoment(wall);
  const resolved = parseTelemetryTimestamp(wall, timezone);
  if (resolved) return localMoment(resolved);
  const nominal = localMoment(wall);
  if (!Number.isFinite(nominal) || !localTimestamp(new Date(nominal).toISOString(), timezone)) return NaN;
  // Midnight may be nonexistent or repeated. Find the first instant at/after this date.
  let low = nominal - 36 * 3600000, high = nominal + 36 * 3600000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localTimestamp(new Date(middle).toISOString(), timezone).slice(0, 10) < day) low = middle + 1;
    else high = middle;
  }
  return low;
}
const wallMoment = (value: string, timezone: string, zoned: boolean) => calendarDayMoment(value.slice(0, 10), timezone, zoned);
export type IntervalLoss = { timestamp: string; lossKwh: number; countedLossKwh?: number; intervalMinutes?: number; actualKwh?: number; expectedKwh?: number; lossUnknown?: boolean; expectedUnknown?: boolean; productionUnknown?: boolean };
export type PeriodLoss = { startDateTime: string; endDateTime: string; estimatedLossKwh: number | null };
export type ReportRange = { from: string; through: string };
type SourceIssue = { id: string; startDateTime: string; endDateTime: string; estimatedLossKwh: number | null; actualEnergyKwh?: number | null; expectedEnergyKwh?: number | null; lossUnknown?: boolean; expectedUnknown?: boolean; productionUnknown?: boolean; timezone?: string; intervalMinutes?: number; intervalLosses?: IntervalLoss[]; evidence?: Record<string, unknown> };
const ledger = (issue: SourceIssue): IntervalLoss[] => issue.intervalLosses || (Array.isArray(issue.evidence?.intervalLosses) ? issue.evidence.intervalLosses as IntervalLoss[] : []);
const intervalLength = (item: IntervalLoss, intervalMinutes: number) => item.intervalMinutes || intervalMinutes;
const countedLoss = (item: IntervalLoss) => item.countedLossKwh ?? item.lossKwh;
function validLedger(issue: SourceIssue, intervalMinutes: number) {
  const items = ledger(issue);
  if (!items.length || items.some(item => !Number.isFinite(localMoment(item.timestamp)) || !Number.isFinite(countedLoss(item)) || countedLoss(item) < 0 || !(intervalLength(item, intervalMinutes) > 0))) return false;
  const total = items.reduce((sum, item) => sum + countedLoss(item), 0);
  return issue.estimatedLossKwh !== null && Math.abs(total - issue.estimatedLossKwh) <= Math.max(0.01, issue.estimatedLossKwh * 1e-8);
}
// Without quantified loss there is no loss-total check to establish ledger
// completeness. Independently clipping energy needs full, nonoverlapping event
// coverage as well as reconciliation to its own recorded energy total.
function completeIntervalCoverage(issue: SourceIssue, intervalMinutes: number) {
  const items = [...ledger(issue)].sort((a, b) => localMoment(a.timestamp) - localMoment(b.timestamp));
  let cursor = localMoment(issue.startDateTime);
  if (!items.length || !Number.isFinite(cursor)) return false;
  for (const item of items) {
    const left = localMoment(item.timestamp), length = intervalLength(item, intervalMinutes), right = left + length * 60000;
    if (left !== cursor || !(length > 0) || !Number.isFinite(right)) return false;
    cursor = right;
  }
  return cursor === localMoment(issue.endDateTime);
}
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
export function reportRangeValid(range: ReportRange) { return !range.from || !range.through || range.from <= range.through; }

/** Include intersecting events and allocate only measured interval losses in the range. */
export function clipIssueToReport<T extends SourceIssue>(issue: T, range: ReportRange): T | null {
  if (!range.from && !range.through) return issue;
  if (!reportRangeValid(range)) return null;
  const zoned = hasTimeZone(issue.startDateTime), zone = issue.timezone || "UTC";
  const from = range.from ? wallMoment(`${range.from}T00:00:00`, zone, zoned) : -Infinity;
  const through = range.through ? wallMoment(`${nextDay(range.through)}T00:00:00`, zone, zoned) : Infinity;
  const originalStart = localMoment(issue.startDateTime), originalEnd = localMoment(issue.endDateTime);
  const start = Math.max(originalStart, from), end = Math.min(originalEnd, through);
  if (!(end > start)) return null;
  if (start === originalStart && end === originalEnd) return issue;
  const minutes = issue.intervalMinutes || 0;
  const reliable = !issue.lossUnknown && validLedger(issue, minutes);
  const items = ledger(issue);
  const energyCoverage = reliable || completeIntervalCoverage(issue, minutes);
  const clipped = items.flatMap(item => {
    const left = localMoment(item.timestamp), right = left + intervalLength(item, minutes) * 60000;
    const overlapStart = Math.max(left, from), overlapEnd = Math.min(right, through);
    if (!(overlapEnd > overlapStart)) return [];
    const share = (overlapEnd - overlapStart) / (right - left);
    return [{ ...item, timestamp: stamp(overlapStart, zoned), intervalMinutes: (overlapEnd - overlapStart) / 60000,
      lossKwh: item.lossKwh * share, countedLossKwh: countedLoss(item) * share,
      actualKwh: item.actualKwh == null ? item.actualKwh : item.actualKwh * share,
      expectedKwh: item.expectedKwh == null ? item.expectedKwh : item.expectedKwh * share }];
  });
  const loss = issue.estimatedLossKwh === 0 && !issue.lossUnknown ? 0 : reliable ? clipped.reduce((sum, item) => sum + countedLoss(item), 0) : null;
  const energy = (key: "actualKwh" | "expectedKwh", unknown: boolean | undefined, total: number | null | undefined) => {
    const known = (item: IntervalLoss) => Number.isFinite(item[key]) && !(key === "actualKwh" ? item.productionUnknown : item.expectedUnknown);
    if (unknown || !energyCoverage || !clipped.length || !clipped.every(known)) return null;
    if (!reliable) {
      if (typeof total !== "number" || !Number.isFinite(total) || !items.every(known)) return null;
      const sum = items.reduce((value, item) => value + item[key]!, 0);
      if (Math.abs(sum - total) > Math.max(0.01, Math.abs(total) * 1e-8)) return null;
    }
    return clipped.reduce((sum, item) => sum + item[key]!, 0);
  };
  const actual = energy("actualKwh", issue.productionUnknown, issue.actualEnergyKwh);
  const expected = energy("expectedKwh", issue.expectedUnknown, issue.expectedEnergyKwh);
  const result = { ...issue, startDateTime: stamp(start, zoned), endDateTime: stamp(end, zoned),
    originalStart: issue.startDateTime, originalEnd: issue.endDateTime,
    reportClipped: true, durationMinutes: (end - start) / 60000,
    estimatedLossKwh: loss, lossUnknown: loss === null,
    actualEnergyKwh: actual, productionUnknown: actual === null,
    expectedEnergyKwh: expected, expectedUnknown: expected === null,
    lossPercent: loss !== null && expected !== null && expected > 0 ? loss / expected * 100 : null,
    intervalLosses: clipped, summaryPeriods: undefined,
    evidence: { ...issue.evidence, intervalLosses: clipped },
  };
  return { ...result, summaryPeriods: monthlyLosses(result, minutes) } as T;
}

export function monthlyLosses(issue: SourceIssue, intervalMinutes: number): PeriodLoss[] {
  const start = localMoment(issue.startDateTime), end = localMoment(issue.endDateTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const zoned = hasTimeZone(issue.startDateTime), zone = issue.timezone || "UTC";
  const parts: PeriodLoss[] = [];
  for (let cursor = start; cursor < end;) {
    const date = new Date(`${siteWallTime(stamp(cursor, zoned), zone).slice(0, 10)}T00:00:00Z`);
    const nextWall = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 19);
    const boundary = wallMoment(nextWall, zone, zoned);
    if (!Number.isFinite(boundary) || boundary <= cursor) return [];
    const next = Math.min(end, boundary);
    parts.push({ startDateTime: stamp(cursor, zoned), endDateTime: stamp(next, zoned), estimatedLossKwh: 0 });
    cursor = next;
  }
  if (issue.lossUnknown || issue.estimatedLossKwh === null) return parts.map(part => ({ ...part, estimatedLossKwh: null }));
  if (parts.length === 1 || issue.estimatedLossKwh === 0) {
    parts[0].estimatedLossKwh = issue.estimatedLossKwh;
    return parts;
  }
  const valid = validLedger(issue, intervalMinutes);
  if (valid) for (const item of ledger(issue)) {
    const from = localMoment(item.timestamp), to = from + intervalLength(item, intervalMinutes) * 60000;
    for (const part of parts) {
      const overlap = Math.max(0, Math.min(to, localMoment(part.endDateTime)) - Math.max(from, localMoment(part.startDateTime)));
      part.estimatedLossKwh! += countedLoss(item) * overlap / (to - from);
    }
  }
  const total = parts.reduce((sum, part) => sum + (part.estimatedLossKwh ?? 0), 0);
  // Legacy/missing evidence stays unknown rather than prorating a whole event by duration.
  if (!valid || Math.abs(total - issue.estimatedLossKwh) > Math.max(0.01, issue.estimatedLossKwh * 1e-8)) parts.forEach(part => { part.estimatedLossKwh = null; });
  return parts;
}
export type Grouping = "monthly" | "quarterly" | "annual";
export function periodKey(value: string, grouping: Grouping, timezone = "UTC") {
  const date = new Date(`${siteWallTime(value, timezone).slice(0, 10)}T00:00:00Z`);
  const month = grouping === "annual" ? 0 : grouping === "quarterly" ? Math.floor(date.getUTCMonth() / 3) * 3 : date.getUTCMonth();
  return Date.UTC(date.getUTCFullYear(), month, 1);
}
export function splitIssue<T extends SourceIssue & { summaryIssueNumber?: string; summaryPeriods?: PeriodLoss[]; originalStart?: string; originalEnd?: string }>(issue: T, grouping: Grouping) {
  const periods = issue.summaryPeriods?.length ? issue.summaryPeriods : monthlyLosses(issue, issue.intervalMinutes || 0);
  const grouped = new Map<number, PeriodLoss>();
  for (const part of periods) {
    const key = periodKey(part.startDateTime, grouping, issue.timezone), previous = grouped.get(key);
    grouped.set(key, previous ? { ...previous, endDateTime: part.endDateTime,
      estimatedLossKwh: previous.estimatedLossKwh === null || part.estimatedLossKwh === null ? null : previous.estimatedLossKwh + part.estimatedLossKwh } : { ...part });
  }
  return [...grouped.values()].map((part, index, all) => ({ ...issue, ...part,
    estimatedLossKwh: all.length === 1 ? issue.estimatedLossKwh : part.estimatedLossKwh,
    durationMinutes: (localMoment(part.endDateTime) - localMoment(part.startDateTime)) / 60000,
    originalStart: issue.originalStart || issue.startDateTime, originalEnd: issue.originalEnd || issue.endDateTime,
    portion: index + 1, portionCount: all.length,
  }));
}
