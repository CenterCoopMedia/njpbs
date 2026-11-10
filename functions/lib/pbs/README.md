# PBS proxy interface

The thin, documented boundary between the static NJ PBS front and the PBS
platform (#185). A pure static deploy cannot hold a PBS secret or run an OAuth2
token exchange, so PBS calls run in these Cloud Functions and the browser reaches
them over a small, stable contract. Keeping the boundary thin is what makes the
PBS integration swappable and is the survivability line for the whole site.

## Modules behind the boundary

- `media-manager-lookup.js` — the unexported per-viewer asset transport. Uses a
  fixed origin, server-owned station and entitlement context, and a bounded
  deadline. Returns only the asset fields consumed by `assetToGateInput()`.
- `mvault-lookup.js` — the server-only UID lookup and strict response mapping.
  Built, not exported as a Cloud Function; accepts injected fetch and config.
  Returns finite entitlement and identity-mismatch decisions without upstream
  contact data or credentials. Its deadline includes the response body read.
- `mvault-entitlement.js` — the deployable CommonJS decision mirror of
  `site/src/lib/mvault-entitlement.ts`. Shared behavioral fixtures check parity.
- `schedule-proxy.js` — the TVSS fetch core: URL building, the timeout, the
  `X-PBSAUTH` header, and the mapping from TVSS's HTTP reality onto the
  `ScheduleFetchStatus` vocabulary the client degradation policy already acts on
  (`site/src/lib/schedule-availability.ts`). Free of firebase imports, so it is
  unit-tested with an injected fetch and no emulator.
- `schedule-day.js` — the display-safe `ScheduleDay` contract. Every day the
  proxy returns is filtered through `toDisplaySafeDay`, so the key, provider ids,
  and other upstream-only metadata are dropped by construction, not by a reviewer
  remembering to strip them.
- `tvss-schedule-transform.js` — the WNJT broadcast-feed mapper. It converts the
  reconciled TVSS fields into the display-safe day shape, including Eastern time
  offsets across daylight saving transitions. It does not carry provider ids or
  richer static-schedule metadata into the proxy response.
- `schedule-handler.js` — the request handler: method guard, CORS, the header
  baseline, input validation, and the status-to-HTTP mapping. Also firebase-free
  and fully unit-tested with a fake request and response.
- `../http-headers.js` — the shared header baseline (nosniff, deny-frame, HSTS,
  no-referrer, a locked permissions policy) and the CORS origin allowlist.
- `../../schedule.js` — the only firebase-aware file: it reads the secret and the
  deploy params and wraps the handler in `onRequest`.

## The function set the front calls

The schedule handler, MVault transport and Media Manager per-viewer transport
are built but remain unexported; PMSSO token exchange wiring remains unbuilt.

### Media Manager asset availability core

`fetchAssetAvailability({ assetId }, serverContext)` reads one immutable asset
UUID from the request and normalizes its case. The separate server context supplies `stationCid`,
`verifiedEntitlement`, `apiKey`, `apiSecret`, `fetchImpl` and `timeoutMs`.
A future handler must construct this context itself: never spread browser input
into it. `stationCid` is the configured PBS station CID, not the MVault lookup
station identifier. `verifiedEntitlement` must come from the current server-side
MVault lookup for that same station. Only an entitled `active` or `grace` result
adds `membership`; absent, denied or inconsistent results omit it. Both query
CIDs come from `stationCid`. Browser-supplied CIDs and entitlement fields in the
first argument are ignored.

The transport makes one GET to the fixed HTTPS `media.services.pbs.org` origin,
encodes the asset path segment, always sets `localized_station`, sends Basic
Auth only in its header, disables redirects and requests no-store caching.
The default and maximum deadline is 8,000 ms, including the body read. It does
not retry, fetch related records, or bind a secret.

Results are `{ status }` for `not-configured`, `not-found`, `forbidden`,
`rate-limited`, `timeout` and `error`. An `ok` result adds `asset`: one matching
JSON:API asset projected to its ID, type, audience-keyed availability bounds,
PBS's `availability_window` and `playable_window` decisions, and only the
rendition bucket named by `playable_window`. An `unavailable` decision returns
no rendition URLs; unknown window values fail closed.
Empty data is `not-found`; ambiguous resources, mismatched identities and
malformed envelopes are `error`. PBS's empty video list remains a readable asset
without HLS. Malformed individual renditions are omitted, matching the existing
adapter without hiding other usable renditions.
Unrelated metadata, links, error bodies and exception text do not cross the
boundary. `ok` means a readable asset, not permission to play: pass the projection
through the existing `assetToGateInput()` and playback gate with the independently
resolved viewer. The gate still checks timing, entitlement and URS HLS URLs.

The wire contract follows the PBS Assets API.
Synthetic contract tests use real JSON serialization and the existing MVault
mapper and playback gate. No live request or credential is needed for this slice
(#1262). Runtime use remains gated on #206 provisioning, #187 secret binding,
verified member identity and a separately reviewed handler. The build-time
public catalog remains a separate consumer.

### MVault UID lookup core

`fetchMembership({ stationId, pbsUid, apiKey, apiSecret, signInEmail, now,
fetchImpl, timeoutMs })` calls only the fixed HTTPS MVault origin with Basic
Auth in its header, separately encoded path segments, and redirects disabled.
Missing configuration returns `not-configured` before a network call. A later
handler must supply a verified PBS UID from the member sign-in flow.
The default and maximum timeout is 8,000 ms; a smaller positive timeout is
accepted. The deadline covers both response headers and the complete body read.

Results are `{ status }` for `not-found`, `not-configured`, `forbidden`,
`rate-limited`, `timeout`, and `error`. An `ok` result adds `entitlement`,
`identityMismatch`, and `passportResetOffered`. It contains no raw membership,
contact email, UID, or exception text. `ok` can carry a denied entitlement.
An empty response array is `not-found`; multiple records and unreadable bodies
are `error`. Only one readable membership can reach the decision policy.

The transport contract is pinned to [WNET's station implementation](https://github.com/wnet-ieg-2/pbs-passport-authenticate/blob/2e7bc512ccd00a01308e5b5c5ad0319065d78395/classes/class-PBS-MVault-client.php#L54-L70).
The [PBS API response examples and field definitions](https://docs.pbs.org/space/MV/5799969/Membership%20Vault%20API)
place timing under `current_state.explanation.timing`. The mapper requires that
known verdict, matching status, boolean `token_activated`, and boolean
`current_state.has_access`. An unactivated token or upstream denial never grants
access. Unknown timing and missing or malformed state blocks return `error`.
The wire's `start_date`, `expire_date`, and `grace_period` are UTC timestamps;
the transport does not truncate them into the pure policy's date-only fallback.
Grace uses PBS's `within_grace_period` verdict. The mirror retains date fallback
for parity with existing policy callers, but this transport does not use it.
No live MVault request or secret binding is part of this slice (#1261).
Live use remains gated on keypair and station-ID confirmation (#206), Secret
Manager wiring (#187), and a verified PBS UID from the replacement sign-in flow.

### `scheduleProxy`

A read-only schedule endpoint.

- Method: `GET` (plus `OPTIONS` for the CORS preflight). Any other method is
  `405`.
- Origin: a foreign browser request is `403` before any upstream call, so it
  cannot spend PBS quota. Two signals gate it: `Sec-Fetch-Site: cross-site`
  (Fetch Metadata, set even on no-cors `<img>`/`<script>` loads that omit
  `Origin`) and an `Origin` present but off the allowlist. A request with neither
  (same-origin, server-to-server, or an older browser) cannot be judged here and
  is allowed through; the per-IP rate limit for those callers is #254.
- Query params: `callsign` (defaults to the `TVSS_CALLSIGN` deploy param, `wnjt`)
  and `date` as `YYYYMMDD` (defaults to today in the station's timezone,
  `America/New_York`, so a normal Eastern evening never asks for tomorrow's day).
  A malformed callsign or date is `400` with `bad-request` before any network
  call. The client does not retry that request. A missing key stays
  `not-configured`; a thrown secret read is a retryable `error` (HTTP `502`)
  without exception details. These failure responses use `Cache-Control: no-store`.
- Response: JSON `{ status, day, fetchedAt }`, where `status` is one of `ok`,
  `not-configured`, `bad-request`, `forbidden`, `rateLimited`, `timeout`, or `error`, and `day`
  is a display-safe `ScheduleDay` (or `null` on any non-`ok` status). The HTTP
  status mirrors the body status, so a caller can key off either.
- Empty day: a `2xx` carrying no body (a `204`, or a blank body on any success
  status) is `ok` with `entries: []`. A station with nothing scheduled has
  answered correctly, and `error` would tell the client to render a failure state
  and keep re-polling it. The path skips the transform, though it still sits
  behind the `not-configured` gate like every fetch path. The `fetchSchedule`
  docstring carries the full reasoning.
- Two date formats, one converter. `YYYYMMDD` is the request parameter and the
  date segment in TVSS's `/tvss/<callsign>/day/<YYYYMMDD>/` URL; `day.date` is
  ISO `YYYY-MM-DD` (the shape below), the form the client parses as
  `${date}T12:00:00Z`. `toBroadcastDate` in
  `schedule-proxy.js` is the only bridge between them. `toDisplaySafeDay`
  enforces that ISO shape and a real calendar day, so echoing the dashless
  request date fails the served-day contract instead of reaching the client.
- Caching: `Cache-Control: public, max-age=60` on a successful day; `no-store` on
  anything else, so a transient failure is never held as if it were an answer.

The `ScheduleDay` shape is the one in `site/src/lib/schedule-now-next.ts`:

```json
{
  "date": "2026-07-10",
  "callsign": "wnjt",
  "entries": [
    {
      "startsAt": "2026-07-10T20:00:00-04:00",
      "endsAt": "2026-07-10T21:00:00-04:00",
      "title": "Nature",
      "episodeTitle": "Silent Roar"
    }
  ]
}
```

## Secrets and configuration

The TVSS key lives in Google Secret Manager, never in code or config (#187). Set
it with the Firebase CLI:

```bash
firebase functions:secrets:set PBS_TVSS_AUTH
```

Deploy params (non-secret), set per environment in `functions/.env.<projectId>`:

- `TVSS_CALLSIGN` — the station callsign TVSS listings are scoped to (`wnjt`).
- `PROXY_EXTRA_ORIGINS` — comma-separated extra browser origins allowed to call
  the proxy, merged with the built-in static-front origins.

## Current state: not-configured until the key lands

The proxy is fully built but reports `not-configured` (HTTP `503`) until it holds
the live TVSS `X-PBSAUTH` key. That key is blocked on the external PBS-credentials
issues #191 and #206.

A candidate raw-TVSS-body-to-`ScheduleDay` transform is tested for display-field
parity against the reconciled WNJT providers-feed fixture. That fixture is from
the public JAWS lane, not the credentialed endpoint, so `resolveTransform()`
deliberately remains undefined. Before wiring or export, reconcile a sanitized
capture from the exact authenticated URL against the staged mapper; the function
remains unexported and undeployed until that check and the key both exist.

Reporting `not-configured` rather than shipping a stub keeps the endpoint honest
about what it can and cannot do today.

Because the live key does not exist yet, `scheduleProxy` is deliberately left out
of the functions deploy set: `functions/index.js` builds and tests it but does
not export it. `scheduleProxy` binds the `PBS_TVSS_AUTH` secret, and a Gen 2
function that binds a secret makes that secret a hard requirement of the whole
functions deploy, so exporting it now would fail every deploy until the blocked
key is provisioned. Leaving it unexported keeps the existing functions deploying
normally. To ship the endpoint once the key exists:

```bash
firebase functions:secrets:set PBS_TVSS_AUTH
```

then add the export to `functions/index.js`:

```js
exports.scheduleProxy = require("./schedule").scheduleProxy;
```

## Not in this boundary

- The TTL cache and the per-IP rate limit / bot challenge on the proxy: #254.
- The static schedule grid and the `/live` island that render this model: #281.
- The billing kill switch already gates the metered publish path; wiring it to
  the schedule read, if wanted, is a follow-up, not a launch dependency.
