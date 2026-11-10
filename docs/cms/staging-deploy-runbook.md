# Coordinated CMS release contract

This is the source, command, state and recovery contract for a coordinated
release. Running a deployment workflow changes live systems and requires
separate authorization. This document supplies no credentials or authorization.
Do not infer current live state from a dated source document.

## Component and authority map

| Component | Source/contract | State that proves completion |
| --- | --- | --- |
| Public Worker and Assets | [Public Worker](public-worker-deploy.md) | Active provider deployment/version, exact ordinary-route publication receipt and idle generation pointer |
| Public publisher | [Cloud publisher](cloud-publisher.md) | Exact Worker/container/runtime pins, original release request/batch and public capability/receipt |
| Firebase Functions, rules/indexes | [Functions](functions-deploy.md) | Complete inventory/identities, rules/index readiness, scheduler targets and component receipt |
| CMS API and published readers | [CMS API](cms-api-deploy.md) | Exact Worker version/bindings, secret agreement and endpoint/old-reader proofs |
| Private preview | [Renderer](cloud-preview-renderer.md) | Exact compiled package/image/source, runtime ready and admitted artifact proof |
| Admin | [Admin](admin-deploy.md) | Exact retained build artifact/manifest, Pages security/bindings and staff checks |
| Development and small gateways | [Gateways](small-worker-gateways.md) | Per-component route/binding/version and exact refusal/non-delivery proof |
| Schedule/PDF | [Schedule](../runbooks/schedule-pdf.md) | Accepted input and exact JSON/PDF packet, ordinary public output proof |
| Staff admission | [Access](staff-access-runbook.md) | Protected rules and separate reader activation/account acceptance |
| Experimental paired release | [Release pairs](release-without-pause.md) | Actual installed OLD/NEW reader, switch, rollback and original-operation proofs |

Git source does not restore Firestore or media. Public committed assets, private
R2 objects and provider-hosted images/video have separate owners. A retained
Pages artifact is a recovery origin, not evidence that the apex uses Pages.
No component mutation implicitly deploys another surface or publishes content.

## Release source and prerequisites

Choose full 40-character reviewed NEW once. The normal publisher/public release
finishes and verifies at NEW before CMS dispatch at that same SHA. Later main
merges go in the next release. Keep the separate trusted workflow `main` ref:
GitHub pins its `github.sha`, while `deploy_ref` selects application source.
Authorization, exact-main CI, compatibility and scans use trusted source.
Release planner, receipts, deployment helpers, retirement plan, smoke and
Admin boot checks use NEW. Never copy newer helpers over selected source.

Before selected code or provider authentication, validate both Git identities,
canonical configured repository name/ID, required helper files, Admin `test:boot`
and `contracts.cmsReleaseChecks.version: 1`. Keep the editor-lock compatibility
floor, addressed leases/releases, tier authority, field protection and activation
evidence. Older behavior requires a reviewed forward revert that retains those
contracts. An ancestry marker alone is insufficient compatibility proof.

Run source scans before credentialed execution. Verify required parameters,
named secret bindings/versions, App Check web-app registration/site-key match,
scoped IAM, storage dependencies and native Environment/ref admission. Missing,
unreadable, unknown or mismatched input refuses before mutation. Values remain
in memory or the existing scoped deployment environment; never in receipts/logs.

Functions configuration is table-driven; the routine workflow performs read-only
`verify-config` before mutation and `verify-deployed-config` before receipt
completion. Provider setup belongs solely to explicit `provision-config` with
separate authorization. Follow the [configuration contract](functions-deploy.md#configuration-and-provisioning)
for native readback, asynchronous TTL completion, scoped IAM and the actual
media canary. **Real census NOT DONE** remains a named prerequisite before the
first public release; the staging source and local tests are not live proof.

## Dispatch

From the root of a clean reviewed checkout in Bash, supply `NEW` and the two
[canonical identity inputs](../config/repository-identity.md). In the authorized
operator session, check the exact main-push CI:

```bash
: "${NEW:?Set NEW to the approved full release SHA}"
: "${CANONICAL_GITHUB_REPOSITORY:?Configure the approved repository}"
[[ "$NEW" =~ ^[a-f0-9]{40}$ ]] || exit 1
deploy_sha="$NEW"
gh run list --repo "$CANONICAL_GITHUB_REPOSITORY" --workflow ci.yml \
  --event push --branch main --commit "$deploy_sha" \
  --json databaseId,headSha,status,conclusion
```

Require that exact SHA's successful completed main-push `CI` run and successful
native `ci` job, read with `gh run view RUN_ID --repo "$CANONICAL_GITHUB_REPOSITORY" --json jobs`.
PR/manual runs, canceled/superseded/skipped/pending or unreadable proof cannot
substitute. The trusted workflow repeats admission. After separate deployment
authorization, keep the captured SHA and dispatch:

```bash
gh workflow run cms-staging-deploy.yml \
  --repo "$CANONICAL_GITHUB_REPOSITORY" \
  --ref main \
  -f deploy_ref="$deploy_sha" \
  -f cloudflare_pages_branch=main
```

Read the [workflow](../../.github/workflows/cms-staging-deploy.yml) for the current
input schema. There is no default `deploy_ref`; moving refs and short SHAs fail.
The separate emergency exact-source procedure is a private operator step and
requires its own live-base/CI authorization. The ordinary dispatch cannot enable
that exception. Deployment and failure recovery never authorize a merge.

## Mutation order and selection

1. Finish identity, CI, source, parameter/secret and provider preflight.
2. Prepare declared component dependencies and build exact artifacts. Run each
   required repair in the workflow's source-owned order and verify postconditions.
3. Under a qualified selective plan, ordinary changed Functions may deploy
   after dependency readiness but before the late preview pause. Unknown/config/
   force/recovery plans retain early pause and full release.
4. Pause preview before replacing any preview-pin/control reader. Strict-drain
   admitted queues/journals and prove inactive containers before replacement.
5. Deploy matched preview Functions and renderer; verify exact runtime ready.
   CMS API must have matching edge secret and live identity even when reused.
6. Deploy exact Admin artifact only after backend/settings/security readiness.
7. Run complete inventory/scheduler checks and source-owned deployed smoke.
8. Read receipts/serving identities and perform staff/public interaction and
   post-CMS settlement checks separately. Only then report the paired release
   verified. Missing interaction proof remains explicit.

The planner may reuse only complete receipts with matching input/configuration/
trusted-source fingerprints and fresh live identities. Missing graph metadata,
dynamic/unresolved edges, loader/build/asset/export changes and provider drift
retain conservative selection. It cannot infer a safe no-op from equal source
alone. Renderer input matching includes its committed dependency closure and
conservative Site/assets/package/build inputs. A changed preview pin selects
every graph reader of that pin/control.

Configuration comparison covers effective parameters, provisioned secret
versions and actual bound versions without exposing values. Missing metadata,
partial mutation or unknown state refuses/skips no safety work. Rules/indexes,
migration inputs, Functions, renderer and API have separate selection rows.
Policy and repair edits do not force Functions or Preview; an unrelated Functions
upload does not force the API. Code/configuration dependencies retain their order.
The [Functions](functions-deploy.md) and [API](cms-api-deploy.md) contracts define
the unchanged safety requirements.

## Receipt view

In the authorized read-only credential session, use the
[component runner](../../scripts/component-runner.mjs):

```bash
node scripts/component-runner.mjs functions read
node scripts/component-runner.mjs renderer read
node scripts/component-runner.mjs cmsApi read
```

Confirm provider/runtime identities with the matching component's `confirm`
operation and its explicit source, fingerprint and original run/attempt inputs.
Keep application `sourceSha` and `trustedWorkflowSha` separately.

Retain the `cms-release-source-identities` artifact: `deploySha` and
`releaseChecksSha` equal NEW, `trustedWorkflowSha` identifies trusted gates.
This proves source selection, not completion. Unchanged components retain
their original complete mutation/source receipt and receive fresh live checks.
Selective Functions source identifies the last component mutation; not every
serving export necessarily has that revision.

For public state, compare `system/publicDeployment`, exact active batch/candidate,
runtime pins and ordinary `/_publication.json` with provider deployment/version.
Read active identity before and after a served-artifact proof. Record public,
publisher, CMS API, Functions, renderer and Admin independently. `origin/main`,
`production` branch, a green workflow or old evidence is not the live predecessor.

## Failed or interrupted CMS release

Earlier successful Functions batches remain live when a later one fails;
remaining batches keep old revisions. Preserve `in_progress` and `lastComplete`
and treat the release as mixed until guarded recovery finishes. Recompute plans
and actual identities on a partial rerun. A provider timeout is uncertain, not
permission to restart under another identity.

Automatic Functions abandonment is limited to attempt one, both deployment
phases skipped and no retirement/provider mutation started. Idempotent repairs
may already have run. It restores the prior complete mutation and records the
exact abandoned run/attempt. A later attempt or started retirement retains the
reservation. Recover by a reviewed forward run after GitHub's latest-attempt
readback proves the recorded owner stopped. This also covers failure before a
retirement plan was written. Missing evidence stops recovery; no manual receipt
edit or force override is part of this method.

Only for an attempt-one reservation meeting those no-mutation conditions, in
a separate authorized private credential session, use:

```bash
node scripts/component-runner.mjs functions abandon \
  --run-id "<the dead run's GITHUB_RUN_ID>" \
  --run-attempt "<the dead run's GITHUB_RUN_ATTEMPT>"
```

It requires attempt one, no retirement started, exactly that in-progress
run/attempt and an existing `lastComplete`.
Other state/run or missing predecessor refuses with no write. A second abandon
refuses because the first already restored complete state. `force_firebase`
cannot bypass an active receipt. Never abandon renderer state: recover through
a matched release after proving its old recorded workflow stopped, then verify
readiness before resuming preview. Keep exact accepted claims/source/tokens.

## Boundary smoke and mixed Admin tabs

Use NEW's complete current export manifest and
`node scripts/component-runner.mjs functions smoke`. Missing or unknown exports
refuse; there is no historical optional-family path. Verify health 200; unauthenticated
edge POST 401, direct-origin POST 403, unsupported GET 405 and configured CORS
preflight 204, including App Check headers. Preserve current private-reader
boundaries, inventory/no-deletion and scheduler smoke. No real staff
message, paid API request or content mutation is a harmless smoke substitute.

The mixed-version window begins with new server code and ends with new Admin
artifact; existing tabs may remain old afterward. Keep prior Admin usable with
supported readers. Preserve any error/build identity, save work and reload after
verified upload before retrying; highlighted validation/byline problems need
their own diagnosis. Record server and Admin completion times separately.
A byline readiness-response omission is not proof a profile is incomplete, and
reloading cannot repair a server response contract.

## Development published seed

The [seed operator](../../scripts/seed-dev-published.mjs) keeps `export`,
`validate`, `copy-media` and `import` separate, fixed production-read/development-
write project pair, explicit Node type-stripping flag and service-account stdin.
A private operator step verifies dedicated read-only source and dev-only writer
identities first. No ADC, Auth/database export or production storage authority.
Never substitute an administrator credential.

Order: provision dev roles/test accounts/billing/rules/indexes with admission
paused; obtain exact verified active publication and matching retained context;
export from one read-only snapshot; validate the content-addressed manifest;
optionally copy admitted public media locally; dry-run import; separately
authorized apply; readback; first dev publication; then matched preview setup.

Export arguments remain `--source njpbs-site --destination njpbs-site-dev`,
`--source-sha <reviewed-40-character-sha>`, `--publication`, optional required
`--context` for frozen cards and `--output`. Validation takes `--manifest`.
Import takes that manifest; `--apply` writes. `--configuration-only` hashes
scope and imports only complete section/media-category registries with receipts,
never content or runtime controls. A scoped manifest cannot broaden if that flag
is omitted. These are argument contracts, not credential-producing examples.

Public immutable snapshots and allowlisted registries only; no draft/hidden/
private profile/auth/queue/lease/system/secret import. Settings retain their
public schema; provenance lives in `devSeedRecords`. Registered credits missing
a public profile become frozen custom credits; private rights attestations are
not copied. Public media remains a read-only production dependency. Strict HTTPS
host/path/type/size/redirect gates and actual HEAD/GET byte counts apply.
Local hashed copy receipts never upload or rewrite URLs.

First full import requires absent deployment/preview pointers and empty queues,
then creates generation zero and paused unconfigured preview. Later imports
never reset controls. Inventory preflight and groups of at most 100 transactional
records reject staff edits/deletions/untracked rows. A partial import resumes
the same manifest; unchanged is no-op. Source updates touch only still-matching
tracked records. No deletion/reset/adoption override exists. Configuration-only
repair leaves content/runtime controls and existing seed category unchanged.

## Schedule automation and timing evidence

The [schedule workflow](../../.github/workflows/schedule-bake.yml) validates fresh
public schedule data, commits only `site/src/data/schedule.json` on its automation
branch and creates/updates the schedule PR. It does not use a private supplier
or discovery pointer. Bake success does not prove merge or public publication;
CI completion and deferred merge are separate jobs. Check active/waiting writers
before manual recovery. The shared
non-cancelling group has only one waiting job, which another accepted dispatch
can replace. Closed/superseded/foreign CI completions are refused before entry
and checked again inside the writer lock before a write token exists.

Deferred merge requires the registered workflow/repository/event/branch, open
same-repository automation PR against main, exact current head CI, schedule-only
diff and match-head lease. CI runs outside the writer lock. Missing CI event/API
failure fails rather than inventing proof; pending rebased CI leaves the PR open
for its own completion. Never merge a pending/failed head by hand.
Read current workflow schedule and natural-run receipts instead of old timing
claims. Failure notification delivery and workflow execution are separate proof.

For latency, retain acceptance, queue wait, cold import/startup, preparation,
upload/activation, serving observation and CMS settlement separately. Correlate
exact request/content/source/context and use persisted timing fields. Overlapping
probes cannot be summed as wall time. A warm sample, old audit or import-only
benchmark is not a current percentile or proof of click-to-live. Keep expiry,
freshness and withdrawal gates while measuring. See [schedule/PDF](../runbooks/schedule-pdf.md).

## Incident and fallback recovery

First read actual affected component source/provider/receipt and trusted tooling.
Preserve observations privately; fix forward through reviewed source and one
pinned paired release. A reset of the `production` branch does not recover an
active Worker or CMS. For wrong content, distinguish CMS correction/publication
from source change and investigate unauthorized write access when indicated.

Credential compromise requires separate incident authority: rotate at issuer
first, update every active/recovery consumer, quiesce/redeploy/readback, revoke
prior credentials and audit the exposure window. Do not restart retired owners
to test rotation. Report intake and publisher alerts share downstream secrets:
coordinate downstream-first and both Worker copies. Detaching the intake custom
domain contains direct posts; hiding the site widget alone does not. Secret
rotation alone does not contain public spam. Retain exact private incident note,
timeline, causes, recovery proof and remaining gaps.

A switch to retained Pages is a separately authorized recovery decision:

1. Read live route table, active generation/source/queue/version, and identify
   the exact successful fallback run/ref/artifact.
2. Verify source/digest, public contract and guardrails; prove no private Admin,
   guide, design preview or private media, and only permitted public wiki output.
3. Confirm existing domain/proxied DNS settings without changing them.
4. Complete a private reviewed guarded admission-pause transaction at the exact
   active runtime. Verify deployed Functions enforce manual/scheduled admission.
5. Keep the owner running until all accepted queues/pending markers/journal/
   leases drain. Recover original work first; never clear tokens or force idle.
6. Stop/disable all active/fallback owners and recheck after shutdown. Keep
   admission paused throughout fallback; do not switch transport implicitly.
7. Apply the separately reviewed route change preserving Contact, then prove
   authoritative route ownership and actual Pages origin/content/privacy on
   ordinary public URLs. A successful upload grants no route authority.
8. Before resuming, restore verified Worker route/publication and matched owner,
   idle coordinator and runtime, then guarded transition paused to ready.

Current fallback artifacts reuse the aligned active batch/cutoff without
reserving a generation; revalidate immediately before upload and deployment.
An advancing public pointer refuses. Old generation-reserving sources are
invalid. Independent publication during the provider action remains a race to
account for, not evidence that a prior check locked the publisher.

Verify apex/www redirects and proxy headers, Home/Post/support/live/watch,
styled 404, public search and privacy on ordinary URLs; inspect console errors.
DNS reversals can propagate slowly; preserve prior records/proxy state before
any separately authorized edit. PBS-hosted embed/portal failures require
provider diagnosis; schedule freshness is a separate baked-input problem.

Database delete protection, PITR, scheduled exports, media backups and restore
drills are different controls. Read fresh provider/evidence receipts for each.
Enabled protection is not proof of a tested restore. Missing export retention,
pre-migration snapshot or restore/isolated media drill remains a recovery gap;
source checkout and playable viewing-copy backup cannot restore original CMS
media identities. Never turn a historical claim into current recovery proof.
