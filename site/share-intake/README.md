# Share intake worker

`njpbs-share-intake` is the public edge for the `/share/` form. At launch it
serves `https://intake.njpbs.org` through a Worker custom domain. It checks
Turnstile, the honeypot, dwell time, and rate limits before it calls the private
UGC Functions. File bytes go directly to a signed quarantine upload URL.

## Routes

- `GET /config` calls `ugcGetConfig` and caches a successful JSON response for
  at most 60 seconds.
- `POST /start` checks the form gates, reserves capacity, then calls
  `ugcStartSubmission`. A filled `website` field or a dwell under three seconds
  gets `200 {"ok":true}` without a Function call.
- `POST /complete` requires the accepted request ID, client IP hash and
  submission ID to match one reservation. It consumes completion admission
  before it calls `ugcCompleteSubmission`. It releases the upload slot after
  success, a rejected file or an expired upload.
- `OPTIONS` supports CORS preflight on these routes. Only the configured
  `ALLOWED_ORIGIN` can call them. Other paths return 404.

POST bodies must be JSON and at most 8 KiB. The Worker removes
`turnstileToken` and `website` before forwarding, adds `clientIpHash`, and sends
`x-njpbs-cms-edge` and `x-njpbs-client-ip`. The Functions repeat input checks and
own the closed state and file validation.

## Limits

The SQLite Durable Object reserves one 15-minute upload slot per IP hash. It
allows three accepted starts per IP hash per rolling hour, 100 accepted starts
per UTC day for the form, and a 2 GiB byte budget. Acceptance of a start does
not make its byte charge permanent. The named `UPLOAD_TRANSFER_GRACE_MS` allows
another 60 minutes after the 15-minute URL expires, for 75 minutes total. When
holds beyond that grace block a new start, the Worker reconciles them with the origin in batches of four. The internal
`x-njpbs-quota-reconcile` header uses the existing edge-secret gate; caller
headers are never forwarded. The origin measures present objects, including
uploads whose clients never called `/complete`. It releases absent objects only
after placing a conditional zero-byte marker at the key to fence late PUTs and
replays. Staff-rejected submissions whose quarantine key was deleted retain
their verified upload size as the byte charge. Conditional-write conflicts and storage errors keep capacity held.
Reconciliation also runs after terminal file rejection or upload expiry.

Confirmed bytes count on the UTC day when first confirmed. Byte release
preserves accepted start counts. Active holds count across midnight. A separate
ten-minute reconciliation lease excludes normal completion and fences stale
results. Zero-byte outcomes close the reservation. Markers remain under the
existing 90-day quarantine lifecycle. Functions must ship before this Worker;
older Functions do not return a quota receipt, so their reservations stay held.
The Worker refuses declared files above 500 MiB. The Functions enforce the
photo and video type limits and inspect uploaded bytes.

Each accepted submission permits one terminal completion and at most three
serialized attempts. Missing-upload responses, origin server errors and lost
origin responses permit another attempt within that bound. A successful or
terminally refused submission cannot complete again. Each in-flight claim has a
ten-minute lease, longer than the Function's nine-minute timeout. A lost claim
response or stopped Worker permits a later attempt after that lease expires;
each reclaim counts toward the three-attempt budget. Attempt identities prevent
late replies from changing a newer claim. The Worker refuses expired claim
responses and aborts origin requests at the lease deadline.

Concurrent attempts get HTTP 429 with the remaining lease time. Terminal or
exhausted attempts get HTTP 429 with `expired`, which clears the form's current
request. Requests without a retained reservation also get `expired`.
Unaccepted and mismatched attempts get HTTP 429 without a
Function call. A limiter failure gets HTTP 502 without forwarding. A failed
terminal bookkeeping or slot-release call preserves the origin response; its
claim and upload slot retain their leases. Repeating a start does
not reset the completion budget. Slow uploads may complete after their signed
URL lease expires during the 60-minute transfer grace. After that grace, an
absent object may be fenced to recover capacity; a PUT still transferring then
must restart. Midnight cleanup retains accepted, uncharged reservations until
storage reconciliation records their actual size or installs the zero-byte fence.
Completion records are removed when their reservations leave that ledger.
Reservation cleanup retains active completion leases until they expire.
Initialization adds missing lease and charge-time and reconciliation columns without replacing
reservations. Legacy terminal rows keep their accepted-day byte charge because
the old schema did not distinguish success from rejection. Existing in-flight rows without a lease remain terminal because
their origin outcome is unknown.

## Configuration and deploy

`wrangler.toml` holds the public origin and Functions base URL. Set these Worker
secrets before deploy:

- `CMS_EDGE_ORIGIN_SECRET`: Shared CMS edge gate.
- `TURNSTILE_SECRET`: Turnstile siteverify secret.
- `IP_HASH_SALT`: Salt for the client IP hash.

After an authorized administrator approves launch infrastructure, set the secrets with
`wrangler secret put <NAME>` and run `npx --no-install wrangler deploy` from this directory
after installing root/site locked dependencies and resolving the pinned Wrangler
before fetching the deployment credential.
Create and bind the `intake.njpbs.org` custom domain and the Turnstile widget at
launch with administrator approval. The custom domain is bound out of band, so a script
deploy does not need zone route permissions.

The logic is in `share-intake.ts` and `rate-limit.ts`. `index.ts` binds the
Workers runtime. Tests run under the site's Vitest without starting a Worker.

## Release readback and recovery

The private operator step verifies the approved account/domain, credential
routing, scoped secrets and existing reservations before an authorized release.
Deploy Functions first, then the matched Worker with its SQLite limiter binding
and migration. Read back actual versions/bindings and custom-domain ownership;
local source and dry-run success cannot establish live delivery.

Retain durable reservations, completion identities/leases, confirmed byte charges
and late-PUT fences across retries and rollback. Never reset them or clear an
ambiguous claim to free capacity. A storage/reconciliation failure keeps capacity
held and needs its original guarded recovery. Prove rejection and quota behavior
with synthetic local objects; a real submission/upload is separately authorized.
Shared source/receipt rules are in the
[coordinated release contract](../../docs/cms/staging-deploy-runbook.md).
