#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_CLOSE_PACKET:?}" "${DEV_CLOSE_PACKET_SHA256:?}" "${DEV_SDK_ENTRY:?}"
node --input-type=module -e 'import{readFileSync}from"node:fs";const r=JSON.parse(readFileSync(process.argv[1]));if(r.attempt?.environment!=="development")process.exit(1)' "$DEV_CLOSE_PACKET"
node scripts/close-public-release-bootstrap-admission.mjs --packet "$DEV_CLOSE_PACKET" --packet-digest "$DEV_CLOSE_PACKET_SHA256" \
  > "$DEV_INSTALL_EVIDENCE/close-plan.json"
node scripts/close-public-release-bootstrap-admission.mjs --packet "$DEV_CLOSE_PACKET" --packet-digest "$DEV_CLOSE_PACKET_SHA256" --apply \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/close.json"
node scripts/close-public-release-bootstrap-admission.mjs --packet "$DEV_CLOSE_PACKET" --packet-digest "$DEV_CLOSE_PACKET_SHA256" --readback \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/close-readback.json"
# The #4465 pause command must already own the same original close operation.
# This is its idempotent original close/readback, never a second bootstrap ID.
