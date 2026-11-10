#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
: "${DEV_PREVIEW_IDENTITY:?}" "${DEV_CONSUMER_ADAPTER_A:?}" "${DEV_CONSUMER_ADAPTER_A_SHA256:?}" "${DEV_SDK_ENTRY:?}"
# The #4403 bundle must explicitly bind legacy-first-install; no default B guard.
(
  development_reader_credential_pipes preview-bootstrap
  pass show "$DEV_SDK_ENTRY" | node scripts/bootstrap-cms-preview-pair.cjs plan njpbs-site-dev "$DEV_PREVIEW_IDENTITY" \
    "$DEV_CONSUMER_ADAPTER_A" "$DEV_CONSUMER_ADAPTER_A_SHA256" > "$DEV_INSTALL_EVIDENCE/preview-plan.json"
)
# Freeze the returned request in DEV_PREVIEW_REQUEST, review its original
# installedConsumerDigest, and authorize 22 separately. Do not copy a later plan.
