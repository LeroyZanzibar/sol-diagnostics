import {getBucketBinding, getDatabaseBinding, type SynchronousDatabaseReader} from '../../../db/binding';
import {optionalPerformanceStoreManager} from '../../../db/performance-store';
import {DEPOT_CLEANUP_ID, DEPOT_SITE_ID} from '../../../db/depot-performance-cleanup';
import {publishedAnalysisAvailable} from '../analysis-history/availability';
import {savedAnalysis} from '../analysis-history/service';
import {effectiveReviews} from '../issue-reviews/service';
import {effectiveReviewStatus} from '../../issue-review';
import {defaultIssueVisibility, isIssueVisible} from '../../issue-visibility';
import {hasTimeZone, localMoment, monthlyLosses, siteWallTime} from '../../issue-periods';
import {readCheckpoint} from '../performance-summary/checkpoint-storage';
import {add, fraction, multiply} from '../../monthly-domain.mjs';
import type {Fraction} from '../../monthly-domain.mjs';
import type {MonthlyConfirmedLoss, MonthlyConfirmedLossMetric} from '../../monthly-types';

type Publication = {import_id:string; summary:string; processed_at:string};
type Run = {id:string; site_id:string; import_id:string; analysis_object_key:string; status:string; parser_version:number; model_revision:string};
type Input = {id:string; timezone:string; timestamp_start:string|null; timestamp_end:string|null; validation:string};
type Pointer = {objectKey?:string; analysisRunId?:string};
type Payload = Record<string, any>;
class SourceUnavailable extends Error {}
const absent = (state:MonthlyConfirmedLoss['state'], reason:string, analysisRunId:string|null = null):MonthlyConfirmedLoss =>
  ({state, analysisRunId, timezone:null, months:{}, reason});
const parse = (value:string) => {try {return JSON.parse(value);} catch {return null;}};

/** Mirror the browse selector, without currentAnalysisInput's absent-site store
 * initialization. Never create an input, pick newest history, or skip a bad head. */
function selection(read:SynchronousDatabaseReader, siteId:string) {
  const cleanup = siteId === DEPOT_SITE_ID && read.first<{status:string}>('SELECT status FROM maintenance_tasks WHERE id = ?', DEPOT_CLEANUP_ID)?.status === 'deleting';
  const manager = optionalPerformanceStoreManager();
  const inputId = cleanup ? null : manager?.hasData(siteId) ? manager.site(siteId).describe().revisionId :
    read.first<{id:string}>("SELECT id FROM telemetry_imports WHERE site_id = ? AND status <> 'pending' ORDER BY created_at DESC LIMIT 1", siteId)?.id || null;
  const rows = read.all<Publication>('SELECT import_id,summary,processed_at FROM performance_summaries WHERE site_id = ? ORDER BY import_id', siteId);
  const row = inputId ? rows.find(row => row.import_id === inputId) || (rows.length === 1 ? rows[0] : null) : null;
  const candidate = row ? parse(row.summary) : null;
  const pointer:Pointer|null = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : null;
  // Keep the exact owner/status bytes in the final fence. Availability itself is
  // decided by the shared public-reader guard, including unique legacy ownership.
  const owners = typeof pointer?.objectKey === 'string' && pointer.objectKey ?
    Object.prototype.hasOwnProperty.call(pointer, 'analysisRunId') ?
      read.all<Run>('SELECT id,site_id,import_id,analysis_object_key,status,parser_version,model_revision FROM analysis_runs WHERE id = ? AND site_id = ?', pointer.analysisRunId, siteId) :
      read.all<Run>('SELECT id,site_id,import_id,analysis_object_key,status,parser_version,model_revision FROM analysis_runs WHERE analysis_object_key = ? ORDER BY id LIMIT 2', pointer.objectKey) : [];
  const run = owners.length === 1 ? owners[0] : null;
  const input = row ? read.first<Input>('SELECT id,timezone,timestamp_start,timestamp_end,validation FROM telemetry_imports WHERE id = ? AND site_id = ?', row.import_id, siteId) : null;
  return {row, pointer, run, input, signature:JSON.stringify([inputId, row, owners, input, cleanup])};
}

function reviewVersions(read:SynchronousDatabaseReader, siteId:string, keys:string[]) {
  const rows:unknown[] = [];
  for (let offset = 0; offset < keys.length; offset += 80) {
    const batch = keys.slice(offset, offset + 80);
    rows.push(...read.all(`SELECT r.event_key,r.version,r.state,r.updated_at,
      (SELECT c.run_id FROM issue_review_changes c WHERE c.site_id=r.site_id AND c.event_key=r.event_key AND c.version=r.version LIMIT 1) AS run_id
      FROM issue_event_reviews r WHERE r.site_id=? AND r.event_key IN (${batch.map(() => '?').join(',')}) ORDER BY r.event_key`, siteId, ...batch));
  }
  return JSON.stringify(rows);
}

function assertPayload(payload:Payload, siteId:string, source:ReturnType<typeof selection>) {
  const {run, row} = source;
  if (!run || !row || payload?.siteId !== siteId || payload.importId !== row.import_id || payload.issueDatabase?.analysisRunId !== run.id ||
      payload.import && payload.import.id !== row.import_id || payload.methodology?.analysisId && payload.methodology.analysisId !== run.id ||
      payload.parserVersion !== undefined && payload.parserVersion !== run.parser_version || payload.modelRevision !== undefined && payload.modelRevision !== run.model_revision ||
      !Array.isArray(payload.analysis?.issues) || payload.analysis.recurringIssues !== undefined && !Array.isArray(payload.analysis.recurringIssues) ||
      payload.issueDatabase.persistedIssueCount !== undefined && (!Number.isSafeInteger(payload.issueDatabase.persistedIssueCount) || payload.issueDatabase.persistedIssueCount !== payload.analysis.issues.length))
    throw new SourceUnavailable('The current published analysis identity or full findings are unavailable.');
}

/** The stored analysis domain uses inclusive interval starts, not event bounds.
 * Auxiliary provenance scopes (for example snow) cannot expand that domain. */
function coverage(payload:Payload, source:ReturnType<typeof selection>, timezone:string, minutes:number) {
  const manager = optionalPerformanceStoreManager();
  const provenance = payload.provenance || payload.methodology?.inputProvenance ||
    (manager?.hasData(source.run!.site_id) ? manager.site(source.run!.site_id).analysis(source.run!.id) : null);
  let start:unknown, last:unknown, convention = 'start';
  if (provenance) {
    if (provenance.version !== 1 || provenance.siteId !== source.run!.site_id || provenance.revisionId !== source.row!.import_id ||
        provenance.dependencyScope !== 'analysis-range' || !Array.isArray(provenance.scopes) || !provenance.scopes.length)
      throw new SourceUnavailable('The saved analysis coverage provenance is inconsistent.');
    ({start, end:last} = provenance.scopes[0]);
  } else if (Array.isArray(payload.summary?.timestamps) && payload.summary.timestamps.length) {
    const timestamps = payload.summary.timestamps;
    if (timestamps.some((stamp:unknown) => typeof stamp !== 'string' || !Number.isFinite(localMoment(stamp))))
      throw new SourceUnavailable('The saved analysis timestamp coverage is unavailable.');
    const ordered = [...timestamps].sort((a:string, b:string) => localMoment(a) - localMoment(b));
    start = ordered[0]; last = ordered.at(-1);
  } else {
    start = payload.import?.timestampStart ?? source.input?.timestamp_start;
    last = payload.import?.timestampEnd ?? source.input?.timestamp_end;
    convention = payload.validation?.timestampConvention || payload.methodology?.timestampConvention || parse(source.input?.validation || '{}')?.timestampConvention;
    if (!['start', 'end'].includes(convention)) throw new SourceUnavailable('The saved analysis coverage timestamp convention is unavailable.');
  }
  if (typeof start !== 'string' || typeof last !== 'string' || hasTimeZone(start) !== hasTimeZone(last) ||
      !Number.isFinite(localMoment(start)) || !Number.isFinite(localMoment(last)) || localMoment(last) < localMoment(start))
    throw new SourceUnavailable('The saved analysis coverage could not be established.');
  const zoned = hasTimeZone(start), shift = convention === 'end' ? minutes * 60000 : 0;
  const stamp = (value:number) => zoned ? new Date(value).toISOString() : new Date(value).toISOString().slice(0, 19);
  const parts = monthlyLosses({id:'analysis-coverage', timezone, startDateTime:stamp(localMoment(start) - shift),
    endDateTime:stamp(localMoment(last) - shift + minutes * 60000), estimatedLossKwh:0}, minutes);
  if (!parts.length) throw new SourceUnavailable('The saved analysis coverage could not be established.');
  return parts.map(part => siteWallTime(part.startDateTime, timezone).slice(0, 7));
}

// Analysis numbers already have Number precision. Preserve their decimal form
// (including exponent notation), then sum exact fractions without display rounding.
function numericFraction(value:number):Fraction {
  const [mantissa, exponent] = String(value).toLowerCase().split('e');
  const base = fraction(mantissa), power = Number(exponent || 0);
  return multiply(base, power >= 0 ? {n:String(BigInt(10) ** BigInt(power)), d:'1'} : {n:'1', d:String(BigInt(10) ** BigInt(-power))});
}

async function issueMonths(issue:Payload, source:ReturnType<typeof selection>, timezone:string, minutes:number) {
  const normalized = {...issue, timezone, intervalMinutes:minutes,
    estimatedLossKwh:typeof issue.estimatedLossKwh === 'number' && Number.isFinite(issue.estimatedLossKwh) && issue.estimatedLossKwh >= 0 ? issue.estimatedLossKwh : null};
  let parts = monthlyLosses(normalized as Parameters<typeof monthlyLosses>[0], minutes);
  // Full contemporary results already carry their counted ledger. Only a known
  // cross-month total may need older per-issue evidence; never read foreign keys.
  if (parts.length > 1 && parts.some(part => part.estimatedLossKwh === null) && !issue.lossUnknown && normalized.estimatedLossKwh !== null && normalized.estimatedLossKwh !== 0) {
    const key = issue.evidence?.evidenceKey;
    const root = `analysis/${source.run!.site_id}/jobs/${source.run!.id}/`;
    const safe = typeof key === 'string' && key.startsWith(root) && key !== source.run!.analysis_object_key &&
      !key.slice(root.length).split('/').some(part => !part || part === '.' || part === '..') &&
      source.run!.analysis_object_key === `${root}result.json` && issue.evidence?.evidenceFormat !== 'analysis-result' &&
      (!issue.evidence?.analysisRunId || issue.evidence.analysisRunId === source.run!.id) &&
      (!issue.evidence?.sourceIssueId || issue.evidence.sourceIssueId === issue.id);
    if (safe) {
      try {
        const object = await getBucketBinding().get(key);
        if (object) {
          const evidence = await readCheckpoint<Payload>(object);
          if ((!evidence.analysisRunId || evidence.analysisRunId === source.run!.id) && (!evidence.sourceIssueId || evidence.sourceIssueId === issue.id) &&
              (!evidence.siteId || evidence.siteId === source.run!.site_id) && Array.isArray(evidence.intervalLosses))
            parts = monthlyLosses({...normalized, intervalLosses:evidence.intervalLosses, evidence} as Parameters<typeof monthlyLosses>[0], minutes);
        }
      } catch { /* Missing legacy evidence makes this contribution unknown. */ }
    }
  }
  if (!parts.length) throw new SourceUnavailable('A Confirmed finding has unavailable event dates; monthly loss cannot be allocated.');
  return parts;
}

async function aggregate(payload:Payload, source:ReturnType<typeof selection>, reviews:Awaited<ReturnType<typeof effectiveReviews>>):Promise<MonthlyConfirmedLoss> {
  const timezone = payload.timeZone || payload.summary?.timezone || payload.methodology?.timezone || source.input?.timezone;
  try {if (typeof timezone !== 'string' || !timezone) throw Error(); new Intl.DateTimeFormat('en', {timeZone:timezone}).format(0);}
  catch {throw new SourceUnavailable('The saved analysis reporting timezone is unavailable.');}
  const minutes = payload.analysis.analysisIntervalMinutes || payload.summary?.intervalMinutes || payload.methodology?.intervalMinutes || payload.validation?.intervalMinutes;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) throw new SourceUnavailable('The saved analysis interval cadence is unavailable.');
  const months:Record<string, MonthlyConfirmedLossMetric> = Object.fromEntries(coverage(payload, source, timezone, minutes).map(month =>
    [month, {value:fraction('0'), state:'complete', confirmedCount:0, unknownCount:0, reason:null}]));
  const byKey = new Map(reviews.map(review => [review.eventKey, review])), seen = new Map<string, string>();
  for (const issue of payload.analysis.issues) {
    if (!issue || typeof issue.id !== 'string' || !issue.id || typeof issue.eventKey !== 'string' || !issue.eventKey)
      throw new SourceUnavailable('The saved analysis contains an unavailable finding identity.');
    const identity = JSON.stringify(issue);
    if (seen.has(issue.id)) {
      if (seen.get(issue.id) !== identity) throw new SourceUnavailable('The saved analysis contains conflicting finding identities.');
      continue;
    }
    seen.set(issue.id, identity);
    if (!isIssueVisible(issue, defaultIssueVisibility) || effectiveReviewStatus(issue, byKey.get(issue.eventKey)) !== 'Confirmed') continue;
    for (const part of await issueMonths(issue, source, timezone, minutes)) {
      const month = siteWallTime(part.startDateTime, timezone).slice(0, 7), target = months[month];
      if (!target) continue; // No fabricated coverage outside the saved analyzed domain.
      target.confirmedCount++;
      if (part.estimatedLossKwh === null || !Number.isFinite(part.estimatedLossKwh) || part.estimatedLossKwh < 0) {
        target.unknownCount++; target.value = null; target.state = 'partial';
        target.reason = 'At least one Confirmed finding has unknown estimated loss or unavailable monthly interval allocation. No known subtotal is shown.';
      } else if (target.value !== null) target.value = add(target.value, numericFraction(part.estimatedLossKwh));
    }
  }
  return {state:'current', analysisRunId:source.run!.id, timezone, months, reason:null};
}

/** Fresh read-only composition; never persisted in the telemetry/monthly cache. */
export async function readMonthlyConfirmedLoss(siteId:string):Promise<MonthlyConfirmedLoss> {
  try {
    const db = getDatabaseBinding();
    if (!db.withSynchronousRead) throw new SourceUnavailable('A consistent read of the current published analysis is unavailable.');
    for (let attempt = 0; attempt < 2; attempt++) {
      const source = db.withSynchronousRead((read:SynchronousDatabaseReader) => selection(read, siteId));
      if (!source.row) return absent('missing', 'No current published analysis is available for this site.');
      let keys:string[] = [], versions:string|undefined, result:MonthlyConfirmedLoss;
      try {
        if (!await publishedAnalysisAvailable(db, siteId, source.row.import_id, source.pointer) || !source.run)
          throw new SourceUnavailable('The current published analysis is unavailable. No historical analysis is substituted.');
        const payload = await savedAnalysis(siteId, source.run.id);
        assertPayload(payload, siteId, source);
        // Include parents and absent direct children: a new explicit Unreviewed
        // exception is just as important as changing an existing confirmation.
        keys = [...new Set<string>([...payload.analysis.issues, ...(payload.analysis.recurringIssues || [])].map(issue => issue.eventKey))].sort();
        versions = db.withSynchronousRead((read:SynchronousDatabaseReader) => reviewVersions(read, siteId, keys));
        const reviews = await effectiveReviews(db, siteId, source.run.id, payload, payload.analysis.issues.map((issue:Payload) => issue.eventKey));
        result = await aggregate(payload, source, reviews);
      } catch (error) {
        result = absent('unavailable', error instanceof SourceUnavailable ? error.message : 'The current published analysis or its reviews could not be read.', source.run?.id || null);
      }
      // One non-yielding final snapshot fences the selected pointer, run status,
      // current input and all relevant review versions after every async read.
      const stable = db.withSynchronousRead((read:SynchronousDatabaseReader) => selection(read, siteId).signature === source.signature &&
        (versions === undefined || reviewVersions(read, siteId, keys) === versions));
      if (stable) return result;
    }
    return absent('refreshing', 'The current publication or reviews changed during this read. Refreshing confirmed estimated loss.');
  } catch {
    // Derived-source failure must not block unrelated utility/configuration saves.
    return absent('unavailable', 'The current published analysis or its reviews could not be read.');
  }
}
