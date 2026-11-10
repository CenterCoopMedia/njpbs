set +x
set -euo pipefail
umask 077
env -i PATH="$PATH" HOME="$HOME" node scripts/retire-pre-enrollment-history.mjs \
  --packet "$HISTORY_LIST_PACKET" --packet-digest "$HISTORY_LIST_PACKET_DIGEST" \
  3< <(pass show "$HISTORY_SDK_ENTRY") > "$HISTORY_LIST_RESULT"
