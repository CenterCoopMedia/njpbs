#!/usr/bin/env bash
set -euo pipefail

# Discovery and runtime use the same metadata-only decision. No secret payloads.
ready() {
  local state status=0
  state="$(node "$(dirname "${BASH_SOURCE[0]}")/lib/provider-call.mjs" "secret version $1" -- \
    gcloud secrets versions describe latest --secret="$1" \
    --project njpbs-site --format='value(state)')" || status=$?
  # Only an absent version is an answer. A provider fault must not switch a feature off.
  [[ "$status" != 4 ]] || return 1
  if [[ "$status" != 0 ]]; then
    echo "The secret version state of $1 could not be read." >&2
    exit 1
  fi
  [[ "$state" == ENABLED ]]
}
enabled=false
real=false
if [[ "${CMS_MEDIA_PURGE_SWEEP_ENABLED:-false}" == true ]]; then
  if ready HEALTHCHECKS_MEDIA_PURGE_SWEEP && ready CMS_MEDIA_PURGE_R2_ACCESS_KEY_ID \
    && ready CMS_MEDIA_PURGE_R2_SECRET_ACCESS_KEY; then
    enabled=true
    [[ "${CMS_MEDIA_PURGE_REAL_DELETES_ENABLED:-false}" != true ]] || real=true
  else
    echo 'Media purge stays disabled: scoped reader/deleter or heartbeat secret version unavailable.' >&2
  fi
fi
cat > functions/media-purge.generated.json <<JSON
{"schemaVersion":1,"projectId":"njpbs-site","enabled":$enabled,"realDeletesEnabled":$real}
JSON
printf 'CMS_MEDIA_PURGE_SWEEP_ENABLED=%s\nCMS_MEDIA_PURGE_REAL_DELETES_ENABLED=%s\n' "$enabled" "$real"
