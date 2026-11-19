"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EquipmentAsset } from "./equipment";
import { suggestSignal } from "./telemetry-csv";
import type { PerformanceCommit, PerformanceDataset, PerformanceImportAudit, PerformancePreview } from "../db/performance-store";
import type { VcomAction, VcomAuthMode, VcomManualJob, VcomMapping, VcomSettingsPublic, VcomSource, VcomWorkspace as Workspace } from "./manual-vcom-types";

export type VcomTab = "data" | "setup" | "mapping" | "activity";
export type VcomVerifiedData = { dataset: PerformanceDataset; imports: PerformanceImportAudit[]; requiresMigration: boolean };
type Props = {
  siteId: string; activeTab: VcomTab; equipment: EquipmentAsset[]; equipmentLoading: boolean;
  dataset: PerformanceDataset | null; datasetLoading: boolean; datasetError: string; requiresMigration: boolean;
  refreshRevision: number; imports: PerformanceImportAudit[]; csvBusy: boolean; csvFileName: string | null;
  onChooseCsv: () => void; onSelectTab: (tab: VcomTab) => void; onTimezone: (siteId: string, timezone: string) => void;
  onVerifiedImport: (data: VcomVerifiedData, job: VcomManualJob) => void; notify: (message: string) => void;
  isSiteCurrent?: (siteId: string) => boolean;
};
type Uncertain = { action: "start"; requestId: string; generation: number; fromDate: string; throughDate: string } | { action: "apply"; jobId: string; stageId: string } | { action: "retry" | "cancel"; jobId: string };
const activeStatuses = new Set(["queued", "downloading", "staging"]);
const savedCredentialPlaceholder = "••••••••";
const countLabels = [["added", "Added"], ["overlapping", "Overlapping"], ["changed", "Changed"], ["identical", "Identical"], ["blankPreserved", "Blank/null preserved"]] as const;
const statusLabels: Record<VcomManualJob["status"], string> = { queued: "Queued", downloading: "Downloading", staging: "Preparing preview", awaiting_approval: "Awaiting approval", committed: "Applied", failed: "Failed", canceled: "Canceled" };

function calendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}
function shiftDate(value: string, days: number) {
  const date = calendarDate(value)!;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function localToday(timezone: string, now = new Date()) {
  if (!timezone) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (name: string) => parts.find(p => p.type === name)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch { return ""; }
}
export function defaultVcomRange(timezone: string, now = new Date()) {
  const today = localToday(timezone, now);
  return today ? { fromDate: shiftDate(today, -7), throughDate: shiftDate(today, -1) } : null;
}
export function vcomRangeIssue(from: string, through: string, today: string) {
  const start = calendarDate(from), end = calendarDate(through);
  if (!start || !end) return "Choose valid From and Through dates.";
  if (!today) return "Test the saved connection to establish the site's timezone.";
  if (from > through) return "From must be on or before Through.";
  if (through > today) return "Dates cannot be later than today in the site's timezone.";
  const year = start.getUTCFullYear() + 1, month = start.getUTCMonth();
  const anniversary = new Date(Date.UTC(year, month, Math.min(start.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate())));
  if (shiftDate(through, 1) > anniversary.toISOString().slice(0, 10)) return "Choose at most one calendar year, including both dates.";
  return "";
}
function stamp(value: string | null, timezone?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not available";
  try { return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", ...(timezone ? { timeZone: timezone } : {}) }).format(new Date(value)); }
  catch { return value; }
}
async function jsonResponse(response: Response) {
  let data;
  try { data = await response.json(); } catch { throw new Error("The server returned an unreadable response."); }
  if (!response.ok) throw Object.assign(new Error(typeof data?.error === "string" ? data.error : `Request failed (${response.status}).`), { status: response.status });
  return data;
}
function destinations(source: VcomSource, equipment: EquipmentAsset[]) {
  const type = source.kind === "irradiance" ? "weather_sensor" : source.kind === "inverter" ? "inverter" : "revenue_meter";
  return equipment.filter(asset => asset.type === type);
}
function mappingSuggestion(source: VcomSource, equipment: EquipmentAsset[]) {
  return source.kind === "simulation"
    ? { equipmentId: "@site", confidence: "high" as const, reason: "Fixed site destination for Expected Production" }
    : suggestSignal(source.name, destinations(source, equipment));
}
function mappingDefaults(settings: VcomSettingsPublic, equipment: EquipmentAsset[]): VcomMapping[] {
  return settings.discovery?.sources.map(source => {
    const saved = settings.mappings.find(m => m.sourceId === source.id);
    return saved?.excluded === true
      ? { sourceId: source.id, equipmentId: "", measurement: source.measurement, excluded: true }
      : { sourceId: source.id, equipmentId: saved ? saved.equipmentId : mappingSuggestion(source, equipment).equipmentId, measurement: source.measurement };
  }) || [];
}
function irradianceExcluded(settings: VcomSettingsPublic | undefined, draft: VcomMapping[]) {
  return !!settings?.discovery?.sources.some(source => source.kind === "irradiance" && draft.some(m => m.sourceId === source.id && m.excluded === true));
}
function mappingsIssue(settings: VcomSettingsPublic | undefined, draft: VcomMapping[], equipment: EquipmentAsset[], poa: string | null) {
  if (!settings?.discovery) return "Test the saved connection before mapping fields.";
  if (draft.length !== settings.discovery.sources.length || new Set(draft.map(m => m.sourceId)).size !== draft.length) return "Include or exclude every discovered source exactly once.";
  const seen = new Set<string>();
  for (const source of settings.discovery.sources) {
    const mapping = draft.find(item => item.sourceId === source.id);
    if (!mapping || mapping.measurement !== source.measurement) return "Include or exclude every source with its fixed measurement.";
    if (mapping.excluded === true) {
      if (mapping.equipmentId !== "") return "Excluded sources must not have a destination.";
      continue;
    }
    if (!source.eligible) return "Exclude unsupported sources before saving the field mappings.";
    if (!mapping.equipmentId) return "Assign every included source to its appropriate destination, or exclude it.";
    if (source.kind === "simulation" ? mapping.equipmentId !== "@site" : !destinations(source, equipment).some(asset => asset.id === mapping.equipmentId)) return "A mapped destination is no longer available or has the wrong equipment type.";
    const key = JSON.stringify([mapping.equipmentId, mapping.measurement]);
    if (seen.has(key)) return "Each source needs a distinct equipment and measurement destination.";
    seen.add(key);
  }
  if (poa !== null && irradianceExcluded(settings, draft)) return "Exclude irradiance without a POA fallback.";
  if (poa !== null && !settings.discovery.poaSensors.some(source => source.id === poa && source.eligible)) return "Choose an eligible POA fallback, or explicitly choose no fallback.";
  return "";
}
function validPreview(job: VcomManualJob | undefined, siteId: string) {
  const p = job?.preview;
  return !!(p && job?.stageId === p.stageId && p.siteId === siteId && p.status === "preview" && p.stageId && p.previewToken && Number.isSafeInteger(p.baseRevision) && p.baseRevision >= 0 && p.counts && countLabels.every(([key]) => Number.isSafeInteger(p.counts[key]) && p.counts[key] >= 0) && Array.isArray(p.samples));
}
function expiredPreview(job: VcomManualJob | undefined) {
  return job?.status === "awaiting_approval" && (!job.preview || !Number.isFinite(Date.parse(job.preview.expiresAt)) || Date.parse(job.preview.expiresAt) <= Date.now());
}
function canRetry(job: VcomManualJob) { return job.status === "failed" || expiredPreview(job); }
function sameReceipt(a: PerformanceCommit | undefined | null, b: PerformanceCommit | undefined | null) {
  return !!(a && b && a.siteId === b.siteId && a.stageId === b.stageId && a.revision === b.revision && a.revisionId === b.revisionId && a.committedAt === b.committedAt && countLabels.every(([key]) => Number.isSafeInteger(a.counts?.[key]) && a.counts[key] >= 0 && a.counts[key] === b.counts?.[key]));
}
function canonicalMappings(mappings: VcomMapping[]) {
  return JSON.stringify([...mappings].sort((a, b) => a.sourceId.localeCompare(b.sourceId)).map(m => [m.sourceId, m.equipmentId, m.measurement, m.excluded === true]));
}

export default function VcomWorkspace(props: Props) {
  const { siteId, activeTab, equipment, equipmentLoading, refreshRevision } = props;
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [systemKey, setSystemKey] = useState("");
  const [authMode, setAuthMode] = useState<VcomAuthMode>("basic");
  const [apiKey, setApiKey] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [configGeneration, setConfigGeneration] = useState(-1);
  const [mappingGeneration, setMappingGeneration] = useState(-1);
  const [mappingDraft, setMappingDraft] = useState<VcomMapping[]>([]);
  const manualMappings = useRef(new Set<string>());
  const [selectedPoaSourceId, setSelectedPoaSourceId] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [throughDate, setThroughDate] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [approveOverlap, setApproveOverlap] = useState(false);
  const [approvalIdentity, setApprovalIdentity] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState<Uncertain | null>(null);
  const [pollError, setPollError] = useState(false);
  const alive = useRef(true), currentSite = useRef(siteId), sequence = useRef(0), operationBusy = useRef(false), queuedRefresh = useRef(false);
  const readController = useRef<AbortController | null>(null), verifiedReceipts = useRef(new Set<string>());
  const latestProps = useRef(props), defaultsInitialized = useRef(false);
  const isCurrent = useCallback(() => alive.current && currentSite.current === siteId && latestProps.current.isSiteCurrent?.(siteId) !== false, [siteId]);
  const settings = workspace?.settings;
  const timezone = settings?.discovery?.timezone || "";
  const today = localToday(timezone);
  const selectedJob = (workspace?.job?.id === selectedJobId ? workspace.job : workspace?.jobs.find(job => job.id === selectedJobId)) || workspace?.job || workspace?.jobs[0];
  const activeJob = workspace?.jobs.find(job => activeStatuses.has(job.status));
  const unfinished = workspace?.jobs.some(job => activeStatuses.has(job.status) || job.status === "awaiting_approval");
  const hasSecretDraft = !!(apiKey || username || password || accessToken);
  const credentialPlaceholder = settings?.hasCredentials && authMode === settings.authMode ? savedCredentialPlaceholder : undefined;
  const unsavedConfiguration = !!settings && (systemKey !== settings.systemKey || authMode !== settings.authMode || hasSecretDraft);
  const unsavedMappings = !!settings?.discovery && (canonicalMappings(mappingDraft) !== canonicalMappings(settings.mappings) || selectedPoaSourceId !== (settings.selectedPoaSourceId ?? null));
  const excludeIrradiance = irradianceExcluded(settings, mappingDraft);
  const noIncludedSources = !!settings?.discovery?.sources.length && settings.discovery.sources.every(source => mappingDraft.some(m => m.sourceId === source.id && m.excluded === true));
  const rangeIssue = vcomRangeIssue(fromDate, throughDate, today);
  const mappingIssue = mappingsIssue(settings, mappingDraft, equipment, selectedPoaSourceId);
  const datasetBlocked = props.datasetLoading || !!props.datasetError || props.requiresMigration || !props.dataset || props.dataset.siteId !== siteId;
  const startDisabled = loading || !!busy || !!uncertain || !settings?.ready || unsavedMappings || noIncludedSources || !!unfinished || datasetBlocked || !!rangeIssue;
  const preview = validPreview(selectedJob, siteId) ? selectedJob!.preview : null;
  const previewIdentity = preview && selectedJob ? JSON.stringify([siteId, selectedJob.id, preview.stageId, preview.previewToken, preview.baseRevision, settings?.generation]) : null;
  const approvedOverlap = approveOverlap && approvalIdentity !== null && approvalIdentity === previewIdentity;
  const staleJob = !!selectedJob && selectedJob.generation !== settings?.generation;
  const applyDisabled = !!busy || !!uncertain || !preview || selectedJob?.status !== "awaiting_approval" || expiredPreview(selectedJob) || staleJob || datasetBlocked || (preview.counts.overlapping > 0 && !approvedOverlap);

  const resetDrafts = useCallback((saved: VcomSettingsPublic) => {
    setSystemKey(saved.systemKey); setAuthMode(saved.authMode); setConfigGeneration(saved.generation); setMappingGeneration(saved.generation);
    const defaults = mappingDefaults(saved, latestProps.current.equipment);
    setMappingDraft(defaults); manualMappings.current.clear(); setSelectedPoaSourceId(irradianceExcluded(saved, defaults) ? null : saved.selectedPoaSourceId ?? null);
    setApproveOverlap(false); setApprovalIdentity(null);
  }, []);
  const install = useCallback((saved: Workspace, reset = false) => {
    if (!isCurrent()) return;
    setWorkspace(saved); setLoading(false);
    if (reset) resetDrafts(saved.settings);
    const zone = saved.settings.discovery?.timezone;
    if (zone) {
      latestProps.current.onTimezone(siteId, zone);
      if (!defaultsInitialized.current) {
        const range = defaultVcomRange(zone);
        if (range) { defaultsInitialized.current = true; setFromDate(current => current || range.fromDate); setThroughDate(current => current || range.throughDate); }
      }
    }
  }, [isCurrent, resetDrafts, siteId]);
  const readWorkspace = useCallback(async (jobId?: string, signal?: AbortSignal) => {
    const data = await jsonResponse(await fetch(`/api/manual-vcom?siteId=${encodeURIComponent(siteId)}${jobId ? `&jobId=${encodeURIComponent(jobId)}` : ""}`, { cache: "no-store", signal })) as Workspace;
    if (!data.settings || data.settings.siteId !== siteId || !Number.isSafeInteger(data.settings.generation) || !Array.isArray(data.jobs) || data.jobs.some(job => job.siteId !== siteId) || (jobId && (!data.job || data.job.id !== jobId || data.job.siteId !== siteId))) throw new Error("The workspace response does not match this site or requested job.");
    return data;
  }, [siteId]);
  const refresh = useCallback((reset = true) => {
    if (operationBusy.current) { queuedRefresh.current = true; return; }
    const ticket = ++sequence.current;
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    return readWorkspace(undefined, controller.signal)
      .then(saved => { if (isCurrent() && ticket === sequence.current) { setError(""); setPollError(false); install(saved, reset); } })
      .catch(reason => { if (isCurrent() && ticket === sequence.current && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load the VCOM connection."); })
      .finally(() => { if (isCurrent() && ticket === sequence.current) setLoading(false); });
  }, [install, isCurrent, readWorkspace]);
  useEffect(() => { latestProps.current = props; }, [props]);
  useEffect(() => {
    alive.current = true; currentSite.current = siteId;
    return () => { alive.current = false; readController.current?.abort(); };
  }, [siteId]);
  // External CSV commits must also refresh configuration/history.
  useEffect(() => { void refresh(); }, [refresh, refreshRevision]);
  // Equipment can arrive after discovery. Only untouched, unsaved suggestions
  // follow that inventory; saved choices and deliberate blanks stay untouched.
  useEffect(() => {
    if (!settings?.discovery || equipmentLoading || mappingGeneration !== settings.generation) return;
    setMappingDraft(current => {
      let changed = false;
      const next = current.map(mapping => {
        if (mapping.excluded === true || manualMappings.current.has(mapping.sourceId) || settings.mappings.some(m => m.sourceId === mapping.sourceId)) return mapping;
        const source = settings.discovery!.sources.find(s => s.id === mapping.sourceId);
        if (!source) return mapping;
        const equipmentId = mappingSuggestion(source, equipment).equipmentId;
        if (equipmentId === mapping.equipmentId) return mapping;
        changed = true;
        return { ...mapping, equipmentId };
      });
      return changed ? next : current;
    });
  }, [equipment, equipmentLoading, settings, mappingGeneration]);
  useEffect(() => {
    if (!activeJob || busy || pollError) return;
    const controller = new AbortController(), ticket = sequence.current;
    const retryDelay = activeJob.nextAttemptAt ? Date.parse(activeJob.nextAttemptAt) - Date.now() : 0;
    const timer = setTimeout(async () => {
      try { const saved = await readWorkspace(activeJob.id, controller.signal); if (!controller.signal.aborted && isCurrent() && ticket === sequence.current && !operationBusy.current) install(saved); }
      catch (reason) { if (!controller.signal.aborted && isCurrent() && ticket === sequence.current) { setPollError(true); setError(reason instanceof Error ? reason.message : "Progress could not be refreshed. Check job status to continue."); } }
    }, Math.max(2000, Math.min(30000, Number.isFinite(retryDelay) ? retryDelay : 0)));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [activeJob, busy, pollError, install, isCurrent, readWorkspace]);

  async function verifyCommit(job: VcomManualJob, stageId: string) {
    const receipt = job.result;
    if (job.siteId !== siteId || job.stageId !== stageId || job.status !== "committed" || !receipt || receipt.siteId !== siteId || receipt.stageId !== stageId || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || !receipt.revisionId) throw new Error("The job's exact stage receipt could not be verified.");
    const stageData = await jsonResponse(await fetch(`/api/performance-data?siteId=${encodeURIComponent(siteId)}&stageId=${encodeURIComponent(stageId)}`, { cache: "no-store" }));
    if (!isCurrent()) return;
    const stage = stageData.preview as PerformancePreview | undefined;
    if (!stage || stage.siteId !== siteId || stage.stageId !== stageId || stage.status !== "committed" || stage.metadata?.sourceImportId !== `vcom:${job.id}` || !sameReceipt(stage.result, receipt)) throw new Error("The committed stage receipt does not match this job.");
    const data = await jsonResponse(await fetch(`/api/performance-data?siteId=${encodeURIComponent(siteId)}`, { cache: "no-store" }));
    if (!isCurrent()) return;
    const dataset = data.dataset as PerformanceDataset | undefined;
    if (!dataset || dataset.siteId !== siteId || !Number.isSafeInteger(dataset.revision) || dataset.revision < receipt.revision || (dataset.revision === receipt.revision && dataset.revisionId !== receipt.revisionId) || !Array.isArray(data.imports)) throw new Error("The commit is recorded, but the cumulative dataset and import history could not be verified.");
    setUncertain(null); setApproveOverlap(false); setError("");
    const identity = `${receipt.stageId}:${receipt.revisionId}`;
    if (!verifiedReceipts.current.has(identity)) {
      verifiedReceipts.current.add(identity);
      props.onVerifiedImport({ dataset, imports: data.imports, requiresMigration: Boolean(data.requiresMigration) }, job);
      props.notify(`VCOM performance data applied and verified at revision ${receipt.revision}. Analysis remains manual.`);
    }
  }
  async function reconcile(intent: Uncertain, saved: Workspace) {
    let job = intent.action === "start" ? saved.jobs.find(j => j.requestId === intent.requestId) : saved.job;
    if (!job || job.siteId !== siteId || (intent.action !== "start" && job.id !== intent.jobId)) throw new Error("The exact request was not found. Check request status again; do not create a replacement download.");
    if (!saved.job || saved.job.id !== job.id) { saved = await readWorkspace(job.id); job = saved.job!; }
    if (!isCurrent()) return;
    if (intent.action === "start" && (job.requestId !== intent.requestId || job.generation !== intent.generation || job.fromDate !== intent.fromDate || job.throughDate !== intent.throughDate)) throw new Error("The saved request does not match the requested dates and configuration. Check request status before starting another download.");
    install(saved); setSelectedJobId(job.id); setPollError(false);
    if (intent.action === "apply") {
      if (job.stageId !== intent.stageId) throw new Error("The job's stage changed. The original Apply outcome still needs verification.");
      if (job.status === "committed") await verifyCommit(job, intent.stageId);
      else { setUncertain(null); setApproveOverlap(false); setError("Apply is not recorded for this stage. Review its current status and explicitly approve again before retrying."); }
    } else if (intent.action === "cancel" && job.status !== "canceled") {
      if (job.status === "committed" && job.stageId) await verifyCommit(job, job.stageId);
      else throw new Error("Cancellation is not confirmed. Check request status before taking another action.");
    } else { setUncertain(null); setMessage(intent.action === "start" ? "Download requested. Review the staged readings before Apply." : intent.action === "cancel" ? "Download cancellation verified." : "Download status refreshed."); }
  }
  async function mutate(action: VcomAction) {
    if (!isCurrent() || operationBusy.current || uncertain) return;
    operationBusy.current = true; sequence.current++; readController.current?.abort(); setBusy(action.action); setError(""); setMessage(""); setPollError(false);
    const intent: Uncertain | null = action.action === "start" ? { action: "start", requestId: action.requestId, generation: action.expectedGeneration, fromDate: action.fromDate, throughDate: action.throughDate } : action.action === "apply" ? { action: "apply", jobId: action.jobId, stageId: action.stageId } : action.action === "cancel" || action.action === "retry" ? { action: action.action, jobId: action.jobId } : null;
    if (intent) setUncertain(intent);
    if (action.action === "configure") { setApiKey(""); setUsername(""); setPassword(""); setAccessToken(""); }
    try {
      let acknowledgement: Workspace | undefined, failure: unknown;
      try { acknowledgement = await jsonResponse(await fetch("/api/manual-vcom", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) })); }
      catch (reason) { failure = reason; }
      if (!isCurrent()) return;
      const jobId = intent && intent.action !== "start" ? intent.jobId : action.action === "start" && acknowledgement?.job?.requestId === action.requestId ? acknowledgement.job.id : undefined;
      const saved = await readWorkspace(jobId);
      if (!isCurrent()) return;
      install(saved);
      if (intent) {
        // A rejected start has no new identity to recover. Unknown transport outcomes stay fenced.
        if (intent.action === "start" && failure && [400,401,403,409,422].includes((failure as { status?: number }).status || 0) && !saved.jobs.some(j => j.requestId === intent.requestId)) { setUncertain(null); throw failure; }
        await reconcile(intent, saved);
      } else {
        if (failure && (failure as { status?: number }).status) throw failure;
        if (!("expectedGeneration" in action) || saved.settings.generation <= action.expectedGeneration) throw failure || new Error("The settings change was not verified. Refresh the connection before trying again.");
        if (action.action === "configure" && (saved.settings.systemKey !== action.systemKey || (action.credentials && (!saved.settings.hasCredentials || saved.settings.authMode !== action.credentials.mode)))) throw new Error("The saved configuration does not match the requested change.");
        if (action.action === "discover" && (!saved.settings.discovery || saved.settings.discovery.systemKey !== saved.settings.systemKey)) throw new Error("Connection discovery was not verified.");
        if (action.action === "mappings" && (canonicalMappings(saved.settings.mappings) !== canonicalMappings(action.mappings) || (saved.settings.selectedPoaSourceId ?? null) !== action.selectedPoaSourceId)) throw new Error("The saved mappings do not match the requested change.");
        resetDrafts(saved.settings); setApproveOverlap(false);
        setMessage(action.action === "configure" ? "Configuration saved. Test the saved connection to discover sources." : action.action === "discover" ? "Connection tested. Review and save the discovered field mappings." : "Field mappings saved and read back.");
      }
    } catch (reason) {
      if (isCurrent()) setError(`${reason instanceof Error ? reason.message : "The request could not be verified."}${intent ? " If the outcome is uncertain, check request status. No write will be replayed automatically." : ""}`);
    } finally {
      if (isCurrent()) { operationBusy.current = false; setBusy(""); if (queuedRefresh.current) { queuedRefresh.current = false; void refresh(false); } }
    }
  }
  async function checkRequestStatus(jobId?: string) {
    if (!isCurrent() || operationBusy.current) return;
    operationBusy.current = true; sequence.current++; setBusy("checking"); setError("");
    try {
      const requestedId = uncertain && uncertain.action !== "start" ? uncertain.jobId : jobId;
      const saved = await readWorkspace(requestedId);
      if (!isCurrent()) return;
      if (uncertain) await reconcile(uncertain, saved);
      else { install(saved); setPollError(false); if (jobId) { setSelectedJobId(jobId); setApproveOverlap(false); } }
    } catch (reason) { if (isCurrent()) setError(reason instanceof Error ? reason.message : "Unable to verify the request."); }
    finally { if (isCurrent()) { operationBusy.current = false; setBusy(""); if (queuedRefresh.current) { queuedRefresh.current = false; void refresh(false); } } }
  }
  function saveConfiguration() {
    if (!settings || busy || uncertain || !systemKey || configGeneration !== settings.generation) return;
    if (hasSecretDraft || authMode !== settings.authMode || !settings.hasCredentials) {
      if (!apiKey || (authMode === "basic" ? !username || !password : !accessToken)) { setError("Enter a complete replacement credential set, or leave every credential field blank to keep the saved credentials."); return; }
      return mutate({ action: "configure", siteId, expectedGeneration: configGeneration, systemKey, credentials: authMode === "basic" ? { mode: "basic", apiKey, username, password } : { mode: "bearer", apiKey, accessToken } });
    } else return mutate({ action: "configure", siteId, expectedGeneration: configGeneration, systemKey });
  }
  function discover() { if (settings?.hasCredentials && !unsavedConfiguration && !busy && !uncertain) return mutate({ action: "discover", siteId, expectedGeneration: settings.generation }); }
  function saveMappings() {
    if (settings && !mappingIssue && !equipmentLoading && mappingGeneration === settings.generation && !busy && !uncertain) {
      const mappings = mappingDraft.map(m => ({ sourceId: m.sourceId, equipmentId: m.equipmentId, measurement: m.measurement, ...(m.excluded === true ? { excluded: true } : {}) }));
      return mutate({ action: "mappings", siteId, expectedGeneration: mappingGeneration, mappings, selectedPoaSourceId });
    }
  }
  function setSourceIncluded(source: VcomSource, included: boolean) {
    if (!isCurrent() || operationBusy.current || uncertain) return;
    manualMappings.current.add(source.id);
    setMappingDraft(current => {
      const previous = current.find(m => m.sourceId === source.id);
      const mapping: VcomMapping = { sourceId: source.id, measurement: source.measurement, equipmentId: included ? previous?.equipmentId || mappingSuggestion(source, equipment).equipmentId : "", ...(!included ? { excluded: true } : {}) };
      return previous ? current.map(m => m.sourceId === source.id ? mapping : m) : [...current, mapping];
    });
    if (!included && source.kind === "irradiance") setSelectedPoaSourceId(null);
  }
  function setDestination(source: VcomSource, equipmentId: string) {
    if (!isCurrent() || operationBusy.current || uncertain || equipmentLoading || !source.eligible || mappingDraft.some(m => m.sourceId === source.id && m.excluded === true)) return;
    manualMappings.current.add(source.id);
    setMappingDraft(current => current.map(m => m.sourceId === source.id ? { sourceId: source.id, equipmentId, measurement: source.measurement } : m));
  }
  function start() {
    if (startDisabled || !settings || operationBusy.current) return;
    return mutate({ action: "start", siteId, expectedGeneration: settings.generation, requestId: crypto.randomUUID(), fromDate, throughDate });
  }
  function apply() {
    if (applyDisabled || !selectedJob || !preview || operationBusy.current) return;
    if (expiredPreview(selectedJob)) { setError("This preview has expired. Retry the same download to prepare a fresh preview from retained chunks."); return; }
    return mutate({ action: "apply", siteId, jobId: selectedJob.id, stageId: preview.stageId, previewToken: preview.previewToken, approveOverlap: approvedOverlap });
  }
  function jobAction(action: "retry" | "cancel", job: VcomManualJob) {
    if (job.siteId !== siteId || busy || uncertain || job.status === "committed" || job.status === "canceled" || (action === "retry" && (!canRetry(job) || job.generation !== settings?.generation))) return;
    return mutate({ action, siteId, jobId: job.id });
  }

  return <div className="vcom-workspace">
    {loading && <p className="vcom-notice" role="status">Loading VCOM connection…</p>}
    <div role="status" aria-live="polite" aria-atomic={true}>{busy === "discover" && <p className="vcom-notice">Testing connection… Waiting for saved-source discovery and verification.</p>}</div>
    {error && <div className="vcom-notice vcom-error" role="alert">{error}</div>}
    {message && <p className="vcom-notice" role="status">{message}</p>}
    {(error || uncertain) && <div className="vcom-actions vcom-recovery">{uncertain ? <button className="secondary-btn" disabled={!!busy} onClick={() => checkRequestStatus()}>Check request status</button> : <button className="secondary-btn" disabled={!!busy} onClick={() => refresh()}>Refresh connection</button>}</div>}

    <div hidden={activeTab !== "data"}>
      <div className="vcom-source-grid">
        <section className="vcom-card" aria-labelledby="vcom-download-title">
          <header className="vcom-card-head"><h2 id="vcom-download-title">Download from API</h2><span className="vcom-badge">VCOM</span></header>
          <div className="vcom-card-body">
            <div className="vcom-date-fields"><label>From<input aria-label="API From date" type="date" value={fromDate} max={throughDate && throughDate < today ? throughDate : today || undefined} disabled={!!busy || !!uncertain || !timezone} onChange={event => setFromDate(event.target.value)} /></label><label>Through<input aria-label="API Through date" type="date" value={throughDate} min={fromDate || undefined} max={today || undefined} disabled={!!busy || !!uncertain || !timezone} onChange={event => setThroughDate(event.target.value)} /></label></div>
            <div className="vcom-download-actions"><p>Up to 1 calendar year. Both dates included.<br />Review first; Apply and analysis are manual.</p><button className="primary-btn" disabled={startDisabled} onClick={start}>{busy === "start" ? "Requesting…" : "Download range"}</button></div>
            {!loading && (!settings?.ready || unsavedMappings || noIncludedSources) && <p className="vcom-help">{noIncludedSources ? "No sources included. Include and save at least one source before downloading." : settings?.discovery ? "Review and save field mapping before downloading." : "Save configuration and test the connection before downloading."} <button className="vcom-text-button" onClick={() => props.onSelectTab(settings?.discovery ? "mapping" : "setup")}>{settings?.discovery ? "Open field mapping" : "Open API setup"}</button></p>}
            {settings?.ready && rangeIssue && <p className="vcom-help">{rangeIssue}</p>}
            {props.requiresMigration && <p className="vcom-help">Apply the retained-file migration before an API download.</p>}
            <p className="vcom-help">Downloads run on the server. You can close this page and return to review.</p>
          </div>
        </section>
        <section className="vcom-card" aria-labelledby="vcom-csv-title"><header className="vcom-card-head"><h2 id="vcom-csv-title">Upload CSV</h2><span className="vcom-help">Manual source</span></header><div className="vcom-card-body"><div className="vcom-csv-prompt"><strong>{props.csvFileName || "Choose a performance CSV"}</strong><p>Map fields, validate, then review before applying.<br />Existing CSV mappings and units are preserved.</p></div><button className="secondary-btn vcom-full" disabled={props.csvBusy} onClick={props.onChooseCsv}>{props.csvFileName ? "Review CSV upload" : "Choose file"}</button></div></section>
      </div>
      {selectedJob && <section className="vcom-card vcom-job-review" aria-labelledby="vcom-review-title">
        <header className="vcom-card-head"><h2 id="vcom-review-title">{selectedJob.status === "awaiting_approval" ? "Review API import" : "Latest API download"}</h2><span className="vcom-badge">{statusLabels[selectedJob.status]}</span></header>
        <div className="vcom-card-body"><p>{selectedJob.fromDate} to {selectedJob.throughDate} · {selectedJob.completedRequests} / {selectedJob.totalRequests} requests</p><p>{selectedJob.message}</p>{selectedJob.nextAttemptAt && <p>Next attempt: {stamp(selectedJob.nextAttemptAt, timezone)}</p>}
          {staleJob && selectedJob.status !== "committed" && <p className="vcom-warning">Configuration has changed since this download. Its previous approval cannot be used. Check status or cancel before requesting a new download.</p>}
          {selectedJob.quality && <div className="vcom-quality"><h3>Download quality</h3><dl className="vcom-quality-counts"><div><dt>Missing readings</dt><dd>{selectedJob.quality.missingReadings}</dd></div><div><dt>Partial simulation hours</dt><dd>{selectedJob.quality.partialSimulationHours}</dd></div><div><dt>Missing simulation hours</dt><dd>{selectedJob.quality.missingSimulationHours}</dd></div><div><dt>Satellite gaps</dt><dd>{selectedJob.quality.satelliteGaps}</dd></div><div><dt>POA-filled hours</dt><dd>{selectedJob.quality.poaFilled}</dd></div><div><dt>Remaining irradiance gaps</dt><dd>{selectedJob.quality.remainingIrradianceGaps}</dd></div></dl><p>Partial simulation sums are retained unscaled, not estimated as full-hour production. Review missing and partial coverage before Apply.</p>{selectedJob.quality.warnings.map((warning, index) => <p className="vcom-warning" key={index}>{warning}</p>)}</div>}
          {preview && <><p>Based on dataset revision {preview.baseRevision}. No readings are applied until you choose Apply. Omitted timestamps and channels and blank/null values preserve saved readings.</p><dl className="import-preview-counts">{countLabels.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{preview.counts[key].toLocaleString()}</dd></div>)}</dl>
            {!!preview.samples.length && <div className="vcom-table-wrap"><table><thead><tr><th>Timestamp</th><th>Equipment / channel</th><th>Saved</th><th>Incoming</th></tr></thead><tbody>{preview.samples.map((sample, index) => <tr key={index}><td>{sample.timestamp}</td><td>{sample.channel.equipmentId} / {sample.channel.measurement}</td><td>{sample.previous ?? "Blank"}</td><td>{sample.incoming ?? "Blank (preserved)"}</td></tr>)}</tbody></table></div>}
            {preview.counts.overlapping > 0 && <div className="overlap-approval"><p><strong>All overlaps require approval, including identical values.</strong></p><label><input aria-label="Approve API overlap" type="checkbox" checked={approvedOverlap} disabled={!!busy || !!uncertain || staleJob || expiredPreview(selectedJob)} onChange={event => { setApproveOverlap(event.target.checked); setApprovalIdentity(event.target.checked ? previewIdentity : null); }} />I approve these overlapping readings for this exact staged import at revision {preview.baseRevision}.</label></div>}
          </>}
          {selectedJob.status === "awaiting_approval" && !preview && <p className="vcom-warning">A valid staged preview is unavailable. Check job status before applying.</p>}
          {expiredPreview(selectedJob) && <p className="vcom-warning">This preview has expired or is unavailable. Retry download to prepare a new preview from the same retained chunks. Review it and approve any overlap again.</p>}
          <div className="vcom-actions"><button className="secondary-btn" disabled={!!busy} onClick={() => checkRequestStatus(selectedJob.id)}>Check job status</button>{canRetry(selectedJob) && <button className="secondary-btn" disabled={!!busy || !!uncertain || staleJob} onClick={() => jobAction("retry", selectedJob)}>Retry download</button>}{!['committed', 'canceled'].includes(selectedJob.status) && <button className="secondary-btn" disabled={!!busy || !!uncertain} onClick={() => jobAction("cancel", selectedJob)}>Cancel download</button>}{selectedJob.status === "awaiting_approval" && <button className="primary-btn" disabled={applyDisabled} onClick={apply}>Apply API import</button>}</div>
        </div>
      </section>}
    </div>

    <section hidden={activeTab !== "setup"} className="vcom-card" aria-labelledby="vcom-setup-title">
      <header className="vcom-card-head"><h2 id="vcom-setup-title">API setup</h2><span className="vcom-badge">{settings?.discovery ? "Saved discovery" : "Not tested"}</span></header>
      <div className="vcom-card-body"><p>Credentials are saved on the server and never returned to this form. Dots indicate saved credentials, not their values or lengths. Leave every credential field untouched to keep them. To replace any credential or change authentication mode, enter a complete replacement set.</p>
        <fieldset className="vcom-form" aria-busy={!!busy} disabled={loading || !!busy || !!uncertain}>
          <label>VCOM system key<input aria-label="VCOM system key" value={systemKey} autoComplete="off" spellCheck={false} onChange={event => setSystemKey(event.target.value)} /></label>
          <label>Authentication<select aria-label="VCOM authentication" value={authMode} onChange={event => { setAuthMode(event.target.value as VcomAuthMode); setUsername(""); setPassword(""); setAccessToken(""); }}><option value="basic">Basic (deprecated)</option><option value="bearer">Bearer access token</option></select></label>
          <label>API key<input aria-label="VCOM API key" type="password" value={apiKey} placeholder={credentialPlaceholder} aria-describedby="vcom-credential-help" autoComplete="new-password" onChange={event => setApiKey(event.target.value)} /></label>
          {authMode === "basic" ? <><label>Username<input aria-label="VCOM username" value={username} placeholder={credentialPlaceholder} aria-describedby="vcom-credential-help" autoComplete="off" onChange={event => setUsername(event.target.value)} /></label><label>Password<input aria-label="VCOM password" type="password" value={password} placeholder={credentialPlaceholder} aria-describedby="vcom-credential-help" autoComplete="new-password" onChange={event => setPassword(event.target.value)} /></label></> : <label>Access token<input aria-label="VCOM access token" type="password" value={accessToken} placeholder={credentialPlaceholder} aria-describedby="vcom-credential-help" autoComplete="new-password" onChange={event => setAccessToken(event.target.value)} /></label>}
        </fieldset>
        <p className="vcom-help" id="vcom-credential-help">{credentialPlaceholder ? "Credentials are saved for this authentication mode. Leave all fields untouched to keep them, or enter the full replacement set." : settings?.hasCredentials ? "No credentials are saved for the selected authentication mode. Enter the full replacement set to change modes." : "No credentials have been saved."} Saving configuration does not download telemetry.</p>
        {settings && configGeneration !== settings.generation && <p className="vcom-warning">Configuration changed elsewhere. Refresh the connection before saving this draft.</p>}
        <div className="vcom-actions"><button className="primary-btn" disabled={loading || !!busy || !!uncertain || !systemKey || configGeneration !== settings?.generation} onClick={saveConfiguration}>Save configuration</button><button className="secondary-btn" disabled={loading || !!busy || !!uncertain || !settings?.hasCredentials || unsavedConfiguration} aria-busy={busy === "discover"} onClick={discover}>{busy === "discover" ? <><span className="vcom-spinner" aria-hidden={true} />Testing connection…</> : "Test saved connection"}</button><button className="secondary-btn" disabled={!!busy || !!uncertain} onClick={() => refresh()}>Refresh connection</button></div>
        {unsavedConfiguration && <p className="vcom-help">Save configuration before testing this connection.</p>}
        {settings?.discovery && <div className="vcom-discovery"><h3>{settings.discovery.systemName}</h3><p>System: {settings.discovery.systemKey}<br />Timezone: {settings.discovery.timezone}<br />Discovered: {stamp(settings.discovery.discoveredAt, settings.discovery.timezone)}</p>{settings.discovery.warnings.map((warning, i) => <p className="vcom-warning" key={i}>{warning}</p>)}</div>}
        {!!settings?.issues.length && <ul className="vcom-issues">{settings.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}
      </div>
    </section>

    <section hidden={activeTab !== "mapping"} className="vcom-card" aria-labelledby="vcom-mapping-title">
      <header className="vcom-card-head"><h2 id="vcom-mapping-title">Field mapping</h2><span className="vcom-help">Explicit confirmation required</span></header>
      <div className="vcom-card-body"><p>Include or exclude each discovered analytical source. Destination suggestions use the CSV equipment matcher; review them and choose Save mappings to confirm. Exclusions affect future imports only, not saved data. Measurements and normalized API units are fixed. Meters remain separate from inverter energy; meter import is Other, not generated Energy.</p>
        {!settings?.discovery ? <p>Test the saved connection in API setup to discover sources.</p> : <>
          <div className="vcom-table-wrap"><table className="vcom-mapping-table"><thead><tr><th>VCOM source / device</th><th>Measurement / unit</th><th>Import</th><th>Destination</th></tr></thead><tbody>{settings.discovery.sources.map(source => {
            const mapping = mappingDraft.find(m => m.sourceId === source.id);
            const excluded = mapping?.excluded === true;
            const manual = manualMappings.current.has(source.id);
            const saved = settings.mappings.some(m => m.sourceId === source.id);
            const suggestion = mappingSuggestion(source, equipment);
            return <tr key={source.id} className={excluded ? "vcom-mapping-excluded" : undefined}>
              <td><strong>{source.name}</strong><small>{source.id}</small><small>Device: {source.deviceId ?? "System-level"}</small>{!source.eligible && <p className="vcom-warning">Unsupported: {source.reason || "Source cannot be imported."} Exclude this source to save the remaining mappings.</p>}</td>
              <td>{source.measurement}<small>{source.unit}</small><small>Upstream: {source.sourceUnit} / {source.aggregation}</small></td>
              <td><label className="vcom-include"><input type="checkbox" aria-label={`Include ${source.id}`} checked={!excluded} disabled={!!busy || !!uncertain} onChange={event => setSourceIncluded(source, event.target.checked)} /><span>{excluded ? "Excluded" : "Included"}</span></label></td>
              <td>{source.kind === "simulation" ? <span>{excluded ? "Not imported" : "Site Expected Production (@site)"}</span> : <select aria-label={`Destination for ${source.id}`} value={mapping?.equipmentId || ""} disabled={excluded || !source.eligible || !!busy || !!uncertain || equipmentLoading} onChange={event => setDestination(source, event.target.value)}><option value="">{excluded ? "Not imported" : "Choose destination"}</option>{destinations(source, equipment).map(asset => <option key={asset.id} value={asset.id}>{asset.name} ({asset.id})</option>)}</select>}
                <small className="vcom-mapping-choice">{manual ? excluded ? "Manual exclusion" : "Manual choice" : saved ? excluded ? "Saved exclusion" : "Saved mapping" : "Suggested mapping"}</small>
                {excluded ? <small>Not included in future downloads after Save mappings.</small> : manual || saved ? <small>Kept as chosen; automatic matching does not replace this destination.</small> : <small className={`vcom-confidence vcom-confidence-${suggestion.confidence}`}>{suggestion.confidence === "high" ? "High" : suggestion.confidence === "medium" ? "Medium" : "Low"} confidence · {suggestion.reason}. Confirm with Save mappings.</small>}
              </td>
            </tr>;
          })}</tbody></table></div>
          {noIncludedSources && <p className="vcom-warning">No sources included. You can save these exclusions, but downloads remain unavailable until at least one source is included and saved.</p>}
          {unsavedMappings && !noIncludedSources && <p className="vcom-help">Mapping changes are not saved. Choose Save mappings before downloading.</p>}
          <div className="vcom-poa"><h3>Irradiance fallback</h3><p>Satellite irradiance is primary. The combined site irradiance series is authoritative. A selected raw POA sensor only fills satellite gaps; it is not imported as a second analytical irradiance series.</p><label>POA fallback source<select aria-label="POA fallback source" value={selectedPoaSourceId ?? ""} disabled={excludeIrradiance || !!busy || !!uncertain} onChange={event => { if (!excludeIrradiance && !operationBusy.current && !uncertain) setSelectedPoaSourceId(event.target.value || null); }}><option value="">No POA fallback</option>{settings.discovery.poaSensors.map(source => <option key={source.id} value={source.id} disabled={!source.eligible}>{source.name} ({source.deviceId ?? source.id}){!source.eligible ? ` - unsupported: ${source.reason}` : ""}</option>)}</select></label><p className="vcom-help">{excludeIrradiance ? "Irradiance is excluded, so its POA fallback is cleared and disabled." : "Raw satellite and selected POA provenance are retained. No sensor is selected automatically."}</p></div>
          {!!settings.discovery.excludedMeters.length && <details><summary>Excluded meters ({settings.discovery.excludedMeters.length})</summary><ul>{settings.discovery.excludedMeters.map(meter => <li key={meter.id}>{meter.name} ({meter.id}): {meter.reason}</li>)}</ul></details>}
        </>}
        {mappingIssue && <p className="vcom-warning">{mappingIssue}</p>}{settings && mappingGeneration !== settings.generation && <p className="vcom-warning">The mapping draft is based on an older configuration. Refresh the connection and review it again.</p>}
        <div className="vcom-actions"><button className="primary-btn" disabled={loading || !!busy || !!uncertain || equipmentLoading || !!mappingIssue || mappingGeneration !== settings?.generation} onClick={saveMappings}>Save mappings</button></div>
      </div>
    </section>

    <section hidden={activeTab !== "activity"} className="vcom-card" aria-labelledby="vcom-activity-title"><header className="vcom-card-head"><h2 id="vcom-activity-title">Activity</h2><button className="secondary-btn" disabled={!!busy} onClick={() => checkRequestStatus()}>Refresh activity</button></header><div className="vcom-card-body"><h3>API downloads</h3>{!workspace?.jobs.length && <p>No manual API downloads recorded for this site.</p>}<div className="vcom-job-list">{workspace?.jobs.map(job => <article key={job.id}><div className="vcom-job-line"><strong>{job.fromDate} to {job.throughDate}</strong><span className="vcom-badge">{statusLabels[job.status]}</span></div><p>{job.completedRequests} / {job.totalRequests} requests · {stamp(job.updatedAt, timezone)}</p><p>{job.message}</p>{job.nextAttemptAt && <p>Next attempt: {stamp(job.nextAttemptAt, timezone)}</p>}{job.errorCode && <p className="vcom-help">{job.errorCode}</p>}{job.quality && <p>Missing readings: {job.quality.missingReadings}; partial simulation hours: {job.quality.partialSimulationHours} (unscaled sums retained).</p>}<div className="vcom-actions"><button className="secondary-btn" disabled={!!busy} onClick={() => { props.onSelectTab("data"); return checkRequestStatus(job.id); }}>Review download</button>{canRetry(job) && <button className="secondary-btn" disabled={!!busy || !!uncertain || job.generation !== settings?.generation} onClick={() => jobAction("retry", job)}>Retry download</button>}{!['committed', 'canceled'].includes(job.status) && <button className="secondary-btn" disabled={!!busy || !!uncertain} onClick={() => jobAction("cancel", job)}>Cancel download</button>}</div></article>)}</div><h3>Applied import history</h3>{!props.imports.length ? <p>No applied imports recorded for this site.</p> : <div className="vcom-table-wrap"><table><thead><tr><th>Applied</th><th>Source / file</th><th>Revision</th><th>Overlap approval</th></tr></thead><tbody>{props.imports.map(record => <tr key={record.stageId}><td>{stamp(record.committedAt, timezone)}</td><td>{record.metadata.source === "api" && record.metadata.sourceImportId?.startsWith("vcom:") ? "VCOM API" : record.metadata.source}<small>{record.metadata.fileName}</small></td><td>{record.revision}</td><td>{record.overlapApproved ? "Approved" : "Not required"}</td></tr>)}</tbody></table></div>}</div></section>
  </div>;
}
