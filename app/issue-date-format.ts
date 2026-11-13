import { localTimestamp } from "./telemetry-time";

// Legacy saved wall times remain unchanged; new UTC records display in the site's zone.
export function formatDateTime(value: string, timezone = "UTC") {
  if (!value) return "—";
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const wall = zoned ? localTimestamp(value, timezone) : value;
  const match = wall.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return "—";
  const seconds = match[6] && match[6] !== "00" ? `:${match[6]}` : "";
  // Include the offset so the two occurrences of a repeated DST hour are distinguishable.
  const offset = zoned ? new Intl.DateTimeFormat("en", { timeZone: timezone, timeZoneName: "shortOffset" }).formatToParts(new Date(value)).find(part => part.type === "timeZoneName")?.value : "";
  return `${match[1]}/${match[2]}/${match[3]} ${Number(match[4])}:${match[5]}${seconds}${offset ? ` ${offset}` : ""}`;
}
