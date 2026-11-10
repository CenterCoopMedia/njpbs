# Render Wrangler configuration before deployment

Wrangler does not substitute `${NAME}` inputs in these checked-in templates.
Supply inputs to the deployment process and run `scripts/render-wrangler-config.mjs`
before invoking Wrangler. No provider lookup runs during rendering or on a request.

| Template | Required deployment environment input | Accepted form |
| --- | --- | --- |
| `workers/wrangler.shadow-posts.jsonc`, default profile | None | Inactive profiles are omitted |
| `workers/wrangler.shadow-posts.jsonc`, `--env kv` | `SHADOW_POST_REVISIONS_KV_NAMESPACE_ID` | Nonzero, 32-character lowercase hexadecimal KV namespace ID |
| `site/worker/wrangler.toml` | `RATE_LIMIT_KV_NAMESPACE_ID` | Nonzero, 32-character lowercase hexadecimal KV namespace ID |
| `site/worker/wrangler.toml` | `REPORT_INTAKE_URL` | HTTPS endpoint with path exactly `/api/report`, without credentials, port, query or fragment; no `example.org`, `example.com` or `example.net` host or subdomain |
| `crawl-worker/wrangler.jsonc` | `CRAWL_RATE_LIMIT_NAMESPACE_ID` | Positive integer expressed as a string |

The crawl namespace is a [Workers rate limiting namespace](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
which differs from a KV namespace. The renderer refuses missing inputs, placeholders,
zero namespace IDs and malformed values. Input strings containing `replace`,
`placeholder` or `template` are refused as template values. Input refusals name the configured input
without printing its value; parser and filesystem failures use a generic error.

Run this block from the repository root in Bash after separately authorizing a
deployment and supplying its inputs. Choose one template and the matching profile:

```bash
set -euo pipefail
rendered="$(node scripts/render-wrangler-config.mjs --config crawl-worker/wrangler.jsonc)"
trap 'rm -f "$rendered"' EXIT
npx --no-install wrangler deploy --config "$rendered"
```

For the optional shadow KV profile, pass `--env kv` to both the renderer and
Wrangler. Ordinary shadow deployments pass neither; their generated config has
no KV binding and does not require the optional namespace input. The existing
shadow workflow renders and cleans up its default config automatically.

Generated `.wrangler-rendered-*` files have mode `0600`, are ignored by Git, and
stay beside their templates so relative entry points, assets and schema paths
keep their meaning. Only the generated path is printed. The original template
is unchanged; remove the generated file even if the deployment fails. Hard
termination can leave an ignored file behind; delete it before leaving the
workspace. Keep credentials in the provider's existing secret bindings.
