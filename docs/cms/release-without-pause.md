# Release-pair contract

Release pairs prepare and qualify a complete NEW code/content environment while
OLD continues publishing, then make one guarded selection with a retained OLD
return path. Source availability is not installation, adoption or live proof.
Read actual selectors, provider receipts and installed readers before choosing
any method. The [existing coordinated release](staging-deploy-runbook.md) and
[publisher pause/recovery](cloud-publisher.md) remain authoritative for schema
one. A routine component release cannot implicitly enroll or select a pair.

This contract consolidates pair design, byte ownership, installation, readers,
rehearsal, qualification and recovery. It changes no pair implementation,
capability, test, default flag or production state. Any provider/SDK operation
below requires its own named authorization.

## Invariants and identities

Keep code generation, release epoch, editorial source version, original
operation generation, public context revision and global log sequence distinct.
One schema-two selector owns selection; projected legacy fields are not another
authority. Do not add unknown fields to strict schema-one documents or use a
schema-one writer on a converted selector.

| Identity | Binds |
| --- | --- |
| Immutable public pair | Incarnation, source, publisher application/version/image/journal, public slot/version, compiled graph, configuration/environment, code assets, deployed reader and capability digests |
| Preview pair | Exact renderer source/version/image, serializer/journal, installed reader contracts and its distinct incarnation |
| Selector | Monotonic epoch/code generation, selected pair/version/content head, admitted contract, recovery pair, prior selector digest, original switch/proof |
| Accepted change | Original operation/source version/snapshot, transactional sequence, owner/pair, dependency/withdrawal changes and durable outbox |
| H | Actual immutable historical input root, full inventory/digests, source census/CODE provenance, render time and contiguous cursor |
| G | Original completed claim's immutable rendered view, manifest, complete closed output roster and staged proof |
| Qualification | Exact pair, live head/context/source/reader seals, complete independently read bytes and retained evidence; no selection authority |

Semantic pair IDs include slot incarnation; physical keys use the shared
canonical digest helper. Never handwrite REST paths from a colon-bearing ID.
Registration creates candidate control and separate journal, not active/retained
authority. Exact retries preserve immutable identity; changed source/version/
image/reader/capability refuses. Resource collisions are checked across both
publisher and slot roles and all retained/pending registrations.

The closed pair resource domain is separate from legacy public, publisher,
CMS and preview resources. Registry/upload index is bounded to eight outstanding
incarnations. It supplies no general retirement/slot-reuse escape. Do not edit
records to bypass capacity. Retiring accepted-work/assets/media/requests requires
their actual owner proof first.

## Public checkout font preparation

In a networked Node.js 22 checkout preparation session on macOS or Linux, run
this block from the public repository root before entering the protected WSL
first-install session. It downloads the five licensed fonts into the ignored
`site/public/brand/fonts/` directory and verifies the checked-in SHA-256 pins.
Do this before enabling offline/frozen mode or mounting the checkout read-only;
the build refuses missing or corrupt fonts and never fetches while offline.
Keep these verified files in the target checkout used by first-install builds.
Publisher images perform the same preparation in their Dockerfiles.

```sh
node site/scripts/prepare-public-fonts.mjs
```

The private `njpbs-site` repository keeps its tracked fonts and needs no added
preparation. These steps apply to the public source split.

## Source, session and credential boundary

All attended first-install blocks run one at a time in their protected, retained
**WSL Bash** session with Node.js 22, exact reviewed clean checkout/tree and installed
root/site lockfiles. The selected checkout and dependencies must be protected
from concurrent preparers; worker-owned `node_modules` is not a trusted operator
runtime. This trusts the operator host/UID; it does not isolate hostile same-UID
code. Verify source before repository modules or credentials load.

A **private operator step** supplies the exact packet, independent byte digest,
operation IDs, credential identity/routing, installed resource references,
session/host selection and outside-checkout evidence paths at each credentialed
boundary. Those packets and routes stay private and unlinked here. Stop when
that step is missing; never skip it or manufacture a replacement SDK call.

Keep shell tracing off, private umask, exclusive evidence creation and no
credential/ADC/emulator inheritance in real operators. Node entrypoints perform
built-in-only source/packet checks before loading SDK/runtime code. Packet
identity fields are references/public metadata, never credential values. Fetch
each credential only for the consuming process and fd; never in argv, receipts,
shell logs, source or build children. Ordinary `npx tsx` wrappers cannot be
assumed to preserve inherited fds: use the owner's direct Node entry/loader.

Local proof uses a dedicated `demo-*` project, loopback emulator and unique
assigned ports for Firestore and all auxiliary services. Real-project operators
refuse emulator/ADC fallback before consuming credentials. A demo fixture is
never installed-provider evidence. Keep at least 6 GiB available for the
documented image/rehearsal session, without generating synthetic host load.

## Private publisher installation

Offline resource planning/configuration does not build, upload, deploy or read
credentials. Prepare exact actual bundle/configuration bytes and immutable image
before sealing an upload plan. Provider-assigned UUIDs are filled from actual
upload readback, not predicted or persisted as process-local placeholders.

Schema-two upload plans omit only publisher UUID for an assigned slot.
Fresh schema-three plans also omit slot UUID/reader receipt and bind the
original slot-install operation and reader origin. First upload publisher,
install slots/ingress from that real UUID, create immutable complete-pair seal,
register the exact pair, then deploy publisher. The original upload plan never
changes; both actual UUIDs and original ledger receipts bind its completion.

Every provider effect has a durable one-attempt grant: identity, version,
deployment, container and optional sealed trigger. Only the creating transaction
permits a write. Upload reservation alone does not permit all effects. Version
requires verified identity; deployment requires upload seal, registered pair
and rollout reservation; container requires verified deployment; trigger requires
its explicit full-continuation plan and verified container. Disabled billing,
overlapping resources/journals or capacity refuses before a new grant.

Complete, reserved and uncertain existing attempts permit readback only. Lost
responses never grant a repeated POST, fresh UUID or replacement operation.
Read actual independent provider inventory, exact bytes/config/image,
deployment IDs and 100% version selection. A completed upload proves no rollout,
startup, reader installation or public result. Keep original OLD untouched.
Wrangler is for offline bundling here; the controlled writer avoids automatic
provider mutation retries.

The distinct pair Worker has no public routes/workers.dev/preview URLs and
public fetch is always 404. It compares actual version metadata with registry
before container startup. `PairPublicationWake` exposes private preflight/wake/
staging recovery under exact pair/source/environment/journal identity. Read-only
reader calls do not drain publication. Configuration cannot copy legacy
serializer, namespace, activation credential or shared withdrawal owners.

The pair container verifies exact source, compiled graph and sandbox before
ready. `PAIR_EXECUTOR_READY` alone cannot manufacture installed readiness.
Disabled executor returns before credentials, queries or compute. The billing
guard also gates explicit startup; retired/unavailable lifecycle authority
cannot leave warm health green. Wake hints are bounded advisory reads, not
claims or publication proof; transactional owners recheck everything.

## Original work, H and G

Accepted work is created with its exact original admission, queue and durable
outbox in the source transaction. H capture follows that committed event and
must complete immutable storage readback before enqueue. Selected-pair checks
govern new work. After selection moves, only the exact retained durable
admission/queue/pending/event exception can authorize its original pair to
capture/enqueue/claim/retry/finish. Qualification/recovery work cannot turn
itself into accepted editorial work or terminal public success.

Task identity seals pair/source/version, kind, original operation, snapshot,
source version, context sequence and input-root digest. Full identity digest
is the task ID. Original snapshot seal stays separate from H root. Journals,
receipts and output prefixes are pair-scoped; claim digest in output prefix
fences expired executors from replacement attempts.

H includes ordinary and aggregate render plans derived by the source owner from
the same baseline/census/contiguous changes, source reader provenance and frozen
render instant. No mutable latest CMS, provider refetch or inferred dependency
fills a missing historical member. Verify all input files and every original
registered owner; a partial inventory refuses the whole task. Bounds/headroom
fail explicitly rather than truncating a history or claiming subset success.

The source-sealed code pack covers compiled renderer, client/static/fallback
files, source-input census bytes and all aggregate families. Its
`codeAssetManifestDigest`, complete renderer graph and original global baseline
must agree. First-install source input is captured after actual atomic enrollment,
before image/code-pack/upload sealing. Ordinary post-enrollment writers retain
their own exact serializer and newline/canonical-byte contract.

Executor opens actual H, verified graph and selected frozen assets, then runs
existing projectors/templates in the network-free Bubblewrap sandbox. No SDK,
provider credential or claim token enters the child. Missing resource refuses;
there is no latest/provider fallback or implicit render-time refresh. Discard
unused child stdout/stderr; keep actual byte/receipt checks. Cross-source target
receipts retain original source/CODE/owner identities rather than retagging them.

Closed composite output distinguishes ordinary/member routes, aggregate
namespaces, feed/search, catalog images and approved auxiliary members, including
author pages. Every accepted member needs its own complete owner proof; extra
aggregate output cannot substitute. Frozen public author census, Post/media/
chrome/navigation inputs use the shared projector; no private profiles or name
joins. Unknown auxiliary/static takeover refuses.

Write immutable private bodies/pages/manifests and verify storage metadata,
size and actual SHA-256 readback before staged receipt. Exact existing bytes
may be reused; different bytes under the same identity refuse. No public head
or success comes from partial storage. Storage failures leave original claims
and receipts for recovery. Existing bounds are in the
[view owner](../../site/scripts/public-release-pair-view-storage.ts).

Renewable execution deadlines release stopped/hung attempts without trusting
the child. Stale bytes remain in the old claim prefix. Atomic staging outbox
recovers completion-before-staging using the original receipt, without another
render/claim. Transport failure defers without consuming retry budget; byte/
receipt failure has bounded retries and quarantines original evidence after
three failures. Quarantine cannot keep waking compute; explicit private repair
reopens exact original bytes/receipt rather than creating fresh work.

## Replay and complete coverage

Global baseline receipt digest differs from its log anchor; neither hashes
itself. Pair replay baseline is create-only and binds complete actual census,
original input/completed claim/G, code pack, cursor and initial selections.
Different baselines cannot replace the same pair's cursor.

Replay consumes every contiguous log page and every member, dependencies,
aliases/withdrawals and original owner. Missing history/position/body refuses;
large event IDs or partial pages never prove coverage. Pending render leaves
cursor unchanged. Replay requests only qualification/recovery work. Recheck
completed/staged ownership after byte reads. Withdrawals require explicit empty
410; redirects must equal frozen destinations.

Content and code overlays retain separate immutable selections. Only allowed
dynamic routes may replace baseline ownership. `/pagefind/` and numbered
`/api/v1/content/` have sealed complete-replacement namespace semantics. Feed
index `/api/v1/content.json` is an exact path from that same producing view and
must enumerate exactly all positive contiguous pages, including zero-page case.
`/feeds/news.xml` stays exact-path. Every prior name absent at selected cursor,
even one added/removed between baseline and head, needs typed namespace absence.
Missing objects/descriptors, timeouts or transport errors cannot prove absence.

Catalog image additions are an exact-path exception bound to original H/G
catalog, source/reader seals and NEW baseline. New paths must match replay;
existing baseline paths require identical bytes/size/MIME. Nonimage/compiled
code takeover refuses. Every member needs actual byte proof, even identical
copies in original G. A namespace retains its producing cursor separately from
witness head; later entries prove replacement or unchanged complete sealed
inputs. A dynamic flag alone supplies no authority.

The durable replay witness/capsule binds exact baseline, contiguous history,
all selections, head view and content/code digests. Open full immutable
inventories outside transactions. The late guard inside the real writer's
transaction must also compare actual current log head; a retained-witness guard
that tolerates later growth cannot establish exact-head equality.

## Private HTTP reader and qualification

Private reader is authenticated HTTPS POST `/private-pair-reader/v2/read` on
its exact sealed origin. Loopback HTTP exists only for demo-emulator tests.
Signed Access admission belongs to the slot; strip credential headers before
`PAIR_READER` forwards through the private publisher entrypoint. Separate
operator Access application/token cannot substitute for reader identity.
Default publisher fetch remains 404; ordinary viewer headers choose no pair.

Installation seals actual environment/service/Worker/source/contract/origin,
publisher image/readback and every required capability. Actual version UUID,
verified rollout and immutable registered pair precede atomic seal write.
Metadata-shaped receipts, caller-supplied seals or config flags cannot establish
installation. Missing/revoked/replaced/mismatched live seal refuses.

Reader request binds full pair, original task/claim, settled manifest/size,
fresh nonce and sorted unique paths. Check original completed/staged owner before
storage and after all byte reads, including lifecycle/billing/seal authority.
No current-input read, render, claim, selector write or staff acknowledgement.
Verify actual pages/body bytes/metadata, headers/status, empty redirect/withdrawal
bodies and catalog authority. Namespace absence is a separate typed result
proved from complete settled inventory, never an error response interpreted as
404. Lazy member reads are not `verifyAll()`.

| Reader/qualification bound | Limit |
| --- | --- |
| Private batch | 32 sorted unique paths; 16 MiB logical bodies |
| Encoded request/reply | 64 KiB / 24 MiB |
| Actual private request, credential acquisition and streaming | Shared 3-second deadline |
| Qualification attempt | 10 minutes including cancellation |
| Owners per source collection | 4,096 |
| Route census/selected lane | 100,000 paths |
| Full source census | 100-document pages, at most 20,000 reads |
| Final SDK transaction | 500 actual document results, all caller/guard reads |
| Retained evidence | 200,000 results; 256/page, 512 KiB/page, 8 MiB root |

Actual remote client has no in-process/local decision fallback. It verifies
nonce/request digest, count/order, allowlisted headers, canonical base64,
decoded length and actual SHA-256. Redirect/timeout/cancellation refuses.
A digest-shaped response header alone is not byte proof.

Qualification starts from real current replay witness/log head and separately
checks context. Verify complete code pack and every source-owned route, alias,
retained withdrawal, record index, composite/namespace/catalog/auxiliary member.
Missing/orphan/conflicting source ownership or different version refuses even
if path/status match. Independently open original settled G and compare remote
actual bytes/status/headers/size, not just remote digest consistency.

Recheck live full source census, log/context, installed readers/capabilities,
deployment/admission/runtime and original owners before and after private I/O.
Retain create-only private proof pages after full byte readback, then create
only the bounded qualification receipt in the final transaction. Crashed orphan
objects cannot create success. Exact retry preserves original time; >60-second
or future proof refuses. Create a fresh qualification against current evidence,
never refresh an old timestamp.

All switch-owned reads and every pair guard share the original opaque
`trackQualificationTransactionReads` tracker/transaction. Derive allowance from
actual SDK results; copied/deserialized hints cannot weaken it. Full census
repeats transactionally when it fits. Otherwise the explicitly recorded split
uses fresh complete outside census plus late log/owned-route/reader/original-
owner guards; it is not atomic validation of every source document. Public
author roster comparison still runs transactionally. A failed full check cannot
fall back to split. Assert final cumulative budget before selection writes.
No R2, H or HTTP I/O belongs inside that transaction.

## Per-publication activation and terminal ownership

Ordinary publication uses its own opaque source/reader/capability preparation
and late guard, not full candidate HTTP requalification. Read original H/source,
complete current census and installed seals; no receipt or full-body HTTP work
occurs at preparation. Its purpose cannot satisfy candidate complete-input
qualification. Late guard requires same in-process object/tracker, fresh <=60s
source/seals and original ownership immediately before target-head CAS.

[content activation](../../site/scripts/public-release-pair-content-activation.ts)
binds original admission, source/snapshot/view/completed claim and exact replay
witness. Reserved switch, stale cursor, changed owner/head, missing namespace
or seal refuses before write. Advance only that pair's content head and media
manifest reference; if selected, project that same head into selector. Code
generation/epoch/pins, other pair and original pending/terminal state stay fixed.
Same already-included head can gain original-operation receipt; never rewind.

`activationPending` handoff is atomic with deleting original staging, after
actual completion/composite proof. Lost response leaves either staging or exact
continuation, not neither. Recovery/qualification work without original admission
gets no publication capability. Quarantine repair retains original intent.
The continuation cannot acknowledge itself; original immutable activation
receipt must exist before deleting it.

Recover due activations after staging on the existing wake, rechecking lifecycle/
billing. Missing predecessor or stale current snapshot defers without consuming
failure. Failed/quarantined predecessor stops automatic wake. Other failures
quarantine after three; explicit repair reopens original complete composite,
never another renderer task or claim. Quarantine cannot keep compute alive.

Activation receipt is not canonical public proof or terminal success. Original
admission owner separately proves current ordinary serving and original inclusion/
withdrawal, then settles original queue/pending/audit. Recovery-side completion
cannot clear selected work. Already-terminal recovery requires actual original
terminal receipt and absent pending marker; supersession also needs linked later
successful fact, not a serialized success flag.

## One switch and guarded OLD return

Prepare/prove NEW while OLD remains ready and accepted changes continue through
durable log/outbox. Preparation cannot advance generation/media fence. A
separate switch-attempt writer lease serializes release changes without making
the active pointer deploying or pausing admission. One final CAS validates
fresh OLD/NEW qualification, current selector/head/context/source/readers,
in-flight inclusion, original owner/terminal obligations, capability/media and
actual provider versions; then allocates epoch/code generation and selects
the exact head/pair with retained recovery. No flag alone grants authority.

After lost response read original switch receipt and actual authority before
any action. Before commit keep original selection; after commit retain committed
selection even if Admin upload fails/cancels. Do not automatically rewind or
write a compensating legacy pointer. Prior Admin must remain usable through
versioned readers. A guarded return to OLD is a separately named operation tied
to the original forward receipt, fresh current OLD qualification and current
inclusion/withdrawal/media/reader proof. Replaying a stale baseline is not return.

Production packet's `direction` is `new` or `old`; OLD return retains original
OLD-then-NEW reader order and names `forwardOperationId`. Exact observations
bind operation/path/source/snapshot and status 200/308/410. Current-content
readback/recovery refresh cannot rewrite original acceptance or claim a later
operation succeeded. A missing bound owner adapter is STOP.

OLD remains able to consume current accepted changes until return obligations
expire. Retain old code assets/media, both heads, accepted work, supported saved
Preview/Admin sessions and reader contracts. No provider resource or registry
slot retirement merely because a new selector exists.

The production switch CLI is
`node scripts/switch-production-public-release.mjs --packet <absolute-file> --packet-digest <byte-sha256>`.
No final flag is offline plan; explicit modes are `--apply`, `--readback`,
`--observe` and `--capture-recovery`. Launch in protected held Bash through
`env -i PATH="$PATH" HOME="$HOME" node ...`, after private prelaunch, with a new
private result file. SDK fd 3 is required for credentialed modes; R2 fd 4 for
apply/observe/capture; OLD/NEW reader Access fd 5/6 for apply; original operator
Access fd 7 for observe/capture; Cloudflare read fd 8 for NEW apply only.
Readback uses only fd 3. Observe/capture storage is read-only; native capture
owns its separate advisory write. No arbitrary source/content/staff or routing
object write is granted by these streams.

NEW apply first reads original complete deployed ingress adoption, actual apex
route, original slots and recovery-capture enablement. It freshly qualifies
both current heads before preparing/applying in one process. Readback reports
historical committed outcome separately from fresh current selection. Attempt
without receipt is unconfirmed and exits without requalifying/applying/abandoning.
Only preparation refusal before an attempt exists can use a reviewed fresh
qualification ID under that same switch operation. Observation proves actual
original operation/body/current authority but creates no inclusion/terminal
receipt and clears no pending row. Capture refresh is advisory, not an invented
prerequisite to first NEW switch.

## Public routing, rate controls and cost

Stable ingress uses fixed installed OLD/NEW bindings and actual provider version.
Untrusted headers cannot choose a slot, proof budget or alternate implementation.
Routing selector cache is at most five seconds; publication/withdrawal decisions
are uncached. One monotonic three-second authority budget includes admission,
cache refresh, slot work, content I/O and all ownership rechecks. Never reset it
after a limiter, refresh or reselection. Late success cannot start new work.

`PUBLIC_RELEASE_RATE_CONTROLS_ENABLED=true` is prerequisite for all paired
selector/decision consumers, including private proofs and measurements, when
that CMS implementation is installed. Unset refuses paired calls; it is no
bypass. Use the existing `CmsRateLimiter`, not another namespace/isolate counter.
IP admission precedes selector/slot/R2 work; verified retained assets avoid live
authority quota. Other requests consume global quota immediately before live
authority. Refused global/RPC quota can attempt only current-withdrawal-verified
storage recovery under the original deadline; otherwise 503.

| Token bucket | Burst | Refill/second |
| --- | ---: | ---: |
| Live authority | 400 | 200 |
| Viewer IP/network | 60 | 2 |
| Selector/decision RPC | 2,400 | 1,200 |
| Private proof | 400 | 200 |

Only trusted platform metadata/connecting IP supplies viewer identity. Ignore
forwarded/custom proof headers. Hash before storage/naming/logging; IPv6 shares
/64 and mapped IPv6 shares IPv4 budget. Per-IP exhaustion is empty uncached 429
with bounded Retry-After; malformed/failed/stalled admission is 503. All GET,
HEAD and assets share it. Distributed traffic can exhaust global quota; there
is no unlimited-availability claim or permission to disable the limiter.

The immutable rate-control evidence owner defaults to offline plan. Record
actual exact-source full independent review, compiled bytes/config, disabled
original ingress readback, actual CMS deployed enabled flags and real limiter
binding before declaring proposed enable eligible. No packet-supplied success
or copied hash can replace observations. A disabled target's receipt cannot
claim enabled traffic was observed. First enable also needs the explicit
operating decision for global ceiling/overload behavior.

Cost acceptance uses actual selector reads/isolate churn/latency and incremental
provider cost. Preserve the $50/month selector-routing ceiling and <=10-second
continuous click-to-live acceptance; historical models or a fixture sample are
not installed evidence. Measurement is separately authorized on development,
default off, isolated from public publication authority. Router/direct lanes use
the actual module instance/selector, alternating warm order; no invented cold
start from a warm cache. Retain sampling/units/windows and provider cost limits.
Do not generate artificial CPU/memory load on fleet hosts to measure it.

## CMS reader bridge and retained sessions

`cmsReaderV1`, `cmsReaderV2` and `cmsReadPairCurrentCodeV2` mounts are explicit
and default off. Routine dev deployment installs inert exports with API routes
unavailable; production installation is separately opt-in. Match actual deployed
Functions/API reader cohort, versioned envelopes, fixed private target, enabled
configuration and exact release receipts. Never expose CODE as a bare browser
API or drop the legacy exact-source gate without actual installed compatibility.

Retained request/reply seals bind original reader/source/request/body/status and
supported session expiry. OLD source and NEW consumer stay distinct. Capture
from real immutable CODE owner/native reply, not reconstructed latest data.
Complete retained output before sealing installation. Stage A legacy install,
public conversion at OLD, then Stage B schema-two replay remain ordered. Actual
deployed old/new readers must replay supported Post/Page/chrome/settings/record
and saved-preview contracts, not only fixture DTOs.

The development reader manifest and production rollback-family manifest remain
separate. Whole/partial-family checks refuse incomplete exports. Installation
requires fresh reader receipt/probe and exact bytes. Already started/uncertain
bridge attempts must settle or receive their explicit original issuance fence
before session-retirement proof; an old success-shaped catalog is insufficient.

Enabled-reader workflow inputs are `install_reader_bridge=true`, the original
`reader_operation_id` and the exact `reader_install_authorization` supplied by
the private operator step; no historical approval phrase is published here.
Development additionally keeps `CMS_DEV_PUBLISH_ENABLED=false` throughout and
selects its separately authorized `release_preview_renderer` choice. Production
requires `force_firebase=true`, first workflow attempt and exact equality of
current trusted workflow, checkout and `deploy_ref` SHAs; ordinary ancestor-NEW
admission does not apply to this opt-in installation. Default dispatch leaves
mounts off. Check both actor identities, configured repository/environment and
complete target tuple before SDK/provider mutation.

Start original native component/candidate receipts before their respective
deployments; Functions precedes API. Verify ACTIVE complete reader/consumer
Functions cohort, actual source/flags/candidate bindings and API one-version
100% readback, then verify candidates, complete native receipts and commit
installed-reader evidence with fresh provider observations. Retain the sanitized
deployment artifact for Stage A, not as Stage A/B bridge or fresh OLD-control
preparation. A later routine dev deploy returns mounts off; it is not a reader
refresh. Failed/interrupted installation preserves original run/attempt/receipts
and refuses automatic rerun or a new ID to bypass uncertainty. A complete
component without matching reader compatibility is a refusal, not installed proof.

The retained command sequence in protected Bash with exact private source/
packet/credential setup stays:

| Order | Native command |
| --- | --- |
| Capture | `node scripts/capture-cms-reader-reply-sources.mjs njpbs-site-dev "$READER_SOURCE_PLAN"` with matching account stdin |
| Build adapter | `node scripts/build-cms-reader-install-adapter.mjs "$READER_ADAPTER_CONFIG" "$READER_ADAPTER_BUNDLE"` |
| Prepare A | `node scripts/prepare-cms-reader-bridge-request.mjs njpbs-site-dev "$READER_OPERATION_A" legacy-first-install "$READER_ADAPTER_BUNDLE" "$READER_ADAPTER_SHA256" "$READER_REQUEST_A"` with matching account stdin |
| Prove A | `node scripts/install-cms-reader-bridge.mjs prove njpbs-site-dev "$READER_REQUEST_A" "$READER_ADAPTER_BUNDLE" "$READER_ADAPTER_SHA256"` |
| Install A | Same command with `install` in place of `prove`; retain original request on uncertainty |
| Preview bootstrap | `node scripts/bootstrap-cms-preview-pair.cjs plan njpbs-site-dev "$PREVIEW_BOOTSTRAP_IDENTITY" "$CONSUMER_ADAPTER_BUNDLE" "$CONSUMER_ADAPTER_SHA256"` |

Prove uses provider/Google/staff-JWT/edge-secret fds 4/12/13/14; install and
preview-bootstrap plan use provider/Google fds 4/12. Describe only opened pipes
with `node scripts/describe-cms-reader-credential-pipes.mjs 4 12 13 14` or
`4 12`, passing its output as `CMS_READER_CREDENTIAL_PIPES`; matching SDK account
stays stdin. Do not use this development layout for production wrappers. The
private step supplies streams, original outputs and Stage B request.

## Saved preview pairs and editorial context

A private preview application is a distinct standby, not a replacement of OLD.
Choose executor/readiness flags before immutable version upload; provider UUID
comes from actual metadata. Candidate health can report installed runtime but
cannot process selected work or switch preview. Keep public URLs/routes off,
original accepted rows/journals untouched and source/capability/reader seals exact.

First preview bootstrap converts paused schema one to ready schema two at the
current OLD renderer, with NEW retained. It does not select NEW, change public
authority, resume public producers or install Admin. Existing accepted work
must drain under its original source/token first. Private preview provider,
installed consumers, compatible workflow and admission fence must actually
exist and pass, not merely have a source signature.

The private preview CLI is `node --import ./site/node_modules/tsx/dist/loader.mjs scripts/install-private-preview-pair.mjs`
followed by `plan`, `apply`, `qualify` or `receipt` and the reviewed packet path.
Apply installs original resources; qualify creates only a separately named fresh
health proof against those same resources; receipt reads originals. Provider
token is stdin, exact narrow preview SDK account fd 3, preview R2 fd 4 and edge
secret fd 5; development additionally uses Access ID/secret fds 6/7. Production
never reads those dev streams. Receipt needs only fd 3. Broad deploy account,
ADC and real-project emulator routing refuse.

Bind OLD/NEW offline with `node scripts/bind-private-preview-packets.mjs plan "$BINDING"`,
then after separately authorized installation/qualification and original receipt
readback use `node scripts/bind-private-preview-packets.mjs receipt "$BINDING" "$OLD_READBACK" "$NEW_READBACK"`.
The exact input packet bytes/multipart/resource/qualification identities must
agree; swapped roles or shared resources refuse. Binding retains original times
and grants no fresh provider/readiness/session authority. Legacy release
interruption can require a new qualification request/current-runtime digest,
but keeps original resource operation and completed effects without resending.

Paired previews need current editorial output as well as retained CODE frame.
The executor's optional side write starts only after actual view/replay proof,
does not hold publication/head/selection, and affects preview freezing only.
It reopens original H independently, captures actual rendered Home bytes from
G, retains original CODE/source/target identities and never fetches latest CMS.
Create-only chunks <=400 KiB, body <=20 MiB and exact byte/hash manifest/index
must finish before a view can supply editorial context. Partial output grants
no authority; a matching cursor on another physical view is insufficient.

One active side write and newest pending view bound memory. Known transient
failures have at most three attempts with 250/500ms backoff; newer pending view
supersedes retry. Permanent failure gets one attempt; process exit can interrupt
retention without failing publication. Repair needs original H and retained
rendered Home from G; H alone cannot recreate it. Never retag source/CODE/Home
as the target pair.

The private `current-editorial-v2`/reference bridge verifies selected public
pair, preview candidate/retained pair, actual pair-local head, global cursor and
current reader cohort before/after immutable chunk reads. For composed heads,
open the real replay witness and physical head view; global copied head cannot
substitute. Missing/pending side output or observed head/cohort movement is
retryable pending; corruption/invalid owner is permanent refusal. Stale selector
digest is 409 requiring fresh authority/transport. Timeouts/abort use pending;
other errors/redirects refuse without printing causes. No CODE-only fallback.

Recurring preview replacement requires closing recovery issuance, waiting
original expiries and queue/journal drain, then fresh candidate/provider/reader/
replay proof in the selection transaction. Current selected sessions continue
during drain. Closure inventories every installed identity, completed/uncertain
probe and historical session window, captures original maximum expiries and
fences older unscoped implementations; receipt freshness cannot renew a lease.
Use server snapshot time, never operator clock, for expiry.

`replace-cms-preview-pair.cjs` supports `plan`, `close`, `select`, `receipt` and
`fence-reader`, explicit project and JSON input. Plan closure first; close;
wait expiry/drain; install/qualify NEW; plan fresh selection; select; read original
receipt. A closed incarnation cannot return to selection. Explicit uncertain-
probe fencing uses exact original request digest and preserves closure-aware
current readers; it cannot claim a failed probe succeeded. Missing original
packet remains STOP.

The displacement transaction terminally fences the old serializer journal so
even a base-revision image cannot reserve after replacement. Retain that record
on idempotent clear. No saved input/artifact or provider resource is deleted by
selection. Provider retirement remains a separate operation.

## Shared preflight and Access installation

Private Access applications/policies must precede any gateway hostname. OLD
reader, NEW reader and proof operator use distinct exact audiences/tokens.
Use existing approved tokens; Access setup never creates/prints service-token
secrets. Default plans read no credentials/SDK/provider. Enabled attachment is
sealed before UUID assignment and can attach only its own protected hostname
after exact private deployment; no forced DNS overwrite or other-host edit.

The real preflight caller rereads actual registry/version/modules/config,
container/namespace and no-public-route inventory before reserving, invoking
and returning. It returns actual installed-target digest, not the expected hash
copied from plan. Publisher health, preview health and reader installation are
distinct fixed RPC kinds; none can substitute for another.

Ephemeral remote probe authority uses one durable grant per preview-session
creation, allowed same-account HTTPS exchange, fixed one-method probe upload
and single invocation. The apparently read-only session GET creates authority
and is journaled as mutation. It neither uploads target runtime nor wakes/claims
work. No automatic retry, session refresh, log-tail or cleanup write. Tokens
remain in process memory and error text is projected to fixed safe categories.
The health invocation deadline is 180 seconds.

A completed exact probe may return its original result for at most five minutes
after fresh target readback, without changing time. Definite not-ready differs
from uncertain transport. Uncertain/noncomplete attempt refuses repeats; lost
ephemeral token cannot be recreated from a journal. A fresh later proof needs a
new named authorization, preserving original evidence.

## Command and state map

The following are existing entrypoints, invoked in protected Bash at repository
root. Exact private packets/digests and fd/session setup are prerequisites,
not optional omissions. Commands do not grant their own authorization.
Follow each parser's current exact flags; do not run a command against another
environment or silently replace a failed block.

| Boundary | Existing command/arguments | Credential/session and recovery |
| --- | --- | --- |
| Prepare publisher | `node scripts/prepare-private-pair-publisher.mjs --input <absolute intent> --output <new absolute receipt>` | Offline exact-source preparation; no provider effect. |
| Publisher install | `node scripts/install-private-pair-publisher.mjs --packet "$PACKET" --packet-digest "$DIGEST"` plus explicit `--upload`, `--complete`, `--apply` or `--readback` | Provider stdin, matching SDK fd 3 when required; source/packet before credentials; original attempts only. |
| Slot plan | `node scripts/prepare-private-public-release-slots.mjs --template "$TEMPLATE" --old-upload "$OLD_UPLOAD" --new-upload "$NEW_UPLOAD" --output "$PLAN"` | Actual assigned publisher UUIDs; no predicted slot identity. |
| Access plan | `node scripts/install-private-pair-access.mjs --packet "$ACCESS_PACKET" --packet-digest "$ACCESS_PACKET_SHA256"` | Plan offline; apply consumes provider stdin + SDK fd 3, 240s bound; readback 120s. |
| Bridge prepare/plan | `node scripts/prepare-private-pair-bridge.mjs --input "$BRIDGE_INTENT" --output "$BRIDGE_PACKET"`, then `node scripts/install-private-pair-bridge.mjs --packet "$BRIDGE_PACKET" --packet-digest "$BRIDGE_PACKET_SHA256"` | Access before attached domain; apply provider stdin + SDK fd 3, 240s; readback 120s. |
| Reader plan | `node scripts/install-public-release-pair-reader.mjs --packet "$READER_PACKET" --packet-digest "$READER_PACKET_SHA256"` | Offline source/packet validation; no installation from metadata alone. |
| Reader apply/readback | Same reader command plus `--apply` / `--readback` | Apply provider stdin + SDK fd 3, 240s; readback SDK fd 3, 120s. Original native probe/rollout before atomic seal. |
| Dev public pause | `node scripts/pause-dev-public-release.mjs --packet "$DEV_PAUSE_PACKET" --packet-digest "$DEV_PAUSE_PACKET_DIGEST"` | Plan offline; apply/readback exact original dev account fd 3; production refused. |
| Enrollment | `node scripts/enroll-public-release-change-log.mjs dry-run` then `apply`, `--project njpbs-site-dev --request "$DEV_ENROLLMENT_REQUEST" --development-sdk-packet "$DEV_SDK_PACKET" --development-sdk-packet-digest "$DEV_SDK_PACKET_SHA256"` | SDK fd 3 and edge secret fd 4 in private session; original atomic baseline/log/enrollment. |
| History | `node scripts/terminalize-dev-publication-history.mjs --packet "$PACKET" --packet-digest "$DIGEST"` | Plan, authorized `--apply`, then `--readback`; SDK fd 3, exact original bounded inventory. |
| Rate evidence | `node scripts/record-public-release-rate-controls.mjs --packet "$RATE_PACKET" --packet-digest "$RATE_PACKET_SHA256"` | Default offline plan; record requires actual protected review/provider evidence. |
| Rehearsal plan | `node scripts/rehearse-public-release-pairs.mjs plan` | Offline plan; not a completed rehearsal. |
| Demo rehearsal | `node scripts/rehearse-public-release-pairs.mjs run "$REHEARSAL_PACKET" "$REHEARSAL_EVIDENCE"` | Schema 1 demo/loopback only; this mode refuses development packets. |
| Development rehearsal | `node scripts/rehearse-public-release-pairs.mjs run-development "$DEV_REHEARSAL_PACKET" "$REHEARSAL_EVIDENCE"` | Schema 2, admitted development target and bound actual adapters; matching private development credential pipe fd 3, no ADC/emulator fallback. Missing bindings refuse before opening it. |
| Installed development | `node scripts/rehearse-public-release-pairs.mjs installed-development "$INSTALLED_PLAN" "$INSTALLED_PLAN_SHA256" "$REHEARSAL_EVIDENCE"` | Exact byte-bound native launcher plan, actual installed session/transports and all private prerequisites; no invented fixture proof. |
| Installed recovery | `node scripts/rehearse-public-release-pairs.mjs recover-installed-development "$INSTALLED_PLAN" "$INSTALLED_PLAN_SHA256" "$REHEARSAL_EVIDENCE"` | Same original plan, byte digest and evidence directory. Recover original accepted effects; observation window remains failed. |
| Publication timing | `node --import ./site/node_modules/tsx/dist/loader.mjs site/scripts/measure-public-release-pair-publication.ts plan` | Offline plan is not installed timing. |
| Executor check | `node scripts/check-public-release-pair-executor.mjs` | Credential-free local graph/runtime check; `--reconcile-static` is the separate focused mode. |

`timeout --signal=TERM --kill-after=5s` bounds attended Access/bridge/reader apply
at 240s and readback at 120s as above. Timeout/signal is not proof remote effects
stopped: preserve original attempt and reconcile; do not repeat a mutation.
Plain Node pins its source hook only after the built-in-only gate. Keep no-clobber
receipts and original operation state in the retained session.

## Development first-install order

Private packet freezes OLD/NEW, exact source/reader/image/plan references,
original IDs/digests, windows and expectations before execution. Development
targets only its isolated project/staff-gated origin; no production route-swap
operator. If inactive sequence-zero enrollment must be replaced, use its
separately reviewed retirement first; never abandon an enrolled history by
starting the first-install rows again.

1. Bring the actual legacy predecessor to compatible OLD through its separately
   authorized owner; verify both private current-CODE RPCs against that actual
   OLD renderer. Required source-input census fixes must exist in OLD and NEW.
   A newer operator cannot relabel an incompatible source as fixed.
2. If missing, establish exact native predecessor runtime/media controls using
   `08a-runtime-initialize.sh` then `08b-media-lifecycle-initialize.sh`, with fresh
   idle predecessor, exact public receipt bytes and actual provider identities.
   Classify/settle historical batches through `08c-historical-batches.sh` before
   freezing pause expectations. Never infer a baseline from local hints.
3. Run or reconcile original `09-public-pause.sh`, `10-close-inspect.sh`,
   `10a-preview-pause.sh`, `10b-enrollment-inspect.sh` and `11-enroll.sh`:
   original public/preview drain, independent closed fences, stable cutoff,
   then ONE atomic log head + complete global baseline + enrollment receipt.
   Fresh pair resources are not prerequisites for this original enrollment.
   Optional `09a-public-pause-recovery.sh` is limited to the original failed
   development pause; it is never a production recovery command.
4. Freeze enrolled source inputs OLD then NEW with
   `bash scripts/development-install/code-pack/freeze.sh`; prepare immutable
   images with `image-context.sh`, perform the separately authorized exact image
   build, then `extract.sh` and `build.sh` in that same directory. These latter
   names mean `bash scripts/development-install/code-pack/<name>`. Verify actual
   extracted graph and full native code-asset digest before freezing/reviewing
   either schema-three publisher packet. Preserve obsolete image/pack evidence;
   never repeat enrollment after resources are installed.
5. Upload OLD publisher then NEW using their native `--upload` commands. Derive
   the original slot plan with actual UUIDs; run
   `bash scripts/development-install/00-private-slots.sh`; complete/register OLD
   then NEW using original `--complete --slot-plan --slot-plan-digest`; apply
   OLD then NEW and read back both. Publisher command consumes provider stdin
   and SDK fd 3; the **slot wrapper instead consumes provider fd 3 and SDK fd 4**.
   Never interchange these layouts or guess/register an incomplete pair.
6. Complete actual private Access/policies, reader gateways/operator, both reader
   seals, deployed Functions/API mounts and OLD/NEW preview installations with
   their original receipts. Upload or candidate health alone is insufficient.
   Preserve complete served Admin baseline and separate candidate artifact.
7. `19-old-code.sh`, then `20-stage-a.sh`; `21-preview-plan.sh`, then
   `22-preview-convert.sh` select current OLD preview using its original CAS.
   Keep legacy preview and accepted-source/claim ownership intact.
8. `29-initial-pair-staging.sh`, `30-controls.sh`, `30a-initial-pairs.sh` and
   `31-initial.sh` use actual OLD/NEW bytes/replay/fresh qualification and exact
   paused-first-install guards to convert public root selecting OLD. A schema-two
   root must refuse before conversion; private byte qualification is independent.
9. `32-staff-binding.sh`, `40-stage-b.sh` and `50-resume.sh` finish actual reader/
   gateway/admission bindings and resume only the logged path under the original
   fence. `60-native-schedule.sh` verifies native scheduled saves through original
   owners. Each row requires its native receipt, not just shell exit.

The command files live in [scripts/development-install/](../../scripts/development-install/).
Use each block's exact named private held session and state mirror after every
block/refusal. A mirror failure stops progression. For `19-old-code.sh`,
`29-initial-pair-staging.sh` and `30a-initial-pairs.sh`, explicit `readback`
recovers original receipts; never rerun a provider effect to reconstruct state.
The private mirror command and packet are not copied into public source.

### Development pause and drain refusal

Pause packet binds original first-install operation, ready OLD primary/cloud
runtime and exact idle legacy pointer digest. All pointer-mutating work settles
before freezing it. Allowed already-accepted build-free work may drain after
pause only with exact original queue/revision/runtime and current-context
preparation owner. Malformed/exhausted/final-expired preparations refuse before
pause; exhaustion afterward creates immutable STOP even if parent still pending.

The apply transaction changes only two ready phases to paused and creates the
original attempt. Drain checks queues, canonical retired batches, current-context
preparations, both original journals/releases, external refresh, outputs and Home
owner/refresh. Each collection is bounded to 1,000; oversize/malformed/claimed/
retrying/nonterminal histories refuse without truncation. Original canonical
terminal labels, including historical failure/unconfirmed/deployed, stay distinct.
Pause never transfers/cancels/retries/repairs accepted work. Recover its original
attempt instead of changing packet expectations or manufacturing terminal rows.

The separate development `09a` continuation retains the original immutable STOP,
records failed work as failed-not-published and keeps pins paused; it never
reruns failed accepted work or relabels original drain success. Its separately
authorized original receipt and fresh `canContinue` readback are required.
`50-resume.sh` is post-enrollment logged resume, not pre-enrollment failure
recovery. Later task progress alone cannot reopen fences or bypass a failed pause.

## Production first-install and switch order

Production source remains BUILD-only until a named operator task supplies exact
authorization, packets/resources and all actual installed development proof.
The first installation keeps its existing pause/drain/byte/resume plan; it is
not the later no-pause acceptance release. Missing concrete owner is STOP,
not permission for fixture writes or a schema-one command on schema two.

| Order | Existing attended command | Required original evidence |
| --- | --- | --- |
| 1 | Separately opt-in production reader workflow and installed bridge | Exact Functions/API deployed cohort and actual old/new retained-request replay; prior Admin supported. |
| 2 | `bash scripts/production-install/bootstrap.sh plan`, authorized `apply`, then original `readback`, separately for `pause` and `preview-pause` packets | Exact native public/preview pause/drain and original closed admission fences, no reassigned accepted work. |
| 3 | `bash scripts/production-install/enroll.sh inspect`, `dry-run`, authorized `apply`, then `readback` | Original successful pause/drain/current fence; one atomic baseline/log/enrollment. Failed production pause is STOP before enrollment. |
| 4 | `bash scripts/production-install/code-pack.sh freeze`, `image-context`, `extract`, `build`, OLD then NEW with each mode's packet/result | Enrollment first; baseline-bound image with every returned production build argument, actual extracted graph and full artifact before upload-plan sealing. |
| 5 | Actual native publisher/slot/preview/Access/reader installation owners | Assigned UUIDs, complete immutable pair registration and independent original readbacks; no implicit ingress/public selection. |
| 6 | Original OLD CODE/Stage A and `bootstrap.sh plan`/authorized `apply`/`readback` with `controls` packet; `bash scripts/production-install/initial-pairs.sh plan`, authorized `apply`, then `readback` | Compatible OLD controls ready under closed fences; actual H/G/staging/replay and both fresh qualifications. Initial-pairs apply stages/qualifies; it does not convert the root. |
| 7 | `bootstrap.sh plan`, authorized `apply`, then original `readback`, with exact `initial` packet | Native CAS converts schema-one root selecting OLD, after fresh actual late guards and original reader/source/media/capability proof. |
| 8 | Complete explicit ingress/binding/Stage B owners, then `bootstrap.sh plan`, authorized `apply`, `readback` with `resume` packet | Enrollment and root CAS committed; TWO fresh qualifications, canonical OLD roster/root and installed readers before one logged-path resume. |
| 9 | Separately named guarded NEW switch and OLD return | Frozen switch packet, fresh installed qualification/current inclusion, original native switch/return receipts and real serving evidence. |

Every `bootstrap.sh` abbreviation above means
`bash scripts/production-install/bootstrap.sh` from the repository root. Its
packet's exact `step` chooses the native owner; it is not a positional step flag.
The private attended row map instantiates each separate boundary; do not run
these as an unattended loop. `bootstrap.sh abandon` applies only to an explicitly
eligible pre-enrollment return with original proof, restored original public AND
preview controls, closed original fences and no enrollment/producer control.
It cannot undo enrollment/conversion or rewind authority. Production
`pause-recovery` refuses before credential reads with the native unreviewed-
recovery STOP. Preserve failed original evidence and fix its owner forward;
never use development recovery, ADC or manual pin writes to bypass it.

Production bootstrap uses SDK fd 3; `controls` also uses read-only Google fd 5;
`initial`/`resume` add R2 read fd 4 and Google fd 5. Production initial-pairs
apply has a different layout: SDK fd 3, R2 reads fd 4, conditional H/replay/proof
writes fd 5, OLD/NEW private-reader Access fd 6/7. Its plan is offline and
readback uses SDK fd 3 only. Production enrollment inspect/readback uses only
SDK fd 3; dry-run/apply also uses edge fd 4. Never substitute a generic initial
CLI's R2/ADC layout or a development viewer-Access layout. Qualifiers use only
native target namespaces; no arbitrary bucket, list/delete/overwrite or G-write
capability is granted by an input packet.

After schema-two root commit, legacy activation writers must refuse. Read
original conversion receipt on lost response; retain committed OLD authority
and fix the original install forward. A later no-pause release must keep staff
publication and saved previews open through candidate preparation, switch and
guarded return; first-install pause does not satisfy that acceptance.

## Seven real preflights and rehearsal

The emulator-only driver remains
`node --import ./site/node_modules/tsx/dist/loader.mjs scripts/preflight-release-no-pause-bootstrap.mjs dry-run "$EVIDENCE/bootstrap-preflight.json" "$PREFLIGHT_ADAPTER"`
from `REVIEWED_SOURCE`, with the assigned loopback `FIRESTORE_EMULATOR_HOST` and
`METADATA_SERVER_DETECTION=none`. The external config assigns every auxiliary
port; do not start a shared default-port wrapper in another worker's range.

Read-only bootstrap driver is emulator-only. It binds exact clean tracked adapter
bytes/source/packet digest and uses actual owner callbacks. It runs all seven
layers even after refusal, rejects ordinary SDK/transaction writes and records
bounded observations plus final report digest with no production authority.
Fixture setup writes are separate from preflight. An unbound callback is STOP.

| Layer | Required actual observation |
| --- | --- |
| 1 | Original enrollment/baseline, pair/selector identities and contiguous current log cursor |
| 2 | Private publisher/version/image/journal/resources, candidate/retained authority and original work |
| 3 | Complete H/completed claim/G/code/composite bytes, replay witness at exact current head and fresh retained qualification with cumulative tracker |
| 4 | OLD-only private ingress/slots, actual provider versions, current root, warm/cold retained recovery, routing cost/latency and rate evidence |
| 5 | Original switch receipt/attempt, actual both-pair inclusion/terminal adapters and no conflicting writer |
| 6 | Actual deployed CMS/preview readers and session windows, supported old Admin/requests, original queues/journals and source compatibility |
| 7 | Complete real isolated rehearsal report/status/step/adapter digests and exact OLD/NEW preview references, never harness-fixture report |

Qualification prepared objects remain process-local and opaque. Retained
inventory/body reads occur outside SDK transactions, final current authority
guards inside. Source/head movement after the preflight requires fresh real
proof, not a report reuse. A stopped host leaves OLD selected and original
durable work recoverable.

Rehearsal covers failure after Functions/private rollout/selection/Admin upload,
cancellation, body mismatch, replay gaps, withdrawal, old tabs, retained preview,
uncertain provider/selector result, canonical terminal ownership and guarded
OLD return. Before selection failures keep OLD; after selection NEW remains
selected and prior Admin works. A future API signature/plan or fixture pass
does not count as an actual installed transport.

Retain complete `status.json`, `report.json`, packet/step/adapter bytes and
digests. Require current status complete and SHA-256 report match; an old report
beside running/refused status fails. Demo mode never accepts production.
Development mode uses only its reviewed integration adapter/isolated project;
it does not deploy resources or automatically repair missing owners.

Publication timing must observe original admission, actual completed view,
activation, canonical terminal receipt and ordinary current serving, including
continuous publishing through switch/return. Routing measurements retain real
units/sampling and both cold/warm limits; source-level test timings are not
performance acceptance. Include actual reads/compute/storage cost of enabled
recovery and private qualification, including idle minute wake queries.

The separate routing observer uses
`site/scripts/create-private-routing-measurement.ts --measurement-id "$M28_ID" --source-digest "$M28_SOURCE_DIGEST"`
through the direct Node loader, dry-run before separately authorized `--apply`.
`scripts/prepare-public-release-routing-measurement.mjs --source <receipt> --cases <cases> --out <new-config>`
creates disabled config first; explicit `--enable-development` is separately
qualified. Private credential/session provisioning and provider installs remain
private steps. Observe with `node scripts/measure-public-release-routing.mjs --url "$M28_URL" --measurement-id "$M28_ID" --version "$M28_VERSION" --mix "$M28_MIX" --seconds 10 --rate 1 --out <new-smoke>`;
the retained observation uses `--seconds 600 --rate 1.25` and a new output.
Its private measurement credential is stdin, never argv or a packet. Retain both
router/direct lane results and original version; no public authority comes from
this measurement.

Pre-enrollment historical retirement keeps
`env -i PATH="$PATH" HOME="$HOME" node scripts/retire-pre-enrollment-history.mjs --packet "$HISTORY_LIST_PACKET" --packet-digest "$HISTORY_LIST_PACKET_DIGEST"`
for the original list, then a separately reviewed apply packet with `--apply`.
Both use exact private SDK fd 3 in protected Bash, fresh no-clobber outputs and
unchanged original source/authority. List success never grants apply by itself.

Existing proof entrypoints remain `node scripts/test-cms-reader-bridge.mjs`
with explicit named test files and assigned emulator ports, and the root/site
Vitest commands for the changed owner. Preserve default-off/refusal, source,
actual SDK transactions, runtime/reader/namespace/replay, fault/uncertainty and
old-session assertions. Compilation checks use the actual
`site/scripts/build-public-post-renderer.ts` and
`site/scripts/build-public-release-pair-renderer.ts` in the credential-free
offline development environment with the pinned semantic model cache;
`site/scripts/prepare-search-model.ts` prepares that cache. Do not use a new
timeout/retry or replace real-owner tests with document-text assertions.

## Retirement and proof limits

Before deleting any old path/resource, prove accepted work terminal, original
outboxes/journals drained, reader/session expiries reached, retained requests,
assets/media and rollback obligations resolved, all imports/callers removed
or equivalently covered and actual provider ownership/census reconciled.
Do not add another selection lane, flag, receipt or alert to bypass a missing
owner; name the failure and removal step in its separately reviewed change.

This consolidation adds no new gate or protocol. It documents existing second
environment, switch, compatibility and rollback boundaries. Old schema-one
release remains for its retained accepted work until every consumer migrates;
schema-two pair implementation stays until the live experiment decision and
retirement proof. Never weaken tests, timeouts, freshness, byte completeness,
withdrawal or terminal ownership to reduce documentation or claim readiness.
