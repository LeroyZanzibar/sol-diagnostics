# Monthly calculated metrics

The **Projections → Monthly comparison** table adds twelve read-only calculated columns for each site. The monthly API returns the same calculations as exact rational values (`{n, d}`), together with their availability/partial-data status. They are recalculated from saved inputs on reads, not stored as independently editable or rounded copies. No database migration or historical-input rewrite is required.

## Inputs and units

- **Utility production**: the existing total of present on-peak and off-peak production entries, in kWh. Either category alone is valid; all-blank is unavailable and explicit zero is retained.
- **Projected production, budgeted revenue and projected insolation**: the existing monthly projections after start-month proration and the configured degradation rules, not the raw undegraded calendar-month baselines.
- **Actual insolation**: the existing selected monthly reporting series, integrated to kWh/m², with its retained coverage and source provenance. Expected Production is the existing monthly sum of the imported site-level Expected Production series, in kWh.
- **DC capacity**: the site's connected module nameplate watts × module quantity, summed and divided by 1,000 to obtain kWp. Do not substitute inverter AC capacity, inverter maximum-DC input limits or export limits, and do not reduce nameplate capacity for degradation or delivery losses. Missing/incomplete module capacity makes dependent metrics unavailable rather than silently using an understated total.

Conventional performance ratio uses plane-of-array insolation and a 1 kW/m² reference irradiance. The app uses the selected reporting series as configured; it does not convert GHI to POA or certify that an unknown/mixed source and a projected baseline use the same plane. Check that basis before treating PR as a contractual performance assessment. This is not a temperature-corrected or bifacial-specific PR.

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

## Availability and precision

- Missing inputs or zero denominators display an em dash with an explanation. Zero numerators remain valid zero results when their denominator is available and nonzero.
- Ratios are not capped at 100%; signed utility revenue is retained.
- A calculation using partial telemetry remains visibly partial. Refreshing telemetry does not supply a current-looking derived metric.
- Display rounding is not written back to input storage or used in another calculation. Editing utility entries continues to show their original saved decimal strings.
- Utility, baseline and model edits affect the next monthly read without requiring another telemetry import or outage analysis. Changing the current saved model changes the capacity basis for displayed historical months; this feature does not introduce effective-dated historical capacity models.
- Source measurements, monthly inputs, saved analyses and review history are unchanged by read-only metric calculation.

Definition references: PVsyst official documentation, **Performance Ratio PR** and **Normalised performance index** (DC module nameplate normalization and the 1 kW/m² reference irradiance).
