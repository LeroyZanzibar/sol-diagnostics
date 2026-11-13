"use client";

import { Fragment, useMemo, useState, type ReactNode, type CSSProperties } from "react";
import { formatDateTime } from "./issue-date-format";
import { localMoment, hasTimeZone, calendarDayMoment, type ReportRange } from "./issue-periods";
import {activeSegments,type RecurringIssue} from './recurring-issues';
import type {IntervalLoss} from './issue-periods';
import {formatAxis,firstOfMonth,nextMonth,reviewMonthDays} from "./timeline-axis";
import {isValidTimezone} from './telemetry-time';
import TimelineMaintenance,{useTimelineMaintenance,maintenanceDaySpan,nextMaintenanceDate} from './TimelineMaintenance';

type Severity = "critical" | "high" | "medium";
type IssueCategory = "Performance" | "Data quality" | "Communications";

export type TimelineIssue = {
  id: string;
  recurringId?:string;intervalMinutes?:number;intervalLosses?:IntervalLoss[];
  timezone?: string;
  name: string;
  category: IssueCategory;
  severity: Severity;
  equipmentId: string;
  equipmentName: string;
  startDateTime: string;
  endDateTime: string;
  estimatedLossKwh: number | null;
};

type TimelineSegment = {
  start: number;
  end: number;
  category: IssueCategory;
  severity: Severity;
  issues: TimelineIssue[];
};

const severityRank: Record<Severity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
};

const moment = localMoment;

export default function IssueTimeline({
  issues,
  siteName,
  onBack,
  reportingPeriod,
  episodes=[],
  siteId,
  sites,
  onSiteChange,
  reportRange={from:'',through:''},
  timezone='',
  maintenanceRevision=0,
}: {
  issues: TimelineIssue[];
  siteName: string;
  onBack: () => void;
  reportingPeriod?: ReactNode;
  episodes?:RecurringIssue[];
  siteId:string;
  sites:{id:string;name:string}[];
  onSiteChange:(siteId:string)=>void;
  reportRange?:ReportRange;
  timezone?:string;
  maintenanceRevision?:number;
}) {
  const maintenance=useTimelineMaintenance(siteId,reportRange,maintenanceRevision);
  const [showMaintenance,setShowMaintenance]=useState(true);
  const preferredTimezone=[issues[0]?.timezone,timezone,maintenance.timezone].find(zone=>zone&&isValidTimezone(zone))||'UTC';
  const timelineTimezone=issues.length&&!hasTimeZone(issues[0].startDateTime)?'UTC':preferredTimezone;
  const zoned = issues.length ? hasTimeZone(issues[0].startDateTime) : false;
  const segmentTimestamp = (value: number) => zoned ? new Date(value).toISOString() : new Date(value).toISOString().slice(0, 19);
  const [category, setCategory] = useState<"" | IssueCategory>("");
  const [severity, setSeverity] = useState<"" | Severity>("");
  const [issueSort, setIssueSort] = useState<"asc" | "desc">("asc");
  const [selectedDetail, setSelectedDetail] = useState<string | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const filtered = useMemo(
    () =>
      issues
        .filter(
          (issue) =>
            (!category || issue.category === category) &&
            (!severity || issue.severity === severity),
        )
        .sort(
          (a, b) =>
            moment(a.startDateTime) - moment(b.startDateTime) ||
            moment(a.endDateTime) - moment(b.endDateTime),
        ),
    [issues, category, severity],
  );
  const range = useMemo(() => {
    const maintenanceSpans=showMaintenance?maintenance.days.map(day=>maintenanceDaySpan(day.date,timelineTimezone)):[];
    const starts=[...filtered.map(issue=>moment(issue.startDateTime)),...maintenanceSpans.map(day=>day.start)];
    const ends=[...filtered.map(issue=>moment(issue.endDateTime)),...maintenanceSpans.map(day=>day.end)];
    if(reportRange.from&&reportRange.through&&reportRange.from<=reportRange.through){starts.push(calendarDayMoment(reportRange.from,timelineTimezone));ends.push(calendarDayMoment(nextMaintenanceDate(reportRange.through),timelineTimezone));}
    if(!starts.length)return null;
    const rawStart=starts.reduce((a,b)=>Math.min(a,b),Infinity),rawEnd=ends.reduce((a,b)=>Math.max(a,b),-Infinity);
    const start = firstOfMonth(rawStart, timelineTimezone);
    const end = nextMonth(firstOfMonth(rawEnd - 1, timelineTimezone), timelineTimezone);
    return { start, end };
  }, [filtered, timelineTimezone,maintenance.days,showMaintenance,reportRange.from,reportRange.through]);
  const rows = useMemo(() => {
    const grouped = new Map<
      string,
      { name: string; equipmentName: string; issues: TimelineIssue[] }
    >();
    filtered.forEach((issue) => {
      const key = issue.recurringId||issue.id;
      const episode=episodes.find(e=>e.id===issue.recurringId);
      const current = grouped.get(key) || {
        name: episode?`${episode.name} · ${episode.firstDay}–${episode.lastDay}`:issue.name,
        equipmentName: issue.equipmentName,
        issues: [],
      };
      current.issues.push(issue);
      grouped.set(key, current);
    });
    return [...grouped.entries()]
      .map(([key, group]) => {
        const segments = group.issues
          .flatMap(issue => (issue.recurringId?activeSegments(issue):[{startDateTime:issue.startDateTime,endDateTime:issue.endDateTime}]).map(
            (part): TimelineSegment => ({
              start: moment(part.startDateTime),
              end: Math.max(
                moment(part.startDateTime),
                moment(part.endDateTime),
              ),
              category: issue.category,
              severity: issue.severity,
              issues: [issue],
            }),
          ))
          .sort((a, b) => a.start - b.start)
          .reduce<TimelineSegment[]>((merged, segment) => {
            const previous = merged.at(-1);
            if (!previous || segment.start > previous.end) {
              merged.push(segment);
              return merged;
            }
            previous.end = Math.max(previous.end, segment.end);
            previous.issues.push(...segment.issues);
            if (severityRank[segment.severity] > severityRank[previous.severity])
              previous.severity = segment.severity;
            return merged;
          }, []);
        return {
          key,
          ...group,
          segments,
          firstStart: segments[0]?.start || 0,
        };
      })
      .sort((a, b) => {
        const comparison =
          a.name.localeCompare(b.name) ||
          a.equipmentName.localeCompare(b.equipmentName);
        return issueSort === "asc" ? comparison : -comparison;
      });
  }, [filtered, issueSort,episodes]);
  const axis = useMemo(() => {
    if (!range) return [];
    const ticks: Array<{ value: number; left: string }> = [];
    for (let value = range.start; value <= range.end; value = nextMonth(value, timelineTimezone))
      ticks.push({
        value,
        left: `${((value - range.start) / (range.end - range.start)) * 100}%`,
      });
    return ticks;
  }, [range, timelineTimezone]);
  const span = range ? range.end - range.start : 1;
  const dailyAxis=useMemo(()=>range?axis.slice(0,-1).flatMap((month,index)=>{
    const days=reviewMonthDays(month.value,timelineTimezone);
    return days.map((day,dayIndex)=>({value:day.time,day:day.day,left:`${(day.time-range.start)/span*100}%`,center:`${((day.time+(days[dayIndex+1]?.time||axis[index+1].value))/2-range.start)/span*100}%`}));
  }):[],[range,axis,timelineTimezone,span]);
  // One inherited background avoids creating hundreds of grid nodes per finding.
  const dayGrid=`linear-gradient(to right,${dailyAxis.map(tick=>`transparent ${tick.left},var(--line) ${tick.left},var(--line) calc(${tick.left} + 1px),transparent calc(${tick.left} + 1px)`).join(',')})`;
  const chartWidth = Math.max(980, 260 + dailyAxis.length * 28);

  function toggleRow(key: string) {
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <section className="timeline-view" aria-labelledby="timeline-title">
      <header className="settings-header timeline-header">
        <div>
          <p className="eyebrow">ISSUE HISTORY</p>
          <h1 id="timeline-title">Timeline</h1>
          <p>{siteName} · one row per recurring episode or standalone finding. Recurring bars show active intervals only.</p>
        </div>
        <div className="timeline-header-actions"><label>Site<select aria-label="Timeline site" value={siteId} onChange={event=>onSiteChange(event.target.value)}>{sites.map(site=><option value={site.id} key={site.id}>{site.name}</option>)}</select></label><button className="secondary-btn" onClick={onBack}>
          Back to issues
        </button></div>
      </header>
      {reportingPeriod}

      <section className="panel timeline-panel">
        <div className="timeline-toolbar">
          <div>
            <p className="eyebrow">ISSUE PERIODS</p>
            <h2>
              {filtered.length} issue{filtered.length === 1 ? "" : "s"} ·{" "}
              {rows.length} row{rows.length === 1 ? "" : "s"}
            </h2>
          </div>
          <div className="timeline-filters" aria-label="Timeline filters">
            <label className="timeline-maintenance-toggle"><input type="checkbox" checked={showMaintenance} onChange={event=>setShowMaintenance(event.target.checked)}/>Show maintenance</label>
            <label>
              <span>Category</span>
              <select
                value={category}
                onChange={(event) =>
                  setCategory(event.target.value as "" | IssueCategory)
                }
              >
                <option value="">All categories</option>
                <option value="Performance">Performance</option>
                <option value="Data quality">Data quality</option>
                <option value="Communications">Communications</option>
              </select>
            </label>
            <label>
              <span>Severity</span>
              <select
                value={severity}
                onChange={(event) =>
                  setSeverity(event.target.value as "" | Severity)
                }
              >
                <option value="">All severities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
              </select>
            </label>
            {(category || severity) && (
              <button
                className="secondary-btn"
                onClick={() => {
                  setCategory("");
                  setSeverity("");
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        </div>

        {showMaintenance&&maintenance.loading&&<p className="timeline-maintenance-status" role="status">Loading maintenance dates…</p>}
        {showMaintenance&&maintenance.error&&<p className="timeline-maintenance-status import-error" role="alert">Maintenance dates could not be loaded: {maintenance.error}<button className="secondary-btn" onClick={maintenance.retry}>Retry</button></p>}
        {!range ? (
          <div className="performance-empty compact timeline-empty">
            <span>—</span>
            <strong>{issues.length ? "No matching issues or maintenance dates" : "No issues or maintenance dates to chart"}</strong>
            <p>
              {issues.length
                ? "Adjust or clear the Category and Severity filters."
                : "Choose a reporting period or upload maintenance data. The audit view includes dismissed findings."}
            </p>
          </div>
        ) : (
          <div className="timeline-scroll" role="region" aria-label="Issue timeline, scroll horizontally to explore dates" tabIndex={0}>
            <div className="timeline-chart" style={{ minWidth: chartWidth,'--timeline-daily-grid':dayGrid } as CSSProperties}>
              <div
                className="timeline-axis-label"
                role="columnheader"
                aria-sort={issueSort === "asc" ? "ascending" : "descending"}
              >
                <button
                  onClick={() =>
                    setIssueSort((current) =>
                      current === "asc" ? "desc" : "asc",
                    )
                  }
                >
                  Issue <span>{issueSort === "asc" ? "↑" : "↓"}</span>
                </button>
              </div>
              <div className="timeline-axis" aria-hidden="true">
                {axis.slice(0,-1).map((tick) => (
                  <span className="timeline-month-tick" key={tick.value} style={{ left: tick.left }}>
                    {formatAxis(tick.value, timelineTimezone)}
                  </span>
                ))}
                {dailyAxis.map(tick=><span className="timeline-day-tick" key={`day-${tick.value}`} style={{left:tick.center}}>{tick.day}</span>)}
              </div>
              {showMaintenance&&<TimelineMaintenance key={`${siteId}:${reportRange.from}:${reportRange.through}`} days={maintenance.days} start={range.start} end={range.end} timezone={timelineTimezone}/>}
              {rows.map((row) => {
                const expanded = expandedRows.has(row.key);
                return (
                  <Fragment key={row.key}>
                    <div className="timeline-issue-label timeline-parent-label">
                      {row.issues.length > 1 || row.issues[0]?.recurringId ? (
                        <button
                          className="timeline-expand"
                          aria-expanded={expanded}
                          onClick={() => toggleRow(row.key)}
                        >
                          <span aria-hidden="true">{expanded ? "⌄" : "›"}</span>
                          <strong>{row.name}</strong>
                        </button>
                      ) : (
                        <strong>{row.name}</strong>
                      )}
                      <small>
                        {row.equipmentName} · {row.issues.length} occurrence
                        {row.issues.length === 1 ? "" : "s"}
                      </small>
                    </div>
                    <div className="timeline-track">
                      {row.segments.map((segment, index) => {
                        const left = ((segment.start - range.start) / span) * 100;
                        const width = ((segment.end - segment.start) / span) * 100;
                        const lossKwh = [...new Map(segment.issues.map(i=>[i.id,i])).values()].reduce(
                          (sum, issue) => sum + (issue.estimatedLossKwh ?? 0),
                          0,
                        );
                        const detail = `${row.name} · ${formatDateTime(segmentTimestamp(segment.start), timelineTimezone)} to ${formatDateTime(segmentTimestamp(segment.end), timelineTimezone)} · Source occurrence total: ${segment.issues.some(issue => issue.estimatedLossKwh === null) ? "Unknown loss" : `${lossKwh.toLocaleString(undefined, { maximumFractionDigits: 1 })} kWh`}${segment.issues.length > 1 ? ` · ${segment.issues.length} overlapping occurrences combined` : ""}`;
                        return (
                          <button
                            type="button"
                            key={`${segment.start}-${segment.end}-${index}`}
                            className={`timeline-bar ${segment.category.toLowerCase().replace(/\s+/g, "-")} ${segment.severity}`}
                            style={{ left: `${left}%`, width: `max(6px, ${width}%)` }}
                            title={detail}
                            onClick={() => setSelectedDetail(detail)}
                            aria-label={detail}
                            tabIndex={0}
                          />
                        );
                      })}
                    </div>
                    {expanded &&
                      row.issues.map((issue, issueIndex) => {
                        const detail = `${issue.name} · ${formatDateTime(issue.startDateTime, issue.timezone)} to ${formatDateTime(issue.endDateTime, issue.timezone)} · ${issue.estimatedLossKwh === null ? "Unknown loss" : `${issue.estimatedLossKwh.toLocaleString(undefined, { maximumFractionDigits: 1 })} kWh`}`;
                        return (
                          <Fragment key={issue.id}>
                            <div className="timeline-issue-label timeline-child-label">
                              <strong>Occurrence {issueIndex + 1}</strong>
                              <small>
                                {formatDateTime(issue.startDateTime, issue.timezone)} –{" "}
                                {formatDateTime(issue.endDateTime, issue.timezone)}
                              </small>
                            </div>
                            <div className="timeline-track timeline-child-track">
                              {(issue.recurringId?activeSegments(issue):[{startDateTime:issue.startDateTime,endDateTime:issue.endDateTime}]).map(part=><button
                                key={part.startDateTime} type="button"
                                className={`timeline-bar ${issue.category.toLowerCase().replace(/\s+/g, "-")} ${issue.severity}`}
                                style={{ left: `${((moment(part.startDateTime)-range.start)/span)*100}%`, width: `max(6px, ${(moment(part.endDateTime)-moment(part.startDateTime))/span*100}%)` }}
                                title={detail} onClick={() => setSelectedDetail(detail)} aria-label={detail} tabIndex={0}
                              />)}
                            </div>
                          </Fragment>
                        );
                      })}
                  </Fragment>
                );
              })}
            </div>
          </div>
        )}
        {selectedDetail && <div className="timeline-selection" role="status"><p>{selectedDetail}</p><button className="secondary-btn" onClick={() => setSelectedDetail(null)}>Close details</button></div>}
        <footer className="timeline-legend">
          {showMaintenance&&<span><i className="maintenance"/> Maintenance · task count</span>}
          <span><i className="performance" /> Performance</span>
          <span><i className="data-quality" /> Data quality</span>
          <span><i className="communications" /> Communications</span>
          <small>Bar intensity indicates severity.</small>
        </footer>
      </section>
    </section>
  );
}
