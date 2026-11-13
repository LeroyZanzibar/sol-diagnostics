import { inspectTelemetryTimestamp, isValidTimezone, localTimestamp } from "./telemetry-time";

export function reviewTimezone(timezone: unknown): string {
  return typeof timezone === "string" && isValidTimezone(timezone) ? timezone : "UTC";
}

/** Keep storage in UTC; only the editor's wall-clock value uses the site's zone. */
export function resolutionLocalTime(timestamp: string, timezone: string): string {
  const local = localTimestamp(timestamp, timezone);
  if (!local) return "";
  const milliseconds = new Date(timestamp).toISOString().slice(19, 23);
  return local + (milliseconds === ".000" ? "" : milliseconds);
}

export function issueResolutionTime(issueEndDateTime: string, timezone: string): string {
  return inspectTelemetryTimestamp(issueEndDateTime, timezone).timestamp;
}

export function resolutionTimeOptions(value: string, timezone: string): { timestamp: string; label: string }[] {
  const parsed = inspectTelemetryTimestamp(value, timezone);
  let candidates = parsed.timestamp ? [parsed.timestamp] : [];
  if (parsed.reason === "ambiguous") {
    // A repeated clock hour needs an explicit occurrence. Support half-hour DST too.
    const wall = inspectTelemetryTimestamp(value, "UTC").timestamp;
    const epoch = Date.parse(wall);
    const offsets = new Set([-36, -12, 0, 12, 36].map(hours => {
      const probe = epoch + hours * 3600000;
      return Date.parse(`${localTimestamp(new Date(probe).toISOString(), timezone)}Z`) - Math.floor(probe / 1000) * 1000;
    }));
    candidates = [...offsets].map(offset => new Date(epoch - offset).toISOString())
      .filter(timestamp => resolutionLocalTime(timestamp, timezone) === resolutionLocalTime(wall, "UTC")).sort();
  }
  return candidates.map(timestamp => ({ timestamp, label: new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
  }).format(new Date(timestamp)) }));
}

export function resolutionTimeError(value: string, timezone: string, timestamp: string): string {
  const options = resolutionTimeOptions(value, timezone);
  if (options.some(option => option.timestamp === timestamp)) return "";
  if (options.length > 1) return "This time occurs twice when daylight saving ends. Choose the time occurrence.";
  if (inspectTelemetryTimestamp(value, timezone).reason === "nonexistent") return `This time does not exist in ${timezone} because the clocks move forward. Choose a valid time.`;
  return "Enter a valid resolution date and time.";
}
