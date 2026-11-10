#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_INITIAL_PAIRS_PACKET:?}" "${DEV_INITIAL_PAIRS_PACKET_SHA256:?}" "${DEV_SDK_ENTRY:?}"
node --input-type=module - "$DEV_INITIAL_PAIRS_PACKET" <<'JS'
import { readFileSync } from 'node:fs';
const p = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (p.step !== 'qualify' || p.credentialIdentity?.projectId !== 'njpbs-site-dev') process.exit(1);
JS
case "${1:-apply}" in
  readback)
    node scripts/prepare-development-initial-pairs.mjs --packet "$DEV_INITIAL_PAIRS_PACKET" --packet-digest "$DEV_INITIAL_PAIRS_PACKET_SHA256" --readback \
      3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/initial-pairs-readback.json"
    ;;
  apply)
    : "${DEV_R2_WRITE_ENTRY:?}" "${DEV_PAIR_READER_ACCESS_ENTRY:?}"
    node scripts/prepare-development-initial-pairs.mjs --packet "$DEV_INITIAL_PAIRS_PACKET" --packet-digest "$DEV_INITIAL_PAIRS_PACKET_SHA256" \
      > "$DEV_INSTALL_EVIDENCE/initial-pairs-plan.json"
    node scripts/prepare-development-initial-pairs.mjs --packet "$DEV_INITIAL_PAIRS_PACKET" --packet-digest "$DEV_INITIAL_PAIRS_PACKET_SHA256" --apply \
      3< <(pass show "$DEV_SDK_ENTRY") 4< <(pass show "$DEV_R2_WRITE_ENTRY") 6< <(pass show "$DEV_PAIR_READER_ACCESS_ENTRY") \
      > "$DEV_INSTALL_EVIDENCE/initial-pairs.json"
    # A native queue wait is an attended STOP, never permission to run 31.
    node --input-type=module - "$DEV_INSTALL_EVIDENCE/initial-pairs.json" <<'JS'
import { readFileSync } from 'node:fs';
if (JSON.parse(readFileSync(process.argv[2], 'utf8')).status !== 'qualified') process.exit(1);
JS
    ;;
  *) exit 1 ;;
esac
