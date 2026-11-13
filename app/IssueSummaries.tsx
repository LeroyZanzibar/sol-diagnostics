"use client";
import {appendReportMethodology,type ReportContext} from "./report-methodology";

import { useMemo, useState, type ReactNode } from "react";
import { splitIssue, periodKey, type PeriodLoss, type IntervalLoss, type ReportRange } from "./issue-periods";
import { formatDateTime } from "./issue-date-format";
import * as XLSX from "xlsx";

type Severity = "critical" | "high" | "medium";
type IssueCategory = "Performance" | "Data quality" | "Communications";
export type SummaryIssue = {
  id: string;
  timezone?: string;
  intervalMinutes?: number;
  intervalLosses?: IntervalLoss[];
  originalStart?: string;
  originalEnd?: string;
  summaryIssueNumber?: string;
  summaryPeriods?: PeriodLoss[];
  name: string;
  suspectedCause?: string;
  causeExplanation?: string;
  category: IssueCategory;
  severity: Severity;
  equipmentId: string;
  equipmentName: string;
  equipmentExternalId: string;
  startDateTime: string;
  endDateTime: string;
  durationMinutes: number;
  estimatedLossKwh: number | null;
  lossUnknown?: boolean;
  affectedEquipment?: { id: string; name: string }[];
};

type Grouping = "monthly" | "quarterly" | "annual";
type SortKey = "period" | "equipment" | "category" | "severity" | "issues" | "loss";
type Filters = Record<SortKey, string>;
const emptyFilters: Filters = { period: "", equipment: "", category: "", severity: "", issues: "", loss: "" };

function periodFor(value: string, grouping: Grouping, timezone?: string) {
  const date = new Date(periodKey(value, grouping, timezone));
  const year = date.getUTCFullYear();
  if (grouping === "annual") return `${year}`;
  if (grouping === "quarterly")
    return `${year} Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
function formatKwh(value: number | null) {
  if (value === null) return "Unknown";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} kWh`;
}


export default function IssueSummaries({
  issues,
  siteName,
  onBack,
  reportingPeriod,
  reportRange,
  timezone,
  reportContext,
}: {
  issues: SummaryIssue[];
  siteName: string;
  onBack: () => void;
  reportingPeriod?: ReactNode;
  reportRange?: ReportRange;
  reportContext?:ReportContext;
  timezone?: string;
}) {
  const [grouping, setGrouping] = useState<Grouping>("monthly");
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "period", direction: "desc" });
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const allGroups = useMemo(() => {
    const grouped = new Map<string, { period: string; issues: ReturnType<typeof splitIssue<SummaryIssue>> }>();
    issues.flatMap(issue => splitIssue(issue, grouping)).forEach((issue) => {
      const period = periodFor(issue.startDateTime, grouping, issue.timezone);
      const key = `${period}|${issue.equipmentId}|${issue.category}|${issue.severity}`;
      const current = grouped.get(key) || { period, issues: [] };
      current.issues.push(issue);
      grouped.set(key, current);
    });
    return [...grouped.values()].map((group) => ({
        ...group,
        key: `${group.period}|${group.issues[0].equipmentId}|${group.issues[0].category}|${group.issues[0].severity}`,
        periodOrder: periodKey(group.issues[0].startDateTime, grouping, group.issues[0].timezone),
        equipmentName: group.issues[0].equipmentName,
        equipmentExternalId: group.issues[0].equipmentExternalId,
        category: group.issues[0].category,
        severity: group.issues[0].severity,
        estimatedLossKwh: group.issues.some(issue => issue.estimatedLossKwh === null) ? null : group.issues.reduce(
          (sum, issue) => sum + (issue.estimatedLossKwh ?? 0),
          0,
        ),
      }));
  }, [issues, grouping]);
  const groups = useMemo(() => allGroups.filter((group) => {
    if (filters.period && !group.period.toLowerCase().includes(filters.period.toLowerCase())) return false;
    if (filters.equipment && !`${group.equipmentName} ${group.equipmentExternalId}`.toLowerCase().includes(filters.equipment.toLowerCase())) return false;
    if (filters.category && group.category !== filters.category) return false;
    if (filters.severity && group.severity !== filters.severity) return false;
    if (filters.issues && group.issues.length < Number(filters.issues)) return false;
    if (filters.loss && (group.estimatedLossKwh === null || group.estimatedLossKwh < Number(filters.loss))) return false;
    return true;
  }).sort((a, b) => {
    const severityRank = { critical: 3, high: 2, medium: 1 };
    const values = {
      period: [a.periodOrder, b.periodOrder],
      equipment: [a.equipmentName, b.equipmentName],
      category: [a.category, b.category],
      severity: [severityRank[a.severity], severityRank[b.severity]],
      issues: [a.issues.length, b.issues.length],
      loss: [a.estimatedLossKwh ?? -1, b.estimatedLossKwh ?? -1],
    }[sort.key];
    const comparison = typeof values[0] === "number"
      ? Number(values[0]) - Number(values[1])
      : String(values[0]).localeCompare(String(values[1]));
    return sort.direction === "asc" ? comparison : -comparison;
  }), [allGroups, filters, sort]);
  const hasFilters = Object.values(filters).some(Boolean);
  function toggleSort(key: SortKey) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
  }
  function indicator(key: SortKey) { return sort.key === key ? (sort.direction === "asc" ? "↑" : "↓") : "↕"; }
  function updateFilter(key: SortKey, value: string) { setFilters((current) => ({ ...current, [key]: value })); }
  function exportSummaries() {
    if(reportContext&&!reportContext.reviewRetrievedAt)return;
    const rows: (string | number)[][] = [[
      "Row type",
      "Period",
      "Equipment",
      "Equipment ID",
      "Category",
      "Severity",
      "Issue",
      "Start",
      "End",
      "Duration (minutes)",
      "Issue count",
      "Estimated loss (kWh)",
      "Shared issue", "Portion", "Original start", "Original end", "Source issue ID", "Suspected cause", "Cause evidence", "Affected inverters",
    ]];
    const outlineRows: XLSX.RowInfo[] = [{}];

    groups.forEach((group) => {
      rows.push([
        "Summary",
        group.period,
        group.equipmentName,
        group.equipmentExternalId,
        group.category,
        group.severity,
        "",
        "",
        "",
        "",
        group.issues.length,
        group.estimatedLossKwh ?? "Unknown",
      ]);
      outlineRows.push({ level: 0 });

      [...group.issues]
        .sort((a, b) => a.startDateTime.localeCompare(b.startDateTime))
        .forEach((issue) => {
          rows.push([
            "Child issue",
            group.period,
            group.equipmentName,
            group.equipmentExternalId,
            issue.category,
            issue.severity,
            `↳ ${issue.name}`,
            formatDateTime(issue.startDateTime, issue.timezone),
            formatDateTime(issue.endDateTime, issue.timezone),
            issue.durationMinutes,
            "",
            issue.estimatedLossKwh ?? "Unknown",
            issue.summaryIssueNumber || issue.id,
            `${issue.portion} of ${issue.portionCount}`,
            formatDateTime(issue.originalStart, issue.timezone), formatDateTime(issue.originalEnd, issue.timezone), issue.id, issue.suspectedCause || "", issue.causeExplanation || "", (issue.affectedEquipment || []).map(item => item.name).join(", "),
          ]);
          outlineRows.push({ level: 1 });
        });
    });

    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet["!rows"] = outlineRows;
    worksheet["!cols"] = [
      { wch: 13 }, { wch: 14 }, { wch: 24 }, { wch: 18 },
      { wch: 17 }, { wch: 12 }, { wch: 38 }, { wch: 22 },
      { wch: 22 }, { wch: 18 }, { wch: 13 }, { wch: 22 },
    ];
    worksheet["!cols"]!.push({ wch: 16 }, { wch: 12 }, { wch: 24 }, { wch: 24 }, { wch: 50 }, { wch: 18 }, { wch: 70 }, { wch: 60 });
    worksheet["!autofilter"] = { ref: `A1:T${rows.length}` };

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Summaries");
    if(reportContext)appendReportMethodology(workbook,{...reportContext,filters:{...reportContext.filters as object,summaryGrouping:grouping,summaryFilters:filters},issues:reportContext.issues.filter(i=>groups.some(g=>g.issues.some(v=>v.id===i.id)))});
    if (reportRange) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Reporting from", reportRange.from || "All dates"], ["Reporting through (inclusive)", reportRange.through || "All dates"], ["Timezone", timezone || "Site local time"], ["Allocation", "Overlapping events; interval losses within the selected dates. Unknown allocations are excluded from quantified totals."]]), "Reporting period");
    const safeSiteName = siteName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    XLSX.writeFile(workbook, `${safeSiteName || "site"}-${grouping}-summaries.xlsx`, {
      compression: true,
    });
  }

  return (
    <section className="summaries-view" aria-labelledby="summaries-title">
      <header className="settings-header summaries-header">
        <div>
          <p className="eyebrow">PERFORMANCE REPORTING</p>
          <h1 id="summaries-title">Summaries</h1>
          <p>
            Roll up {siteName} issues by equipment, category, severity, and
            reporting period.
          </p>
        </div>
        <div className="summary-actions">
          <label>
            <span>TIME GROUPING</span>
            <select
              value={grouping}
              onChange={(event) => { setGrouping(event.target.value as Grouping); setSelectedIssue(null); setExpandedGroups(new Set()); }}
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annual">Annual</option>
            </select>
          </label>
          <button
            className="secondary-btn"
            onClick={exportSummaries}
            disabled={reportContext?!reportContext.reviewRetrievedAt:!groups.length}
            title="Export the currently filtered and sorted summaries with child issue rows"
          >
            Export XLSX <b aria-hidden="true">↓</b>
          </button>
          <button className="secondary-btn" onClick={onBack}>
            ← Back to issues
          </button>
        </div>
      </header>
      {reportingPeriod}
      <div className="summary-strip">
        {reportContext&&!reportContext.reviewRetrievedAt?<span>Review-adjusted totals unavailable until saved reviews load.</span>:<>
        <strong>{groups.length.toLocaleString()}</strong> of {allGroups.length.toLocaleString()} summarized issue groups
        <span>{new Set(groups.flatMap(group => group.issues.map(issue => issue.id))).size} unique issues</span>
        <span>
          {formatKwh(
            groups.reduce((sum, group) => sum + group.issues.reduce((subtotal, issue) => subtotal + (issue.estimatedLossKwh ?? 0), 0), 0),
          )}{" "}
          total estimated loss
        </span></>}
      </div>
      <p className="summary-help">Dates use the site’s local time. Linked badges identify portions of one continuous issue; select a badge to highlight its visible portions.</p>
      {selectedIssue && <button className="secondary-btn" onClick={() => setSelectedIssue(null)}>Clear related-issue highlight</button>}
      {groups.some(group => group.estimatedLossKwh === null) && <p role="status">Unknown losses are excluded from quantified totals. A group containing unknown losses is marked Unknown; its known child losses remain visible.</p>}
      <section className="panel summary-panel">
        {groups.length ? (
          <div className="table-wrap summary-scroll" role="region" aria-label="Issue summaries, scroll horizontally for more columns" tabIndex={0}>
            <table className="summary-matrix">
              <thead>
                <tr className="summary-sort-row">
                  <th><button onClick={() => toggleSort("period")}>Period <span>{indicator("period")}</span></button></th>
                  <th><button onClick={() => toggleSort("equipment")}>Equipment <span>{indicator("equipment")}</span></button></th>
                  <th><button onClick={() => toggleSort("category")}>Category <span>{indicator("category")}</span></button></th>
                  <th><button onClick={() => toggleSort("severity")}>Severity <span>{indicator("severity")}</span></button></th>
                  <th><button onClick={() => toggleSort("issues")}>Issues <span>{indicator("issues")}</span></button></th>
                  <th><button onClick={() => toggleSort("loss")}>Estimated loss <span>{indicator("loss")}</span></button></th>
                </tr>
                <tr className="summary-filter-row">
                  <th><input aria-label="Filter summary period" value={filters.period} onChange={(event) => updateFilter("period", event.target.value)} placeholder="Contains…" /></th>
                  <th><input aria-label="Filter summary equipment" value={filters.equipment} onChange={(event) => updateFilter("equipment", event.target.value)} placeholder="Name or ID…" /></th>
                  <th><select aria-label="Filter summary category" value={filters.category} onChange={(event) => updateFilter("category", event.target.value)}><option value="">All</option><option>Performance</option><option>Data quality</option><option>Communications</option></select></th>
                  <th><select aria-label="Filter summary severity" value={filters.severity} onChange={(event) => updateFilter("severity", event.target.value)}><option value="">All</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option></select></th>
                  <th><input aria-label="Filter minimum summarized issue count" type="number" min="0" value={filters.issues} onChange={(event) => updateFilter("issues", event.target.value)} placeholder="Min" /></th>
                  <th><input aria-label="Filter minimum summarized loss" type="number" min="0" value={filters.loss} onChange={(event) => updateFilter("loss", event.target.value)} placeholder="Min kWh" /></th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.key}>
                    <td colSpan={6}>
                      <details className="summary-group" open={expandedGroups.has(group.key)} onToggle={event => {
                        const open = event.currentTarget.open;
                        setExpandedGroups(current => { if (current.has(group.key) === open) return current; const next = new Set(current); if (open) next.add(group.key); else next.delete(group.key); return next; });
                      }}>
                        <summary>
                          <span>{group.period}</span>
                          <span>
                            <strong>{group.equipmentName}</strong>
                            <small>{group.equipmentExternalId}</small>
                          </span>
                          <span className={`issue-category ${group.category.toLowerCase().replace(/\s+/g, "-")}`}>
                            {group.category}
                          </span>
                          <span className={`severity ${group.severity}`}>
                            <i /> {group.severity}
                          </span>
                          <span>{group.issues.length}</span>
                          <strong>{formatKwh(group.estimatedLossKwh)}</strong>
                        </summary>
                        <div className="summary-children">
                          <table>
                            <thead>
                              <tr>
                                <th>Related issue</th>
                                <th>Individual issue</th>
                                <th>Suspected cause</th>
                                <th>Start</th>
                                <th>End</th>
                                <th>Estimated loss</th>
                              </tr>
                            </thead>
                            <tbody>
                              {[...group.issues]
                                .sort((a, b) =>
                                  a.startDateTime.localeCompare(b.startDateTime),
                                )
                                .map((issue) => (
                                  <tr key={issue.id} className={selectedIssue === issue.id ? "related-issue-selected" : undefined}>
                                    <td className="related-issue-cell">{issue.portionCount > 1 && <span className="issue-link-wrap">
                                      <button className="issue-link-badge" aria-pressed={selectedIssue === issue.id}
                                        aria-label={`Issue ${issue.summaryIssueNumber || issue.id}, portion ${issue.portion} of ${issue.portionCount}. Highlight related portions.`}
                                        aria-describedby={`portion-${group.periodOrder}-${issue.id}`}
                                        onClick={() => {
                                          setSelectedIssue(current => current === issue.id ? null : issue.id);
                                          setExpandedGroups(current => new Set([...current, ...groups.filter(item => item.issues.some(child => child.id === issue.id)).map(item => item.key)]));
                                        }}>
                                        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7 .2l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.2l-3 3a5 5 0 0 0 7 7l2-2" /></svg>
                                        {issue.summaryIssueNumber || "Linked"}
                                      </button>
                                      <span role="tooltip" className="issue-link-tooltip" id={`portion-${group.periodOrder}-${issue.id}`}>
                                        {formatDateTime(issue.originalStart, issue.timezone)} – {formatDateTime(issue.originalEnd, issue.timezone)}<br />Portion {issue.portion} of {issue.portionCount}
                                      </span>
                                    </span>}</td>
                                    <td>{issue.name}{!!issue.affectedEquipment?.length && <details><summary>{issue.affectedEquipment.length} affected inverters</summary><small>{issue.affectedEquipment.map(item => item.name).join(", ")}</small></details>}</td>
                                    <td>{issue.suspectedCause ? <details className="cause-evidence"><summary>{issue.suspectedCause}</summary><small>{issue.causeExplanation}</small></details> : ""}</td>
                                    <td>{formatDateTime(issue.startDateTime, issue.timezone)}</td>
                                    <td>{formatDateTime(issue.endDateTime, issue.timezone)}</td>
                                    <td>{formatKwh(issue.estimatedLossKwh)}</td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : hasFilters ? (
          <div className="performance-empty">
            <span>○</span><strong>No matching summary groups</strong>
            <p>Adjust the column filters or clear them to see other groups.</p>
            <button className="secondary-btn empty-action" onClick={() => setFilters(emptyFilters)}>Clear filters</button>
          </div>
        ) : (
          <div className="performance-empty">
            <span>○</span>
            <strong>No issues to summarize</strong>
            <p>{reportContext?.reviewRetrievedAt?"No findings match the reporting period and analyst review filter. Use the audit view to include dismissed findings.":"Load an analysis and its saved reviews to populate this page."}</p>
          </div>
        )}
      </section>
    </section>
  );
}
