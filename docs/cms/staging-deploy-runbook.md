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
R2 objects and provider-hosted images/video have separate owners. A component
rollout changes only its own surface.

## Release source and prerequisites

Choose full 40-character reviewed NEW once. The normal publisher/public release
finishes and verifies at NEW before CMS dispatch at that same SHA. Later main
merges go in the next release. Keep the separate trusted workflow `main` ref:
GitHub pins its `github.sha`, while `deploy_ref` selects application source.
Authorization, exact-main CI, compatibility and scans use trusted source.
Release planner, receipts, deployment helpers, retirement plan, Functions smoke
and Admin boot checks use NEW. The signed-in preview probe comes from the
trusted workflow checkout and runs against the deployed target. Never copy
newer helpers over selected source.

Configure `CMS_LOCAL_PUBLICATION_OWNER` and `CMS_GPU_WORKER_ID` from the live
deployment before the first public-source release. The existing source renderer
requires both values in production workflows and isolated publisher/preview
images; omission refuses before deployment. The committed generic identities
are source templates, not deployed defaults. Keep the local owner distinct from
`cloudflare`. The pinned rendering receipt and component fingerprints bind the
same configuration to compiled consumers and operator source checks.

Keep the recorded local publication owner across queues, background work and
retirement receipts. Keep the GPU identity across worker authentication,
transcription/alignment/orientation leases, the shared slot and orientation
capability check-in. A repository or host rename does not rename accepted work.
Do not rewrite terminal receipts, clear leases or create another active slot.
At the authorized handoff, drain the existing owners and read back auth identity,
all accepted GPU jobs and the shared slot immediately before replacement. Retain
queued work and its original IDs; install the new source against that same slot.
Keep an original-source recovery owner for any unsettled claim. A later identity
change requires its own reviewed move after settlement, with the old consumer
stopped and its slot retired; this release adds no alias or alternate consumer.

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

The ordinary dev deploy and production live-smoke step each open one private
preview in a fresh browser. In each GitHub Environment, supply
`CMS_PREVIEW_SMOKE_TARGET` with `editor` (the dedicated fixture's edit route)
and `heading` (the exact heading it renders). Supply
`CMS_PREVIEW_SMOKE_CREDENTIAL` with the fixture account's `email` and `password`.
Development also needs `adminAccess` and `previewAccess` objects containing the
`CF-Access-Client-Id` and `CF-Access-Client-Secret` for their respective origins.
Use a fixture nobody edits during the check and grant its account only the
access needed to open it in the editor and request a preview.

Before using the production probe, retain an authorized ordinary dev run that
passes both the existing CMS boundary checks and `signed_in_private_preview`.
That result requires a successful session POST from the Admin tab and a first
preview document response of 200 on the immutable preview route with the
expected heading. The receipt contains only the result and a fixed stage code.
Dev operations that intentionally preserve or restore paused preview admission
skip this check.

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
operator session, check the exact landed source CI.

```bash
: "${NEW:?Set NEW to the approved full release SHA}"
: "${CANONICAL_GITHUB_REPOSITORY:?Configure the approved repository}"
: "${CANONICAL_GITHUB_REPOSITORY_ID:?Configure the approved repository ID}"
[[ "$NEW" =~ ^[a-f0-9]{40}$ ]] || exit 1
deploy_sha="$NEW"
export CANONICAL_GITHUB_REPOSITORY CANONICAL_GITHUB_REPOSITORY_ID
node scripts/check-admin-release-ci.mjs "$deploy_sha"
```

Require the exact SHA's completed `CI / ci` success from a main push or its
landed main merge group. The shared reader verifies repository and source
identity and checks main ancestry for queue proof. The trusted workflow repeats
admission. After separate deployment authorization, keep the captured SHA and
dispatch.

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
8. Recheck the singleton contract after upload if the before-upload check used
   independent proof. It verifies the native readset, backend and public-reader
   identity, and the deployed Admin SHA. Its Firebase authentication stays in a
   separate runner from smoke. A successful public-first result skips this job
   because settlement would repeat the public renderer compatibility read.
9. Read receipts and serving identities. Perform staff and public interaction
   and post-CMS release settlement checks separately. Only then report the
   paired release verified. Report any missing interaction proof.

The Functions planner may reuse complete receipts with matching runtime inputs,
render inputs, configuration and fresh live identities. A workflow-only edit
does not require a Functions rollout. Missing graph metadata,
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
`validate`, `copy-media`, `import` and `verify` separate, with a fixed
production-read/development-write project pair, the explicit Node type-stripping
flag and service-account JSON on stdin. Export accepts only the production
service account that `SEED_EXPORT_IDENTITY` names; give that account Firestore
viewer access and nothing else. Before any read, export confirms at project
level that the account can get and list Firestore entities and holds none of
the probed Firestore write, import, export or Cloud Storage permissions. That
check cannot see a grant on an individual bucket. The script makes no Cloud
Storage call. Import and verify accept only the dedicated dev seed writer. A
private operator step verifies the dedicated read-only source identity
(including that it has no production bucket-level storage grant) and the
dev-only writer identity before their first use and after any IAM change. The
procedure uses no ADC and no Auth or database export. Never substitute an
administrator credential.

### Refresh dev before a rehearsal

Run from a fresh clone at the source SHA, after the root and `site` installs and
`npm run functions:build`. `SEED_READER_COMMAND` and `SEED_WRITER_COMMAND` are
operator-supplied commands that stream the production reader and dev writer
service-account JSON to stdout at use time; `SEED_EXPORT_IDENTITY` is the
reader's service-account email.

Plan (read-only on both projects):

```bash
set -euo pipefail
STATE=$(mktemp -d)   # owner-only; keep it for the rehearsal record
SHA=$(git rev-parse HEAD)
SEED="node --experimental-strip-types --no-warnings scripts/seed-dev-published.mjs"
PAIR="--source njpbs-site --destination njpbs-site-dev"
# The code-context receipt names the generation the production pointer serves.
curl -fsS 'https://njpbs.org/_publication.json?cms-context=code' > "$STATE/publication.json"
sh -c "$SEED_READER_COMMAND" |
  $SEED export $PAIR --source-sha "$SHA" --publication "$STATE/publication.json" --output "$STATE/manifests" | tee "$STATE/export.json"
MANIFEST=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).path)' "$STATE/export.json")
$SEED validate $PAIR --manifest "$MANIFEST"
sh -c "$SEED_WRITER_COMMAND" | $SEED import $PAIR --manifest "$MANIFEST" | tee "$STATE/plan.json"
```

The dry run is the plan. `restored` lists seeded records that dev changed or
deleted; `removed` lists seeded records the source no longer publishes. Each
entry records the document and receipt hashes the dry run saw. Apply takes the
plan from the same run and restores or removes a listed row only while both
hashes still match.

The plan is checked before apply in one of two ways:

- By hand: read `plan.json`. Every `restored` path must be a seeded record a dev
  rehearsal or proof changed, and every `removed` path must be a record
  production no longer publishes. Stop and investigate a path you cannot explain.
- Through `jawn-ops njpbs release run --target development`: the command applies
  the plan from the same run with no person wait. Apply itself enforces the
  [dev rehearsal refresh policy](../../AGENTS.md): it acts only on seed-written
  rows whose path, document and receipt hashes the plan binds, and refuses
  anything else. The plan and apply records go into the run record.

Then apply and verify:

```bash
sh -c "$SEED_WRITER_COMMAND" | $SEED import $PAIR --manifest "$MANIFEST" --plan "$STATE/plan.json" --apply | tee -a "$STATE/apply.json"
sh -c "$SEED_WRITER_COMMAND" | $SEED verify $PAIR --manifest "$MANIFEST" | tee "$STATE/verify.json"
```

If the snapshot references a Sponsor or Newsletter card, export also needs
`--context` with the retained public context of that publication and refuses
without it. Production's Nov. 23, 2026 snapshot references none.

Keep `plan.json`, `apply.json` and `verify.json` with the rehearsal run record.
Apply prints one JSON line per committed group, then a summary, so a partial
apply still records what it wrote; `tee -a` keeps every attempt when you resume. The summary's `plan` field compares the apply
with its plan: `matched` is false when a planned path was not applied or a
withdrawn row was `retained` because the plan did not list it.

`verify` prints the manifest hash, the source publication receipt, the export
time and per-collection counts; record that line with the rehearsal. It fails
when any seeded dev document differs from the manifest or dev still tracks a
record the snapshot no longer has. Rerun the apply with the same manifest and
plan to resume an interrupted refresh; finished groups report `unchanged`.

### What the refresh copies and reconciles

Public immutable snapshots and allowlisted registries only: routed published
Pages, Posts, Programs and Events whose `publishAt` has passed, the three public
settings, public author profiles, and the public media records they reference.
No draft, hidden, deleted, scheduled, staff-type, private profile, Auth, queue,
lease, system, secret or rights-attestation data. Published snapshots are
rebuilt through the publish contract and scrubbed of email, private, internal,
credential, token and storage fields. Settings keep their public schema;
provenance lives in `devSeedRecords`. Registered credits missing a public
profile become frozen custom credits. Public media stays a read-only production
dependency: dev records keep the `media.njpbs.org` URLs, so the refresh adds no
dev storage. Strict HTTPS host/path/type/size/redirect gates and real HEAD/GET
byte counts apply. Optional local hashed copy receipts never upload or rewrite
URLs.

The first full import requires absent deployment and preview pointers and
empty queues; it then creates generation zero and a paused, unconfigured
preview. Later imports never reset controls. Apply writes in transactional
groups of at most 100. Without a plan it refuses a seeded record that dev edited
or deleted and retains a seeded record the source withdrew. With a plan it
restores or removes only the listed seed-written rows whose document and receipt
still match the dry run; a seeded record changed after the dry run is refused.
Apply that writes or removes seeded media clears the cached media admission
count, so the next upload recounts active media. An untracked dev record at a source path is always
refused, so dev-authored fixtures are never overwritten.
Configuration-only manifests reconcile only the section and media-category
registries and leave content, runtime controls and the `dev-seed` category alone.

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

## Incident recovery

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
