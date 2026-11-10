# NJ PBS site

The public website is an Astro static site. Shared rendering and content helpers
live in `../packages/content-core`, and browser search helpers live in
`../packages/browser-search`.

The complete workspace includes the backend modules in `functions/`, the admin
sources, root build scripts, QA helpers, and workflow tools. Integrate these
companion sources together before running the commands below. This directory
uses their shared contracts and is not a standalone npm project.

Install dependencies from the repository root lockfile, then from the site
lockfile. Use Node 22.

```sh
npm ci --ignore-scripts
npm --prefix site ci --ignore-scripts
cd site
npm run check
npm test
npm run build
```

Builds that need content services require their environment configuration.
`CMS_OFFLINE_BUILD=1` uses retained content without remote content reads.
`PUBLIC_ONLY=1` builds the small public landing page and public wiki.

The published schedule snapshot is tracked in `src/data/schedule.json` and used
by site builds. `NOTICE` excludes schedule data from the MIT license grant.
Schedule feed credentials remain configured secrets and must not enter source.

## Configuration

Cloud operations read `CLOUDFLARE_ACCOUNT_ID` from the environment. Public
activation and retirement also require `CLOUDFLARE_PUBLIC_ZONE_ID` and
`CLOUDFLARE_PUBLIC_WORKER_TAG`, each a 32-character lowercase hexadecimal pin.
Supply these process settings before starting the operator; missing or malformed
settings refuse provider access. The publisher preparation command also renders
the Worker tag into its binding, which the container forwards and validates at
startup, including preflight. The deploy-preparation CLI requires the tag before
producing a deployable configuration; its exported helper allows image-only
callers to omit the tag. Analytics uses the separate Functions parameter
`CMS_ANALYTICS_CF_ZONE_ID`, which has no default zone. Development
publication also requires the independent `CMS_DEV_CLOUDFLARE_ACCOUNT_ID` pin;
the active and expected account must match. Replace the
placeholder account configuration before using those operations. Direct uploads
use `PUBLIC_SHARE_UPLOAD_ORIGIN`, an exact origin rather than a wildcard.
Configure the same origin in the public response headers and the public worker
bundle. Email routing destinations are supplied through Worker bindings; see
`worker-fanout/README.md`. Never commit credentials or unpublished personal addresses. Published public
contact addresses remain part of the public page contract.

## Public wiki

Only Markdown pages with `public: true` in frontmatter belong in the root wiki
bundle. The routes filter by that flag. Links to omitted pages are rendered as
plain text. Wiki pages have `noindex`, are excluded from the sitemap, and are
excluded from the site search index.

## Public content

The site distinguishes the station operator from the license holder. Preserve
accessibility, valid current destinations, and the approved public copy. Shared
logic has unit tests in `tests/`; browser search tests also run with the site
Vitest configuration.

The data hub's public route uses the publisher and public renderer contracts.
Release the publisher, renderer and CMS from the same pinned source commit.
The route needs no separate variable or secret change. Deployment requires
separate authorization.

## Browser checks

The required Site CI consumer runs `qa/axe_scan_browser_test.py` against both
existing build targets before they are replaced. It checks emitted-route
console/page errors, native homepage scrolling and mobile Menu/Escape behavior
in the full target; the coming-soon target checks scene selection, rotation,
pause/resume and reduced motion with a controlled browser clock. The full target
also verifies search readiness and runs `qa/axe_scan.py` over every emitted route.
Both use installed, sandboxed Chrome. See `qa/README.md` for commands.
