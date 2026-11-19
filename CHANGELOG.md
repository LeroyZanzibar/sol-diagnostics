# Changelog

## 2026.11.19.2 — published November 19, 2026

- Allow each discovered VCOM field to be included or explicitly excluded. Save exclusions across reload/discovery and enforce them in request planning and normalization; excluded fields never add canonical readings. Existing imported history is not deleted. All-excluded configurations may be saved, but downloads require at least one included field.
- Suggest compatible equipment destinations with the same name/ID/alias/channel matcher and confidence levels used by CSV mapping. Preserve saved/manual mappings and exclusions; suggestions require explicit Save mappings.
- Show immediate, accessible connection-test progress through discovery and saved-state verification, with clear success/error feedback and duplicate-action protection.
- Show fixed-width masked indicators for saved API key, username, password and bearer token without returning stored values or submitting mask text. Unchanged fields preserve saved credentials.
- Keep manual preview/Apply, overlap approval, CSV imports, retained data, authentication and encryption-key protections unchanged. No scheduler, automatic analysis or SQL migration is introduced.

Pre-publication local verification: production build and 738/738 tests passed, including synthetic production-HTTP exclusions/restart/history-preservation coverage. Desktop/mobile browser checks passed for all four changes and selective preview → Apply. Standalone TypeScript retains exactly six reproduced baseline diagnostics; no new diagnostics. Live VCOM and installed-app behavior were not exercised at that checkpoint.

Published as `v2026.11.19.2` from source commit `7681f1ba07c13fe004faa0725bf56079d586b7ff`. The immutable multi-platform image digest is `sha256:d0b526316aab99b5e2426b1f92e92d149b76e002e9b2aa7f734f8ab5429d866d`. The release build passed 738/738 tests and native AMD64/ARM64 hardened persistence checks. Independent anonymous native pulls verified both architectures and the exact source/version labels. Both uploaded source/checksum assets were downloaded anonymously and byte-verified. See [the GitHub release](https://github.com/LeroyZanzibar/sol-diagnostics/releases/tag/v2026.11.19.2) for downloads and exact CI evidence. This publication-only documentation does not move the source tag or rebuild its images. Installed-app deployment is a separate stage; back up complete storage, including the independent VCOM master key, before updating.

## 2026.11.19.1 — published November 19, 2026

- Add manual VCOM imports to Performance data with the requested **Data / API setup / Field mapping / Activity** workspace, alongside the existing CSV flow.
- Save site-scoped connections and explicit equipment mappings. Encrypt provider credentials server-side with an independent private key; credentials never return to the browser.
- Download date-bounded hourly simulation, separate meter export/import, inverter energy, and combined satellite/selected-POA irradiance. Retain source and completeness evidence; partial simulation sums remain unscaled and are disclosed for review.
- Keep manual downloads running without an open browser and resume from durable downloaded responses. Imports stop at preview and require explicit Apply, including overlap acceptance. Older readings, omitted/blank corrections and saved analyses retain the existing preservation rules.
- Add a streaming, revision-pinned CSV export. Numeric negatives are preserved; formula-like text is prefixed with an apostrophe for spreadsheet safety.
- No automatic refresh, automatic analysis, or analysis-engine changes. The one-calendar-year limit applies to each download, not retained history; installed-app deployment is a separate rollout stage.

Published as `v2026.11.19.1` from source commit `0cef17be68e2a41cdac9c56565bc6a1089e2b9a0`. The immutable multi-platform image digest is `sha256:79c469fba735b86806ffb280158ffa54338b30bdbd38d5f321e2d2595b02cd92`. The release build passed 685 tests and native AMD64/ARM64 hardened persistence checks. Independent anonymous native pulls verified the exact image/source/version labels; both uploaded source/checksum assets were downloaded anonymously and byte-verified. Independent specification and quality/integration reviews approved the feature, with synthetic production-HTTP and browser coverage. Six baseline-existing standalone TypeScript diagnostics remain unchanged; live VCOM authentication was not tested. See [the GitHub release](https://github.com/LeroyZanzibar/sol-diagnostics/releases/tag/v2026.11.19.1) for downloads and exact CI evidence. This documentation records publication without moving the source tag or rebuilding its images. Back up complete app storage and preserve the independent VCOM master key before any installed-app update or data move.

## 2026.11.16.1 — published November 16, 2026

Published as `v2026.11.16.1` from source commit `bed533927225a531b672ce9a6cffa6836fbbc9cf`. The immutable multi-platform image digest is `sha256:2b460a7b99554472679af1bd17273ee76c2f31d3e5240af71c97850049a1655a`. The production build, 535 tests, native AMD64/ARM64 hardened persistence smoke tests, and independent anonymous native pulls passed. Both source/checksum assets were downloaded anonymously and their hashes matched GitHub and the local originals. See [the GitHub release](https://github.com/LeroyZanzibar/sol-diagnostics/releases/tag/v2026.11.16.1) for downloads and exact CI evidence. This documentation records publication without moving the source tag.

- Replace the single-retained-CSV model with cumulative, versioned performance data in one SQLite database per site. CSV and JSON imports preview overlaps and require explicit acceptance; only supplied matching timestamp/channel values replace saved values, preserving omissions and blank/null corrections.
- Retain immutable completed analyses, pinned input revisions, evidence and review/audit history. New corrections do not silently rewrite previous results or resolve findings absent from a later analysis.
- Add **Manage Analyses** for current/historical selection. Rename the parent navigation to **Analysis**, the findings page to **Findings**, and uploads to **Data management**.
- Apply shared current/older/unknown data-freshness filtering to Findings, Summaries, Timeline and supported exports, using the approved conservative analysis-input-range policy.
- Preserve existing published results after failed/canceled reruns, and distinguish fresh current-input analysis from original-input Retry after a failed first attempt. Bind import validation and staging to the same revision to reject concurrent grid changes safely.
- Require explicit non-destructive migration of an available legacy CSV; retain original source/import records, saved analyses and reviews. No new deletion/archive controls or retention garbage collection.
- Feature-baseline verification passed the production build, 532 tests, independent specification/quality/final integration reviews, real-browser recovery and a 1.2-million-reading storage benchmark. Release preparation added native canonical-persistence coverage and corrected a test-only temporary-directory portability issue; all 535 tests passed on the final PR, merged-source and tag runs. Six baseline-existing standalone TypeScript diagnostics remain outside this release's scope.

**Upgrade boundary:** back up the complete app data before any later authorized installation/migration. This source release does not itself update the community-store entry or installed app. Already-deleted legacy sources cannot be reconstructed; use one application instance per data volume.

## 2026.11.15.2 — published November 15, 2026

Published as `v2026.11.15.2` from source commit `f0c436d4c63fcd7365644a65f727f778bd624b94`. The immutable multi-platform image digest is `sha256:231eff9439302d98ca8bb5df67050c1d98002e9e33561c93534eb915222bb461`. The production build, 304 tests, native AMD64/ARM64 image smoke tests, and anonymous pulls passed. Release asset checksums were verified against GitHub. See [the GitHub release](https://github.com/LeroyZanzibar/sol-diagnostics/releases/tag/v2026.11.15.2) for downloads and evidence. This documentation records publication without moving the source tag.

- Group Timeline rows by issue name and stable equipment ID across recurring episodes and standalone findings.
- Preserve separate active date ranges, expandable individual occurrences, category/severity filters, overlap severity and loss details.
- Keep different equipment separate even when their display names match; leave issue detection, recurring episode records, reviews and saved data unchanged.
- Add six Timeline rendering regression tests covering grouping, equipment identity, filtering, sorting, expansion and active gaps.

## 2026.11.15.1 — published November 15, 2026

Published as `v2026.11.15.1` from source commit `134e720af6d2e1fcb2a9bdff46d07213e2fa91fa`. The immutable multi-platform image digest is `sha256:deb5cbaf899608b7659eb94d79c7ad136eeec8a54ebab46cb2e183f3227725ca`. The production build, 298 tests, native AMD64/ARM64 image smoke tests, and anonymous pulls passed. See [the GitHub release](https://github.com/LeroyZanzibar/sol-diagnostics/releases/tag/v2026.11.15.1) for source downloads and evidence. This documentation records publication without moving the source tag.

- Fix Depot performance uploads and analysis failing with `no such table: maintenance_tasks` by creating the required table through a new additive startup migration.
- Preserve existing maintenance-task records and cleanup safety checks; do not invoke legacy cleanup or delete performance data during initialization.
- Validate the maintenance table's schema before serving requests, with fresh-install, upgrade, restart, and Depot upload regression coverage.

## 2026.11.14.1 — published November 14, 2026

Published as `v2026.11.14.1` from source commit `03095fba561ad43dc9ef41211831419ff0929c8a`. The immutable multi-platform image digest is `sha256:d1d6127b86db3d0d6991eaf3626bbfe204430050484db1db97e1fc22210bd3c2`. Both native architecture images and anonymous pulls were verified. See [the GitHub release](https://github.com/LeroyZanzibar/sol-diagnostics/releases/tag/v2026.11.14.1) for downloads and verification details. The tagged source snapshot retains the pre-publication changelog; this entry records the confirmed result without moving that tag.

- Rename the displayed Foundry theme to **Light - alternate**, preserving existing saved preferences.
- Add bulk Site settings CSV upload with a downloadable template and existing-site export, preview, row-level validation, and atomic create/update.
- Adopt `YYYY.MM.DD.X` calendar release versions. `X` counts releases on that Eastern-time calendar day, starting at 1. This is the first release for November 14, 2026. The earlier `v1.0.0` tag is unchanged; the provisional `2026.11.13.2` development version was never released.
- Verify anonymous pulls of both published container architectures in release CI.

Canonical release versions live in `VERSION`. Git tags use `vYYYY.MM.DD.X`; release names and container tags use `YYYY.MM.DD.X`. npm metadata uses the implementation-only SemVer mapping `YYYY.M.D-X` (without month/day padding). CI checks that the versions agree. Recheck the date and existing GitHub releases before publishing future releases; update a pending target if the release date changes, never an already-published tag.
