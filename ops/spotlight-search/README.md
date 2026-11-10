# Spotlight indexed search

This WordPress adapter uses Relevanssi Free **4.28.4** to search public title,
body, summary and Co-Authors Plus display-name fields. Positive normalized terms
use AND across those fields. Quoted phrases and excluded terms retain their
constraints. Exclusion-only queries return no matches and never scan the archive
body. The adapter returns IDs in descending date and ID order, with one extra
result for pagination. Visibility is checked again against current posts.

## Deployment configuration

Set `NJSPOTLIGHT_BLOG_ID` and `NJSPOTLIGHT_SEARCH_PAGE_ID` to positive IDs for your
installation before PHP starts. The adapter reads them once at bootstrap;
missing or invalid settings leave it inactive. `.env.example` contains only
placeholders and is not loaded automatically. The shortcode reads the same
bootstrap settings in either load order and renders only on the configured site
and page. A missing indexing adapter retains the unavailable message and header
search redirect.

Install Co-Authors Plus and the pinned Relevanssi version for the intended site.
`configure.php` enables only public content types and public display names. It
disables query logging, comment and custom-field indexing, shortcode expansion,
automatic excerpts, highlighting, fuzzy matching and OR fallback. Technical
login names and author emails are excluded. Other native WordPress searches keep
their own query path.

`index-batch.php` builds a resumable index with a bounded batch size. It records
the adapter source hash and refuses to resume after that source changes. Keep
`spotlight_search_ready` false until index coverage and behavior are verified.
The query requires that readiness option and the exact vendor version. Missing
providers, SQL errors and the two-second MariaDB statement limit produce the
unavailable state. Positive terms use individual `EXISTS` lookups with subquery
materialization disabled; they do not hydrate or rank every matching body.
Quoted author names use Unicode caseless literal matching. A search accepts at
most eight positive and excluded phrases combined. Each phrase reads at most
101 author candidates and resolves at most 100 display names; the extra candidate
detects overflow. Overflow, failed lookups and invalid Unicode refuse the search
without running the article query, including for exclusions.
This budget counts all candidate rows: Co-Authors Plus also stores login and
email fields in its search descriptions. Even a phrase matching only those
fields must refuse on overflow rather than return a partial author set. Only
the resolved public display name can contribute an author match.
Queries with too many quoted phrases ask the reader to use at most eight,
instead of suggesting a retry.

Author assignment and display-name changes save durable refresh jobs after
Co-Authors Plus clears its caches. Shutdown starts at most 25 refreshes within
a one-second budget. The `spotlight_search_refresh_jobs` hook starts at most
100 within two seconds and saves a continuation before work. Failed jobs remain
for retry. Configure an external WordPress cron runner to drain these events;
no public request fetches deployment settings. `refresh.php` runs only these
jobs. It does not dispatch unrelated WordPress cron. Initial indexing and refresh
share a lock scoped to the configured blog ID.

## Isolated integration checks

`integration-test.php` runs only through WP-CLI at
`http://search-fixture.example.test` on the configured fixture blog. It creates
synthetic users, 18 synthetic archive articles from `corpus-sample.jsonl` and
additional privacy, query, pagination and lifecycle records. Never point it at
a real installation. Use a disposable WordPress database with outgoing mail
and external HTTP disabled and no published service ports. Load the adapter,
Co-Authors Plus 4.1.1 and Relevanssi 4.28.4, then run these as separate WP-CLI
requests from a fixture where this directory is available:

1. Evaluate `configure.php`, then `integration-test.php seed`.
2. Evaluate `index-batch.php` in batches until `spotlight_search_build.complete`
   is true. Enable `spotlight_search_ready` in that fixture only.
3. Evaluate `refresh.php` until `integration-test.php jobs` reports zero.
4. Evaluate `integration-test.php assert`, `assert-retry` and
   `assert-index-failure` separately.
5. Evaluate `integration-test.php mutate`, then `assert-queued`; drain refresh
   jobs and evaluate `assert-fresh`.

The tests exercise real vendor indexing, stale nonpublic rows, mixed-field
queries, numeric and phrase tokens, SQL-looking input, retained retry jobs,
separate-connection lock contention, an actual failed INSERT, and author changes
across requests. The synthetic mixed-field oracle places `riverbyline` only in
the public author name and `railroad` in article text. These fixtures prove
behavior and do not establish production corpus coverage or latency.

From the repository root, lint the PHP sources before using the fixture:

```sh
python3 -m unittest discover -s ops/spotlight-search -v
php -l ops/spotlight-search/configure.php
php -l ops/spotlight-search/index-batch.php
php -l ops/spotlight-search/refresh.php
php -l ops/spotlight-search/spotlight-indexed-search.php
php -l ops/spotlight-search/spotlight-local-search.php
php -l ops/spotlight-search/integration-test.php
```
