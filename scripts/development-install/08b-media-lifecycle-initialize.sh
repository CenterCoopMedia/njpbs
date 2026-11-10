#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_MEDIA_INIT_PACKET:?}" "${DEV_MEDIA_INIT_PACKET_SHA256:?}" "${DEV_SDK_ENTRY:?}"
node scripts/initialize-dev-public-predecessor.mjs --packet "$DEV_MEDIA_INIT_PACKET" --packet-digest "$DEV_MEDIA_INIT_PACKET_SHA256" \
  > "$DEV_INSTALL_EVIDENCE/media-lifecycle-plan.json"
node --input-type=module -e 'import{readFileSync}from"node:fs";const r=JSON.parse(readFileSync(process.argv[1]));if(r.kind!=="dev-public-predecessor-result"||r.step!=="media-lifecycle"||r.mode!=="plan")process.exit(1)' \
  "$DEV_INSTALL_EVIDENCE/media-lifecycle-plan.json"
node scripts/initialize-dev-public-predecessor.mjs --packet "$DEV_MEDIA_INIT_PACKET" --packet-digest "$DEV_MEDIA_INIT_PACKET_SHA256" --apply \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/media-lifecycle.json"
node scripts/initialize-dev-public-predecessor.mjs --packet "$DEV_MEDIA_INIT_PACKET" --packet-digest "$DEV_MEDIA_INIT_PACKET_SHA256" --readback \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/media-lifecycle-readback.json"
node --input-type=module -e 'import{readFileSync}from"node:fs";const r=JSON.parse(readFileSync(process.argv[1]));if(r.kind!=="dev-public-predecessor-result"||r.step!=="media-lifecycle"||r.committed!==true||r.currentReady!==true)process.exit(1)' \
  "$DEV_INSTALL_EVIDENCE/media-lifecycle-readback.json"
