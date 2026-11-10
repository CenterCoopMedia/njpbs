# Development gateways and small Worker contract

Each gateway keeps its own identity, bindings, route owner and non-delivery
proof. A source change does not authorize a route, Access, DNS or provider write.
Use the [release contract](staging-deploy-runbook.md) for source/receipt handling.

## Development publication

The development public Worker is reachable through `DEV_PUBLIC` after the staff
gateway's admission. It has no public route, workers.dev URL or preview URL.
`cms-dev-publish.yml` owns the existing development publication queue, frozen
inputs and non-cancelling writer concurrency. Its exact paths/events are in
the [workflow](../../.github/workflows/cms-dev-publish.yml). Wiki-only changes do
not publish because that artifact omits the wiki. Internal guide/design previews
remain CI artifacts; development publication excludes them and analytics.

Development Admin is a separate Pages artifact. Its public-site origin must
match the configured staff gateway. Credentialed Home-source/receipt CORS admits
only the configured development Admin origin. Keep catalogs behind Access and
current staff checks: development-only titles, summaries, categories, tags and
bylines are not an anonymous receipt surface. Machine publication uses a
separate development identity; no production credential crosses this boundary.

## Route transaction

Use [guard-dev-routing-change.mjs](../../scripts/guard-dev-routing-change.mjs)
from the exact reviewed checkout in Bash on the authorized operator machine.
Its apply command is:

```sh
DEV_ROUTING_CHANGE_APPROVED=true node scripts/guard-dev-routing-change.mjs \
  /private/dev-change.json /private/dev-change-receipt.jsonl --apply
```

The private plan supplies the approved exact operation and existing route
identity; it is not committed here. Run the guard's preflight before the change
and preserve its post-change refusal proof. It does not purge caches, rotate
credentials, change Access or delete an old origin on the operator's behalf.
No literal approval variable substitutes for the separately authorized plan.

## Anonymous refusal and admitted readback

Before a manual proof, supply the approved `CMS_DEV_ADMIN_ORIGIN`,
`CMS_DEV_PUBLIC_ORIGIN` and `CMS_DEV_ACCESS_ORIGIN` plus every other named input
required by [development rendering](../config/development-rendering.md). Render
and verify a **disposable checkout** using that documented method, then run
tools from its repository root. Never probe neutral template hosts or commit
rendered source. Missing input/render preparation is a setup refusal, not proof
of access failure. The HTTP probe needs no staff credential, but does require
this configured target/Access-origin preparation. Its commands remain:

```sh
node scripts/check-dev-anonymous-refusal.mjs
node --test tests/scripts/dev-access-guards.test.mjs
```

GET and HEAD cover Home, the fixed removed Post, publication receipt and static
logo on both development hosts. Every response must be the exact configured
Access login redirect or the gateway's precise 401/403 privacy contract. Do not
follow redirects. A generic WAF/bot denial, 2xx, public/cacheable response,
unexpected status or transport failure fails proof. Bodies are compared only
in bounded memory; never print credentials, cookies or response bodies.

The [anonymous-refusal workflow](../../.github/workflows/dev-anonymous-refusal.yml)
is detection, not a guaranteed response time. Read its current schedule and run
receipts rather than asserting a dated deployment state. A setup/timeout failure
is infrastructure failure; it is not itself proof of anonymous exposure.

After an authorized development publication, compare active deployment/version
to retained `deployment.json`, queue, build batch and `system/publicDeployment`.
Through the admitted gateway compare publication/content-status, Home and
affected Posts to the retained artifact, with active-version reads before and
after. Removed content must be absent at its ordinary URL. Check HTML/assets,
machine GET/HEAD admission, and staff Home shelf/hero previews separately.
Source and machine receipt tests alone do not establish the staff browser result.

## Small Worker ownership and recovery

| Component | Contract | Recovery boundary |
| --- | --- | --- |
| Report intake | [Report Worker](../../site/worker/README.md) | Configured intake, Turnstile, KV, scoped Access credentials and exact origin; no real report for smoke. |
| Share intake | [Share Worker](../../site/share-intake/README.md) | Functions first, quarantine fencing and completion leases; never reset accepted reservations. |
| Email fan-out | [Fan-out Worker](../../site/worker-fanout/README.md) | Keep durable per-destination receipts and verified configured recipients; no test delivery without authorization. |
| Publisher alerts | [Alert relay](publisher-alerts-deploy.md) | Durable ambiguous outcomes need reconciliation before retry. |
| Crawl service | [Crawl Worker](crawl-worker-deploy.md) | Token, limiter namespace and enable flag remain scoped to this Worker. |

Restore the previous reviewed version/configuration only through its guarded
deployment path. Recheck route/binding ownership and non-delivery behavior
afterward. A generic provider success does not prove a component's contract.
