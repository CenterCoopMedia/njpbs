# Functions, rules and migration contract

Use the [coordinated release](staging-deploy-runbook.md) at its exact reviewed
application SHA. Function code, Firestore rules/indexes, Storage rules and data
repairs have independent inputs in the component table. Policy and repair edits
do not select Functions or Preview uploads. Code releases still run ordered
prerequisites. This contract describes the source; prove actual serving state
from receipts and provider readback before calling a release live.

## Planning and source

The source-owned planner is [cms-release-plan.mjs](../../scripts/cms-release-plan.mjs).
It compares complete prior receipts, actual live identities, effective runtime
parameters, provisioned secret versions and the versions bound by each export.
Secret values never enter diagnostics. Missing/unreadable metadata, partial
receipts, configuration/secret drift or unknown graph edges cannot become no-op.

The planner selects changed committed closures, readers with a different
effective parameter, exports bound to an older enabled secret version, and
the required preview readers. It emits the sorted decision for each export
without parameter values or secret payloads. Variable-list edits can skip a
rollout when the deployed settings, source closures and shared inputs agree.
Shared startup, package, provider configuration, or export inventory changes
take the full path. So do unreadable live inputs and ownership that the module
graph cannot prove. Rules/indexes and Storage rules retain
their own readiness checks. Repairs retain consumer order, scans and postconditions
while their selection stays independent of a Functions upload.

Run preflight before mutation: canonical source/ref/Environment, exact-main CI,
App Check registration, required declared parameters, scoped IAM and provider
dependencies. Noninteractive deployment needs all declared nonsecret parameters
in generated dotenv. Unknown keys, absent required values or secret-agreement
failure stop. Provisioning and release remain distinct authorizations.

## Development rehearsal

Run the normal development deploy at a green exact main SHA with publishing
held and no active dev producer. Keep the current renderer pin for a routine
deploy. The dev job uses its own OIDC identity, Worker token and dev codebase.

The dev and production jobs use the same per-export target selector. Dev
compares the rendered parameters and a complete live inventory to the prior
receipt. Changed or unproven source inputs select the entire dev manifest.
Every dev reader update also assigns new candidate IDs to the shared Functions
configuration. That selects every dev export even when the source is unchanged.
The dev job logs each export's reasons and the Functions deploy duration.
It reads the exact active Wrangler version before completing the CMS API
receipt.

The same post-deploy runner overlaps Eventarc IAM and Functions configuration
readback. Dev verifies its rendered settings on every export. Production
also verifies its pinned R2 credential versions, native TTL and Auth policies,
and integration configuration. Those checks need production resources.

Registry input changes select the shared repair path. With stable inputs,
each registry runs the shared live readiness check and seeds only when that
check finds a gap. A second run at the same source can prove a skip after a
repair. The dev job records each decision and still runs its full smoke suite.

For a failed dev deploy that reached a provider mutation, preserve its
receipt identities. Verify the original run and attempt are terminal, read
back the live Functions and Worker revisions, and confirm the idle publisher,
held publishing flag and ready renderer. Run the corrected green main source
as a new routine dev deployment. Its new run identity takes the component
reservations and retains the preceding complete receipts and original
candidate records.

## Configuration and provisioning

For the GitHub report token and webhook secret, follow the
[bug-report credential rotation runbook](bug-report-secret-rotation.md). It keeps
the private issue tracker separate from the fix-source repository and requires
runtime adoption before old credentials are retired.

[functions-configuration.json](../../config/functions-configuration.json) owns
each input's native binding, default/type/required checks, runtime parameter and
secret role. SDK declarations and actual export bindings supply the export and
runtime-account inventory; do not maintain a second export list. The common
runner exposes these operations from the repository root in Bash:

| Operation | Behavior |
| --- | --- |
| `node scripts/component-runner.mjs functions configure` | Validate declared inputs and metadata discovery; atomically write the private, mode-0600 Functions dotenv file. No provider writes. |
| `node scripts/component-runner.mjs functions verify-config` | Read native auth/TTL, secret versions, scoped IAM, bucket lifecycle and pinned-credential bucket access. Missing or differing state refuses before release mutation. |
| `node scripts/component-runner.mjs functions verify-deployed-config` | Repeat verification and compare serving exports' actual media secret bindings to the canary-proven native version references before completing the Functions receipt. |
| `node scripts/component-runner.mjs functions provision-config` | Explicit, separately authorized setup/rotation. Create only missing resources, add changed secret versions, grant missing scoped IAM, enable email/password auth and queue required TTL policies. Run the actual media Put/Head/Delete canary and prove cleanup before writing native version references. |

Provider operations require a clean source checkout (including verified,
deterministically rendered deployment inputs) whose HEAD equals the full
`DEPLOY_SHA`, the configured deploy identity and scoped project-number readback.
The existing process environment supplies credentials and private inputs at use;
never put values in command arguments, logs or receipts. `CMS_DEPLOYMENT_VARIABLES_JSON`
supplies the GitHub variable map; only the table's declared keys enter runtime
configuration. Private preset/admin-map JSON is validated in memory and safely
serialized. The nine release-comparison secrets retain their value-agreement
checks, including optional publish-token agreement when supplied.

The production planner, dev preflight and dev verifier use the same serving
parameter encoding. Firebase stores SDK list parameters as JSON. JSON text
parameters and other settings retain the supplied runtime value.

Routine release calls verification only. Missing resources name the exact
required secret, binding or TTL policy rather than creating it. Explicit
provisioning reuses matching enabled versions and reads back changes.
Requested cost-pull and media-purge secrets are provisioned before repeating
metadata discovery, so first-time setup can enable their actual SDK bindings.
Missing enabled versions refuse explicit setup rather than disabling the request.
TTL setup uses native asynchronous operations: `CREATING` is pending, not ready. Wait for
native completion and rerun the same operation; no queued policy can satisfy
the required `ACTIVE` state. A failed or uncertain media write/delete must settle
through actual object readback before credential references can advance.

[functions-deployment.json](../../config/functions-deployment.json) records only
the approved scope and native media secret version references. Null references
deliberately refuse verification. The references were recorded on Nov. 18, 2026
from the production census: each media secret has one enabled version (1, created
Aug. 14, 2026), and all 12 serving Functions that bind the media credentials,
including `cmsUploadMedia`, bind version 1. CMS deploy run 44269086649 passed the
native resource, scoped IAM and secret-value checks before it refused the null
references. The repository's `mediaCanary` then passed with version 1 against the
production media bucket at 2026-11-18T08:55:51Z: Put, Head, Delete and proven absence of
`cms-media-staging/deploy-preflight-9af235f4-298f-401e-9bee-e724ae253d46`. Rotation requires explicit `provision-config` and a new committed
reference; no value digest or second ledger exists.

The trusted source gate requires selected IAM and retention validators to match
the trusted workflow's committed bytes. A stale validator refuses before selected
code or credentials run; release fixes forward. SDK and gcloud use the same
verified credential file when supplied, without enrolling a gcloud account.

## Development project setup

Seven dev CMS deploy runs on Nov. 23, 2026 (45285400512 through 45310500950)
found these setup requirements one run at a time. A new or rebuilt dev project
needs every row before its first deploy. Each check runs before any release
mutation and names the fix below.

| Requirement | Check that refuses | Fix |
| --- | --- | --- |
| Every secret and variable in `env.CMS_DEVELOPMENT_ENVIRONMENT_NAMES` exists in the GitHub `development` environment (njpbs#562) | The release runner's input check before dispatch | `gh secret set <NAME> --env development --repo CenterCoopMedia/njpbs` (or `gh variable set`) |
| Dev secret values are at least 6 characters. GitHub masks each secret value in every log and drops any job output that contains it, so the placeholder `1` emptied the Functions configuration fingerprint (run 45306098095). A real Telegram chat ID of 6 or more digits passes | "Require the target's deploy credentials" in `cms-staging-deploy.yml` | A placeholder: `openssl rand -hex 24 \| gh secret set <NAME> --env development --repo CenterCoopMedia/njpbs`. Two secrets have a format. `CMS_BUG_REPORT_TELEGRAM_CHAT_ID` takes digits: `node -p '"1" + require("crypto").randomInt(1e14, 2e14)' \| gh secret set CMS_BUG_REPORT_TELEGRAM_CHAT_ID --env development --repo CenterCoopMedia/njpbs`. `CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP` takes a JSON object of numeric IDs to user IDs: `node -p 'const c = require("crypto"); JSON.stringify({ ["1" + c.randomInt(1e14, 2e14)]: "dev-placeholder-" + c.randomBytes(8).toString("hex") })' \| gh secret set CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP --env development --repo CenterCoopMedia/njpbs`. A changed value that is also a Functions secret then needs explicit `provision-config` |
| Each Functions secret exists in `njpbs-site-dev`. The deploy account holds `roles/secretmanager.admin` on every `deployAdmin` secret in [functions-configuration.json](../../config/functions-configuration.json), and each runtime account holds `roles/secretmanager.secretAccessor` (run 45287010195) | `functions verify-config` and `check-cms-secret-iam.mjs --pre-deploy` list every missing binding at once | `CMS_TARGET=development node scripts/component-runner.mjs functions provision-config`, with the requirements above. One binding: `gcloud secrets add-iam-policy-binding <secret> --project=njpbs-site-dev --member=serviceAccount:<FIREBASE_DEPLOY_SERVICE_ACCOUNT> --role=roles/secretmanager.admin --condition=None` |
| The dev Cloudflare deploy token (`CLOUDFLARE_API_TOKEN` in the `development` environment) has the account permission Workers R2 Storage Read, which the media lifecycle read uses | `functions verify-config`: "CLOUDFLARE_API_TOKEN cannot read the njpbs-dev-media lifecycle" | The token owner adds the permission to the existing token |
| `njpbs-dev-media` deletes `cms-media-staging/` after seven days, and no delete rule reaches `cms-media/` | `functions verify-config`, through [assert-r2-lifecycle.mjs](../../scripts/assert-r2-lifecycle.mjs) | `npx wrangler r2 bucket lifecycle add njpbs-dev-media cms-media-staging-expiry cms-media-staging/ --expire-days 7`, with a token that can edit R2 |
| `system/noBuildPostAdmission` exists in `njpbs-site-dev` with production's shape and the dev artifact bucket | The release pause (`NJPBS_RELEASE_PAUSE_ADMISSION`) | `jawn-ops njpbs release admission --target development --install` (creates only an absent record, then reads it back) |

## Event trigger IAM

[check-cms-secret-iam.mjs](../../scripts/check-cms-secret-iam.mjs) checks each
Gen 2 event trigger's declared runtime account, or the Compute default account
when none is declared. It requires an unconditional `roles/eventarc.eventReceiver`
grant on the project and `roles/run.invoker` on the project or target Cloud Run
service. A new service can have pending invocation proof before deployment,
because its Cloud Run service exists only after the Functions deploy. The
post-deploy step confirms each trigger's actual account matches the release
source, adds the missing `roles/run.invoker` binding on that one service
(additive, unconditional), and then checks the grant. The check stays because a
trigger that cannot be invoked drops its events silently. The deploy never adds
receiver grants or project-wide grants.

The grant needs `run.services.getIamPolicy` and `run.services.setIamPolicy`.
Both deploy identities (`njpbs-site` and `njpbs-site-dev`) hold the project-level
`roles/run.admin` grant, which includes both, so no extra role is needed. When
the release adds a trigger service, the pre-deploy check tests these permissions
before any mutation. If that grant is ever removed, the release stops at
preflight instead of after the Functions deploy.

## Video replacement cleanup

[template-v1.json](../../infrastructure/boardwalk-video-replacement/template-v1.json)
defines the separate `njpbs-video-version-cleanup` role. Its trust uses the same
configured Google runtime identity and audience as the media roles. Its policy
allows `s3:DeleteObjectVersion` throughout the two named source and replica video
buckets and the listed rendition/transcript prefixes. It permits version
inventory only in those derived prefixes. It grants no object read/write,
archive-bucket access, ordinary `s3:DeleteObject`, or Object Lock bypass.
The policy does not enforce age, current-file or publication-reference checks;
the application transactions enforce those limits. This shared runtime identity
can assume the cleanup role as well as the media roles.

Deployment and activation require separate authorization. The cleanup role and
replica bucket parameters default empty; cleanup defaults to dry run. An approved
release must supply `CMS_VIDEO_REPLACEMENT_CLEANUP_ROLE_ARN` and
`CMS_VIDEO_REPLACEMENT_REPLICA_BUCKET`, and set
`CMS_VIDEO_REPLACEMENT_CLEANUP_DRY_RUN` exactly to `false` for deletion. The replica
region is `us-west-2`. A template or parameter in source does not prove activation.

One previous file is available for rollback for 14 days. A further replacement
makes the older previous file eligible for cleanup sooner; failed candidates can
also become eligible immediately. Cleanup still defers while a file is current,
selected for rollback, leased, referenced by published content, or used by
unfinished work. Unresolved writers and pending S3 replication also defer it.
The cleanup owner freezes the selected version before provider deletion.

This is an exception to indefinite replica retention. The replica template keeps
ordinary CMS/media-role denial, retained buckets, no completed-version expiration
and no delete-marker propagation. Cleanup explicitly deletes the same exact
version from the replica and source after removing eligible derived copies.
R2 deletion uses its existing separate credentials. Installing this role does not
change the ordinary replica policy or authorize a cleanup run.

## Reader session history

[cms-reader-session-history.cjs](../../scripts/cms-reader-session-history.cjs)
provides the explicit `plan`, `close` and `sweep` operations. Each production run
requires a named authorized coordinator task and a matching credential JSON on
stdin. Demo targets require a loopback Firestore emulator.

Reader sessions last at most 24 hours and never renew. Retain expired UUID rows
while their reader window is open; they prevent the same IDs from opening again.
`plan` reads the retained inventory. `close` refuses a current Functions or CMS
API reader. `sweep` requires a closed window whose maximum session expiry has
passed. It deletes at most 200 UUID rows per transaction and repeats until done.
Reader windows, pair dependencies and principal quota rows remain. This operation
does not retire a preview pair or remove its data.

## Repairs and readiness

Keep each script's original apply/dry-run and credential contract. The current
workflow selects changed repair scripts from the last completed Functions source
or an explicit allowlisted request. Every current helper must exist in the
reviewed source. Repair-only runs repeat idempotently until a completed Functions
release advances that baseline; there is no one-time completion bit. Preserve
this order and each postcondition:

| Order | Script | Required postcondition before consumer |
| --- | --- | --- |
| 1 | `backfill-page-seed-media.mjs` | Referenced launch/seed media resolve through the public projection. |
| 2 | `backfill-media-thumbnails.mjs` | Existing eligible media gain valid thumbnails without changing originals. |
| 3 | `seed-media-categories.mjs` | Required managed category registry exists and validates. |
| 4 | `backfill-media-category-assignments.mjs` | Category assignments satisfy the current multi-category contract. |
| 5 | `backfill-author-profiles.mjs` | Approved mappings and public author/profile foundation exist; ambiguous bylines are reported, never guessed. |
| 6 | `seed-content-sections.mjs` | Required section registry exists for editor/save validation. |
| 7 | `backfill-byline-projections.mjs` | Byline projection matches validated public/working owner rules. |
| 8 | `backfill-media-discovery.mjs` | Eligible current media have bounded discovery projections with source provenance. |

The scripts remain under [scripts/](../../scripts/); this consolidation changes
none of them. A one-time done bit cannot protect records created later. Keep
ongoing writer invariants or the explicit idempotent repair. Partial failures
resume against current records, with transactional conflicts and omissions
retained; no blanket overwrite to get a deployment green.

Deploy rules/indexes before queries that require them and verify index READY,
including public reader ownership queries. The three Firestore release commands
omit `--force` to preserve undeclared field overrides and TTL. Retiring a policy
requires its own reviewed explicit scope. Preserve Storage rules and schema
compatibility during forward recovery; do not replace application code with incompatible
lease, tier or lifecycle authority.

## Function batches and retirement

[deploy-cms-function-batches.mjs](../../scripts/deploy-cms-function-batches.mjs)
keeps serial batches of at most ten, no-deletion manifests before every attempt,
complete intended export inventory and final scheduler/readiness smoke. Known
Cloud Build `EXPIRED` failures and exact refused Cloud Run invoker-policy reads
permit bounded retry of only the named failed exports after ten seconds, up to
two retries. Require one allowed diagnostic per failed name with no other error
class. Incomplete/unknown failure lists, other faults or missing Deploy complete confirmation stop at
that batch. Later dependent exports do not run; earlier updated exports remain
live and the release stays mixed.

Function deletion is never simply live-minus-target. The retirement table admits
only reviewed predecessor exports from the completed receipt that the current
source omits, within the approved project, region, codebase and native managed
ownership. A pending entry retains its original source/run/attempt and native
Function/Scheduler identities when a stopped run moves forward. Current source
intent controls targets. A live function in neither the current source nor the
completed receipt stays in place, and so does a function that another tool
deployed. The plan refuses when another tool or codebase owns a deploy target,
when a planned deletion has lost Firebase CLI ownership, or when
`firebase functions:delete <name>` would also reach another live function in
the `<name>-` group. Before each delete,
recheck the current receipt owner and original native identity; afterward prove
Function absence and Scheduler cleanup. Partial/404/lost-response/provider-error
paths retain the journal and lastComplete until actual readback settles them.
The current complete manifest and boundary smoke remain required.

## Receipts and recovery

Start component receipt before mutation; complete only after actual live
identity/inventory and required proofs agree. Preserve original run/attempt,
application/trusted SHA, configuration fingerprint, per-export closure and
separate preview renderer pin. A matching source without matching bindings/
parameters or a completed provider rollout cannot complete it.

An interrupted mutation retains `in_progress` and `lastComplete`. Recompute
actual identity on retry. The planner checks GitHub's latest recorded run/attempt
before resuming a stopped reservation, including failure before a plan existed.
Active or unreadable owners stay blocked; force_firebase is not an override.
Abandonment is limited to proven no-Function-mutation
and exact dead attempt; see [failed release recovery](staging-deploy-runbook.md#failed-or-interrupted-cms-release).
Renderer receipts are never abandoned. Any preview pause requires a matched
ready renderer before admission resumes. Rule/index changes may already exist
even when no Function changed; preserve that evidence separately.
