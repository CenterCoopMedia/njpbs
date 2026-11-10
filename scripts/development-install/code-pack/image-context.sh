#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
node scripts/prepare-development-pair-code-pack.mjs image-context \
  --packet "$DEV_PAIR_CODE_PACK_PACKET" --packet-digest "$DEV_PAIR_CODE_PACK_PACKET_SHA256" \
  > "$DEV_INSTALL_EVIDENCE/$DEV_PAIR_CODE_PACK_LABEL-code-pack-image-context.json"
