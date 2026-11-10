# Problem report worker

This Worker validates problem reports, verifies Turnstile, limits request rates,
and forwards normalized reports to a configured intake endpoint. Authentication
values belong in Worker secrets. Configure the intake URL and access credentials
for the receiving service before use.

The public widget uses `PUBLIC_REPORT_ENDPOINT` and `PUBLIC_TURNSTILE_SITEKEY`.
The Worker owns no report store or messaging-bot credential. Its configured
intake must acknowledge durable acceptance; an unreachable intake returns 502.

## Request order

1. Handle CORS/OPTIONS and the supported report method, then enforce body byte
   limits and parse the request. Unsupported method is 405; invalid/oversized
   input is 400/413.
2. Silently accept/discard honeypot-filled or under-three-second submissions
   with no downstream call; then validate category and minimum report text.
   These 200/400 results occur even on a misconfigured deployment, so they are
   not configuration-health proof.
3. Validate origin/intake and required `IP_HASH_SALT`, `TURNSTILE_SECRET` and
   `INTAKE_SECRET` before quota writes. Missing/malformed required configuration
   returns 500. Optional Access headers are omitted when their values are unset;
   a protected intake can then refuse forwarding and produce 502 instead.
4. Apply the KV per-IP ten-per-hour limit before Turnstile, bounding verification
   calls. The code skips that limiter when KV is absent; deployment must provide
   the required binding rather than treating that fallback as production proof.
5. Verify Turnstile and require the returned solving hostname to match
   `ALLOWED_ORIGIN`. Missing hostname refuses. Do not claim action binding unless
   the widget and verifier actually supply/check a report-specific action.
6. Forward only normalized report and salted truncated IP hash. Use the intake
   Bearer and, where required, Access service token. Neither reaches the browser.

The widget keeps Send disabled until verification, preserves the draft for
supported transient retry, announces errors and restores focus when recovery
controls disappear. Unknown/configuration failures offer the configured support
route rather than an ineffective retry.

## Configuration and release

Supply `RATE_LIMIT_KV_NAMESPACE_ID` and `REPORT_INTAKE_URL` before rendering
`wrangler.toml`. Follow [Wrangler rendering](../../docs/config/wrangler-rendering.md)
from the repository root: raw templates cannot be deployed directly. Preserve
`workers_dev=false` and `preview_urls=false`; the custom domain is managed
separately and a script redeploy does not reauthorize its attachment.

The private operator step verifies the approved account/domain/intake and
credential routing before any write. Provision `TURNSTILE_SECRET`,
`INTAKE_SECRET`, `IP_HASH_SALT`, `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET` through secret stdin at moment of use. Keep namespace
IDs and credential values outside source. Remove generated config afterward.

Deploy only with separate authorization and read back exact Worker version,
rendered bindings and custom-domain ownership. Use fake-forward/Turnstile/limit
tests for local proof; a real report or notification is a separate authorized
delivery exercise. Logic and fixtures live in `report-intake.ts` and
`../tests/report-worker.test.ts`.

## Recovery

Preserve origin, hostname verification and private intake gates on rollback.
Detach the custom domain to stop direct intake under incident authorization;
removing the site widget alone cannot contain direct POSTs. Do not rotate an
intake Bearer merely to contain spam. For actual compromise coordinate the
receiving verifier first and both this Worker and the
[publisher alert relay](../../docs/cms/publisher-alerts-deploy.md), then verify
both paths before declaring recovery. Never log report text, credentials or
private intake details as deployment evidence.
