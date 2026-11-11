#!/usr/bin/env bash
set -euo pipefail

# GitHub's Ubuntu mirror list can prefer Azure even when later entries are
# reachable. Use Ubuntu's archive directly without changing signed repositories.
sudo python3 - <<'PY'
from pathlib import Path

sources = [Path('/etc/apt/sources.list'), Path('/etc/apt/apt-mirrors.txt')]
sources.extend(Path('/etc/apt/sources.list.d').glob('*.list'))
sources.extend(Path('/etc/apt/sources.list.d').glob('*.sources'))
for path in sources:
    if path.is_file():
        original = path.read_text()
        updated = original.replace('azure.archive.ubuntu.com', 'archive.ubuntu.com')
        if updated != original:
            path.write_text(updated)
PY

if ! sudo apt-get -o Acquire::Retries=0 -o APT::Update::Error-Mode=any update; then
  echo "::warning::APT metadata update failed; retrying once."
  sudo apt-get -o Acquire::Retries=0 -o APT::Update::Error-Mode=any update || {
    echo "::error::APT metadata update failed after one retry; Ubuntu mirror is archive.ubuntu.com."
    exit 1
  }
fi
