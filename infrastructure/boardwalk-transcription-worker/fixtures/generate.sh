#!/usr/bin/env bash
set -euo pipefail
fixture_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fixture_tmp=$(mktemp -d)
trap 'rm -rf "$fixture_tmp"' EXIT

# Use the same synthetic speech for both decoder formats.
espeak-ng -v en-us -s 190 -w "$fixture_tmp/speech.wav" \
  "This is a short English speech sample. Each spoken word has a clear place in time."
ffmpeg -hide_banner -loglevel error -y -i "$fixture_tmp/speech.wav" \
  -af 'apad,atrim=duration=7.2' -ar 16000 -ac 1 -c:a pcm_s16le \
  -map_metadata -1 "$fixture_dir/alignment-english.wav"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'color=c=black:s=320x180:r=25:d=7.2' \
  -i "$fixture_dir/alignment-english.wav" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 -t 7.2 \
  -map_metadata -1 -movflags +faststart "$fixture_dir/alignment-english-h264-aac.mp4"
