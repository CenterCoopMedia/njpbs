#!/usr/bin/env bash
# Runs the development project's hand setup steps in order and reads each one
# back, so a rebuilt dev project reaches a release run with one command. Each
# step stops the script on its first refusal and names it.
#
# Usage, from a clean checkout of main rendered by render-development-config.mjs:
#   scripts/setup-dev.sh [--check]
# --check runs only the read-only checks; without it each install step runs
# first and creates or adds only what is missing.
#
# Inputs. Every *_ENTRY variable is a vault entry NAME, never a secret value;
# each value is streamed from `pass show` to the one descriptor that uses it.
#   JAWN_OPS                         jawn-ops binary (default: jawn-ops on PATH)
#   DEV_PUBLISHER_KEY_ENTRY          development publisher account key (check-dev-setup fd 3)
#   DEV_OPERATOR_CREDENTIAL_ENTRY    dev Firestore operator credential (install-dev-publisher fd 3)
#   DEV_CLOUDFLARE_READ_ENTRY        dev Cloudflare read token (install-dev-publisher fd 5)
#   PUBLISHER_SHA, PUBLISHER_IMAGE_RUN   the installed publisher's main commit and image run
#   CANONICAL_GITHUB_REPOSITORY, CANONICAL_GITHUB_REPOSITORY_ID   as install-dev-publisher requires
# provision-config reads the complete declared Functions input set from the
# environment, as docs/cms/functions-deploy.md describes; supply it at use time.
#
# The other rows of docs/cms/functions-deploy.md#development-project-setup
# (buckets, IAM grants, custom domains, publisher secrets) are one-time
# provider setup; check-dev-setup and the publisher check below read them.
set +x
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

check_only=false
case "${1:-}" in
  "") ;;
  --check) check_only=true ;;
  *) echo "Usage: scripts/setup-dev.sh [--check]" >&2; exit 64 ;;
esac
[[ $# -le 1 ]] || { echo "Usage: scripts/setup-dev.sh [--check]" >&2; exit 64; }

JAWN_OPS="${JAWN_OPS:-jawn-ops}"
: "${DEV_PUBLISHER_KEY_ENTRY:?vault entry name required}"
: "${DEV_OPERATOR_CREDENTIAL_ENTRY:?vault entry name required}"
: "${DEV_CLOUDFLARE_READ_ENTRY:?vault entry name required}"
: "${PUBLISHER_SHA:?publisher main commit required}" "${PUBLISHER_IMAGE_RUN:?publisher image run id required}"
[[ "$PUBLISHER_SHA" =~ ^[a-f0-9]{40}$ && "$PUBLISHER_IMAGE_RUN" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid publisher commit or image run" >&2; exit 64; }

step() {
  local name="$1"; shift
  echo "setup-dev: ${name}: start"
  if "$@"; then echo "setup-dev: ${name}: ok"
  else
    local status=$?
    echo "setup-dev: ${name}: refused (exit ${status}); see docs/cms/functions-deploy.md#development-project-setup" >&2
    exit "$status"
  fi
}

admission_install() { "$JAWN_OPS" njpbs release admission --target development --install; }
admission_read() { "$JAWN_OPS" njpbs release admission --target development; }
functions_provision() { CMS_TARGET=development node scripts/component-runner.mjs functions provision-config; }
functions_verify() { CMS_TARGET=development node scripts/component-runner.mjs functions verify-config; }
grants_check() { node scripts/check-dev-setup.mjs 3< <(pass show "$DEV_PUBLISHER_KEY_ENTRY"); }
publisher_check() {
  node scripts/install-dev-publisher.mjs --sha "$PUBLISHER_SHA" --image-run "$PUBLISHER_IMAGE_RUN" --check \
    3< <(pass show "$DEV_OPERATOR_CREDENTIAL_ENTRY") 5< <(pass show "$DEV_CLOUDFLARE_READ_ENTRY")
}

if [[ "$check_only" == false ]]; then
  step "post admission install" admission_install
  step "functions provision-config" functions_provision
fi
step "post admission read" admission_read
step "functions verify-config" functions_verify
step "release reader grants" grants_check
step "publisher check" publisher_check
echo "setup-dev: every step passed"
