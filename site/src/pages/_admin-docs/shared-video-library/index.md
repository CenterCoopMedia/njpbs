---
title: Videos
description: "Browse, upload, play, seek through, download, and maintain private staff video files in Boardwalk."
---

## Open Videos

<figure class="admin-docs-video">
<video controls preload="none" playsinline width="1280" height="720" poster="/guide-content/videos/shared-video-library.jpg" aria-label="Find, upload, and organize shared videos" src="/guide-content/videos/shared-video-library.mp4">
<track kind="chapters" src="/guide-content/videos/shared-video-library.vtt" srclang="en" label="Chapters" default></track>
</video>
<figcaption>Find, upload, and organize shared videos. <a href="/guide/video-tutorials#find-upload-and-organize-shared-videos">Open this video in the tutorial list</a>.</figcaption>
</figure>

<p>Transcript: Find, upload, and organize shared videos. <a href="/guide/video-tutorials#find-upload-and-organize-shared-videos">Read the full transcript in the tutorial list</a>.</p>

Open **Media library** from the Boardwalk navigation, then select the **Videos**
tab. Every approved, active staff account can
browse, preview, and download from this source. Uploading requires global
media upload access. Editing details requires global media management access.

Some screenshots retain earlier media labels and tab order. **Images and documents** is now **Images**, **Shared video library** is now **Videos**, and **Voiceovers** is now **Audio**. Use the current names in the navigation.

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Use the shared toolbar and select cards to work with several videos at once.</strong> This local sample includes the shared toolbar and a ready video card with its duration and preview state. Select a card's title to open it, or its checkbox to select it. This example uses synthetic metadata; it does not show a production job. </figcaption>
</figure>

Use Boardwalk for this work. You do not need to sign in to the AWS console.
Boardwalk creates temporary private access when you open or download a video.
Boardwalk prepares posters for ready videos with the page. A poster appears when
its card or row comes into view. A poster that was not ready, or that did not
arrive with the page, is requested then.

When the Boardwalk panel for Adobe Premiere Pro is turned on, video editors can
also browse this library, import video and return finished videos from
Premiere. See [Premiere Pro panel](/guide/premiere-panel).

The **Videos** tab is separate from **Images**. Available video sources depend
on the configured integrations.

Select the heart on a video card to save it to your account without opening
the video. On a phone, open the card's **More** menu and choose **Add to
favorites**. The same control appears in the video's preview dialog. Open
**Media library → Favorites** to review saved videos with your saved images,
documents and audio. Select the filled heart to remove an item. A favorite does not change who
can open the source, and it does not publish the video. Voiceover favorites use
the same shared heart and appear in **Favorites**.

To change several favorites at once, select up to 100 videos and choose **Add
to favorites** or **Remove from favorites** in the selection bar. The same
actions appear in a selected card's menu. Wait for the save to finish before
opening a video. Any videos that could not be changed stay selected for retry;
if the result is unconfirmed, check the refreshed hearts before trying again.

## Add videos to a collection

Select the checkbox on a video card or list row. A selection bar appears at
the bottom of the results. It shows how many videos you selected, out of 100,
and how many are on other pages. Use **Select this page** in the bar to add
every video on the page, then select **Add to collection**. You can select
across pages and filters. One collection change accepts up to 30 videos. Choose
a private collection or one shared with all active staff. After the add
finishes, focus returns to the card you last used.

To add one video without changing your selection, select **Add to collection**
on its card, or choose it from the card's **More** menu.

On the keyboard, use the arrow keys to move between cards (Up and Down in the
list), Space to select the current video, Shift+Arrow to extend a selection, and Ctrl+A (Command+A on a Mac)
to select the page. Press Escape or select **Clear selection** to clear it.

This action saves references to the existing videos. It does not upload another
copy, change uploader attribution, publish a video, or grant source access.
Open **Media library → Collections** to rename, remove references, archive, or
restore the package. Any approved active staff member can organize an all-staff
collection. Only its owner can open a private collection.

### Preview with Quick Look

Choose **Quick Look** from a card's **More** menu, or focus the card and press
Command+Y on a Mac or Ctrl+Y on Windows. Quick Look opens a light poster preview
without the player, details form, transcript, or production tools.

Use Left and Right Arrow, or **Previous** and **Next**, to move through the
videos on the loaded page. The counter shows your place. Quick Look does not
load the next video in advance. Press Escape or the same Quick Look shortcut,
click outside it, or move Tab past either end to close it. Focus returns to the
video that was on screen unless you clicked another control.

Quick Look uses a poster already held by the page. If that poster has not been
loaded, Boardwalk can request it once through the same bounded poster queue the
cards use, then caches it. Opening a cached poster and stepping between cached
posters make no request.

## Edit metadata for selected videos

Select up to 100 videos, then choose **Edit selected**. The shared inspector opens beside
the results, or as a full-height sheet in a narrow window. Its preview stack uses
posters already loaded in the browser. It keeps a fixed snapshot of the selected
videos.

In **Details** and **Rights**, use each field's menu to leave description,
credit, license or rights review unchanged, set one value on every selected
video, or clear a text field. Name and filename stay out of the batch.

In **Tags**, a solid token is on every video and a dashed token whose accessible
name includes "mixed" is on only some. Remove a mixed token to remove it where
present. Add a token to add it to all selected videos. Video tags use exact
spelling and case. Each resulting video can have 30 tags of up to 80 characters.
The Tags menu can replace or clear every tag and warns before existing tags are
removed.

Select **Review N changes** to compare each before-and-after value. **Back to
editing** keeps the inspector draft. Nothing is saved before **Apply to N
videos**. Saves run one video at a time, at least 2.1 seconds apart. Unchanged
videos are skipped, and conflicts are shown without an automatic retry. The
list refreshes once after you close an attempted batch. Opening and editing the
inspector and opening review make no additional request.

## Find and open a video

1. Enter the start of a video name in **Search video names**.
   Boardwalk applies the search 300 milliseconds after you stop typing. Press
   Enter to apply it at once. Name searches always use alphabetical order.
   When the search is empty, Boardwalk does not scan the transcript corpus.
2. Select **Filter**, then choose Tag, Rights review, or Uploader. Enter an exact
   tag, choose **Needs review** or **Rights recorded**, or choose **Me**. One
   filter property applies at a time. Choosing another replaces the first.
   You can combine the one filter with search. Applied filters appear as chips.
   **Clear all** removes the chips and search.
3. Staff with access to the staff directory can choose another named uploader
   under **Filter → Uploader**, open the card's **More** menu, or
   right-click the card or row, and choose **Show videos uploaded by** their
   name. Other staff can use **Me** without seeing account IDs or the staff
   directory. To find a related topic, select a visible tag on a card. Each card
   shows up to three tags when Tags is enabled in Display; pause on the video
   title or open its details to see the rest.
4. Use **Sort** to choose **Recently updated**, **Oldest update**, or
   **Name A–Z**. Name searches always use alphabetical order. Update order
   changes when video details are saved; it is not upload-date order.
5. Open **Display** to choose Grid or List, Small, Medium, or Large thumbnails,
   **Use app setting**, Compact, Comfortable, or Loose density, and the facts
   shown on cards and in list columns: Type, Size, Duration, Rights, Updated,
   Tags, and Uploader. Uploader is unavailable without staff-directory access.
   These choices stay in this browser. Changing layout, thumbnails, density,
   or fields reuses the loaded page and keeps your selection.
6. In **Display**, set **Per page** to 24, 48, or 96. This choice loads the first
   page at the new size. Use **Previous page**, **Next page**, and **First page**
   to move through results. A List row keeps the same configured facts and
   actions as its Grid card. At smaller widths, facts move under the title.
7. Read the title and preview state, then select the card to
   open the file preview. Pause on the title to see the duration, frame size,
   rights, update date and every tag without opening the video:
   - **Preview ready** means that the private web copy is ready to play.
   - **Preparing preview** means that Boardwalk is making the web copy. This can
     take time for a large file.
   - **Preview not prepared** means that Boardwalk has not started a web copy
     for this video.
   - **Preview unavailable** means that Boardwalk could not make the web copy.

Search, the one filter, sort, per-page choice, and the opened video are in the
page address. Back, Forward, refresh, and a copied link restore them for this
video source. During an active upload, every browser Back or Forward change
opens the leave-work prompt, even when only the video search or filter changes.
You can still change search and filters directly in the toolbar during the
transfer. A refresh or copied link starts at page 1 because later-page
cursors stay only in the current browser session.

The card and list search starts at the beginning of the video name. Related
transcript results above them also find words within saved passages and start
only after you search. Filtered cards show the number on the current page.

Transcript results are grouped by video. Each group shows its poster, file name
and match count. Passages show their start time and nearby words, with the search
text highlighted. Select a passage to open the file at that time. Select the
video name to open at the start. Boardwalk checks current access and the saved
transcript revision before opening a passage. If the text changed, reload the library to refresh search.
Closing the preview returns to the library and keeps the search.

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Choose a passage within its video.</strong> This local example uses synthetic names and transcript text. The timestamp opens the internal file link.</figcaption>
</figure>

**Uploaded by** uses the staff name linked to the original upload when your
account can view the staff directory. Other accounts see **Staff uploader** and
cannot filter by that account ID. **Uploader name unavailable** means that the
uploader was recorded but their name is unavailable to an administrator.
**Not recorded** means that the video has no recorded staff uploader, including
files imported from storage. It does not identify the import operator as the
uploader.

## Play, seek through, and download a video

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Use the browser player for the private web copy.</strong> This synthetic local fixture shows the native browser controls. Play, pause, and move along the timeline without saving a local copy. The displayed sizes and ready state are examples, not production results. </figcaption>
</figure>

When the card says **Preview ready**:

1. Select the card. Boardwalk opens its private MP4 web copy in the browser
   player.
2. Use the player's play control to start the video.
3. Drag the player timeline to seek through the file. You can also focus the
   timeline and use the browser's keyboard controls.
4. If playback access expires or stops, select **Refresh preview**. Boardwalk
   requests new private access and keeps the current playback position when the
   browser reloads the video.
5. Open **Download** in the header. Choose **Web copy** for the web-ready MP4
   or **Original** for the source file. Each choice shows its file size.

If the video has a saved credit, confirm the on-screen credit before downloading.
If another editor added or changed it since you opened the video, the prompt shows
the current credit. Cancel stops the download. Use Boardwalk's download buttons;
the player does not offer its own download menu or context menu.

For landscape video, the web copy is at most 1920 × 1080. Portrait video stays
in portrait orientation within the corresponding 1080 × 1920 frame. Boardwalk
keeps the source aspect ratio and does not enlarge a smaller video. The size
reduction depends on the source file. The original file stays unchanged.

You can download an available or restored original while its preview is being
prepared or when a preview is unavailable. An archived original needs a restore first. Some browser-compatible originals can also play while
the web copy is not ready. A format that has no browser playback needs a
compatible player on your computer.

A preview or download does not publish the video. **Download → Original** and
**Download → Web copy** return the whole file. Use **Create a clip** for an in/out
selection. Moving the playback timeline alone does not trim a download.

## Restore an archived original

Video cards, list rows, and details show the original state separately from the
web viewing copy: **Original available**, **Original archived**, **Original
restoring**, or **Original restored**. **Original status unchecked** means the
storage check did not finish. Open the video for a fresh check; its header facts
show the result. **Check original status** is in **Watch & details**, or below the
viewing area when no transcript is available. Archive and
restore controls appear near the top of both workspace panes. List states can be
up to 15 minutes old.

1. Open the video. Its existing details and Edit controls remain available.
2. If the original is archived, select **Restore original** near the top of the viewer.
   These controls stay visible in both **Watch & details** and **Transcript**.
   If you see a note to ask a person who manages video, that restore is charged.
   Ask that person to start it.
3. Wait for the restore. Standard retrieval can take up to 12 hours. Use **Check original status** to check progress.
4. On your next visit to Videos after completion, Boardwalk shows a private
   **Original restored** notice. Select **Open video**, then download the original
   or request the export again. Select **Dismiss** to clear your notice.

The staff who can download the original can request most restores. A charged
restore needs the permission to manage video. Only staff
who requested the restore receive its private notice. Repeated requests do not
start another retrieval. If the request cannot be
confirmed, check status before trying again. After 72 hours without confirmed
completion, Boardwalk shows a notice that needs attention. Check the original
status or ask a CMS administrator for help.

The web viewing copy, poster, saved transcripts, and MP4 clips made from the web
copy remain available during restore. Exports that need the original give a
restore message and start after you retry them with the restored original.
Restoring does not change or publish the video. A restored original stays ready
for at least 7 days. It can then return to the archive. If it does, select
**Restore original** again.

## Step through videos on this page

In the video's preview dialog, select **Previous file** or **Next file** to move through the videos
on the page you opened. The counter, such as **3 of 24**, shows your place in
that page. The first and last videos have no step beyond the page.

Left and Right Arrow also step when focus is on the viewer frame. They keep
their usual action in the player, its controls, the transcript, and text fields.
If you have unsaved changes, Boardwalk asks you to discard them or keep editing
before it moves. Save changes you want to keep, then step. Closing the viewer
returns focus to the video on screen, or to the next available card if that
video no longer matches the current view.

## Upload videos

Select **Upload** in **Videos**, press Command/Ctrl+U outside a text
field, or drag a video over the results. Boardwalk opens the upload sheet beside
the results. Closing the sheet does not stop an active transfer; its progress
stays in the upload tray.

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Resume a saved transfer with the same original file.</strong> This controlled sample is paused at 41 percent. No upload occurred for the screenshot. </figcaption>
</figure>

Upload a file only when the shared library does not already contain the video.

1. Drop files over the video results, or open the sheet and select **Upload media**.
   If you choose an image, PDF or WAV, the Video sheet closes while the media
   upload form is open.
2. Review the title, description, rights status, credit, license and tags for
   each video. Separate tags with commas. Use up to 30 tags of up to 80
   characters each. Boardwalk uses the filename as the first title.
3. Select **Start upload** for one video, or **Start all uploads** after you
   review a batch. The sheet closes so you can use the video library while the
   transfer continues in the upload tray. Approved files wait when both
   transfer slots are in use and start as slots open.
4. Keep the Boardwalk tab open while each active transfer runs.
5. Read the status for **Checking file**, upload percentage, **Verifying
   upload**, or a state that needs attention.
6. Wait for the message that the original file is ready in the video library.
7. Find the new card. Boardwalk prepares its private web copy in the background.
8. When the card says **Preview ready**, check its playback and complete its
   details. You can download an available original before this step is complete.

Use the upload tray to Pause, Resume, Retry, or Cancel a transfer. Select its
summary pill on a phone to reopen the sheet. **Clear queue** stays in the sheet.
Only the tab that owns the video queue can use these controls. If Boardwalk was
reopened, Resume asks for the same original file.

The accepted video file types are MP4, M4V, MOV, WebM, MPEG, MPG, MKV, AVI, WMV, and
MXF. Each file can be up to 250 GiB. The transfer list holds up to 20 files and
can run up to two transfers at once. A prepared file starts only after you
select its **Start upload** control or approve its batch with **Start all
uploads**.

The same control also accepts JPEG, PNG, WebP, GIF, AVIF, and PDF files. Those
files open the image upload form on this page. Boardwalk stays on this video
library. After an image or PDF upload finishes, a notice names **Images** and
offers to open that tab. A file that is not an image, PDF, or
video is listed on its own. The other files continue. Favorites, Collections,
and Audio use this same control.

Boardwalk derives the first title from the filename and sets **Rights review**
to **Needs review**. The upload creates a private library asset. It does not add
the video to a public page or post.

Only one Boardwalk tab in the same browser profile can manage transfers in the
shared library. Other tabs in that profile can still browse, preview, and
download. This does not prevent uploads in another browser or on another device. If the panel says
that transfers are open in another tab, close that other tab before you manage
them here. A browser without the required upload lock can still view and
download videos, but it cannot upload them.

## Pause, resume, or cancel a transfer

This tutorial shows the earlier file-selection step. Boardwalk now pauses after
selection so you can review the video details and select **Start upload**. The
batch control is **Start all uploads**. The pause, resume and cancel steps are
unchanged after the transfer starts.

<figure class="admin-docs-video">
<video controls preload="none" playsinline width="1280" height="720" poster="/guide-content/videos/pause-resume-upload.jpg" aria-label="Pause and resume a video upload" src="/guide-content/videos/pause-resume-upload.mp4">
<track kind="chapters" src="/guide-content/videos/pause-resume-upload.vtt" srclang="en" label="Chapters" default></track>
</video>
<figcaption>Pause and resume a video upload. <a href="/guide/video-tutorials#pause-and-resume-a-video-upload">Open this video in the tutorial list</a>.</figcaption>
</figure>

<details><summary>Transcript: Pause and resume a video upload</summary>
<p>Descriptive guide. The video has interface sounds, optional instrumental music, and no spoken narration.</p>
<p><strong>Title</strong></p>
<p>The NJ PBS logo and &quot;Pause and resume a video upload&quot;. The opening includes a screen preview, duration and step count.</p>
<p>Outcome: &quot;Pause a transfer safely, continue it, and recognize the confirmed upload result.&quot;</p>
<p><strong>Overview: Start in Shared video library</strong></p>
<p>Use the same Boardwalk tab for the transfer. This demonstration uses a generated practice file.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Choose the local practice recording&quot;. Select the upload control and choose the local practice file &quot;boardwalk-sample.mp4&quot; in the file picker. The operating-system picker is omitted from the video.</li>
</ul>
<p><strong>Step 1 of 3: Pause the active transfer</strong></p>
<p>Pause keeps the incomplete transfer so you can continue it later.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Pause this transfer&quot;. The pointer clicks it. The result callout says &quot;The transfer can resume&quot;.</li>
</ul>
<p><strong>Step 2 of 3: Resume in the same tab</strong></p>
<p>The same-tab transfer still has its file. After reloading, Boardwalk can ask you to select it again.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Continue the paused upload&quot;. The pointer clicks it. The result callout says &quot;The original upload is confirmed&quot;.</li>
</ul>
<p><strong>Step 3 of 3: Separate upload from preview preparation</strong></p>
<p>The original can finish before its web preview is ready. Neither action publishes a video.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Read the upload confirmation&quot; and &quot;Preview preparation is a separate step.&quot;</li>
</ul>
<p>Remember:</p>
<ul>
<li>Do not upload a second copy</li>
</ul>
<p><strong>Recap</strong></p>
<p>&quot;Continue without starting over&quot;. Result pictures and confirmation marks accompany these points:</p>
<ol>
<li>Pause the active transfer</li>
<li>Resume the same upload</li>
<li>Check original and preview separately</li>
</ol>
<p><strong>End</strong></p>
<p>The NJ PBS logo and &quot;More help: open the Boardwalk guide from Home.&quot;</p>
</details>

- Select **Pause upload** to stop the current browser requests and retain the
  incomplete transfer for later.
- Select **Resume upload** to continue. After a reload or later visit, select
  the same original local file.
- Select **Cancel upload** to remove a queued transfer or cancel its incomplete
  upload. Cancel does not delete a completed library asset.
- Select **Clear queue** to cancel each transfer in order. If a server request
  fails, that row and later rows stay in the queue. Try again after the error
  is resolved. Clear queue stops at older saved transfers that have no known
  server session. Remove those rows one at a time with **Remove saved transfer**.

If a start or another control request times out, use **Resume upload** or
**Cancel upload** again. Boardwalk keeps the transfer record while it checks
the server result. A saved transfer from an older Boardwalk build may have no
recoverable server session. Its action says **Remove saved transfer**; this
removes only the browser record. Boardwalk states that server cancellation was
not confirmed. Check the library before removing the row, then add the file
again if it is still needed. An unfinished server session expires after 24
hours, and incomplete S3 parts are cleaned up after seven days.

If the server confirms that an upload already completed, Cancel removes its
saved transfer from this browser. The video remains in the library. Refresh
the library to see it. An upload still being completed stays in the queue.

An upload session expires after 24 hours. If you leave **Media library** or
change sources during an active transfer, Boardwalk asks you to confirm. Pause
the transfer first when you intend to continue it later.

## Edit video details

<div>
  <figure class="admin-docs-screenshot">
    <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
    <figcaption><strong>Use the details inspector beside the player.</strong> File information shows the measured source rate and broadcast notice. Edit its sections, then use Save details beside Close at the bottom of the dialog. Use the header Download menu for file formats. File information and Delete from library start closed; this example opens File information to show its read-only facts. <span class="admin-docs-image-note">Example screen. Screenshot omitted..</span></figcaption>
  </figure>
  <div class="admin-docs-details-copy">
    <p>Staff with global media management access can edit details in Videos.</p>
    <ol>
      <li>Open the video card and find <strong>Video details</strong> beside the player. On a narrow screen, it follows the player.</li>
      <li>Enter an accurate <strong>Title</strong> and <strong>Description</strong>.</li>
      <li>Record the required <strong>Credit</strong> and <strong>License</strong> information.</li>
      <li>Add <strong>Tags</strong> for topics, programs, places, or production types. Press Enter or type a comma to make each tag a token. Then set <strong>Rights review</strong>. Use consistent spelling and capitalization so people can find related videos with <strong>By tag</strong>.</li>
      <li>Select <strong>Save details</strong> beside <strong>Close</strong> at the bottom of the dialog and wait for <strong>Video details saved</strong>.</li>
    </ol>
    <blockquote>
      <p><strong>Before you save:</strong> Leave <strong>Rights review</strong> at <strong>Needs review</strong> until the required review is complete. Select <strong>Recorded</strong> only after that review. This example has no unsaved change, so <strong>Save details</strong> is unavailable.</p>
    </blockquote>
    <p><strong>Recorded</strong> means that staff completed the rights review. It does not grant public-use rights, publish the file, or insert it into public content. These values do not grant rights for another file. The original filename, file size, and file type do not change when you edit details.</p>
    <p>Read-only staff can inspect Details, Rights, Tags, and File information and can use the header Download menu. The inspector shows <strong>Read-only media access</strong> instead of Save details and Delete from library.</p>
    <p>Boardwalk warns before you close the dialog, change routes, or leave the browser with unsaved details. Select <strong>Keep editing</strong> to return, or use <strong>Discard changes</strong> to close the video without saving. The route-change warning uses <strong>Discard and leave</strong>. If another save changed the asset first, select <strong>Reload details</strong>, review the current values, and make your change again when needed.</p>
  </div>
</div>

## Delete a video from the library

This control appears only for staff with permission to manage the whole
media library. Permission to upload does not include permission to delete.

1. Open the video and expand the final **Delete from library** section in the
   details inspector.
2. Save or discard any unsaved detail changes.
3. Select **Delete from library** and check the video name.
4. Select **Yes, delete from library**, or **Keep video** to cancel.
5. Wait for **Video deleted from library**. The video is removed from browse
   results, and Boardwalk records the action in Activity.

You can also choose **Delete from library** from a card's **More** menu. It
opens the video at the same confirmation, so you still check the name first.

The original and web copy remain stored for recovery. Boardwalk has no restore
control. If a deletion was a mistake, report the video title and deletion time
to an administrator. A private link opened before deletion can work until it
expires. If another person changed the video first, select **Reload details**,
check the current video, and retry only if deletion is still needed.

## Make or open a transcript

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Check the source rate and estimate before preparing a copy.</strong> This sample is scrolled below the player to the clip and export controls. The 120-second synthetic source uses 25 fps; its full-video MP4 selection estimates $0.048 at 29.97 fps. The saved ready result is a fixture. No export was submitted. </figcaption>
</figure>

The wider dialog docks Video details beside the player. Download is available in the header menu. Delete stays in the
inspector. Transcript and Create clip controls are in the header or its More menu;
their sections stay below the player. On narrow screens, the inspector follows the player.
**Save details** sits beside **Close** at the bottom of the dialog. On a phone it
shows as a check mark button on the same row.

1. Open a video with a ready web copy. Select **Transcript** in the preview header (or **More** on a narrow screen), or expand **Transcript** below the player.
2. Choose the spoken language: English or Spanish. Boardwalk checks for a saved
   transcript with those settings.
3. If no transcript exists, select **Transcribe video**. Processing continues
   while the modal is closed. Return to the same video and language to check it.
4. When ready, read the speaker-labeled text in the expanded Transcript section. Select a
   timestamp to move the preview to that passage. Use **Load more transcript**
   for longer recordings.
5. Use **Download text**, **Download captions** or **Download SRT captions** below the player for TXT, WebVTT or SRT.

Before selecting **Transcribe video**, read the provider notice. It reflects the
current server configuration:

- **Free local processing:** the station machine has no per-minute
  recognition charge. You can queue many videos while another runs, without a
  per-person active limit or daily cap. Queued requests wait in order. If audio cannot be prepared after three
  consecutive unexpected errors, that video fails and the queue moves on.
  Temporary service errors and restores in progress do not use these attempts. The station
  can hold 500 queued or running requests as a safety ceiling.
  When fallback is enabled and local processing cannot complete, the station
  ElevenLabs key is tried before Amazon Transcribe. If fallback is disabled, an
  administrator must check a request that local processing cannot complete.
- **ElevenLabs first:** when local processing is off, the station key is tried
  first and Amazon Transcribe remains the final provider. Paid recognition
  charges can apply.
- **Amazon Transcribe:** an older server policy can use Amazon directly and
  incur a recognition charge.
- **Unavailable or provider not verified:** new requests are disabled. Select
  **Check availability** to check again; contact an administrator if it persists.

For free local requests, open **Paid backup details** to see the possible
Amazon charge. A direct paid request shows the estimate in its provider notice. The estimate uses $0.36 per
hour, billed in one-second increments, and excludes storage, request charges and
credits. It is an estimate, not a charge receipt. The job status identifies the
service used and any fallback reason.

### Who pays for transcription

Local Whisper processing uses station hardware. It has no recognition-provider
fee, but electricity, hardware, storage and maintenance still have costs. A paid
Amazon fallback uses the station AWS account. An ElevenLabs request charges the
account behind the key you explicitly select: your personal account or the
station account. A transcript remains shared with library staff in either case.

Published base recognition prices checked September 22, 2026:

| Processing path | Billing unit | One audio hour | 10,000 audio minutes |
| --- | --- | --- | --- |
| Local Whisper, with no cloud fallback | No recognition-provider fee | $0 provider fee | $0 provider fee |
| Amazon Transcribe batch, Ohio | $0.0001 per second | $0.36 | $60.00 |
| ElevenLabs Scribe v2 API | $0.22 per hour | $0.22 | About $36.67 |

These examples assume one processing pass and exclude taxes, storage, transfer,
other services, discounts and account-specific terms. They are estimates, not
bills. Check the [AWS Ohio price feed](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/transcribe/current/us-east-2/index.json)
and [ElevenLabs API pricing](https://elevenlabs.io/pricing/api) before budgeting.
A retry or a different provider can have a separate charge. Opening a saved
result or saving a key does not start a paid transcription request.

Transcripts are cached. Opening or downloading one does not run transcription
again. Changing the spoken language requests a separate result. A ready MP4 web
copy of up to two hours and 2 GB is required. Speaker numbers distinguish voices;
they do not identify people. Review the words and speaker labels before use.

If processing needs attention, use **Check saved status** to read the saved
outcome. After a failed request or **Needs attention**, use **New transcript**
to choose another provider. The earlier request stays in history. Report its
reference to an administrator if you need help. When backup is enabled, a failed local attempt
can use paid backup. If the paid allowance is used or billing is stopped, the
request returns behind fresh local work. Three reported local failures need an
administrator's check; with backup off, the first local failure needs that check.
Waiting for the machine or a paid allowance does not count as a failed attempt. When a paid cap is reached, local requests
stay in the free queue. Paid limits remain five submissions and one hour per
person each day, 20 submissions and four hours for the station each day, and
one outstanding paid request per person. A paid request must reach a terminal
state before you can authorize a new attempt. A new attempt can have a new
charge; it does not refund an earlier uncertain submission.

## Transcription key settings

The **Transcription key settings** disclosure opens separate forms
below the transcript and clip sections. Saving a key does not start a provider request. Paid requests require a separate
key choice and consent, and the service must be enabled.

- **Your private key** belongs to your account.
- **Station default key** is visible only to Managers with global settings
  access. Station-funded transcripts belong to the station video library.
- Enter the ElevenLabs key and select **Save key** or **Replace key**. The field
  clears when submitted; saved keys are never displayed or returned.
- **Configured · unverified** means a key is stored. It does not confirm that the
  key works or has billing access.
- **Disconnect key** requires confirmation. Saved transcripts remain available.
- If the configuration changes elsewhere or a save cannot be confirmed, select
  **Reload key status** before trying another change.

**Save details** does not save keys. A typed key triggers the existing close
warning; pending key changes block close and navigation. Save or clear the entry
before closing its disclosure.

### Choose a saved result or another provider

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Choose the provider for another attempt.</strong> This local example shows the free provider after a request needs attention. Paid choices require consent and an available allowance. It does not show a provider run. </figcaption>
</figure>

The **Saved transcript** selector lists existing results and failed attempts for
this video.
Choose one to read, correct or download that exact result. **Default transcription
for this language** returns to the newest ready result for the current language
and speaker limit. A newer failed request does not hide that result. Local processing runs first
when enabled. When paid fallback is enabled, it uses the station ElevenLabs key
first, with Amazon Transcribe as the final fallback. Personal keys are used only
when you select one for a separate paid request. **Load more saved transcripts**
continues the list; opening a result does not start recognition.
Save or discard transcript edits before changing the selection.

After a failed request, **Needs attention** or a ready result, **New transcript**
provides a **Transcript provider** choice. The language and speaker limit start
with the earlier transcript settings. You can change them for this request:

- **Local transcription (free)** runs on our own machine, with no paid backup. Select
  **Request free transcript**. Local processing must be enabled.
- **Amazon Transcribe (paid)** uses the station account directly. Read the estimate
  and allowance, authorize the paid request, then select **Request Amazon
  transcript**. Paid requests support videos of one hour or less. An administrator
  must enable the Amazon route.
- **ElevenLabs (paid)** uses a configured personal or station key. Choose **My
  ElevenLabs key** or **Station ElevenLabs key**, check the language, speaker limit,
  price and allowance, then authorize the request and select **Request ElevenLabs
  transcript**. The transcript is shared with library staff even with a personal
  key. Stored keys remain unverified.

A matching active request or ready local result is reused without a new retry.
A new free retry allows one active request from the earlier transcript and one
active request for you, with five new free retries per UTC day. The initial free
request for a video keeps its existing queue policy. Changing language or speaker
limit does not bypass retry limits.

Queued and processing requests must finish before another attempt. Each attempt
keeps the earlier row and any saved result. Wait for the request to be recorded
before closing the video; processing can then continue while it is closed. If a
request cannot be confirmed, check the saved list before another submission.

An earlier uncertain Amazon request can still hold the paid request slot after a
free retry finishes. Select that earlier request in **Saved transcript**, then
request Amazon again from that history row. A request from a later result does
not replace the earlier uncertain request's slot. The earlier intent and used
allowance stay recorded.

The provider input cap is two hours and 2 GB. The paid requester's daily allowance is
smaller: five requests, 60 audio minutes and one outstanding request. The library
allowance is twenty requests and 240 audio minutes. Daily limits reset at midnight
UTC. Reserved work counts toward these limits. Once the service records submission
intent, the allowance is consumed even if the provider result is uncertain;
neither figure is a confirmed charge receipt. Use
**Reload transcription options** after a key change or to check availability and
remaining limits. Unavailable or unverified options disable paid requests.
Input preparation can retry within the same saved request before the provider
is called. The provider call has a ten-minute deadline. An uncertain response
never starts another paid call automatically. The service can recover an exact
saved result, but a missing result needs an administrator's check. Correcting
words can remove the timing needed for Premiere; the other transcript downloads
remain available.

## Check transcription and clip progress

Open **Transcript** or **Create a clip** to see the last confirmed status:

| Status | What it means |
| --- | --- |
| Queued | The request is saved and waiting to start. |
| Preparing | The service is preparing the input. |
| Processing | The service is handling the request. |
| Finalizing | The service is checking and saving the result. |
| Ready | The saved result is available. |
| Failed | Processing stopped. Follow the help shown with the status. |
| Needs attention | The result needs an administrator's check before another run. |
| Expired | The clip is no longer available. Export the range again if needed. |

Boardwalk shows only stages reported by the service. Some jobs do not report
each stage. **Provider** identifies the processing service. **Requested by**
shows the saved staff display name when known. Otherwise, **Requester account**
shows the saved account ID. Fields with no saved value are hidden. For free local
requests, open **Paid backup details** to see a possible paid estimate.

For an active node-gpu-b request, the panel can also show download, audio preparation,
Whisper transcription, timestamp alignment, speaker separation, or result saving.
These are reported stages, not estimates of how much work remains. Once a request
uses Amazon Transcribe, the panel shows its cloud status and the fallback reason.

A paid-only request can stay queued while its paid allowance is used or another
paid request runs. Its status explains the wait; daily limits reset at midnight
UTC.

**Elapsed since request** includes time in the queue. **Last updated** is the
time recorded by the service. **Last checked** is the last successful check in
this browser window. A newer check time does not mean that processing advanced.
When the service records a completion time, the elapsed total stops there.
Boardwalk shows a percentage only when the provider reports one. It does not
estimate a finish time.

You can close the modal and return later. Use **Check saved status** for a
transcript or **Check status** for a clip to check now. If a check fails, the last
confirmed status stays visible. **Needs attention** stops automatic checks;
use the manual check or report the visible reference to a CMS administrator.
Only a confirmed clip failure can offer **Retry clip**, which can incur another
processing charge. Checking status does not start another run.

## Correct a transcript and identify speakers

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Correct words and speaker assignments.</strong> This local example uses synthetic text and speaker names. </figcaption>
</figure>

To name speakers:

1. Open the saved transcript and select **Rename speakers**. You can also open
   a passage's **Passage actions** menu and choose **Rename** for its speaker.
2. Enter names and titles or affiliations for the numbered speaker labels.
   Each name applies to every passage with that label, including passages not
   yet loaded. Clear a name to restore its numbered label.
3. If two people were grouped under one label, select **Add speaker** to make
   another numbered label. Select **Save speaker names**, then assign the
   affected passages to that speaker using the correction steps below.

**Unknown speaker** can include different voices. Assign each unknown passage
to a numbered speaker before adding its name or role.

To correct words or speaker assignments:

1. Select **Edit transcript** to open the first visible passage, or open a
   passage's menu and choose **Edit passage** for that passage number.
2. Correct the words and choose the speaker. Only one passage editor is open
   at a time. To move to another passage, use its menu's **Edit passage** action.
   Your unsaved corrections stay with you between passages and pages.
3. Select **Save transcript**. Save up to 100 changed passages at a time.
   Timestamps stay unchanged and refer to elapsed time in the web copy.

Search and speaker filters cover loaded passages. While correcting text, they
use the saved words and speaker assignments so an edited passage stays in view.
Names and corrections appear when you reopen the video and in new transcript
downloads.

**Save details** saves the video metadata. **Save transcript** and **Save speaker
names** save transcript changes. Boardwalk warns before you leave with unsaved
changes. If someone
else saves first, your changes stay in the editor; discard and reload the saved
version before applying them again.

Edits do not run transcription again. The original automatic output stays
stored. Speaker names apply to this transcript; they do not identify people in
other videos automatically.

## Review a transcript and use its passages

Each compact row shows a start timestamp, speaker and text. An arrow continues
the previous speaker's turn. Select the timestamp to seek the preview. Open the
row's **Passage actions** menu, then choose **Passage details** for the exact
start, end and duration, plus the speaker's title or affiliation when saved.
Use Tab to reach the menu, Enter or an arrow key to open it, and Escape to close
it. **Speaker uncertain** and **Overlapping speech**
mark passages to check against the audio. Reassigning a passage to a numbered
speaker clears its uncertainty flag when saved; overlapping speech remains
flagged. These elapsed times are not source SMPTE timecodes.

Open **Transcript tools & review**. Load all passages, check the entire
transcript against the audio, then select
**I checked the entire transcript against the audio** and **Mark transcript
reviewed**. The record identifies the saved revision, reviewer when available,
and time. Any saved text, speaker assignment, name, or role change clears that
review record. Save corrections before recording a new review. If a review
conflicts with another save, reload and check the saved revision again.

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Check the saved revision and select a passage.</strong> This local example uses synthetic text and a fixture review record. </figcaption>
</figure>

Open a passage's menu and choose **Use passage as clip**; the action includes
its passage number. This copies its start and end into the clip controls. Check
the preview and adjust the selection before exporting. Choosing the range does
not create an export. The action appears only for an available clip range,
while you are reading rather than editing or selecting passages. Clip length
and viewing-copy limits still apply; it is absent while an export is active.

**Download soundbite log** downloads a cached TSV file for a spreadsheet. It
includes passage times, speaker names and roles, text, review status, and
uncertainty and overlap flags. It does not run transcription again. **Download
text**, **Download captions** and **Download SRT captions** remain available.
Check captions before use; a saved transcript review does not certify
broadcast-caption compliance. Captions split passages into short cues with at
most two lines, a 42-character line target and a seven-second maximum. Unbroken
names or URLs longer than the target stay intact in their own cue. Both caption
downloads rebuild from the selected saved transcript, including older results,
without another transcription job. Full caption downloads require billing to
be enabled for the private export.

Matching word alignment supplies cue times. After you edit words, or when word
times are unavailable, cue times are estimated within the passage. Check them
against the video and change timing by hand where needed. Saved clip captions
use clip-relative times. Upload the new caption file to replace an existing
YouTube or other distribution track; a download does not change those tracks.
Very short passage times need manual checking. A passage with exactly zero
duration has no caption cue; its text stays in the saved transcript and TXT.

### Download for Avid or Premiere

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Use settings from your editing project.</strong> Set the rate and offset below the player. The download buttons stay with the production tools below the player. </figcaption>
</figure>

Open **Editing software exports** within the transcript section.

For Avid Media Composer, choose the **Editing clip or sequence frame rate**
that matches your edit. Fractional rates show their exact ratio. Set **Elapsed
frame offset** to a whole number of frames, or keep 0 to start from the viewing
copy's beginning. Select **Download Avid markers** below the player for a tab-separated TXT
marker file. Each passage becomes a V1 marker with speaker, role, text, elapsed
in/out times, review state, and review flags in its comment. Import the markers
into the matching clip or sequence and check their placement. Boardwalk does
not infer source timecode or a sequence start offset.

For Adobe Premiere Pro, select **Download Premiere transcript** for JSON.
Every saved passage must have reviewed word timing for the current transcript
revision. The server checks the whole transcript, including passages not loaded
in the browser. If text edits removed timing, first check the corrected words
against the audio and mark the transcript reviewed. Then use **Align corrected
words**. Boardwalk estimates word times on the private node-gpu-b worker; this does
not start ElevenLabs, Amazon Transcribe or another paid provider.

For a long transcript, use **Continue word alignment** after each private batch.
You can check or cancel an active request. A cancelled, unavailable, stale or
unconfirmed request needs an explicit retry. When the timing candidate is ready, Boardwalk
clears the earlier review record. Check the entire transcript and its estimated
word timing against the audio, then use **Mark transcript and timing reviewed**.
Only that second review makes the aligned Premiere result available. A later text
edit clears it. If a passage cannot be aligned safely, the message explains why
Premiere export is unavailable;
**Download text** and **Download soundbite log** still work. Speaker names
include saved titles or affiliations. Check the result in your Premiere
version after import.

These downloads use cached transcript data. They do not run transcription
again. Word times are model estimates
in elapsed viewing-copy time. They do not prove that every saved word was spoken
and do not provide source SMPTE timecode or approved broadcast captions.

## Select and download a clip

<figure class="admin-docs-video">
<video controls preload="none" playsinline width="1280" height="720" poster="/guide-content/videos/transcript-passage-to-clip.jpg" aria-label="Turn a transcript passage into a clip" src="/guide-content/videos/transcript-passage-to-clip.mp4">
<track kind="chapters" src="/guide-content/videos/transcript-passage-to-clip.vtt" srclang="en" label="Chapters" default></track>
</video>
<figcaption>Turn a transcript passage into a clip. <a href="/guide/video-tutorials#turn-a-transcript-passage-into-a-clip">Open this video in the tutorial list</a>.</figcaption>
</figure>

<details><summary>Transcript: Turn a transcript passage into a clip</summary>
<p>Descriptive guide. The video has interface sounds, optional instrumental music, and no spoken narration.</p>
<p><strong>Title</strong></p>
<p>The NJ PBS logo and &quot;Turn a transcript passage into a clip&quot;. The opening includes a screen preview, duration and step count.</p>
<p>Outcome: &quot;Select a saved passage, check its range, and download the resulting private MP4.&quot;</p>
<p><strong>Overview: Open the ready practice recording</strong></p>
<p>Start in Shared video library with a recording that already has a saved transcript.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Open the practice video&quot;. The pointer clicks it. The result callout says &quot;The private preview opens&quot;.</li>
</ul>
<p><strong>Step 1 of 7: Open the saved transcript</strong></p>
<p>Use the existing text. Opening it does not request another transcription.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Read the saved transcript&quot;. The pointer clicks it. The result callout says &quot;Choose the passage you need&quot;.</li>
</ul>
<p><strong>Step 2 of 7: Use the passage as a selection</strong></p>
<p>The passage supplies in and out points. This does not export a file.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Copy the passage range&quot;. The pointer clicks it. The result callout says &quot;The selected range is ready&quot;.</li>
</ul>
<p><strong>Step 3 of 7: Check the range and export settings</strong></p>
<p>Review the selected start and end. The original recording stays unchanged.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Check where the selection ends&quot;.</li>
</ul>
<p><strong>Step 4 of 7: Preview the selection</strong></p>
<p>Play the chosen range before exporting it.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Preview this selection&quot;. The pointer clicks it.</li>
</ul>
<p><strong>Step 5 of 7: Check clip quality</strong></p>
<p>Confirm the export setting for the selected range.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Check quality before exporting&quot;.</li>
</ul>
<p><strong>Step 6 of 7: Request the private clip</strong></p>
<p>Export the checked range once. Processing time is omitted between this step and the next.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Request the clip export&quot;. The pointer clicks it.</li>
</ul>
<p><strong>Step 7 of 7: Download when the export is ready</strong></p>
<p>Return to the saved export after processing. Check its range before downloading.</p>
<p>The Boardwalk screen appears in a browser frame. Focus treatment identifies the named controls.</p>
<ul>
<li>A callout says &quot;Download the completed MP4&quot;. Select the download control and verify the downloaded file.</li>
</ul>
<p><strong>Recap</strong></p>
<p>&quot;Keep the finished clip&quot;. Result pictures and confirmation marks accompany these points:</p>
<ol>
<li>Open the saved transcript</li>
<li>Use a passage range</li>
<li>Check the end time</li>
<li>Preview the selection</li>
<li>Check clip quality</li>
<li>Export the checked range</li>
<li>Download the completed clip</li>
</ol>
<p><strong>End</strong></p>
<p>The NJ PBS logo and &quot;More help: open the Boardwalk guide from Home.&quot;</p>
</details>

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Choose the download settings before export.</strong> This synthetic local example uses Match web copy and Balanced quality. The choices apply to the exported file. </figcaption>
</figure>

1. Open a ready video and select **Clip** in the preview header (or **More** on a narrow screen), or expand **Create a clip** below the player.
2. Move the player to the start and select **Set in to playhead**. Move to the
   end and select **Set out to playhead**. You can also type decimal seconds or
   hours:minutes:seconds, such as `00:01:12.500`.
3. Select **Preview selection** to play from in to out. The out point is
   excluded. Choose a range from 0.25 seconds to 30 minutes, within this video.
4. Choose **Clip resolution**. **Match web copy** is the default. The 1080p,
   720p and 480p options are available only when the web copy is large enough.
   If its dimensions are unknown, use **Match web copy**. Portrait orientation
   and aspect ratio are retained; Boardwalk does not enlarge the video.
5. Choose **Clip quality**: **Smaller file**, **Balanced** (the default), or
   **Higher quality**. Higher quality can make a larger file. The selection
   preview still plays the existing web copy.
6. Select **Export clip**. Boardwalk creates a private MP4 from the web copy.
   The original stays unchanged. Frame boundaries can slightly adjust a cut.
7. When ready, check the saved resolution and quality, then select **Download
   clip**. Boardwalk shows actual pixel dimensions when they are recorded.
   Clips stay available for seven days. Each download creates a short-lived
   private link.

### Download the matching transcript

Open the saved transcript you want to use, then select a ready clip. Beside
**Download clip**, choose **Clip transcript format** and select **Download clip
transcript**. Text, VTT or SRT captions and a TSV soundbite log are available. These
use the saved clip's range, even if you later change the in/out fields.

Transcript times start from the clip's frame-rounded beginning. The download
uses saved corrections. Text, VTT and TSV files also include speaker names;
SRT captions do not. If the cut crosses an edited passage
without aligned words, resync the transcript or select the full passage. An
older clip without frame timing must be exported again first. Downloading the
matching transcript does not start another transcription or clip job.

You can close the modal during export. Return to **Your recent exports** and
select the range to check or download it. Use **Load older MP4 exports** to find
earlier clips for the current video version. Each entry identifies its range,
resolution and quality. Selecting the same range and settings reuses its cached
export. Different settings create a separate export. An expired clip can be
requested again.

One export per person can run at a time. The daily limits are 30 new attempts
per person and 120 across the library. They reset at midnight UTC: 8 p.m.
EDT or 7 p.m. EST. Only confirmed
failures offer **Retry clip**. If the job's result is uncertain, report its
reference so an administrator can check it before another conversion starts.
**Retry clip** uses that failed export's saved range, resolution and quality,
even if you changed the current selection. To use different settings, select
**Export clip** for a new export.

## Broadcast and editing exports

Export controls show whether new requests are enabled. Existing MP4 clips and
original downloads stay available when new requests are disabled.

Open **Broadcast and editing exports** in the video details. Choose
**Selected clip** to use the in/out range from **Clip** in the preview header (or **More** on a narrow screen), or **Full
video** for the complete original. Then choose a format:

- **MXF / XDCAM HD422** for the supported broadcast preset.
- **MOV / ProRes 422 HQ** for editing.
- **MXF / DNxHD** for the supported Avid preset. DNxHR is not available yet.
- **MP4 / Frame rate copy** for a full video at the chosen rate.

Select **Export video** when the service is enabled. Conversion uses paid
processing. New editor exports default to **29.97 fps (30000/1001)**.
Choose **Keep source frame rate** to retain the admitted source rate, or select 23.976 (24000/1001), 24, 25, 30, 50, 59.94 (60000/1001), or 60 fps. Exact 24, 30 and 60 are unavailable for XDCAM. Read the
estimated MediaConvert charge before submitting. Storage and other service
charges are extra. If original dimensions are not measured, the ProRes estimate shows an SD-through-4K range. Interpolation and telecine do not add a FrameFormer charge.
Editor audio channels stay separate. A 720p film source uses 1080i for standard
2:3 pulldown; XDCAM and DNxHD use 720p above 30 fps. Other supported outputs retain their dimensions. Full-video exports support recordings up to 24 hours;
clip selections retain the 30-minute limit. Original-based conversions also
have a daily duration allowance of 24 hours per person and 96 hours across the
library. Files remain available for seven days.

The exact source frame rate appears in the viewer and **File information**. A rate
other than 29.97 shows a notice: CentralCast needs 29.97 fps (30000/1001), so this source cannot air. Upload, selection and publication remain
available. **Not measured** means no source-rate metadata is saved. Editor
exports inspect the original before encoding; the existing web copy is not
used to infer the original frame rate.

For a measured non-29.97 source, select **Prepare 29.97 fps copy**. The controls
open with **Full video**, **MP4 / Frame rate copy**, and 29.97 fps selected. Read the estimate before requesting the copy. You can choose another output rate.
Then select **Export video** to request the copy. This preserves the original
and existing web copy. MP4 uses H.264 and stereo AAC at 48 kHz when audio is
present. A measured 29.97 source offers **Download 29.97 fps original** instead
of another conversion. Older assets need measured metadata before this copy
action is available.

Progressive 23.976 uses standard 2:3 pulldown with interlaced output. Other
differing rates use interpolation. New editor conversion supports measured
rates from 1 to 60 fps, subject to the chosen format's raster and scan limits.

Editor exports need one video track. **MOV / ProRes 422 HQ** accepts even
width and height values from 32 through 4096 pixels. It supports progressive
and interlaced video at 23.976, 24, 25, 29.97, 30, 50, 59.94 or 60 fps.

**MXF / DNxHD** accepts 1920 x 1080 or 1280 x 720 progressive video at those
rates. Interlaced DNxHD needs 1920 x 1080 at 25, 29.97 or 30 fps. Choose
ProRes for 4K or portrait video.

**MXF / XDCAM HD422** accepts these **Keep source frame rate** combinations:

| Raster | Scan | Frame rates |
| --- | --- | --- |
| 1920 x 1080 | Progressive | 23.976, 25, 29.97 |
| 1920 x 1080 | Interlaced | 25, 29.97 |
| 1280 x 720 | Progressive | 23.976, 25, 29.97, 50, 59.94 |

Each audio track can have 1 to 8 channels. **MXF / XDCAM HD422** needs 2, 4 or
8 channels in total. ProRes and DNxHD accept a silent source or up to 8 channels.
MP4 produces stereo AAC. The service checks
the original after the export starts. If the video or audio does not match, or
a selected range is longer than the original, the export stops with a message that names the
problem. New input rejections have no retry. Earlier ProRes and Avid failures
can show **Retry export** after the format checks are corrected. Choose another
format or download the original if a retry is not available. The earlier error
did not save which check failed. A legacy retry can fail again for an unsupported
video track or duration and uses the normal export allowances.

A saved export shows its chosen rate, measured source and output rates and conversion method. The chosen rate also appears in the export list.
New output jobs request an embedded timecode timeline. The AWS API describes a zero-based fallback, but output timecode presence is not confirmed. Drop-frame is requested at 29.97 where supported. Camera timecode
presence and preservation have not been verified. Clip selection continues to
use elapsed time.

Choose a saved export from its history, then select **Check export status** or
**Download video**. Use **Load older editor exports** to find earlier entries. **Cancel queued export** is available only before processing
starts. It does not restore the daily allowance. **Retry export** uses the saved
format, range and frame-rate choice and can incur another processing charge. If a request cannot
be confirmed, check its saved status before starting another.

A ready export shows an **AWS estimate** when published pricing covers its
size. ProRes outputs above 2160 pixels on the shorter side have no estimate.
The estimate covers the conversion of that
attempt and the storage of the export and its staged original. It does not
include earlier attempts. The amount is an estimate, not a bill.

For a ready clip, open the saved transcript, choose **Matching transcript
format**, then **Download matching transcript**. It uses the saved export range
and the same timing checks as an MP4 clip transcript. For a full-video export,
use the existing full-transcript downloads. Check native Avid or Premiere import
and station broadcast compliance separately.

## Keep the private-media boundary clear

The **Videos** tab stores private staff media. It has no public embed or
publication control. Uploading, preparing a web copy, previewing, downloading,
editing details, and deleting a library entry do not change the public NJ PBS
site.

Do not copy a temporary preview or download address into a page, post, message,
or external player. The address expires. Boardwalk creates it only after it
checks an authorized staff request.

## Recover a problem

- If the library says **Video library unavailable**, select **Try again**.
- If ready playback fails, select **Refresh preview**.
- If the card says **Preview unavailable**, download the original and report the
  preview error reference under **File information**.
- If a transfer says **Transfer interrupted**, select the resume control and
  provide the original file when asked.
- If uploads are unavailable, check for another open Boardwalk tab. If the
  browser lacks upload support, use a current supported browser.
- If **Videos** is missing for an approved, active account, sign
  out, sign back in, and report the missing source if it does not return.

Report the exact source, video title, visible status, browser, and time. Do not
include a private media URL, cloud credential, or downloaded file in the support
report.
