# Spotlight most read

This WordPress package displays four ranked stories in the homepage sidebar and
a ten-story standalone page. The existing popular REST response and legacy
consumer share the saved ranking. Co-Authors Plus supplies assigned display
names to the cards and explicit RSS byline fields; account-only fallback names
are omitted. Shared styles preserve keyboard focus and fit whole sidebar cards.

## Configuration

Configure these environment values before PHP starts. The plugin reads them
once at bootstrap and stays inactive when a required value is missing or invalid.
`.env.example` lists placeholders; it is documentation, not an automatically
loaded settings file.

- `NJSPOTLIGHT_BLOG_ID`: positive WordPress blog ID for this installation.
- `NJSPOTLIGHT_CONTEXT`: `production` to enable the Most read integration.
- `NJSPOTLIGHT_POSTING_ACCOUNT`: technical posting account display name to omit
  from public bylines.

The page template falls back to the ordinary theme view when the integration is
inactive. Install the plugin, stylesheet and guarded theme patches together for
your theme. [HOST_CONTRACT.md](HOST_CONTRACT.md) describes the required hooks and
native consumers. Capture your own source hashes and backups before installing;
this repository contains no installation history or deployed-host receipts.

## Ranking data

`rank_requests.py` reads bounded tails of combined-format request logs. It
requires a complete 24-hour UTC window and includes successful browser-like GET
requests for dated public article paths. It excludes explicit bots, preview
queries and invalid paths. Case and percent-encoded aliases share the same path.
Each IPv4 address or IPv6 /64 contributes once per article per hour. Ephemeral
keyed digests enforce that limit in memory and disappear when the process exits.

The output contains article paths, aggregate counts, reporting times and
aggregate diagnostics. It contains no client addresses, user agents, referrers
or query values. Each tail is bounded to 512 MiB. Incomplete coverage, unsupported
time zones or excessive malformed records fail the refresh. The previous
uncompressed `.1` log may supply the beginning of the reporting window.

The importer requires a complete, current snapshot. It resolves only published,
passwordless, publicly viewable articles, consolidates aliases using their
maximum count and saves at most 50 IDs. Public responses omit request counts.
Readback checks visibility again and rejects snapshots older than four hours.
These are recent request estimates, with shared-network undercounts and possible
undeclared bots; they do not measure unique readers or historical analytics.

`refresh.sh` and the systemd units refresh outside public page requests. The
service's `/etc/spotlight-most-read.env` supplies PHP deployment settings plus
`SPOTLIGHT_WP_PATH` and `SPOTLIGHT_WP_URL`; the refresh refuses missing values.
The example standard directories must be adapted to the installation. A lock
prevents overlapping refreshes, and failed imports preserve the last valid
snapshot. Monitor timer results and snapshot age. No request fetches credentials,
account settings or ranking data from an external configuration service.

## Local checks

From the repository root:

```sh
python3 -m unittest discover -s ops/spotlight-most-read -v
php -l ops/spotlight-most-read/spotlight-most-read.php
php -l ops/spotlight-most-read/page-most-read.php
php -l ops/spotlight-most-read/legacy-popular.php
sh -n ops/spotlight-most-read/refresh.sh
```

These checks use synthetic request logs and a PHP hook fixture. They do not
connect to WordPress, install plugins, or establish public deployment acceptance.
