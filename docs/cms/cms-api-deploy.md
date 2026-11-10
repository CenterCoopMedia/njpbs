# CMS API and published reader contract

The CMS API mediates authenticated staff requests and bounded public-reader
relays. Deploy through the [coordinated release](staging-deploy-runbook.md), not
a direct upload that skips source/receipt/secret and endpoint checks.

## API selection and readback

The [API configuration](../../cms-api/wrangler.jsonc) owns routes, rate-limit
and live-production Durable Objects, migrations, Functions origin, renderer
service and version metadata. Preserve these bindings across script releases.
Development uses its own environment, origins and credentials. Local-origin
flags cannot open a production/development boundary.

Before deploying or reusing a version, require its input/configuration/trusted
source fingerprint, complete receipt and actual provider deployment to agree.
The API's secret digest must match Functions preflight even on a partial rerun;
missing/different/unreadable input stops before deployment. Reread actual
provider identity before Admin. A previous skip is not reusable proof.

An unrelated Functions upload does not select an API deployment. The API uses
its own runtime dependency closure, configuration and fresh live-version proof.
Configuration releases and shared-secret rotation retain conservative paired
selection and secret agreement. Backend ordering and endpoint/reader probes
remain required. These source rules do not claim a deployment is live.

Probe unauthenticated edge denial, direct-origin denial, configured CORS/App
Check, navigation/settings readiness and supported old-reader routes. Optional
preview wake failure preserves accepted queue and cron recovery. Staff cookies
or bearer credentials cannot leak into private artifact or published-read relays.

## Published Post read boundary

`cmsGetPublishedPost` is a read-only published projection, not generic CMS API
access. Explicit enable/slug allowlists on both sides default closed. Only
canonical `GET /posts/{slug}/` with no query/body is admitted. HMAC input is four
newline-separated fields: `njpbs-post-reader-v1`, `GET`, canonical path and
13-digit Unix milliseconds. Compare lowercase-hex signature in constant time
with at most 60 seconds clock skew. A replay repeats a fresh nonmutating read.
No browser signature, URL token or anonymous fallback is accepted.

The relay has no public route/workers.dev/preview URL, no Firestore credential,
strips staff credentials, refuses redirects and permits only the exact HTTPS
Function endpoint. Its ten-second origin deadline bounds cold reads. The
Function's read-only identity is distinct from ordinary CMS edge credentials;
Firestore IAM alone is broader than this projection, so HMAC and public-only
validation remain necessary. Rotate matching reader keys on every consumer
together; never reuse edge or activation secrets.

One read-only transaction checks canonical/retired-slug ownership, explicit
visibility, immutable published snapshot, due publication time and required
media. Bounded competing owners fail closed. Positive snapshot version cannot
exceed record version or fall below confirmed public source; a newer private
working draft is allowed but never selected. Public ownership indexes must be
READY before release; emulators cannot prove that provider state.

| Status | Meaning |
| --- | --- |
| 200 | Bounded selected published Post, image, public author and published chrome/navigation projections |
| 404 | Unknown/unlisted/unpublished/withdrawn or unavailable alias, no content |
| 410 | Matching deleted snapshot, including retained alias |
| 403 | Authentication or request-shape refusal |
| 503 | Invalid/ambiguous version/owner, missing media, read error or unsupported renderer dependency; no stale/static substitution |

Responses stay private/no-store and at most 2 MiB. Never include private
profiles/accounts/staff IDs, working fields, unknown nested fields or object
keys. Frozen credits admit at most 12 distinct referenced public profiles;
missing/withdrawn profiles retain valid frozen names without links. Guests
never join by name. Invalid/duplicate/conflicting author context refuses.
Media lifecycle/public-copy validation stays required. `spotlightNews` is a
published boolean with false default for old snapshots.

Published settings use the shared published projector and published source
version, not draft save version. Only bounded admitted Page path identities
leave navigation reads; no bodies or working slugs. Duplicate paths refuse.
Missing/invalid published settings retain publisher defaults. Chrome digest
and optional sweep preserve their own refresh bounds.

## Retained pilot rollout and removal

Use the retained shadow workflow only for its explicitly authorized pilot.
Functions/indexes first, private relay/disabled shadow second, signed-out and
staff proof before explicit enable. `enabled=false, remove=false` stages off;
`enabled=true, remove=false` admits only the configured pilot;
`remove=true` takes precedence and skips build/secret upload.

Admission/removal require exactly one approved parent gateway route and no
foreign/unassigned/duplicate owner. Deploy refuses active development public
publication; removal remains available. Removal deletes only its exact Post
route (including orphan), proves absence and unchanged parent identity, then
deletes shadow and relay. Unexpected ownership/API failure stops. Function,
secret and read-only account have separate retirement authority; names alone
do not prove retirement. Preserve serving/cold/withdrawal and binding census
before any later source removal.

## Reader-before-writer compatibility

Election/schema upgrades first deploy readers accepting known old/new versions
while writers, sealed artifacts and activation markers retain the old version.
Unknown versions and fields still refuse. Writer/normalizer enablement is a
separate release. Exact release-specific byte exceptions are private operator
steps bound to literal reviewed trees and hashes, never a general relaxed
equality/range guard. Re-run actual OLD/NEW validators/normalizers/activation
and actual retained-candidate replay against deployed OLD CMS. A stand-in
fixture cannot prove that compatibility window.

Recover through the original guarded workflow with actual source/version and
secret agreement readback. Test authenticated denial and supported old tabs,
not only provider deployment. Pair reader installation/retention stays in the
[pair contract](release-without-pause.md).
