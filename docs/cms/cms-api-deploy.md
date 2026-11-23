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
preview wake failure preserves accepted queue and cron recovery. Keep staff
cookies and bearer credentials out of private artifact relays.

## Published Post read boundary

`cmsGetPublishedPost` returns a read-only published projection. It requires
explicit enablement, an allowlisted slug and a signed canonical
`GET /posts/{slug}/` with an empty query. The HMAC covers
`njpbs-post-reader-v1`, the method, the canonical path and a 13-digit Unix
timestamp in milliseconds, each on its own line. The Function compares the
lowercase hexadecimal signature in constant time and allows at most 60 seconds
of clock skew. A repeated valid request performs a fresh read.

The Function uses a dedicated read-only identity. HMAC admission and
published-data checks narrow what that identity can return through this endpoint.
Use a dedicated signing key and rotate the Function key together with the keys
of any approved consumers.

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
