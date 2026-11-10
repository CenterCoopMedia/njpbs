#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 3 || $1 != "--serve" ]]; then
  echo "Usage: run-cms-preview-serializer.sh --serve <40-character-commit> <serializer-id>" >&2
  exit 64
fi

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
site_root="$repository_root/site"
operator_path="$site_root/scripts/run-cms-preview-serializer.ts"
tsx_import="$site_root/node_modules/tsx/dist/loader.mjs"
runtime_directory=/run/njpbs-cms-preview
lock_path="$runtime_directory/serializer.lock"

# Verify source and required isolation before opening any credentials. Both
# Node invocations receive a fresh environment, without ambient provider routes.
/usr/bin/env -i PATH=/usr/bin:/bin NODE_PATH="$site_root/node_modules" \
  /usr/bin/node --import "$tsx_import" "$operator_path" --preflight "$2" "$3"

if [[ ${CREDENTIALS_DIRECTORY:-} != /run/credentials/njpbs-cms-preview.service ]]; then
  echo "CMS preview serializer credentials are unavailable" >&2
  exit 78
fi
if [[ ! -d $runtime_directory || -L $runtime_directory || ! -O $runtime_directory || $(stat -c %a "$runtime_directory") != 700 || -L $lock_path ]]; then
  echo "CMS preview serializer runtime directory is not private" >&2
  exit 78
fi
exec 5>>"$lock_path"
if ! /usr/bin/flock --exclusive --nonblock 5; then
  echo "CMS preview serializer lock is held" >&2
  exit 75
fi
exec 3<"$CREDENTIALS_DIRECTORY/r2-preview"
exec 4<"$CREDENTIALS_DIRECTORY/firebase-service-account"
exec /usr/bin/env -i PATH=/usr/bin:/bin NODE_PATH="$site_root/node_modules" \
  /usr/bin/node --import "$tsx_import" "$operator_path" "$@"
