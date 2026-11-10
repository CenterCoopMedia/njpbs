#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "usage: $0 local-image-tag" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image_tag="$1"

docker build \
  --platform linux/amd64 \
  --provenance=false \
  --pull=false \
  --tag "$image_tag" \
  "$script_dir"
docker run --rm --entrypoint cat "$image_tag" /opt/bin/ffmpeg-manifest.json
docker image inspect "$image_tag" --format 'localImageId={{.Id}} architecture={{.Architecture}} os={{.Os}}'
