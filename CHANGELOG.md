# Changelog

## 2026.11.14.1 — pending release

- Rename the displayed Foundry theme to **Light - alternate**, preserving existing saved preferences.
- Add bulk Site settings CSV upload with a downloadable template and existing-site export, preview, row-level validation, and atomic create/update.
- Adopt `YYYY.MM.DD.X` calendar release versions. `X` counts releases on that Eastern-time calendar day, starting at 1. This is the first release for November 14, 2026. The earlier `v1.0.0` tag is unchanged; the provisional `2026.11.13.2` development version was never released.
- Verify anonymous pulls of both published container architectures in release CI.

Canonical release versions live in `VERSION`. Git tags use `vYYYY.MM.DD.X`; release names and container tags use `YYYY.MM.DD.X`. npm metadata uses the implementation-only SemVer mapping `YYYY.M.D-X` (without month/day padding). CI checks that the versions agree. Recheck the date and existing GitHub releases before publishing; update this pending version if the release date changes.
