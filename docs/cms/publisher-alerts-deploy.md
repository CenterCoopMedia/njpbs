# Publisher alert relay contract

The [relay](../../publisher/alerts.ts) is independent of the publisher container.
It accepts only the configured authenticated healthcheck webhook and forwards a
bounded report to `ALERT_INTAKE_URL`. It holds no messaging-bot credential.
Deployment and notification delivery each require separate authorization/proof.

## Configuration and release order

Use [publisher/wrangler.alerts.jsonc](../../publisher/wrangler.alerts.jsonc).
Supply account and intake endpoint before deploy, using the existing bindings;
do not add a request-time private configuration lookup. Keep workers.dev and
preview URLs disabled. The private operator step provisions the approved
webhook/receiving service and credential routing before the following order:

1. Deploy the compatible durable intake consumer first and verify its schema
   and authentication behavior.
2. Provision `ALERT_WEBHOOK_SECRET`, `INTAKE_SECRET`, `CF_ACCESS_CLIENT_ID` and
   `CF_ACCESS_CLIENT_SECRET` through secret stdin at moment of use. No values
   belong in command arguments, files or logs.
3. After root locked dependencies resolve the pinned Wrangler, deploy reviewed
   source with the explicit nonsecret overrides below from root operator Bash.
   The checked-in empty `vars` are not populated from shell variables by Wrangler.
   Read back exact version/config and both effective variables.
4. Confirm healthcheck is HTTPS GET, certificate checked, no redirects, expected
   200 and healthy status; notification policy covers only this publisher check.
5. Use an authorized non-disruptive webhook test and separately approved
   failure/recovery/retry exercise. Never break the live publisher to test alerts.

After the private credential step and separate deployment authorization:

```bash
set -euo pipefail
: "${CLOUDFLARE_ACCOUNT_ID:?Supply the approved account identity}"
: "${ALERT_INTAKE_URL:?Supply the approved intake endpoint}"
npx --no-install wrangler deploy --config publisher/wrangler.alerts.jsonc \
  --var "CLOUDFLARE_ACCOUNT_ID:$CLOUDFLARE_ACCOUNT_ID" \
  --var "ALERT_INTAKE_URL:$ALERT_INTAKE_URL"
```

Resolve packages before fetching the scoped deployment token; `--no-install`
prevents an empty cache from downloading package/install code with it in scope.
These two overrides are deployment inputs, not credential values. Do not print
their effective private values into public source or release evidence.

Report intake and this relay share the downstream Bearer/Access service token.
Rotate downstream first and both Worker copies together, prove both paths,
then revoke the previous service token. Do not provision retired direct-bot
secrets or assume one Worker's deployment rotated the other.

## Identity, ambiguity and recovery

Structured start/end or explicit healthy/unhealthy state determines transition.
Unknown state remains unclassified triage, never implied recovery. Valid
correlation/check/time after `ALERT_TRANSITION_CUTOVER` yields a stable transition
key; retries of that transition retain it and later recurrence gets a new key.
Delivery time never participates. Legacy/missing/invalid timestamps retain the
documented degraded correlation identity; do not promise recurrence delivery.

The cutover remains fixed for the lifetime of an active deployment. A new
identity transition requires a reviewed future boundary, 100% active version
readback and allowance for in-flight old requests before that boundary. Missing
that allowance stops qualification. Never silently move an already used cutover
or rewrite stored reports. Recovery does not close issues or alter a failure's
handled state. Informational webhook tests have their own submission identity.

Relay success requires durable intake acceptance with matching report ID; it
does not establish actual notification delivery. Keep the receiving outbox's
bounded retries and unknown-outcome reconciliation. Crash between delivery and
receipt can still duplicate a notification; retain the same report/action guard.
Verify durable report readback, intended failure/recovery controls and eventual
delivery separately. Do not replay historical live alerts as a test.
