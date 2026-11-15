# Bug-report credential rotation

Use this runbook for `CMS_BUG_REPORT_GITHUB_TOKEN` and
`CMS_BUG_REPORT_GITHUB_WEBHOOK_SECRET`. Rotate one credential at a time.
The coordinator must authorize the production change and name its operator.
A source PR does not authorize provisioning, deployment or revocation.

Keep the issue tracker private. Proposed fixes use a separate source repository.
Before rotation, read back all four deployed parameters from the
[repository identity contract](../config/repository-identity.md):

| Parameter | Purpose |
| --- | --- |
| `CMS_BUG_REPORT_GITHUB_REPOSITORY` | Report issue repository name |
| `CMS_BUG_REPORT_GITHUB_REPOSITORY_ID` | Immutable issue repository ID |
| `CMS_BUG_REPORT_FIX_GITHUB_REPOSITORY` | Proposed-fix repository name |
| `CMS_BUG_REPORT_FIX_GITHUB_REPOSITORY_ID` | Immutable fix repository ID |

Use the approved deployment record for the expected values. Do not infer them
from the checkout. Inventory every hook that shares the runtime HMAC secret,
including hooks in both the issue and fix repositories. Record each repository,
hook ID, URL and event selection, plus the current token ID, secret version IDs,
bound runtime revisions and an existing linked report's ID. Keep this change
record private. Keep report content and account identifiers out of public receipts.

## Credential delivery and Functions release

The operator uses the approved credential store and scoped deployment session.
Name the current and replacement credential pointers in the private change
record. Retrieve values only when the consuming command needs them. Do not put
values in command arguments, source, persistent payload files, logs or reports.
Keep shell tracing off. Do not print a secret or the complete process environment.

Deliver the replacement to the same-name secret in the public source repository's
production Actions environment. Keep the old provider credential valid until
adoption is proved. An Actions update timestamp alone does not prove adoption.

Follow [Functions configuration and provisioning](functions-deploy.md#configuration-and-provisioning)
and the [coordinated release](staging-deploy-runbook.md) at one reviewed deploy SHA.
Use a clean checkout at that SHA, including its verified production render, and
the complete declared input set. The scoped session supplies private inputs at
use time. Routine deployment runs `verify-config`; it refuses a replacement that
differs from Secret Manager. Run the separately authorized provisioning step
before dispatching the coordinated release.

Session: The approved Bash deployment session, at the exact reviewed source root.
Run each command at its named stage. These commands do not select or dispatch a
release by themselves.

```bash
node scripts/component-runner.mjs functions provision-config
```

After provisioning, before release mutation:

```bash
node scripts/component-runner.mjs functions verify-config
```

After the coordinated Functions rollout:

```bash
node scripts/component-runner.mjs functions verify-deployed-config
```

Retain the original run/attempt and component receipts. Read provider metadata
for every serving export that binds the changed secret. Require its intended
enabled version and completed runtime rollout; enumerate consumers from the
current source bindings and live inventory. `verify-deployed-config` includes
media-binding checks and does not by itself prove bug-report webhook delivery.
Do not revoke an old value or disable an old version while a live revision or
unfinished release still needs it.

## GitHub API token

1. Create a replacement fine-grained token through the credential owner's approved
   GitHub account. Select the issue repository and the separate fix repository.
   The common runtime token serves both clients. Use Issues write for report
   creation/comments, and Pull requests, Checks, Commit statuses and Deployments
   read for linked-fix progress. Preserve required Metadata read. Do not add
   source-write, workflow, administration or webhook-management permission.
   GitHub's fine-grained token model applies the chosen permissions to selected
   repositories; this runbook does not claim different per-repository scopes.
2. Confirm the replacement can read each repository's configured name and numeric
   ID. Keep responses private and retain only identity agreement and status in
   the change record. Supply `CMS_BUG_REPORT_GITHUB_TOKEN` through the delivery
   and Functions sequence above.
3. Require successful synchronization of one existing linked report through its
   configured issue and fix repositories. Match its stored
   `fixPullRequestRepository` and `fixPullRequestRepositoryId`, PR number and
   resulting progress. Preserve the original outbox/retry identities. Do not
   submit a new report or send a notification to manufacture proof.
4. Revoke only the recorded old token through its owner. Read back its revoked
   state and confirm an authenticated read with that old value is refused. Pass
   the value through the approved client's private input, never argv. Report
   only the HTTP status. Require the replacement's normal synchronization to
   remain healthy after revocation. Disable old Secret Manager versions only
   after all consumers have moved.

If adoption fails, retain the old token and the original failed run. Diagnose
before another action. After revocation, recovery requires a valid replacement
and a forward configuration release; do not restore a revoked credential.

## GitHub webhook secret

The handler verifies one HMAC secret. It has no old/new overlap. Changing either
side first creates a mismatch interval for each hook. Record each interval's
start and end, then recover every failed delivery for every inventoried hook.

1. Generate a fresh random value with the approved credential tool. The source
   requires 32 to 256 characters from letters, digits, `_` and `-`. Store it under
   the approved replacement pointer. Keep each hook's URL, repository, event
   selection, content type and TLS verification unchanged.
2. Supply `CMS_BUG_REPORT_GITHUB_WEBHOOK_SECRET`, provision it and complete the
   Functions release above. Confirm the webhook export's new binding and runtime
   revision. Keep the prior version enabled while old consumers still need it.
3. Have the authorized webhook administrator set that same replacement on every
   inventoried hook, including both issue- and fix-repository hooks. Use the
   approved secret-safe UI or client
   for `PATCH /repos/{owner}/{repo}/hooks/{hook_id}/config`. The runtime token
   must not gain webhook-management permissions. Do not put a secret in a JSON
   payload file, a command argument or an API response log. A config GET or
   update timestamp cannot prove secret equality.
4. Inspect delivery IDs and statuses across each hook's full mismatch interval.
   Redeliver each failed delivery through its original hook. A redelivery request is only
   submission: Wait for its result and require 2xx, then verify the queued sync
   reaches its original terminal result. Account for every delivery; do not
   declare success from a small recent sample. Keep payloads private.
5. Require valid signed deliveries from both configured repositories accepted by
   the new handler, with their linked report synchronization. Account for every
   other inventoried hook before disabling the unbound old Secret Manager version.
   Record each repository/hook ID, new binding/version, runtime revision,
   delivery IDs, outcomes and old-version disabled state without either value.

If either side fails, keep the change open and retain the delivery inventory.
The coordinator selects a matched valid secret for both sides and repeats the
forward adoption/readback steps. Do not restore only one side or mark a failed
delivery settled because redelivery was requested.

## Completion and references

Complete the private change record only after public adoption, serving bindings,
normal report progress and old-credential retirement are all proved. List any
remaining old consumer or delivery as unfinished work. This runbook does not
rotate the Telegram bot, relay secret or other service credentials.

- [GitHub fine-grained token permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).
- [GitHub repository webhook configuration and delivery API](https://docs.github.com/en/rest/repos/webhooks).
- [GitHub webhook redelivery](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks).
- [Functions configuration](../../config/functions-configuration.json) and
  [bug-report GitHub client/handler](../../functions/bug-report-github.js).
