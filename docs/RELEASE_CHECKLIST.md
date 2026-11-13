# Public release checklist

## Preparation evidence (November 13, 2026)

- The supplied directory was not an initialized Git repository. No source commit, push, tag, registry publication, or deployment was made during this preparation.
- Node **24.22.3** was downloaded from nodejs.org into the ignored `.release-local/` directory; its archive SHA-256 matched the official SHASUMS256.txt. This is download-integrity verification, not independent signature verification.
- `npm ci --no-audit --no-fund` was attempted with Node 24. It failed with `ENOSPC`: the persistent filesystem had only roughly 13,000 free inodes at the failure check despite 35 GB free space. The chained build and full test suite therefore **did not run**. The newly created npm download cache was removed. Do not delete unrelated data to make room without approval.
- `node --test tests/selfhost/storage.test.mjs` on Node 24: **5 passed, 0 failed**.
- `node --check scripts/container-smoke.mjs`: passed. Workflow YAML, all pinned action input names, and embedded Bash syntax were checked locally. Ignore rules were checked against 13 representative paths, including allowing `.env.example` and `public/maintenance-template.csv`.
- Docker CLI exists, but no Docker daemon is reachable. **Neither architecture image nor the container smoke script has been executed here.** GitHub runners must provide that evidence.
- All six action release tags were resolved through the official GitHub API to full commit SHAs; the API marked each commit signature verified. Each pinned `action.yml` was also retrieved, and configured input names were checked against it. This verifies identity/availability, not a security audit of the actions.
- Existing application, database, migration, calculation and test files were left unchanged; the lockfile and Dockerfile were not changed.

Local-only baseline hashes, download checksums, action metadata and test/install logs are under `.release-local/`, excluded from Git and Docker build context. Do not publish that directory.

## Secret and operational-data inspection

The initial 223-file tree was inventoried and checked for common GitHub/OpenAI/AWS token patterns and private-key headers. No matching credentials were found. The only environment file was `.env.example`, with an empty password. No SQLite/database dumps, customer spreadsheets, or source archives were found. The only CSV asset was the supplied maintenance template. The `public/og.png` asset was visually checked: it contains product branding and abstract artwork, not a customer dashboard or credentials. This is a bounded inspection, not proof that every possible secret format or confidential string is absent.

The archive's `.vinext/` generated font cache is now excluded. `.gitignore` and `.dockerignore` exclude databases, environment secrets, operational data, backups, uploads, archives and local release tooling. Ignore rules do not remove already tracked files: the release owner must inspect the actual staged tree before publication.

## Source and license provenance gates

1. **No top-level application LICENSE was supplied.** The README identifies hosted version 116 and source commit `0820d6762070df30649ee47dba79e5ab29286c46`, but no upstream Git history or ownership/assignment evidence accompanies the extracted tree. Confirm rights to publish this application and its branding/artwork, and select an application license only with the rights holder's authorization. This preparation does not invent a license or claim provenance was independently established.
2. Existing Inter, Outfit, and DM Serif Display font OFL notices remain in `public/fonts/`. The build imports Geist and Geist Mono through `next/font/google`; verify that redistributed generated font assets have the applicable upstream notices. Excluding the old font cache does not eliminate responsibility for fonts generated into the image.
3. Lockfile license metadata includes **LGPL-3.0-or-later** (sharp/libvips platform packages), **MPL-2.0** (including lightningcss, resvg, satori, axe-core), and **CC-BY-4.0** (caniuse-lite), alongside permissive packages. These are review flags, not a claim that every platform package enters each image or that publication is prohibited. Review the actual shipped binary/source/license and notice obligations before distributing images.
4. The current final image copies all `node_modules`, including development dependencies. `vinext` is a development dependency but is required at runtime, so blindly running `npm prune --omit=dev` would break startup. Narrowing dependencies is separate work requiring tests. Retain included dependency notices; prepare a dependency/license inventory and required source/notice materials for the exact final image.
5. Dependency versions remain as supplied. This preparation did not complete a vulnerability audit or issue a security certification. Review an up-to-date dependency/image scan before promoting a release.

## CI and release-owner gates

- Use the canonical `VERSION` format `YYYY.MM.DD.X`: zero-padded month/day, with X starting at 1 and incrementing for releases on that day in America/New_York. Check the actual publication date and existing GitHub releases/tags before allocating the next number; count earlier releases that day even if they used the legacy format. Never move old tags.
- Keep release names, Compose/container tags, and the future Umbrel package version aligned with `VERSION`; Git tags have a leading `v`. npm metadata alone uses the SemVer-compatible mapping `YYYY.M.D-X`. Run `node scripts/check-release-version.mjs` locally; CI validates this mapping and, for tag builds, exact tag equality. Update the pending changelog and README if publication moves to another day.

- Push source only after the provenance review and staged-content review. Protect `main` and release tags and restrict who can push a `v*` tag; such a push is the publication trigger. Re-running a tag workflow can replace that tag's image, so use immutable release tags operationally.
- Run validation on `main` first. The first job runs `npm ci`, `npm run build`, then `npm test` because the integration suite starts the built production server.
- Native `ubuntu-24.04` and `ubuntu-24.04-arm` jobs must both pass. No emulation is used. They build once, load and smoke-test that image, then push those same image bytes for tag releases.
- The smoke script binds a temporary synthetic-data directory, initializes ownership to UID/GID 1000, and runs the app as 1000:1000 with no capabilities, `no-new-privileges`, a read-only root and a `/tmp` tmpfs. It checks unauthenticated and wrong-password rejection, authenticated UI/API access, cross-origin write rejection, SQLite site/preferences and actual HTTP-uploaded object bytes surviving restart and recreation, and Docker HEALTHCHECK health. It does not claim browser UI automation or a real Umbrel deployment.
- The app's credential variable is **`SOL_PASSWORD`** (minimum 16 characters), not `APP_PASSWORD`. An Umbrel wrapper may map its generated `APP_PASSWORD` to `SOL_PASSWORD`; verify the mapping. Persistent bind mounts must be writable by 1000:1000 before startup.
- A failed architecture cannot produce the merged release index. A successful architecture might leave a candidate `ci-...-ARCH` image if the other architecture fails; this is not a completed release.
- The merge job downloads the two digest artifacts, publishes the Git-tag version with its leading `v` removed (for example `v2026.11.13.2` → image `2026.11.13.2`), and reads the index back to verify exactly linux/amd64 and linux/arm64 and both expected digests. There is deliberately no automatic `latest` tag and no GHCR publish on pull requests or manual dispatch.
- After publication, separately verify GHCR package visibility and anonymous pulling of the released multiarch image. Public repository visibility does not prove public package visibility. Retain the resulting immutable multiarch digest for the Umbrel manifest.
- Docker base tags and Node 24 patch versions currently float. Actions are pinned, but the overall image is not claimed to be fully reproducible or byte-identical between rebuilds.
