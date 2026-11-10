#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_HISTORY_PACKET:?}" "${DEV_HISTORY_PACKET_SHA256:?}" "${DEV_SDK_ENTRY:?}"
node scripts/terminalize-dev-publication-history.mjs --packet "$DEV_HISTORY_PACKET" --packet-digest "$DEV_HISTORY_PACKET_SHA256" \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/history-plan.json"
node --input-type=module -e 'import{readFileSync}from"node:fs";const r=JSON.parse(readFileSync(process.argv[1]));if(r.kind!=="dev-publication-history-result"||r.mode!=="plan"||r.plan.requestDigest!==r.requestDigest||r.plan.rows.filter(x=>x.action==="retire").length!==9||r.plan.rows.filter(x=>x.action==="supersede").length!==1)process.exit(1)' \
  "$DEV_INSTALL_EVIDENCE/history-plan.json"
node scripts/terminalize-dev-publication-history.mjs --packet "$DEV_HISTORY_PACKET" --packet-digest "$DEV_HISTORY_PACKET_SHA256" --apply \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/history.json"
node scripts/terminalize-dev-publication-history.mjs --packet "$DEV_HISTORY_PACKET" --packet-digest "$DEV_HISTORY_PACKET_SHA256" --readback \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/history-readback.json"
node --input-type=module -e 'import{readFileSync}from"node:fs";const r=JSON.parse(readFileSync(process.argv[1]));if(r.kind!=="dev-publication-history-result"||r.committed!==true||r.conservationVerified!==true)process.exit(1)' \
  "$DEV_INSTALL_EVIDENCE/history-readback.json"
