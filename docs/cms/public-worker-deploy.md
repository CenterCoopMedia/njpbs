# Public Worker deployment and recovery contract

The public Worker serves one active code generation with independently owned
content families. Source controls, deployment lease and actual predecessor
checks prevent stale or mixed activation. Use the [publisher](cloud-publisher.md)
and [coordinated CMS release](staging-deploy-runbook.md) at the same pinned SHA.

## Artifact and candidate

Prepare only reviewed exact committed source with frozen public input. The
artifact includes Assets, complete compiled renderer graph, release/inventory
seals, code/public context and media manifest. Validate Node and workerd
compatibility for that exact source. Keep build credentials and private data
out of files/assets and the offline sandbox.

[upload-public-worker-candidate.ts](../../site/scripts/upload-public-worker-candidate.ts)
binds actual source, sealed bytes, variables/bindings and immutable provider
version. A provider upload is not active traffic or publication. In detached
mode it remains preparation-owned until guarded promotion. Never infer an
upload succeeded or failed solely from a lost response; read the original
attempt/provider identity before retry.

## Activation

The single deployment writer validates current lease, idle/expected predecessor,
reserved generation, eligible candidate, renderer capability seals, complete
content-family inclusion, public media readiness and withdrawal cutoff before
changing traffic. Recheck predecessor/actual active provider identity at the
late mutation/settlement boundary, not only initial planning.

Read public receipt and provider active version before and after ordinary-route
proof. Matching source alone cannot establish exact generation/context/body.
Reconciliation uses the original operation and lease; it never clears an
uncertain lease/token or creates another owner to force idle. The retained
[reconciler](../../site/scripts/reconcile-public-worker-deployment.ts) handles
provider/database disagreement under these same checks.

## Serving and retained copies

Owned family readers validate exact current generation/context/source, route
owner, immutable selected output and removal watermark. Keep private/public
read and capability contracts distinct. 404/410/redirect behavior for canonical
paths and retained aliases must survive a release. Private guide/Admin/design
artifacts never enter public Assets. Internal preview fixture modes cannot
authorize production publication.

Last-good Page/Post bytes and their asset/media references are immutable and
sealed for their original accepted operation. Readback must precede making a
copy usable. Code generation, per-record source version and operation generation
are distinct. A copied last-good object cannot acquire fresh withdrawal grace.
After final namespace handoff, absent owned output fails closed rather than
returning to static Assets. Cold recovery still observes withdrawal/alias and
asset rules. Approved auxiliary outputs keep exact-path/source coverage.

## Recovery

Fix forward with a compatible reviewed source and the full pinned release.
Do not choose a known historical source if it drops current lease/rule/reader
or content capabilities. Exact live-blog/election/Page/Data Hub contracts and
retained old Admin/Preview requests must continue to work. Unsupported rollback
requires a reviewed forward revert, not a marker override.

For an uncertain activation: retain original lease/journal/artifact, inspect
actual provider version and database pointer, run original reconciliation,
then prove idle pointer, exact public root receipt, body bytes, family/withdrawal
and media readiness. Failed proof retains the original attempt for diagnosis.
No second uncoordinated public writer is permitted.

The retained Pages origin is a separately authorized fallback, with exact
active-batch/source/cutoff checks before upload and immediately before deploy.
It must not reserve or advance a public generation. Source changes do not
authorize a route switch. Use the pause/drain/route/readback/resume sequence in
[incident recovery](staging-deploy-runbook.md#incident-and-fallback-recovery).

## Proof boundary

Build/source tests, immutable upload readback, actual active deployment, public
ordinary-route receipts and signed-in CMS behavior are separate evidence.
Qualification includes cold/withdrawn/alias/asset cases and current fallback
copies. Do not use cache-busting URLs to establish removal, stale receipt
examples as a predecessor, or a provider success as completed content settlement.
