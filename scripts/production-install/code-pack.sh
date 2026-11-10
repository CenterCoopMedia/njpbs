#!/usr/bin/env bash
# Attended Bash only; packets/source checks and all effects belong to native owners.
set +x
set -euo pipefail
set -o noclobber
umask 077
: "${PACKET:?}" "${PACKET_SHA256:?}" "${RESULT:?}"
[[ "$PACKET" == /* && "$RESULT" == /* && "$PACKET_SHA256" =~ ^[a-f0-9]{64}$ ]]
case "${1:-}" in
  freeze)
    : "${SDK_ENTRY:?}" "${R2_READ_ENTRY:?}"
    env -i PATH="$PATH" HOME="$HOME" node scripts/prepare-production-pair-code-pack.mjs freeze \
      --packet "$PACKET" --packet-digest "$PACKET_SHA256" \
      > "$RESULT" 3< <(pass show "$SDK_ENTRY") 4< <(pass show "$R2_READ_ENTRY")
    ;;
  image-context|extract|build)
    env -i PATH="$PATH" HOME="$HOME" node scripts/prepare-production-pair-code-pack.mjs "$1" \
      --packet "$PACKET" --packet-digest "$PACKET_SHA256" > "$RESULT"
    ;;
  *) exit 1 ;;
esac
