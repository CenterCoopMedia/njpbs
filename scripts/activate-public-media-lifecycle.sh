#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 2 || $1 != "--apply" || $2 != /* ]]; then
  echo "Usage: activate-public-media-lifecycle.sh --apply <absolute-prepared-artifact-path>" >&2
  exit 64
fi

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
site_root="$repository_root/site"
operator_path="$site_root/scripts/activate-public-media-lifecycle.ts"
tsx_import="$site_root/node_modules/tsx/dist/loader.mjs"
credential_environment_variables=(
  CF_API_KEY
  CF_API_TOKEN
  CLOUDFLARE_API_KEY
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_EMAIL
  FIREBASE_CONFIG
  FIRESTORE_EMULATOR_HOST
  GOOGLE_API_KEY
  GOOGLE_APPLICATION_CREDENTIALS
  GOOGLE_APPLICATION_CREDENTIALS_JSON
  NODE_OPTIONS
)

cd "$site_root"
export NODE_PATH="$site_root/node_modules"
for variable in "${credential_environment_variables[@]}"; do
  if [[ -v $variable ]]; then
    echo "Public media lifecycle activation inherited process environment is not allowed" >&2
    exit 78
  fi
done
if [[ ${CREDENTIALS_DIRECTORY:-} != /* ]]; then
  echo "Public media lifecycle activation credentials are unavailable" >&2
  exit 78
fi

exec 3<"$CREDENTIALS_DIRECTORY/cloudflare-api-token"
exec 4<"$CREDENTIALS_DIRECTORY/firebase-service-account"
exec 6<"$CREDENTIALS_DIRECTORY/cloudflare-route-read-token"
unset CREDENTIALS_DIRECTORY
exec /usr/bin/node --import "$tsx_import" "$operator_path" "$@"
