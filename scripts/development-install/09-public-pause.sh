#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_PUBLIC_PAUSE_PACKET:?}" "${DEV_PUBLIC_PAUSE_PACKET_SHA256:?}" "${DEV_SDK_ENTRY:?}"
# A paused-failed STOP preserves 09's evidence. Optional continuation belongs
# only to the separately authorized 09a-public-pause-recovery.sh owner.
node scripts/pause-dev-public-release.mjs --packet "$DEV_PUBLIC_PAUSE_PACKET" --packet-digest "$DEV_PUBLIC_PAUSE_PACKET_SHA256" \
  > "$DEV_INSTALL_EVIDENCE/public-pause-plan.json"
node scripts/pause-dev-public-release.mjs --packet "$DEV_PUBLIC_PAUSE_PACKET" --packet-digest "$DEV_PUBLIC_PAUSE_PACKET_SHA256" --apply \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/public-pause.json"
node scripts/pause-dev-public-release.mjs --packet "$DEV_PUBLIC_PAUSE_PACKET" --packet-digest "$DEV_PUBLIC_PAUSE_PACKET_SHA256" --readback \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/public-pause-readback.json"
node --input-type=module -e 'import{readFileSync}from"node:fs";const r=JSON.parse(readFileSync(process.argv[1]));if(r.kind!=="dev-public-release-pause-result"||r.pauseCommitted!==true||r.drainCommitted!==true||r.currentReady!==true||r.ownsClosedFence!==true)process.exit(1)' \
  "$DEV_INSTALL_EVIDENCE/public-pause-readback.json"
