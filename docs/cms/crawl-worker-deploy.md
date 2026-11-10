# Own-site crawl deployment contract

The [crawl package](../../crawl-worker/README.md) extracts allowed static public
HTML and advertised sitemaps. It stays disabled by default. Enabling/deploying
it requires separate authorization; a source change authorizes neither.

## Inputs and order

1. Use exact reviewed source and the package lockfile in a credential-free
   development shell for offline policy/extraction tests.
2. The private operator step verifies account, approved endpoint plan and scoped
   deployment credential, then provisions `CRAWL_TOKEN` as a Worker secret.
3. Supply `CRAWL_RATE_LIMIT_NAMESPACE_ID` to the deployment process. It is a
   Workers rate-limit namespace, not KV. Render
   [crawl-worker/wrangler.jsonc](../../crawl-worker/wrangler.jsonc) from the root
   before Wrangler using [configuration rendering](../config/wrangler-rendering.md).
   Raw templates do not expand environment variables.
4. Keep the generated config beside its template with private permissions;
   remove it on success/failure. Hard termination needs explicit ignored-file
   cleanup before leaving. Token values never enter the config or arguments.
5. Deploy/read back the approved reviewed version, limiter binding, route and
   explicit `CRAWL_ENABLED` selection. Missing auth/limiter keeps it disabled.

## Serving and recovery

Only authenticated POST `/scrape` and `/map` are supported. URL allowlist,
robots policy, rate/byte/redirect limits and total deadline apply. Report linked
pages without recursively fetching them. Logs contain aggregate counts/status,
never raw fetched bodies, credentials or private content. Configuration resolves
before serving, without account/namespace lookups per incoming request.

Verify wrong-token/disabled/foreign-URL/malformed/limit denials with controlled
fixtures; real crawling is a separate metered operation. Restore a reviewed
version/config through the same rendering path and recheck actual binding and
denials. Do not bypass robots, increase limits or enable it to make proof pass.
