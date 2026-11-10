#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_ENROLLMENT_REQUEST:?}" "${DEV_SDK_ENTRY:?}" "${DEV_SDK_PACKET:?}" "${DEV_SDK_PACKET_SHA256:?}" "${DEV_EDGE_ENTRY:?}"
# The request comes from a fresh inspect after original close/pause/drain.
node scripts/check-dev-current-code.mjs --enrollment-request "$DEV_ENROLLMENT_REQUEST" \
  4< <(pass show "$DEV_EDGE_ENTRY") > "$DEV_INSTALL_EVIDENCE/code-rpc-preflight.json"
node scripts/enroll-public-release-change-log.mjs dry-run --project njpbs-site-dev --request "$DEV_ENROLLMENT_REQUEST" \
  --development-sdk-packet "$DEV_SDK_PACKET" --development-sdk-packet-digest "$DEV_SDK_PACKET_SHA256" \
  3< <(pass show "$DEV_SDK_ENTRY") 4< <(pass show "$DEV_EDGE_ENTRY") > "$DEV_INSTALL_EVIDENCE/enrollment-plan.json"
node scripts/enroll-public-release-change-log.mjs apply --project njpbs-site-dev --request "$DEV_ENROLLMENT_REQUEST" \
  --development-sdk-packet "$DEV_SDK_PACKET" --development-sdk-packet-digest "$DEV_SDK_PACKET_SHA256" \
  3< <(pass show "$DEV_SDK_ENTRY") 4< <(pass show "$DEV_EDGE_ENTRY") > "$DEV_INSTALL_EVIDENCE/enrollment.json"
node scripts/enroll-public-release-change-log.mjs readback --project njpbs-site-dev --request "$DEV_ENROLLMENT_REQUEST" \
  --development-sdk-packet "$DEV_SDK_PACKET" --development-sdk-packet-digest "$DEV_SDK_PACKET_SHA256" \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/enrollment-readback.json"
