# Changelog

## 2026.11.16.1 — publication pending

- Replace the single-retained-CSV model with cumulative, versioned performance data in one SQLite database per site. CSV and JSON imports preview overlaps and require explicit acceptance; only supplied matching timestamp/channel values replace saved values, preserving omissions and blank/null corrections.
- Retain immutable completed analyses, pinned input revisions, evidence and review/audit history. New corrections do not silently rewrite previous results or resolve findings absent from a later analysis.
- Add **Manage Analyses** for current/historical selection. Rename the parent navigation to **Analysis**, the findings page to **Findings**, and uploads to **Data management**.
- Apply shared current/older/unknown data-freshness filtering to Findings, Summaries, Timeline and supported exports, using the approved conservative analysis-input-range policy.
- Preserve existing published results after failed/canceled reruns, and distinguish fresh current-input analysis from original-input Retry after a failed first attempt. Bind import validation and staging to the same revision to reject concurrent grid changes safely.
- Require explicit non-destructive migration of an available legacy CSV; retain original source/import records, saved analyses and reviews. No new deletion/archive controls or retention garbage collection.
- Local feature verification: production build, 532 tests, independent specification/quality/final integration reviews, real-browser recovery and a 1.2-million-reading storage benchmark passed. Release build/native-image checks remain required before publication. Six baseline-existing standalone TypeScript diagnostics remain outside this release's scope.

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
