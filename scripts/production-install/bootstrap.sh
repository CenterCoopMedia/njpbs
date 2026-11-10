#!/usr/bin/env bash
# One attended step. Variables name public packets, evidence and vault entries.
set +x
set -euo pipefail
set -C
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
: "${PROD_BOOTSTRAP_PACKET:?}" "${PROD_BOOTSTRAP_PACKET_SHA256:?}" "${PROD_BOOTSTRAP_OUTPUT:?}"
case "$PROD_BOOTSTRAP_OUTPUT" in /*) ;; *) exit 1 ;; esac
case "$(realpath -m -- "$PROD_BOOTSTRAP_OUTPUT")" in "$(pwd -P)"/*) exit 1 ;; esac
mode="${1:?plan, apply, readback or abandon required}"
case "$mode" in plan|apply|readback|abandon) ;; *) exit 1 ;; esac
step="$(node --input-type=module -e '
import{readFileSync}from"node:fs";const p=JSON.parse(readFileSync(process.argv[1]));
if(p.credentialIdentity?.projectId!=="njpbs-site")process.exit(1);
if(p.kind==="bootstrap-admission-close-operator"&&p.attempt?.environment==="production")console.log("close");
else if(p.kind==="production-public-release-adoption")console.log(p.step);else process.exit(1);
' "$PROD_BOOTSTRAP_PACKET")"
cli=scripts/production-public-release-adoption.mjs
if [[ "$step" == close ]]; then cli=scripts/close-public-release-bootstrap-admission.mjs; fi
args=(--packet "$PROD_BOOTSTRAP_PACKET" --packet-digest "$PROD_BOOTSTRAP_PACKET_SHA256")
if [[ "$mode" == plan || "$step" == pause-recovery ]]; then
  # Preserve the pre-credential STOP in the named evidence file in every mode.
  # A recovery request never reaches the environment guard or credential pipes.
  node "$cli" "${args[@]}" > "$PROD_BOOTSTRAP_OUTPUT"
  exit
fi
[[ "$mode" != abandon || "$step" == close ]]
# Verify packet/source and the shared production environment BEFORE fetching keys.
node "$cli" "${args[@]}" >/dev/null
node --input-type=module -e 'import{assertProductionInstallEnvironment}from"./scripts/lib/production-install-binding.mjs";assertProductionInstallEnvironment()'
: "${PROD_SDK_ENTRY:?}"
if [[ "$mode" == apply && "$step" == controls ]]; then
  : "${PROD_GOOGLE_READ_ENTRY:?}"
  node "$cli" "${args[@]}" --apply 3< <(pass show "$PROD_SDK_ENTRY") 5< <(pass show "$PROD_GOOGLE_READ_ENTRY") > "$PROD_BOOTSTRAP_OUTPUT"
elif [[ "$mode" == apply && ( "$step" == initial || "$step" == resume ) ]]; then
  : "${PROD_GOOGLE_READ_ENTRY:?}" "${PROD_R2_READ_ENTRY:?}"
  node "$cli" "${args[@]}" --apply 3< <(pass show "$PROD_SDK_ENTRY") 4< <(pass show "$PROD_R2_READ_ENTRY") 5< <(pass show "$PROD_GOOGLE_READ_ENTRY") > "$PROD_BOOTSTRAP_OUTPUT"
else
  node "$cli" "${args[@]}" "--$mode" 3< <(pass show "$PROD_SDK_ENTRY") > "$PROD_BOOTSTRAP_OUTPUT"
fi
