# Usage analytics release checks

Before releasing enabled collection, an authorized server operator must set
`usageAnalyticsExcluded: true` on each agent, test and non-staff vendor
`users/{uid}` document. Verify that every nonhuman account is excluded. Keep
accounts used by staff counted.

The server-only profile field is the sole exclusion authority for new usage
events and historical totals. Browser clients, including administrators, cannot
add, change or remove it. Existing aggregate counts are not rewritten.

Deploy and verify the two usage TTL policies and Functions before releasing an
enabled Admin artifact. Verify account exclusions before enabling collection.
The shared `analyticsEnabled` setting remains the collection stop control.
Account changes and deployment require separate authority.

Daily and weekly aggregates and presence markers are keyed by Eastern date
with the `et-` prefix. Rows collected before that change keep their UTC date
keys and are reported as UTC rows. The first `et-` daily row is the change date.

## What Boardwalk records

Each usage event names a screen from `functions/lib/boardwalk-usage-config.json`
and may carry `offsetMs`, the time from the event to its batch being sent
(0 to 600,000). Events are `screen.view`, `screen.duration` and the configured
actions. An action carries `objectType` and `objectId` only when it acts on a
saved page or record.

- `content.publish.request`, `content.schedule.request` and `preview.request`
  are recorded where staff start them.
- Failed content saves, transcript requests and clip requests are recorded at
  the shared Functions transport (`measureEndpointUsage` in
  `admin/src/lib/boardwalk-usage.ts`).
- Uploads are measured with `measureUsage` where each upload succeeds or fails,
  after automatic rate-limit retries and duplicate reuse: image uploads in
  `uploadMediaReusingDuplicates` and `uploadAuthorPhoto`, video session starts
  in `startVideoUpload` and each video transfer attempt in `transferVideo`.
  Only the person's own cancellation is not a failure; internal timeouts are.
- `search` is recorded when any `input[type="search"]` goes from blank to
  nonblank text. The text is never sent.
- `earlierScreens` labels the combined `posts`, `pages` and `media` counts
  stored before the list and editor split. They appear only in report windows
  that include them. The collector still accepts these ids from tabs opened
  before the split and counts them on the combined rows.

The staff explanation is the Boardwalk guide page `boardwalk-usage`.
