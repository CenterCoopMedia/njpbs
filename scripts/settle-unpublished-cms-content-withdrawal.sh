#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 8 || $1 != "--apply" ]]; then
  echo "Usage: settle-unpublished-cms-content-withdrawal.sh --apply <operator-commit> <collection> <record-id> <published-source-version> <cancelled-queue-id> <active-generation> <active-batch-id>" >&2
  exit 64
fi

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
site_root="$repository_root/site"
operator_path="$site_root/scripts/settle-unpublished-cms-content-withdrawal.ts"
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
    echo "Unpublished withdrawal settlement inherited process environment is not allowed" >&2
    exit 78
  fi
done

if [[ ${CREDENTIALS_DIRECTORY:-} != /* ]]; then
  echo "Unpublished withdrawal settlement credentials are unavailable" >&2
  exit 78
fi

if [[ ! -d $runtime_directory || -L $runtime_directory || ! -O $runtime_directory || $(stat -c %a "$runtime_directory") != 700 ]]; then
  echo "Unpublished withdrawal settlement runtime directory is not private" >&2
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
