#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 6 || $1 != "--apply" ]]; then
  echo "Usage: cancel-claimed-cms-publication-baseline.sh --apply <operator-commit> <queue-id> <generation> <old-queue-commit> <serializer-id>" >&2
  exit 64
fi

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
site_root="$repository_root/site"
operator_path="$site_root/scripts/cancel-claimed-cms-publication-baseline.ts"
tsx_import="$site_root/node_modules/tsx/dist/loader.mjs"
runtime_directory=/run/njpbs-cms-publisher
lock_path="$runtime_directory/serializer.lock"
credential_environment_variables=(
  FIREBASE_CONFIG
  FIRESTORE_EMULATOR_HOST
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
    echo "Claimed publication baseline cancellation inherited process environment is not allowed" >&2
    exit 78
  fi
done

if [[ ${CREDENTIALS_DIRECTORY:-} != /* ]]; then
  echo "Claimed publication baseline cancellation credentials are unavailable" >&2
  exit 78
fi

if [[ ! -d $runtime_directory || -L $runtime_directory || ! -O $runtime_directory || $(stat -c %a "$runtime_directory") != 700 ]]; then
  echo "Claimed publication baseline cancellation runtime directory is not private" >&2
  exit 78
fi

exec 5>"$lock_path"
if ! /usr/bin/flock --exclusive --nonblock 5; then
  echo "CMS publication serializer lock is held" >&2
  exit 75
fi

exec 3<"$CREDENTIALS_DIRECTORY/firebase-service-account"
unset CREDENTIALS_DIRECTORY

exec /usr/bin/node --import "$tsx_import" "$operator_path" "$@"
