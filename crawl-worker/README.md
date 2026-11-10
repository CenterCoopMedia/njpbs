# Own-site crawl worker

This disabled-by-default Worker extracts static HTML from `https://njpbs.org`
and maps advertised sitemaps. It accepts only authenticated POST requests to
`/scrape` and `/map`. The URL allowlist, robots policy, rate limiter, byte limits,
redirect limits and total deadline apply before results are returned. Linked
pages are reported without recursively fetching them. Logs contain aggregate
counts and status only.

Deployment supplies `CRAWL_TOKEN` as a Worker secret and explicitly enables
`CRAWL_ENABLED`. Keep the token out of source and command arguments. The checked-in
`wrangler.jsonc` is a template. Supply `CRAWL_RATE_LIMIT_NAMESPACE_ID` to the
deployment process and render it with `scripts/render-wrangler-config.mjs` from
the repository root before invoking Wrangler. See
[Wrangler configuration rendering](../docs/config/wrangler-rendering.md). Missing authentication
or rate-limit bindings keep the Worker disabled. No account or namespace lookup
runs on an incoming request.

From this directory, install locked dependencies and run the offline tests:

```sh
npm ci --ignore-scripts --prefer-offline --no-audit --no-fund
npm test
node --check src/index.mjs
node --check src/content.mjs
node --check src/policy.mjs
```

This package contains JavaScript modules and has no TypeScript typecheck script.
The upstream notice in `LICENSE.upstream` covers the adapted extraction code.
