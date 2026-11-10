# Legacy njpbs.org 410/301 map (#260, ADR 0010 M7)

WNET ran njpbs.org before the domain transferred to MSU on 2026-06-29. The old
site left thousands of indexed paths that do not exist on the Astro site. This
module gives each known legacy path one of three results:

- `410 Gone` for a retired path with no current equivalent.
- `301 Moved Permanently` for a path with a live page that has the same subject
  and user intent.
- Pass-through for a current route, an asset, or an unknown path that a future
  release can use.

The safe default is pass-through. A missing entry cannot hide a current or
future page.

## Files

- `../../src/lib/legacy-redirects.ts` is the pure classifier and data map.
- `snippet.js` is the Cloudflare Snippet entry point.
- `runbook-lib.sh` contains the fail-closed API receipt and comparison helpers
  used by the deployment and rollback blocks below.
- `../../tests/legacy-redirects.test.ts` tests the path decisions and current
  route collisions.
- `../../tests/legacy-redirects-edge.test.ts` tests edge responses and query
  preservation.
- `../../tests/legacy-redirects-runbook.test.ts` tests the authorized missing
  entrypoint response and checks the documented Bash blocks.

The generated single-file Snippet is not stored in Git. The repository stores
source and tests, and the deploy operator builds the artifact from the reviewed
commit.

## Inventory receipt

The inventory was regenerated from the public Wayback CDX API using the request
below.

CDX request:

```text
GET https://web.archive.org/cdx/search/cdx
  ?url=njpbs.org*
  &output=json
  &fl=original,timestamp,statuscode,mimetype,digest,length
  &filter=statuscode:200
  &filter=mimetype:text/html
  &collapse=urlkey
  &to=20260628
  &limit=10000
```

Receipt:

- Requested once over HTTPS with redirects disabled, a 60-second timeout, and
  a 10 MiB response limit.
- Response completed at 2026-08-24 9:23:22 p.m. EDT with HTTP 200 and
  `application/json`.
- Raw result: 3,718 CDX rows and 589,612 bytes.
- Raw SHA-256:
  `82c315a21b78e151f8acabb5dad1d869f4529047d01237dc5151768d78a39447`.
- Normalizing host variants, repeated slashes, case, query strings, and trailing
  slashes produced 3,559 unique paths.
- The raw CDX JSON is derived data and is not stored in Git. The query, hash,
  counts, decisions, source paths, and tests are the durable receipt.

Thirteen selected Wayback replays were fetched with redirects disabled, a
20-second timeout, and a 2 MiB response limit. They confirmed the subjects of
the redirect candidates and representative 410s. The current target pages were
then probed at njpbs.org on 2026-08-24 between 9:25 and 9:28 p.m. EDT. Every 301
target returned 200.

The regenerated inventory divides as follows:

| Result | Paths | Basis |
|---|---:|---|
| Existing family and shape 410s | 3,476 | Retired families, oEmbed paths, pagination, and legacy children of live roots |
| Exact residual 410s | 55 | Archived HTML or endpoint with no current semantic equivalent |
| Hand-picked 301s | 9 | Archived subject matched to a live 200 route with the same intent |
| Deliberate pass-through | 19 | Current routes, podcasts, and asset paths |
| **Total** | **3,559** | All normalized CDX paths adjudicated |

## Permanent redirects

The Meeting notices rules redirect PDF paths below `/public-meetings/` to the
same filenames below `/meeting-notices/`, as required by #2800. Static notice
PDFs live in `site/public/meeting-notices/`. CMS library PDFs retain their
approved media-host URLs.

The operator must build and re-upload the reviewed Snippet with the procedure
below to activate these HTTP 301s. A site build does not upload the edge Snippet.
Verify both the old page and an existing old PDF URL after that release step.
The response preserves query parameters. Until the Snippet is updated, the old
static page remains a noindex refresh alias.

The Snippet keeps the request query string when the destination has no query of
its own.

| Legacy path | Last selected CDX capture | Destination | Evidence |
|---|---|---|---|
| `/all-programs` | 2023-06-27 03:43:03 UTC | `/watch/` | The archive is the all-programs browser; Watch is the current program and on-demand browser. |
| `/anywhere` | 2025-05-31 10:32:11 UTC | `/watch/` | The archive offers NJ PBS programs on supported devices; Watch provides the current PBS portal and device path. |
| `/app-support` | 2024-08-08 00:12:11 UTC | `/contact/` | The archive accepts app questions; Contact now says it routes PBS app and player questions. |
| `/closed-meetings` | 2025-06-28 10:57:58 UTC | `/meeting-notices/` | Both pages direct the reader to public-body meeting notices and records. |
| `/public-meetings` | Page rename (#2800) | `/meeting-notices/` | The same notice page has a new route. |
| `/eguide` | 2025-06-28 10:58:14 UTC | `/schedule/` | The archive says the eGuide ended and directs readers to the schedule. |
| `/help` | 2025-06-28 10:57:48 UTC | `/contact/` | The archive is a general help route; Contact is the current general help route. |
| `/how-to-watch` | 2025-06-18 00:12:23 UTC | `/watch/` | Both pages help viewers find NJ PBS video and viewing options. |
| `/index.htm` | 2004-08-31 08:36:17 UTC | `/` | Legacy home document to current home. |
| `/index.html` | 2004-06-20 03:25:07 UTC | `/` | Legacy home document to current home. |

Do not add a redirect only because a destination is in the same broad section.
For example, a retired sponsor page does not become a donation page, and a
retired program page does not become the general Watch page. Such a redirect is
a soft 404 and changes the reader's subject.

## The 55 exact 410s

These residual paths are exact matches. The live-route check runs before this
set, so an explicit future live route can still take priority.

```text
/about-teaching-channel-presents
/accessibility_statement.html
/api/ajax/ajax-hp-load-on-demand
/broadway-and-beyond
/careers
/classroom-close-up-nj
/coachs_network/index.htm
/connect-with-njtv-for-new-jersey-news
/docs
/documentary/treblinkas-last-witness
/due-process
/email-preferences
/email-preferences/confirmation
/footers/pbsis-footer.html
/funder-spots
/leadershipforum/leadershipforum.html
/links/index.htm
/midtown-men-pledge-special
/neal-shapiro-statement-to-the-community
/newsletters/index.htm
/nj-pbs-is-at-risk
/nj-spotlight-and-njtv-news-join-forces
/nj_success/index.htm
/njtv-benefit
/njvid
/on-the-record
/ournj
/ournj-signup
/private-preview
/rescuing-the-river
/search-results
/search.htm
/serving-new-jersey-into-the-future
/sfmc-proxy/njpbs_preference
/share-your-story
/shore-week
/sitemap.htm
/statement-from-the-wnet-group
/survey-of-media-consumption-habits
/teaching-channel-season-three
/teaching-channel-season-two
/upcoming_events/index.htm
/whats_new/index.htm
/why-sponsor
/x270
/x271
/x272
/x273
/x274
/x275
/x276
/x277
/x279
/x78
/your-election-2024
```

The old `/accessibility_statement.html` page is an NJ PBSIS and Rutgers site
statement. It is not the predecessor of the current NJ PBS accessibility page.
The `/x*` pages and the other underscored paths in this list are remaining NJ
PBSIS microsite pages.

## Family and shape 410s

- `/njtv-pressroom` and `/pbsoauth` at the root and
  below. `/pbsoauth/callback` is reserved for the current PMSSO callback and
  passes through.
- The 21 `LEGACY_TAIL_FAMILIES` at the root and below. These cover retired
  WordPress sections, NJTV/WNET sections, and the NJ PBSIS microsite.
- Any unprotected path ending in `/embed`.
- `/page/<number>` pagination stubs.
- Children of `/about`, `/kids`, `/live`, `/passport`, `/support`, and
  `/schedule`. Their bare current routes pass through.

The current `/posts/*`, `/authors/*`, `/programs/*`, `/events/*`, and `/wiki/*` namespaces pass
before shape rules. A current nested route under a held-back family must be
added to `LIVE_EXACT`, or supplied through `opts.live`, before it is released.

## Deliberate pass-through decisions

- `/podcast` and `/podcasts` pass through at the root and below. The CDX result
  contains seven episode paths and one series path. NJ PBS still makes those
  podcast subjects, so the namespaces can return in a later release.
- `/images` passes through at the root and below. The four captured paths are
  image assets. A content 410 must not answer an asset request.
- `/stylesheets/archive.css` passes through as an asset.
- Current exact routes pass through. Unknown paths also pass through so a later
  release can add them without first changing the edge map.

The 19 CDX paths that take the pass-through result are:

```text
/
/about
/images/glogo.jpg
/images/glogo2.png
/images/go-button-gateway.gif
/images/petabox-header.png
/kids
/live
/passport
/podcast/hazard-nj-first-a-miracle-then-a-curse
/podcast/hazard-nj-nothing-is-forever
/podcast/jazz-in-jersey-with-caelan-cardello
/podcast/off-exit-njs-food-influencers
/podcast/off-exit-noble-mushrooms
/podcast/off-exit-race-day
/podcast/surf-jam
/podcasts/off-exit-nj-pbs
/schedule
/stylesheets/archive.css
```

## Deployment prerequisite

Before deployment, confirm that the apex and `www` records are proxied, the
apex serves HTTPS through Cloudflare, and `www` redirects to the apex.

Deploy the repository artifact and attach its rule separately from the site build.

## Build and local verification

Run from `site/` after `npm ci --ignore-scripts`. The locked install supplies
esbuild 0.28.2. The flags below produce one minified ESM file with no source map
or legal-comment side file.

```bash
BUNDLE=/tmp/legacy_redirects_260.js

npx --no-install esbuild snippets/legacy-redirects/snippet.js \
  --bundle \
  --format=esm \
  --platform=browser \
  --target=es2022 \
  --minify \
  --legal-comments=none \
  --outfile="$BUNDLE"

node --check "$BUNDLE"
test "$(wc -c < "$BUNDLE")" -lt 32768
sha256sum "$BUNDLE"
npm test -- legacy-redirects
```

The deploy receipt must record the source commit, byte count, and SHA-256. Do
not add the generated file to Git.

## Snippet deployment

Cloudflare's current API requires `Zone > Snippets > Edit`. A code upload does
not run until a snippet rule points to it. The snippet-rules `PUT` replaces the
whole zone list, so the procedure saves and preserves every existing rule. See
the [Cloudflare Snippets API guide](https://developers.cloudflare.com/rules/snippets/create-api/).
The first API call lists Snippets and must succeed before any upload. It checks
that the token and zone plan can use the Snippets API.

On a first deployment, the rule-list endpoint has no `http_request_snippets`
entrypoint. Cloudflare returns HTTP 404 with error code 10003 in that exact
state. The helper accepts only that status and single error code as an empty,
absent rule list. It saves the raw body, HTTP status, entrypoint state, and
full rule payload separately. It also creates a canonical comparison list that
omits Cloudflare's server-managed `id` and `last_updated` fields. The full
payload remains the source for activation and rollback. All other HTTP, API,
JSON, and transport failures stop the block. An absent entrypoint is different
from a present entrypoint with zero rules, even though both canonical rule
arrays are empty.

Load the approved token into `CLOUDFLARE_API_TOKEN` without putting its value in
the command line or a file. Load the full reviewed commit SHA into
`APPROVED_SOURCE_SHA` and the deployment zone ID into `CLOUDFLARE_ZONE_ID`.
Export these values, then run the delimited Bash block
from `site/` as one command. The child shell creates the receipt directory after
it enables fail-closed options, prints the path immediately, and prints its exact
export command after success. A failed directory creation, build, validation,
concurrency check, or API call stops before any later mutation.

```bash
: "${CLOUDFLARE_API_TOKEN:?Load the approved NJ PBS Snippets token}"
: "${APPROVED_SOURCE_SHA:?Load the approved full commit SHA}"
: "${CLOUDFLARE_ZONE_ID:?Load the deployment zone ID}"

export CLOUDFLARE_API_TOKEN APPROVED_SOURCE_SHA CLOUDFLARE_ZONE_ID

bash <<'DEPLOY'
set -euo pipefail

ZONE_ID="${CLOUDFLARE_ZONE_ID:?Load the deployment zone ID}"
[[ "$ZONE_ID" =~ ^[a-fA-F0-9]{32}$ ]]
DEPLOY_DIR="$(mktemp -d)"
printf 'Deployment receipt directory: %s\n' "$DEPLOY_DIR" >&2

[[ "$APPROVED_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]
test "$(git rev-parse --verify HEAD)" = "$APPROVED_SOURCE_SHA"
test -z "$(git status --porcelain --untracked-files=all)"

SOURCE_SHA="${APPROVED_SOURCE_SHA:0:12}"
SNIPPET_NAME="legacy_redirects_260_${SOURCE_SHA}"
BUNDLE_NAME=legacy_redirects_260.js
BUNDLE="$DEPLOY_DIR/$BUNDLE_NAME"
API_BASE="https://api.cloudflare.com/client/v4/zones/$ZONE_ID/snippets"
RULE_DESCRIPTION="NJ PBS legacy URL map (#260)"

source snippets/legacy-redirects/runbook-lib.sh

npx --no-install esbuild snippets/legacy-redirects/snippet.js \
  --bundle --format=esm --platform=browser --target=es2022 --minify \
  --legal-comments=none --outfile="$BUNDLE"
node --check "$BUNDLE"
test "$(wc -c < "$BUNDLE")" -lt 32768
sha256sum "$BUNDLE" | tee "$DEPLOY_DIR/bundle.sha256"

cf_api_receipt GET "$API_BASE" snippets.before
jq -e --arg name "$SNIPPET_NAME" '
  .success == true and
  has("result") and
  (
    .result == null or
    (
      (.result | type == "array") and
      all(.result[];
        (. | type == "object") and
        (.snippet_name | type == "string") and
        .snippet_name != $name
      )
    )
  )
' \
  "$DEPLOY_DIR/snippets.before.json"

read_snippet_rules rules.before

cf_api_receipt PUT "$API_BASE/$SNIPPET_NAME" snippet.upload \
  --form "files=@$BUNDLE;filename=$BUNDLE_NAME" \
  --form "metadata={\"main_module\":\"$BUNDLE_NAME\"}"
jq -e --arg name "$SNIPPET_NAME" \
  '.success == true and .result.snippet_name == $name' \
  "$DEPLOY_DIR/snippet.upload.json"

read_snippet_rules rules.pre-activate
compare_saved_rules rules.before rules.pre-activate

prepare_snippet_rules rules.before rules.after rules.expected \
  "$RULE_DESCRIPTION" "$SNIPPET_NAME"

cf_api_receipt PUT "$API_BASE/snippet_rules" rules.activate \
  --header 'Content-Type: application/json' \
  --data-binary "@$DEPLOY_DIR/rules.after.body.json"
jq -e '.success == true' "$DEPLOY_DIR/rules.activate.json"

read_snippet_rules rules.live
compare_saved_rules rules.expected rules.live
jq -e --arg name "$SNIPPET_NAME" --arg description "$RULE_DESCRIPTION" '
  any(.[];
    .snippet_name == $name and
    .description == $description and
    .enabled == true and
    .expression == "http.host eq \"njpbs.org\""
  )
' "$DEPLOY_DIR/rules.live.canonical.json"

printf 'Deployment succeeded. Run: export DEPLOY_DIR=%q\n' "$DEPLOY_DIR"
DEPLOY
```

The Snippets list check requires the commit-derived name to be absent before
upload. This makes the upload a new artifact and gives rollback proof that it
can delete that artifact without removing pre-existing code. Do not continue if
the block exits nonzero. The pre-activation comparison checks both entrypoint
presence and the canonical rule list. A comparison failure means another
operator changed the zone after the backup, so a new backup and review are
required. After a successful block, run its printed `export DEPLOY_DIR=...`
command before the smoke-test or rollback block. If the block fails after
upload, use the receipt path it printed at startup to inspect the state and
perform rollback.

Smoke-test without following redirects:

```bash
bash <<'SMOKE'
set -euo pipefail
: "${DEPLOY_DIR:?Use the deployment receipt directory}"

test "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  'https://njpbs.org/all-programs?utm_source=issue260')" = 301

curl --silent --show-error --dump-header "$DEPLOY_DIR/redirect.headers" \
  --output /dev/null 'https://njpbs.org/all-programs?utm_source=issue260'
grep -i '^location: https://njpbs.org/watch/?utm_source=issue260' \
  "$DEPLOY_DIR/redirect.headers"

test "$(curl --silent --show-error --output /dev/null \
  --write-out '%{http_code}' 'https://njpbs.org/programs/issue-260-proof')" != 410

test "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  'https://njpbs.org/')" = 200
test "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  'https://njpbs.org/podcast/off-exit-race-day')" != 410
test "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  'https://njpbs.org/images/glogo.jpg')" != 410
test "$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  'https://njpbs.org/issue-260-future-route-proof')" != 410
SMOKE
```

Record the deploy directory, API receipts, live response headers, and test time.
Confirm the deployment only after these checks pass.

## Rollback

Rollback first compares the current rules with the saved pre-deployment or
expected activated state. It stops if neither state matches. If the original
entrypoint was absent, rollback uses Cloudflare's documented delete-all-rules
endpoint to remove the entrypoint and then confirms the same authorized 404 and
code 10003 state. If the original entrypoint was present, rollback restores its
exact rule list with `PUT`. If activation did not occur, rollback leaves the
matching original rules unchanged and removes only the uploaded code Snippet.

```bash
bash <<'ROLLBACK'
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?Load the approved NJ PBS Snippets token}"
: "${APPROVED_SOURCE_SHA:?Use the deployed full commit SHA}"
: "${DEPLOY_DIR:?Use the deployment receipt directory}"

ZONE_ID="${CLOUDFLARE_ZONE_ID:?Load the deployment zone ID}"
[[ "$ZONE_ID" =~ ^[a-fA-F0-9]{32}$ ]]
[[ "$APPROVED_SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]
test "$(git rev-parse --verify HEAD)" = "$APPROVED_SOURCE_SHA"
test -z "$(git status --porcelain --untracked-files=all)"
SOURCE_SHA="${APPROVED_SOURCE_SHA:0:12}"
SNIPPET_NAME="legacy_redirects_260_${SOURCE_SHA}"
API_BASE="https://api.cloudflare.com/client/v4/zones/$ZONE_ID/snippets"

source snippets/legacy-redirects/runbook-lib.sh

jq -e --arg name "$SNIPPET_NAME" '
  .success == true and
  has("result") and
  (
    .result == null or
    (
      (.result | type == "array") and
      all(.result[];
        (. | type == "object") and
        (.snippet_name | type == "string") and
        .snippet_name != $name
      )
    )
  )
' "$DEPLOY_DIR/snippets.before.json"
jq -e --arg name "$SNIPPET_NAME" '
  .success == true and .result.snippet_name == $name
' "$DEPLOY_DIR/snippet.upload.json"

validate_saved_rules rules.before
read_snippet_rules rules.rollback-current

if compare_saved_rules rules.before rules.rollback-current > /dev/null; then
  printf 'Rules already match the pre-deployment state.\n' \
    > "$DEPLOY_DIR/rules.rollback.action"
elif compare_saved_rules rules.expected rules.rollback-current > /dev/null; then
  restore_snippet_rules rules.before rules.rollback
  printf 'Rules restored from the pre-deployment receipt.\n' \
    > "$DEPLOY_DIR/rules.rollback.action"
else
  printf 'The current Snippet rules do not match a safe rollback state.\n' >&2
  exit 1
fi

read_snippet_rules rules.rolled-back
compare_saved_rules rules.before rules.rolled-back

cf_api_receipt DELETE "$API_BASE/$SNIPPET_NAME" snippet.delete
jq -e '.success == true' "$DEPLOY_DIR/snippet.delete.json"
ROLLBACK
```

After rollback, test the home page and the same redirect, Gone, podcast, image,
and future-route paths. Record their returned states. If any response reports
`cf-cache-status: HIT`, verify the zone cache policy and clear only the affected
cache entries through the approved production process before calling rollback
complete.
