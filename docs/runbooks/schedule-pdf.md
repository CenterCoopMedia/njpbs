# Schedule and PDF contract

The schedule page, program dialog and public PDF consume the same corrected
dataset through `loadScheduleData`. There is one Download the schedule (PDF)
button, one stable `/schedule/downloads/nj-pbs-schedule.pdf` route and no
separate monthly feed or completeness gate. The button works without JavaScript.
Private frozen preview artifacts omit it because they do not contain that route.

## Input and time

The tracked `site/src/data/schedule.json` is the published schedule input,
with active corrections applied. If no `SCHEDULE_DATA_PATH` is supplied, the
loader uses those committed published bytes. An explicit path selects a frozen
external input and must pass the schedule validator; it is not a fixture-mode
bypass. There is no private schedule supplier in this path. PBS credentials
remain outside source. See the actual [loader](../../site/src/lib/schedule-data.ts)
and [exporter](../../site/src/lib/schedule-export.ts) for input behavior.

The PDF starts on the Eastern calendar date of `generatedAt` and includes
13 more calendar dates. Count calendar dates across daylight saving changes,
not fixed 24-hour intervals. A later build keeps the baked window rather than
shifting stale listings to today. The page retains all baked dates, including
dates beyond the PDF's 14. Cross-year labels include both years.

Each missing date/channel prints Listings unavailable; it does not prevent
export, borrow an earlier PDF or invent a full-day lineup. Existing expiry
behavior continues to disclose unavailable current listings. The dated download
filename comes from the button; sharing the stable URL can display inline and
save the stable basename instead.

## Provenance and corrections

`ScheduleProvenance` JSON is PDF metadata, not a toolbar panel or printed
preamble. It records source/revisions, oldest PBS check, evidence counts/status,
bake/build clocks, timezone, missing dates and coverage/freshness notices.
`sourceCheckedAt` records the start of a successful PBS retrieval. Retained days
keep their original time; bake/build time cannot establish a fresh provider check.
Checks older than 20 hours are stale; invalid/future evidence is invalid.
Count corrected, PBS-checked and unknown dates separately; only PBS-sourced
dates contribute to oldest PBS check in mixed windows.

The [correction implementation](../../site/src/lib/schedule-corrections.ts)
owns the active date-specific sources and expiry. Full-day replacements preserve
source revision/hash, sheet/cell references and unresolved outer intervals.
Do not infer ten-minute precision from spreadsheet layout, divide an unresolved
combined block, or inherit another episode's identifiers/descriptions. Metadata
is reused only when program and explicit episode titles agree. The kids view
classifies the same broadcast timeline rather than adding another channel.
Date unions remain bounded to 45; ordinary 14-day provider windows resume after
replacement expiry. Source data and correction assets remain unchanged by this
documentation consolidation.

Episode-only corrections apply code, guest title and supplied description to
existing matching airings. They add no airing, change no feed interval, and
retain PBS evidence; they do not claim a full-day `sourceRevision`. Conflicting
source time labels need separate resolution before changing the timeline.
Preserve source text and audited whitespace repairs. Source hashes describe
provenance, never current public delivery.

Workbook extraction is a **private operator step** before supplying a revised
correction asset. This tree does not include the historical workbook extractor
or its original source packet. Do not run a missing extractor or substitute an
unreviewed local conversion. Its source owner must verify the exact approved
workbook hash, preserve unresolved boundaries and provide the regenerated JSON
with its extraction audit. A new source requires a deliberate revision and fresh
validation. Keep original packets/audits private; the public loader, correction
assets and schedule tests then validate the supplied result.

## Staff broadcast workspace

The signed-in Admin `/schedule` view is read-only partner-packet data from
`cmsGetBroadcastSchedule`, separate from the public TV feed/PDF. Source packet
stays in the authenticated response, never the static Admin bundle. Refresh
loads only that available packet; it imports/writes nothing and cannot establish
last-minute broadcast changes. Last checked advances only after successful
validated response, not a source revision or invalid/failed result.

Keep packet/filter state visible during checking and transient failure; explicit
401/403 discards retained packet. Initial failure offers retry, not empty data.
Only one refresh request can run. Mount/manual accepted refresh load packets;
filtering, week/day navigation and minute/visibility date updates make no request
and add no persistent cache. Use packet timezone for day/week and current marker.

Keep all seven dates, including empty/uncovered with explicit explanations;
week menu stays in coverage and This week appears only when covered. Search
matches every entered term, filters retain unavailable selections with clear
recovery, week changes clear day but keep filters, Back/reload preserve address
state and unrelated query parameters. Clear filters retains week/day.
Grouped episodes preserve original labels, recognized chronological times before
unrecognized labels, textual preemption cues and inclusive listed-slot counts.
Missing listings never prove a station is off air.

Verify the existing focused `broadcast-schedule`, `schedule-workspace` and
`schedule-workspace-ui` tests from **admin/**, with the root/site dependency
setup. Keep original `npm test -- tests/broadcast-schedule.test.ts tests/schedule-workspace.test.ts tests/schedule-workspace-ui.test.tsx`
and the Admin `npm run build` for an actual workspace-code change. Public schedule
tests run from site/ instead. Synthetic isolated UI proof is not full signed-in
integration; verify actual staff admission and deployed endpoint separately.
Retain labeled native controls, keyboard focus, polite state/count updates,
text/border status cues, reduced-motion/forced-color behavior and phone overflow.

## Immutable cloud packet

The background preparation seals corrected JSON and exact PDF bytes as one
packet under `post-background-v1/schedule-packets/`. Upload and readback of both
precede its receipt. The reader validates accepted input identity, clock, seals,
bake/window, and bounded object size/deadline. Moved source, changed clock,
unknown key or mismatched readback refuses the pair.

Cold recovery restores the accepted exact pair instead of regenerating the
PDF: rendering can allocate PNG objects differently despite equal inputs.
`externalInputs.schedulePacket` is optional; the existing files map still
contains the three provider JSONs. Acceptance binds the exact context revision
and digest and refuses a changed input receipt during sealing. Unchanged input
keeps its original receipt/packet. Historical input missing a packet can gain
one successor without relabeling its original provider/runtime/check clock.
Page/Context export readers must consume the pair before opening admission.
A packet helper alone does not prove public PDF delivery.

## Verify and recover

From `site/` in a credential-free development shell, after root/site lockfile
installation, run the focused schedule tests for the changed behavior and the
site check. Build the schedule page/PDF only when testing rendering changes.
Do not run full builds merely to validate prose.

1. Compare PDF programs, missing dates, inclusive range and filename with the
   exact corrected input. Require output even with missing days.
2. Check desktop and phone toolbar, one download, keyboard focus, accessible
   role/label and target of at least 44 px. Day selection retains all baked dates.
3. Render first/last pages; use `pdfinfo`, `pdftotext` and `pdfinfo -custom`.
   Check selectable/tagged text, program order, repeated date/channel headers,
   whole rows, page numbers and separate provenance metadata.
4. Preserve the approved lockup, Public Sans Regular, Bold and Black TTF fonts from
   site/src/assets/pdf-fonts/ (SIL Open Font License 1.1) and Eastern times.
   Rendering uses committed open-font bytes with no network dependency.
   Missing font/logo or render failure fails the build; repair the input/asset
   and rebuild rather than substituting an older PDF.

Tagged text and local checks do not establish full PDF/UA conformance without
an external validator receipt. Public publication needs its own deployment
and ordinary-URL readback in the [release contract](../cms/staging-deploy-runbook.md).
