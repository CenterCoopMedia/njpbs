#!/usr/bin/env bash
# Resolve this repository's CI outcome and its still-current bot PR.
set -euo pipefail
: "${RUN_ID:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_OUTPUT:?}" "${SCHEDULE_BAKE_APP_SLUG:?}"
[[ "$RUN_ID" =~ ^[1-9][0-9]*$ ]]
source "$(dirname "${BASH_SOURCE[0]}")/../../scripts/lib/canonical-repo.sh"
configured_repository_identity
[[ "$GITHUB_REPOSITORY" == "$CANONICAL_GITHUB_REPOSITORY" &&
   "${GITHUB_REPOSITORY_ID:-}" == "$CANONICAL_GITHUB_REPOSITORY_ID" ]]

SCHEDULE_CI_OUTCOME=${1:-success}
case "$SCHEDULE_CI_OUTCOME" in success|failure) ;; *) exit 1 ;; esac
export SCHEDULE_CI_OUTCOME

CI_WORKFLOW_ID=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml" --jq '.id')
export CI_WORKFLOW_ID
# Compare the registered workflow ID, not its caller-controlled display name.
run=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID" --jq '
  select((.workflow_id | tostring) == env.CI_WORKFLOW_ID and
    (.path | split("@")[0]) == ".github/workflows/ci.yml" and .event == "pull_request" and
    .status == "completed" and
    ((env.SCHEDULE_CI_OUTCOME == "success" and .conclusion == "success") or
     (env.SCHEDULE_CI_OUTCOME == "failure" and
      (.conclusion as $conclusion | ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"] | index($conclusion) != null))) and
    .repository.full_name == env.GITHUB_REPOSITORY and
    (.repository.id | tostring) == env.CANONICAL_GITHUB_REPOSITORY_ID and
    (.head_repository.id | tostring) == env.CANONICAL_GITHUB_REPOSITORY_ID and
    .head_repository.full_name == env.GITHUB_REPOSITORY and
    .head_branch == "automation/schedule-bake")')
if [ -z "$run" ]; then exit 0; fi

# A completion can wait behind the bake; skip a closed or superseded PR.
prs=$(gh pr list --repo "$GITHUB_REPOSITORY" --head automation/schedule-bake \
  --base main --state open --json number,headRefOid,isCrossRepository,author)
admitted=$(jq -nr --arg expected_author "app/$SCHEDULE_BAKE_APP_SLUG" --argjson run "$run" --argjson prs "$prs" '
  $prs[] | select(.isCrossRepository == false and .headRefOid == $run.head_sha and
    .author.is_bot == true and .author.login == $expected_author) |
  . as $pr | $run.pull_requests[] |
  select(.number == $pr.number and .head.sha == $pr.headRefOid and
    .head.repo.id == $run.repository.id and .base.repo.id == $run.repository.id and
    .head.ref == "automation/schedule-bake" and .base.ref == "main") |
  "number=\($pr.number)\nhead_sha=\($pr.headRefOid)"')
if [ -n "$admitted" ]; then
  printf '%s\n' "$admitted" >> "$GITHUB_OUTPUT"
fi
