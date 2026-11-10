#!/usr/bin/env bash
set -euo pipefail
fixture_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ffmpeg -nostdin -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=duration=134:size=640x360:rate=1' \
  -an -c:v libx264 -profile:v baseline -pix_fmt yuv420p \
  -preset veryfast -crf 35 -g 1 -threads 1 \
  -map_metadata -1 -fflags +bitexact -flags:v +bitexact -movflags +faststart \
  "$fixture_dir/media-frame-preview.mp4"
