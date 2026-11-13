#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
umask 077
mkdir -p backups
output="backups/sol-diagnostics-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
docker compose stop app
trap 'docker compose start app >/dev/null' EXIT
docker compose run --rm --no-deps -T --entrypoint tar app -C /data -czf - . > "$output.part"
mv "$output.part" "$output"
echo "Backup saved to $output"
echo 'Keep a separate private copy of .env as well.'
