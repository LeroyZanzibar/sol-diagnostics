# Persistent performance data and analysis history

> Feature documentation for release 2026.11.16.1. Local implementation verification and all independent specification, quality and final integration reviews have passed. See CHANGELOG.md and GitHub Releases for publication status; this is not a deployment or live migration-success report.

## Data ownership

Each site has its own SQLite performance database inside `SOL_DATA_DIR/performance/`. Site identifiers are mapped to safe filenames; these databases do not live inside the disposable object-bucket namespace. The shared application database continues to hold site configuration, analysis jobs/catalog and review state. Source files and immutable analysis result/evidence objects remain in the existing object storage.

The canonical dataset accumulates readings across CSV and API imports. A timestamp identifies a UTC instant; multiple equipment/channels can have readings at that instant. A timestamp/channel pair is unique. Corrections update that pair, not a whole CSV row or date range. Older committed revisions remain available to analysis inputs.

## Import behavior

Both CSV transport and the JSON API follow:

1. Stage and server-validate incoming readings.
2. Preview added, overlapping, changed, identical and blank-preserved readings, with their affected dates/channels.
3. Explicitly accept overlap before applying it.
4. Commit the approved import atomically to the site's database.

Preview and cancellation do not modify the authoritative measurements. API clients must present overlap information and obtain deliberate user acceptance, not automatically submit `approveOverlap: true` for every response.

### Replacement scope

- Supplied values replace only matching timestamp/channel values after approval.
- Omitted timestamps and channels remain intact, including inside the incoming time range.
- Blank CSV cells and JSON `null` do not clear existing values. A previously absent key may retain explicit missingness/coverage.
- Numeric zero is a value, not a blank.
- Clearing/deleting readings is not exposed by this import workflow.
- Conflicting duplicate keys inside one import are rejected rather than silently added together.
- Identical overlaps still require acknowledgement, even though their values do not change.

The server binds approval to the staged input, source mapping/model state and current dataset revision. If these change, preview again. Stage IDs identify idempotent commits: if a response is lost, read back the same stage or deliberately retry that stage, rather than creating a new import and blindly replaying it.

Validation and stage creation also use the same exact data revision. If another import commits while a JSON/CSV/migration preview is being validated, the server rejects that preview with 409 instead of silently adopting a newer interval grid. Start a fresh preview against the new saved data.

### Time, channels and units

Offset-free timestamps use the selected source IANA timezone. Ambiguous/nonexistent local times must be corrected or supplied with explicit offsets. Interval-end measurements are normalized to interval starts exactly once. Snow observations retain their observation instant, including `Status` and `Other` mappings on a configured weather sensor named `Snow sensor`. These events do not establish the interval cadence/grid; an event-only wide CSV row does not create production coverage from its otherwise empty interval columns. Other equipment's status mappings are not reinterpreted as snow observations. The first dataset import establishes the reporting timezone and cadence; later sources may have another timezone but must use compatible interval boundaries/cadence.

Calendar dates must be valid before normalization, and timestamp precision must be supported at millisecond resolution. Invalid dates must not roll into another month, and unsupported sub-millisecond precision must not silently collapse distinct readings.

Equipment must resolve unambiguously to a configured site identity. The JSON API uses exact equipment IDs. Site expected interval energy uses equipment `@site` and measurement `Expected Production`. Channels retain stable identity across imports and unit conversions. Distinct physical channels must not be silently collapsed into a single implicit equipment/measurement mapping.

CSV import validation runs on the server over all records; browser validation is helpful feedback, not authority. A partial import need not contain every configured meter. The assembled dataset must still satisfy the analyzer's existing model/input requirements. One-timestamp corrections require an established or explicitly supplied cadence.

## Existing installations

A retained single-file dataset is not discarded or silently replaced. Where a site has a retained legacy CSV but no canonical database revision, Performance data exposes a migration preview first. Review and apply that file before adding new cumulative data. The original CSV/import record, completed analyses and review/audit records remain retained.

Migration cannot reconstruct older source files that a previous application version already deleted. Invalid or ambiguous legacy data must be corrected rather than silently coerced into a different dataset.

Before an authorized deployment/migration, take a recoverable full-app-data backup and verify restoration. Include the shared database, all per-site performance databases, their required SQLite state and object files together. For the standalone edition, the existing stopped-app whole-data backup/restore workflow covers the new directory. For Umbrel-managed installations, use the store's documented backup route; do not run standalone scripts against the live Umbrel volume.

## Analyses and freshness

Completed analysis results and evidence are immutable snapshots of a pinned input revision. Later measurement corrections do not rewrite those results, change their issue identities, delete notes, or silently mark reviewed issues resolved.

The published-current selection is a pointer to a saved result, not the complete issue archive. A successful rerun can replace what the current reports display without deleting the previous result or its review history. A finding absent from the selected analysis is absent from its Summaries; a saved review does not force that finding into every later report. Changed event boundaries can create a new finding identity requiring a new review.

An unsuccessful rerun must not hide an existing published result. Canceled, failed and interrupted attempts are reported separately from that result; Findings shows the prior published analysis and offers an explicit retry. Selecting an already-selected run is idempotent. Historical selections are read-only and do not start work.

After a stopped first attempt with no saved result, **Run analysis** starts a fresh analysis using current data and the current equipment model. **Retry analysis** intentionally uses the failed attempt's original saved inputs. Use Run analysis after correcting those inputs; browsing alone never starts a job. The stopped attempt remains visible while the fresh-start option is offered, and the two actions are unavailable during active work or when a historical analysis is selected.

The first version uses a **conservative analysis-range assessment**, not precise per-finding dependency tracking. Calculations can depend on other days, peers and site-level inputs, so a correction outside a finding's event window can still affect it.

The dependency domain includes supported POA/GHI irradiance and site-level expected production. When snow observations are used, their scope covers complete boundary days in the saved reporting timezone, not just the first and last production instants: an earlier observation can classify production later on the same local day.

- **Current data:** relevant semantic inputs in the saved analysis domain match current data.
- **Based on older data:** relevant inputs in that domain differ. All findings from that analysis can receive this flag; some may remain unchanged after reanalysis.
- **Freshness unknown:** the old analysis lacks sufficient provenance or comparison inputs are unavailable. Unknown is never presented as current.

Identical reuploads and unrelated additions outside the fixed input domain do not by themselves make an analysis older. Freshness is separate from analyst confirmation/dismissal and issue resolution. A completed historical run may be based on current data without being the site's currently published run, and vice versa.

Findings, Summaries and Timeline share the Data freshness filter: All items, Current data only, Based on older data. Unknown findings remain visible in All items. Filtering is applied before aggregation/grouping and reflected in supported exports. Historical analysis results remain unchanged by filtering.

## Navigation

```text
Analysis
  Findings
  Summaries
  Timeline

Data management
  Performance data
  Maintenance data
  Manage Analyses
```

Manage Analyses provides site-specific browsing/selection of current and historical runs, their analyzed ranges, run metadata, finding counts, source revisions and freshness. Selecting a saved analysis changes the reporting view; it does not republish, recalculate or delete anything. New archive/delete actions are outside this feature.

## JSON API contract

All endpoints require the application's existing authentication. Mutations retain same-origin protection. Previews and readbacks use `Cache-Control: no-store`.

### Inspect a site or staged import

```text
GET /api/performance-data?siteId=SITE_ID
GET /api/performance-data?siteId=SITE_ID&stageId=STAGE_ID
```

The site response contains `dataset`, committed `imports`, `legacyImport` and `requiresMigration`. Stage readback returns `preview`, including its committed result when applicable.

### Preview readings

Illustrative request; replace `SITE_ID` and `EXACT_EQUIPMENT_ID` with saved IDs:

```json
{
  "action": "preview",
  "siteId": "SITE_ID",
  "fileName": "API correction",
  "timezone": "UTC",
  "timestampConvention": "start",
  "intervalMinutes": 5,
  "readings": [
    {
      "timestamp": "2026-06-01T12:00:00Z",
      "equipmentId": "EXACT_EQUIPMENT_ID",
      "measurement": "Energy",
      "unit": "kWh",
      "value": 12.5
    }
  ]
}
```

Send to `POST /api/performance-data`. The response is a preview, not a saved canonical import. Use the returned `stageId` and `previewToken`; do not manufacture them.

### Apply after review

```json
{
  "action": "commit",
  "siteId": "SITE_ID",
  "stageId": "STAGE_ID_FROM_PREVIEW",
  "previewToken": "TOKEN_FROM_PREVIEW",
  "approveOverlap": true
}
```

Set overlap approval only after acceptance. A successful response returns `committed`, the committed `result` and current `dataset`. A stale preview or changed model requires a new preview; do not bypass the check.

Cancel with `{"action":"cancel","siteId":"SITE_ID","stageId":"STAGE_ID"}`. Preview legacy migration with `{"action":"previewLegacy","siteId":"SITE_ID"}`, then use the same apply flow.

### CSV transport

Existing multipart `/api/telemetry-imports` and chunk/finalize endpoints retain their mapping/source metadata inputs but now return `{preview}`. Clients must use the common commit endpoint; a successful byte upload is not permission to overwrite measurements.

### Analysis history and freshness

```text
GET /api/analysis-history?siteId=SITE_ID
GET /api/analysis-history?siteId=SITE_ID&before=OPAQUE_CURSOR
GET /api/analysis-history?siteId=SITE_ID&runId=RUN_ID
GET /api/analysis-freshness?siteId=SITE_ID&runId=RUN_ID
```

Freshness returns status, comparison revision/time, reasons and `dependencyScope: "analysis-range"`. Existing completed analyses without provenance return unknown. Browsing these endpoints does not start a new analysis.

Start analysis explicitly with `POST /api/performance-summary` and `{"siteId":"SITE_ID","action":"reanalyze"}`. The normal summary GET returns the published result or work status. If a newer attempt stopped but a published result remains, `hasData` stays true and `issueDatabase.analysisRunId` still identifies that published run; additive `lastAttempt` metadata describes the stopped attempt. Query an exact `attemptId` or `progressOnly=1` for attempt-specific status rather than treating that status as the identity of the published result. Retrying uses the returned attempt ID and the existing explicit `retry` action.

## Verification and limits

Implementation verification includes real SQLite rollback/restart/version tests, production HTTP CSV/API approval and migration tests, unchanged historical review/results, filtered report/export membership, and browser interaction on isolated synthetic data. The feature-baseline production build and 532-test suite passed, including data/model correction after a failed first analysis. All specification and quality findings are independently closed, and the final integration review approved the unchanged source after 108 additional focused tests. Actual retained-file migration matches nonempty baseline results for all supported snow-code mappings, including local-midnight/DST cases. The synthetic benchmark script `scripts/benchmark-performance-data.mjs` measures ingestion, revision reads and fingerprints without opening a live dataset.

Release 2026.11.16.1 subsequently passed the production build and all 535 tests on the final PR, merged-source and tag runs. Real hardened native AMD64/ARM64 images preserved exact canonical values and approval receipts across restart and container recreation; independent anonymous native pulls and source/version labels also passed. The [release notes](https://github.com/LeroyZanzibar/sol-diagnostics/releases/tag/v2026.11.16.1) identify the immutable source, image digests and verification runs. Release-only additions and the test-path portability correction received separate scoped reviews without changing application behavior.

A synthetic run with 100,000 timestamps × 12 channels (1,200,000 readings) verified pinned-revision retention after a correction. It measured staging at 19,592.10 ms, commit at 4,488.07 ms, reading at 2,721.83 ms and fingerprinting at 3,741.63 ms, with peak resident memory of 271,867,904 bytes. These are observed local storage measurements, not service-level guarantees or detector benchmarks.

Database connections are bounded at 64 per manager, with idle connections parked and reopened on demand. An active reader/import pins its connection; if all slots are busy, a new request can temporarily return `STORE_CAPACITY` and should retry after active work ends. Merely visiting more than 64 sites sequentially does not exhaust the manager permanently. Retained versions and raw evidence consume disk; this feature does not add retention garbage collection.

The standalone TypeScript check is not clean: the repository's pre-existing D1/R2 ambient-type declarations remain unresolved. A fresh baseline checkout using the same dependencies also fails on those diagnostics. This is separate from the passing production build and regression suite.

Storage streaming/indexing is not a guarantee that the existing detection engine can analyze unlimited history within a fixed memory/time budget. Report measured workload, timings and memory separately from production sizing claims. No data-retention garbage collection or destructive analysis-management interface is added here.

Run one application instance per data volume. Synchronous revision/configuration guards do not create an atomic transaction across the shared database, object storage and separate per-site databases. Docker/ARM execution was verified in the subsequent release CI, not by the local development run. Live Umbrel upgrade/migration/restore and production sizing remain unverified for this release; publication did not update the community-store entry or installed app.
