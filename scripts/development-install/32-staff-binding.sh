#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_GATEWAY_PACKET:?}" "${DEV_GATEWAY_PACKET_SHA256:?}" "${DEV_SDK_ENTRY:?}" "${DEV_PROVIDER_TOKEN_ENTRY:?}"
node scripts/bind-development-public-release-gateway.mjs --packet "$DEV_GATEWAY_PACKET" --packet-digest "$DEV_GATEWAY_PACKET_SHA256" \
  > "$DEV_INSTALL_EVIDENCE/gateway-plan.json"
node scripts/bind-development-public-release-gateway.mjs --packet "$DEV_GATEWAY_PACKET" --packet-digest "$DEV_GATEWAY_PACKET_SHA256" --apply \
  3< <(pass show "$DEV_SDK_ENTRY") 4< <(pass show "$DEV_PROVIDER_TOKEN_ENTRY") > "$DEV_INSTALL_EVIDENCE/gateway.json"
node scripts/bind-development-public-release-gateway.mjs --packet "$DEV_GATEWAY_PACKET" --packet-digest "$DEV_GATEWAY_PACKET_SHA256" --readback \
  3< <(pass show "$DEV_SDK_ENTRY") 4< <(pass show "$DEV_PROVIDER_TOKEN_ENTRY") > "$DEV_INSTALL_EVIDENCE/gateway-readback.json"
