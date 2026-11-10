#!/usr/bin/env bash
set -euo pipefail

# Discovery and runtime use the same metadata-only decision. No secret payloads.
ready() {
  local state
  state="$(timeout 10s gcloud secrets versions describe latest --secret="$1" \
    --project njpbs-site --format='value(state)' 2>/dev/null)" || return 1
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
