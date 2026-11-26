# Persisted monthly Unconfirmed estimated loss

## Contract

`GET /api/monthly-data` and successful monthly mutation readbacks include
`unconfirmedLoss` alongside the unchanged `confirmedLoss` contract. Preview
responses do not include either derived field.

Unconfirmed means **effective Unreviewed or Needs review**, using the same
`effectiveReviews` / `effectiveReviewStatus` assessment as findings. An old stored
Confirmed or Dismissed decision can therefore contribute when its current
assessment is Needs review. Effective Confirmed and Dismissed are excluded.
The two partitions share one selected current publication and final review fence.
Completed unpublished and historical browsing selections are not summed.

Allocation reuses the Confirmed service's publication selection, original-finding
visibility/deduplication and interval-aware site-local month allocation. Counted
interval losses remain authoritative; no duration-prorated replacement or
frontend loss calculation is introduced. Fractions are stored unrounded.

## Persistence and freshness

Migration `0024_monthly_unconfirmed_loss.sql` adds `monthly_unconfirmed_loss` to
the shared SQLite database already containing `monthly_configuration`,
`monthly_utility` and `monthly_rollups`. It does not change per-site canonical
telemetry databases, editable monthly strings, existing telemetry caches, saved
analyses, review records, or historical migration bytes.

One row per exact site ID materializes the whole derived monthly snapshot:

- `site_id`: primary key, site foreign key with delete cascade;
- `calculation_version`: private calculation schema version (currently 1);
- `publication_identity`: exact selected input, publication pointer, run ownership,
  status, coverage input and maintenance-selection identity;
- `review_identity`: relevant direct and recurring-parent review keys, versions,
  persisted state, update timestamps and evidence-run identity;
- `payload_json`: complete monthly `unconfirmedLoss` object, including exact
  numerator/denominator strings, availability, timezone and finding counts.

This is an **on-demand materialization**, not an editable input and not a cache
trusted independently of its publication/reviews. Each monthly API read reloads
the current published findings and effective reviews. A final non-yielding shared
SQLite write transaction rechecks selection/review identity before upserting the
materialization. Concurrent changes retry once; continued changes return
`refreshing`, not an obsolete value. Identical reads leave row bytes unchanged.
Review/publication changes therefore take effect on the next permitted monthly
read even when monthly-input and telemetry revision numbers are unchanged.

Retained rows survive restart but are never served as a shortcut around current
source validation. Missing or unreadable publication is materialized as explicit
missing/unavailable rather than retaining an apparently-current response. If
storage itself is unavailable, Unconfirmed is unavailable; independently valid
Confirmed values and utility saves remain usable. An older retained row in that
failure case is only a previous materialization, never read authority.

## Availability and UI

`months[YYYY-MM]` contains `value`, `state`, `unconfirmedCount`, `unknownCount`
and `reason`. A covered month without contributions is a complete numeric zero.
Unknown loss makes the whole monthly total null/partial, not a known subtotal.
Outside established coverage, there is no fabricated zero. Source states remain
current, refreshing, missing or unavailable.

Monthly comparison has a read-only whole-kWh column. Charts adds Unconfirmed
estimated loss under Production, using the authoritative snapshot for line,
bar, table, date ranges and prior-year comparisons. Compact hover shows only
selected metrics and enabled periods; explicit details retain effective-status
semantics, publication identity, timezone, coverage and counts. The shared metric
catalog also controls server saved-view validation/restoration.

No refresh cadence changes: Charts reads only on mount/page refresh, site change
or explicit error Retry, retains timeout/cancellation, and never polls. Monthly
editor retains its existing polling and draft guards without widening them.

## Verification boundaries

Feature tests exercise native SQLite, effective review transitions (including old
Confirmed/Dismissed becoming Needs review), inheritance/direct exceptions,
publication changes while reads are held, unknown/zero, stale retained cache
repair and storage failure isolation. Production HTTP tests use a newly built
server and isolated synthetic populated results, perform real review API writes,
verify independent New York month-boundary totals, inspect persisted row bytes
before and after server restart, restore a saved view through the actual chart
component/data hook, and render the comparison component.

These are production HTTP/native-storage and deterministic component tests, not
claims of a live deployment, customer-data run, interactive browser acceptance,
or native-container image execution.
