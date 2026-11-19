# Manual VCOM imports

Performance data supports manual VCOM downloads alongside CSV uploads. There is no scheduled refresh or automatic analysis in this version. Downloading creates a preview; **Apply import** is the separate action that changes saved readings.

## Connect a site

1. Select the Sol Diagnostics site and open **Performance data → API setup**.
2. Enter the exact VCOM system key and the credentials for that system. Both modes require the VCOM API key: either a supplied bearer access token, or username/password authentication (deprecated by the provider). This version does not implement interactive OAuth or automatically refresh an expired supplied token.
3. Save, then test/discover the connection. Discovery reads system and device metadata; it does not import telemetry. Connection failure is not a successful empty inventory.
4. In **Field mapping**, explicitly confirm the destinations for simulation expected production, combined irradiance, inverter energy and each meter's separate export/import readings. Meter import is **Other**, not generated Energy. Meters whose names contain `651` are excluded by the established workflow.
5. Choose an eligible POA sensor as an optional fallback, or explicitly leave fallback disabled. Satellite irradiance remains authoritative whenever it is numeric, including zero. The selected POA source is a fallback input, not another independently mapped analytical irradiance series.
6. Save mappings. Unsupported abbreviations/units, missing destinations or duplicate canonical destinations prevent readiness; correct these before downloading.

Saved secrets are never returned to the browser. Blank credential controls after loading a saved connection are expected; omitting replacement credentials preserves the saved credentials. Do not enter secrets in issue reports, screenshots or repository files.

## Download and review

On **Data**, choose inclusive site-local From/Through dates, then **Download range**. Each request is limited to one calendar year; that limit never trims stored history. A January–December request can include leap day. Unsupported time grids and future dates are rejected rather than silently changed.

The server owns the job. Closing the tab does not cancel a submitted download, and already downloaded responses are retained for restart/retry. **Activity** shows progress, failures and available retry/cancel actions. Rate limiting may postpone the next request. Changing site configuration or saved data can invalidate a pending preview; obtain a new preview instead of reusing an old approval.

The review shows new and overlapping readings, including identical overlaps and blank corrections. Any overlap requires explicit acceptance. Canceling a download/preview never applies readings. After an uncertain Apply response, the app checks the exact job and stage receipt before reporting the result; do not submit a fresh download merely to retry an unknown Apply outcome.

Apply updates only supplied matching timestamp/channel values. Existing history and unrelated channels are retained. Blank/null corrections do not erase existing numeric values; newly absent readings can remain explicit nulls. API and CSV mappings for the same equipment/measurement use the same canonical identity rather than creating duplicate vendor channels.

## What the hourly data means

- Simulation expected values use the established five-minute `/12` conversion only when the response supplies five-minute cadence evidence. A partial hour retains its unscaled partial sum and is flagged in the import's completeness evidence; it is not extrapolated to a complete hour. Entirely missing hours remain blank.
- Meter and inverter interval energy is normalized using supported source units and aggregation metadata. Inverter values are **not** divided by 12.
- Satellite/selected-POA irradiance retains numeric zero and negative source values. POA fills only missing satellite values. Unfilled gaps remain blank.
- UTC interval-start instants identify saved hours. Fall-back hours therefore remain distinct even when their local clock labels repeat. The display uses the site's timezone.
- Original source responses and per-hour completeness/source evidence are retained. Simulation and satellite interpretation is a versioned convention inherited from the established export workflow, not a claim that those API endpoints expose live unit metadata.

The review describes **this import's** completeness, not a certification that all stored historical data is gap-free. Imports do not rerun or rewrite saved analyses. Run analysis explicitly when you are ready to assess the updated data.

## CSV uploads and export

The existing CSV mapping, validation and approval flow remains available. Moving between workspace tabs keeps its pending file/preview mounted; changing sites isolates API credentials, mappings and approval drafts.

**Export CSV** downloads all applied canonical channels at one pinned data revision, with UTC timestamps and blank null values. Formula-like textual fields receive a leading apostrophe for spreadsheet safety; numeric negative readings are unchanged. This is a canonical long-format export, not a reconstruction of the original vendor file. When importing it again, review equipment and measurement mappings normally.

## Backup and operational boundary

Back up the **entire application data directory**, including the independent private VCOM credential key, shared SQLite database, per-site performance databases and source objects. The application refuses to decrypt credentials when the retained key is missing or mismatched. A database-only backup is insufficient for encrypted connections.

Use one application instance per data volume. Retry activity drains only explicitly submitted jobs; saving settings, testing the connection and visiting tabs do not schedule downloads. A source pull request is not an installed-app update; deployment and migration require the normal backup and approval process.
