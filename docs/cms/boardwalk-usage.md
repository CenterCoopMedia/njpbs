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

## Dashboard counters

`collectBatch` writes every counter in the same transaction as the raw event.
The team is `product` for an actor whose `users/{uid}.accessTier` is `owner`
and `newsroom` for everyone else. The role key is `accessTier`, or `none`.
Top-level `activeUsers`, `views`, `visibleMs` and `actions` stay all-staff
totals.

Eastern daily docs (`cmsUsageDaily/et-YYYY-MM-DD`) add:

- `groups.{team}`: `activeUsers`, `sessions`, `views.{screen}`,
  `visibleMs.{screen}`, `actions.{action}`, `screenDays.{screen}` and
  `actionDays.{action}` (distinct person-days), `hourMs.{HH}` (visible time by
  Eastern hour of the event, collection time minus `offsetMs`), `transitions`,
  `backForth`, `pairs.{a~b}` (sorted screen pair) and
  `repeat.{publish|preview}.{items,repeats,repeatedItems}`.
- `roles.{role}`: `activeUsers`, `sessions`, `visibleMs`.

Eastern weekly docs add `groups.{team}.activeUsers` and
`roles.{role}.activeUsers`.

`cmsUsagePresence` markers hold no account or content IDs; IDs are SHA-256
hashes. All have `purgeAt` (180 days):

- `day_{day}_{person}`: `lastAt` (ms) and the last two screen ids. A batch
  whose first event is 30 minutes or more after `lastAt`, or the first batch of
  the day, starts a session. A view of a different screen counts a transition;
  a view of the screen before last also counts a back-and-forth for that pair.
- `screen_{day}_{screen}_{person}` and `action_{day}_{action}_{person}`: one
  person-day per screen (views or visible time) and per action.
- `repeat_{day}_{hash(uid:action:objectType:objectId)}`: `lastAt` and
  `repeated` for publish and Preview attempts. The first attempt on an item
  counts an item; an attempt within 10 minutes of the last counts a repeat; the
  first repeat counts a repeated item.
- `person_{person}`: `lastDay`, `group`, `role`. The report counts distinct
  active people for any window from markers with `lastDay` in it.

The report also reads, with field projections and limits, and reports a
section as `unavailable` when a read fails or passes its limit:
`users` (roster by role and excluded-account count), `bug_reports` (open
count, median days to resolve, top five pages with non-word path segments
replaced), `cmsPosts` (first publishes per Eastern week, median hours from
creation, open draft ages), `cmsPreviewQueue` (failed and expired jobs) and
`mediaSourceUploads` (uploads active over a day). Friction compares the prior
window of the same length, read from Eastern daily docs only.
