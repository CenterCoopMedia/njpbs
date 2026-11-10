#!/usr/bin/env bash
set -euo pipefail
umask 077

if ! { [[ $# -eq 2 && $1 == "--apply" && $2 == /* ]] ||
       [[ $# -eq 3 && $1 == "--restore-predecessor" && $2 =~ ^[A-Za-z0-9._:-]{1,128}$ && $3 =~ ^[A-Za-z0-9._:-]{1,128}$ ]]; }; then
  echo "Usage: activate-public-worker-candidate.sh --apply <absolute-prepared-artifact-path> or --restore-predecessor <leased-build-batch-id> <predecessor-build-batch-id>" >&2
  exit 64
fi

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
site_root="$repository_root/site"
operator_path="$site_root/scripts/activate-public-worker-candidate.ts"
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
    echo "Public Worker activation inherited process environment is not allowed" >&2
    exit 78
  fi
done
if [[ ${CREDENTIALS_DIRECTORY:-} != /* ]]; then
  echo "Public Worker activation credentials are unavailable" >&2
  exit 78
fi

exec 3<"$CREDENTIALS_DIRECTORY/cloudflare-api-token"
exec 4<"$CREDENTIALS_DIRECTORY/firebase-service-account"
unset CREDENTIALS_DIRECTORY
exec /usr/bin/node --import "$tsx_import" "$operator_path" "$@"
