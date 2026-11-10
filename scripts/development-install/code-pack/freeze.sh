#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_SDK_ENTRY:?}" "${DEV_R2_READ_ENTRY:?}"
node scripts/prepare-development-pair-code-pack.mjs freeze \
  --packet "$DEV_PAIR_CODE_PACK_PACKET" --packet-digest "$DEV_PAIR_CODE_PACK_PACKET_SHA256" \
  3< <(pass show "$DEV_SDK_ENTRY") 4< <(pass show "$DEV_R2_READ_ENTRY") \
  > "$DEV_INSTALL_EVIDENCE/$DEV_PAIR_CODE_PACK_LABEL-code-pack-freeze.json"
