"use client";

import {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import type {FormEvent, KeyboardEvent, RefObject} from 'react';
import type {ChartMetricId, ChartSettings, ChartType, MonthRange, SavedChartView} from './chart-types';
import type {MonthlySnapshot} from './monthly-types';
import {buildChartSeries, chartMetrics, chartSettingsEqual, defaultRange, formatChartMonth, quickViews, shiftMonth, validateChartSettings} from './monthly-chart-model';
import {useMonthlyChartData} from './monthly-chart-client';
import MonthlyChartPlot, {chartSeriesColor} from './MonthlyChartPlot';
import './monthly-charts.css';

type Props = {sites: Array<{id: string; name: string; location: string}>; siteId: string; onSiteChange: (id: string) => void};
const metricGroups = ['Production', 'Revenue', 'Insolation', 'Performance'] as const;

function reportingMonth(snapshot: MonthlySnapshot | null) {
  const now = new Date();
  const timeZone = snapshot?.telemetry.timezone || 'UTC';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {timeZone, year: 'numeric', month: '2-digit'}).formatToParts(now);
    return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}`;
  } catch {return now.toISOString().slice(0, 7);}
}
function availableRange(snapshot: MonthlySnapshot | null, fallback: string): MonthRange {
  if (!snapshot) return {start: fallback, end: fallback};
  const months = [...new Set([...snapshot.projections.map(row => row.month), ...Object.keys(snapshot.utility), ...Object.keys(snapshot.telemetry.months), ...Object.keys(snapshot.calculated)])].sort();
  return {start: months[0] || fallback, end: months.at(-1) || fallback};
}
function exactSettings(a: ChartSettings, b: ChartSettings) {
  return a.start === b.start && a.end === b.end && a.type === b.type && a.comparisonYears === b.comparisonYears && a.metrics.length === b.metrics.length && a.metrics.every((metric, index) => metric === b.metrics[index]);
}
function checkedView(input: unknown): SavedChartView {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Saved view response is invalid.');
  const value = input as Record<string, unknown>;
  if (typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name.trim() || typeof value.createdAt !== 'string') throw new Error('Saved view response is incomplete.');
  return {id: value.id, name: value.name, createdAt: value.createdAt, settings: validateChartSettings(value.settings)};
}
async function responseBody(response: Response) {
  let body: Record<string, unknown>;
  try {body = await response.json();} catch {throw new Error(`Chart views request failed (${response.status}). Reload and try again.`);}
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Chart views request failed (${response.status}).`);
  return body;
}
async function readViews(signal?: AbortSignal) {
  const response = await fetch('/api/chart-views', {method: 'GET', cache: 'no-store', credentials: 'same-origin', signal});
  const body = await responseBody(response);
  if (!Array.isArray(body?.views)) throw new Error('Saved views could not be read. The server returned an invalid list.');
  const views = body.views.map(checkedView);
  if (new Set(views.map(view => view.id)).size !== views.length) throw new Error('Saved views contain duplicate identifiers. Reload to try again.');
  return views;
}
function errorText(error: unknown) {return error instanceof Error ? error.message : 'The request could not be completed.';}
function closeDetails(ref: RefObject<HTMLDetailsElement | null>, focus = true) {
  if (!ref.current) return;
  ref.current.open = false;
  if (focus) ref.current.querySelector('summary')?.focus();
}
function viewDescription(view: SavedChartView) {
  const settings = view.settings;
  return `${settings.metrics.length} metrics / ${formatChartMonth(settings.start)} to ${formatChartMonth(settings.end)} / ${settings.type}${settings.comparisonYears ? ` / YoY +${settings.comparisonYears}` : ' / Timeline'}`;
}

export default function MonthlyCharts({sites, siteId, onSiteChange}: Props) {
  const instanceId = useId();
  const data = useMonthlyChartData(siteId);
  // In addition to the hook's generation fencing, never render another site's snapshot.
  const snapshot = data.snapshot?.siteId === siteId ? data.snapshot : null;
  const currentMonth = reportingMonth(snapshot);
  const [chart, setChart] = useState<{readySite: string; settings: ChartSettings}>(() => ({readySite: '', settings: {start: shiftMonth(currentMonth, -11), end: currentMonth, type: 'line', comparisonYears: 0, metrics: [...quickViews[0].metrics]}}));
  const settings = chart.settings;
  const [search, setSearch] = useState('');
  const [views, setViews] = useState<SavedChartView[]>([]);
  const [viewsLoading, setViewsLoading] = useState(true);
  const [viewsError, setViewsError] = useState('');
  const [activeView, setActiveView] = useState<SavedChartView | null>(null);
  const [saveFormOpen, setSaveFormOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [unverifiedView, setUnverifiedView] = useState<SavedChartView | null>(null);
  const [notice, setNotice] = useState('');
  const viewsRef = useRef<HTMLDetailsElement>(null);
  const metricsRef = useRef<HTMLDetailsElement>(null);
  const mountedRef = useRef(false);
  const readGenerationRef = useRef(0);
  const savingRef = useRef(false);
  const formActiveRef = useRef(false);
  const unverifiedRef = useRef<SavedChartView | null>(null);

  useEffect(() => {
    if (!siteId || !snapshot) return;
    setChart(previous => previous.readySite === siteId ? previous : {readySite: siteId, settings: {...previous.settings, ...defaultRange(snapshot, currentMonth)}});
  }, [siteId, snapshot, currentMonth]);

  const refreshViews = useCallback(async (signal?: AbortSignal) => {
    const generation = ++readGenerationRef.current;
    setViewsLoading(true); setViewsError('');
    try {
      const saved = await readViews(signal);
      if (mountedRef.current && generation === readGenerationRef.current) setViews(saved);
    } catch (error) {
      if (!signal?.aborted && mountedRef.current && generation === readGenerationRef.current) setViewsError(errorText(error));
    } finally {
      if (mountedRef.current && generation === readGenerationRef.current) setViewsLoading(false);
    }
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void refreshViews(controller.signal);
    return () => {mountedRef.current = false; readGenerationRef.current++; controller.abort();};
  }, [refreshViews]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      for (const ref of [viewsRef, metricsRef]) if (ref.current?.open && !ref.current.contains(event.target as Node)) closeDetails(ref, false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);

  function update(patch: Partial<ChartSettings>) {
    setChart(previous => ({...previous, settings: {...previous.settings, ...patch}}));
    setNotice('');
  }
  function removeMetric(id: ChartMetricId) {update({metrics: settings.metrics.filter(metric => metric !== id)});}
  function toggleMetric(id: ChartMetricId) {
    update({metrics: settings.metrics.includes(id) ? settings.metrics.filter(metric => metric !== id) : [...settings.metrics, id]});
  }
  function popupKey(event: KeyboardEvent<HTMLDetailsElement>, ref: RefObject<HTMLDetailsElement | null>, saved = false) {
    if (event.key === 'Escape' && ref.current?.open) {event.preventDefault(); event.stopPropagation(); closeDetails(ref); return;}
    if (!saved || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || ['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName)) return;
    const entries = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[data-view-entry]') ?? []);
    if (!entries.length) return;
    event.preventDefault();
    if (ref.current) ref.current.open = true;
    const current = entries.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : event.key === 'ArrowDown' ? (current + 1) % entries.length : (current <= 0 ? entries.length : current) - 1;
    entries[next].focus();
  }
  function restore(view: SavedChartView) {
    if (savingRef.current) return;
    setChart({readySite: siteId, settings: {...view.settings, metrics: [...view.settings.metrics]}});
    setActiveView(view); setNotice(`Restored “${view.name}”. Selected site unchanged.`);
    formActiveRef.current = false; setSaveFormOpen(false); setSaveError(''); closeDetails(viewsRef);
  }
  function beginSave() {
    if (savingRef.current || unverifiedRef.current) return;
    formActiveRef.current = true; setSaveFormOpen(true); setViewName(''); setSaveError(''); setNotice('');
  }
  async function verifySave(created: SavedChartView) {
    const saved = await readViews();
    const found = saved.find(view => view.id === created.id);
    if (!found || found.name !== created.name || !exactSettings(found.settings, created.settings)) throw new Error('The saved view did not match its readback.');
    if (!mountedRef.current) return;
    readGenerationRef.current++;
    setViews(saved); setViewsLoading(false); setViewsError(''); setActiveView(found);
    unverifiedRef.current = null; setUnverifiedView(null);
    formActiveRef.current = false; setSaveFormOpen(false); setSaveError('');
    setNotice(`Saved “${found.name}”. Available across sites in this app profile.`);
    closeDetails(viewsRef);
  }
  async function retryVerification() {
    const pending = unverifiedRef.current;
    if (!pending || savingRef.current) return;
    savingRef.current = true; setSaving(true); setSaveError('');
    try {await verifySave(pending);} catch (error) {if (mountedRef.current) setSaveError(`Save not yet verified. ${errorText(error)} Retry verification without saving again.`);}
    finally {savingRef.current = false; if (mountedRef.current) setSaving(false);}
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (savingRef.current || !formActiveRef.current || unverifiedRef.current) return;
    setSaveError(''); setNotice('');
    const name = viewName.trim();
    if (!name) {setSaveError('Enter a name for this view.'); return;}
    if (name.length > 60 || /\p{Cc}/u.test(name)) {setSaveError('Use 1–60 characters without control characters.'); return;}
    if (views.some(view => view.name.trim().toLowerCase() === name.toLowerCase())) {setSaveError('A view with this name already exists. Choose another name; existing views are never overwritten.'); return;}
    let savedSettings: ChartSettings;
    try {savedSettings = validateChartSettings(settings);} catch (error) {setSaveError(`Fix the current chart before saving. ${errorText(error)}`); return;}
    savingRef.current = true; setSaving(true); readGenerationRef.current++; setViewsLoading(false);
    try {
      const response = await fetch('/api/chart-views', {method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name, settings: savedSettings})});
      const body = await responseBody(response);
      if (response.status !== 201) throw new Error('The server did not confirm creation of a new view. Reload My views before trying again.');
      const created = checkedView(body.view);
      if (created.name !== name || !exactSettings(created.settings, savedSettings)) throw new Error('The save acknowledgement did not match this setup. Reload My views before trying again.');
      unverifiedRef.current = created;
      if (mountedRef.current) setUnverifiedView(created);
      await verifySave(created);
    } catch (error) {
      if (mountedRef.current) setSaveError(unverifiedRef.current ? `View may be saved, but verification failed. ${errorText(error)} Retry verification without saving again.` : errorText(error));
    } finally {savingRef.current = false; if (mountedRef.current) setSaving(false);}
  }

  let validationError = '';
  try {validateChartSettings(settings, true);} catch (error) {validationError = errorText(error);}
  const ready = !!snapshot && chart.readySite === siteId && !!siteId;
  const series = useMemo(() => ready && !validationError && snapshot ? buildChartSeries(snapshot, settings, {refreshing: data.refreshing, error: data.error}) : [], [ready, validationError, snapshot, settings, data.refreshing, data.error]);
  const hasValues = series.some(item => item.points.some(point => point.plotValue !== null));
  const selected = chartMetrics.filter(metric => settings.metrics.includes(metric.id));
  const filtered = chartMetrics.filter(metric => `${metric.label} ${metric.description} ${metric.unit} ${metric.group}`.toLowerCase().includes(search.trim().toLowerCase()));
  const observed = snapshot ? defaultRange(snapshot, currentMonth) : {start: shiftMonth(currentMonth, -11), end: currentMonth};
  const last24Start = shiftMonth(observed.end, -23);
  const ranges: Array<{label: string; range: MonthRange; title: string}> = [
    {label: '12M', range: observed, title: 'Last 12 months ending at the latest numeric actual month'},
    {label: '24M', range: {start: last24Start < '1900-01' ? '1900-01' : last24Start, end: observed.end}, title: 'Last 24 months ending at the latest numeric actual month'},
    {label: 'YTD', range: {start: `${currentMonth.slice(0, 4)}-01`, end: currentMonth}, title: 'Current reporting year through this month'},
    {label: 'All', range: availableRange(snapshot, currentMonth), title: 'All available actual and projection months, including future projections'},
  ];
  const modified = activeView && !chartSettingsEqual(activeView.settings, settings);
  const site = sites.find(item => item.id === siteId);
  const rangeErrorId = `${instanceId}-range-error`, saveErrorId = `${instanceId}-save-error`;

  return <section className="monthly-charts" aria-label="Monthly charts">
    <header className="mc-pagehead"><div><h1>Monthly charts</h1><p>Explore saved monthly site performance.</p></div>
      <label className="mc-site"><span>Site</span><select aria-label="Chart site" value={siteId} disabled={!sites.length} onChange={event => onSiteChange(event.target.value)}>
        {!site && <option value="">Choose a site</option>}{sites.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
      </select>{site?.location && <small>{site.location}</small>}</label>
    </header>
    <div className="mc-workspace">
      <div className="mc-views-row"><span className="mc-row-label">Quick views</span><div className="mc-presets" role="group" aria-label="Metric quick views">
        {quickViews.map(preset => <button type="button" key={preset.id} aria-pressed={preset.metrics.length === settings.metrics.length && preset.metrics.every(id => settings.metrics.includes(id))} onClick={() => update({metrics: [...preset.metrics]})}>{preset.label}</button>)}
      </div><span className={`mc-current-view${modified ? ' mc-modified' : ''}`} title={modified ? 'Changes do not overwrite the original view.' : undefined}>{activeView ? `${activeView.name}${modified ? ' (modified)' : ''}` : 'Unsaved view'}</span>
      <details className="mc-popup mc-my-views" data-my-views ref={viewsRef} onKeyDown={event => popupKey(event, viewsRef, true)}>
        <summary aria-controls={`${instanceId}-saved-views`}>My views</summary>
        <div className="mc-popover mc-views-popover" id={`${instanceId}-saved-views`} role="region" aria-label="Saved chart views">
          <div className="mc-popover-head"><strong>My views <small>{views.length} saved</small></strong><button type="button" onClick={() => closeDetails(viewsRef)}>Close</button></div>
          {viewsLoading && <p role="status">Loading saved views…</p>}
          {viewsError && <div className="mc-error" role="alert">{viewsError} <button type="button" onClick={() => void refreshViews()}>Retry views</button></div>}
          {!viewsLoading && !viewsError && !views.length && <p className="mc-views-empty">No saved views yet. Save a setup below.</p>}
          <div className="mc-saved-list">{views.map(view => <button type="button" className="mc-view-entry" data-view-entry={view.id} key={view.id} disabled={saving} aria-pressed={activeView?.id === view.id && !modified} onClick={() => restore(view)}>
            <span className="mc-view-check" aria-hidden="true">{activeView?.id === view.id && !modified ? '✓' : ''}</span><span><strong>{view.name}</strong><small>{viewDescription(view)}</small></span>
          </button>)}</div>
          <div className="mc-save-area">{!saveFormOpen && !unverifiedView ? <button type="button" className="mc-save-current" onClick={beginSave} disabled={saving}>Save current view</button> : <form className="mc-save-form" onSubmit={save} noValidate>
            <label><span>View name</span><input aria-label="View name" autoFocus autoComplete="off" maxLength={60} value={viewName} disabled={saving || !!unverifiedView} aria-invalid={!!saveError} aria-describedby={saveErrorId} onChange={event => {if (!savingRef.current && !unverifiedRef.current) setViewName(event.target.value);}}/></label>
            <div className="mc-save-actions">{unverifiedView ? <button type="button" onClick={() => void retryVerification()} disabled={saving}>{saving ? 'Verifying…' : 'Retry verification'}</button> : <button type="submit" className="mc-primary" disabled={saving}>{saving ? 'Saving & verifying…' : 'Save view'}</button>}
              {!unverifiedView && <button type="button" disabled={saving} onClick={() => {if (!savingRef.current) {formActiveRef.current = false; setSaveFormOpen(false); setSaveError('');}}}>Cancel</button>}
            </div>
            <p id={saveErrorId} className="mc-error" role={saveError ? 'alert' : undefined}>{saveError}</p>
          </form>}</div>
          <p className="mc-views-help">Saves metrics, dates, chart type and comparison in this shared app profile. Available across sites; your selected site stays unchanged.</p>
        </div>
      </details></div>
      <div className="mc-filters">
        <div className="mc-date-group"><div className="mc-date-fields"><label><span>From</span><input type="month" aria-label="From month" min="1900-01" max="9999-12" value={settings.start} aria-invalid={!!validationError} aria-describedby={rangeErrorId} onChange={event => update({start: event.target.value})}/></label>
          <label><span>To</span><input type="month" aria-label="To month" min="1900-01" max="9999-12" value={settings.end} aria-invalid={!!validationError} aria-describedby={rangeErrorId} onChange={event => update({end: event.target.value})}/></label></div>
          <div className="mc-ranges" role="group" aria-label="Date range shortcuts">{ranges.map(({label, range, title}) => <button type="button" key={label} title={title} disabled={!snapshot} aria-pressed={settings.start === range.start && settings.end === range.end} onClick={() => update(range)}>{label}</button>)}</div>
        </div>
        <div className="mc-control"><span>Chart type</span><div className="mc-segmented" role="group" aria-label="Chart type">{(['line', 'bar', 'table'] as ChartType[]).map(type => <button type="button" key={type} aria-pressed={settings.type === type} onClick={() => update({type})}>{type[0].toUpperCase() + type.slice(1)}</button>)}</div></div>
        <div className="mc-control"><span>Comparison</span><div className="mc-comparison"><div className="mc-segmented" role="group" aria-label="Time comparison"><button type="button" aria-pressed={settings.comparisonYears === 0} onClick={() => update({comparisonYears: 0})}>Timeline</button><button type="button" aria-pressed={settings.comparisonYears > 0} onClick={() => update({comparisonYears: settings.comparisonYears || 1})}>YoY</button></div>
          {settings.comparisonYears > 0 && <button type="button" className="mc-extra-year" aria-label="Second prior year" aria-pressed={settings.comparisonYears === 2} onClick={() => update({comparisonYears: settings.comparisonYears === 2 ? 1 : 2})}>+ 2nd prior year</button>}</div></div>
      </div>
      <div className="mc-metric-strip"><div className="mc-chips" aria-label="Selected metrics">{selected.map(metric => <button type="button" key={metric.id} className="mc-chip" aria-label={`Remove ${metric.label}`} onClick={() => removeMetric(metric.id)}><span className="mc-swatch" style={{borderColor: chartSeriesColor(metric.color)}} aria-hidden="true"/>{metric.label}<span aria-hidden="true">×</span></button>)}</div>
        <details className="mc-popup mc-metric-picker" ref={metricsRef} onKeyDown={event => popupKey(event, metricsRef)}><summary aria-controls={`${instanceId}-metric-options`}>+ Metrics <span>{selected.length}</span></summary>
          <div className="mc-popover mc-metric-popover" id={`${instanceId}-metric-options`} role="region" aria-label="Select metrics"><div className="mc-popover-head"><strong>Select metrics</strong><button type="button" onClick={() => closeDetails(metricsRef)}>Close</button></div>
            <div className="mc-metric-tools"><label className="mc-search"><span className="mc-sr-only">Search metrics</span><input type="search" aria-label="Search metrics" placeholder="Search all metrics" value={search} onChange={event => setSearch(event.target.value)}/></label><button type="button" onClick={() => update({metrics: chartMetrics.map(metric => metric.id)})}>Select all</button><button type="button" onClick={() => update({metrics: []})}>Clear</button></div>
            <div className="mc-metric-groups">{metricGroups.map(group => {const matches = filtered.filter(metric => metric.group === group); return matches.length > 0 && <fieldset key={group}><legend>{group}</legend>{matches.map(metric => <label className="mc-metric-option" key={metric.id}><input type="checkbox" data-metric-id={metric.id} aria-label={metric.label} checked={settings.metrics.includes(metric.id)} onChange={() => toggleMetric(metric.id)}/><span>{metric.label}<small>{metric.unit}</small></span><span className="mc-sr-only">{metric.description}</span></label>)}</fieldset>;})}{!filtered.length && <p>No matching metrics. Try another search.</p>}</div>
            <p className="mc-picker-help">Changes appear immediately. Select all includes all metrics, not just search results.</p>
          </div>
        </details>
      </div>
      <div id={rangeErrorId} className="mc-range-error" role={validationError ? 'alert' : undefined}>{validationError && `Check the date range: ${validationError}`}</div>
      {notice && <p className="mc-notice" role="status">{notice}</p>}
      {data.error && siteId && <div className="mc-data-error" role="alert"><strong>Monthly data could not be refreshed.</strong><p>{data.error} Telemetry-dependent values are hidden until freshness is confirmed. Other values come from the last accepted saved snapshot.</p><button type="button" onClick={() => void data.reload()} disabled={data.refreshing}>Retry</button></div>}
      {!siteId || !site ? <div className="mc-empty" role="status"><h2>{sites.length ? 'Choose a site' : 'No sites available'}</h2><p>Select a configured site to explore its saved monthly data.</p></div> : !ready ? <div className="mc-empty" role="status"><h2>{data.error ? 'Monthly data unavailable' : 'Loading saved monthly data…'}</h2><p>{data.error ? 'Retry the read to load this site.' : 'Reading utility actuals, projections and monthly telemetry.'}</p></div> : validationError ? <div className="mc-empty"><p>Correct the date range above to show the chart. No values are plotted for an invalid range.</p></div> : !selected.length ? <div className="mc-empty" role="status"><h2>Choose at least one metric</h2><p>Use a quick view or open Metrics to start a chart.</p></div> : <>
        <div className="mc-range-readout"><div><strong>{formatChartMonth(settings.start)} to {formatChartMonth(settings.end)}</strong><p>{settings.comparisonYears ? `Same calendar months, plus ${settings.comparisonYears === 2 ? 'two prior years' : 'one prior year'}. Source periods are labeled below.` : 'Monthly timeline'}{data.refreshing ? ' / Refreshing saved data…' : ''}</p></div><span>{new Set(selected.map(metric => metric.unit)).size > 2 ? 'Separate charts by unit' : 'Axes follow measurement units'}</span></div>
        {!hasValues && <div className="mc-empty" role="status"><h2>No numeric values in this selection</h2><p>Try another period or metric. Missing values are never treated as zero; the table retains source reasons.</p></div>}
        {(hasValues || settings.type === 'table') && <MonthlyChartPlot key={`${siteId}:${settings.start}:${settings.end}:${settings.type}:${settings.comparisonYears}:${settings.metrics.join(',')}`} series={series} type={settings.type} onRemoveMetric={removeMetric}/>}
        <div className="mc-summary-line"><span>{selected.length} metrics / read-only source values</span><span>{settings.type === 'bar' ? 'Grouped bars, never stacked' : settings.type === 'line' ? 'Gaps mean unavailable values' : 'Exact monthly display values'}</span></div>
      </>}
    </div>
    {snapshot && <details className="mc-source-notes"><summary>Monthly sources & calculation notes</summary>
      <p>Expected Production is the monthly total of imported hourly Expected Production, not projected production. Partial totals remain partial; missing values are not zero.</p>
      <p>Actual insolation uses the selected reporting series: satellite-first with POA gap filling only when supported by retained evidence. Imported provenance can be mixed or unknown. Conventional performance ratio expects matching plane-of-array (POA) insolation.</p>
      <p>Specific yield and performance ratio use saved connected module DC capacity, not AC limits or losses. {snapshot.capacity.unavailableReason || 'Capacity-dependent metrics use the saved model.'}</p>
      <p>Reporting timezone: {snapshot.telemetry.timezone || 'not yet pinned (UTC used for current-year shortcuts)'}. Telemetry source revision: {snapshot.telemetry.sourceRevision}. Status: {data.error ? 'freshness unavailable' : data.refreshing ? 'refreshing' : snapshot.telemetry.state}.</p>
      {snapshot.telemetry.expectedUnavailableReason && <p>{snapshot.telemetry.expectedUnavailableReason}</p>}
      {snapshot.telemetry.selectionRequired && <p>Select an explicit irradiance reporting channel in 12-month baselines before comparing Actual insolation.</p>}
      <p>All includes the available actual and projection domain, including future projections. The default 12 months ends at the latest numeric actual month. YTD uses the current reporting year.</p>
    </details>}
  </section>;
}
