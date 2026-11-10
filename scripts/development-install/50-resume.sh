#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_RESUME_PACKET:?}" "${DEV_RESUME_PACKET_SHA256:?}" "${DEV_SDK_ENTRY:?}" "${DEV_GOOGLE_READ_ENTRY:?}" "${DEV_R2_READ_ENTRY:?}" "${DEV_VIEWER_ACCESS_ENTRY:?}"
# Original bootstrap identity plus TWO fresh qualifications; full canonical OLD
# roster traverses the unchanged staff Access gateway before atomic resume.
node scripts/development-public-release-adoption.mjs --packet "$DEV_RESUME_PACKET" --packet-digest "$DEV_RESUME_PACKET_SHA256" \
  > "$DEV_INSTALL_EVIDENCE/resume-plan.json"
node scripts/development-public-release-adoption.mjs --packet "$DEV_RESUME_PACKET" --packet-digest "$DEV_RESUME_PACKET_SHA256" --apply \
  3< <(pass show "$DEV_SDK_ENTRY") 4< <(pass show "$DEV_R2_READ_ENTRY") 5< <(pass show "$DEV_GOOGLE_READ_ENTRY") \
  6< <(pass show "$DEV_VIEWER_ACCESS_ENTRY") > "$DEV_INSTALL_EVIDENCE/resume.json"
node scripts/development-public-release-adoption.mjs --packet "$DEV_RESUME_PACKET" --packet-digest "$DEV_RESUME_PACKET_SHA256" --readback \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/resume-readback.json"
