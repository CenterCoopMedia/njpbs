#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_CONTROLS_PACKET:?}" "${DEV_CONTROLS_PACKET_SHA256:?}" "${DEV_SDK_ENTRY:?}" "${DEV_GOOGLE_READ_ENTRY:?}"
node scripts/development-public-release-adoption.mjs --packet "$DEV_CONTROLS_PACKET" --packet-digest "$DEV_CONTROLS_PACKET_SHA256" \
  > "$DEV_INSTALL_EVIDENCE/controls-plan.json"
node scripts/development-public-release-adoption.mjs --packet "$DEV_CONTROLS_PACKET" --packet-digest "$DEV_CONTROLS_PACKET_SHA256" --apply \
  3< <(pass show "$DEV_SDK_ENTRY") 5< <(pass show "$DEV_GOOGLE_READ_ENTRY") > "$DEV_INSTALL_EVIDENCE/controls.json"
