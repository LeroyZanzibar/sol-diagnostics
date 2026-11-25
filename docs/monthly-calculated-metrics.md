# Monthly calculated metrics

The **Projections → Monthly comparison** table adds twelve read-only calculated columns for each site. The monthly API returns the same calculations as exact rational values (`{n, d}`), together with their availability/partial-data status. They are recalculated from saved inputs on reads, not stored as independently editable or rounded copies. The calculations require no new stored columns; the accompanying Unpaid energy input uses the additive migration described below.

## Inputs and units

- **Utility production**: the exact total of present on-peak, off-peak and **Unpaid energy** entries, in kWh. Any category alone is valid; all-blank is unavailable and explicit zero is retained. The utility ledger, comparison total and every production-dependent metric use this same total.
- **Projected production, budgeted revenue and projected insolation**: the existing monthly projections after start-month proration and the configured degradation rules, not the raw undegraded calendar-month baselines.
- **Actual insolation**: uploaded performance readings mapped to the selected POA equipment series. Each uploaded value is interval energy in Wh/m²; sum the unrounded values and divide by 1,000 for kWh/m². Assign intervals to the site's pinned local start month (including DST), with no duration multiplication, annual normalization, proration or degradation. This reporting contract also applies to existing channels carrying legacy `W/m²` metadata; canonical units and analytical behavior are not rewritten. Expected Production retains its existing monthly sum, elapsed-overlap allocation and quality handling, in kWh.
- **DC capacity**: the site's connected module nameplate watts × module quantity, summed and divided by 1,000 to obtain kWp. Do not substitute inverter AC capacity, inverter maximum-DC input limits or export limits, and do not reduce nameplate capacity for degradation or delivery losses. Missing/incomplete module capacity makes dependent metrics unavailable rather than silently using an understated total.

Conventional performance ratio uses plane-of-array insolation and a 1 kW/m² reference irradiance. The app uses the selected reporting series as configured; it does not convert GHI to POA or certify that an unknown/mixed source and a projected baseline use the same plane. Check that basis before treating PR as a contractual performance assessment. This is not a temperature-corrected or bifacial-specific PR.

## Uploaded Actual Insolation selection and refresh

The **Uploaded POA series** selector restores the saved `irradianceChannelId` mechanism. CSV, generic API, onsite, satellite-first and blended readings all qualify; physical-sensor proof, VCOM sidecars and source labels are not eligibility gates. Reporting does not download, reimport or invent provenance. The older `poaSourceId` field is retained unchanged for compatibility but no longer selects reporting data.

A single unambiguous series is automatic. Independent equipment series, or multiple channels with the same measurement on one equipment, require an explicit choice. Missing or unavailable saved selections stay unavailable rather than switching to another series. Exactly one `Irradiance` and one `POA irradiance` channel on the same equipment are treated as historical names of one logical series. A saved exact channel ID is retained and resolves to that equipment's alias pair, so selecting either historical name includes both periods. At overlapping timestamps equal numeric alias values count once; conflicting values are excluded and flagged, never summed. GHI channels remain separate choices, without plane conversion.

Zero is a valid reading; missing values remain gaps. Numeric subtotals retain partial coverage, including any excluded alias conflicts. Coverage uses elapsed interval time, but values do not. Monthly comparison and charts consume the same exact cached fractions and round only for display.

Rollup calculation version 4 invalidates older measured-only caches even when the import revision is unchanged. Reads and the existing startup/periodic sweep recompute and persist these derived rollups; subsequent selection or canonical-data edits are fenced against stale in-flight publication. No monthly input strings, utility drafts, canonical readings/units, saved analyses, or Confirmed current-published loss records are changed.

## Calculations

All division uses unrounded values. Percent ratios are dimensionless; multiplication by 100 occurs only for display.

| Column | Formula | Display |
| --- | --- | --- |
| Budgeted specific yield | Projected production / DC capacity | 2 decimals, kWh/kWp |
| Actual specific yield | Utility production / DC capacity | 2 decimals, kWh/kWp |
| Actual / budgeted specific yield | Actual specific yield / budgeted specific yield | Whole % |
| Budgeted performance ratio | Budgeted specific yield / projected insolation | Whole % |
| Actual performance ratio | Actual specific yield / actual insolation | Whole % |
| Actual / budgeted performance ratio | Actual PR / budgeted PR | Whole % |
| Actual / projected insolation | Actual insolation / projected insolation | Whole % |
| Utility production / projected production | Utility production / projected production | Whole % |
| Utility production / Expected Production | Utility production / monthly Expected Production | Whole % |
| Utility revenue / budgeted revenue | Utility revenue / budgeted revenue | Whole % |
| IAPR — Irradiance Adjusted Performance Ratio | (Utility production / projected production) / (actual insolation / projected insolation) | Whole % |
| IAR — Irradiance Adjusted Revenue | (Utility revenue / budgeted revenue) / (actual insolation / projected insolation) | Whole % |

When their inputs are available, actual/budgeted specific yield equals utility/projected production, and actual/budgeted PR equals IAPR. Both requested columns remain visible. Unlike absolute yield and PR, IAPR and IAR do not require DC capacity.

## Unpaid energy input and upgrade

Unpaid energy is an editable kWh column between Off-peak production and Total production. Like other energy inputs, it accepts nonnegative plain-decimal strings within the existing magnitude and 20-character limits. It displays whole kWh while retaining the original decimal string for storage, editing and calculations. Sum all unrounded components before formatting the total.

Migration `0022_unpaid_energy.sql` adds nullable `unpaid_energy TEXT`. Existing rows retain their old values, with Unpaid energy initially blank; no zeros or historical unpaid values are fabricated. Full-row API saves must explicitly include `unpaidEnergy`, using `null` for blank, so an omitted field cannot silently erase saved data.

Changing Unpaid energy updates the actual specific yield, yield ratio, actual PR, PR ratio, utility/projected production, utility/Expected Production and IAPR. It does not create revenue or change budgeted yield/PR, insolation, revenue comparisons or IAR when all other inputs are unchanged.

## Availability and precision

- Missing inputs or zero denominators display an em dash with an explanation. Zero numerators remain valid zero results when their denominator is available and nonzero.
- Ratios are not capped at 100%; signed utility revenue is retained.
- A calculation using partial telemetry remains visibly partial. Refreshing telemetry does not supply a current-looking derived metric.
- Display rounding is not written back to input storage or used in another calculation. Editing utility entries continues to show their original saved decimal strings.
- Utility, baseline and model edits affect the next monthly read without requiring another telemetry import or outage analysis. Changing the current saved model changes the capacity basis for displayed historical months; this feature does not introduce effective-dated historical capacity models.
- Source measurements, monthly inputs, saved analyses and review history are unchanged by read-only metric calculation.

Definition references: PVsyst official documentation, **Performance Ratio PR** and **Normalised performance index** (DC module nameplate normalization and the 1 kW/m² reference irradiance).
