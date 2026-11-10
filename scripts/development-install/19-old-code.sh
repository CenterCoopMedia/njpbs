#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_OLD_CODE_PACKET:?}" "${DEV_OLD_CODE_PACKET_SHA256:?}" "${DEV_SDK_ENTRY:?}"
node --input-type=module - "$DEV_OLD_CODE_PACKET" <<'JS'
import { readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (p.step !== 'old-code' || p.credentialIdentity?.projectId !== 'njpbs-site-dev') process.exit(1);
JS
case "${1:-apply}" in
  readback)
    node scripts/prepare-development-initial-pairs.mjs --packet "$DEV_OLD_CODE_PACKET" --packet-digest "$DEV_OLD_CODE_PACKET_SHA256" --readback \
      3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/old-code-readback.json"
    ;;
  apply)
    : "${DEV_R2_WRITE_ENTRY:?}"
    node scripts/prepare-development-initial-pairs.mjs --packet "$DEV_OLD_CODE_PACKET" --packet-digest "$DEV_OLD_CODE_PACKET_SHA256" \
      > "$DEV_INSTALL_EVIDENCE/old-code-plan.json"
    node scripts/prepare-development-initial-pairs.mjs --packet "$DEV_OLD_CODE_PACKET" --packet-digest "$DEV_OLD_CODE_PACKET_SHA256" --apply \
      3< <(pass show "$DEV_SDK_ENTRY") 4< <(pass show "$DEV_R2_WRITE_ENTRY") > "$DEV_INSTALL_EVIDENCE/old-code.json"
    ;;
  *) exit 1 ;;
esac
