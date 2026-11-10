#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_INITIAL_PACKET:?}" "${DEV_INITIAL_PACKET_SHA256:?}" "${DEV_SDK_ENTRY:?}" "${DEV_GOOGLE_READ_ENTRY:?}" "${DEV_R2_READ_ENTRY:?}"
# Both actual pairs must have current native qualification references first.
node scripts/development-public-release-adoption.mjs --packet "$DEV_INITIAL_PACKET" --packet-digest "$DEV_INITIAL_PACKET_SHA256" \
  > "$DEV_INSTALL_EVIDENCE/initial-plan.json"
node scripts/development-public-release-adoption.mjs --packet "$DEV_INITIAL_PACKET" --packet-digest "$DEV_INITIAL_PACKET_SHA256" --apply \
  3< <(pass show "$DEV_SDK_ENTRY") 4< <(pass show "$DEV_R2_READ_ENTRY") 5< <(pass show "$DEV_GOOGLE_READ_ENTRY") \
  > "$DEV_INSTALL_EVIDENCE/initial.json"
node scripts/development-public-release-adoption.mjs --packet "$DEV_INITIAL_PACKET" --packet-digest "$DEV_INITIAL_PACKET_SHA256" --readback \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/initial-readback.json"
