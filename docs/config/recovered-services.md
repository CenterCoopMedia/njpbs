# Recovered service source

The NJ PBS coordinator owns source and future deployment of these four retained
services in this repository. Issue #92 and switch packet SURF-07 track adoption.
The public repository switch leaves their current versions, routing, runtime
settings and triggers in place.

| Service | Source | Retained deployment |
| --- | --- | --- |
| Media mail forwarding | `site/worker-media-fanout/` | Worker version 1, one Email Routing rule |
| Station subdomain redirects | `site/worker-subdomain-redirects/` | Worker version 2, nine routes |
| Former domain redirect | `site/worker-newnjpbs-redirect/` | Worker version 1, apex and www routes |
| Billing budget control | `infrastructure/billing-kill-switch/` | Function revision `billingkillswitch-00008-juv`, existing Pub/Sub trigger |

## Recovery proof

The November 14, 2026 provider reads supplied the version IDs and SHA-256 hashes
in `config/recovered-service-hashes.json`. Worker deployment IDs were checked
before and after each download. The billing ZIP was fetched using its immutable
GCS object generation. Its generation and ZIP hash are in the same manifest;
private bucket and account identifiers stay in the operator report.

Both redirect modules and the billing handler, package manifest and original
tests retain their deployed bytes. The billing test project ID is already
public in the repository. Two privacy changes are explicit:

- Media mail addresses now come from `MEDIA_FANOUT_ADDRESS` and
  `MEDIA_FANOUT_RECIPIENTS_JSON` Worker bindings. The latter is a JSON array of
  recipient strings in the original order. Missing or malformed configuration
  refuses forwarding. No recipient values are stored here.
- The billing lockfile's dependency deprecation message replaces its vendor
  contact address with a neutral label. Versions, resolved packages and integrity
  hashes are unchanged.

The private operator report records the one-time media source reconstruction
proof: substituting the live constants and removing the binding-loading code
reproduces the live module hash. This proves the retained handler text. The
hosted media contracts cover configured routing, all destinations after an
individual failure, normal success, wrong-address rejection and invalid bindings.
It does not claim the parameterized module is byte-identical to the live module.

The credential-free hash command is:

```sh
python3 scripts/check-recovered-service-hashes.py
```

GitHub-hosted `Recovered service source` runs it, the media contracts and the
recovered billing tests. Expected hashes come from provider bytes, with the two
privacy changes separately pinned. The check detects accidental recovery edits
identified in #92; full-diff review also checks the source. Replace each frozen
recovery pin when a reviewed change intentionally changes that service.

## Deployment remains disabled

`.github/workflows/recovered-services-deploy.yml.disabled` is a deployment
template. GitHub does not register files with that suffix. It adds no active
deployment route. Enabling it requires a separate reviewed change and deployment
authorization, with production environment protection and explicit identities.

Before the first media deployment, the coordinator must supply the two private
Worker bindings using the existing live addresses and order. The template takes
them as a single private `MEDIA_FANOUT_BINDINGS_JSON` secret map, provisions them
before upload, and retains unrelated variables. It uses the existing root-locked
Wrangler without downloading a tool in a credential-bearing step. Email Routing
rules and verified recipients remain separate provider configuration.

The redirect configs record the existing routes and compatibility dates.
The billing template requires explicit project, region, deploy account and WIF
settings. It requires the existing Pub/Sub function before updating source and
does not supply new trigger, runtime service-account, IAM, mode or threshold
settings. It stays separate from the Firebase index and normal CMS deployment.
Read back those retained settings during any separately authorized deployment.
