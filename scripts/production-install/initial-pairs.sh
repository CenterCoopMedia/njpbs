#!/usr/bin/env bash
set +x
set -euo pipefail
set -o noclobber
umask 077
: "${PACKET:?}" "${PACKET_SHA256:?}" "${RESULT:?}"
[[ "$PACKET" == /* && "$RESULT" == /* && "$PACKET_SHA256" =~ ^[a-f0-9]{64}$ ]]
case "${1:-}" in
  plan)
    env -i PATH="$PATH" HOME="$HOME" node scripts/prepare-production-initial-pairs.mjs \
      --packet "$PACKET" --packet-digest "$PACKET_SHA256" > "$RESULT"
    ;;
  readback)
    : "${SDK_ENTRY:?}"
    env -i PATH="$PATH" HOME="$HOME" node scripts/prepare-production-initial-pairs.mjs \
      --packet "$PACKET" --packet-digest "$PACKET_SHA256" --readback \
      3< <(pass show "$SDK_ENTRY") > "$RESULT"
    ;;
  apply)
    : "${SDK_ENTRY:?}" "${R2_READ_ENTRY:?}" "${R2_WRITE_ENTRY:?}"
    pair_step=$(node --input-type=module - "$PACKET" "$PACKET_SHA256" <<'JS'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const bytes = readFileSync(process.argv[2]);
if (bytes.length > 262144 || createHash('sha256').update(bytes).digest('hex') !== process.argv[3]) process.exit(1);
const packet = JSON.parse(bytes);
if (packet.kind !== 'production-initial-pairs' || !['old-code', 'stage', 'qualify'].includes(packet.step)) process.exit(1);
process.stdout.write(packet.step);
JS
)
    # Plan must already have been reviewed. A separate result preserves it.
    if [[ "$pair_step" == qualify ]]; then
      : "${OLD_READER_ACCESS_ENTRY:?}" "${NEW_READER_ACCESS_ENTRY:?}"
      env -i PATH="$PATH" HOME="$HOME" node scripts/prepare-production-initial-pairs.mjs \
        --packet "$PACKET" --packet-digest "$PACKET_SHA256" --apply \
        > "$RESULT" 3< <(pass show "$SDK_ENTRY") 4< <(pass show "$R2_READ_ENTRY") \
        5< <(pass show "$R2_WRITE_ENTRY") 6< <(pass show "$OLD_READER_ACCESS_ENTRY") \
        7< <(pass show "$NEW_READER_ACCESS_ENTRY")
    else
      env -i PATH="$PATH" HOME="$HOME" node scripts/prepare-production-initial-pairs.mjs \
        --packet "$PACKET" --packet-digest "$PACKET_SHA256" --apply \
        > "$RESULT" 3< <(pass show "$SDK_ENTRY") 4< <(pass show "$R2_READ_ENTRY") \
        5< <(pass show "$R2_WRITE_ENTRY")
    fi
    # Pending native work is an attended STOP; preserve it and read it back.
    node --input-type=module - "$RESULT" <<'JS'
import { readFileSync } from 'node:fs';
if (!['old-code-sealed', 'retained', 'qualified'].includes(JSON.parse(readFileSync(process.argv[2], 'utf8')).status)) process.exit(1);
JS
    ;;
  *) exit 1 ;;
esac
