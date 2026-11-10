#!/usr/bin/env bash
# Deploy the admin CMS to production (admin.njpbs.org) in one command.
#
#   npm run admin:deploy
#
# Builds admin/dist and direct-uploads it to the njpbs-admin Cloudflare Pages
# project. The Cloudflare token is read from pass at run time and passed only to
# the Pages security checks and wrangler; it is never written to disk or printed.
#
# Four gates run before anything is uploaded, because this command replaces what
# staff see at admin.njpbs.org:
#
#   1. Production serves the reviewed, current code. njpbs-admin is a direct-upload
#      project, so the bytes come from this working tree rather than from a branch
#      CI has checked. Without a gate, deploying from a feature branch or a dirty
#      tree would publish code that never passed review, and deploying from a
#      stale checkout would roll the live admin back to older code without saying
#      so. The comparison is against origin/main, so the gate also has to know
#      that origin is this repository: against a fork or a scratch remote it
#      would prove the commit matches somebody else's main. Advancing the
#      production branch to a reviewed tip is what gives the public site all of
#      this for free.
#   2. The source has the public-shell safety marker and real config. A rollback
#      that predates the marker would expose the old bootstrap screen after the
#      application-wide Access bypass, so it is refused even when the rollback
#      flag is set. admin/.env is gitignored, and a missing value
#      does not fail the build: site/admin's firebase-config falls back to the
#      demo project, so an unconfigured build produces a healthy-looking bundle
#      wired to demo-njpbs. Checking for index.html cannot catch that; checking
#      the inputs can. This mirrors the preflight in cms-staging-deploy.yml.
#   3. The required account backend is already live. The admin validates every
#      restored and new session through registerStaffProfile. Navigation saves
#      also require the navigation edge route and its deployed Function.
#   4. The build and M14 status source is current and satisfies the public
#      manifest contract. Production refuses instead of publishing a guessed or
#      unavailable status.
#
# ADMIN_DEPLOY_CHECK=1 answers "would this deploy?" without deploying: it runs
# all four gates, reports every verdict, and stops before the credential read.
# ADMIN_DEPLOY_RELEASE_SHA=<full SHA> selects a reviewed main ancestor with its
# own successful main CI. It cannot be combined with either override below.
#
# Two overrides, because being unreviewed and being stale are different
# decisions. ADMIN_DEPLOY_ALLOW_UNREVIEWED=1 publishes code no one has reviewed
# (a hands-on check of an unmerged branch), and an origin the gate cannot
# identify counts as unreviewed, so it falls under this flag too.
# ADMIN_DEPLOY_ROLLBACK=1 publishes an older reviewed commit, which is what an
# incident rollback is, and it covers only the behind-the-tip refusal. Reusing the unreviewed
# flag for a rollback would ask whoever is mid-incident to declare reviewed code
# unreviewed. Gates 2 and 3 always run, under either.
#
# Why --branch=main is hardcoded: njpbs-admin is a direct-upload Pages project,
# where the branch decides production vs preview. Its production branch is main,
# and admin.njpbs.org serves the production deployment. Left to infer, wrangler
# would read the current git branch, so deploying from a feature branch would
# publish a preview that never reaches the custom domain.
#
# Config lives in admin/wrangler.jsonc; --cwd admin makes wrangler discover it
# instead of the repo-root Workers config (issue #552). Runbook:
# the deployment configuration
set -euo pipefail

readonly PROJECT="njpbs-admin"
# The Firebase project the live admin must talk to. Hardcoded for the same reason
# the Pages project above is: this script deploys one known thing to one known
# place, so a config pointing anywhere else is a mistake, not a variation.
readonly FIREBASE_PROJECT="njpbs-site"
readonly TOKEN_KEY="${CLOUDFLARE_TOKEN_ENTRY:?Set the Cloudflare token entry name}"
# Gate 1 requires an independently configured repository identity.
readonly CANONICAL_REPO="${CANONICAL_GITHUB_REPOSITORY:?Configure the canonical repository}"
readonly CANONICAL_REPO_ID="${CANONICAL_GITHUB_REPOSITORY_ID:?Configure the canonical repository ID}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# shellcheck source=scripts/lib/canonical-repo.sh
source "$repo_root/scripts/lib/canonical-repo.sh"

die() {
  echo "error: $1" >&2
  shift
  local line
  for line in "$@"; do echo "       $line" >&2; done
  exit 1
}

configured_repository_identity || die "canonical repository identity is invalid."
export CANONICAL_GITHUB_REPOSITORY CANONICAL_GITHUB_REPOSITORY_ID
export VITE_CANONICAL_GITHUB_REPOSITORY="$CANONICAL_REPO"

# Match the workflow's production environment > repository > organization selection.
# Refuse an unreadable catalog; absence at every scope deliberately means off.
author_profile_release_selection() {
  local release_repo selection endpoint
  command -v gh >/dev/null 2>&1 || die "gh is required to read the author publication release selection."
  if ! release_repo="$(gh api "repos/$CANONICAL_REPO" --jq '
    select((.id | tostring) == env.CANONICAL_GITHUB_REPOSITORY_ID and
      .full_name == env.CANONICAL_GITHUB_REPOSITORY) | .full_name')" ||
      [[ "$release_repo" != "$CANONICAL_REPO" ]]; then
    die "could not resolve the approved repository for author publication."
  fi
  for endpoint in \
      "repos/$release_repo/environments/production/variables?per_page=100" \
      "repos/$release_repo/actions/variables?per_page=100" \
      "repos/$release_repo/actions/organization-variables?per_page=100"; do
    if ! selection="$(gh api --paginate "$endpoint" \
        --jq '.variables[] | select(.name == "AUTHOR_PAGES_LIVE") | .value | @json')"; then
      die "could not read the author publication switch; refusing the build."
    fi
    [[ -n "$selection" ]] && break
  done
  if [[ "$selection" == '"true"' ]]; then printf '%s' true; else printf '%s' false; fi
}

# Ask Vite what `vite build` will resolve, rather than reading the env files
# here. Vite's rules are more than "read admin/.env": mode-specific files
# override it, a real environment variable beats all of them, and dotenv itself
# strips quotes and trailing comments, so `VITE_USE_EMULATORS='true' # note`
# means true. Every one of those is a way a hand-written check reads a different
# value than the bundle gets, and every .env file is gitignored, so the
# difference would be invisible. loadEnv is the resolver the build uses, so the
# gate cannot drift from what ships.
admin_config_state() {
  env -u GH_TOKEN -u GITHUB_TOKEN node --input-type=module -e '
    import { loadEnv } from "vite";
    const dir = process.argv[1];
    const project = process.argv[2];
    const required = [
      "VITE_FIREBASE_API_KEY",
      "VITE_FIREBASE_AUTH_DOMAIN",
      "VITE_FIREBASE_PROJECT_ID",
      "VITE_FIREBASE_APP_ID",
      "VITE_FIREBASE_APPCHECK_SITE_KEY",
      "VITE_FUNCTIONS_BASE_URL",
    ];
    const env = loadEnv("production", dir, "VITE_");
    // config-input: VITE_FIREBASE_API_KEY, VITE_FIREBASE_APPCHECK_SITE_KEY, VITE_FIREBASE_APP_ID, VITE_FIREBASE_AUTH_DOMAIN
    // config-input: VITE_FIREBASE_PROJECT_ID, VITE_FUNCTIONS_BASE_URL
    const missing = required.filter((key) => !(env[key] ?? "").trim());
    // The admin builds every call by appending a slash and the endpoint to the
    // raw value of this variable, so it has to be a bare origin and nothing
    // else. The console hands out per-function URLs, so one copied from there,
    // ending in /grantRole, would send every write to /grantRole/cmsSaveContent.
    // Comparing the parsed origin back to the unparsed value is what catches
    // that: it rejects a path, a query, a fragment and a nonstandard port at
    // once, and a trailing slash too, which no amount of reading .pathname
    // would, since "https://h" and "https://h/" both parse to "/" while only
    // the second builds a double slash into every call.
    const rawFunctionsUrl = env.VITE_FUNCTIONS_BASE_URL ?? "";
    const functionsUrlIsBareOrigin = (url) =>
      url.origin === rawFunctionsUrl && url.protocol === "https:" && url.port === "";
    const functionsUrl = (() => {
      try {
        return new URL(rawFunctionsUrl);
      } catch {
        return null;
      }
    })();
    const cmsApiOrigin = "https://api.example.org";
    if (missing.length > 0) console.log("missing:" + missing.join(" "));
    else if (env.VITE_USE_EMULATORS === "true") console.log("emulators");
    // Present is not the same as right. A filled-in config still points wherever
    // it points, and a complete demo or emulator config would otherwise pass.
    else if (env.VITE_FIREBASE_PROJECT_ID !== project)
      console.log("project:" + env.VITE_FIREBASE_PROJECT_ID);
    // The project id does not pin the app. authDomain names the Firebase app the
    // SPA signs in against, so a stale one carried over from another project
    // clears every other check here and hands staff a sign-in for the wrong app.
    else if (env.VITE_FIREBASE_AUTH_DOMAIN !== project + ".firebaseapp.com")
      console.log("authdomain:" + env.VITE_FIREBASE_AUTH_DOMAIN);
    else if (
      rawFunctionsUrl !== cmsApiOrigin ||
      !functionsUrl ||
      !functionsUrlIsBareOrigin(functionsUrl)
    )
      console.log("functions:" + env.VITE_FUNCTIONS_BASE_URL);
    else if (!["true", "false"].includes(process.argv[3]) || env.VITE_AUTHOR_PAGES_LIVE !== process.argv[3])
      console.log("authorrelease");
    else console.log("ok");
  ' "$repo_root/admin" "$FIREBASE_PROJECT" "${1:-}" 2>/dev/null
}

admin_functions_url() {
  env -u GH_TOKEN -u GITHUB_TOKEN node --input-type=module -e '
    import { loadEnv } from "vite";
    const env = loadEnv("production", process.argv[1], "VITE_");
    process.stdout.write((env.VITE_FUNCTIONS_BASE_URL ?? "").trim());
  ' "$repo_root/admin" 2>/dev/null
}

# --- gate 1: production serves reviewed code ---------------------------------
gate_reviewed_code() {
  local release_sha="${ADMIN_DEPLOY_RELEASE_SHA-}"
  if [[ -n "${ADMIN_DEPLOY_RELEASE_SHA+x}" ]]; then
    [[ "$release_sha" =~ ^[a-f0-9]{40}$ ]] || die "ADMIN_DEPLOY_RELEASE_SHA must be a full commit SHA."
    if [[ "${ADMIN_DEPLOY_ALLOW_UNREVIEWED:-}" == "1" || "${ADMIN_DEPLOY_ROLLBACK:-}" == "1" ]]; then
      die "An explicit Admin release pin cannot use unreviewed or rollback overrides."
    fi
    [[ "$(git rev-parse HEAD)" == "$release_sha" ]] || die "HEAD must equal ADMIN_DEPLOY_RELEASE_SHA."
  fi
  # These notes say what the flag permits rather than narrating a deploy, so
  # they read the same whether this run publishes or only reports (check mode).
  if [[ "${ADMIN_DEPLOY_ALLOW_UNREVIEWED:-}" == "1" ]]; then
    echo "note: ADMIN_DEPLOY_ALLOW_UNREVIEWED=1 skips the reviewed-code check, so"
    echo "      this working tree reaches admin.njpbs.org unreviewed."
    return 0
  fi
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]] &&
     ! node scripts/render-development-config.mjs --check-source --root "$repo_root" >/dev/null 2>&1; then
    die "the working tree has uncommitted changes." \
      "This command publishes these bytes to admin.njpbs.org, so it would put" \
      "code live that no one reviewed. Commit and merge first, or set" \
      "ADMIN_DEPLOY_ALLOW_UNREVIEWED=1 to publish this tree on purpose."
  fi
  local origin_url origin_repo origin_shown
  # Everything below reasons about origin/main as if it were this repository's
  # main, and never checks that it is. On a checkout whose origin points at a
  # fork or a scratch remote, that remote's main becomes the source of truth and
  # unreviewed admin code walks through the gate built to stop it. Same
  # principle as the fetch and origin/main checks below: unverifiable is a
  # refusal, not a pass, so a remote this cannot identify as the canonical
  # repository stops here rather than being assumed friendly (#557).
  #
  # ls-remote --get-url, not remote get-url, because it applies the
  # url.<base>.insteadOf rewrites git will actually fetch through. Reading the
  # unrewritten value would refuse an ordinary multi-account setup whose origin
  # is spelled gh:owner/repository.
  origin_url="$(git ls-remote --get-url origin 2>/dev/null || true)"
  # ls-remote --get-url echoes the name back when there is no such remote.
  [[ "$origin_url" == "origin" ]] && origin_url=""
  if [[ -z "$origin_url" ]]; then
    die "this checkout has no origin remote." \
      "Gate 1 proves a commit is reviewed by comparing it against the canonical" \
      "repository's main, and there is nothing here to compare against. Add the" \
      "remote, or set ADMIN_DEPLOY_ALLOW_UNREVIEWED=1 to publish this tree on" \
      "purpose."
  fi
  origin_repo="$(canonical_repo_from_url "$origin_url" || true)"
  # Named in the refusal so the message is actionable, but a remote can carry a
  # token in its userinfo and this text goes to a terminal or a CI log.
  origin_shown="$(redact_url_credentials "$origin_url")"
  if [[ -z "$origin_repo" ]]; then
    die "cannot tell what repository origin points at: $origin_shown" \
      "Gate 1 trusts origin/main as the record of what passed review, which only" \
      "holds if origin is an approved NJ PBS repository. A local mirror, a self-hosted host, or" \
      "an ssh host alias from your ~/.ssh/config may well be legitimate, but this" \
      "cannot tell one from an impostor, so it refuses rather than guesses. Spell" \
      "origin out as github.com/$CANONICAL_REPO, or set" \
      "ADMIN_DEPLOY_ALLOW_UNREVIEWED=1 to publish this tree on purpose."
  fi
  if [[ "$origin_repo" != "${CANONICAL_REPO,,}" ]]; then
    die "origin is $origin_repo; the approved repository is $CANONICAL_REPO." \
      "Every check below reads origin/main as the record of what passed review," \
      "so against a fork or a scratch remote they would prove that this commit" \
      "matches that remote's main and nothing about review. Point origin at the" \
      "canonical repository, or set ADMIN_DEPLOY_ALLOW_UNREVIEWED=1 to publish" \
      "this tree on purpose."
  fi
  # Verify the immutable ID as well as the configured name.
  local origin_id
  if ! command -v gh >/dev/null 2>&1 ||
      ! origin_id="$(gh api "repos/$origin_repo" --jq '.id' 2>/dev/null)" ||
      [[ "$origin_id" != "$CANONICAL_REPO_ID" ]]; then
    die "origin does not resolve to the approved NJ PBS repository ID."
  fi
  # Unverifiable is a refusal, not a pass. Skipping the check when origin cannot
  # be read would let a fresh or misconfigured checkout publish an unreviewed
  # commit through the gate that exists to stop exactly that.
  if ! git fetch --quiet origin main 2>/dev/null; then
    die "could not reach origin to check that this commit is reviewed." \
      "The deploy needs the network anyway, so this is refusing rather than" \
      "guessing. Reconnect, or set ADMIN_DEPLOY_ALLOW_UNREVIEWED=1 to publish" \
      "this tree on purpose."
  fi
  if ! git rev-parse --verify --quiet origin/main >/dev/null; then
    die "this checkout has no origin/main to compare against." \
      "Without it there is no way to tell whether HEAD was reviewed. Check the" \
      "remote, or set ADMIN_DEPLOY_ALLOW_UNREVIEWED=1 to publish this tree on" \
      "purpose."
  fi
  if ! git merge-base --is-ancestor HEAD origin/main; then
    die "HEAD is not part of origin/main." \
      "Only reviewed commits belong on admin.njpbs.org, and this one has not" \
      "landed through a PR yet. Merge it first, or set" \
      "ADMIN_DEPLOY_ALLOW_UNREVIEWED=1 to publish this tree on purpose."
  fi
  if [[ -n "$release_sha" ]]; then
    node "$repo_root/scripts/check-admin-release-ci.mjs" "$release_sha" ||
      die "The selected Admin release requires its own successful main CI."
    return 0
  fi
  # Reviewed is not the same as current. The ancestor check above passes for any
  # commit in main's history, so a checkout that is merely out of date would
  # deploy old code and undo whatever merged since, reporting success either
  # way. Deploying an older commit is a real thing to want during an incident,
  # so this refuses the accident and keeps the deliberate case one flag away.
  if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
    if [[ "${ADMIN_DEPLOY_ROLLBACK:-}" == "1" ]]; then
      echo "note: ADMIN_DEPLOY_ROLLBACK=1 allows $(git rev-parse --short HEAD), which is"
      echo "      behind origin/main, to reach admin.njpbs.org."
    else
      die "HEAD is behind origin/main." \
        "This commit was reviewed, but newer code has merged since. Deploying" \
        "it would roll admin.njpbs.org back to older code and say nothing," \
        "which is usually a forgotten git pull. Run git pull, or set" \
        "ADMIN_DEPLOY_ROLLBACK=1 to publish this older commit on purpose."
    fi
  fi
}

# --- gate 2: the build has real config, not the demo fallback ----------------
gate_build_config() {
  local config_state release_selection
  if [[ ! -f admin/public/_headers ]] \
    || [[ ! -f admin/index.html ]] \
    || ! node "$repo_root/scripts/lib/admin-public-shell.mjs" \
      "$repo_root/admin/public/_headers" "$repo_root/admin/index.html"; then
    die "this Admin revision predates the public authentication-shell safety boundary." \
      "The Cloudflare Access bypass persists independently of the Pages artifact," \
      "so publishing this revision would expose its retired bootstrap screen." \
      "Use a reviewed rollback that contains the no-index public shell, or restore" \
      "the private Access policy before using an older emergency artifact. Neither" \
      "ADMIN_DEPLOY_ROLLBACK nor ADMIN_DEPLOY_ALLOW_UNREVIEWED bypasses this check."
  fi
  release_selection="$(author_profile_release_selection)" || return 1
  config_state="$(VITE_AUTHOR_PAGES_LIVE="$release_selection" admin_config_state "$release_selection")" || true
  case "$config_state" in
    ok) ;;
    missing:*)
      die "the admin build config is missing required values: ${config_state#missing:}" \
        "Without them the build does not fail. It quietly ships an admin wired to" \
        "the demo-njpbs project instead of njpbs-site, so staff would sign in to" \
        "an app with no data. Set them in admin/.env (see admin/.env.example);" \
        "this shell and any .env.local or .env.production count too."
      ;;
    emulators)
      die "VITE_USE_EMULATORS resolves to true for a production build." \
        "That points the bundle at localhost emulators, which nothing outside" \
        "this machine can reach. Set it to false; this shell and any .env.local" \
        "or .env.production count as well as admin/.env."
      ;;
    project:*)
      die "the build is configured for Firebase project '${config_state#project:}', not $FIREBASE_PROJECT." \
        "The config is complete, so nothing else would complain, and the admin" \
        "would come up at admin.njpbs.org signed in against the wrong backend." \
        "Point VITE_FIREBASE_PROJECT_ID at $FIREBASE_PROJECT to deploy."
      ;;
    authdomain:*)
      die "VITE_FIREBASE_AUTH_DOMAIN is not $FIREBASE_PROJECT's: ${config_state#authdomain:}" \
        "This names the Firebase app staff sign in against. Pointing it at another" \
        "project's app while the project id says $FIREBASE_PROJECT signs them in" \
        "with the wrong identity, and every privileged call is then rejected." \
        "Set it to $FIREBASE_PROJECT.firebaseapp.com to deploy."
      ;;
    functions:*)
      die "VITE_FUNCTIONS_BASE_URL is not the approved CMS API edge: ${config_state#functions:}" \
        "Direct Firebase Function origins bypass the shared request budget and" \
        "must not be compiled into the production admin. Set it to exactly" \
        "https://api.example.org, with no trailing slash or path."
      ;;
    authorrelease)
      die "the Vite author publication input does not match the production release switch."
      ;;
    *)
      die "could not read the admin build config through Vite." \
        "The gate that keeps a demo-wired bundle off admin.njpbs.org depends on" \
        "it, so this is refusing rather than guessing. Run npm install at the" \
        "repo root, then try again."
      ;;
  esac
}

# --- gate 3: the session-admission backend is already live -------------------
gate_staff_admission_backend() {
  local functions_url endpoint status navigation_origin
  functions_url="$(admin_functions_url)" || true
  if [[ -z "$functions_url" ]]; then
    die "could not resolve VITE_FUNCTIONS_BASE_URL for the backend check." \
      "Gate 2 should have named the configuration problem. This gate refuses" \
      "because publishing without a verified staff-admission endpoint can lock" \
      "every account out of the admin."
  fi
  if ! command -v curl >/dev/null 2>&1; then
    die "curl is required to verify the staff-admission endpoint." \
      "Install curl, then retry. The staff profile and account-request endpoints" \
      "must be confirmed on the configured backend before the front end is published."
  fi

  for endpoint in registerStaffProfile submitStaffAccessRequest cmsGetBroadcastSchedule cmsSetNavigationPreferences; do
    status="$(
      curl --silent --show-error \
        --output /dev/null \
        --write-out '%{http_code}' \
        --request POST \
        --header 'Content-Type: application/json' \
        --data '{}' \
        --connect-timeout 5 \
        --max-time 15 \
        "${functions_url}/${endpoint}"
    )" || true

    # These handlers require a bearer token. An empty unauthenticated probe must
    # find each edge route and return 401 before the front end can depend on it.
    # The full-stack deployment covers the settings release.
    if [[ "$status" == "401" ]]; then
      continue
    fi

    die "$endpoint is not ready on the configured backend (HTTP ${status:-000})." \
      "Run the reviewed full-stack Firebase deploy first, then retry this standalone" \
      "admin upload. Publishing now would expose an account screen whose server" \
      "boundary is unavailable."
  done

  # The edge refuses anonymous requests before it contacts Firebase. Check the
  # new Function's direct-origin refusal too, as the full-stack smoke check does,
  # so a present edge route cannot hide a missing navigation Function.
  navigation_origin="https://us-central1-${FIREBASE_PROJECT}.cloudfunctions.net/cmsSetNavigationPreferences"
  status="$(
    curl --silent --show-error \
      --output /dev/null \
      --write-out '%{http_code}' \
      --request POST \
      --header 'Content-Type: application/json' \
      --data '{}' \
      --connect-timeout 5 \
      --max-time 15 \
      "$navigation_origin"
  )" || true
  if [[ "$status" != "403" ]]; then
    die "cmsSetNavigationPreferences is not ready at its Firebase origin (HTTP ${status:-000})." \
      "Run the reviewed full-stack Firebase deploy first, then retry this standalone" \
      "admin upload. Navigation saves require both the edge route and its Function."
  fi
}

# Build status is public deployment metadata, but its source is the private
# workflow context. Fetch the bounded milestone catalog before any Cloudflare
# credential is read. Only the encoded, validated manifest reaches Vite.
prepare_admin_status_manifest() {
  local milestones_file manifest status_repo
  if ! command -v gh >/dev/null 2>&1; then
    die "gh is required to read milestones for the Admin status surface." \
      "Install and authenticate GitHub CLI, then retry. The deploy will not" \
      "publish an unavailable or guessed production status."
  fi
  if ! status_repo="$(gh api "repos/$CANONICAL_REPO" --jq '
    select((.id | tostring) == env.CANONICAL_GITHUB_REPOSITORY_ID and
      .full_name == env.CANONICAL_GITHUB_REPOSITORY) | .full_name')" ||
      [[ "$status_repo" != "$CANONICAL_REPO" ]]; then
    die "could not resolve the approved Admin repository identity."
  fi
  milestones_file="$(mktemp)" || die "could not create the temporary milestone file."
  if ! gh api "repos/$status_repo/milestones?state=all&sort=due_on&direction=asc&per_page=100" > "$milestones_file"; then
    rm -f "$milestones_file"
    die "could not read milestones from $status_repo." \
      "Reconnect or authenticate GitHub CLI, then retry."
  fi
  if ! manifest="$(
    env -u GH_TOKEN -u GITHUB_TOKEN \
      node scripts/admin-status-manifest.mjs \
        --environment Production \
        --milestones "$milestones_file" \
        --repository "$status_repo" \
        --revision "$(git rev-parse HEAD)"
  )"; then
    rm -f "$milestones_file"
    die "the milestone response did not satisfy the Admin status manifest contract."
  fi
  rm -f "$milestones_file"
  printf '%s' "$manifest"
}

# --- check mode: report all gates, deploy nothing ----------------------------
# Asking what a gate decides used to mean running the command that publishes,
# and on 2026-07-16 that put a staging-wired bundle on admin.njpbs.org for about
# a minute (issue #558). The two older flags both make the deploy publish more
# readily; this one is the way to get an answer without one.
#
# All gates are reported, rather than stopping at the first refusal, because
# stopping is the "fix one, re-run, find the next" loop this mode exists to end.
# The gates run for real: same functions, same order, same checks as a deploy.
# The difference is where it ends, before the credential read. A check mode that
# still needs an unlocked gpg agent is a check mode nobody runs.
#
# Each gate runs inside a command substitution, which is a subshell, so die ends
# the gate instead of the script and its message is captured for the report.
# A normal deploy calls the same functions directly, where die still exits.
if [[ "${ADMIN_DEPLOY_CHECK:-}" == "1" ]]; then
  echo "ADMIN_DEPLOY_CHECK=1: reporting what the gates decide."
  echo "Nothing is built, no credential is read, nothing is uploaded."
  echo
  check_refused=0

  if gate_1_output="$(gate_reviewed_code 2>&1)"; then
    echo "gate 1, reviewed and current code: pass"
  else
    echo "gate 1, reviewed and current code: would refuse"
    check_refused=1
  fi
  [[ -n "$gate_1_output" ]] && echo "$gate_1_output"
  echo

  if gate_2_output="$(gate_build_config 2>&1)"; then
    echo "gate 2, real build config: pass"
  else
    echo "gate 2, real build config: would refuse"
    check_refused=1
  fi
  [[ -n "$gate_2_output" ]] && echo "$gate_2_output"
  echo

  if gate_3_output="$(gate_staff_admission_backend 2>&1)"; then
    echo "gate 3, required Admin backend: pass"
  else
    echo "gate 3, required Admin backend: would refuse"
    check_refused=1
  fi
  [[ -n "$gate_3_output" ]] && echo "$gate_3_output"
  echo

  if gate_4_output="$(prepare_admin_status_manifest 2>&1 >/dev/null)"; then
    echo "gate 4, Admin status manifest: pass"
  else
    echo "gate 4, Admin status manifest: would refuse"
    check_refused=1
  fi
  [[ -n "$gate_4_output" ]] && echo "$gate_4_output"
  echo

  if (( check_refused )); then
    echo "npm run admin:deploy would refuse to publish."
    exit 1
  fi
  echo "npm run admin:deploy would publish $(git rev-parse --short HEAD) to admin.njpbs.org."
  exit 0
fi

gate_reviewed_code
gate_build_config
gate_staff_admission_backend
admin_status_manifest="$(prepare_admin_status_manifest)"
# Read back once more before credentials/build. The explicit build input below
# overrides stale ambient and local Vite files, including when the switch is absent.
author_release_selection="$(author_profile_release_selection)"

# --- credentials -------------------------------------------------------------
if ! command -v pass >/dev/null 2>&1; then
  die "pass is not installed, so the Cloudflare token can't be read." \
    "Install and configure pass before running this command."
fi
if ! token="$(pass show "$TOKEN_KEY" 2>/dev/null)" || [[ -z "$token" ]]; then
  die "could not read the Cloudflare token from pass ($TOKEN_KEY)." \
    "Check the configured credential entry and unlock the GPG agent."
fi

echo "checking the Admin Pages guide boundary ..."
env -u GH_TOKEN -u GITHUB_TOKEN CLOUDFLARE_API_TOKEN="$token" \
  node scripts/check-admin-pages-security.mjs predeploy

# --- build -------------------------------------------------------------------
echo "building admin/dist ..."
env -u GH_TOKEN -u GITHUB_TOKEN \
  ADMIN_STATUS_MANIFEST_BASE64="$admin_status_manifest" \
  VITE_AUTHOR_PAGES_LIVE="$author_release_selection" \
  npm run admin:build

if [[ ! -f admin/dist/index.html ]]; then
  die "admin/dist/index.html is missing after the build." \
    "The upload would publish an empty site, so stopping here."
fi

# --- upload ------------------------------------------------------------------
# wrangler nags about deploying from a dirty tree unless it is told the state.
# Report the real state instead of always claiming one, so the deployment
# metadata records whether the build came from committed code and the deploy
# stays quiet either way. Gate 1 means this is false unless it was overridden.
if [[ -n "$(git status --porcelain 2>/dev/null)" ]] &&
     ! node scripts/render-development-config.mjs --check-source --root "$repo_root" >/dev/null 2>&1; then
  commit_dirty=true
else
  commit_dirty=false
fi

# Fetch wrangler before the token exists anywhere, then run the cached copy with
# the token but without the ability to install. Downloading a package runs its
# install scripts, and those of its dependencies, so doing that with a broad
# Cloudflare credential already in the environment would hand it to whatever
# code npm happens to fetch. Splitting it in two keeps the credential out of
# every install. --no-install is what makes it a guarantee rather than a habit:
# if the cache is empty at this point it fails loudly instead of quietly
# downloading with the token set. --yes on the fetch keeps a fresh machine from
# stopping at a prompt. The exact pin keeps local and CI deploy tooling aligned.
echo "resolving wrangler ..."
env -u GH_TOKEN -u GITHUB_TOKEN npx --yes wrangler@4.134.0 --version >/dev/null

echo "deploying admin/dist to $PROJECT (production, admin.njpbs.org) ..."
env -u GH_TOKEN -u GITHUB_TOKEN CLOUDFLARE_API_TOKEN="$token" \
  npx --no-install wrangler@4.134.0 pages deploy \
  --cwd admin \
  --project-name="$PROJECT" \
  --branch=main \
  --commit-dirty="$commit_dirty" \
  --commit-message="admin deploy from $(git rev-parse --short HEAD)"

echo
echo "confirming admin.njpbs.org serves this revision ..."
DEPLOY_SHA="$(git rev-parse HEAD)" node scripts/confirm-admin-revision.mjs

env -u GH_TOKEN -u GITHUB_TOKEN CLOUDFLARE_API_TOKEN="$token" \
  node scripts/check-admin-pages-security.mjs postdeploy

echo
echo "done. admin.njpbs.org serves the new deployment. The bare URL must return"
echo "the public no-index authentication shell with HTTP 200; sign in to confirm"
echo "the build."
