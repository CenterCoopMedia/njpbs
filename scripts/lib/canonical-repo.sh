# shellcheck shell=bash
# Normalise a git remote URL to owner/repo.
#
# Sourced by scripts/deploy-admin.sh so its reviewed-code gate can check that
# `origin` is this repository before it trusts `origin/main` (#557). It lives in
# its own file, with no side effects, so a test can source it and exercise the
# parsing directly. Do not put anything here that runs on source.
#
# The same repository has several valid spellings, and all of them have to
# normalise to the same answer, because a false refusal here is worse than the
# hole this closes. the deployment configuration says why under gate 1.
#
#   git@github.com:owner/repo.git
#   github.com:owner/repo.git
#   ssh://git@github.com/owner/repo.git
#   https://github.com/owner/repo.git
#   https://github.com/owner/repo
#   https://token@github.com/owner/repo.git
#   git://github.com/owner/repo.git
#   any of the above with a trailing slash
#
# Prints owner/repo and returns 0 when the URL names a GitHub repository over a
# transport that fetches from the host it names. Prints nothing and returns 1
# when it does not: a local path, a mirror, a self-hosted host, a scheme like
# file:// or ext:: that does not mean what it looks like, or anything
# unparseable. The caller decides what to do with that; this function does not
# guess, because guessing here would mean guessing that an unknown remote is
# trustworthy.
configured_repository_identity() {
  [[ "${CANONICAL_GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ &&
     ! "${CANONICAL_GITHUB_REPOSITORY,,}" =~ replace|placeholder &&
     "${CANONICAL_GITHUB_REPOSITORY_ID:-}" =~ ^[1-9][0-9]*$ ]] || return 1
}

canonical_repo_matches_configured_url() {
  configured_repository_identity || return 1
  local repository
  repository="$(canonical_repo_from_url "${1:-}")" || return 1
  [[ "$repository" == "${CANONICAL_GITHUB_REPOSITORY,,}" ]]
}

canonical_repo_from_url() {
  local url="${1:-}"
  [[ -n "$url" ]] || return 1

  local scheme
  if [[ "$url" == *"://"* ]]; then
    scheme="${url%%://*}"
  elif [[ "$url" == *:* ]]; then
    # scp-like syntax has no scheme and uses a colon instead of a slash:
    # user@host:owner/repo.git. Rewrite it to a URL shape so one parser handles
    # every form. A Windows path takes this branch too and falls out at the host
    # check below, which is the right answer for a local path anyway.
    url="ssh://${url/://}"
    scheme="ssh"
  else
    # No scheme and no colon is a bare local path.
    return 1
  fi

  # Allowlist the transports that actually fetch from the host they name, or the
  # host check below proves nothing. git reads file://github.com/owner/repo as
  # the LOCAL PATH /owner/repo and ignores the host entirely, and ext:: runs a
  # command of the remote's choosing. Either would hand the gate an origin/main
  # that never came from GitHub while parsing as though it had.
  case "${scheme,,}" in
    https | http | ssh | git | git+ssh) ;;
    *) return 1 ;;
  esac

  local rest="${url#*://}"

  # Split the authority off BEFORE touching credentials. Order matters: strip
  # to the last @ across the whole remainder first, and an @ later in the URL
  # poses as the host separator, so
  # https://evil.test/@github.com/example-org/example-repo.git reads as github.com
  # while git fetches it from evil.test. That is the whole attack this function
  # exists to stop.
  #
  # The authority ends at the first /, ? or #, and all three matter: git fetches
  # https://evil.test?@github.com/owner/repo from evil.test as well, so
  # terminating only on / would leave the same impersonation open through a
  # query string or a fragment.
  local authority="${rest%%[/?#]*}"

  # An authority contains no delimiter, so the last @ inside it is the real end
  # of the userinfo, and a password may legitimately contain one.
  local host="${authority##*@}"
  host="${host%%:*}"
  # Hostnames are case insensitive, and git will happily fetch GITHUB.com from
  # the real GitHub. Refusing that spelling would be a false refusal.
  host="${host,,}"

  # Only github.com. A different host may be a legitimate mirror, but this
  # function cannot tell a mirror from an impostor, and the gate that calls it
  # treats unverifiable as a refusal rather than a pass.
  [[ "$host" == "github.com" || "$host" == "www.github.com" ]] || return 1

  # Only a slash opens a path. A ? or # after the authority means there is no
  # repository path here at all, which the owner/repo check below then refuses.
  local path=""
  local after="${rest:${#authority}}"
  [[ "$after" == /* ]] && path="${after:1}"

  path="${path%/}"
  path="${path%.git}"
  path="${path%/}"

  # Exactly owner/repo. Anything deeper is not a clone URL.
  [[ "$path" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || return 1

  # Lowercased, because GitHub owner and repository names are case insensitive:
  # Example-Org/Example-Repo and example-org/example-repo are one repository. Returning
  # the spelling as typed would make the caller's comparison refuse a checkout
  # that is in fact canonical, which is the false refusal this whole function
  # exists to avoid.
  printf '%s\n' "${path,,}"
}

# Strip credentials out of a URL so it can be printed.
#
# The gate names the offending remote in its refusal, which is what makes the
# message actionable. A remote can carry a token in its userinfo, and printing
# that would write a live credential into a terminal scrollback or a CI log.
#
# Only the userinfo is removed, and it is found the same way the parser finds
# the host: inside the authority, which ends at the first /, ? or #. Cutting at
# the first @ anywhere instead would rewrite
# https://evil.test/@github.com/example-org/example-repo.git into
# https://***@github.com/example-org/example-repo.git, hiding the real host and
# showing the operator the canonical repository in a message that refuses it.
redact_url_credentials() {
  local url="${1:-}"
  [[ "$url" == *"://"* ]] || { printf '%s\n' "$url"; return 0; }

  local scheme="${url%%://*}"
  local rest="${url#*://}"
  local authority="${rest%%[/?#]*}"
  if [[ "$authority" == *@* ]]; then
    # Last @ inside the authority, matching the parser, so a password that
    # itself contains an @ is removed whole rather than half-printed.
    printf '%s\n' "${scheme}://***@${authority##*@}${rest:${#authority}}"
  else
    printf '%s\n' "$url"
  fi
}
