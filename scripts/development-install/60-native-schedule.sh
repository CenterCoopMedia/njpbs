#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_SCHEDULE_PACKET:?}" "${DEV_SCHEDULE_PACKET_SHA256:?}" "${DEV_SDK_ENTRY:?}" "${DEV_STAFF_JWT_ENTRY:?}" "${DEV_EDGE_ENTRY:?}"
node scripts/save-development-rehearsal-schedule.mjs --packet "$DEV_SCHEDULE_PACKET" --packet-digest "$DEV_SCHEDULE_PACKET_SHA256" \
  > "$DEV_INSTALL_EVIDENCE/schedule-plan.json"
node scripts/save-development-rehearsal-schedule.mjs --packet "$DEV_SCHEDULE_PACKET" --packet-digest "$DEV_SCHEDULE_PACKET_SHA256" --apply \
  3< <(pass show "$DEV_SDK_ENTRY") 4< <(pass show "$DEV_STAFF_JWT_ENTRY") 5< <(pass show "$DEV_EDGE_ENTRY") \
  > "$DEV_INSTALL_EVIDENCE/schedule.json"
node scripts/save-development-rehearsal-schedule.mjs --packet "$DEV_SCHEDULE_PACKET" --packet-digest "$DEV_SCHEDULE_PACKET_SHA256" --readback \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/schedule-readback.json"
