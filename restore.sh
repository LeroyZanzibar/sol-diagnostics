#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then echo 'Usage: ./restore.sh /path/to/backup.tar.gz' >&2; exit 1; fi
echo 'Restore requires an empty data volume; it never overwrites an existing installation.'
docker compose stop app
trap 'docker compose up -d app >/dev/null' EXIT
docker compose run --rm --no-deps -T --entrypoint sh app -c 'test -z "$(ls -A /data)" || { echo "Data already exists. Use a new Compose project/volume to restore safely." >&2; exit 1; }; tar -C /data -xzf -' < "$1"
echo 'Restored. Starting Sol Diagnostics.'
