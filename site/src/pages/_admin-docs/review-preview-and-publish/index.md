---
title: Review, preview, and publish
description: "Save, review, preview, publish, and verify CMS content."
---


## Check a draft before publication

A saved draft can be complete enough for an editorial check without being ready
for publication. The workflow can include:

- Drafting.
- Assignment.
- Editorial review.
- Approval, for manual election results, Spanish editions, and sponsor or
  newsletter cards.
- Preview.
- Scheduling or publication.
- Public verification.
- Delete or unpublish work.

For Posts, Pages and Programs, the editor header keeps **Save draft** beside
**Preview** where available. Open **Publishing** for **Publish** and **Schedule publish**.
Other content types keep their lifecycle actions in the editor toolbar.
Some actions appear only when they apply. Recovery tools are separate from this
editing surface. Do not skip an editorial check
that your area requires simply because **Publish** is available.

## Read working and public state separately

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Read both version fields.</strong> This local example shows working version 12 approved while an older published copy remains live. Approval does not replace the public copy. </figcaption>
</figure>

The workflow state describes the current working revision. The public state
describes the detached snapshot that visitors can read. These can show different
versions. For example, working version 12 can be approved while version 8 stays
live.

A person with publishing permission and edit access can publish the exact saved
version. Save the
draft first, then select **Publish**. Until publication succeeds, the older live
version remains public. **Version 8 live** identifies the confirmed public
version. **Version 12 is publishing** means a newer saved version is in progress.
**Version 12 needs publication retry** means that it is not confirmed live.

## Prepare a draft for review

Use this checklist before editorial review.

1. Confirm the correct record, public path, author, and section.
2. Read the full draft from beginning to end.
3. Check headings, links, media, alternative text, captions, and credits.
4. Check Basics, Search, and Social sharing metadata.
5. Remove placeholders, test markers, and internal instructions.
6. Save and reload.
7. Inspect the newest revision.
8. Confirm the assignment.
9. Add a concise review note in the area's review channel when required.
10. Tell the person who checks your area's work that the draft is ready.

A review note should state what changed, what needs special attention, and any
known limitation. It should not repeat the entire draft.

## Review a saved draft

The person who checks a draft should evaluate both editorial quality and
operational readiness.

Check:

- The draft answers the assignment.
- The title, description, and social copy agree.
- The page or post uses the correct route and content type.
- Block order and heading hierarchy are logical.
- Links work and identify external destinations clearly.
- Images are authorized, credited, and described.
- Locked or derived integrations have not been duplicated.
- Dates, schedules, and lifecycle choices are correct.
- The revision evidence matches the stated change.
- No private or internal material will be exposed.

When changes are required, make the request specific enough that the author can
verify completion. “Fix metadata” is weaker than “Replace the social
description; it still contains the internal launch note.”

## Request an exact-draft preview

Preview is a separate operation from saving and publishing. It should represent
a specific saved draft revision.

You can preview any saved Page or Post that you can open in Boardwalk. Writers
can preview their own drafts. Editors can preview records in their assigned
content areas. Preview does not give permission to edit a record. Archived content cannot be previewed.

To preview a record:

1. Open the Page or Post that you want to inspect.
2. Select **Preview** in the editor header once. A new tab opens immediately and shows **Preparing preview**.
3. Keep that tab open. Boardwalk saves changes when needed, then opens the protected preview automatically.
4. Check both a wide and narrow viewport.
5. Return to Boardwalk and make any corrections. Select **Preview** again to inspect a later saved version.

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Keep the progress tab open.</strong> It opens the protected preview automatically when the saved version is ready. <span class="admin-docs-image-note">Example screen from the local editor fixture. Select the image to enlarge it in a new tab.</span></figcaption>
</figure>

The new tab shows whether Boardwalk is preparing the draft, waiting to build,
building the preview, or opening it. It may skip straight to an existing preview
of the same saved version. **Pause motion** stops the animation while work
continues. Your device’s reduced-motion setting also stops the animation.

After a recent publish, the tab may show **Previews are refreshing**. Keep it
open while Boardwalk waits for up to four minutes. If it tells you to try again
in a minute, return to the editor and select **Preview** after that wait. Your
edits remain in the editor.

You can continue editing while the preview is prepared. The preview includes
the edits present when you selected **Preview**, even if an earlier save was
still running. Later edits stay in the editor as unsaved changes.
Preview does not publish the draft. A later preview build does not replace an
already open preview. Each private preview expires after seven days.

If the browser blocks the new tab, allow pop-ups for Boardwalk and select
**Preview** again. Closing the progress tab cancels the preview operation;
a save already sent can still complete. If the preview fails, return to
Boardwalk. Your edits remain in the editor.

## What to inspect in preview

Review the complete rendered result:

- Public header and footer context.
- Page title and description.
- Block order and visibility.
- Responsive image crop.
- Alternative text and captions.
- Link destinations.
- Locked player, schedule, account, or feed context.
- Narrow-screen wrapping and action placement.
- Keyboard focus and zoom.
- Absence of internal notes or test content.

A guide, block outline, or editor representation is not a preview.

## Use Publish activity

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Read each publish request.</strong> Publish activity lists recent, active, and failed publish jobs. A completed job does not mean that every saved draft is live. </figcaption>
</figure>

**Publish activity** shows the history of publish jobs. Staff with settings
access can open it from the navigation rail. It lists the latest 100 requests,
the requests still running, and the latest 100 requests that need recovery.

For each request, identify:

- Record or site update.
- Who or what started it.
- Changes included.
- Current stage and outcome.
- Any failure that blocks progress.

When a site update fails, select **Retry site update**. When Boardwalk cannot
confirm the public result, select **Check again**. Select **Refresh** to reload
the list.

A row in this list is a summary. Confirm the exact public version on the content
record before you say that a saved version is live.

## Publish

Only publish after the required editorial and operational checks.

1. Confirm the saved draft revision.
2. Confirm the assignment and any editorial review your area requires.
3. Review the exact-draft preview when required.
4. For manual election results and Spanish editions, select **Approve** on the
   saved draft first. For sponsor and newsletter cards, **Approve** publishes
   the card.
5. Open **Publishing** and select **Publish** once.
6. Keep the publication status in view.
7. Wait for a terminal success or failure.
8. Open the public URL without relying on a logged-in preview session.
9. Check the changed content and surrounding page.
10. Record completion or start a correction.

A successful button press is not the same as a successful public release.

## Schedule publication

Open **Publishing**, then select **Schedule publish**. You need publishing
permission and a saved version in draft or approved status. Before you confirm:

- Confirm the date, time, and displayed time zone.
- Confirm that the content is appropriate to become public without another
  person present.
- Verify that related links, media, and external services will be available at
  that time.
- Record who owns the post-publication check.
- Recheck the scheduled item after any later draft edit. Selecting **Edit**
  returns scheduled or approved content to draft. Schedule it again, and
  approve it again when its content type requires approval.

Use an explicit date and time in handoff notes. Avoid “tomorrow morning” or
other relative descriptions.

## After release, respond to a failed release

When publication or preview fails:

1. Do not repeatedly start new runs.
2. Record the exact status and error.
3. Confirm the record and revision.
4. Check whether the failure is validation, permission, build, media, or
   deployment related.
5. Correct editorial validation in the draft when the message identifies it.
6. Escalate operational failures with the run or request identifier shown by
   the interface.
7. Retry only after the cause has been corrected or an administrator has
   confirmed that retry is safe.

A failed public release should leave the prior public version intact. Verify the
public page rather than assuming.

## After release, verify the public result

Use a clean browser tab and the public NJ PBS URL.

Check:

- The intended content appears.
- No unrelated block or metadata changed.
- The canonical route resolves.
- Images and documents load.
- Links go to the intended destinations.
- Mobile layout remains usable.
- Search and social metadata are present when the task includes them.
- Scheduled dates and statuses are correct.
- The public page contains no preview banner or internal note.

For a high-risk correction, ask a second person to verify independently.

## Unpublish, delete, and restore

For Posts, Pages and Programs, open **Post actions**, **Page actions**, or
**Program actions** for **Unpublish** and **Delete**. Other content types keep
these controls in the editor toolbar. Deleted content
shows **Restore to draft** in the editor toolbar.

- **Unpublish** requests removal of the public version. The working copy and last public snapshot stay saved.
- **Delete** moves the content out of active editorial work. Confirm with **Move to recycle bin**. The status then reads **Deleted**. Revision history stays.
- **Restore to draft** returns that deleted content to draft. It does not publish the content.

Before acting, read the public consequence in the confirmation. Preserve
redirects, legal retention, and audience expectations. When urgent removal is
required, coordinate the public check and the follow-up correction rather than
deleting evidence.
