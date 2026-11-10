set -euo pipefail
node scripts/record-public-release-rate-controls.mjs \
  --packet "$RATE_PACKET" --packet-digest "$RATE_PACKET_SHA256"
