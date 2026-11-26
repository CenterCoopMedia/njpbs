# Release drift check

`scripts/check-release-drift.mjs` reads one CMS target and compares it with a
source commit on main. It writes nothing. The checker and the live-part list come
from the checkout it runs in (main in the workflow); the source commit is read
through git only, so an older source needs no checker of its own. The source
must carry `config/release-surfaces.json` (main since Nov. 14, 2026); the
workflow refuses an older one, because no release goes back before it. `.github/workflows/release-drift.yml` runs
it with the target environment's own secrets: by dispatch (the release runs it
before its first write and, with `after`, after its last) and every night against
main on production.

```sh
node scripts/check-release-drift.mjs <production|development> [--source <sha>] [--after] [--compare <facts.json>] [--facts <out.json>]
```

The output is one line per check. Exit 1 when a stopping check fails.

## Stopping checks

Each check names the failure it stops.

1. Leftover Functions: a live Function that neither the source nor the live
   Functions commit exports. Firebase asks before it deletes one, and the
   non-interactive deploy stops (production run 1, Nov. 25, 2026). Names each
   Function. A Function with its own registry row (`live`, provider `function`)
   is not a leftover.
2. Smoke fixture: the record in `CMS_PREVIEW_SMOKE_TARGET` is missing or not a
   draft. The preview smoke then waits for a control that never comes (run 2,
   31 minutes). Prints the state, not the record ID.
3. Publication idle: the public pointer is not idle, its active, eligible and
   reserved generations differ, or the runtime phase is not `ready`. A release
   must not start on top of an unfinished one (njpbs #676).
5. Release credentials: the deploy account, the Cloudflare deploy token and the
   Admin Access token can each make the read their step needs. The release tool's
   publisher token (`NJPBS_PUBLISHER_CLOUDFLARE_TOKEN`) and publication bucket key
   (`NJPBS_PUBLICATION_R2_CREDENTIAL`) are checked only where they are set; they
   are not GitHub secrets.

Check 4 (a live Worker, Pages project, container or Snippet with no row in
`config/release-surfaces.json` `live`) prints its result and does not stop the
run yet. It becomes a stopping check once a production run shows the list
complete.

## Report lines

- Each `live` row with a `read`: `equal` or `differs` against the source. A
  missing exported Function differs, except the cloud wake Functions, which the
  deploy leaves out when `cloudWakeEnabled` is off. The edge snippet's rule must
  match the public host. With
  `--after`, every `differs` or `not read` line fails: the release must leave
  every listed part equal to its source.
- Rows without a `read` print which step deploys them and why they are not read.
- How many commits production is behind main.
- With `--compare`: Function names, pointer schemaVersion and fixture state that
  differ between production and development.

The drift check does not stop a release for parts that are behind the source;
the release exists to change those.

## Nightly run

A red nightly run, or one that fails before the check, opens or updates one
issue titled "Release drift check failed"; the next green run closes it.

A dispatch runs only from main and only for the deploy owner, as
`cms-deploy.yml` does. The Cloudflare account and zone come from
`CLOUDFLARE_ACCOUNT_ID` and `CMS_ANALYTICS_CF_ZONE_ID`.

## Expected values

- Functions carry `CMS_ADMIN_BUILD_REVISION`, the last commit that changed the
  paths in `scripts/lib/cms-release-paths.mjs`; the preview renderer carries the
  same for its paths.
- The CMS API Worker carries `CMS_API_SOURCE_SHA` from this check's first
  commit on (no release goes back before it); the public Worker, the
  publisher Worker, the runtime pin and `_publication.json` carry the source.
- Firestore and Storage rules equal the source files byte for byte.
- The edge snippet equals the bundle that the snippet README builds from the
  source.
