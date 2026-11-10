#!/usr/bin/env bash
set +x
set -euo pipefail
set -o noclobber
umask 077
: "${ENROLLMENT_SDK_PACKET:?}" "${ENROLLMENT_SDK_PACKET_SHA256:?}" "${SDK_ENTRY:?}" "${RESULT:?}"
[[ "$ENROLLMENT_SDK_PACKET" == /* && "$RESULT" == /* && "$ENROLLMENT_SDK_PACKET_SHA256" =~ ^[a-f0-9]{64}$ ]]
case "${1:-}" in
  inspect) request_args=() ;;
  readback|dry-run|apply)
    : "${ENROLLMENT_REQUEST:?}"
    [[ "$ENROLLMENT_REQUEST" == /* ]]
    request_args=(--request "$ENROLLMENT_REQUEST") ;;
  *) exit 1 ;;
esac
case "$1" in
  dry-run|apply)
    : "${EDGE_ENTRY:?}"
    env -i PATH="$PATH" HOME="$HOME" node scripts/enroll-public-release-change-log.mjs "$1" --project njpbs-site \
      "${request_args[@]}" --production-sdk-packet "$ENROLLMENT_SDK_PACKET" \
      --production-sdk-packet-digest "$ENROLLMENT_SDK_PACKET_SHA256" \
      > "$RESULT" 3< <(pass show "$SDK_ENTRY") 4< <(pass show "$EDGE_ENTRY") ;;
  *)
    env -i PATH="$PATH" HOME="$HOME" node scripts/enroll-public-release-change-log.mjs "$1" --project njpbs-site \
      "${request_args[@]}" --production-sdk-packet "$ENROLLMENT_SDK_PACKET" \
      --production-sdk-packet-digest "$ENROLLMENT_SDK_PACKET_SHA256" \
      > "$RESULT" 3< <(pass show "$SDK_ENTRY") ;;
esac
