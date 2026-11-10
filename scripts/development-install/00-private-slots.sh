#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_SLOT_PLAN:?}" "${DEV_PROVIDER_TOKEN_ENTRY:?}" "${DEV_SDK_ENTRY:?}" "${DEV_SDK_PACKET:?}" "${DEV_SDK_PACKET_SHA256:?}"
# Plan must set developmentIngress=true and both slot/reader enables=true.
node --input-type=module -e 'import{readFileSync}from"node:fs";const r=JSON.parse(readFileSync(process.argv[1]));if(r.developmentIngress!==true||r.oldPair?.environment!=="development"||r.newPair?.environment!=="development")process.exit(1)' "$DEV_SLOT_PLAN"
node scripts/install-private-public-release.mjs --plan "$DEV_SLOT_PLAN" \
  --development-sdk-packet "$DEV_SDK_PACKET" --development-sdk-packet-digest "$DEV_SDK_PACKET_SHA256" > "$DEV_INSTALL_EVIDENCE/private-slots-plan.json"
PRIVATE_INSTALL_TOKEN_FD=3 node scripts/install-private-public-release.mjs --plan "$DEV_SLOT_PLAN" --apply \
  --development-sdk-packet "$DEV_SDK_PACKET" --development-sdk-packet-digest "$DEV_SDK_PACKET_SHA256" \
  3< <(pass show "$DEV_PROVIDER_TOKEN_ENTRY") 4< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/private-slots.json"
