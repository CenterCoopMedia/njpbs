---
title: NJ Decides election night
description: "Set the election brand, schedule the banner, prepare the hub Page, and publish manual or connected election results."
---

Use this walkthrough to prepare NJ Decides 2026 coverage before election night
and keep results current during the count. Your existing permissions control
which settings, review and publishing actions you can use. Ask a Manager when
an action is unavailable.

## Prepare in this order

1. [Set and publish the shared brand](#set-the-nj-decides-brand).
2. [Prepare the hub Page](#prepare-the-election-hub-page).
3. [Add results and check their source](#enter-and-approve-manual-results).
4. If needed, [connect automatic results](#connect-a-results-source).
5. [Schedule and publish the election banner](#show-or-schedule-the-election-banner)
   after the destination Page is live.
6. [Check the reader experience](#check-the-public-page) and the next update.

Saving keeps a draft. Approval permits publication. Publish starts the saved
change on its path to readers; check its progress and the public page before
calling it live.

## Set the NJ Decides brand

1. Open **Admin settings** in the rail. Find **NJ Decides brand**.
2. Set the background, text, link, rule and accent colors. Keep the preview
   readable. Text and links each need at least 4.5:1 contrast against the
   background; Boardwalk refuses invalid colors.
3. Choose whether to **Show the diagonal flag**. For different artwork, choose
   a custom logo or background artwork from Media. Add alternative text for a
   custom logo. Removing either image restores the bundled artwork.
4. Check **Live preview**, then choose **Save draft** in this section.
5. Choose **Publish** in the same section. Follow its publication progress,
   then check a Page or banner using the brand on the public site.

**Reset to defaults** restores the approved colors and flag and removes custom
images from the local draft. Save and publish to make that reset public.
Publishing the brand updates its shared appearance; it does not add a banner,
create a Page or fill in election results.

If someone changes the saved setting while you work, keep your local changes
and use the offered saved-version check. Review the current values before
saving again. Do not keep retrying an older version.

## Prepare the election hub Page

1. Open **Pages** and the regular Page that will hold election coverage.
2. Open **Details → Page → Page metadata**. In **Page theme**, choose
   **NJ Decides 2026**. Keep a descriptive Page title:
   screen readers, browser titles and shared links still use it. The logo
   becomes the visible heading; the optional Page summary provides its copy.
3. Add and arrange spans and planks with the normal Page controls. The theme
   supplies no results, reporting or fixed section order. Add the approved
   links and content your Page needs.
4. Save, request review, approve and publish through the usual
   [Page workflow](../review-preview-and-publish/).
5. Open the public Page. Confirm its heading, content and links before using
   its address in the sitewide banner.

Shared brand settings control the heading colors and artwork. A themed Page
uses its own election heading instead of repeating the sitewide election
banner. Choose **NJ PBS default**, then save and publish, to restore its normal
heading. Dedicated Pages such as Home and Contact retain their own controls.

## Enter and approve manual results

1. In a Page or Post, choose **Add** to open **Add content**. Select
   **election results**, then choose **Insert block**.
2. Add a race. Enter the office and district or area, then every candidate in
   the source's order. Candidate photos from Media are optional.
3. Copy the source's reported votes and shares; zero means reported zero.
   Before changing **Awaiting results** to **Votes being counted**, every
   candidate needs both reported votes and share. Both are also required for
   **AP race call**, **Official results** and **Certified results** publication.
   Do not calculate percentages from an incomplete list. If any candidate's
   votes or share are missing, wait for the source's reported values, keep the
   race **Awaiting results** and leave all candidate votes and shares blank.
   Approval refuses incomplete counts with: "Add the reported votes and share
   for every candidate before approval."
4. Enter the source type, source name, HTTPS source link, source update time
   and reporting share when provided. Check the time zone. Readers see the
   source time in Eastern time.
5. Choose the status the source supports. **Votes being counted** is not a
   race call. An **AP race call** needs the called candidate and an AP call
   link. **Official results** and **Certified results** need an official source
   establishing that status. A concession is not a call; NJ PBS does not make
   its own projections.
6. Save the draft. Open **Review & publish → Submit for review**, then choose
   **Confirm submission**. A staff approver checks the exact values, source,
   update time, reporting share and any call attribution, then chooses
   **Approve** and **Confirm approval**.
7. Open **Review & publish → Publish** to request publication. Check Publish activity and the public race. Approval
   alone does not publish. Open **Race approval history** to inspect approved
   manual revisions.

Later edits stay private until that exact revision is reviewed and published.
An unchanged race keeps its earlier approval. For an enabled source connection,
use [the correction steps below](#pause-and-correct-results) before editing its
manual values.

## Connect a results source

Publish the Page or Post with its Election results plank first. In that plank,
open **Election source**. Staff with publish permission can change connections;
other staff with read access can inspect their status.

1. Choose **Connect a source** and select one source: **nj-decides public JSON**,
   **Google Sheet** or **AP Elections API**. Sources are never blended
   automatically.
2. Select races from the roster and review candidate identities and labels.
   Source names do not replace roster identities. Optional Media photos stay
   attached to those identities.
3. For a Sheet, enter its spreadsheet ID, tab and column mapping. Use the
   roster's race and candidate IDs, one row per candidate, and repeat the same
   race-level fields on each row. Use numeric percentage points from 0 to 100,
   not percent-formatted cells. Dates need a time zone. Include every selected
   race's complete candidate list without duplicates.
4. Share the Sheet with **Viewer** access to the exact runtime account supplied
   by the site administrator. Keep it private; do not enter Google credentials
   in Boardwalk. For public JSON, the published results file must be available
   and contain real results rather than a sample. For AP, review explicit race
   and candidate ID mappings; the site administrator must configure AP access
   before it works. No API key belongs in Boardwalk.
5. Choose a publishing mode using the table below. Review the selected races,
   mapping and authorization, then choose **Connect source** or
   **Save connection**. These actions can authorize public updates.

| Mode | What you approve and what happens next |
| --- | --- |
| Approve the link once | Review the first valid source values and choose **Approve link**. Later valid counts and calls publish automatically for that configuration. A configuration change requires renewed approval. |
| Counts automatic, calls by click | Counts publish automatically. Compare accepted and pending status, winner and attribution; choose **Approve status changes** for the exact pending call or official/certified status changes. |
| Fully automatic | Connecting authorizes valid counts, calls and source statuses to publish automatically. |

The server checks enabled sources at 8 AM and 8 PM ET, within provider limits.
It changes only the connected public results; other unsaved or saved draft edits
stay private. **Refresh connection** reads the latest connection state; it does
not force a source request.

In the two approval modes, approve within five minutes after a successful check
at the default source age limit. If that time passes, wait for the next successful
check. After resuming, wait for that check before approving; Resume does not fetch
the source immediately. Fully automatic connections need no approval click.

Sheet and repo values must still be no more than five minutes old at a check by
default. An edit made more than five minutes before a twice-daily check can raise a stale hold
and stays held on later checks. Recheck the producer's counts and use their real
fresh verification time in `as_of` before the next check. A merge, deploy or
Refresh connection does not refresh the source time.

A missing candidate, duplicate ID, invalid value, stale timestamp or unavailable
source puts the connection on hold. The last good public results stay visible;
a bad row does not replace them or break the Page. Read the reason, correct the
source or mapping, and check the next successful update. A quota notice can mean
the next check is waiting for provider capacity. No alternate source is selected
automatically. **Last accepted update** means publication work was accepted;
check Publish activity and the public values for confirmation.

### Pause and correct results

1. Choose **Pause updates** before making a manual correction. This also
   discards a source response still in flight.
2. Start a revision if needed. Choose **Copy accepted values to manual draft**
   so the correction begins with the last accepted numbers.
3. Correct the values and source time. Save, request review, approve and publish
   the manual revision as described above.
4. Check the public correction. Review and reconnect the source afterward.
   **Resume updates** refuses a public binding changed by a manual publication;
   reconnect rather than trying to overwrite it with an older source state.

Use **Resume updates** when the paused public results, connection and saved
manual draft still match their connected versions. If the saved manual draft
changed, review and publish it or discard it before reconnecting the source.
Check the next accepted update.

## Show or schedule the election banner

1. Open **Admin settings → Homepage banner**. Turn on
   **Use NJ Decides sitewide mode**, then **Show NJ Decides band sitewide**.
2. Review any existing message and link before reusing them. The logo is the
   title. A message and link are optional in election mode; enter both
   **Link label** and **Link URL**, or leave both blank. After the first link,
   optionally fill in **Second link label** and **Second link URL**. Both links
   appear side by side and wrap on phones. Clear both second-link fields to remove
   the second link. Use the published hub address for election coverage. Add an
   optional **Live label**.
3. Expand **Schedule** to set the banner's start and end times in Eastern time.
   Either bound can be blank. The start is inclusive; the end is exclusive.
   Leave both blank for immediate display after publication.
4. Under **Hide the NJ Decides band on these pages**, choose **Choose pages**.
   Add a published Page or Post, Home, or a main site destination. The list can
   hold up to 50 URLs. Remove a choice to show the band there again. Choices
   use the published URL; reselect after a Page or Post changes its URL.
5. Check the Home sample preview and the selected URLs, then choose **Save draft** in the banner section.
6. Choose **Publish** in the same section. Check progress and open the public
   site, including a Page or Post outside the hub.

The election banner uses the published shared brand across the public site,
except the selected URLs. Unknown or removed URLs do not affect other pages.
The normal announcement mode appears on Home only. A themed hub uses its own
heading instead of duplicating the election banner.

To remove the banner early, turn off **Show NJ Decides band sitewide**, save and
publish. Saving alone leaves the public banner as it was. An already open tab
checks scheduled bounds and checks again when restored. That scheduled change
in an open cached page needs JavaScript; reload to check the current state.

## Live blog

Live-blog coverage uses its own Post controls. This walkthrough covers the
shared brand, banner, hub Page and results; those steps do not create or update
a live blog.

## Check the public page

After publication, use the public address and check on a phone and a wide
screen:

- The hub has one election heading and the expected Page title for shared links.
- Banner copy, destination and schedule match the approved plan.
- Every race has the expected candidates, source, update time and status.
- Candidate rows and the table alternative show the same values.
- The status panel shows source update time and, for reported races, reporting
  share; on phones it appears above the rows. Leading is an uncalled lead.
- Unknown reader values show a dash; screen readers hear “Not reported”.
  Reported zero remains zero, and AP calls retain attribution.
- A later valid source update arrives without exposing another draft edit.

For sharing, the hub, results and election Posts have matching default artwork
without vote totals or calls that could become stale. A selected **Social image**
takes precedence. Review it in [metadata and media](../metadata-and-media/).

If publication fails, use its displayed recovery action and
[Publish activity](../review-preview-and-publish/). Keep the last good page
available while correcting the source or draft. A saved draft, an accepted
source update and a confirmed public change are different states.
