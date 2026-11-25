"use client";

import { reportRangeValid, type ReportRange } from "./issue-periods";

export default function ReportingPeriod({ range, onChange, timezone, compact = false }: { range: ReportRange; onChange: (value: ReportRange) => void; timezone: string; compact?: boolean }) {
  return <section className={`panel reporting-period${compact ? " reporting-period-compact" : ""}`} aria-label="Reporting period">
    <div className="reporting-period-row">
      {!compact && <div className="reporting-period-intro">
        <p className="eyebrow">REPORTING PERIOD</p>
        <p className="reporting-period-description">Include overlapping issues and count losses within these dates.</p>
      </div>}
      <div className="reporting-period-controls">
        <label className="field">
          <span>From</span>
          <input aria-label="Reporting period from" type="date" value={range.from} max={range.through || undefined} onChange={event => onChange({ ...range, from: event.target.value })} />
        </label>
        <label className="field">
          <span>Through</span>
          <input aria-label="Reporting period through" type="date" value={range.through} min={range.from || undefined} onChange={event => onChange({ ...range, through: event.target.value })} />
        </label>
        {(range.from || range.through) && <button className="secondary-btn" onClick={() => onChange({ from: "", through: "" })}>All dates</button>}
      </div>
    </div>
    <small className="reporting-period-help">{compact && "Include overlapping issues and count losses within these dates. "}Dates use {timezone}. Through includes the entire day. Applies to Findings, Summaries, Timeline, and their exports.</small>
    {!reportRangeValid(range) && <p className="reporting-period-error" role="alert">The reporting end date must be on or after the start date.</p>}
  </section>;
}
