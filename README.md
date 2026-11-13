# Sol Diagnostics — Docker edition for UmbrelOS

A self-contained edition of Sol Diagnostics based on hosted version 116 (source commit `0820d6762070df30649ee47dba79e5ab29286c46`). Release 1.0.0, prepared November 13, 2026.

The complete application is included: site and array configuration (including transformers), performance CSV imports, cached/resumable analyses, issue review and recurring groups, visibility settings, summaries and spreadsheet exports, Timeline, maintenance CSV/Excel uploads, and all three themes.

Analysis rules, loss calculations, timestamps, and review logic are retained. The hosting layer uses Node.js 24, SQLite, and local object files. No Cloudflare or ChatGPT account, API key, or subscription is needed to run this edition.

## Umbrel community-store installation

The Umbrel package is maintained separately in
[Leroy's Umbrel App Store](https://github.com/LeroyZanzibar/Leroys-umbrel-app-store).
Add that repository in **App Store → ⋯ → Community App Stores** and install
**Sol Diagnostics** when the release is available. The package uses a prebuilt,
digest-pinned image and preserves data across ordinary app updates. Sign in as
`admin` with the unique app password shown by Umbrel.

The instructions below describe the **standalone Docker edition**, not the
Umbrel-managed package. Do not run `setup.sh`, `backup.sh`, or `restore.sh` against
an Umbrel-managed installation. See the store README for its storage and backup
instructions. Neither route automatically imports existing hosted data.

## What is included — and what is separate

- Full source, locked dependencies, Dockerfile, Docker Compose configuration, setup/backup/restore scripts, and tests.
- A persistent Docker volume stores site configurations, uploaded CSVs, analyses, reviews, maintenance records, and preferences.
- A local password protects the UI and all application endpoints. The browser displays its normal username/password prompt.
- **The first installation starts empty.** Hosted site settings, files, analyses, and review history have not been copied into this package. A full transfer of existing cloud records is a separate migration step. The hosted site has not been changed.
- Running this repository's standalone Compose file does not create an Umbrel home-screen tile; use the separate community-store package for that integration.

## Requirements

- UmbrelOS with Docker Engine and Docker Compose v2, or its Portainer Docker environment.
- A 64-bit x86 or ARM Linux system supported by the official `node:24-bookworm-slim` image. ARM and Docker image execution have not been tested in this development environment.
- Suggested starting resources: 4 GB free RAM for the build and normal use; 8 GB system RAM or more for large sites alongside other Umbrel apps. Actual requirements depend on upload and analysis size.
- Free disk space for dependencies, Docker layers, uploads, retained results, and backups.
- Internet access for the initial image/dependency download. Analysis and local data storage run locally; map tiles and postal-code lookups use external services, and some font fallbacks can use Google Fonts.

Umbrel documents custom Docker/Compose applications through Portainer:
https://umbrel.com/support/apps/running-custom-docker-containers

## Install from an Umbrel terminal

Use a directory you control on persistent storage, outside any existing app's data directory. Copy the downloaded archive there. Open a terminal on your Umbrel with access to its Docker daemon (or use the Portainer workflow below).

```sh
tar -xzf Sol-Diagnostics-Umbrel-1.0.0.tar.gz
cd sol-diagnostics-umbrel
sh setup.sh
docker compose up -d --build
docker compose ps
```

`setup.sh` generates a unique password, prints it once, and saves it in the private `.env` file. Running setup again preserves the existing settings. Do not share `.env`.

Open `http://umbrel.local:3080`, or use your Umbrel server's LAN IP with port 3080. Sign in as **admin** with the generated password. The first launch opens **Site settings** to add your first site. Then configure its **Array model**, upload **Performance data**, and run the analysis. Upload your cross-site maintenance calendar through **Data uploads → Maintenance data**.

If port 3080 is already occupied, edit `SOL_PORT` in `.env` and run `docker compose up -d` again. Read startup errors with:

```sh
docker compose logs --tail=100 app
```

For remote access from your laptop, use your existing Tailscale connection and the Umbrel server's Tailscale IP with port 3080. Use Tailscale or an HTTPS reverse proxy for remote access; do not port-forward this HTTP service to the public Internet. Local password authentication does not itself encrypt HTTP traffic.

### Portainer workflow

The archive is **source**, not a prebuilt Docker image. First build the image in the Docker environment managed by Portainer. Extract the archive, then run `docker compose build` from the extracted directory against that same Docker daemon. This creates the image tagged `sol-diagnostics:1.0.0`.

Create a stack from `docker-compose.yml`, remove the `build: .` line, and set the environment variables in Portainer (at minimum `SOL_PASSWORD` to a unique password of at least 16 characters). Keep the named `sol-data` volume; do not replace it with an ephemeral container directory. Deploy the stack and open the server on port 3080.

Custom containers are managed in Portainer and do not automatically appear as Umbrel home-screen apps. Back up the volume before removing Portainer or its managed containers.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SOL_USERNAME` | `admin` | Local login and review audit actor. |
| `SOL_PASSWORD` | Generated by setup | Required password; minimum 16 characters. |
| `SOL_PORT` | `3080` | Port published on the Umbrel server. |
| `SOL_BIND_IP` | `0.0.0.0` | Host interface for the published port. Set a specific LAN/Tailscale address if preferred. |
| `SOL_HEAP_MB` | `2048` | Node heap budget. Allow additional RAM for buffers and the OS. |
| `SOL_PUBLIC_URL` | Empty | Full external origin when using an HTTPS reverse proxy, e.g. `https://solar.example.com`. |

Advanced: `selfhost/server.mjs` also accepts `SOL_PASSWORD_FILE` for a mounted Docker secret and `SOL_DATA_DIR` for the writable data directory. The supplied Compose file uses `/data` and a named volume. Use one application instance per data volume.

Passwords are local to this application, separate from your Umbrel login. Changing the profile name in User Settings does not change the login username. To rotate the password, edit `.env`, recreate the service with `docker compose up -d --force-recreate`, and close/reopen the browser session to clear its cached login.

## Persistence and backups

The normal Compose project name is `sol-diagnostics`. Its named volume is normally `sol-diagnostics_sol-data`. Container recreation and application rebuilds preserve it. Do not run `docker compose down -v` unless you intend to delete the local application data.

Create a consistent backup:

```sh
sh backup.sh
```

This briefly stops the application, archives the entire data volume (database and files together), and restarts it. Copy the resulting file from `backups/` to another device, and keep a private copy of `.env`. Backups contain your operational data.

Restore into an **empty** volume using the same application release:

```sh
sh restore.sh /absolute/path/to/sol-diagnostics-backup.tar.gz
```

The restore script refuses to overwrite existing data. For a parallel recovery installation, use a separate copy of the package with a different Compose project name and unused port. Preserve the original volume until recovery is verified.

## Updates

1. Run `sh backup.sh` and retain the previous package/image.
2. Replace application source with the new package, preserving `.env` and backups.
3. Keep the Compose project name and volume name unchanged.
4. Run `docker compose up -d --build`.

Database migrations run automatically at startup. A modified previously applied migration causes a clear startup error instead of silently changing your schema. To downgrade after a schema-changing update, restore a pre-update backup with the matching application version.

## Verification

The following results were reported by the archive producer; they are not a claim that the public-release preparation reproduced the full build or suite:

- Production Node build passed.
- **263 tests passed**, including existing calculation, timezone, transformer, review, recurring-issue, maintenance, and upload tests.
- A real HTTP test of the built production server created a site and array model, uploaded a two-part performance CSV, completed an analysis, saved a confirmed review, imported maintenance, restarted the server, and verified retained data and unchanged cached losses.
- Storage tests cover atomic SQL rollback, streamed files, interrupted replacement, metadata, pagination, and persistence.
- Authentication tests reject unsigned requests and cross-origin changes.

**Verification limit:** Docker Engine and an Umbrel device were unavailable in this workspace. The actual Docker image build, ARM execution, resource sizing for your largest production dataset, and deployment on your Umbrel still need to be verified there. Browser interactions use the existing interface; no new visual redesign is included.

To run the checks on a machine with Node 24:

```sh
npm ci
npm run build
npm test
```

The source archive contains no installed `node_modules`, production data, or credentials. Docker builds the production assets from the supplied lockfile. Existing dependency versions were retained; this release does not perform a dependency upgrade.

## Public release CI

`.github/workflows/release.yml` first installs locked dependencies, builds, and runs the full suite on Node 24. Only after those checks pass, separate native Linux amd64 and arm64 runners build the Docker image and run `scripts/container-smoke.mjs`. The smoke check requires a Docker daemon and tests UID 1000, a read-only root filesystem, a writable `/data` bind mount, password protection, cross-origin rejection, and database/upload persistence across restart and container recreation.

Pull requests, pushes to `main`, and manual runs validate without publishing. A pushed `v*` tag additionally publishes the smoke-tested architecture images to GHCR, then merges their immutable digests into a two-platform index tagged with the exact Git tag. No `latest` alias is created. Package visibility is separate from repository visibility and must be checked by the release owner.

See [the release checklist](docs/RELEASE_CHECKLIST.md) for verification limits, source/license provenance review, and release-owner gates. This preparation did not publish a container or deploy an Umbrel app.
