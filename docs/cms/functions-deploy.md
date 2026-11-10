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

The committed module graph may select changed exports and the complete set of
preview-pin/control readers. Keep conservative fallback for configuration,
package/assets/export inventory, trusted execution, loader/generated wrappers,
unresolved or dynamic edges. New graph formats need their first complete release;
do not manufacture baseline metadata. Rules/indexes and Storage rules retain
their own readiness checks. Repairs retain consumer order, scans and postconditions
while their selection stays independent of a Functions upload.

Run preflight before mutation: canonical source/ref/Environment, exact-main CI,
App Check registration, required declared parameters, scoped IAM and provider
dependencies. Noninteractive deployment needs all declared nonsecret parameters
in generated dotenv. Unknown keys, absent required values or secret-agreement
failure stop. Provisioning and release remain distinct authorizations.

## Configuration and provisioning

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
deliberately refuse verification. **Real census NOT DONE:** before the first
public release, a separately authorized operator task must census actual native
resources, complete any needed setup, prove the real canary and serving bindings,
and commit the resulting references. Local fake-provider tests prove the method;
they do not prove a live configuration or authorize provider access. Rotation
requires that explicit procedure again; no value digest or second ledger exists.

The trusted source gate requires selected IAM and retention validators to match
the trusted workflow's committed bytes. A stale validator refuses before selected
code or credentials run; release fixes forward. SDK and gcloud use the same
verified credential file when supplied, without enrolling a gcloud account.

## Event trigger IAM

[check-cms-secret-iam.mjs](../../scripts/check-cms-secret-iam.mjs) checks each
Gen 2 event trigger's declared runtime account, or the Compute default account
when none is declared. It requires an unconditional `roles/eventarc.eventReceiver`
grant on the project and `roles/run.invoker` on the project or target Cloud Run
service. Missing grants require separate authorization. The checker does not add
them. A new service can have pending invocation proof before deployment;
post-deploy checks must confirm its actual trigger account and invocation grant.

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
intent controls targets. Unknown managed live names refuse. Before each delete,
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
