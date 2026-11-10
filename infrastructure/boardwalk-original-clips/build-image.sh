#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 1 || -z "$1" ]]; then
  echo "usage: $0 local-image-tag" >&2
  exit 2
fi
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
engine="${CONTAINER_ENGINE:-docker}"
"$engine" build --platform linux/amd64 --pull=false --tag "$1" "$script_dir"
"$engine" run --rm --network none --entrypoint cat "$1" /opt/bin/ffmpeg-manifest.json
"$engine" image inspect "$1" --format 'localImageId={{.Id}} architecture={{.Architecture}} os={{.Os}}'
