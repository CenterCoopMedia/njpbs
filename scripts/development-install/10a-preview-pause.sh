#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_PREVIEW_PAUSE_PACKET:?}" "${DEV_PREVIEW_PAUSE_PACKET_SHA256:?}" "${DEV_SDK_ENTRY:?}"
node scripts/development-public-release-adoption.mjs --packet "$DEV_PREVIEW_PAUSE_PACKET" --packet-digest "$DEV_PREVIEW_PAUSE_PACKET_SHA256" \
  > "$DEV_INSTALL_EVIDENCE/preview-pause-plan.json"
node scripts/development-public-release-adoption.mjs --packet "$DEV_PREVIEW_PAUSE_PACKET" --packet-digest "$DEV_PREVIEW_PAUSE_PACKET_SHA256" --apply \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/preview-pause.json"
node scripts/development-public-release-adoption.mjs --packet "$DEV_PREVIEW_PAUSE_PACKET" --packet-digest "$DEV_PREVIEW_PAUSE_PACKET_SHA256" --readback \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/preview-pause-readback.json"
