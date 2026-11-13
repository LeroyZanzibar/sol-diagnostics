#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ -f .env ]; then
  echo '.env already exists; keeping your current credentials and settings.'
  exit 0
fi
umask 077
password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
printf 'SOL_USERNAME=admin\nSOL_PASSWORD=%s\nSOL_PORT=3080\nSOL_HEAP_MB=2048\n' "$password" > .env
echo 'Created local credentials in .env. Keep this file private.'
printf 'Username: admin\nPassword: %s\n' "$password"
echo 'Next: docker compose up -d --build'
