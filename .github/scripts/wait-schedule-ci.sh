#!/usr/bin/env bash
# Exit 0 for exact-head CI success, 2 for CI still pending, 1 for real errors.
set -euo pipefail

: "${HEAD_SHA:?}" "${CI_WAIT_DEADLINE:?}" "${PR_NUMBER:?}" "${GITHUB_REPOSITORY:?}"

# A missing CI event fails after one minute. An existing queued run waits until
# the shared CI deadline, including when the head changes after a rebase.
discovery_deadline=$(( $(date +%s) + 60 ))

while true; do
  # Query the immutable head, including after a rebase. An earlier green run
  # on the automation branch cannot authorize this schedule commit.
  if ! run=$(gh run list \
    --repo "$GITHUB_REPOSITORY" \
    --workflow ci.yml \
    --branch automation/schedule-bake \
    --event pull_request \
    --limit 20 \
    --json databaseId,headSha,status,conclusion \
    --jq '[.[] | select(.headSha == env.HEAD_SHA)][0] // empty | [.databaseId, .status, (.conclusion // "pending")] | @tsv'); then
    echo "::error::Schedule PR CI observation failed." >&2
    exit 1
  fi

  if [ -n "$run" ]; then
    read -r run_id status conclusion <<< "$run"
    case "$status" in
      completed)
        if [ "$conclusion" = "success" ]; then
          exit 0
        fi
        echo "::error::Schedule PR CI run $run_id completed with $conclusion." >&2
        exit 1
        ;;
      queued|in_progress|pending|waiting|requested) ;;
      *) echo "::error::Schedule PR CI returned an invalid status." >&2; exit 1 ;;
    esac
  fi

  now=$(date +%s)
  if [ -z "$run" ] && [ "$now" -ge "$discovery_deadline" ]; then
    echo "::error::No CI run found for schedule PR #$PR_NUMBER head $HEAD_SHA." >&2
    exit 1
  fi
  if [ -n "$run" ] && [ "$now" -ge "$CI_WAIT_DEADLINE" ]; then
    message="Schedule PR #$PR_NUMBER CI pending for head $HEAD_SHA; the bake is complete and the PR remains open."
    echo "::notice::$message"
    printf '%s\n' "$message" >> "$GITHUB_STEP_SUMMARY"
    exit 2
  fi
  sleep 15
done
