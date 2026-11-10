#!/usr/bin/env bash
set -euo pipefail
umask 077

if ! [[ ( $# -eq 3 && ( $1 == "--apply" || $1 == "--retire" ) ) ||
        ( $# -eq 4 && $1 == "--prepare" ) ||
        ( ( $# -eq 3 || ( $# -eq 4 && ${4:-} == "--apply" ) ) && $1 == "--supersede-upload-exhausted" ) ||
        ( ( $# -eq 4 || ( $# -eq 5 && ${5:-} == "--apply" ) ) && $1 == "--retry" ) ]]; then
  echo "Usage: stage-cms-publication-cloud-release.sh --apply|--retire <operation-id> <commit-sha> OR --prepare <operation-id> <new-commit-sha> <old-commit-sha> OR --retry <operation-id> <new-commit-sha> <old-commit-sha> [--apply] OR --supersede-upload-exhausted <operation-id> <commit-sha> [--apply]" >&2
  exit 64
fi

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
site_root="$repository_root/site"
operator_path="$site_root/scripts/stage-cms-publication-cloud-release.ts"
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
  MEDIA_MANAGER_API_KEY
  MEDIA_MANAGER_API_SECRET
  NODE_OPTIONS
)

cd "$site_root"
export NODE_PATH="$site_root/node_modules"
for variable in "${credential_environment_variables[@]}"; do
  if [[ -v $variable ]]; then
    echo "CMS publication cloud release inherited process environment is not allowed" >&2
    exit 78
  fi
done
if [[ ${CREDENTIALS_DIRECTORY:-} != /* ]]; then
  echo "CMS publication cloud release credentials are unavailable" >&2
  exit 78
fi

# The build writes site/dist and the compiled renderer inside this checkout.
# One command per checkout, so a release never stages the output of another.
exec 9<"$site_root"
if ! /usr/bin/flock --exclusive --nonblock 9; then
  echo "Another CMS publication cloud release command is using this checkout" >&2
  exit 75
fi

exec 3<"$CREDENTIALS_DIRECTORY/firebase-service-account"
if [[ $1 == "--apply" || $1 == "--prepare" ]]; then
  exec 4<"$CREDENTIALS_DIRECTORY/publication-storage"
  exec 5<"$CREDENTIALS_DIRECTORY/media-manager"
fi
unset CREDENTIALS_DIRECTORY
exec /usr/bin/node --import "$tsx_import" "$operator_path" "$@"
