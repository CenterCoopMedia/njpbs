#!/usr/bin/env bash
# Source only from the reviewed numbered Bash command files.
set +x
set -euo pipefail
umask 077
set -C
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
: "${DEV_INSTALL_EVIDENCE:?absolute new evidence directory required}"
case "$DEV_INSTALL_EVIDENCE" in /*) ;; *) exit 1 ;; esac
mkdir -p -- "$DEV_INSTALL_EVIDENCE"
# All *_ENTRY variables below are vault entry NAMES, never secret values.

# Call in a per-command subshell so channels and metadata cannot outlive a mode.
development_reader_credential_pipes() {
  unset CMS_READER_CREDENTIAL_PIPES
  case "$1" in
    none) return ;;
    reader-prove) : "${DEV_STAFF_JWT_ENTRY:?}" "${DEV_EDGE_ENTRY:?}" ;;
    reader-install|preview-bootstrap) ;;
    *) return 1 ;;
  esac
  : "${DEV_PROVIDER_TOKEN_ENTRY:?}" "${DEV_GOOGLE_READ_ENTRY:?}"
  local -a descriptors=(4 12)
  exec 4< <(pass show "$DEV_PROVIDER_TOKEN_ENTRY")
  exec 12< <(pass show "$DEV_GOOGLE_READ_ENTRY")
  if [[ "$1" == reader-prove ]]; then
    exec 13< <(pass show "$DEV_STAFF_JWT_ENTRY")
    exec 14< <(pass show "$DEV_EDGE_ENTRY")
    descriptors+=(13 14)
  fi
  CMS_READER_CREDENTIAL_PIPES="$(node scripts/describe-cms-reader-credential-pipes.mjs "${descriptors[@]}")"
  export CMS_READER_CREDENTIAL_PIPES
}
