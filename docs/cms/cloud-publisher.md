# Cloud publication contract

The publisher owns public content preparation, activation and exact accepted
work recovery. A CMS save, accepted queue, uploaded candidate or process health
200 is not a public publication receipt. Read current identities through the
[common receipt view](staging-deploy-runbook.md#receipt-view).

## Source and session

Choose one reviewed full 40-character NEW SHA for publisher, public renderer
and subsequent CMS deployment. Normal source is merged and has its own passing
main-push CI and native aggregate check. Later main merges belong to the next
release. Keep trusted operator source separate from application source.
An emergency release needs the separately authorized exact-source procedure;
an old freeze date never grants permission or skips CI/compatibility.

Run credentialed commands only from an immutable, reviewed known-good checkout.
Verify canonical origin, main ancestry, exact HEAD/tree and cleanliness before
installing dependencies or supplying credentials. Prefer the live version for
compatibility only when it is independently trusted. A live receipt can match
compromised bytes. Never execute tooling taken from a live manifest or suspect
artifact; pass supported live identity inputs as data to trusted tools.

Operator wrappers run in their specified Bash/systemd credential session with
private state outside the checkout. A **private operator step** supplies the
approved credential identities, session setup and reviewed release packet
before any credentialed action below. Do not skip it or invent local credential
routing. Private host/packet details are intentionally not published here.

The producer rejects inherited credentials before launching the credential-free
build, requires production environment, and holds an exclusive `site` checkout
lock. A second producer exits 75. SIGINT/TERM stop at a safe point while the
child holds that lock; after forced termination prove no child remains before
retry. Credentials are opened only for their consumer, never in arguments,
logs, source, image layers or the offline renderer.

## Prepare while publication stays open

Use [stage-cms-publication-cloud-release.sh](../../scripts/stage-cms-publication-cloud-release.sh)
with `--prepare <operation-id> <new-commit-sha> <old-commit-sha>` in the prepared
method. Both runtime controls and active public source must be ready at OLD.
The immutable preparation records NEW, proposed generation, exact predecessor,
context and server read-time. It reserves no live generation, changes no pin,
traffic or media fence, and creates no wakeable release request.

Freeze published input at that exact cutoff within the existing 60-second
historical-read bound. Checkpoint it for later retries. A changed context or
predecessor requires a new operation ID. The loader admits `preparationId` only
with its exact `cms-{operationId}` batch and no other batch mode. Ordinary and
detached reservation modes cannot reuse each other's identity, even concurrently.

Build offline, compile the same-source renderer, check seals/compatibility and
checkpoint the complete artifact. Restore and byte-verify before marking it
prepared. A partial checkpoint or merely complete local directory is not
uploadable. The optional uploader `--preparation <operation-id>` retains one
exact uploaded provider version without taking the live lease, making it
eligible, registering media or changing traffic. Both receipts, Assets and
restored renderer must belong to that retained directory/source.

The [prepared operator](../../scripts/prepared-cms-publication-cloud-release.sh)
keeps these actions in order, each with the same operation and full NEW SHA:

| Action | Session/state | Required effect |
| --- | --- | --- |
| `--seal` | OLD ready; private credential session | Restore checkpoint; verify uploaded version/renderer, retained private preview context, candidate contract and current owners; seal receipts and media manifest. No pause on failure. |
| `--check` | Immediately before pause | Compare current predecessor/published content/authority with the seal. Draft-only saves and unrelated uploads do not change this public identity. |
| `--handover` | After pause and strict drain; before publisher replacement | Recheck freshness and bind the exact runtime update time. Drift resumes OLD and requires a fresh operation outside the pause. A later resume/re-pause invalidates handover. |
| `--promote` | Exact new publisher installed; both pins still paused at OLD | First read-only preview; separately authorized `--apply` atomically changes pins, reserves generation and creates the original request, then bounded readback. No separate manual pin edits. |

An exact promotion retry returns its stored receipt without reserving again.
The publisher activates the sealed candidate without rebuilding/restoring/
uploading/retaining preview context in the paused window. Owner, capability,
withdrawal and settlement checks remain. A 750,000-byte detached proof bound
can refuse sealing while publication stays open; use the ordinary method
instead of enlarging the bound without review.

Candidate live-blog contract must match exact NEW and version 3 before sealing.
Never seed a missing marker by hand. Once newer live-blog appearance/follow-up
data is published, a lower-contract rollback is unsupported: fix forward.
After a stale final-ready check, retain all receipts and prepare one fresh
operation outside the pause. A second published drift stops for a new operating
decision; do not loop through fresh IDs or weaken the freshness test.

## Release order

1. Verify both release/activation access checks using the publisher's own scoped
   identity, READY indexes and retained OLD. Do not pause while they fail.
2. Prepare exact committed image context with
   `node scripts/prepare-cloud-publisher.mjs <new-commit-sha>`. Build/push and
   verify the immutable registry image before pause. Finish preparation, seal,
   actual retained-candidate replay and final READY while OLD stays open.
3. Run the private operator pause block: pause both runtime phases at OLD and
   strict-drain accepted queues, claims, journals and release work. In the
   prepared method, complete guarded handover now.
4. Deploy the publisher Worker/container. Wait for complete rollout and verify
   exact image, Worker source, public bindings and named secret bindings.
   An ambiguous response requires readback of the same attempt first.
5. Promote through the prepared operator, or use the ordinary packet's guarded
   pin order then producer. Keep admission paused. The pointer may still name
   OLD between publisher replacement and activation; do not process new work.
6. Observe original request/batch deployed, idle pointer at NEW, matching
   generation, provider version, publication receipt, capabilities and exact
   Page/Post last-good proofs. Keep original lease/journal on uncertainty.
7. Resume both runtime phases only after all required receipts agree. Record
   actual pause/resume, run passive health and an approved ordinary publication.
8. Deploy CMS at that same full NEW through the coordinated workflow and run
   strict source-owned smoke plus post-CMS settlement. No later main-tip
   substitution between publisher and CMS.

Run each reviewed block in the session it names. The private packet's state
mirror runs after every block, including refusals. A failed mirror stops
progression and retains the held session. Workers without pause authority stop
before step 3. After promotion there is no rewind; recover the original attempt.

Wait for a successful quiet hourly provider check before preparation. The
regular refresh uses America/New_York, 06:00 through 22:00, including DST.
Confirm no scheduled publication or build retry is due in the window. Planning
targets READY `:40`, pause start `:48`, durable pause by `:55` never authorize a
failed guard. Missed preparation targets keep publishing open for another quiet
window. Do not insert a site-wide crawl into the short pause.

## Ordinary producer and retained attempts

The existing producer also supports `--apply <operation-id> <commit>`,
`--retry <operation-id> <new-commit-sha> <old-commit-sha>` and
`--retire <operation-id> <commit>` under its own source validation. Ordinary
apply checks exact cloud runtime, idle predecessor and inactive target source,
reserves, freezes CMS input once, fetches bounded external input/images, builds
offline and seals the release directory. It stages a journal request last;
the cloud publisher owns upload/activation. It does not itself activate.

Retain `dist/`, `artifact-inventory.json`, `prepared-worker.json`,
`public-context.json` and the complete renderer graph/seals. Immutable private
storage readback must succeed for every checkpoint before executable work is
created. Empty-disk recovery restores exact bytes. A complete saved build is
reused; an incomplete build retries from the original frozen input/cutoff.
Public settings must equal the deployed Worker's settings.

A reservation not staged blocks later strict drain. Retirement is available
only before any release request, candidate or publish queue and with the
correct owner/source and no deployment in progress. It retains reservation
and typed receipt, never reuses the batch. Once staged, the original cloud
owner must drive it terminal. Missing the 60-second freeze window needs that
retirement and a fresh operation, not a new cutoff under the old ID.

## Content and aggregate publication

Publish admission freezes the acknowledged public snapshot, source version,
operation and runtime. Working drafts stay private. Home/settings/Page/Post
owners keep distinct route and completion proofs. A successful aggregate queue
does not by itself complete Page, Post detail or Home publication.
Unpublish preserves content/snapshot and active review state, cancels a pending
schedule, and requests exact absence. Built-in Pages return to site composition;
Posts disappear. Dispatch failure can coexist with a saved withdrawal: retry
removal without undoing it. A successful queue waiting for public confirmation
does not offer another publication/removal retry.

The cloud context owner controls six aggregate outputs: listings, authors,
feed, Content API, sitemap and paired search. Source must match active CODE and
the global coordinator must be idle before preparation. Context acceptance
atomically binds exact runtime, revision/digest and operation, deferring writes
until all reads finish. Same ID with different immutable input refuses.
Reuse requires all six verified outputs. Partial cohorts keep last-good serving
and preserve preparation/task identities, reservations, attempts and backoff.

Once preparation freezes, ordinary revisions leave it running; one waiting
`followUp` tracks the latest accepted context. Same-context aliases share bounded
work and exact success/failure. Completed aliases retire without rewriting queue
receipts. Newer context supersedes only waiting work; waiting queues have no
family tasks. A withdrawal can preempt a pure aggregate cohort, but unfinished
settings/library/record consumer proof retains its original frozen operation.
Late writers are fenced by selected preparation/task, revision and renderer.
An old cutoff never grants fresh withdrawal grace.

`finalNamespaceOwner` and `namespaceOperationId` bind all six selected tasks.
They may differ from the explicitly retained original preparation. First
handoff preserves old Post tasks and last-good provenance; later Post acceptance
cannot reclaim those namespaces. Missing/foreign preparation or partial task
cohort refuses adoption, and a damaged marker cannot acquire fresh automatic
budget. Before first handoff an Assets baseline is allowed only under its
captured withdrawal watermark; after handoff missing receipts cannot fall back
to Assets. Home root/source catalogs retain their own authority.

## External inputs, output recovery and health

The single external-refresh owner seals schedule, Spotlight and media inputs as
three immutable JSON objects, verifies size/digest readback, then advances
context and enqueues aggregates transactionally. Observation timestamps alone
do not advance context. Unchanged checks retain original input provenance.
Consumers restore accepted bytes; they never refetch under an accepted revision.
Four bounded attempts per scheduled period preserve last accepted context.
Concurrent wake hints cannot start duplicate refreshes; shutdown drains it.
Accepted input is not completion of outputs or public schedule PDF.

Preparation and family checkpoints restore onto empty disk with full digest
checks. Local disk is a cache. Original claim, reservation/cutoff and attempt
budget survive retries. Restore/entry into a stage is not new durable progress.
`progressAt` advances only at the first committed input checkpoint or verified
preparation. Oldest unpublished change survives coalescing/retry as the overdue
clock. Keep the five-minute health threshold and separate 15-minute listing
notification threshold; expired leases/exhaustion cannot suppress health.

Exact output receipts bind frozen source/context, selected family/task and
immutable manifest. Page/Home completion verifies ordinary routes independently;
settings must also verify all of its consumers. Withdrawal cutoff blocks stale
last-good output; no cold/static fallback can republish removed content. Retained
public copies, assets, aliases and generation/context readback stay available
for guarded recovery without creating a second public writer.

For current failed context recovery, the direct Node loader preserves fd 3;
the `npx tsx` wrapper does not. The operator is
[retry-public-context-publication.ts](../../site/scripts/retry-public-context-publication.ts).
In the private credential session it takes `--operation-id <current-failed-id>`,
`--source-sha <active-source-sha>` and `--context-revision <current-revision>`;
Firebase credential arrives on fd 3. Default is dry-run. It refuses emulator
routing, changed source/context, a deployment lease or held family/preparation.

Authorized `--apply` creates a successor with `retryOfQueueId`, never resets
the original exhausted budget/checkpoints. It fences only its own expired
preparation; another family's claim refuses even after expiry. If the response
is lost, read `aggregateContexts/current`, then its queue, and compare retry-of,
source and context before another apply. Recover that matching successor
instead of creating another. Acceptance still requires six-output and ordinary
route proof. Preview projection recovery remains independently sealed under
the [preview contract](cloud-preview-renderer.md#public-and-editorial-context).

## Retained serializer and host retirement

Serializer admission control has exactly schema 1 and `enabled: false` when
disabled. Missing retains paired legacy behavior; malformed control refuses.
It changes no accepted queue's identity. Scheduled work keeps requested time
and defers. Only server operators may write it.

Before disabling/stopping an old owner, verify cloud withdrawal and all six
dependent outputs, drain accepted work, then disable admission and stop it.
Development precedes production. Existing accepted reservations keep original
recovery; a stopped owner never receives a new replacement queue. The
[control writer](../../scripts/serializer-publishing-control.mjs) defaults to
read, with `--project` and separately authorized `--apply`, approved account on
stdin. Runtime pin names alone cannot prove a host is still a serving owner.

The private operator step for host retirement inventories services/timers,
locks, owner-only journals, queues, retained owners/outputs/preparations/batches
and the idle pointer. Every original claim must finish or receive an exact
terminal receipt before masking services or deleting local credential/state
files. Unknown reads, retained work or a missing journal without terminal proof
stop retirement. Public source cannot establish that private host cleanup ran.
Never restart a retired owner as a recovery shortcut.

| Retained recovery | Exact eligibility and order |
| --- | --- |
| Unclaimed no-change baseline | Exact pending queue with no claim/artifact/candidate/media/deploy evidence, matching owner journal and lock; idle media-disabled predecessor. Cancel queue and audit, then clear only its exact journal token and verify receipt. |
| Claimed baseline | Exact publishing claim, generation, reservation, nanosecond cutoff and optional exact inclusion; no candidate/media/verification/lease/deploy. Cancel queue and batch without changing counters/predecessor, then exact journal cleanup. |
| Claimed content | Exact reviewed descendant operator source, queue/batch/source/owner/journal and idle reserved-against predecessor; no candidate/media/activation. Cancel queue/batch and release only matching revision pointers; preserve snapshots and pending removal/publication. |
| Never-public withdrawal | Fresh exact record/source, canceled original-publication queue and receipt, unchanged idle predecessor and last reservation; no pending work or successful/unconfirmed original publication in retained history. Clear only three pending/public-version fields, retain snapshot and write one typed receipt/audit. |

These operations require the private reviewed transient-service session, exact
CLI arguments and shared lock; both primary/fallback owners must be disabled
and inactive before running them. Credential fd 3 and lock fd 5 remain scoped
to the consumer. Tokens stay only in the owner journal, never arguments or
receipts. Database commit precedes exact token cleanup. Exact retries finish
cleanup/return the retained receipt; conflicting identities refuse.

An absent public-version marker alone cannot prove content never appeared.
Possible unconfirmed exposure requires verified withdrawal, not never-public
settlement. Later reservation/deployment invalidates first settlement
eligibility; investigate history instead of modifying expectations. Retained
receipt validators and cloud recovery do not authorize a legacy owner restart.

## Retained command arguments

These existing wrappers run only inside their private reviewed credential/lock
session, after the eligibility checks above. Placeholders denote freshly verified
identities, not defaults. Preserve exact argument order:

| Boundary | Command after the private session is established |
| --- | --- |
| Unclaimed baseline | `scripts/cancel-unclaimed-cms-publication-baseline.sh --apply <operator-commit> <queue-id> <queue-commit> <serializer-id>` |
| Claimed baseline | `scripts/cancel-claimed-cms-publication-baseline.sh --apply <operator-commit> <queue-id> <generation> <queue-commit> <serializer-id>` |
| Claimed content | `scripts/cancel-claimed-cms-publication-content.sh --apply <operator-commit> <queue-id> <batch-id> <serializer-id> <queue-commit> <absolute-journal-path>` |
| Never-public withdrawal | `scripts/settle-unpublished-cms-content-withdrawal.sh --apply <operator-commit> <collection> <record-id> <published-source-version> <cancelled-queue-id> <active-generation> <active-batch-id>` |
| Retained content baseline | `bash scripts/seed-public-content-baseline.sh --target production --dist <absolute-retained-dist> --prepared <absolute-retained-prepared-worker.json>` |
| Context dry-run | `node --import "file://$PWD/site/node_modules/tsx/dist/loader.mjs" site/scripts/retry-public-context-publication.ts --operation-id <current-failed-id> --source-sha <active-source-sha> --context-revision <current-revision>` with credential fd 3 |

Baseline seeding verifies exact complete retained bytes/source and immutable
readback; it grants no deployment/route switch or withdrawal exception.
Provider wake preparation remains `node scripts/prepare-cloud-publication-wake.mjs production true`
before explicit deployment of `onNoBuildCloudState`, `onNoBuildCloudCandidate`
and `onNoBuildCloudRelease`. Disabling uses the same command with `false` before
explicit retirement of exactly those three exports in their approved region.
These are separate reviewed provider actions, not ordinary content-edit steps.
Keep minute recovery and actual trigger inventory/readback; a source flag cannot
establish provider wake installation or retirement.

## Final proof

After CMS, collect two native settlement samples and strict search separately
from workflow success. FIRST requires the current-context aggregate's success;
last-good/older success cannot substitute. Start SECOND 60 seconds after FIRST,
keep receipts 60–180 seconds apart and retain both full collectors. Use a quiet
provider window; a refused source/context guard needs a named fresh-pair
continuation, not an automatic loop or expired sample. Then strict search and
remaining smoke follow in order.

Record ordinary-route content/removal, aliases, media, fallback, private Preview
and supported old Admin tabs with their actual limits. Local fixtures, emitted
builds, provider deployment completion and staff interaction receipts prove
different boundaries. Report missing evidence explicitly.
