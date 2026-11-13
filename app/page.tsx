"use client";

import {recurringTableRows,recurringAggregate,type RecurringIssue} from "./recurring-issues";
import RecurringTableGroup from "./RecurringTableGroup";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDateTime } from "./issue-date-format";
import { clipIssueToReport, localMoment, siteWallTime, type IntervalLoss, type PeriodLoss, type ReportRange } from "./issue-periods";
import AnalysisHistory from "./AnalysisHistory";
import IssueReviewDialog from "./IssueReviewDialog";
import ReviewWorkbench from "./ReviewWorkbench";
import {replaceInverterSelection} from "./inverter-review";
import {useMaintenanceWindows} from "./MaintenanceWindows";
import {maintenanceMatch} from "./review-groups";
import {defaultConfidence,effectiveReviewStatus,matchesReviewFilter,reviewLossSummary,nextReviewFinding,type IssueReview,type ConfidenceDetail,type SavedIssueReview} from "./issue-review";
import {appendReportMethodology,type ReportContext} from "./report-methodology";
import ReportingPeriod from "./ReportingPeriod";
import IssueVisibilitySettings from "./IssueVisibilitySettings";
import {defaultIssueVisibility,normalizeIssueVisibility,isIssueVisible,issueVisibilityOptions,type IssueVisibility} from "./issue-visibility";
import { themes, defaultTheme, isThemeId, type ThemeId } from "./themes";
import * as XLSX from "xlsx";
import type {
  DragEvent as ReactDragEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import TelemetryUploads from "./TelemetryUploads";
import MaintenanceUploads from "./MaintenanceUploads";
import ArrayConfiguration from "./ArrayConfiguration";
import IssueSummaries from "./IssueSummaries";
import IssueTimeline from "./IssueTimeline";
import SiteMap from "./SiteMap";
import SiteSettingsCsv from "./SiteSettingsCsv";
import { useMobileNavigation } from "./useMobileNavigation";

type Site = { id: string; name: string; location: string; arrayModelVerified: boolean };
type GeneralConfig = {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  latitude: string;
  longitude: string;
  expectedShading: string;
  expectedSnow: string;
  expectedProductionNotes: string;
  arrayModelVerified: boolean;
};
type UserSettings = {
  issueVisibility: IssueVisibility;
  theme: ThemeId;
  firstName: string;
  lastName: string;
  title: string;
  minimumIssueLossKwh: string;
};
type Severity = "critical" | "high" | "medium";
type IssueCategory = "Performance" | "Data quality" | "Communications";
type IssueConfidence = "confirmed" | "model-based";
type PerformanceIssue = {
  recurringId?:string;isRecurring?:boolean;
  recurringLossKwh?: number; recurringIssueCount?: number;
  eventKey?:string; evidenceSignature?:string; confidenceDetail?:ConfidenceDetail;
  id: string;
  timezone?: string;
  intervalMinutes?: number;
  intervalLosses?: IntervalLoss[];
  summaryPeriods?: PeriodLoss[];
  originalStart?: string;
  originalEnd?: string;
  reportClipped?: boolean;
  name: string;
  type:
    | "Site outage"
    | "Equipment outage"
    | "Underperformance"
    | "Data gap"
    | "Communication issue";
  category: IssueCategory;
  confidence: IssueConfidence;
  severity: Severity;
  equipmentId: string;
  equipmentName: string;
  equipmentType: string;
  equipmentExternalId: string;
  startDateTime: string;
  endDateTime: string;
  durationMinutes: number;
  estimatedLossKwh: number | null;
  lossUnknown?: boolean;
  productionUnknown?: boolean;
  affectedEquipment?: { id: string; name: string }[];
  lossPercent: number | null;
  siteImpactPercent: number;
  actualEnergyKwh: number | null;
  expectedEnergyKwh: number | null;
  description: string;
  suspectedCause?: "" | "Shading" | "Snow";
  causeExplanation?: string;
};
type PerformanceData = {
  issueDatabase?:{analysisRunId:string};methodology?:Record<string,any>;historical?:boolean;
  hasData: boolean;
  reason?: string;
  error?: string;
  cacheStatus?: "stored" | "generated";
  capacityKw: number;
  timeZone?: string;
  timezone?: string;
  summary: {
    timezone?: string;
    dailyProduction: Array<{ date: string; energyKwh: number }>;
    totalEnergyKwh: number;
    latestDate: string;
    latestDayEnergyKwh: number;
    readingCount: number;
    source: "interval_energy" | "active_power" | "";
  };
  analysis: {
    recurringIssues?:RecurringIssue[];
    timezone?: string;
    unfilteredTotalLossKwh?: number;
    thresholdExcludedLossKwh?: number;
    issues: PerformanceIssue[];
    totalLossKwh: number;
    affectedDays: number;
    analyzedDays: number;
    analyzedIntervals: number;
    analysisIntervalMinutes: number;
    irradianceAvailable: boolean;
    irradianceDays: number;
    skippedLowIrradianceDays: number;
    skippedLowIrradianceIntervals: number;
    lowIrradianceThresholdWm2: number;
    issueLossThresholdKwh: number | null;
    suppressedByLossThreshold: number;
    baselineMethod: string;
    inverterExpectation?: { status: string; message: string };
    peerComparison?: { referenceQualification?: { status: string; message: string; qualifiedInverters: number } };
  };
  validation: Record<string, unknown>;
  import: {
    fileName: string;
    createdAt: string;
    timestampStart: string | null;
    timestampEnd: string | null;
  };
};

const PERFORMANCE_ANALYSIS_IDLE_TIMEOUT_MS = 300_000;
type SortKey =
  | "name"
  | "category"
  | "confidence"
  | "suspectedCause"
  | "equipmentName"
  | "severity"
  | "startDateTime"
  | "endDateTime"
  | "durationMinutes"
  | "estimatedLossKwh"
  | "lossPercent"
  | "siteImpactPercent";
type ColumnFilters = {
  type: string;
  category: "" | IssueCategory;
  confidence: string;
  suspectedCause: string;
  equipmentName: string;
  severity: "" | Severity;
  startDateTime: string;
  endDateTime: string;
  durationHours: string;
  estimatedLossKwh: string;
  lossPercent: string;
  siteImpactPercent: string;
};
type IssueColumn = { id: SortKey; label: string };

const defaultConfigs: Record<string, GeneralConfig> = {};
const defaultSiteId = "";
const defaultUser: UserSettings = {
  issueVisibility: {...defaultIssueVisibility},
  theme: defaultTheme,
  firstName: "Local",
  lastName: "Analyst",
  title: "Asset Manager",
  minimumIssueLossKwh: "",
};
function blankConfig(): GeneralConfig {
  return {
    id: "",
    name: "",
    address: "",
    city: "",
    state: "",
    zip: "",
    country: "US",
    latitude: "",
    longitude: "",
    expectedShading: "not_included", expectedSnow: "not_included", expectedProductionNotes: "",
    arrayModelVerified: false,
  };
}
const countries = [
  ["US", "United States"],
  ["CA", "Canada"],
  ["MX", "Mexico"],
  ["AU", "Australia"],
  ["BR", "Brazil"],
  ["CL", "Chile"],
  ["DE", "Germany"],
  ["ES", "Spain"],
  ["FR", "France"],
  ["GB", "United Kingdom"],
  ["IN", "India"],
  ["IT", "Italy"],
  ["JP", "Japan"],
  ["NL", "Netherlands"],
  ["PL", "Poland"],
  ["PT", "Portugal"],
  ["ZA", "South Africa"],
];
const postalCodeRules: Record<
  string,
  { placeholder: string; maxLength: number; pattern: string; title: string }
> = {
  US: { placeholder: "00000 or 00000-0000", maxLength: 10, pattern: "[0-9]{5}(-[0-9]{4})?", title: "Enter a 5-digit ZIP code, optionally followed by a 4-digit extension." },
  CA: { placeholder: "A1A 1A1", maxLength: 7, pattern: "[A-Za-z][0-9][A-Za-z][ -]?[0-9][A-Za-z][0-9]", title: "Enter a Canadian postal code, for example A1A 1A1." },
  DE: { placeholder: "10115", maxLength: 5, pattern: "[0-9]{5}", title: "Enter a 5-digit German postal code." },
  JP: { placeholder: "100-0001", maxLength: 8, pattern: "[0-9]{3}-?[0-9]{4}", title: "Enter a 7-digit Japanese postal code, with or without a hyphen." },
  PL: { placeholder: "00-001", maxLength: 6, pattern: "[0-9]{2}-?[0-9]{3}", title: "Enter a 5-digit Polish postal code, with or without a hyphen." },
  IT: { placeholder: "00100", maxLength: 5, pattern: "[0-9]{5}", title: "Enter a 5-digit Italian postal code." },
};
type AnalysisProgressState = {
  attemptId: string;
  status: "processing" | "canceling" | "canceled" | "failed" | "interrupted" | "completed";
  stage: string; label: string; completed: number; total: number; percent: number;
  updatedAt: number; error: string;
};
const emptyPerformance: PerformanceData = {
  hasData: false,
  capacityKw: 0,
  summary: {
    dailyProduction: [],
    totalEnergyKwh: 0,
    latestDate: "",
    latestDayEnergyKwh: 0,
    readingCount: 0,
    source: "",
  },
  analysis: {
    issues: [],
    totalLossKwh: 0,
    affectedDays: 0,
    analyzedDays: 0,
    analyzedIntervals: 0,
    analysisIntervalMinutes: 15,
    irradianceAvailable: false,
    irradianceDays: 0,
    skippedLowIrradianceDays: 0,
    skippedLowIrradianceIntervals: 0,
    lowIrradianceThresholdWm2: 50,
    issueLossThresholdKwh: null,
    suppressedByLossThreshold: 0,
    baselineMethod: "",
  },
  validation: {},
  import: {
    fileName: "",
    createdAt: "",
    timestampStart: null,
    timestampEnd: null,
  },
};
const defaultIssueColumns: IssueColumn[] = [
  { id: "name", label: "Issue" },
  { id: "category", label: "Category" },
  { id: "confidence", label: "Confidence" },
  { id: "suspectedCause", label: "Suspected cause" },
  { id: "equipmentName", label: "Equipment" },
  { id: "severity", label: "Severity" },
  { id: "startDateTime", label: "Start" },
  { id: "endDateTime", label: "End" },
  { id: "durationMinutes", label: "Duration" },
  { id: "estimatedLossKwh", label: "Estimated loss" },
  { id: "lossPercent", label: "Loss vs. expected" },
  { id: "siteImpactPercent", label: "Site impacted" },
];
const issueColumnOrderStorageKey = "performance-issue-column-order";

function formatEnergy(value: number) {
  if (value >= 1000000)
    return `${(value / 1000000).toLocaleString(undefined, { maximumFractionDigits: 2 })} GWh`;
  if (value >= 1000)
    return `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} MWh`;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} kWh`;
}
function formatKwh(value: number | null) {
  if (value === null) return "Unknown";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} kWh`;
}
function formatDate(value: string) {
  if (!value) return "—";
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(year, month - 1, day));
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60),
    remainingMinutes = minutes % 60;
  if (hours < 24)
    return remainingMinutes
      ? `${hours} hr ${remainingMinutes} min`
      : `${hours} hr`;
  const days = Math.floor(hours / 24),
    remainingHours = hours % 24;
  return remainingHours ? `${days} d ${remainingHours} hr` : `${days} d`;
}
function affectedDayCount(issues: PerformanceIssue[]) {
  const dates = new Set<string>();
  issues.forEach((issue) => {
    const start = Date.parse(`${siteWallTime(issue.startDateTime, issue.timezone).slice(0, 10)}T00:00:00Z`);
    const lastInstant = new Date(localMoment(issue.endDateTime) - 1).toISOString();
    const endDay = /Z$/.test(issue.endDateTime) ? siteWallTime(lastInstant, issue.timezone).slice(0, 10) : lastInstant.slice(0, 10);
    const finalDay = Math.max(start, Date.parse(`${endDay}T00:00:00Z`));
    for (let day = start; day <= finalDay; day += 86400000)
      dates.add(new Date(day).toISOString().slice(0, 10));
  });
  return dates.size;
}
function comparableDateTimeFilter(value: string) {
  const match = value
    .trim()
    .match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}T${match[4].padStart(2, "0")}:${match[5]}:00`;
}
function sortValue(issue: PerformanceIssue, key: SortKey) {
  if (key === "severity")
    return { critical: 3, high: 2, medium: 1 }[issue.severity];
  return issue[key] ?? "";
}
function userInitials(user: UserSettings) {
  return (
    `${user.firstName.charAt(0)}${user.lastName.charAt(0)}`.toUpperCase() || "U"
  );
}
function thresholdLabel(value: string) {
  const threshold = Number(value);
  return value.trim() && Number.isFinite(threshold)
    ? `Show individual or recurring losses above ${formatKwh(threshold)}`
    : "Log every detected issue";
}
export default function Home() {
  const [toast, setToast] = useState("");
  const [view, setView] = useState<
    | "map"
    | "issues"
    | "timeline"
    | "summaries"
    | "settings"
    | "uploads"
    | "maintenance-uploads"
    | "array"
    | "user"
    | "issue-visibility"
  >("map");
  const [configs, setConfigs] =
    useState<Record<string, GeneralConfig>>(defaultConfigs);
  const verificationUpdatesRef = useRef<Record<string, boolean>>({});
  const updateSiteVerification = useCallback((siteId: string, verified: boolean) => {
    verificationUpdatesRef.current[siteId] = verified;
    setConfigs(current => {
      const site = current[siteId];
      if (!site || site.arrayModelVerified === verified) return current;
      return { ...current, [siteId]: { ...site, arrayModelVerified: verified } };
    });
  }, []);
  const [activeSiteId, setActiveSiteId] = useState(defaultSiteId);
  const [sitesWithPerformanceData, setSitesWithPerformanceData] = useState<Set<string>>(new Set());
  const [settingsSiteId, setSettingsSiteId] = useState(defaultSiteId);
  const [form, setForm] = useState<GeneralConfig>(
    blankConfig(),
  );
  const [creatingSite, setCreatingSite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [user, setUser] = useState<UserSettings>(defaultUser);
  const [userForm, setUserForm] = useState<UserSettings>(defaultUser);
  const [savingUser, setSavingUser] = useState(false);
  const [userSettingsReady,setUserSettingsReady]=useState(false);
  const [userSettingsError,setUserSettingsError]=useState("");
  const [userSettingsRevision,setUserSettingsRevision]=useState(0);
  const [userMenuOpen,setUserMenuOpen]=useState(true);
  const chosenTheme = view === "user" ? userForm.theme : user.theme;
  const activeTheme = isThemeId(chosenTheme) ? chosenTheme : defaultTheme;
  useEffect(() => {
    document.documentElement.dataset.theme = activeTheme;
  }, [activeTheme]);
  const [zipStatus, setZipStatus] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { isMobile, mobileMenuOpen, setMobileMenuOpen, navigationRef, menuButtonRef } = useMobileNavigation();
  const [sitesMenuOpen, setSitesMenuOpen] = useState(true);
  const [issuesMenuOpen, setIssuesMenuOpen] = useState(true);
  const [uploadsMenuOpen, setUploadsMenuOpen] = useState(true);
  const [maintenanceRevision,setMaintenanceRevision]=useState(0);
  const [performance, setPerformance] = useState<PerformanceData | null>(null);
  const performanceCacheRef = useRef(new Map<string, { data: PerformanceData; etag: string; bytes: number }>());
  const [analysisLoadMode, setAnalysisLoadMode] = useState<
    "loading" | "analyzing"
  >("loading");
  const [analysisState, setAnalysisState] = useState<AnalysisProgressState | null>(null);
  const [analysisWaiting, setAnalysisWaiting] = useState(false);
  const [analysisAction, setAnalysisAction] = useState("");
  const [analysisControlError, setAnalysisControlError] = useState("");
  const analysisSiteRef = useRef(activeSiteId);
  analysisSiteRef.current = activeSiteId;
  const [performanceRevision, setPerformanceRevision] = useState(0);
  const [analysisSelection,setAnalysisSelection]=useState({siteId:"",runId:""});
  const selectedRunId=analysisSelection.siteId===activeSiteId?analysisSelection.runId:"";
  const [reviews,setReviews]=useState<Record<string,IssueReview>>({});
  const [reviewsRetrievedAt,setReviewsRetrievedAt]=useState("");
  const [reviewError,setReviewError]=useState("");
  const [reviewFilter,setReviewFilter]=useState("Exclude dismissed");
  const [issuePage,setIssuePage]=useState(0);
  const maintenance=useMaintenanceWindows(activeSiteId);
  const [selectedFindings,setSelectedFindings]=useState<string[]>([]);
  const [reviewTarget,setReviewTarget]=useState<PerformanceIssue|null>(null);
  const [reviewScope,setReviewScope]=useState("");
  const analysisRunId=performance?.issueDatabase?.analysisRunId||String(performance?.methodology?.analysisId||selectedRunId||"");
  const currentReviewScope=useRef("");
  currentReviewScope.current=`${activeSiteId}:${analysisRunId}`;
  const reviewsReady=userSettingsReady&&!!reviewsRetrievedAt&&!reviewError&&reviewScope===`${activeSiteId}:${analysisRunId}`;
  useEffect(()=>{
    const controller=new AbortController();setReviews({});setReviewsRetrievedAt("");setReviewError("");
    if(!analysisRunId)return;
    void (async()=>{const collected:Record<string,IssueReview>={};let cursor:number|null=0,retrievedAt="";
      do{const response:Response=await fetch(`/api/issue-reviews?siteId=${encodeURIComponent(activeSiteId)}&runId=${encodeURIComponent(analysisRunId)}&cursor=${cursor}`,{signal:controller.signal});const data:{reviews:(IssueReview&{eventKey:string})[];next:number|null;retrievedAt:string;error?:string}=await response.json();if(!response.ok)throw new Error(data.error);if(controller.signal.aborted)return;for(const review of data.reviews)collected[review.eventKey]=review;cursor=data.next;retrievedAt=data.retrievedAt;}while(cursor!==null&&cursor!==undefined);
      setReviews(collected);setReviewsRetrievedAt(retrievedAt);setReviewScope(`${activeSiteId}:${analysisRunId}`);
    })().catch(e=>{if(!controller.signal.aborted)setReviewError(e.message);});
    return()=>controller.abort();
  },[activeSiteId,analysisRunId]);
  function confidenceFor(issue:PerformanceIssue){return (issue.eventKey&&reviews[issue.eventKey]?.state.confidence)||issue.confidenceDetail||defaultConfidence(issue);}
  function reviewStatus(issue:PerformanceIssue){if(!reviewsReady)return reviewError?"Review unavailable":"Loading review";return effectiveReviewStatus(issue,issue.eventKey?reviews[issue.eventKey]:undefined);}
  const pendingAnalysisSiteRef = useRef("");
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>(
    { key: "estimatedLossKwh", direction: "desc" },
  );
  const [filters, setFilters] = useState<ColumnFilters>({
    type: "",
    category: "",
    confidence: "",
    suspectedCause: "",
    equipmentName: "",
    severity: "",
    startDateTime: "",
    endDateTime: "",
    durationHours: "",
    estimatedLossKwh: "",
    lossPercent: "",
    siteImpactPercent: "",
  });
  const [reportRange, setReportRange] = useState<ReportRange>({ from: "", through: "" });
  const [issueColumns, setIssueColumns] = useState(defaultIssueColumns);
  const [draggedColumn, setDraggedColumn] = useState<SortKey | null>(null);
  const [dropColumn, setDropColumn] = useState<SortKey | null>(null);

  useEffect(() => {
    try {
      const legacyKey = Object.keys(window.localStorage).find((key) =>
        key.startsWith("performance-issue-column-order:"),
      );
      const saved =
        window.localStorage.getItem(issueColumnOrderStorageKey) ||
        (legacyKey ? window.localStorage.getItem(legacyKey) : null);
      if (!saved) return;
      const order = JSON.parse(saved) as SortKey[];
      const known = new Map(defaultIssueColumns.map((column) => [column.id, column]));
      const restored = order
        .map((id) => known.get(id))
        .filter((column): column is (typeof defaultIssueColumns)[number] => Boolean(column));
      defaultIssueColumns.forEach((column) => {
        if (!restored.some((savedColumn) => savedColumn.id === column.id))
          restored.push(column);
      });
      queueMicrotask(() => setIssueColumns(restored));
      window.localStorage.setItem(
        issueColumnOrderStorageKey,
        JSON.stringify(restored.map((column) => column.id)),
      );
    } catch {
      queueMicrotask(() => setIssueColumns(defaultIssueColumns));
    }
  }, []);
  const managedSites = useMemo<Site[]>(
    () =>
      Object.values(configs)
        .map((config) => ({
          id: config.id,
          name: config.name,
          location:
            [config.city, config.state].filter(Boolean).join(", ") ||
            "Location not set",
          arrayModelVerified: Boolean(config.arrayModelVerified),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [configs],
  );
  const activeSite =
    managedSites.find((site) => site.id === activeSiteId) || managedSites[0];
  const issues = useMemo(
    () => performance?.analysis?.issues || [],
    [performance],
  );
  const recurringIssues=performance?.analysis.recurringIssues||[];
  function openReview(id:string){const issue=issues.find(i=>i.id===id);if(issue){setReviewTarget(issue);return;}const episode=recurringIssues.find(e=>e.id===id);if(episode){const first=issues.find(i=>episode.members.some(m=>m.id===i.id));if(first)setReviewTarget({...first,...episode});}}
  const reportTimezone = performance?.timezone || performance?.timeZone || performance?.summary?.timezone || performance?.analysis?.timezone || issues[0]?.timezone || "Site local time";
  const periodIssues = useMemo(() => issues.flatMap(issue => {
    const clipped = clipIssueToReport(issue, reportRange);
    return clipped ? [clipped] : [];
  }), [issues, reportRange]);
  const visibility=user.issueVisibility;
  const enabledPeriodIssues=useMemo(()=>periodIssues.filter(issue=>isIssueVisible(issue,visibility)),[periodIssues,visibility]);
  const enabledAnalysisIssues=useMemo(()=>issues.filter(issue=>isIssueVisible(issue,visibility)),[issues,visibility]);
  const hiddenTypeCount=issueVisibilityOptions.filter(option=>!visibility[option.key]).length;
  const matchesAnalystFilter=(issue:PerformanceIssue)=>matchesReviewFilter(issue,issue.eventKey?reviews[issue.eventKey]:undefined,reviewFilter);
  const reportIssues=reviewsReady?enabledPeriodIssues.filter(matchesAnalystFilter):[];
  const hiddenIssues=reviewsReady?periodIssues.filter(issue=>!isIssueVisible(issue,visibility)&&matchesAnalystFilter(issue)):[];
  const visibilityHidden={count:hiddenIssues.length,knownLossKwh:hiddenIssues.reduce((sum,issue)=>sum+(issue.lossUnknown?0:issue.estimatedLossKwh||0),0),unknownLossCount:hiddenIssues.filter(issue=>issue.lossUnknown||issue.estimatedLossKwh==null).length};
  const reviewTotals=reviewLossSummary(enabledPeriodIssues,reviews);
  const reportContext:ReportContext={issueVisibility:visibility,visibilityHidden,recurringIssues:recurringIssues.filter(issue=>isIssueVisible(issue,visibility)),maintenanceWindows:maintenance.windows,maintenanceRetrievedAt:maintenance.retrievedAt,maintenanceError:maintenance.error,methodology:performance?.methodology,analysisId:analysisRunId,reviewFilter,reviews,reviewRetrievedAt:reviewsReady?reviewsRetrievedAt:"",reviewTotals:reviewsReady?reviewTotals:undefined,excludedIssues:reviewsReady?enabledPeriodIssues.filter(i=>reviewStatus(i)==="Dismissed"):[],filters:{...filters,reportRange,sort,columnOrder:issueColumns.map(c=>c.id),lossThreshold:performance?.analysis.issueLossThresholdKwh,issueVisibility:visibility},issues:reportIssues};
  const visibleIssues = useMemo(
    () =>
      reportIssues
        .filter((issue) => {
          const startFilter = comparableDateTimeFilter(filters.startDateTime);
          const endFilter = comparableDateTimeFilter(filters.endDateTime);
          if (
            filters.type &&
            !`${issue.name} ${issue.type} ${issue.description}`
              .toLowerCase()
              .includes(filters.type.toLowerCase())
          )
            return false;
          if (filters.category && issue.category !== filters.category)
            return false;
          if(filters.confidence){const [key,level]=filters.confidence.split(":");if(confidenceFor(issue)[key as keyof ConfidenceDetail]?.level!==level)return false;}
          if (filters.suspectedCause && (issue.suspectedCause || "blank") !== filters.suspectedCause) return false;
          if (
            filters.equipmentName &&
            !`${issue.equipmentName} ${issue.equipmentExternalId} ${issue.equipmentType}`
              .toLowerCase()
              .includes(filters.equipmentName.toLowerCase())
          )
            return false;
          if (filters.severity && issue.severity !== filters.severity)
            return false;
          if (startFilter && siteWallTime(issue.originalStart || issue.startDateTime, issue.timezone) < startFilter) return false;
          if (endFilter && siteWallTime(issue.originalEnd || issue.endDateTime, issue.timezone) > endFilter) return false;
          if (
            filters.durationHours &&
            issue.durationMinutes < Number(filters.durationHours) * 60
          )
            return false;
          if (
            filters.estimatedLossKwh &&
            (issue.estimatedLossKwh === null || issue.estimatedLossKwh < Number(filters.estimatedLossKwh))
          )
            return false;
          if (
            filters.lossPercent &&
            (issue.lossPercent === null || issue.lossPercent < Number(filters.lossPercent))
          )
            return false;
          if (
            filters.siteImpactPercent &&
            issue.siteImpactPercent < Number(filters.siteImpactPercent)
          )
            return false;
          return true;
        })
        .sort((a, b) => {
          const ranks=["Unknown","Low","Moderate","High"];
          const left = sort.key==="confidence"?ranks.indexOf(confidenceFor(a).anomaly.level):sortValue(a, sort.key),
            right = sort.key==="confidence"?ranks.indexOf(confidenceFor(b).anomaly.level):sortValue(b, sort.key);
          const comparison =
            typeof left === "number" && typeof right === "number"
              ? left - right
              : String(left).localeCompare(String(right));
          return sort.direction === "asc" ? comparison : -comparison;
        }),
    [reportIssues, filters, sort],
  );
  const issueRows=recurringTableRows(recurringIssues,visibleIssues).sort((a,b)=>{
    const itemA=a.group?recurringAggregate(a.group):a.issue,itemB=b.group?recurringAggregate(b.group):b.issue;
    const ranks=["Unknown","Low","Moderate","High"],left=sort.key==="confidence"?ranks.indexOf(confidenceFor(itemA).anomaly.level):sortValue(itemA,sort.key),right=sort.key==="confidence"?ranks.indexOf(confidenceFor(itemB).anomaly.level):sortValue(itemB,sort.key);
    const comparison=typeof left==="number"&&typeof right==="number"?left-right:String(left).localeCompare(String(right));return sort.direction==="asc"?comparison:-comparison;
  });
  const pageRows=issueRows.slice(issuePage*100,issuePage*100+100);
  const pageOccurrenceIds=pageRows.flatMap(row=>row.group?row.group.issues.map(i=>i.id):[row.issue.id]);
  const hasFilters = Object.values(filters).some(Boolean);
  const activeFilterCount = Object.values(filters).filter(
    (value) => String(value).trim() !== "",
  ).length;
  const visibleIssueMetrics = useMemo(
    () => ({
      count: visibleIssues.length,
      critical: visibleIssues.filter((issue) => issue.severity === "critical").length,
      high: visibleIssues.filter((issue) => issue.severity === "high").length,
      lossKwh: visibleIssues.reduce((sum, issue) => sum + (issue.estimatedLossKwh ?? 0), 0),
      affectedDays: affectedDayCount(visibleIssues),
    }),
    [visibleIssues],
  );

  useEffect(() => {
    fetch("/api/site-settings")
      .then(async (response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!Array.isArray(data?.sites)) return;
        if (!data.sites.length) {setConfigs({});setActiveSiteId('');startNewSite();setView('settings');return;}
        setSitesWithPerformanceData(new Set<string>(data.sitesWithPerformanceData || []));
        const stored = Object.fromEntries(
          data.sites.map((item: GeneralConfig) => [item.id, {
            ...item, arrayModelVerified: verificationUpdatesRef.current[item.id] ?? item.arrayModelVerified,
          }]),
        );
        setConfigs(stored);
        const first = data.sites[0] as GeneralConfig;
        setActiveSiteId((current) => (stored[current] ? current : first.id));
        setSettingsSiteId((current) => {
          const next = stored[current] || first;
          setForm(next);
          return next.id;
        });
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    const controller=new AbortController();setUserSettingsError("");
    fetch("/api/user-settings",{signal:controller.signal})
      .then(async response=>{const data=await response.json();if(!response.ok||!data?.user)throw new Error(data.error||"Unable to load saved user preferences.");return data;})
      .then((data) => {
        if(controller.signal.aborted)return;
        const saved={...data.user,issueVisibility:normalizeIssueVisibility(data.user.issueVisibility)};
        setUser(saved);setUserForm(saved);setUserSettingsReady(true);
      })
      .catch(error=>{if(!controller.signal.aborted)setUserSettingsError(error instanceof Error?error.message:"Unable to load saved user preferences.");});
    return()=>controller.abort();
  }, [userSettingsRevision]);
  useEffect(() => {
    let cancelled = false;
    if (!activeSiteId) return;
    const controller = new AbortController();
    let timedOut = false;
    let attemptId = "";
    let polling = false;
    const requestedAnalysis = pendingAnalysisSiteRef.current === activeSiteId;
    const cacheKey=selectedRunId?`${activeSiteId}|${selectedRunId}`:activeSiteId;
    const cached = requestedAnalysis ? undefined : performanceCacheRef.current.get(cacheKey);
    queueMicrotask(() => {
      if (cancelled) return;
      setPerformance(cached?.data || null);
      setAnalysisLoadMode(requestedAnalysis ? "analyzing" : "loading");
      setAnalysisState(null);
      setAnalysisAction("");
      setAnalysisControlError("");
      setAnalysisWaiting(false);
    });
    let timeoutTimer: number;
    let lastProgressUpdate = 0;
    const resetIdleTimeout = () => {
      window.clearTimeout(timeoutTimer);
      timeoutTimer = window.setTimeout(() => { timedOut = true; controller.abort(); }, PERFORMANCE_ANALYSIS_IDLE_TIMEOUT_MS);
    };
    resetIdleTimeout();
    const applyProgress = (progress?: AnalysisProgressState) => {
      if (!progress || cancelled) return;
      attemptId = progress.attemptId;
      if(progress.updatedAt>lastProgressUpdate){lastProgressUpdate=progress.updatedAt;resetIdleTimeout();}
      setAnalysisLoadMode("analyzing");
      setAnalysisState(current => current?.attemptId === progress.attemptId && current.updatedAt > progress.updatedAt ? current : progress);
    };
    // Poll only persisted progress while a bounded work request is in flight.
    const progressTimer = window.setInterval(async () => {
      if (!attemptId || polling || cancelled || controller.signal.aborted) return;
      polling = true;
      try {
        const response = await fetch(`/api/performance-summary?siteId=${encodeURIComponent(activeSiteId)}&progressOnly=1&attemptId=${encodeURIComponent(attemptId)}`,
          { signal: controller.signal, cache: "no-store" });
        if (response.ok) applyProgress((await response.json()).progress);
      } catch { /* Work request reports failures; a single missed poll is harmless. */ }
      finally { polling = false; }
    }, 1000);

    async function readResponse(response: Response) {
      const text = await response.text();
      let data: PerformanceData & { processing?: boolean; retryAfterMs?: number;
        progress?: AnalysisProgressState; waiting?: boolean };
      try { data = JSON.parse(text) as typeof data; }
      catch { throw new Error("The analysis connection was interrupted. Resume to check its saved progress."); }
      if (!response.ok) throw new Error(data.error || "Unable to load issue analysis");
      return { data, etag: response.headers.get("ETag") || "", bytes: text.length * 2 };
    }
    async function loadPerformance() {
      while (!cancelled) {
        const response = await fetch(selectedRunId?`/api/analysis-history?siteId=${encodeURIComponent(activeSiteId)}&runId=${encodeURIComponent(selectedRunId)}`:`/api/performance-summary?siteId=${encodeURIComponent(activeSiteId)}`,
          { signal: controller.signal, cache: "no-store", headers: cached?.etag ? { "If-None-Match": cached.etag } : {} });
        if (cancelled) throw new Error("Analysis loading was canceled.");
        if (response.status === 304 && cached) return cached;
        const result = await readResponse(response);
        applyProgress(result.data.progress);
        setAnalysisWaiting(Boolean(result.data.waiting));
        if (response.status !== 202) return result;
        performanceCacheRef.current.delete(activeSiteId);
        setPerformance(null);
        setAnalysisLoadMode("analyzing");
        await new Promise(resolve => window.setTimeout(resolve, Math.max(250, result.data.retryAfterMs || 500)));
      }
      throw new Error("Analysis loading was canceled.");
    }
    void loadPerformance().then(({ data, etag, bytes }) => {
      if (cancelled) return;
      const normalizedData = { ...emptyPerformance, ...data,
        analysis: { ...emptyPerformance.analysis, ...data.analysis } };
      const cache = performanceCacheRef.current;
      cache.delete(cacheKey);
      if (etag && bytes <= 12 * 1024 * 1024) cache.set(cacheKey, { data: normalizedData, etag, bytes });
      let totalBytes = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      while (cache.size > 5 || totalBytes > 12 * 1024 * 1024) {
        const oldest = cache.keys().next().value!;
        totalBytes -= cache.get(oldest)!.bytes;
        cache.delete(oldest);
      }
      if (data.hasData && !data.error) {
        setAnalysisState(null);
      }
      if (pendingAnalysisSiteRef.current === activeSiteId) pendingAnalysisSiteRef.current = "";
      setPerformance(normalizedData);
    }).catch(error => {
      if (!cancelled) setPerformance({ ...emptyPerformance,
        error: timedOut ? "No analysis progress was recorded for five minutes. Resume from saved progress, or cancel the analysis."
          : error instanceof Error ? error.message : "Unable to load issue analysis" });
    }).finally(() => {
      window.clearInterval(progressTimer);
      window.clearTimeout(timeoutTimer);
    });
    return () => {
      cancelled = true;
      window.clearInterval(progressTimer);
      window.clearTimeout(timeoutTimer);
      controller.abort();
    };
  }, [activeSiteId, performanceRevision,selectedRunId]);

  useEffect(()=>{setSelectedFindings([]);},[activeSiteId,analysisRunId,filters,reportRange,reviewFilter,visibility]);
  useEffect(()=>{setIssuePage(0);},[activeSiteId,analysisRunId,filters,sort,reportRange,reviewFilter,visibility]);
  async function reanalyze() {
    const siteId = activeSiteId;
    if (analysisAction) return;
    setAnalysisAction("retry");
    try {
      const response = await fetch("/api/performance-summary", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({siteId,action:"reanalyze"}) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to start analysis");
      performanceCacheRef.current.delete(siteId);
      if (analysisSiteRef.current !== siteId) return;
      pendingAnalysisSiteRef.current = siteId;
      setPerformanceRevision(value => value + 1);
    } catch (error) { notify(error instanceof Error ? error.message : "Unable to start analysis"); }
    finally { setAnalysisAction(""); }
  }
  async function controlAnalysis(action: "cancel" | "retry") {
    if (!analysisState || analysisAction) return;
    const siteId = activeSiteId;
    setAnalysisAction(action);
    setAnalysisControlError("");
    try {
      const response = await fetch("/api/performance-summary", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId, attemptId: analysisState.attemptId, action }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to update analysis");
      if (analysisSiteRef.current !== siteId) return;
      if (data.progress) setAnalysisState(data.progress);
      // Reconnect even after monitoring has timed out, so cancellation is acknowledged.
      pendingAnalysisSiteRef.current = siteId;
      setPerformanceRevision(value => value + 1);
    } catch (error) {
      if (analysisSiteRef.current === siteId) setAnalysisControlError(error instanceof Error ? error.message : "Unable to update analysis");
    } finally { if (analysisSiteRef.current === siteId) setAnalysisAction(""); }
  }
  useEffect(() => {
    if (form.country !== "US" || !/^\d{5}$/.test(form.zip)) return;
    const timer = window.setTimeout(async () => {
      setZipStatus("Looking up ZIP…");
      try {
        const response = await fetch(`/api/postal?country=US&zip=${form.zip}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        setForm((current) =>
          current.zip === form.zip
            ? { ...current, city: data.city, state: data.state }
            : current,
        );
        setZipStatus("City and state found");
      } catch (error) {
        setZipStatus(error instanceof Error ? error.message : "ZIP not found");
      }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [form.zip, form.country]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }
  function goTo(next: typeof view) {
    if(next==='user'||next==='issue-visibility')setUserMenuOpen(true);
    if(next==='uploads'||next==='maintenance-uploads')setUploadsMenuOpen(true);
    setMobileMenuOpen(false);
    setView(next);
    window.scrollTo({ top: 0 });
  }
  function toggleSort(key: SortKey) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
  }
  function sortIndicator(key: SortKey) {
    return sort.key === key ? (sort.direction === "asc" ? "↑" : "↓") : "↕";
  }
  function updateFilter<Key extends keyof ColumnFilters>(
    key: Key,
    value: ColumnFilters[Key],
  ) {
    setFilters((current) => ({ ...current, [key]: value }));
  }
  function clearFilters() {
    setFilters({
      type: "",
      category: "",
      confidence: "",
      suspectedCause: "",
      equipmentName: "",
      severity: "",
      startDateTime: "",
      endDateTime: "",
      durationHours: "",
      estimatedLossKwh: "",
      lossPercent: "",
      siteImpactPercent: "",
    });
  }
  function reorderColumn(source: SortKey, target: SortKey, placeAfter = false) {
    if (source === target) return;
    setIssueColumns((current) => {
      const next = current.filter((column) => column.id !== source);
      const targetIndex = next.findIndex((column) => column.id === target);
      const sourceColumn = current.find((column) => column.id === source);
      if (!sourceColumn || targetIndex < 0) return current;
      next.splice(targetIndex + (placeAfter ? 1 : 0), 0, sourceColumn);
      try {
        window.localStorage.setItem(
          issueColumnOrderStorageKey,
          JSON.stringify(next.map((column) => column.id)),
        );
      } catch {
        // Column movement still works when browser storage is unavailable.
      }
      return next;
    });
  }
  function startColumnDrag(
    column: SortKey,
    event: ReactDragEvent<HTMLSpanElement>,
  ) {
    setDraggedColumn(column);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", column);
  }
  function finishColumnDrop(
    column: SortKey,
    event: ReactDragEvent<HTMLTableCellElement>,
  ) {
    event.preventDefault();
    const source = (draggedColumn ||
      event.dataTransfer.getData("text/plain")) as SortKey;
    if (source) {
      const bounds = event.currentTarget.getBoundingClientRect();
      reorderColumn(
        source,
        column,
        event.clientX >= bounds.left + bounds.width / 2,
      );
    }
    setDraggedColumn(null);
    setDropColumn(null);
  }
  function moveColumnWithKeyboard(
    column: SortKey,
    event: ReactKeyboardEvent<HTMLSpanElement>,
  ) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = issueColumns.findIndex((item) => item.id === column);
    const targetIndex = event.key === "ArrowLeft" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= issueColumns.length) return;
    const target = issueColumns[targetIndex].id;
    reorderColumn(column, target, event.key === "ArrowRight");
  }
  function filterControl(column: SortKey) {
    switch (column) {
      case "name":
        return (
          <input
            aria-label="Filter issue"
            value={filters.type}
            onChange={(event) => updateFilter("type", event.target.value)}
            placeholder="Contains…"
          />
        );
      case "category":
        return (
          <select
            aria-label="Filter category"
            value={filters.category}
            onChange={(event) =>
              updateFilter(
                "category",
                event.target.value as ColumnFilters["category"],
              )
            }
          >
            <option value="">All</option>
            <option value="Performance">Performance</option>
            <option value="Data quality">Data quality</option>
            <option value="Communications">Communications</option>
          </select>
        );
      case "suspectedCause":
        return <select aria-label="Filter suspected cause" value={filters.suspectedCause} onChange={event => updateFilter("suspectedCause", event.target.value)}>
          <option value="">All</option><option value="Shading">Shading</option><option value="Snow">Snow</option><option value="blank">Blank</option>
        </select>;
      case "confidence":
        return (
          <select
            aria-label="Filter confidence"
            value={filters.confidence}
            onChange={(event) =>
              updateFilter(
                "confidence",
                event.target.value as ColumnFilters["confidence"],
              )
            }
          >
            <option value="">All</option>
            {(["anomaly","cause","loss"] as const).map(key=><optgroup key={key} label={key}>{["Unknown","Low","Moderate","High"].map(level=><option key={level} value={`${key}:${level}`}>{key}: {level}</option>)}</optgroup>)}
          </select>
        );
      case "equipmentName":
        return (
          <input
            aria-label="Filter equipment"
            value={filters.equipmentName}
            onChange={(event) =>
              updateFilter("equipmentName", event.target.value)
            }
            placeholder="Name or ID…"
          />
        );
      case "severity":
        return (
          <select
            aria-label="Filter severity"
            value={filters.severity}
            onChange={(event) =>
              updateFilter(
                "severity",
                event.target.value as ColumnFilters["severity"],
              )
            }
          >
            <option value="">All</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
          </select>
        );
      case "startDateTime":
        return (
          <input
            className="date-filter"
            aria-label="Filter start date and time"
            inputMode="numeric"
            value={filters.startDateTime}
            onChange={(event) =>
              updateFilter("startDateTime", event.target.value)
            }
            placeholder="YYYY/MM/DD H:MM"
            title="Event originally started on or after · YYYY/MM/DD H:MM. Use Reporting period for overlapping events."
          />
        );
      case "endDateTime":
        return (
          <input
            className="date-filter"
            aria-label="Filter end date and time"
            inputMode="numeric"
            value={filters.endDateTime}
            onChange={(event) =>
              updateFilter("endDateTime", event.target.value)
            }
            placeholder="YYYY/MM/DD H:MM"
            title="Event originally ended on or before · YYYY/MM/DD H:MM. Use Reporting period for overlapping events."
          />
        );
      case "durationMinutes":
        return (
          <input
            aria-label="Filter minimum duration in hours"
            type="number"
            min="0"
            step="0.25"
            value={filters.durationHours}
            onChange={(event) =>
              updateFilter("durationHours", event.target.value)
            }
            placeholder="Min hours"
          />
        );
      case "estimatedLossKwh":
        return (
          <input
            aria-label="Filter minimum estimated loss"
            type="number"
            min="0"
            value={filters.estimatedLossKwh}
            onChange={(event) =>
              updateFilter("estimatedLossKwh", event.target.value)
            }
            placeholder="Min kWh"
          />
        );
      case "lossPercent":
        return (
          <input
            aria-label="Filter minimum loss percentage"
            type="number"
            min="0"
            max="100"
            value={filters.lossPercent}
            onChange={(event) =>
              updateFilter("lossPercent", event.target.value)
            }
            placeholder="Min %"
          />
        );
      case "siteImpactPercent":
        return (
          <input
            aria-label="Filter minimum site impact percentage"
            type="number"
            min="0"
            max="100"
            value={filters.siteImpactPercent}
            onChange={(event) =>
              updateFilter("siteImpactPercent", event.target.value)
            }
            placeholder="Min %"
          />
        );
    }
  }
  function issueCell(column: SortKey, issue: PerformanceIssue) {
    switch (column) {
      case "name":
        return (
          <>
            <strong>{issue.name}</strong>
            <button className="issue-review-button" disabled={!analysisRunId||!issue.eventKey} onClick={()=>setReviewTarget(issues.find(i=>i.id===issue.id)||issue)}>{reviewStatus(issue)} · Review</button>
            {issue.eventKey&&reviews[issue.eventKey]&&<small>{reviews[issue.eventKey].state.classification} · {reviews[issue.eventKey].state.resolution}</small>}
            <small>{issue.description}</small>
            {!!issue.recurringIssueCount && <small>Equipment threshold total: {formatKwh(issue.recurringLossKwh || 0)} across {issue.recurringIssueCount} events in the full analysis period.</small>}
            {maintenance.windows.filter(w=>maintenanceMatch(issues.find(i=>i.id===issue.id)||issue,w)).map(w=><small className="maintenance-match" key={w.id}>{w.state.title} · {maintenanceMatch(issues.find(i=>i.id===issue.id)||issue,w)==="full"?"Maintenance window covers this finding":"Partial maintenance overlap"}</small>)}
            {issue.reportClipped && <small>Reporting-period portion. Original event: {formatDateTime(issue.originalStart || issue.startDateTime, issue.timezone)} – {formatDateTime(issue.originalEnd || issue.endDateTime, issue.timezone)}.</small>}
            {!!issue.affectedEquipment?.length && <details className="affected-equipment"><summary>{issue.affectedEquipment.length} affected inverters</summary><small>{issue.affectedEquipment.map(item => item.name).join(", ")}</small></details>}
          </>
        );
      case "category":
        return (
          <span
            className={`issue-category ${issue.category.toLowerCase().replace(/\s+/g, "-")}`}
          >
            {issue.category}
          </span>
        );
      case "suspectedCause":
        return issue.suspectedCause ? <details className="cause-evidence"><summary>{issue.suspectedCause}</summary><small>{issue.causeExplanation}</small></details> : "";
      case "confidence":
        return <div className="confidence-levels">{Object.entries(confidenceFor(issue)).map(([key,c])=><span key={key} title={c.reason}>{key}: <strong>{c.level}</strong></span>)}</div>;
      case "equipmentName":
        return (
          <>
            <strong className="equipment-name">{issue.equipmentName}</strong>
            <small className="equipment-id">
              {issue.equipmentExternalId} ·{" "}
              {issue.equipmentType.replace(/_/g, " ")}
            </small>
          </>
        );
      case "severity":
        return (
          <span className={`severity ${issue.severity}`}>
            <i />
            {issue.severity}
          </span>
        );
      case "startDateTime":
        return (
          <time dateTime={issue.startDateTime}>
            {formatDateTime(issue.startDateTime, issue.timezone)}
          </time>
        );
      case "endDateTime":
        return (
          <time dateTime={issue.endDateTime}>
            {formatDateTime(issue.endDateTime, issue.timezone)}
          </time>
        );
      case "durationMinutes":
        return formatDuration(issue.durationMinutes);
      case "estimatedLossKwh":
        return (
          <strong className="loss-value">
            {formatKwh(issue.estimatedLossKwh)}
          </strong>
        );
      case "lossPercent":
        if (issue.lossPercent === null) return "Unknown";
        return (
          <div className="loss-percent">
            <strong>
              {issue.lossPercent.toLocaleString(undefined, {
                maximumFractionDigits: 1,
              })}
              %
            </strong>
            <span>
              <i style={{ width: `${Math.min(100, issue.lossPercent)}%` }} />
            </span>
          </div>
        );
      case "siteImpactPercent":
        return (
          <div className="site-impact">
            <strong>
              {issue.siteImpactPercent.toLocaleString(undefined, {
                maximumFractionDigits: 1,
              })}
              %
            </strong>
            <span>
              <i
                style={{ width: `${Math.min(100, issue.siteImpactPercent)}%` }}
              />
            </span>
          </div>
        );
    }
  }
  function csvColumn(column: SortKey, issue?: PerformanceIssue) {
    switch (column) {
      case "name":
        return issue
          ? [issue.name, issue.description, (issue.affectedEquipment || []).map(item => item.name).join(", ")]
          : ["Issue", "Description", "Affected inverters"];
      case "category":
        return issue ? [issue.category] : ["Category"];
      case "suspectedCause":
        return issue ? [issue.suspectedCause || "", issue.causeExplanation || ""] : ["Suspected cause", "Cause evidence"];
      case "confidence":
        return issue ? [confidenceFor(issue).anomaly.level,confidenceFor(issue).cause.level,confidenceFor(issue).loss.level] : ["Observed anomaly confidence","Cause confidence","Loss confidence"];
      case "equipmentName":
        return issue
          ? [
              issue.equipmentName,
              issue.equipmentExternalId,
              issue.equipmentType.replace(/_/g, " "),
            ]
          : ["Equipment", "Equipment ID", "Equipment type"];
      case "severity":
        return issue ? [issue.severity] : ["Severity"];
      case "startDateTime":
        return issue ? [formatDateTime(issue.startDateTime, issue.timezone)] : ["Start"];
      case "endDateTime":
        return issue ? [formatDateTime(issue.endDateTime, issue.timezone)] : ["End"];
      case "durationMinutes":
        return issue
          ? [(issue.durationMinutes / 60).toFixed(2)]
          : ["Duration (hours)"];
      case "estimatedLossKwh":
        return issue
          ? [issue.estimatedLossKwh === null ? "Unknown" : issue.estimatedLossKwh.toFixed(3)]
          : ["Estimated loss (kWh)"];
      case "lossPercent":
        return issue
          ? [issue.lossPercent === null ? "Unknown" : issue.lossPercent.toFixed(2)]
          : ["Loss vs. expected (%)"];
      case "siteImpactPercent":
        return issue
          ? [issue.siteImpactPercent.toFixed(2)]
          : ["Site impacted (%)"];
    }
  }
  function exportIssuesXlsx() {
    if (!performance?.hasData||!reviewsReady) return;
    const rows = [
      issueColumns.flatMap((column) => csvColumn(column.id)),
      ...visibleIssues.map((issue) =>
        issueColumns.flatMap((column) => csvColumn(column.id, issue)),
      ),
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet["!autofilter"] = {
      ref: `A1:${XLSX.utils.encode_col(rows[0].length - 1)}${rows.length}`,
    };
    worksheet["!cols"] = rows[0].map((_, columnIndex) => ({
      wch: Math.min(
        42,
        Math.max(
          12,
          ...rows.map((row) => String(row[columnIndex] ?? "").length + 2),
        ),
      ),
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Performance Issues");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Reporting from", reportRange.from || "All dates"], ["Reporting through (inclusive)", reportRange.through || "All dates"], ["Timezone", reportTimezone], ["Allocation", "Overlapping events; interval losses within the selected dates. Unknown allocations are excluded from quantified totals."]]), "Reporting period");
    appendReportMethodology(workbook,{...reportContext,issues:visibleIssues});
    const siteName =
      (activeSite?.name || "site")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "site";
    XLSX.writeFile(
      workbook,
      `${siteName}-performance-issues-${new Date().toISOString().slice(0, 10)}.xlsx`,
      { compression: true },
    );
  }
  function updateField(field: keyof GeneralConfig, value: string) {
    if (field === "zip" || field === "country") setZipStatus("");
    setForm((current) => ({ ...current, [field]: value }));
  }
  function selectSettingsSite(siteId: string) {
    setCreatingSite(false);
    setSettingsSiteId(siteId);
    setForm(configs[siteId]);
  }
  function startNewSite() {
    setCreatingSite(true);
    setSettingsSiteId("");
    setForm(blankConfig());
    setZipStatus("");
  }
  function discardSettings() {
    if (creatingSite) {
      const fallback = configs[activeSiteId] || Object.values(configs)[0];
      if(!fallback){startNewSite();return;}
      setCreatingSite(false);
      setSettingsSiteId(fallback.id);
      setForm(fallback);
    } else setForm(configs[settingsSiteId]);
  }
  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("/api/site-settings", {
        method: creatingSite ? "POST" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to save settings");
      setConfigs((current) => ({ ...current, [data.site.id]: data.site }));
      setSettingsSiteId(data.site.id);
      setForm(data.site);
      if (creatingSite) {
        setCreatingSite(false);
        setActiveSiteId(data.site.id);
        setPerformance(null);
        notify(`${data.site.name} added`);
      } else notify(`${data.site.name} settings saved`);
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Unable to save settings",
      );
    } finally {
      setSaving(false);
    }
  }
  async function saveUserSettings(event: FormEvent) {
    event.preventDefault();
    if(!userSettingsReady)return;
    setSavingUser(true);
    try {
      const response = await fetch("/api/user-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({firstName:userForm.firstName,lastName:userForm.lastName,title:userForm.title,theme:userForm.theme,minimumIssueLossKwh:userForm.minimumIssueLossKwh}),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to save user settings");
      setUser(data.user);
      setUserForm(data.user);
      if(data.user.minimumIssueLossKwh!==user.minimumIssueLossKwh){
        performanceCacheRef.current.clear();setPerformance(null);setPerformanceRevision(value=>value+1);
      }
      notify("User settings saved");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "Unable to save user settings",
      );
    } finally {
      setSavingUser(false);
    }
  }

  async function saveIssueVisibility(issueVisibility:IssueVisibility){
    const response=await fetch('/api/user-settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({issueVisibility})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Unable to save issue visibility.');
    const saved={...data.user,issueVisibility:normalizeIssueVisibility(data.user.issueVisibility)};
    setUser(saved);setUserForm(current=>({...current,issueVisibility:saved.issueVisibility}));
    notify('Issue visibility saved.');
  }

  const reviewControls=<div className="review-reporting-controls">
    <div className="review-toolbar"><label>Analyst review<select value={reviewFilter} onChange={e=>setReviewFilter(e.target.value)}>{["Exclude dismissed","All findings","Confirmed","Unreviewed","Needs review","Dismissed"].map(v=><option key={v} value={v}>{v==="Exclude dismissed"?"Reported findings (excludes dismissed)":v==="All findings"?"All findings (audit view)":v==="Dismissed"?"Dismissed (audit view)":v}</option>)}</select></label>
      <div className="review-counts">{["Confirmed","Unreviewed","Needs review","Dismissed"].map(status=>{const matched=enabledPeriodIssues.filter(i=>reviewStatus(i)===status);return <span key={status}><strong>{status}: {reviewsReady?matched.length:"—"}</strong>{reviewsReady?formatKwh(matched.reduce((n,i)=>n+(i.estimatedLossKwh||0),0)):"Loading…"}</span>;})}</div>
      <button className="secondary-btn" onClick={()=>goTo('issue-visibility')}>Issue visibility{hiddenTypeCount?` · ${hiddenTypeCount} hidden ${hiddenTypeCount===1?'type':'types'}`:''}</button>
    </div>
    {reviewsReady?<p className="review-loss-treatment">Reporting period, enabled issue types, before table filters: <strong>{formatKwh(reviewTotals.adjusted)} after review</strong> · {formatKwh(reviewTotals.dismissed)} dismissed · {formatKwh(reviewTotals.detected)} originally detected. Included provisional loss: {formatKwh(reviewTotals.provisional)} (unreviewed or needs review). Resolved issues retain their historical loss.{(reviewFilter==="All findings"||reviewFilter==="Dismissed")&&<strong> Audit view: displayed losses include dismissed findings.</strong>}</p>:<p className="review-loss-treatment" role="status">{!userSettingsReady?'Saved issue visibility preferences must load before findings and exports are available.':reviewError?`Reviews unavailable: ${reviewError}. Review-adjusted totals and exports are unavailable until reviews load.`:"Loading analyst decisions before showing reported losses…"}</p>}
    {reviewsReady&&hiddenTypeCount>0&&<div className="issue-visibility-notice" role="status"><p><strong>{visibilityHidden.count.toLocaleString()} findings hidden · {formatKwh(visibilityHidden.knownLossKwh)} known loss</strong>{visibilityHidden.unknownLossCount>0&&` · ${visibilityHidden.unknownLossCount} with unknown loss`}. Within the reporting period and analyst review filter, before table filters. Hidden findings remain in the analysis.</p></div>}
  </div>;
  function selectFindings(ids:string[],checked:boolean){
    const allowed=new Set(visibleIssues.map(i=>i.id));
    const next=checked?[...new Set([...selectedFindings,...ids.filter(id=>allowed.has(id))])]:selectedFindings.filter(id=>!ids.includes(id));
    if(next.length>500){notify("Select up to 500 findings per action. Your selection was not changed.");return;}setSelectedFindings(next);
  }
  function selectInverterGroup(equipmentId:string,ids:string[]){
    const next=replaceInverterSelection(selectedFindings,visibleIssues,equipmentId,ids);
    if(!next){notify("Select up to 500 findings per action. Your selection was not changed.");return false;}
    setSelectedFindings(next);return true;
  }
  function savedBulkReviews(rows:(IssueReview&{eventKey:string})[],retrievedAt=new Date().toISOString()){
    if(currentReviewScope.current!==`${activeSiteId}:${analysisRunId}`)return;
    setReviews(current=>{const next={...current};for(const row of rows)next[row.eventKey]=row;return next;});setReviewsRetrievedAt(retrievedAt);
  }
  function savedReview(result:SavedIssueReview,advance=false){
    if(currentReviewScope.current!==`${activeSiteId}:${analysisRunId}`)return;
    const next=advance?nextReviewFinding(visibleIssues,reviewTarget?.id||'',reviews):undefined;
    savedBulkReviews(result.reviews,result.retrievedAt);
    setReviewTarget(next?(issues.find(i=>i.id===next.id)||next):null);
    notify(result.review.state.status==="Dismissed"?"Finding dismissed and excluded from reported loss.":"Review saved.");
  }

  return (
    <main data-theme={activeTheme} className={`app-shell ${sidebarCollapsed ? "sidebar-is-collapsed" : ""}`}>
      <header className="mobile-header" inert={isMobile && mobileMenuOpen}>
        <div><strong>Sol Diagnostics</strong><span>{({ map: "Map", issues: "Performance issues", summaries: "Summaries", timeline: "Timeline", uploads: "Performance data", "maintenance-uploads":"Maintenance data", settings: "Site settings", array: "Array model", user: "User settings", "issue-visibility":"Issue visibility" })[view]}</span></div>
        <button ref={menuButtonRef} className="mobile-menu-button" aria-label="Open navigation menu" aria-controls="site-navigation" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(true)}><span aria-hidden="true">☰</span> Menu</button>
      </header>
      {isMobile && mobileMenuOpen && <div className="mobile-nav-backdrop" aria-hidden="true" onClick={() => setMobileMenuOpen(false)} />}
      <aside id="site-navigation" ref={navigationRef} className={`sidebar ${sidebarCollapsed ? "collapsed" : ""} ${mobileMenuOpen ? "mobile-open" : ""}`}
        inert={isMobile && !mobileMenuOpen} role={isMobile && mobileMenuOpen ? "dialog" : undefined}
        aria-modal={isMobile && mobileMenuOpen ? true : undefined} aria-label="Site navigation">
        <button className="mobile-menu-close" aria-label="Close navigation menu" onClick={() => setMobileMenuOpen(false)}>×</button>
        <button
          className="sidebar-toggle"
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!sidebarCollapsed}
          onClick={() => setSidebarCollapsed((value) => !value)}
        >
          {sidebarCollapsed ? "›" : "‹"}
        </button>
        <div className="brand" aria-label="Sol Diagnostics">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span className="brand-copy">
            <strong>SOL</strong>
            <small>DIAGNOSTICS</small>
          </span>
        </div>
        <nav aria-label="Primary navigation">
          <button
            className={`nav-item ${view === "map" ? "active" : ""}`}
            onClick={() => goTo("map")}
          >
            <span>01</span> Map
          </button>
          <div
            className={`nav-group ${view === "issues" || view === "timeline" || view === "summaries" ? "active" : ""}`}
          >
            <button
              className="nav-item nav-parent"
              aria-expanded={issuesMenuOpen}
              onClick={() => {
                if (sidebarCollapsed) {
                  setSidebarCollapsed(false);
                  setIssuesMenuOpen(true);
                } else setIssuesMenuOpen((value) => !value);
              }}
            >
              <span>02</span> Issues
              <i className="nav-chevron">{issuesMenuOpen ? "⌄" : "›"}</i>
            </button>
            {issuesMenuOpen && (
              <div className="nav-children">
                <button
                  className={`nav-sub-item ${view === "issues" ? "active" : ""}`}
                  onClick={() => goTo("issues")}
                >
                  <span>I</span> Performance issues
                </button>
                <button
                  className={`nav-sub-item ${view === "summaries" ? "active" : ""}`}
                  onClick={() => goTo("summaries")}
                >
                  <span>Σ</span> Summaries
                </button>
                <button
                  className={`nav-sub-item ${view === "timeline" ? "active" : ""}`}
                  onClick={() => goTo("timeline")}
                >
                  <span>↔</span> Timeline
                </button>
              </div>
            )}
          </div>
          <div className={`nav-group ${view==='uploads'||view==='maintenance-uploads'?'active':''}`}>
            <button className="nav-item nav-parent" aria-expanded={uploadsMenuOpen} onClick={()=>{if(sidebarCollapsed){setSidebarCollapsed(false);setUploadsMenuOpen(true);}else setUploadsMenuOpen(value=>!value);}}><span>03</span> Data uploads<i className="nav-chevron">{uploadsMenuOpen?'⌄':'›'}</i></button>
            {uploadsMenuOpen&&<div className="nav-children"><button className={`nav-sub-item ${view==='uploads'?'active':''}`} onClick={()=>goTo('uploads')}><span>P</span>Performance data</button><button className={`nav-sub-item ${view==='maintenance-uploads'?'active':''}`} onClick={()=>goTo('maintenance-uploads')}><span>M</span>Maintenance data</button></div>}
          </div>
          <div
            className={`nav-group ${view === "array" || view === "settings" ? "active" : ""}`}
          >
            <button
              className="nav-item nav-parent"
              aria-expanded={sitesMenuOpen}
              onClick={() => {
                if (sidebarCollapsed) {
                  setSidebarCollapsed(false);
                  setSitesMenuOpen(true);
                } else setSitesMenuOpen((value) => !value);
              }}
            >
              <span>04</span> Site configuration{" "}
              <i className="nav-chevron">{sitesMenuOpen ? "⌄" : "›"}</i>
            </button>
            {sitesMenuOpen && (
              <div className="nav-children">
                <button
                  className={`nav-sub-item ${view === "settings" ? "active" : ""}`}
                  onClick={() => goTo("settings")}
                >
                  <span>S</span> Site settings
                </button>
                <button
                  className={`nav-sub-item ${view === "array" ? "active" : ""}`}
                  onClick={() => goTo("array")}
                >
                  <span>A</span> Array model
                </button>
              </div>
            )}
          </div>
          <div className={`nav-group ${view==='user'||view==='issue-visibility'?'active':''}`}>
            <button className="nav-item nav-parent" aria-expanded={userMenuOpen} onClick={()=>{if(sidebarCollapsed){setSidebarCollapsed(false);setUserMenuOpen(true);}else setUserMenuOpen(open=>!open);}}><span>05</span> User Settings<i className="nav-chevron">{userMenuOpen?'⌄':'›'}</i></button>
            {userMenuOpen&&<div className="nav-children"><button className={`nav-sub-item ${view==='user'?'active':''}`} onClick={()=>goTo('user')}><span>P</span> Profile & preferences</button><button className={`nav-sub-item ${view==='issue-visibility'?'active':''}`} onClick={()=>goTo('issue-visibility')}><span>V</span> Issue visibility</button></div>}
          </div>
        </nav>
        <div className="sidebar-foot">
          <div className="mini-weather">
            <span className="weather-sun">
              {performance?.hasData ? "◎" : "○"}
            </span>
            <div>
              <strong>
                {performance?.hasData
                  ? userSettingsReady?`${enabledAnalysisIssues.length} issue${enabledAnalysisIssues.length === 1 ? "" : "s"} ${hiddenTypeCount?'shown':'detected'}`:'Loading issue visibility…'
                  : "Awaiting site data"}
              </strong>
              <small>
                {performance?.hasData
                  ? `Analyzed through ${formatDate(performance.summary.latestDate)}`
                  : "Import telemetry to begin"}
              </small>
            </div>
          </div>
          <div className="user">
            <span className="avatar">{userInitials(user)}</span>
            <div>
              <strong>{`${user.firstName} ${user.lastName}`.trim()}</strong>
              <small>{user.title || "Title not set"}</small>
            </div>
            <button aria-label="Open user settings" onClick={() => goTo("user")}>
              •••
            </button>
          </div>
        </div>
      </aside>

      <section className="workspace" inert={isMobile && mobileMenuOpen}>
        {userSettingsError&&view!=='issue-visibility'&&<div className="issue-visibility-notice" role="alert"><p>Unable to load saved user preferences: {userSettingsError}</p><button className="secondary-btn" onClick={()=>setUserSettingsRevision(value=>value+1)}>Retry loading preferences</button></div>}
        {view === "map" ? (
          <SiteMap sites={Object.values(configs)} />
        ) : view === "issues" ? (
          <>
            <header className="topbar diagnostic-header">
              <div>
                <p className="eyebrow">SITE DIAGNOSTICS</p>
                <h1>{activeSite?.name || "Site"}</h1>
                <p className="site-descriptor">
                  {activeSite?.location} <i>•</i>{" "}
                  {performance?.capacityKw
                    ? `${performance.capacityKw.toLocaleString(undefined, { maximumFractionDigits: 1 })} kWac modeled capacity`
                    : "Complete the array model to capacity-adjust analysis"}
                </p>
              </div>
              <div className="top-actions">
                <label className="region-select">
                  <span>ANALYSIS SITE</span>
                  <select
                    value={activeSiteId}
                    onChange={(event) => {
                      setPerformance(performanceCacheRef.current.get(event.target.value)?.data || null);
                      setActiveSiteId(event.target.value);
                    }}
                  >
                    {managedSites.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name}{sitesWithPerformanceData.has(site.id) ? " ✅" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {performance?.hasData && <button className="secondary-btn" disabled={Boolean(analysisAction)||!!selectedRunId} onClick={() => void reanalyze()}>Reanalyze current history</button>}
                <button className="primary-btn" onClick={() => goTo("uploads")}>
                  Import performance data <span>↗</span>
                </button>
              </div>
            </header>
            {(performance?.analysis.thresholdExcludedLossKwh || 0) > 0 && <div className="status-strip analysis-period-note" role="status"><strong>Full analysis period (all issue types):</strong> {formatKwh(performance!.analysis.unfilteredTotalLossKwh ?? performance!.analysis.totalLossKwh)}; {formatKwh(performance!.analysis.thresholdExcludedLossKwh!)} excluded by your issue threshold.</div>}
            <AnalysisHistory siteId={activeSiteId} runId={selectedRunId} onChange={runId=>setAnalysisSelection({siteId:activeSiteId,runId})} revision={analysisRunId}/>
            <ReportingPeriod range={reportRange} onChange={setReportRange} timezone={reportTimezone} />
            {visibility.inverterUnderperformance && performance?.hasData && performance.analysis.inverterExpectation && <div className="status-strip analysis-period-note" role="status"><strong>Inverter baseline:</strong> {performance.analysis.inverterExpectation.message}</div>}
            {visibility.inverterUnderperformance && performance?.hasData && performance.analysis.peerComparison?.referenceQualification && <div className="status-strip analysis-period-note" role="status"><strong>Optional peer evidence:</strong> {performance.analysis.peerComparison.referenceQualification.message}</div>}
            {reviewControls}
            <ReviewWorkbench showRecurring={visibility.inverterUnderperformance} key={`${activeSiteId}:${analysisRunId}`} siteId={activeSiteId} runId={analysisRunId} visible={visibleIssues} originals={issues} episodes={recurringIssues} reviews={reviews} selected={selectedFindings} onSelect={selectFindings} onReplace={selectInverterGroup} filterScope={JSON.stringify([filters,reportRange,reviewFilter,visibility])} onClear={()=>setSelectedFindings([])} onUpdated={savedBulkReviews} onReview={openReview} readOnly={!!selectedRunId||!reviewsReady} maintenance={maintenance}/>
            {(reportRange.from || reportRange.through) && reportIssues.some(issue => issue.reportClipped && issue.estimatedLossKwh === null) && <p role="status">Some overlapping issues lack reliable interval loss evidence. Their loss within this reporting period is shown as Unknown; reanalyze the latest upload to refresh the evidence.</p>}
            <div
              className={`status-strip ${performance?.hasData ? "" : "empty"}`}
            >
              <span className="live-dot" />{" "}
              {performance === null
                ? analysisLoadMode === "analyzing"
                  ? "Analyzing the latest import…"
                  : "Loading saved analysis…"
                : performance.hasData
                  ? `Analysis complete through ${formatDate(performance.summary.latestDate)}`
                  : "No analysis available"}
              <span>
                {performance?.hasData
                  ? `${performance.summary.readingCount.toLocaleString()} readings · ${performance.import.fileName}`
                  : performance?.error ||
                    performance?.reason ||
                    "Upload mapped telemetry to identify losses"}
              </span>
            </div>

            <section
              className="metric-grid issue-metrics"
              aria-label="Issue analysis summary"
            >
              <article className="metric-card featured">
                <div className="metric-head">
                  <span>{reviewFilter==="All findings"||reviewFilter==="Dismissed"?"DETECTED FINDINGS (AUDIT)":"REPORTED FINDINGS"}</span>
                </div>
                <strong>
                  {performance?.hasData ? visibleIssueMetrics.count : "—"}
                </strong>
                <p>
                  {performance?.hasData
                    ? `${visibleIssueMetrics.critical} critical · ${visibleIssueMetrics.high} high priority${hasFilters ? " · filtered" : ""}`
                    : "No production data analyzed"}
                </p>
              </article>
              <article className="metric-card loss-metric">
                <div className="metric-head">
                  <span>{reviewFilter==="All findings"||reviewFilter==="Dismissed"?"DETECTED ENERGY LOSS (AUDIT)":"REPORTED ENERGY LOSS"}</span>
                </div>
                <strong>
                  {performance?.hasData && reviewsReady
                    ? formatEnergy(visibleIssueMetrics.lossKwh)
                    : "—"}
                </strong>
                <p>
                  {hasFilters
                    ? "Quantified matching losses; unknown losses excluded"
                    : "Quantified losses; unknown telemetry losses excluded"}
                </p>
              </article>
              <article className="metric-card">
                <div className="metric-head">
                  <span>AFFECTED DAYS</span>
                </div>
                <strong>
                  {performance?.hasData
                    ? visibleIssueMetrics.affectedDays
                    : "—"}
                </strong>
                <p>
                  {performance?.hasData
                    ? `Full analysis: ${performance.analysis.analyzedIntervals.toLocaleString()} qualified ${performance.analysis.analysisIntervalMinutes}-minute intervals · ${performance.analysis.skippedLowIrradianceIntervals.toLocaleString()} low-light intervals excluded`
                    : "Analysis period not available"}
                </p>
              </article>
            </section>

            <section
              className="panel issues-panel"
              aria-labelledby="issues-heading"
            >
              <div className="panel-head issue-panel-head">
                <div>
                  <p className="eyebrow">PRIORITIZED FINDINGS</p>
                  <h2 id="issues-heading">Performance issues</h2>
                  <p className="table-help">
                    Use any combination of filters. Drag the <b>⋮⋮</b> handle to
                    reposition a column. On touchscreens, use the column order controls. Swipe tables to see all fields.
                  </p>
                </div>
                <div className="table-actions">
                  <span>
                    {issueRows.length} review items · {visibleIssues.length} of {enabledAnalysisIssues.length} enabled occurrences
                    {activeFilterCount
                      ? ` · ${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"} active`
                      : ""}
                    {performance?.analysis.issueLossThresholdKwh != null
                      ? ` · individual or recurring losses above ${formatKwh(performance.analysis.issueLossThresholdKwh)} shown`
                      : ""}
                  </span>
                  <button
                    className="secondary-btn export-btn"
                    onClick={exportIssuesXlsx}
                    disabled={!performance?.hasData||!reviewsReady}
                    title="Export the currently visible performance issues in the displayed column order"
                  >
                    Export XLSX <b aria-hidden="true">↓</b>
                  </button>
                  <button
                    className="secondary-btn"
                    onClick={clearFilters}
                    disabled={!hasFilters}
                  >
                    Clear filters
                  </button>
                </div>
              </div>
              <details className="mobile-column-order">
                <summary>Column order</summary>
                <ol>{issueColumns.map((column, index) => <li key={column.id}><span>{column.label}</span><button aria-label={`Move ${column.label} earlier`} disabled={index === 0} onClick={() => reorderColumn(column.id, issueColumns[index - 1].id, false)}>↑</button><button aria-label={`Move ${column.label} later`} disabled={index === issueColumns.length - 1} onClick={() => reorderColumn(column.id, issueColumns[index + 1].id, true)}>↓</button></li>)}</ol>
              </details>
              {analysisState && !performance?.hasData ? (
                <div className="performance-empty" aria-live="polite">
                  <strong>{analysisState.status === "canceling" || analysisAction === "cancel" ? "Canceling analysis…"
                    : analysisState.status === "canceled" ? "Analysis canceled"
                    : analysisState.status === "failed" ? "Analysis failed"
                    : analysisState.status === "interrupted" ? "Analysis interrupted"
                    : analysisState.label}</strong>
                  <p>{analysisState.status === "canceling" ? "Stopping at the next processing checkpoint."
                    : analysisState.status === "canceled" ? "Your uploaded file is retained. You can retry without uploading it again."
                    : analysisState.error || performance?.error || (analysisWaiting ? "Waiting for the existing analysis step to finish." : "Progress reflects completed work, not estimated time remaining.")}</p>
                  <div className="analysis-progress" role="progressbar" aria-label="Analysis work completed"
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={analysisState.percent}
                    aria-valuetext={`${analysisState.label}: ${analysisState.completed} of ${analysisState.total}`}>
                    <span style={{ width: `${analysisState.percent}%` }} />
                  </div>
                  <small>{analysisState.percent}% complete{analysisState.total > 0 && ["read", "equipment", "save"].includes(analysisState.stage)
                    ? ` · ${analysisState.completed.toLocaleString()} of ${analysisState.total.toLocaleString()} ${analysisState.stage === "read" ? "rows" : analysisState.stage === "equipment" ? "equipment items" : "issue records"}` : ""}</small>
                  <div className="analysis-actions">
                    {["processing", "canceling"].includes(analysisState.status) && <button className="secondary-btn"
                      disabled={Boolean(analysisAction) || analysisState.status === "canceling"}
                      onClick={() => void controlAnalysis("cancel")}>{analysisAction === "cancel" || analysisState.status === "canceling" ? "Canceling…" : "Cancel analysis"}</button>}
                    {["canceled", "failed", "interrupted"].includes(analysisState.status) && <button className="secondary-btn"
                      disabled={Boolean(analysisAction)} onClick={() => void controlAnalysis("retry")}>Retry analysis</button>}
                    {performance?.error && analysisState.status === "processing" && <button className="secondary-btn"
                      onClick={() => setPerformanceRevision(value => value + 1)}>Resume analysis</button>}
                  </div>
                  {analysisControlError && <p role="alert">{analysisControlError}</p>}
                </div>
              ) : performance === null ? (
                <div className="performance-empty">
                  <span>⌁</span>
                  <strong>
                    {analysisLoadMode === "analyzing"
                      ? "Analyzing new site data"
                      : "Loading saved analysis"}
                  </strong>
                  <p>
                    {analysisLoadMode === "analyzing"
                      ? "The latest retained telemetry is being compared with the configured array model and mapped irradiance."
                      : "Retrieving this site’s stored JSON analysis for the issues, summaries, and timeline views."}
                  </p>
                  <small>{analysisLoadMode === "analyzing" ? "Preparing analysis…" : "Checking for saved results or an active analysis…"}</small>
                </div>
              ) : !performance.hasData ? (
                <div className="performance-empty">
                  <span>↥</span>
                  <strong>{performance.error ? "Analysis could not complete" : "Import performance data to begin"}</strong>
                  <p>
                    {performance.error ||
                      performance.reason ||
                      "Map energy or power signals to array-model equipment so the site can identify anomalies and quantify losses."}
                  </p>
                  {performance.error && <button className="secondary-btn empty-action" onClick={() => setPerformanceRevision(value => value + 1)}>Retry loading analysis</button>}
                  <button
                    className="secondary-btn empty-action"
                    onClick={() => goTo("uploads")}
                  >
                    Open performance data
                  </button>
                </div>
              ) : !performance.analysis.irradianceAvailable &&
                !issues.length ? (
                <div className="performance-empty">
                  <span>☼</span>
                  <strong>Map irradiance data to analyze losses</strong>
                  <p>
                    POA or GHI irradiance is required so low-light periods are
                    not mistaken for equipment issues. Revenue-meter
                    communication checks remain active without irradiance.
                  </p>
                  <button
                    className="secondary-btn empty-action"
                    onClick={() => goTo("uploads")}
                  >
                    Open performance data
                  </button>
                </div>
              ) : !issues.length ? (
                <div className="performance-empty">
                  <span>✓</span>
                  <strong>
                    {performance.analysis.suppressedByLossThreshold
                      ? "No issues or recurring groups exceed your loss threshold"
                      : "No material issues detected"}
                  </strong>
                  <p>
                    {performance.analysis.suppressedByLossThreshold
                      ? `${performance.analysis.suppressedByLossThreshold.toLocaleString()} issue${performance.analysis.suppressedByLossThreshold === 1 ? " was" : "s were"} excluded by the ${formatKwh(performance.analysis.issueLossThresholdKwh || 0)} individual/recurring loss threshold.`
                      : "No material findings were identified by the available analysis checks. Review reference coverage and data quality before interpreting this as normal performance."}
                  </p>
                  {performance.analysis.suppressedByLossThreshold > 0 && (
                    <button
                      className="secondary-btn empty-action"
                      onClick={() => goTo("user")}
                    >
                      Open user setup
                    </button>
                  )}
                </div>
              ) : !visibleIssues.length ? (
                <div className="performance-empty compact">
                  <span>○</span>
                  <strong>{reviewsReady?"No matching issues":"Loading analyst reviews"}</strong>
                  <p>
                    {reviewsReady?"Adjust issue visibility, the reporting period, analyst review filter, or column filters to see other findings. Dismissed findings remain available in the audit view.":"Reported losses will appear after saved preferences and analyst decisions are loaded."}
                  </p>
                  {reviewsReady&&reviewFilter!=="All findings"&&<button className="secondary-btn empty-action" onClick={()=>setReviewFilter("All findings")}>View all findings (audit)</button>}
                  {hiddenTypeCount>0&&<button className="secondary-btn empty-action" onClick={()=>goTo('issue-visibility')}>Manage issue visibility</button>}
                  <button
                    className="secondary-btn empty-action"
                    onClick={() => { clearFilters(); setReportRange({ from: "", through: "" }); }}
                  >
                    Clear report and filters
                  </button>
                </div>
              ) : (
                <div className="table-wrap issue-table-wrap" role="region" aria-label="Performance issues, scroll horizontally for more columns" tabIndex={0}>
                  <table className="issue-table">
                    <thead>
                      <tr className="sort-row">
                        <th className="issue-select-column"><input type="checkbox" aria-label="Select all findings on this page" disabled={!!selectedRunId||!reviewsReady} checked={pageOccurrenceIds.length>0&&pageOccurrenceIds.every(id=>selectedFindings.includes(id))} onChange={e=>selectFindings(pageOccurrenceIds,e.target.checked)}/></th>
                        {issueColumns.map((column) => (
                          <th
                            key={column.id}
                            className={`issue-column-${column.id} ${dropColumn === column.id && draggedColumn !== column.id ? "drop-target" : ""}`}
                            aria-sort={
                              sort.key === column.id
                                ? sort.direction === "asc"
                                  ? "ascending"
                                  : "descending"
                                : "none"
                            }
                            onDragOver={(event) => {
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                              setDropColumn(column.id);
                            }}
                            onDrop={(event) =>
                              finishColumnDrop(column.id, event)
                            }
                          >
                            <div className="column-heading">
                              <span
                                className="column-drag-handle"
                                draggable
                                title={`Drag to move ${column.label} column`}
                                aria-label={`Move ${column.label} column. Use left and right arrow keys or drag with a mouse.`}
                                role="button"
                                tabIndex={0}
                                onDragStart={(event) =>
                                  startColumnDrag(column.id, event)
                                }
                                onDragEnd={() => {
                                  setDraggedColumn(null);
                                  setDropColumn(null);
                                }}
                                onKeyDown={(event) =>
                                  moveColumnWithKeyboard(column.id, event)
                                }
                              >
                                ⋮⋮
                              </span>
                              <button onClick={() => toggleSort(column.id)}>
                                {column.label}{" "}
                                <span>{sortIndicator(column.id)}</span>
                              </button>
                            </div>
                          </th>
                        ))}
                      </tr>
                      <tr className="filter-row">
                        <th className="issue-select-column"><span className="selection-column-label">Select</span></th>
                        {issueColumns.map((column) => (
                          <th
                            key={column.id}
                            className={`issue-column-${column.id}`}
                          >
                            {filterControl(column.id)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map(({issue,group}) => group ? <RecurringTableGroup key={group.id} group={group} columns={issueColumns} renderCell={issueCell} reviews={reviews} onReview={openReview} selected={selectedFindings} onSelect={selectFindings} readOnly={!!selectedRunId||!reviewsReady}/> : (
                        <tr key={issue.id}>
                          <td className="issue-select-column"><input type="checkbox" aria-label={`Select ${issue.equipmentName} ${issue.type} ${issue.startDateTime}`} disabled={!!selectedRunId||!reviewsReady} checked={selectedFindings.includes(issue.id)} onChange={e=>selectFindings([issue.id],e.target.checked)}/></td>
                          {issueColumns.map((column) => (
                            <td
                              key={column.id}
                              className={`issue-column-${column.id}`}
                            >
                              {issueCell(column.id, issue)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {issueRows.length>100&&<div className="review-toolbar"><button className="secondary-btn" disabled={!issuePage} onClick={()=>setIssuePage(p=>p-1)}>Previous</button><span>Page {issuePage+1} of {Math.ceil(issueRows.length/100)} · exports include all filtered findings</span><button className="secondary-btn" disabled={(issuePage+1)*100>=issueRows.length} onClick={()=>setIssuePage(p=>p+1)}>Next</button></div>}
              {performance?.hasData && (
                <footer className="analysis-method">
                  <span>METHOD</span>
                  <p>{performance.analysis.baselineMethod}</p>
                </footer>
              )}
            </section>
          </>
        ) : view === "timeline" ? (
          <IssueTimeline
            key={activeSiteId}
            siteId={activeSiteId}
            sites={managedSites}
            onSiteChange={setActiveSiteId}
            reportRange={reportRange}
            timezone={reportTimezone}
            maintenanceRevision={maintenanceRevision}
            episodes={recurringIssues}
            issues={reportIssues}
            reportingPeriod={<><ReportingPeriod range={reportRange} onChange={setReportRange} timezone={reportTimezone} />{reviewControls}</>}
            siteName={activeSite?.name || "Site"}
            onBack={() => goTo("issues")}
          />
        ) : view === "summaries" ? (
          <IssueSummaries
            reportContext={reportContext}
            issues={reportIssues}
            reportRange={reportRange}
            timezone={reportTimezone}
            reportingPeriod={<><ReportingPeriod range={reportRange} onChange={setReportRange} timezone={reportTimezone} />{reviewControls}</>}
            siteName={activeSite?.name || "Site"}
            onBack={() => goTo("issues")}
          />
        ) : view === "array" ? (
          <ArrayConfiguration
            sites={managedSites}
            onVerificationChange={updateSiteVerification}
            initialSiteId={activeSiteId}
            onBack={() => goTo("issues")}
            notify={notify}
            onSaved={(siteId) => {
              performanceCacheRef.current.delete(siteId);
              if (siteId !== activeSiteId) return;
              pendingAnalysisSiteRef.current = siteId;
              setPerformance(null);
              setPerformanceRevision((value) => value + 1);
            }}
          />
        ) : view === "maintenance-uploads" ? (
          <MaintenanceUploads sites={managedSites} notify={notify} onImported={()=>setMaintenanceRevision(value=>value+1)} onTimeline={siteId=>{setActiveSiteId(siteId);goTo('timeline');}}/>
        ) : view === "uploads" ? (
          <TelemetryUploads
            sites={managedSites}
            initialSiteId={activeSiteId}
            onBack={() => goTo("issues")}
            notify={notify}
            onImported={(siteId) => {
              setAnalysisSelection({siteId,runId:""});
              setSitesWithPerformanceData(current => new Set([...current, siteId]));
              performanceCacheRef.current.delete(siteId);
              pendingAnalysisSiteRef.current = siteId;
              setPerformance(null);
              setActiveSiteId(siteId);
              setPerformanceRevision((value) => value + 1);
              goTo("issues");
            }}
          />
        ) : view === "issue-visibility" ? (
          <IssueVisibilitySettings value={visibility} ready={userSettingsReady} error={userSettingsError} onRetry={()=>setUserSettingsRevision(value=>value+1)} onSave={saveIssueVisibility} onBack={()=>goTo('user')}/>
        ) : view === "user" ? (
          <section
            className="settings-view user-setup-view"
            aria-labelledby="user-setup-title"
          >
            <header className="settings-header">
              <div>
                <p className="eyebrow">USER SETTINGS</p>
                <h1 id="user-setup-title">Profile & preferences</h1>
                <p>
                  Manage your profile, workspace theme, and performance issue logging.
                </p>
              </div>
              <div className="settings-header-actions">
                <button
                  className="secondary-btn"
                  onClick={() => goTo("issues")}
                >
                  ← Back to issues
                </button>
              </div>
            </header>
            <div className="user-settings-layout">
              <form
                className="settings-form panel user-settings-form"
                onSubmit={saveUserSettings}
              >
                <div className="form-heading">
                  <div>
                    <p className="eyebrow">PROFILE</p>
                    <h2>User information</h2>
                    <p>These details identify the current diagnostics user.</p>
                  </div>
                  <span className="saved-indicator">
                    <i /> Saved across sessions
                  </span>
                </div>
                <div className="form-grid">
                  <label className="field">
                    <span>
                      First name <em>*</em>
                    </span>
                    <input
                      required
                      maxLength={80}
                      value={userForm.firstName}
                      onChange={(event) =>
                        setUserForm((current) => ({
                          ...current,
                          firstName: event.target.value,
                        }))
                      }
                      placeholder="First name"
                    />
                  </label>
                  <label className="field">
                    <span>
                      Last name <em>*</em>
                    </span>
                    <input
                      required
                      maxLength={80}
                      value={userForm.lastName}
                      onChange={(event) =>
                        setUserForm((current) => ({
                          ...current,
                          lastName: event.target.value,
                        }))
                      }
                      placeholder="Last name"
                    />
                  </label>
                  <label className="field full">
                    <span>Title</span>
                    <input
                      maxLength={120}
                      value={userForm.title}
                      onChange={(event) =>
                        setUserForm((current) => ({
                          ...current,
                          title: event.target.value,
                        }))
                      }
                      placeholder="e.g. Asset Manager"
                    />
                  </label>
                </div>
                <div className="form-divider">
                  <span>APPEARANCE</span>
                  <p>Choose a pre-configured workspace theme.</p>
                </div>
                <div className="form-grid">
                  <label className="field">
                    <span>Theme</span>
                    <select value={userForm.theme || defaultTheme}
                      onChange={event => setUserForm(current => ({ ...current, theme: event.target.value as ThemeId }))}>
                      {themes.map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
                    </select>
                    <small>Preview a theme here. Save your settings to keep it.</small>
                  </label>
                </div>
                <div className="form-divider">
                  <span>ISSUE LOGGING</span>
                  <p>
                    Set the minimum estimated energy loss for an individual issue or recurring inverter underperformance group to appear.
                  </p>
                </div>
                <div className="threshold-settings">
                  <label className="field">
                    <span>Minimum issue loss (kWh)</span>
                    <div className="threshold-input">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={userForm.minimumIssueLossKwh}
                        onChange={(event) =>
                          setUserForm((current) => ({
                            ...current,
                            minimumIssueLossKwh: event.target.value,
                          }))
                        }
                        placeholder="Leave blank to log all issues"
                      />
                      <b>kWh</b>
                    </div>
                    <small>
                      Individual issues or recurring inverter underperformance groups must exceed this value. Recurring losses are combined by inverter and suspected cause across the full analysis period. Communications and unknown-loss telemetry findings remain visible.
                    </small>
                  </label>
                  <div className="threshold-rule">
                    <span>ACTIVE RULE</span>
                    <strong>
                      {thresholdLabel(userForm.minimumIssueLossKwh)}
                    </strong>
                    <small>
                      Every event in a qualifying recurring group remains visible, including events individually below the threshold. Reporting-date filters apply afterward; the group threshold uses the full analysis period.
                    </small>
                  </div>
                </div>
                <footer className="form-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => setUserForm(user)}
                  >
                    Discard changes
                  </button>
                  <button
                    className="primary-btn save-btn"
                    disabled={savingUser||!userSettingsReady}
                  >
                    {savingUser ? "Saving…" : "Save user settings"}
                    <span>✓</span>
                  </button>
                </footer>
              </form>
            </div>
          </section>
        ) : (
          <section className="settings-view" aria-labelledby="settings-title">
            <header className="settings-header">
              <div>
                <p className="eyebrow">SITE CONFIGURATION</p>
                <h1 id="settings-title">Site settings</h1>
                <p>
                  Add sites and manage the identifying and geographic
                  information used by diagnostics.
                </p>
              </div>
              <div className="settings-header-actions">
                <button className="primary-btn" onClick={startNewSite}>
                  + Add site
                </button>
                <button
                  className="secondary-btn"
                  onClick={() => goTo("issues")}
                >
                  ← Back to issues
                </button>
              </div>
            </header>
            <SiteSettingsCsv disabled={saving} onImported={(sites) => {
              const stored = Object.fromEntries(sites.map(site => [site.id, site]));
              setConfigs(stored);
              const selected = stored[settingsSiteId] || sites[0];
              if (selected) { setSettingsSiteId(selected.id); setForm(selected); }
              setCreatingSite(false);
              setActiveSiteId(current => stored[current] ? current : sites[0]?.id || '');
              performanceCacheRef.current.clear(); setPerformance(null); setPerformanceRevision(value => value + 1);
            }} />
            <div className="settings-layout">
              <aside className="site-selector" aria-label="Select a site">
                <div className="selector-title">
                  <span>SITES</span>
                  <b>{managedSites.length}</b>
                </div>
                {managedSites.map((site) => (
                  <button
                    key={site.id}
                    className={
                      !creatingSite && settingsSiteId === site.id
                        ? "active"
                        : ""
                    }
                    onClick={() => selectSettingsSite(site.id)}
                  >
                    <span className="site-initial">
                      {site.name.slice(0, 2).toUpperCase()}
                    </span>
                    <span>
                      <strong>{site.name}</strong>
                      <small>{site.location}</small>
                    </span>
                    <i>›</i>
                  </button>
                ))}
              </aside>
              <form className="settings-form panel" onSubmit={saveSettings}>
                <div className="form-heading">
                  <div>
                    <p className="eyebrow">
                      {creatingSite ? "NEW SITE" : "GENERAL"}
                    </p>
                    <h2>{creatingSite ? "Add a site" : "Site information"}</h2>
                    <p>
                      {creatingSite
                        ? "Create the site record, then configure its array model and upload performance data."
                        : "Core details used to identify and locate this asset."}
                    </p>
                  </div>
                  <span className="saved-indicator">
                    <i />{" "}
                    {creatingSite
                      ? "Ready to create"
                      : "Changes save to this site"}
                  </span>
                </div>
                <div className="form-grid">
                  <label className="field full">
                    <span>
                      Site name <em>*</em>
                    </span>
                    <input
                      required
                      value={form.name}
                      onChange={(event) =>
                        updateField("name", event.target.value)
                      }
                      placeholder="Enter site name"
                    />
                  </label>
                  <label className="field full">
                    <span>Address</span>
                    <input
                      value={form.address}
                      onChange={(event) =>
                        updateField("address", event.target.value)
                      }
                      placeholder="Street address"
                    />
                  </label>
                  <label className="field">
                    <span>Country</span>
                    <select
                      value={form.country}
                      onChange={(event) =>
                        updateField("country", event.target.value)
                      }
                    >
                      {countries.map(([code, name]) => (
                        <option key={code} value={code}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field zip-field">
                    <span>
                      {form.country === "US" ? "ZIP code" : "Postal code"}
                    </span>
                    <div className="input-with-status">
                      <input
                        value={form.zip}
                        onChange={(event) =>
                          updateField(
                            "zip",
                            event.target.value
                              .replace(
                                form.country === "US"
                                  ? /\D/g
                                  : /[^A-Za-z0-9 -]/g,
                                "",
                              )
                              .toUpperCase()
                              .slice(0, postalCodeRules[form.country]?.maxLength ?? 12),
                          )
                        }
                        inputMode={["US", "DE", "IT", "JP", "PL"].includes(form.country) ? "numeric" : "text"}
                        maxLength={postalCodeRules[form.country]?.maxLength ?? 12}
                        pattern={postalCodeRules[form.country]?.pattern}
                        title={postalCodeRules[form.country]?.title}
                        placeholder={postalCodeRules[form.country]?.placeholder ?? "Postal code"}
                      />
                      {zipStatus && (
                        <small
                          className={
                            zipStatus.includes("found") ? "success" : ""
                          }
                        >
                          {zipStatus}
                        </small>
                      )}
                    </div>
                  </label>
                  <label className="field">
                    <span>City</span>
                    <input
                      value={form.city}
                      onChange={(event) =>
                        updateField("city", event.target.value)
                      }
                      placeholder="City"
                    />
                  </label>
                  <label className="field">
                    <span>State / Province</span>
                    <input
                      value={form.state}
                      onChange={(event) =>
                        updateField("state", event.target.value)
                      }
                      placeholder="State or province"
                    />
                  </label>
                </div>
                <div className="form-divider">
                  <span>GEOGRAPHIC COORDINATES</span>
                  <p>
                    Used for irradiance, weather and performance-data alignment.
                  </p>
                </div>
                <div className="coordinate-grid">
                  <label className="field">
                    <span>Latitude</span>
                    <div className="coordinate-input">
                      <input
                        type="number"
                        step="any"
                        min="-90"
                        max="90"
                        value={form.latitude}
                        onChange={(event) =>
                          updateField("latitude", event.target.value)
                        }
                        placeholder="e.g. 35.2271"
                      />
                      <b>°N</b>
                    </div>
                    <small>Between −90 and 90</small>
                  </label>
                  <label className="field">
                    <span>Longitude</span>
                    <div className="coordinate-input">
                      <input
                        type="number"
                        step="any"
                        min="-180"
                        max="180"
                        value={form.longitude}
                        onChange={(event) =>
                          updateField("longitude", event.target.value)
                        }
                        placeholder="e.g. -80.8431"
                      />
                      <b>°E</b>
                    </div>
                    <small>Between −180 and 180</small>
                  </label>
                  <div className="coordinate-card">
                    <span className="map-pin">⌖</span>
                    <div>
                      <strong>
                        {form.latitude && form.longitude
                          ? `${form.latitude}, ${form.longitude}`
                          : "Coordinates not set"}
                      </strong>
                      <small>
                        {form.city && form.state
                          ? `${form.city}, ${form.state}`
                          : "Location preview"}
                      </small>
                    </div>
                  </div>
                </div>
                <div className="assumptions-heading"><h3>Expected Production Assumptions</h3><p>Describe the losses already allowed for in your weather-adjusted expected production. Changes apply to the next analysis.</p></div>
                <div className="coordinate-grid">
                  {([['expectedShading', 'Shading included in expected production'], ['expectedSnow', 'Snow losses included in expected production']] as const).map(([field, label]) => <label className="field" key={field}><span>{label}</span><select value={form[field] || "not_included"} onChange={event => updateField(field, event.target.value)}><option value="not_included">Not included</option><option value="included">Included</option><option value="unknown">Unknown</option></select></label>)}
                </div>
                <label className="field assumptions-notes"><span>Model notes (optional)</span><textarea value={form.expectedProductionNotes || ""} onChange={event => updateField("expectedProductionNotes", event.target.value)} placeholder="Model source and loss assumptions" /></label>
                <footer className="form-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={discardSettings}
                  >
                    {creatingSite ? "Cancel" : "Discard changes"}
                  </button>
                  <button className="primary-btn save-btn" disabled={saving}>
                    {saving
                      ? creatingSite
                        ? "Adding…"
                        : "Saving…"
                      : creatingSite
                        ? "Add site"
                        : "Save site settings"}
                    <span>✓</span>
                  </button>
                </footer>
              </form>
            </div>
          </section>
        )}
      </section>
      {reviewTarget&&<IssueReviewDialog key={`${activeSiteId}:${analysisRunId}:${reviewTarget.id}`} siteId={activeSiteId} runId={analysisRunId} issueId={reviewTarget.id} name={reviewTarget.name} maintenanceContext={maintenance.windows.filter(w=>maintenanceMatch(reviewTarget,w)).map(w=>({window:w,coverage:maintenanceMatch(reviewTarget,w)!}))} readOnly={!!selectedRunId} onParentReview={openReview} hasNext={!reviewTarget.isRecurring&&visibleIssues.some(i=>i.id!==reviewTarget.id&&["Unreviewed","Needs review"].includes(reviewStatus(i)))} onClose={()=>setReviewTarget(null)} onSaved={savedReview}/>}
      {toast && (
        <div className="toast" role="status">
          <span>✓</span>
          <div>
            <strong>{toast}</strong>
            <small>Your changes are saved.</small>
          </div>
        </div>
      )}
    </main>
  );
}
