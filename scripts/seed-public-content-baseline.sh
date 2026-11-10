#!/usr/bin/env bash
set -euo pipefail
umask 077

if ! [[ ( $# -eq 6 || ( $# -eq 7 && ${7:-} == "--apply" ) ) &&
        $1 == "--target" && ( $2 == "production" || $2 == "development" ) &&
        $3 == "--dist" && $4 == /* && $5 == "--prepared" && $6 == /* ]]; then
  echo "Usage: seed-public-content-baseline.sh --target production|development --dist <directory> --prepared <file> [--apply]" >&2
  exit 64
fi

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
site_root="$repository_root/site"
for variable in CF_API_KEY CF_API_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_EMAIL \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN NODE_OPTIONS; do
  if [[ -v $variable ]]; then
    echo "Baseline operator inherited credentials are not allowed" >&2
    exit 78
  fi
done
cd "$site_root"
export NODE_PATH="$site_root/node_modules"
exec 9<"$site_root"
if ! /usr/bin/flock --shared --nonblock 9; then
  echo "Another release command is using this checkout" >&2
  exit 75
fi
if [[ ${7:-} == "--apply" ]]; then
  if [[ ${CREDENTIALS_DIRECTORY:-} != /* ]]; then
    echo "Baseline storage credentials are unavailable" >&2
    exit 78
  fi
  exec 3<"$CREDENTIALS_DIRECTORY/publication-storage"
fi
unset CREDENTIALS_DIRECTORY
exec /usr/bin/node --import "$site_root/node_modules/tsx/dist/loader.mjs" \
  "$site_root/scripts/seed-public-content-baseline.ts" "$@"
