/** Instants stay in UTC; a source timezone is used only to interpret offset-free input. */
export type TimestampConvention = "start" | "end";
export type TimestampResult = { timestamp: string; reason?: "invalid" | "timezone" | "ambiguous" | "nonexistent" };

const formatters = new Map<string, Intl.DateTimeFormat>();
const dayOffsets = new Map<string, number[]>();

function formatter(timezone: string) {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formatters.set(timezone, value);
  }
  return value;
}

export function isValidTimezone(timezone: string): boolean {
  if (!timezone.trim()) return false;
  try { formatter(timezone); return true; } catch { return false; }
}

function partsAt(moment: number, timezone: string) {
  return Object.fromEntries(formatter(timezone).formatToParts(new Date(moment)).map(part => [part.type, part.value]));
}

export function localTimestamp(timestamp: string, timezone = "UTC"): string {
  const moment = Date.parse(timestamp);
  if (!Number.isFinite(moment) || !isValidTimezone(timezone)) return "";
  const parts = partsAt(moment, timezone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function localDate(timestamp: string, timezone = "UTC"): string {
  return localTimestamp(timestamp, timezone).slice(0, 10);
}

function offsetAt(moment: number, timezone: string) {
  const parts = partsAt(moment, timezone);
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(moment / 1000) * 1000;
}

export function inspectTelemetryTimestamp(raw: string, timezone = "UTC"): TimestampResult {
  const value = raw.trim();
  if (!isValidTimezone(timezone)) return { timestamp: "", reason: "timezone" };
  if (!value) return { timestamp: "", reason: "invalid" };
  // An explicit offset identifies the instant even during the repeated autumn hour.
  if (/(?:z|[+-]\d{2}:?\d{2}|\b(?:utc|gmt))\s*$/i.test(value)) {
    const calendar = value.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (calendar) {
      const [, year, month, day, hour, minute, second = "0"] = calendar;
      const check = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      if (check.getUTCFullYear() !== Number(year) || check.getUTCMonth() !== Number(month) - 1 || check.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)
        return { timestamp: "", reason: "invalid" };
    }
    const moment = Date.parse(value);
    return Number.isFinite(moment) ? { timestamp: new Date(moment).toISOString() } : { timestamp: "", reason: "invalid" };
  }
  const match = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?\s*(AM|PM)?$/i);
  const monthFirst = !match && value.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?\s*(AM|PM)?$/i);
  const fields = match || monthFirst;
  if (!fields) return { timestamp: "", reason: "invalid" };
  const year = Number(fields[match ? 1 : 3]), month = Number(fields[match ? 2 : 1]), day = Number(fields[match ? 3 : 2]);
  let hour = Number(fields[4] || 0);
  const minute = Number(fields[5] || 0), second = Number(fields[6] || 0), millisecond = Number((fields[7] || "").padEnd(3, "0"));
  if (fields[8]) {
    if (hour < 1 || hour > 12) return { timestamp: "", reason: "invalid" };
    hour = hour % 12 + (fields[8].toUpperCase() === "PM" ? 12 : 0);
  }
  if (year < 100 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return { timestamp: "", reason: "invalid" };
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const normalized = new Date(wall);
  if (normalized.getUTCMonth() !== month - 1 || normalized.getUTCDate() !== day) return { timestamp: "", reason: "invalid" };
  const key = `${timezone}|${year}-${month}-${day}`;
  let offsets = dayOffsets.get(key);
  if (!offsets) {
    // Probe both sides of possible daylight-saving transitions, including half-hour shifts.
    const noon = Date.UTC(year, month - 1, day, 12);
    offsets = [...new Set([-36, -12, 0, 12, 36].map(hours => offsetAt(noon + hours * 3600000, timezone)))];
    if (dayOffsets.size >= 2000) dayOffsets.clear();
    dayOffsets.set(key, offsets);
  }
  const expected = normalized.toISOString().slice(0, 19);
  const candidates = offsets.map(offset => wall - offset).filter(moment => localTimestamp(new Date(moment).toISOString(), timezone) === expected);
  if (candidates.length !== 1) return { timestamp: "", reason: candidates.length ? "ambiguous" : "nonexistent" };
  return { timestamp: new Date(candidates[0]).toISOString() };
}

export function parseTelemetryTimestamp(raw: string, timezone = "UTC"): string {
  return inspectTelemetryTimestamp(raw, timezone).timestamp;
}
