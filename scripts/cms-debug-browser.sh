#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${CMS_DEBUG_BROWSER_CREDENTIAL_REF:-}" || "$CMS_DEBUG_BROWSER_CREDENTIAL_REF" == REPLACE_ME ]]; then
  echo "Configure CMS_DEBUG_BROWSER_CREDENTIAL_REF" >&2
  exit 1
fi

# Keep the credential pipe separate from the MCP JSON-RPC standard input.
exec node scripts/cms-debug-browser.mjs 3< <(pass show -- "$CMS_DEBUG_BROWSER_CREDENTIAL_REF" </dev/null)
