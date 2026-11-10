---
title: Block editor
description: "Work with the content outline, editable blocks, locked regions, block settings, order, and visibility."
---

## Understand the editor structure

A content editor can contain several distinct sections:

- Record identity and public path.
- Basics, search, and social metadata.
- Page or post content.
- Preview or lifecycle controls.
- Revision history.
- Locked public context.
- Assignment or workflow details.

The sections can be arranged, collapsed, or placed in wide and narrow zones
when the interface permits it. That personal arrangement changes the workspace,
not the public page.

Within **Page content** or a post body, the record is composed from ordered
blocks. A block is one editorial unit, such as a heading, prose region, notice,
image, card group, link set, or service-specific configuration.

## Add election results

Follow the [NJ Decides election-night walkthrough](../nj-decides/) for the
brand, banner, hub Page, manual results and connected-source steps.

In a Page or Post, choose **Add content**, then **Election results**. Publish
that section before connecting a source. Its **Election source** controls use
nj-decides public results, a Google Sheet or AP, with one source per connection.
Staff with publish access select roster races, review source mapping and choose:

- **Approve the link once:** review valid source values and approve the connection
  once. Later valid counts and calls publish automatically.
- **Counts automatic, calls by click:** counts publish automatically; a publisher
  reviews and approves pending calls or official/certified status changes.
- **Fully automatic:** valid counts and source statuses can publish immediately.

The nj-decides roster supplies race and candidate identities, display names,
ballot labels, party, incumbency, campaign websites, ballot status and aliases.
Optional candidate photos come from Media and stay keyed to those identities.
A published profile link appears only when the roster already includes one.
No unpublished profile or contact information enters public results.

For a Sheet, enter its ID, tab and column headers, using one candidate per row
and stable roster IDs. Share Viewer access only with the Functions runtime
service account supplied by the site administrator. For AP, review the AP race and
candidate ID mapping; no key belongs in Boardwalk. AP requires configured
provider access and quota. Sources never blend automatically.

The server checks at 8 AM and 8 PM ET and publishes changed valid values. Other
draft edits stay private. A source hold keeps the last good public values and
shows a reason. Correct the source or mapping, then refresh after the next check.
**Last accepted update** is accepted publication work; confirm public results in
Publish activity and on the public page before treating a correction as live.

At the default source age limit, approve a link or pending status within five
minutes after a successful source check. If that window passes, wait for the
next successful check. After resuming, wait for a check before approving.
Refresh connection reads server state and does not fetch the source.

Sheet and repo edits must still be no more than five minutes old when checked
by default. An edit made more than five minutes before a twice-daily check stays
on hold until the producer rechecks the counts and supplies their real fresh
`as_of` time before a check. Keep the real source time; a merge or deploy does
not refresh it.

Choose **Pause updates** before a manual correction. Start a revision if needed,
copy accepted values into the manual draft, correct the values and source time,
then save, request review, approve and publish. After a manual publication,
review and reconnect the source; Resume refuses results changed while paused.
Manual entry remains available for races without a source. If connection status
is unavailable, manual draft entry remains available; refresh before publication.
The server still protects a section owned by an enabled source. Unknown numbers stay
blank; zero means reported zero. Manual changes require approval of their exact
values, source and status. No named person must approve every sourced update.

The team does not make its own race calls. Manual and Sheet AP calls need the
called candidate and an AP call link. The AP adapter carries its own call
attribution. A concession is not a call. Official and certified statuses need a
source that establishes that status. Each public race shows source, source time
in Eastern time, reporting share and a table alternative. Open **Race approval
history** in the manual race or Workflow view for approved manual revisions.
Connection actions, holds and accepted source updates are audited separately.

## Use the content outline

The outline is the fastest way to understand a long composition.

Use it to:

1. Read the block order before making changes.
2. Jump directly to a block.
3. Move a block up or down.
4. Identify hidden blocks.
5. Return to the active block after scrolling.
6. Check that a moved block landed where intended.

The outline and editor should describe the same composition. If their order or
visibility disagrees after loading finishes, stop before saving and report the
record address and mismatch.

## Distinguish editable, locked, and derived content

### Editable blocks

Editable blocks have fields or controls that your role can change. They form
part of the saved draft.

### Locked regions

Locked regions explain context that belongs to the public shell, a schedule
feed, a media player, an account system, or another protected integration. They
help the editor understand the page but do not become ordinary draft blocks.

### Derived content

Derived content comes from an approved external or shared source. It may be
placed automatically on the public page. Do not copy it into a text block to
make it appear editable; that creates a duplicate that will drift from the
source.

If a required integration is wrong, report the integration and public page
rather than editing neighboring copy as a workaround.

### Home page ownership

Home keeps its hero, newsletter signup, program and news shelves, and Passport band in
their assigned positions. In **Page content**, select **Edit Home hero** to open the
Home hero dialog. Choose up to ten linked items there. The hero is separate from body blocks. See
[Home hero selections](../pages-posts-and-library/#home-hero-selections).

A Home draft with section editing enabled exposes compact cards for the sections
that render publicly and supports added content between complete sections. Open
a card to edit it in the shared component dialog. Use **Preview** to check the
public layout. Without a saved Newsletter section, the public newsletter band
stays fixed. A saved Newsletter section can move with the other Home sections.
Manual content shelves retain their own placement controls. Legacy Start here data remains stored for
compatibility, but it has no public output and is not editable.

In a converted Home draft, open **Add**, then choose **Donor-advised giving** to propose
one giving section. Edit its heading, short summary and button text; the button
starts as **Learn more** and always opens the Support page. Move the whole plank
with its header grip or **Move to…**, then save and reopen to check its
position. **Remove section from page** retains the copy for
**Add** → **Donor-advised giving**, with the **Restore hidden section** description. Adding a new section is unavailable in a read-only
draft or when the total Home content limit is reached. Restoring its retained
identity uses no new slot. The giving plank has its
own slot and leaves ordinary card sets available. The summary keeps one
paragraph, converting line breaks and tabs to spaces. An incomplete giving plank
is omitted from private preview until its heading and button text are complete.
Saving these controls updates the draft; publication is a separate action.

## Add a block

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Add content where it belongs.</strong> Each block shows a preview and an Edit button. Edit opens the block's fields and its Hide from page, Duplicate, and Remove controls in a dialog. Hide keeps a block in the draft; Remove takes it out of the composition. </figcaption>
</figure>

1. Place focus near the position where the new content belongs.
2. Select **Add content** at the position where the block belongs. Some older
   surfaces label this **Add block**.
3. Search when needed, select the block type that matches the editorial purpose,
   and then select **Insert block**. Selecting a type does not add it by itself.
   **Add row** stays a separate choice where rows are available.

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Choose, then insert.</strong> The radio shows the pending choice before the separate Insert block action changes the draft. An unavailable type stays visible with its reason. </figcaption>
</figure>

4. Select **Edit** on the block to open its fields in a dialog.
5. Complete every required field.
6. Add accessible labels, alternative text, credits, or link purpose where the
   block calls for them.
7. Select **Done**, then check the outline position.
8. Save the draft.
9. Reload and verify the new block.

Choose blocks by meaning, not by visual novelty. A heading is for document
structure, an image is for informative or editorial media, and a notice is for
important contextual information. Do not use an unrelated block merely because
its current styling looks convenient.

### Size a video player

The video or embed block shows YouTube, Vimeo, TikTok, Instagram, Facebook video and PBS/COVE
player links or iframe code as players. X/Twitter video links show as cards.
Other links show as links. Players load as you scroll near them. No extra click
is needed to load a player. You can set Player width,
Player height, or both in pixels. Leave both blank to use the pasted ratio or
provider default: 9:16 for TikTok and Instagram or Facebook Reels, 16:9 for other players. A manual size is a preferred size. The player still shrinks to
fit a narrow page or row without changing its shape. Use a player shape from
portrait 9:16 through wide 21:9.

## Edit a block

Before changing a block:

- Read its type and current visibility.
- Copy a sensitive original value into an approved work note when recovery may
  be necessary.
- Confirm that the field is content, not a path, identifier, asset URL, or other
  protected value.
- Check whether the same information is maintained elsewhere.

After changing it:

1. Review the full block, not only the edited field.
2. Check the outline and neighboring blocks.
3. Save.
4. Wait for the success confirmation.
5. Reload when persistence must be proven.

## Check the component phone preview

In a component dialog, open **Phone preview** to check the current component or
selected row with your draft changes. It does not save or publish them.

Use **Screen size** to choose **Small phone: 320 × 568**, **Phone: 390 × 844**
(the default), or **Large phone: 430 × 932**. The content uses the selected
dimensions, then scales to fit the panel. The percentage below the screen shows
that display scale. Scroll inside the screen to see the rest of the component.

Supported players work in this preview, including YouTube start times. Custom
HTML can load its CSS and fonts; its scripts stay disabled. To check surrounding
content and the complete page layout, save the draft and use **Preview**.

## Move a block

Use the outline or the block's movement controls.

- Move one position at a time when order is consequential.
- Confirm the new order in both the outline and editor.
- Check heading hierarchy after moving a heading or section.
- Check that an image, caption, or call to action still follows the content it
  supports.
- Save only after the complete sequence makes sense.

Moving a block changes public reading order after publication. It can also
change keyboard and screen-reader order. Visual placement is not the only
consideration.

### Arrange the Support page

On a Support draft enabled for complete section arrangement, the transition
notice, check instructions, donor advised fund (DAF) content and destination
cards are ordinary blocks in **Page content**. Their order is the public page
order after publication.

1. Open **Pages**, then **Support NJ PBS** and **Page content**.
2. Open **Outline** and select the block you want to move. If its component
   dialog opens, choose **Done** to return to the outline.
3. Drag the selected plank's header grip, or focus it and press Up or Down.
   On touch, hold the grip before dragging. Escape cancels a drag. The outline
   also offers **Move up** and **Move down**. Use the header's **Move to…** control
   to choose an explicit destination. Repeat until
   the outline shows the desired sequence. For example: transition, checks,
   DAF and FAQ, then the **card set** containing Give, Member and Help.
4. Select **Edit** on a text or card set block to change its copy, links or
   images. **Done** returns to the page. **Hide from page**, **Duplicate** and
   **Remove** are in the component dialog's settings.
5. Use **Add content** at the desired position to insert **Text**, a **Card
   set** or an **FAQ item**. Complete its fields, then choose **Done**.
6. Save the draft and use **Preview** to check the complete page at desktop
   and phone sizes. Saving keeps the change in the draft; publication follows
   your usual review and role permissions.

The existing DAF text contains its FAQ in the same text block, so moving that
block moves both together. To move questions independently, put each question
and answer in an **FAQ item**, then remove the duplicated question and answer
from the DAF text. Save the draft, then review the complete saved Preview before
publication.

The page title and summary stay in **Title and summary**. Rearranging workspace
panels changes your editor view; use block controls inside **Page content** to
change the public sequence. Other service pages can retain fixed public
placements until their section arrangement is enabled.

## Hide or show a block

A hidden block remains in the draft but is omitted from the rendered page.

Use hiding when:

- Content is temporarily not ready.
- An approved campaign or notice is paused.
- The block must retain its settings for later restoration.

Do not use hiding to conceal sensitive information that should not be stored in
the CMS at all.

After changing visibility, confirm both the block state and the outline state.
A hidden label or status should accompany any visual styling.

## Open block settings

Only blocks with editable settings should expose a settings control. Settings
can affect layout, labels, destinations, count limits, or other block-specific
behavior.

Before saving a setting:

1. Read the current value and help text.
2. Confirm whether the setting affects only this block or the full public
   section.
3. Check required minimums or maximums.
4. Review any destination or URL.
5. Close without saving if you opened the panel only to inspect it.

A setting is not safer simply because it is visually smaller than a content
field.

## Remove a block

Removal is different from hiding. It deletes the block from the current draft
composition when the draft is saved.

Before removing:

- Confirm the record and block title.
- Check whether the content is duplicated elsewhere.
- Decide whether hiding better matches the editorial intent.
- Check whether a required minimum number of blocks or cards would be violated.
- Ensure revision history can support recovery.

After removing, read the complete outline before saving. If the wrong block was
removed and the draft has not been saved, restore it in the current session or
discard the unsaved change. If the removal was saved, use revision history
according to your role and recovery procedure.

## Reorder and collapse editor sections

Editor sections can be rearranged or collapsed to make the workspace easier to
scan. Those choices do not change public content.

A useful arrangement is:

- Main editing section in the wide zone.
- Metadata, lifecycle, or supporting context in the narrow zone.
- Frequently used sections above occasional administrative sections.
- Preview collapsed until needed.

If the editor appears to be missing a section, check whether it is collapsed,
moved lower in the page, or placed in the other zone before reporting a defect.

## Know when saving is disabled

The primary update action should be disabled when the current editor matches the
stored draft or when required validation has not passed.

When saving is unexpectedly disabled:

- Confirm that you changed an editable field.
- Remove leading or trailing changes that normalize to the stored value.
- Check required fields and block limits.
- Check whether the record is read-only for your role or lifecycle.
- Wait for the record to finish loading.
- Look for a validation message near the field and near the primary action.

Do not create a meaningless change solely to enable the button.
