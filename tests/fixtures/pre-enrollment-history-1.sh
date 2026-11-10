set +x
set -euo pipefail
umask 077
env -i PATH="$PATH" HOME="$HOME" node scripts/retire-pre-enrollment-history.mjs \
  --packet "$HISTORY_APPLY_PACKET" --packet-digest "$HISTORY_APPLY_PACKET_DIGEST" --apply \
  3< <(pass show "$HISTORY_SDK_ENTRY") > "$HISTORY_APPLY_RESULT"
