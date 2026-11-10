#!/usr/bin/env bash
# Exact-head merge path for a deferred schedule CI completion.
set -euo pipefail

: "${PR_NUMBER:?}" "${HEAD_SHA:?}" "${GITHUB_REPOSITORY:?}" "${ACTIONS_TOKEN:?}" "${CI_WAIT_DEADLINE:?}" "${SCHEDULE_BAKE_APP_SLUG:?}"

# Keep trusted scripts in place when a rebase checks out the generated head.
script_directory=$(mktemp -d)
trap 'rm -rf "$script_directory"' EXIT
cp .github/scripts/wait-schedule-ci.sh "$script_directory/wait-schedule-ci.sh"

verify_pull_request() {
  # Branch protection restricts pushes; independently reject PRs from any other
  # author, including a writer who opened a PR against the existing bot branch.
  local author trusted_author
  author=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json author)
  trusted_author=$(jq -r --arg expected_author "app/$SCHEDULE_BAKE_APP_SLUG" \
    '.author.is_bot == true and .author.login == $expected_author' <<< "$author")
  if [ "$trusted_author" != "true" ]; then
    echo "::error::Schedule PR $PR_NUMBER must be authored by the schedule-bake App. Close the untrusted PR and rerun the bake." >&2
    exit 1
  fi

  test "$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json state --jq '.state')" = "OPEN"
  test "$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json baseRefName --jq '.baseRefName')" = "main"
  test "$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json headRefName --jq '.headRefName')" = "automation/schedule-bake"
  test "$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json headRefOid --jq '.headRefOid')" = "$HEAD_SHA"

  test "$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json isCrossRepository --jq '.isCrossRepository')" = "false"
  test "$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json headRepositoryOwner --jq '.headRepositoryOwner.login')" = "${GITHUB_REPOSITORY%%/*}"

  local file_names
  file_names=$(gh pr diff "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --name-only)
  mapfile -t changed_files <<< "$file_names"
  test "${#changed_files[@]}" -eq 1
  test "${changed_files[0]}" = "site/src/data/schedule.json"
}

resolve_review_bot_threads() {
  # The connector reviews every PR. On this verified schedule-only PR a thread
  # that holds only connector comments must not block the merge. A thread with
  # a comment from anyone else still does.
  local thread_ids thread_id
  thread_ids=$(gh api graphql --paginate \
    -F owner="${GITHUB_REPOSITORY%%/*}" -F name="${GITHUB_REPOSITORY##*/}" -F number="$PR_NUMBER" \
    -f query='query($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){pageInfo{hasNextPage endCursor} nodes{id isResolved comments(first:100){pageInfo{hasNextPage} nodes{author{login}}}}}}}}' \
    --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false and .comments.pageInfo.hasNextPage == false and (.comments.nodes | length > 0) and all(.comments.nodes[]; .author.login == "chatgpt-codex-connector")) | .id')
  for thread_id in $thread_ids; do
    gh api graphql -F threadId="$thread_id" \
      -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}' >/dev/null
    echo "::notice::Resolved review-bot thread $thread_id on schedule PR $PR_NUMBER. Read it in the PR."
  done
}

rebase_onto_main_and_verify_ci() {
  local old_sha="$HEAD_SHA"
  git fetch origin main automation/schedule-bake
  git checkout --detach "$old_sha"
  git rebase origin/main
  HEAD_SHA=$(git rev-parse HEAD)
  git push --force-with-lease="refs/heads/automation/schedule-bake:$old_sha" \
    origin HEAD:refs/heads/automation/schedule-bake

  local pr_head_sha=""
  for _attempt in {1..30}; do
    pr_head_sha=$(gh pr view "$PR_NUMBER" \
      --repo "$GITHUB_REPOSITORY" \
      --json headRefOid \
      --jq '.headRefOid')
    if [ "$pr_head_sha" = "$HEAD_SHA" ]; then
      break
    fi
    sleep 2
  done
  test "$pr_head_sha" = "$HEAD_SHA"

  if GH_TOKEN="$ACTIONS_TOKEN" HEAD_SHA="$HEAD_SHA" bash "$script_directory/wait-schedule-ci.sh"; then
    return 0
  else
    local status=$?
    # A rebased PR still waiting for CI stays open, with no merge.
    if [ "$status" -eq 2 ]; then exit 0; fi
    return "$status"
  fi
}

# Independently observe successful CI at the expected head before merging.
if GH_TOKEN="$ACTIONS_TOKEN" bash "$script_directory/wait-schedule-ci.sh"; then
  :
else
  status=$?
  if [ "$status" -eq 2 ]; then exit 0; fi
  exit "$status"
fi

for round in 1 2 3; do
  verify_pull_request
  resolve_review_bot_threads

  merge_state=""
  for _attempt in {1..30}; do
    merge_state=$(gh pr view "$PR_NUMBER" \
      --repo "$GITHUB_REPOSITORY" \
      --json mergeStateStatus \
      --jq '.mergeStateStatus')
    if [ "$merge_state" = "CLEAN" ] || [ "$merge_state" = "BEHIND" ]; then
      break
    fi
    sleep 2
  done

  if [ "$merge_state" = "CLEAN" ]; then
    gh pr merge "$PR_NUMBER" \
      --repo "$GITHUB_REPOSITORY" \
      --squash \
      --match-head-commit "$HEAD_SHA"
    exit 0
  fi
  if [ "$merge_state" != "BEHIND" ] || [ "$round" -eq 3 ]; then
    echo "::error::Schedule PR $PR_NUMBER is not mergeable: ${merge_state:-missing}." >&2
    exit 1
  fi

  echo "::notice::Schedule PR $PR_NUMBER is behind main. Rebasing and verifying CI again."
  rebase_onto_main_and_verify_ci
done
