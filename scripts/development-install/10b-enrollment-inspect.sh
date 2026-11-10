#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_SDK_ENTRY:?}" "${DEV_SDK_PACKET:?}" "${DEV_SDK_PACKET_SHA256:?}"
node scripts/enroll-public-release-change-log.mjs inspect --project njpbs-site-dev \
  --development-sdk-packet "$DEV_SDK_PACKET" --development-sdk-packet-digest "$DEV_SDK_PACKET_SHA256" \
  3< <(pass show "$DEV_SDK_ENTRY") > "$DEV_INSTALL_EVIDENCE/enrollment-inspect.json"
