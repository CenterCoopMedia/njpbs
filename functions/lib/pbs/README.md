# PBS proxy interface

Cloud Functions provide the server-side TV schedule adapter for the static
NJ PBS site. The public Media Manager catalog uses its own build-time fetch.

## Modules behind the boundary

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

The schedule handler is built but remains unexported.

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
