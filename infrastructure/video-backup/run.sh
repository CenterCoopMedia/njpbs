#!/bin/bash
set -euo pipefail
if [[ ${NJPBS_VIDEO_BACKUP_ENABLED:-false} != true ]]; then
  exit 0
fi
cd "$(dirname "$0")/../.."
pass show "${NJPBS_VIDEO_BACKUP_SECRET_ENTRY:?Backup credential entry required}" |
  /usr/bin/node scripts/backup-video-viewing-copies.mjs --tick
