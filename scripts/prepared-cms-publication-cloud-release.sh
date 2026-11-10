#!/usr/bin/env bash
set -euo pipefail
umask 077

if ! [[ ( $# -eq 3 && ( $1 == "--seal" || $1 == "--check" || $1 == "--handover" || $1 == "--promote" ) ) ||
        ( $# -eq 4 && $1 == "--promote" && ${4:-} == "--apply" ) ]]; then
  echo "Usage: prepared-cms-publication-cloud-release.sh --seal|--check|--handover|--promote <operation-id> <commit-sha> [--apply for promote]" >&2
  exit 64
fi

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
site_root="$repository_root/site"
for variable in CF_API_KEY CF_API_TOKEN CLOUDFLARE_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_EMAIL \
  FIREBASE_CONFIG FIRESTORE_EMULATOR_HOST GOOGLE_API_KEY GOOGLE_APPLICATION_CREDENTIALS \
  GOOGLE_APPLICATION_CREDENTIALS_JSON MEDIA_MANAGER_API_KEY MEDIA_MANAGER_API_SECRET NODE_OPTIONS; do
  if [[ -v $variable ]]; then
    echo "Prepared release inherited process environment is not allowed" >&2
    exit 78
  fi
done
if [[ ${CREDENTIALS_DIRECTORY:-} != /* ]]; then
  echo "Prepared release credentials are unavailable" >&2
  exit 78
fi

cd "$site_root"
export NODE_PATH="$site_root/node_modules"
exec 9<"$site_root"
if ! /usr/bin/flock --exclusive --nonblock 9; then
  echo "Another release command is using this checkout" >&2
  exit 75
fi
exec 3<"$CREDENTIALS_DIRECTORY/firebase-service-account"
if [[ $1 == "--seal" ]]; then
  exec 4<"$CREDENTIALS_DIRECTORY/publication-storage"
  exec 5<"$CREDENTIALS_DIRECTORY/preview-storage"
  exec 6<"$CREDENTIALS_DIRECTORY/cloudflare-api-token"
fi
unset CREDENTIALS_DIRECTORY
exec /usr/bin/node --import "$site_root/node_modules/tsx/dist/loader.mjs" \
  "$site_root/scripts/prepared-cms-publication-cloud-release.ts" "$@"
