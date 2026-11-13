// Shared CSV contract for the settings UI and server. No spreadsheet type inference:
// identifiers, coordinates and postal codes stay strings throughout the round trip.
export const SITE_CSV_HEADERS = ["id", "name", "address", "city", "state", "zip", "country", "latitude", "longitude", "expectedShading", "expectedSnow", "expectedProductionNotes"] as const;
export const SITE_CSV_MAX_BYTES = 1024 * 1024;
export const SITE_CSV_MAX_ROWS = 500;
export type SiteCsvField = typeof SITE_CSV_HEADERS[number];
export type SiteCsvRecord = Record<SiteCsvField, string>;
export type SiteCsvError = { row: number; message: string };
export type SiteCsvRow = { row: number; action: "create" | "update"; site: SiteCsvRecord };
export type SiteCsvPlan = { rows: SiteCsvRow[]; errors: SiteCsvError[]; created: number; updated: number };
const limits: Record<SiteCsvField, number> = { id: 128, name: 200, address: 500, city: 100, state: 100, zip: 12, country: 2, latitude: 32, longitude: 32, expectedShading: 12, expectedSnow: 12, expectedProductionNotes: 4000 };
const countries = new Set(["US", "CA", "MX", "AU", "BR", "CL", "DE", "ES", "FR", "GB", "IN", "IT", "JP", "NL", "PL", "PT", "ZA"]);
const postalPatterns: Record<string, RegExp> = { US: /^\d{5}(?:-\d{4})?$/, CA: /^[A-Z]\d[A-Z][ -]?\d[A-Z]\d$/, DE: /^\d{5}$/, JP: /^\d{3}-?\d{4}$/, PL: /^\d{2}-?\d{3}$/, IT: /^\d{5}$/ };
const defaults: SiteCsvRecord = { id: "", name: "", address: "", city: "", state: "", zip: "", country: "US", latitude: "", longitude: "", expectedShading: "not_included", expectedSnow: "not_included", expectedProductionNotes: "" };

class CsvError extends Error {
  constructor(public row: number, message: string) { super(message); }
}

// Strict comma-delimited CSV with physical source-line numbers, including quoted
// multiline cells. Reject malformed quotes instead of guessing shifted columns.
function parseCsv(text: string) {
  if (new TextEncoder().encode(text).byteLength > SITE_CSV_MAX_BYTES) throw new CsvError(1, "CSV must be 1 MiB or smaller.");
  text = text.replace(/^\uFEFF/, "");
  const rows: { row: number; cells: string[] }[] = [];
  let cells: string[] = [], cell = "", quoted = false, closed = false, line = 1, start = 1;
  const endCell = () => { cells.push(cell); cell = ""; closed = false; if (cells.length > SITE_CSV_HEADERS.length) throw new CsvError(start, "Too many columns."); };
  const endRow = () => {
    endCell();
    if (cells.some(value => value.trim() !== "")) rows.push({ row: start, cells });
    cells = [];
    if (rows.length > SITE_CSV_MAX_ROWS + 1) throw new CsvError(start, `Import at most ${SITE_CSV_MAX_ROWS} sites at a time.`);
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\0') throw new CsvError(line, "NUL characters are not supported.");
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else {
        cell += char;
        if (char === '\n' || (char === '\r' && text[i + 1] !== '\n')) line++;
      }
    } else if (char === ',') endCell();
    else if (char === '\n' || char === '\r') {
      endRow();
      if (char === '\r' && text[i + 1] === '\n') i++;
      line++; start = line;
    } else if (char === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new CsvError(line, "Malformed CSV quoting.");
      cell += char;
    }
    if (cell.length > 4000) throw new CsvError(start, "A cell exceeds 4,000 characters.");
  }
  if (quoted) throw new CsvError(start, "Unclosed quoted field.");
  if (cell || cells.length || closed) endRow();
  return rows;
}

// Spreadsheet formula protection is reversible: dangerous text and pre-existing
// apostrophes gain one apostrophe on export, removed only for this escape syntax.
function unescapeCell(value: string) { return /^'(?:[=+\-@']|[\t\r\n])/.test(value) ? value.slice(1) : value; }
function csvCell(value: string, field: SiteCsvField) {
  const numericCoordinate = (field === "latitude" || field === "longitude") && /^-?\d+(?:\.\d+)?$/.test(value);
  const safe = !numericCoordinate && /^(?:[=+\-@']|[\t\r\n])/.test(value) ? "'" + value : value;
  return /[",\r\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}
export function sitesToCsv(sites: Partial<SiteCsvRecord>[] = []) {
  return '\uFEFF' + SITE_CSV_HEADERS.join(',') + '\r\n' + sites.map(site => SITE_CSV_HEADERS.map(field => csvCell(String(site[field] ?? ''), field)).join(',') + '\r\n').join('');
}

export function planSiteCsv(text: string, existing: SiteCsvRecord[]): SiteCsvPlan {
  const plan: SiteCsvPlan = { rows: [], errors: [], created: 0, updated: 0 };
  const error = (row: number, message: string) => plan.errors.push({ row, message });
  let parsed: ReturnType<typeof parseCsv>;
  try { parsed = parseCsv(text); }
  catch (cause) { error(cause instanceof CsvError ? cause.row : 1, cause instanceof Error ? cause.message : "Invalid CSV."); return plan; }
  const header = parsed.shift();
  if (!header) { error(1, "CSV is empty. Download the template to get started."); return plan; }
  const fields = header.cells.map(value => value.trim());
  for (const field of fields) {
    if (!(SITE_CSV_HEADERS as readonly string[]).includes(field)) error(header.row, `Unsupported header: ${field || '(blank)'}. Use the template headers exactly.`);
    if (fields.indexOf(field) !== fields.lastIndexOf(field)) error(header.row, `Duplicate header: ${field}.`);
  }
  if (!fields.includes('name')) error(header.row, "The name header is required.");
  if (plan.errors.length) return plan;
  if (!parsed.length) error(header.row, "Add at least one site row beneath the headers.");
  const byId = new Map(existing.map(site => [site.id, site]));
  const used = new Set(byId.keys()), seen = new Set<string>();
  for (const entry of parsed) {
    const { row, cells } = entry;
    if (cells.length !== fields.length) { error(row, `Expected ${fields.length} columns but found ${cells.length}.`); continue; }
    const input = Object.fromEntries(fields.map((field, index) => [field, unescapeCell(cells[index]).trim()])) as Partial<SiteCsvRecord>;
    const sourceId = input.id ?? '';
    // IDs must match exactly, not be trimmed or normalized into a different ID.
    const idIndex = fields.indexOf('id');
    if (idIndex >= 0 && unescapeCell(cells[idIndex]) !== sourceId) error(row, "id must match exactly, without surrounding whitespace.");
    if (sourceId && !byId.has(sourceId)) error(row, `Unknown id: ${sourceId}. Leave id blank to create a site.`);
    if (sourceId && seen.has(sourceId)) error(row, `Duplicate id: ${sourceId}. Include each existing site only once.`);
    if (sourceId) seen.add(sourceId);
    const site = { ...defaults };
    const prior = byId.get(sourceId);
    for (const field of SITE_CSV_HEADERS) site[field] = input[field] || prior?.[field] || defaults[field];
    site.country = site.country.toUpperCase(); site.zip = site.zip.toUpperCase();
    if (!sourceId) {
      const base = site.name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'site';
      let id = base, suffix = 2;
      while (used.has(id)) { id = `${base.slice(0, 47 - String(suffix).length)}-${suffix}`; suffix++; }
      site.id = id; used.add(id);
    }
    if (!site.name) error(row, "name is required for a new site.");
    for (const field of SITE_CSV_HEADERS) {
      if (site[field].length > limits[field]) error(row, `${field} exceeds ${limits[field]} characters.`);
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(site[field])) error(row, `${field} contains unsupported control characters.`);
    }
    if (!countries.has(site.country)) error(row, "country must be a supported two-letter country code (see README).");
    if (site.zip && postalPatterns[site.country] && !postalPatterns[site.country].test(site.zip)) error(row, `Invalid postal code for ${site.country}. Keep postal codes as text to preserve leading zeroes.`);
    for (const field of ['expectedShading', 'expectedSnow'] as const) if (!['included', 'not_included', 'unknown'].includes(site[field])) error(row, `${field} must be included, not_included or unknown.`);
    for (const [field, max] of [['latitude', 90], ['longitude', 180]] as const) {
      const value = site[field];
      if (value && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > max)) error(row, `${field} must be a decimal number between -${max} and ${max}.`);
    }
    plan.rows.push({ row, action: sourceId ? 'update' : 'create', site });
    if (sourceId) plan.updated++; else plan.created++;
  }
  return plan;
}
