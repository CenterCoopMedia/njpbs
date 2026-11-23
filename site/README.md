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

Public builds prepare the five licensed PBS Sans font files at
`public/brand/fonts/`, which is ignored by Git. The build downloads them from
the public station site and verifies the checked-in SHA-256 manifest at
`scripts/public-fonts.json`. Cached files are verified on every build.
Before a development server, standalone renderer, offline or frozen build, run
`node scripts/prepare-public-fonts.mjs` once with network access. Offline and
frozen builds never download fonts: missing or corrupt files stop the build.
CI restores the manifest-keyed cache and runs that same preparation command
before renderer checks. Font bytes remain outside the code license and Git.

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

### NJ Spotlight News archive

An approved archive Post has `spotlightArchive: true` in its published metadata,
with the original station-local day in `date` and `editorialDateSource` set to
`backdated`. It uses the ordinary canonical Post URL, published credits and CMS
blocks. The Pagefind index drives keyword, topic and publication-year searches
at `/search/spotlight-archive/`. The archive stays out of the latest Posts,
homepage selections and released-content feeds.

When the archive export supplies `postDateUtc`, the approved snapshot can carry
it as `archivePublishedAt`. Boardwalk preserves it on later publishes and uses
it for `article:published_time` and `NewsArticle.datePublished`. The byline still
shows the original local day. If the source UTC time is absent, JSON-LD uses that
day and the page omits `article:published_time`.

### Archive route comparison

Use `compare:archive` from `site/` with two anonymously readable origins and
the paths to check on both. Include original permalinks, aliases and their
direct canonical destinations, plus representative unavailable paths.

```sh
npm run --silent compare:archive -- https://before.example.org https://after.example.org /blog-post/story/ /posts/story/
```

Save the JSON lines from stdout with the migration evidence. Each has both
HTTP statuses, literal Location and X-Robots-Tag headers, and metadata from
200 HTML responses. Metadata includes the title, canonical links, description,
publication-time tags, article timestamps, robots and refresh directives, and
parsed JSON-LD.
The command records redirects without following them. Compare the alias's
Location with the direct destination row to verify one hop. Exit status 1
indicates a difference or a read error. Review each difference against the
expected migration, including intentional redirects.

## Data Hub figure embeds

Open a figure in `/data-hub/` and select **Copy embed**. The iframe shows the
selected chart or headline number, source note, snapshot date and an NJ PBS link.
The default **Keep this published version** includes a dated `revision`; **Use
latest approved data** omits it. Both work on another website. These standalone
documents run no scripts, load no analytics and set no cookies.
The embed preview shows the published comparison served by that URL. Downloads
retain the comparison selected on the Data Hub.

The route `/data/figures/<id>/embed/?view=chart&revision=2026-11-09` selects a
saved source snapshot in `src/data/data-hub-revisions/`. Missing figures,
revisions and unsupported views return 404. `view=number` selects the headline
number. A source build renders these documents with the same code as the dialog
preview; it does not use a second chart renderer. The existing Data Hub build
flag controls route emission.

When publishing new data, retain every saved JSON snapshot, add the new dated
snapshot, and update the reader's source payload and `asOf` date together. Each
date identifies one immutable source snapshot. Never change an existing dated
file. The public Worker maps revision/view query parameters to the emitted
documents and applies the frame and privacy headers only to this route family.
The legacy redirect classifier passes this family through its WordPress embed
rule; a release must include the classifier's edge artifact as well as the
public Worker and site assets.

## Browser checks

The required Site CI consumer runs `qa/axe_scan_browser_test.py` against both
existing build targets before they are replaced. It checks emitted-route
console/page errors, native homepage scrolling and mobile Menu/Escape behavior
in the full target; the coming-soon target checks scene selection, rotation,
pause/resume and reduced motion with a controlled browser clock. The full target
also verifies search readiness and runs `qa/axe_scan.py` over every emitted route.
The PR preview build also uses a synthetic launch catalog to verify the program
and episode pages and their Pagefind entries at phone and desktop widths. The
browser checks use installed, sandboxed Chrome. See `qa/README.md` for commands.
