#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_BRIDGE_REQUEST_B:?}" "${DEV_READER_ADAPTER:?}" "${DEV_READER_ADAPTER_SHA256:?}" "${DEV_SDK_ENTRY:?}"
# B has a distinct original operation; A never becomes B.
node --input-type=module -e 'import{readFileSync}from"node:fs";import{parseCmsReaderBridgeRequest}from"./scripts/lib/cms-reader-bridge-install.mjs";const wire=JSON.parse(readFileSync(process.argv[1]));parseCmsReaderBridgeRequest(wire);if(Object.hasOwn(wire,"stage"))process.exit(1)' "$DEV_BRIDGE_REQUEST_B"
for mode in dry-run prove install readback; do
  (
    case "$mode" in
      prove) development_reader_credential_pipes reader-prove ;;
      install) development_reader_credential_pipes reader-install ;;
      *) development_reader_credential_pipes none ;;
    esac
    pass show "$DEV_SDK_ENTRY" | node scripts/install-cms-reader-bridge.mjs "$mode" njpbs-site-dev \
      "$DEV_BRIDGE_REQUEST_B" "$DEV_READER_ADAPTER" "$DEV_READER_ADAPTER_SHA256" > "$DEV_INSTALL_EVIDENCE/reader-b-$mode.json"
  )
done
