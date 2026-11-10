# Private preview renderer contract

Saved Preview renders one exact acknowledged content version without publishing
it. Code identity, editorial context identity and public CODE generation are
distinct. Use the [CMS release](staging-deploy-runbook.md) and its
[receipt view](staging-deploy-runbook.md#receipt-view) for fresh deployment proof.

## Build and startup

The reviewed image compiles templates/assets once into the sealed renderer
package, including `runtime/cloud.mjs`. Local runtime installations require
`npm --prefix site run build:renderer` from the exact clean checkout after
dependency installation. Startup verifies committed source, package hashes and
Bubblewrap before clients/readiness. Missing or mismatched packages refuse;
there is no fallback to another release.

The cloud entry clears credential variables before importing verified runtime
code. SDKs stay external; module resolution remains relative to the installed
checkout and uses the Functions Firestore SDK. Importing the runtime must not
start a Firebase app. Import-only timing does not establish preview latency.
The render child uses rootless Bubblewrap, private namespaces, read-only source
and package assets, writable job output only, no network and no credentials.

The [deployment operator](../../site/scripts/deploy-cms-preview-cloud.ts) supports
`preflight`, `pause`, `deploy`, `confirm` and `seed-context` with a reviewed
commit. Its exact argument validation remains in that source. The standard
workflow builds an image from source; it has no retained-image-digest input.

## Release order

Run the coordinated workflow from trusted `main` with the full pinned NEW
`deploy_ref`, after publisher/public verification at that same source:

1. Complete exact-SHA CI, source scans and prepared Worker dependency checks.
   Component preparation uses clean committed copies and only declared
   dependencies; root packages cannot hide undeclared Worker imports.
2. Complete the private operator step for scoped storage and Firebase credential
   identity, retained public context and provider readiness. Supply credentials
   only to their consuming process, never to builds, arguments or logs.
3. Pause new preview admission, drain admitted queue and journal work, disable
   the old Worker and verify inactive containers before image replacement.
4. Deploy matched Functions, API and renderer. API/renderer wake rollout can
   occur in either order: old APIs use cron; an old renderer may reject the
   optional wake. This cannot reopen admission early.
5. Set runtime `starting`, enable the existing cron, verify exact source/package,
   sandbox, retained context and pending index, then record `ready` transactionally.
6. Deploy Admin afterward. Verify live sources, readiness and private serving;
   separately exercise saved Page/Post, media and retained recovery in an
   authorized staff browser.

The renderer uses `CMS_PREVIEW_CLOUD_ENABLED`, scoped R2 credentials, a matched
Firebase account and the scoped deployment token. Missing provider/binding or
startup proof retains the pause. A candidate receipt cannot replace the last
complete active receipt.

## Queue ownership, wake and recovery

Functions commits acceptance durably before the API sends a private wake.
Only pending/building serializer work carries the accepted renderer identity;
ready, failed and GitHub work sends no wake. The API removes the internal header
and uses `waitUntil` without consuming the accepted response body. Its bounded
post-response lifetime does not own rendering.

The private renderer has no HTTP route. Wake checks exact accepted source,
enabled control, runtime, journal and pending work before selecting the existing
singleton. Concurrent hints cannot create another processing owner. Mismatched
or disabled releases cannot start. Paused admission still lets accepted work
drain. Missing bindings, rejected RPC or canceled wake preserve acceptance and
the durable queue; the minute recovery trigger remains necessary. The container
stops after three idle minutes.

The journal stores the raw claim token before processing and preserves the
same job/token across restarts. `cmsPreviewPublicContexts` contains only sealed
identity/key/length/hash/receipt digest. Both collections deny browser clients.
A retained claim requires its original source and token: never reset it or use
timeout takeover to force a release.

Recover with a full compatible reviewed CMS source, retaining the existing
compatibility floor and every operator file the trusted workflow requires.
Inspect and recover exact journal work when drain/startup fails. Do not swap an
unrelated image through Wrangler or claim a new source build reused old image
bytes. Read back Functions/renderer identity, readiness, Admin manifest and
private serving before releasing containment. Public publication remains
separately owned by the [publisher](cloud-publisher.md).

## Public and editorial context

Code release context is retained and byte-readback verified before activation.
Its reader checks the real `/_publication.json?cms-context=code` before and after
private storage reads. Historical code consumers explicitly request code mode,
not a later editorial context.

Editorial preparation seals a separate preview projection from checkpointed
CMS/provider/media inputs and the public Home catalog. It writes no public HTML,
feed, sitemap or search. Private retention may proceed once that projection is
verified even if a later public search compile/upload fails. Missing/corrupt Home
or media input, changed checkpoint, invalid reservation or source refuses.

The current aggregate pointer must explicitly name `preparationOperationId`.
An accepted alias may retain another operation's original preparation while
keeping its own accepted identity. A family task path cannot identify it by
inference. Missing references refuse; never relabel a speculative background
generation as active CODE. The retention helper needs the exact building claim
and live lease and checks context/source, idle deployment, preparation digest
and original reservation before committing verified private byte readback.

Global pause prevents a new retention claim and verified completion. Current
generation exhaustion stays exhausted; a new CODE generation requires fresh
verification. Retention health/retry failures do not rewrite public status.
Preview input readiness is independent of generated aggregate completion.
Runtime schedule input must be the sealed accepted packet or exact frozen path
and digest; missing, expired, synthetic or foreign input refuses readiness.
See [schedule packets](../runbooks/schedule-pdf.md#immutable-cloud-packet).

## Addressed saved previews

All approved active staff can request/check/open saved previews across owners
and areas; raw history and editing retain their own permissions. Missing,
archived and deleted records remain unavailable. Acknowledged versions may be
recovered only from complete history after-state or the next full before-state,
never bounded audit receipts. Different exact versions keep independent attempts.

The click opens one owned progress tab. Acceptance/save/status can proceed in
parallel, but ready navigation waits for the bounded private session attempt.
The ID token goes only to the fixed private session endpoint, not URLs, popup
state or drafts. A failed/five-second session attempt leaves the normal sign-in
redirect as recovery. Runtime update refusal uses 503 and the allowlisted
`preview-renderer-updating` code, not server message-text classification.

Only opted-in addressed status waits hold at most five seconds. They return on
state change, missing job, expiry, build deadline or request budget, always from
the current server document. Recheck revocation, disabled account and stored
authority before return. Remove listener/timer on disconnect or error. Reads
never overlap; an older server's fast unchanged response is paced to one second.
Popup/editor closure aborts the transport. Request cancellation is not queue
cancellation and does not change accepted ownership.

A context-refreshing preview waits at most four minutes for matching sealed
context. Only the exact building owner can write that progress. Expiry returns
`preview_context_refreshing` with a retry instruction; it cannot turn failed or
ready work back into building. Status cannot disclose URLs for unavailable records.

## Artifact serving, retention and access

Every HTML, asset and HEAD request checks current staff, queue target, ready
artifact kind, record lifecycle and expiry. There is no successful-admission
cache; preview/session/status bypass short revocation caches. A disabled or
revoked staff session cannot reuse an unexpired cookie. Missing/inaccessible
targets share private 404; invalid token is 401, limits 429, infrastructure 503.
The RPC requires `x-njpbs-preview-access: 1`.

Both ordinary `/p/` and retained `/s/` output expire after 24 hours. The serving
cutoff is the earlier of queue expiry and object upload plus 24 hours; retained
heads do not extend it. Everything remains private/no-store. Provider lifecycle
deletion may lag and is cleanup, not admission. Keep one-day `v1/` and `saved/`
deletion and seven-day incomplete multipart abort. Downloaded bytes cannot be
revoked from an existing browser.

Persistent/automatic requests require site-wide `settings.manage` before queue
or head writes, serializer transport only, and no GitHub fallback. Deduplicate
the same item, skip unchanged ready versions, throttle automatic replacement to
five minutes and retain latest/current-ready heads separately. No scheduled
rebuild keeps an idle export alive. Frozen input and `CMS_PREVIEW_PERSISTENT=1`
must agree on asset base.

Write the new ready head before deleting an old export. Lost pointer races
expire/remove only their own output; conditional 409/412 conflicts retry.
Retained journals resume pointer/cleanup work without rebuilding completed
files. Failed exports are removed. Ready artifacts survive failed replacements
within their own lifetime.

## Development isolation and verification

The development preview staff gateway uses development `StaffSiteEntrypoint`
and private artifact service/bucket. Session exchange admits only the configured
development Admin origin; publisher machine identity cannot replace staff.
Wrong project/environment, missing binding or challenge fails closed. No staff
cookies/credentials reach artifact storage. Establish the approved private
Access application/policy/audience before attaching a hostname.

An explicit development renderer release holds publication, drains publishers
and refresh work, then releases exact renderer, matched Functions/API, private
artifact/staff gateways and Admin. Default routine dispatch retains the pinned
renderer only after live Worker/container/runtime/receipt agreement. It cannot
attach a new hostname. Partial/reverted/stale rollouts cannot write completion.
Recheck authoritative route/custom-domain ownership and public DNS; never force
an overwrite. Distinct container and ordinary Worker tokens stay scoped.
Changing component source-pin settings or resuming publication is a separate
private operator step after full success, never implicit on failure.

Verify saved content/version/output identity with ordinary development staff,
anonymous/wrong-project refusal, cross-owner access, disabled/revoked/deleted
accounts, record lifecycle, ordinary/retained 24-hour expiry and HEAD/assets.
Local package/sandbox tests and source checks do not establish live staff
acceptance, disconnect propagation or performance percentiles.
