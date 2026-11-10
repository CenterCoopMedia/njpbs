#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_PREVIEW_REQUEST:?}" "${DEV_CONSUMER_ADAPTER_A:?}" "${DEV_CONSUMER_ADAPTER_A_SHA256:?}" "${DEV_SDK_ENTRY:?}"
for mode in dry-run apply receipt; do
  (
    case "$mode" in
      receipt) development_reader_credential_pipes none ;;
      *) development_reader_credential_pipes preview-bootstrap ;;
    esac
    pass show "$DEV_SDK_ENTRY" | node scripts/bootstrap-cms-preview-pair.cjs "$mode" njpbs-site-dev "$DEV_PREVIEW_REQUEST" \
      "$DEV_CONSUMER_ADAPTER_A" "$DEV_CONSUMER_ADAPTER_A_SHA256" > "$DEV_INSTALL_EVIDENCE/preview-$mode.json"
  )
done
