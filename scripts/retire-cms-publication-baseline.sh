#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 8 || $1 != "--apply" ]]; then
  echo "Usage: retire-cms-publication-baseline.sh --apply <operator-commit> <queue-id> <generation> <target-commit> <deployment-id> <version-id> <serializer-id>" >&2
  exit 64
fi

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
site_root="$repository_root/site"
operator_path="$site_root/scripts/retire-cms-publication-baseline.ts"
tsx_import="$site_root/node_modules/tsx/dist/loader.mjs"
runtime_directory=/run/njpbs-cms-publisher
lock_path="$runtime_directory/serializer.lock"
credential_environment_variables=(
  CF_API_KEY
  CF_API_TOKEN
  CLOUDFLARE_API_KEY
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_EMAIL
  FIREBASE_CONFIG
  GOOGLE_API_KEY
  GOOGLE_APPLICATION_CREDENTIALS
  GOOGLE_APPLICATION_CREDENTIALS_JSON
  NODE_OPTIONS
)

cd "$site_root"
export NODE_PATH="$site_root/node_modules"
preflight=(/usr/bin/env -u CREDENTIALS_DIRECTORY)
for variable in "${credential_environment_variables[@]}"; do
  preflight+=("-u" "$variable")
done
"${preflight[@]}" /usr/bin/node --import "$tsx_import" "$operator_path" --preflight

for variable in "${credential_environment_variables[@]}"; do
  if [[ -v $variable ]]; then
    echo "Publication baseline retirement inherited process environment is not allowed" >&2
    exit 78
  fi
done

if [[ ${CREDENTIALS_DIRECTORY:-} != /* ]]; then
  echo "Publication baseline retirement credentials are unavailable" >&2
  exit 78
fi

if [[ ! -d $runtime_directory || -L $runtime_directory || ! -O $runtime_directory || $(stat -c %a "$runtime_directory") != 700 ]]; then
  echo "Publication baseline retirement runtime directory is not private" >&2
  exit 78
fi

exec 5>"$lock_path"
if ! /usr/bin/flock --exclusive --nonblock 5; then
  echo "CMS publication serializer lock is held" >&2
  exit 75
fi

exec 3<"$CREDENTIALS_DIRECTORY/cloudflare-api-token"
exec 4<"$CREDENTIALS_DIRECTORY/firebase-service-account"
exec 6<"$CREDENTIALS_DIRECTORY/cloudflare-route-read-token"
unset CREDENTIALS_DIRECTORY

exec /usr/bin/node --import "$tsx_import" "$operator_path" "$@"
