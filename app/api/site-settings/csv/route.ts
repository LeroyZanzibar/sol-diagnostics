import { getDatabaseBinding } from '../../../../db/binding';
import { planSiteCsv, sitesToCsv, SITE_CSV_HEADERS, SITE_CSV_MAX_BYTES, type SiteCsvRecord } from '../../../site-settings-csv';

const columns = ['id', 'name', 'address', 'city', 'state', 'zip', 'country', 'latitude', 'longitude', 'expected_shading', 'expected_snow', 'expected_production_notes'];
const selection = columns.map((column, index) => `${column} AS "${SITE_CSV_HEADERS[index]}"`).join(', ') + ', array_model_verified AS "arrayModelVerified", updated_at AS "updatedAt"';
type StoredSite = SiteCsvRecord & { arrayModelVerified: number; updatedAt: string };
type CsvStatement = { bind(...values: (string | number)[]): CsvStatement; all<T>(): Promise<{ results: T[] }> };
type CsvDatabase = { prepare(sql: string): CsvStatement; batch(statements: CsvStatement[]): Promise<{ results: StoredSite[] }[]> };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
async function loadSites(db: CsvDatabase) {
  return (await db.prepare(`SELECT ${selection} FROM site_settings ORDER BY id`).all<StoredSite>()).results;
}
async function previewToken(text: string, sites: StoredSite[]) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([text, sites])));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function GET(request: Request) {
  const download = new URL(request.url).searchParams.get('download');
  if (download !== 'template' && download !== 'sites') return json({ error: 'Choose template or sites.' }, 400);
  try {
    const sites = download === 'sites' ? await loadSites(getDatabaseBinding()) : [];
    return new Response(sitesToCsv(sites), { headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="site-settings-${download}.csv"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch { return json({ error: 'Unable to download site settings.' }, 500); }
}

// Stream and bound the actual bytes, not only the untrusted Content-Length.
async function readCsv(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return '';
  let size = 0, text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SITE_CSV_MAX_BYTES) { await reader.cancel(); throw new RangeError('CSV must be 1 MiB or smaller.'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

export async function POST(request: Request) {
  const mode = new URL(request.url).searchParams.get('mode') || 'preview';
  if (!['preview', 'apply'].includes(mode)) return json({ error: 'Choose preview or apply.' }, 400);
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'text/csv') return json({ error: 'Upload UTF-8 CSV with Content-Type: text/csv.' }, 415);
  let text: string;
  try { text = await readCsv(request); }
  catch (error) { return json({ error: error instanceof RangeError ? error.message : 'Unable to read UTF-8 CSV.' }, error instanceof RangeError ? 413 : 400); }
  try {
    const db: CsvDatabase = getDatabaseBinding();
    const sites = await loadSites(db);
    const plan = planSiteCsv(text, sites);
    if (plan.errors.length) return json({ ...plan, error: 'CSV validation failed. No sites were changed.' }, 400);
    const token = await previewToken(text, sites);
    if (mode === 'preview') return json({ ...plan, previewToken: token });
    if (request.headers.get('X-Site-Preview-Token') !== token) return json({ error: 'Preview is missing or site settings changed. Preview the file again before applying.' }, 409);
    const previous = new Map(sites.map(site => [site.id, site]));
    const statements: CsvStatement[] = [];
    const updatedAt = new Date().toISOString();
    for (const row of plan.rows) {
      const values = SITE_CSV_HEADERS.map(field => row.site[field]);
      if (row.action === 'create') {
        // Plain INSERT intentionally rejects an ID collision; never silently upsert.
        statements.push(db.prepare(`INSERT INTO site_settings (${columns.join(', ')}, updated_at) VALUES (${columns.map(() => '?').join(', ')}, ?)` ).bind(...values, updatedAt));
      } else {
        const prior = previous.get(row.site.id)!;
        // A NOT NULL violation aborts the *whole* batch if a concurrent edit or
        // deletion happened since the preview snapshot. No guard row is written.
        statements.push(db.prepare(`INSERT INTO site_settings (id, name) SELECT ?, NULL WHERE NOT EXISTS (SELECT 1 FROM site_settings WHERE ${columns.map(column => `${column} = ?`).join(' AND ')} AND array_model_verified = ? AND updated_at = ?)`)
          .bind(row.site.id, ...SITE_CSV_HEADERS.map(field => prior[field]), prior.arrayModelVerified, prior.updatedAt));
        statements.push(db.prepare(`UPDATE site_settings SET ${columns.slice(1).map(column => `${column} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).bind(...values.slice(1), updatedAt, row.site.id));
      }
    }
    // LocalDatabase.batch uses one synchronous BEGIN IMMEDIATE/COMMIT transaction;
    // any validation race, constraint or write failure rolls back every statement.
    statements.push(db.prepare(`SELECT ${selection} FROM site_settings ORDER BY id`));
    const results = await db.batch(statements);
    const saved = results[results.length - 1].results.map(site => ({ ...site, arrayModelVerified: Boolean(site.arrayModelVerified) }));
    return json({ created: plan.created, updated: plan.updated, sites: saved });
  } catch {
    return json({ error: 'Import was not applied. No rows in this import were saved. Site settings may have changed; preview again and retry.' }, 500);
  }
}
