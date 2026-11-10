#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_PUBLIC_PAUSE_RECOVERY_PACKET:?}" "${DEV_PUBLIC_PAUSE_RECOVERY_PACKET_SHA256:?}" "${DEV_SDK_ENTRY:?}"
# Optional, separately authorized continuation of an immutable 09 STOP.
# The original pause/failure remains failed; this never re-executes accepted work.
node scripts/recover-dev-public-release-pause.mjs --packet "$DEV_PUBLIC_PAUSE_RECOVERY_PACKET" --packet-digest "$DEV_PUBLIC_PAUSE_RECOVERY_PACKET_SHA256" \
  > "$DEV_INSTALL_EVIDENCE/public-pause-recovery-plan.json"
node scripts/recover-dev-public-release-pause.mjs --packet "$DEV_PUBLIC_PAUSE_RECOVERY_PACKET" --packet-digest "$DEV_PUBLIC_PAUSE_RECOVERY_PACKET_SHA256" --apply \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/public-pause-recovery.json"
node scripts/recover-dev-public-release-pause.mjs --packet "$DEV_PUBLIC_PAUSE_RECOVERY_PACKET" --packet-digest "$DEV_PUBLIC_PAUSE_RECOVERY_PACKET_SHA256" --readback \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/public-pause-recovery-readback.json"
node --input-type=module -e 'import{readFileSync}from"node:fs";const r=JSON.parse(readFileSync(process.argv[1]));if(r.kind!=="dev-public-release-pause-recovery-result"||r.recoveryCommitted!==true||r.canContinue!==true||r.originalOutcome!=="paused-failed"||r.drainCommitted!==false)process.exit(1)' \
  "$DEV_INSTALL_EVIDENCE/public-pause-recovery-readback.json"
