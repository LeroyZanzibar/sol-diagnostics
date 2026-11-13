# Changelog

## 2026.11.13.2 — pending release

- Rename the displayed Foundry theme to **Light - alternate**, preserving existing saved preferences.
- Add bulk Site settings CSV upload with a downloadable template and existing-site export, preview, row-level validation, and atomic create/update.
- Adopt `YYYY.MM.DD.X` calendar release versions. `X` counts releases on that Eastern-time calendar day, starting at 1. The earlier `v1.0.0` release on November 13 counts as that day's first release; its tag is unchanged.

Canonical release versions live in `VERSION`. Git tags use `vYYYY.MM.DD.X`; release names and container tags use `YYYY.MM.DD.X`. npm metadata uses the implementation-only SemVer mapping `YYYY.M.D-X` (without month/day padding). CI checks that the versions agree. Recheck the date and existing GitHub releases before publishing; update this pending version if the release date changes.
