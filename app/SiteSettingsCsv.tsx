"use client";

import { useRef, useState } from 'react';
import { SITE_CSV_HEADERS, SITE_CSV_MAX_BYTES, SITE_CSV_MAX_ROWS, type SiteCsvPlan, type SiteCsvRecord } from './site-settings-csv';
import './site-settings-csv.css';

type SavedSite = SiteCsvRecord & { arrayModelVerified: boolean };
type Preview = SiteCsvPlan & { previewToken: string };
export default function SiteSettingsCsv({ onImported, disabled = false }: { onImported: (sites: SavedSite[]) => void; disabled?: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [errors, setErrors] = useState<SiteCsvPlan['errors']>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);

  function clear() {
    setFile(null); setPreview(null); setErrors([]); setMessage('');
    if (input.current) input.current.value = '';
  }
  async function submit(selected: File, mode: 'preview' | 'apply') {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    const token = preview?.previewToken;
    setBusy(mode); setErrors([]); setMessage(''); setPreview(null);
    try {
      if (selected.size > SITE_CSV_MAX_BYTES) throw new Error('CSV must be 1 MiB or smaller.');
      const response = await fetch(`/api/site-settings/csv?mode=${mode}`, {
        method: 'POST', headers: { 'Content-Type': 'text/csv; charset=utf-8', ...(mode === 'apply' && token ? { 'X-Site-Preview-Token': token } : {}) }, body: selected,
      });
      const result = await response.json();
      if (!response.ok) {
        if (Array.isArray(result.errors)) setErrors(result.errors);
        throw new Error(result.error || 'Unable to import site settings.');
      }
      if (mode === 'preview') setPreview(result);
      else {
        onImported(result.sites); setFile(null);
        if (input.current) input.current.value = '';
        setMessage(`Import complete: ${result.created} created, ${result.updated} updated.`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unable to import site settings.';
      const recovery = mode === 'apply' ? ' If the connection was interrupted, download existing sites before retrying to check whether the import completed.' : '';
      setErrors(current => current.length ? current : [{ row: 0, message: detail + recovery }]);
    } finally { inFlight.current = false; setBusy(null); }
  }

  return <section className="site-csv panel" aria-labelledby="site-csv-title" aria-busy={Boolean(busy)}>
    <h2 id="site-csv-title">Bulk site settings</h2>
    <p>Download a template for new sites, or download existing sites to edit their exact IDs. Upload a UTF-8 CSV, review the preview, then apply all rows together.</p>
    <div className="site-csv-actions">
      <a className="secondary-btn" href="/api/site-settings/csv?download=template" download>Download CSV template</a>
      <a className="secondary-btn" href="/api/site-settings/csv?download=sites" download>Download existing sites</a>
    </div>
    <p id="site-csv-help">Blank id creates a new site (name required). An existing id updates only that site. Blank or omitted fields keep existing values; new sites default to US and not_included assumptions. No fuzzy name matching or deletions. Maximum {SITE_CSV_MAX_ROWS} sites and 1 MiB per file. Keep postal codes as text in your spreadsheet.</p>
    <label className="field site-csv-file"><span>Site settings CSV</span>
      <input ref={input} type="file" accept=".csv,text/csv" disabled={Boolean(busy) || disabled} aria-describedby="site-csv-help" onChange={event => {
        const selected = event.target.files?.[0] ?? null;
        setFile(selected); setPreview(null); setErrors([]); setMessage('');
        if (selected) void submit(selected, 'preview');
      }} />
    </label>
    {busy && <p role="status">{busy === 'preview' ? 'Validating CSV. No changes are being saved.' : 'Applying all site settings…'}</p>}
    {errors.length > 0 && <div role="alert" className="site-csv-errors"><strong>Import needs attention</strong><ul>{errors.map((error, index) => <li key={index}>{error.row > 0 ? `Row ${error.row}: ` : ''}{error.message}</li>)}</ul></div>}
    {message && <p role="status">{message}</p>}
    {preview && <div>
      <p role="status"><strong>{preview.created} to create, {preview.updated} to update.</strong> Nothing has been saved. The table shows the resulting settings, including preserved values.</p>
      <div className="site-csv-table" tabIndex={0} role="region" aria-label="CSV import preview">
        <table><thead><tr><th scope="col">CSV row</th><th scope="col">Action</th>{SITE_CSV_HEADERS.map(field => <th scope="col" key={field}>{field}</th>)}</tr></thead>
          <tbody>{preview.rows.map(row => <tr key={row.row}><td>{row.row}</td><td>{row.action}</td>{SITE_CSV_HEADERS.map(field => <td key={field}>{row.site[field] || '—'}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <p>Applying saves every row or none. Array models, performance data and reviews are untouched. Unsaved edits in the single-site form will be replaced by saved settings.</p>
    </div>}
    {file && <div className="site-csv-actions">
      {preview ? <button type="button" className="primary-btn" disabled={Boolean(busy) || disabled} onClick={() => void submit(file, 'apply')}>Apply {preview.rows.length} {preview.rows.length === 1 ? 'site' : 'sites'}</button>
        : <button type="button" className="secondary-btn" disabled={Boolean(busy) || disabled} onClick={() => void submit(file, 'preview')}>Preview again</button>}
      <button type="button" className="secondary-btn" disabled={Boolean(busy)} onClick={clear}>Cancel import</button>
    </div>}
  </section>;
}
