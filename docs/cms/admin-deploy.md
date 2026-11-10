# Admin deployment contract

Use the [coordinated CMS release](staging-deploy-runbook.md) for a normal release.
Select the same full application SHA as the public publisher. This contract
describes supported behavior; deployment requires separate authorization.

## Source, session and command

Run from the repository root in Bash on an operator machine with Node.js 22,
the root lockfile installed, authenticated GitHub access and the approved
credential supplier. Configure both canonical repository inputs as described in
[repository identity](../config/repository-identity.md). The standalone command
also requires `CLOUDFLARE_TOKEN_ENTRY` to name an approved credential entry.
It must contain an entry name, never a token.

```bash
ADMIN_DEPLOY_CHECK=1 npm run admin:deploy
```

Check mode runs all four source/config/backend/status gates and reports every
verdict. It exits before reading the Cloudflare credential, building or uploading.
It still performs GitHub and backend reads; it is not an offline check.
The subsequent authorized deployment uses:

```bash
npm run admin:deploy
```

The command remains [scripts/deploy-admin.sh](../../scripts/deploy-admin.sh).
Do not replace it with a direct Wrangler upload that bypasses its gates.
The standalone source check requires clean `HEAD == origin/main`; an older
pinned release uses the coordinated workflow. Its unreviewed and rollback
overrides are not the normal pinned release method.

## Required order and refusals

| Order | Boundary | Required result |
| --- | --- | --- |
| 1 | Reviewed source | Clean working tree; independently configured repository name and numeric ID match origin; current main for the standalone command. A fork's main is not review evidence. |
| 2 | Build configuration | Vite's production `loadEnv` resolves every required input, emulator mode is off, project/auth domain agree, App Check is configured and the API URL is the exact allowed HTTPS bare origin. No path, query, fragment, port or trailing slash. |
| 3 | Backend | Account registration/request, broadcast schedule and navigation edge routes return unauthenticated 401. Direct navigation origin returns 403. Network errors or unexpected status stop upload. |
| 4 | Status manifest | Authenticated bounded milestone catalog is valid for the configured repository and selected build contract. Unreadable or invalid data refuses deployment. |
| 5 | Credential and Pages security | Fetch the provider credential only when needed. Production and preview both have `fail_open: false`. Resolve the pinned Wrangler package before exposing the token; deployment cannot install packages with the token in scope. |
| 6 | Artifact | Build `admin/dist` from that source; require `index.html`; deploy with the Admin config, production branch and exact artifact. |
| 7 | Readback | Both production and preview bind `STAFF_ACCESS` to the configured CMS API's `StaffSiteEntrypoint`. Read back the canonical deployment and build manifest. |

The standalone backend check does not prove authenticated settings readiness.
A new settings contract requires the coordinated workflow's settings proof.
GitHub tokens are removed from Node, npm, Vite and Wrangler subprocesses; only
the bounded manifest crosses into the build.

`AUTHOR_PAGES_LIVE` resolves production Environment, repository, then visible
organization settings. An unreadable catalog refuses. Only exact `true` enables
publication; an absent value or another value disables it. Removing an upper
scope setting can expose a lower scope value. The selected value overrides
local shell and dotenv inputs in both checking and building.

## Private guide and status boundaries

The public Admin root is an authentication shell, with noindex/nofollow/noarchive.
Its availability grants no CMS access. Guide Markdown and images below
`/guide-content/` require staff admission; tutorial video/poster/chapter objects
use `GUIDE_VIDEOS` behind the same Function. Verify the binding before release.

Root Pages middleware checks every request, including doubled/encoded slash
aliases, before static fallback. `_routes.json` must include `/*`. Keep Pages
production and preview fail closed: fail open can expose private static guide
assets after the Functions allowance is exhausted.

Public `/admin-status.json` contains build identity with null milestone fields.
The full catalog is staff-only at `/guide-content/admin-status.json`; Home and
Settings use an authorized Firebase bearer token. Cache and robots directives
do not provide admission. Revoked, disabled, pending and unauthorized sessions
cannot read that catalog. Rollback builds use their own manifest generator and
declared status schema rather than a newer generator copied over old source.

## Verification and recovery

After an authorized release, read both Pages deployment profiles and verify
the fail-closed setting and service entrypoint before opening private content.
Compare served build identity to the exact retained artifact, not the latest
main commit. The common [receipt view](staging-deploy-runbook.md#receipt-view)
replaces dated deployment claims.

Use GET and HEAD on `/media`, `/media/`, `/voiceovers` and `/voiceovers/`:
200, no redirect, `Cache-Control: private, no-store`. Unknown top-level paths and
missing assets return 404 without the Admin shell or immutable caching. Retained
deep editor prefixes may return the shell so the client can show Not found.
Real fingerprinted assets retain immutable caching, including non-HTML 304.
Errors, redirects and HTML fallbacks cannot inherit it. Keep the Pages rule
limit and the stricter build-test ceiling.

In an approved staff browser, open and reload deep links, check navigation and
settings, and verify guide admission on both the custom and Pages hostnames.
For any failed gate, repair its named source/config/backend problem and rerun
the same guarded path. Fix forward through reviewed source for incompatible
rollback trees. A successful upload alone is not signed-in acceptance.

## Public terms and attribution

Published term suggestions load on first Tags/Categories focus, once per mounted
Post editor, through authenticated `cmsListContent` with
`view: "published-vocabulary"`. Typing/selection/switching fields adds no request;
no listener, timer or persistent cache. Loading, failure, no match or overflow
never disables manual entry or creation of new terms. Matching ignores case/
outer spaces and preserves saved spelling; selected terms are omitted, duplicates
retain their notice, ordered primary terms and keyboard/live-status behavior stay.
Only authorized visible settled snapshots supply terms; no working/draft,
withdrawn/deleted/pending terms or `format:*` markers. Projection reads no blocks,
media or staff directory. At most 5,001 projected Posts (5,000 plus overflow
sentinel) are read, including excluded/draft rows; overflow is 413 with no partial
vocabulary. Media vocabularies/registries and access groups remain separate.
Lookup or author-readiness failure is not proof a term/profile is absent.
Spotlight attribution controls, Functions boolean validation and public readers
ship as one compatible release: deploy the validation/snapshot contract before
the control, then verify checked/unchecked values in every Post format,
listings and Home at desktop and phone widths.

## Internal preview artifacts

Name-atlas and politics preview assets belong to internal CI/preview artifacts,
not ordinary public or development publication. Preserve their internal build
selection, noindex treatment, asset paths and credential-free fixture modes.
Keep preview evidence separate from public delivery proof; do not treat the
presence of a preview artifact as permission to publish it.

`INTERNAL_SURFACES` is opt-in, but cannot override `PUBLIC_ONLY`, production
Workers, public publication or frozen CMS-preview exclusions. Apply the same
gate to every child endpoint, bundle and data file; scan emitted content as
well as route names so renaming a payload cannot bypass exclusion. No research
belongs in public assets/shared bundles. Sitemap/search/analytics exclusion and
noindex are secondary measures, never authentication. Local private artifact
review records exact source, search/navigation/history/reload, keyboard/focus and
phone layout. Hosted review requires its own authenticated deployment.
Research changes use reviewed source/fingerprint updates; never hand-edit
compressed payloads or infer editorial identity from matching names. Local
static-output checks cannot establish live admission or completed research audit.
