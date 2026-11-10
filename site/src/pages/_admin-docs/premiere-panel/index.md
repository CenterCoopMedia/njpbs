---
title: Premiere Pro panel
description: "Connect the Boardwalk panel in Adobe Premiere Pro, import shared library video, keep source markers, and return finished videos."
---

The Boardwalk panel for Adobe Premiere Pro requires its connection and export
services to be enabled by an administrator. If sign-in is disabled, **Connect
Boardwalk** shows **Premiere sign-in is not enabled**. ProRes and original-range
imports each require their export service. The screenshots use sample data.

## What the panel does

The panel puts the [shared video library](/guide/shared-video-library) inside
Premiere Pro. Video editors and producers use it to:

- Browse library videos by poster, name, duration, size and rights status.
- Download a video to a cache folder on the computer and import it into the
  open Premiere project.
- Import a full original, an original in/out range, or a ProRes copy.
- Copy markers between a Boardwalk video and its downloaded Premiere clip.
- Upload a finished video back to the library as a new video.

The panel opens only the shared video library. It does not open pages, posts,
images, documents or the archive sources. It does not publish anything to the
public NJ PBS site.

## Before you start

You need:

- Adobe Premiere Pro 26.5 or later.
- An approved, active Boardwalk staff account. Every approved, active account
  can browse, download and import.
- Global media upload access to return a finished video.
- Global media management access to save markers to Boardwalk.
- A folder on the computer, or on a drive it can reach, with space for the
  downloaded video files.

Editors, Managers and Site owners usually have upload and media management
access. If an action shows **Media source access denied**, ask an administrator
to check your role. See [Access and roles](/guide/access-and-roles).

The panel uses your own Boardwalk account. It does not use a shared login or
cloud credentials. Boardwalk checks your current access each time the panel
asks for something.

## Install and open the panel

An administrator installs the panel on station computers. The station installer
is a `.ccx` file. Creative Cloud Desktop installs it when you open the file.
Ask an administrator if the panel is not in Premiere.

1. Start Premiere Pro and open the project that will receive the video.
2. Select **Window → UXP Plugins → Boardwalk**.
3. Dock the panel where you want it. It works from 280 pixels wide. As the panel
   gets wider, the library shows two or three columns.

The project name shows under the NJ PBS logo. If it says **Open a project to
import video.**, open a project, then select **Settings → Refresh project**.

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>A new panel asks you to connect your account.</strong> The project name shows under the logo. </figcaption>
</figure>

## Connect the panel to Boardwalk

You approve each computer once in the Boardwalk browser app. The connection
stays active for 30 days.

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>The panel shows a code and waits for your approval.</strong> Compare this code with the code filled in on the Boardwalk page. <span class="admin-docs-image-note">Browser example screen. Select the image to enlarge it in a new tab.</span></figcaption>
</figure>

1. In the panel, select **Connect Boardwalk**. The panel shows an eight-character
   code with letters and numbers, such as `KXQR-7M2P`. Your browser opens the Boardwalk
   **Connect Premiere** page at `admin.njpbs.org/premiere/connect`, with the
   connection code filled in. This requires panel version 0.1.1 and an updated
   Boardwalk connection service and approval page.
2. If the browser did not open, select **Open Boardwalk** in the panel.
3. Sign in to Boardwalk if it asks you to.
4. Check **Connection code**, then select **Review connection**. If the field
   is empty, select **Copy code** beside the code in Premiere, then paste it
   into the field. The panel shows **Code copied.** when copying succeeds.
   If it cannot copy, select the read-only code field and use your computer's
   Copy command. The hyphen is optional, and lowercase letters also work.

   <figure class="admin-docs-screenshot">
     <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
     <figcaption><strong>Review the code filled in from Premiere.</strong> If the field is empty, copy and paste it from the panel. The hyphen is optional. </figcaption>
   </figure>

5. Check the request. It shows **Premiere Pro**, the Premiere version, and the
   code. Read what the connection can do.

   <figure class="admin-docs-screenshot">
     <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
     <figcaption><strong>Approve only a request that you started.</strong> The code on this page must match the code in the panel. </figcaption>
   </figure>

6. If the code matches and you started this connection, select **Approve this
   computer**. Boardwalk shows **Connection approved. Return to Premiere to open
   your library.**

   <figure class="admin-docs-screenshot">
     <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
     <figcaption><strong>Boardwalk confirms the approval.</strong> Return to Premiere to use the library. </figcaption>
   </figure>
7. Go back to Premiere. The panel checks for approval every few seconds. When
   it finds the approval, it loads the library.

If you did not start the request, or the code does not match, select **Deny
connection**. The panel then shows **Sign-in was declined**. To check a
different code before you approve or deny, select **Use a different code**.

The code expires after 10 minutes and works one time only. If Boardwalk says
**This sign-in code expired. Start again in Premiere.**, or the panel says
**The connection code expired. Connect again for a new code.**, select
**Connect Boardwalk** again for a new code. **Cancel** in the panel stops the
wait.

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>An expired code needs a new connection from Premiere.</strong> Boardwalk does not accept an old code again. </figcaption>
</figure>

The connection lets the panel browse the shared video library, download media,
request exports, edit media details and upload new videos, with your current
permissions. It also sends problem reports. See
[Report a problem](#report-a-problem).

## Find a video

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>The library shows posters and details, not video files.</strong> A wider panel shows two columns of cards. </figcaption>
</figure>

The **Library** tab loads up to 24 videos at a time. Select **Load more** to
see the next videos. Each card shows the duration, file size, and **Rights
pending** or **Rights recorded**.

To search, type the start of a video name in the search field. The list changes
after you stop typing. Press Enter to search immediately. Search matches the
start of the name only. Select **Refresh** to load the library again.

Browsing does not download video files. The panel downloads a video only when
you select an import action.

Select a card to open the video details. Select **Back to library** to return
to the same place in the list.

## Import a video into your project

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Choose the format and how much of the video to download.</strong> The note under the fields changes with your choices. </figcaption>
</figure>

Before your first import, choose a cache folder. See
[Choose and clear the cache folder](#choose-and-clear-the-cache-folder).

1. Open a video from the library.
2. If the details say **Rights review is pending. Confirm permission before
   using this footage.**, confirm permission before you use the footage.
3. In **Import format**, choose **Original** or **ProRes**. Check **Remember on
   this computer** to make your choice the default when you open a video later
   with this account on this computer. Batch imports use their own **Format**
   control.
4. In **Media to download**, choose **Full video** or **In/out range**. For a
   range, enter **In (seconds)** and **Out (seconds)**. The out point must be
   after the in point.
5. Select **Download and import**.

For a full original with a saved credit, read the on-screen credit warning, then
select **Continue download** to proceed or **Cancel download** to stop. Each
credited original in a batch requires confirmation. Canceling stops the batch;
files already imported remain in the project.

| Choice | What Boardwalk does |
| --- | --- |
| Original, full video | Downloads the camera original without conversion. |
| Original, in/out range | Copies the original audio and video for the range, without re-encoding. Supported MP4 and MOV files only. The cut moves out to safe keyframes. The panel shows the returned range before import. This uses server processing. |
| ProRes, full video or range | Makes a paid ProRes 422 HQ export at the source size. A ready export that matches is used again. |

A range or ProRes import waits while Boardwalk prepares the file. The panel
shows **Copying the original range in Boardwalk...** or **Preparing ProRes in
Boardwalk...**. For an in/out range, the panel then shows **Returned source
range** with the actual start and end times.

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>The transfer bar shows progress.</strong> Other panel controls wait until the transfer ends. </figcaption>
</figure>

The panel downloads the file to your cache folder, then imports it into the
open project. The file goes into the selected bin in the Project panel, or into
the top of the project. Place it on a timeline as usual.

When the import is complete, the panel shows **Imported** with the video name
and project name. For a range, the message also gives the source range.

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>The message names the video and the project.</strong> Find the clip in the Project panel. </figcaption>
</figure>

### Stop a transfer

Select **Stop transfer**. The panel shows **Transfer stopped. Your source is
unchanged.** The Boardwalk video does not change.

- If the download was already complete, the panel shows **Download complete.
  Import the cached file when you're ready.** Select **Import downloaded file**
  to import it.
- If the panel was waiting for a range or ProRes file, it shows **Stopped
  waiting. The export may still finish in Boardwalk; reopen this asset to use
  it.** or **Transfer stopped. Your source is unchanged.** In both cases, the
  export can still finish in Boardwalk.

### Do not change projects during an import

The panel imports into the project that was active when you started. If you
switch projects, it stops with **The active project changed**. The file stays in
the cache. Return to the intended project and select **Import downloaded file**.

## Import several videos

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Select the checkbox on each card, then import them together.</strong> The batch bar stays at the bottom of the library. </figcaption>
</figure>

1. Select the checkbox on each video card. The bar at the bottom shows how many
   videos you selected.
2. In **Format**, choose **Original** or **ProRes**.
3. Select **Download and import selected**.

Batch import uses the full video of each selection. It downloads and imports
one video at a time. When all are complete, the panel shows **Imported** with
the number of videos. If one fails, the panel stops. The message tells you how
many were imported and which video stopped the batch. The videos that remain
stay selected. Select **Clear** to remove the selection.

A new search clears the selection.

## Keep source markers

Boardwalk can keep Premiere markers with a library video. Other editors can then
apply the same markers to their downloaded clip. This is not live sync. You send
or get markers when you select a button.

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Source markers use times in the original video.</strong> The list shows the start and end in seconds, the name and the comment. </figcaption>
</figure>

Marker actions work only on a clip that this account downloaded through the
panel on this computer. In the Project panel, select one source clip. A
sequence, merged clip or multicam clip does not work.

### Apply Boardwalk markers to your clip

1. Open the video in the panel. Wait for the marker count.
2. In the Project panel, select the clip that you downloaded for this video.
3. Check **Replace the selected clip's markers**.
4. Select **Apply Boardwalk markers**.

This replaces all markers on the selected clip. For a range clip, the panel
applies only the markers that are fully inside the range and moves them to the
clip's times. The message tells you to use Premiere's undo once or twice to
restore the previous markers.

### Save your clip markers to Boardwalk

1. Add or change markers on the downloaded clip in Premiere.
2. Open the same video in the panel and select the clip in the Project panel.
3. Select **Read selected clip markers**. The panel shows how many markers are
   ready to save.
4. Select **Save markers to Boardwalk**. The panel shows **Markers saved to
   Boardwalk.**

For a range clip, Boardwalk keeps its markers that are outside the range or
that cross a range boundary. A clip marker must not go past the end of the
downloaded range.

Marker rules:

- Use **Comment**, **Chapter** or **Segmentation** markers. The panel does not
  copy **WebLink** markers, because Premiere cannot restore their link. A clip
  that has a WebLink marker cannot get Boardwalk markers. Keep WebLink markers
  in Premiere.
- Use up to 100 markers for each video, a name of up to 200 characters, and a
  comment of up to 1,000 characters. All markers for a video together must be
  64 KiB or less. If the panel says that marker metadata exceeds 64 KiB,
  shorten the comments.
- Saving needs global media management access.

If someone else changed the video in Boardwalk after you opened it, the save
can fail. Go back to the library, open the video again, read the clip markers
again, and save.

## Return a finished video

The **Return** tab uploads an exported file to the shared video library as a
new video. It does not replace the source video.

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Name is required.</strong> Description, credit and tags are optional. </figcaption>
</figure>

1. Export the finished video from Premiere.
2. Open the **Return** tab and select **Choose video**. Select the exported
   file. The panel puts the file name, without its extension, in **Name**.
3. Edit **Name**. Add a **Description**, **Credit** and **Tags** if you want.
   Separate tags with commas.
4. To link the source, select the downloaded source clip in the Project panel,
   then select **Link selected Premiere clip**. The source line shows the
   Boardwalk video ID and **full source** or the range. Select **Remove source
   link** to remove it.
5. Check **Include linked clip markers as returned-video metadata** only if
   the export keeps the linked clip's timing. An edited sequence can have
   different times.
6. Select **Upload new asset**.

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>The source link records where the finished video came from.</strong> Rights review stays pending for the new video. </figcaption>
</figure>

When the upload is complete, the panel shows **Uploaded** with the name and
**Rights review is pending.** The new video has a pending rights status. Record
the rights in Boardwalk before other staff use it. See
[Edit video details](/guide/shared-video-library#edit-video-details).

Uploading needs global media upload access.

### Resume or cancel an upload

If an upload stops, the panel keeps a checkpoint on this computer. **Resume
upload** and **Cancel upload** appear on the **Return** tab.

- To resume, select **Choose video**, select the same unchanged file, then
  select **Resume upload**. A different or changed file shows **Choose the same
  file to resume this upload.** or **Select the same, unchanged file to resume
  this upload.**
- To stop, select **Cancel upload**. The panel shows **Upload canceled.** If it
  shows **This upload already completed.**, the new video is in the library.

You can have one upload at a time. A new upload shows **Resume or cancel the
existing upload before starting another.**

## Choose and clear the cache folder

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Downloads go to a Boardwalk folder that you choose.</strong> Premiere uses the files from this folder. </figcaption>
</figure>

1. Open **Settings** and select **Choose cache folder**.
2. Select a folder with enough free space. The panel makes a folder named
   **Boardwalk** in it and shows its path.

Premiere uses the cached files in your project. Keep them while a project uses
them. Use your own folder. Do not share one cache folder between accounts.

To remove files that you no longer need:

1. Check **I no longer need this account's downloaded files in the selected
   cache**.
2. Select **Clear downloaded files**.

The panel removes only the files that this account downloaded into that folder.
It keeps other files. Clips that use the removed files go offline in Premiere.
If Premiere is still using a file, the panel keeps it and names it. Close the
projects that use the file, or restart Premiere. Then clear again.

**Refresh project** reads the open project name again. **Import a local video**
imports a file from your computer into the open project, without Boardwalk.

## Report a problem

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Settings shows your account and the report form.</strong> The sample account is not a staff member. </figcaption>
</figure>

1. Open **Settings** and select **Report a problem**.
2. In **What happened?**, write what you tried to do. This field is optional.
   If you write something, use at least a short sentence.
3. Select **Send report**.

The panel shows **Report received** and a reference. Keep the reference. If the
panel cannot confirm the report, the button changes to **Retry report**. Retry
sends the same report.

The report includes the panel, Premiere and UXP versions and the results of
recent panel actions. These diagnostics do not include video names, file paths,
download links or account credentials. Text that you type in **What happened?**
is sent as you wrote it. Do not type a download link or a credential there.

The panel also sends an automatic alert to Boardwalk Managers when an
action fails unexpectedly. It groups the same failure for 15 minutes. A
canceled action does not send an alert. An expired connection, missing access,
too many requests, or another request that Boardwalk refuses because of your
input or account does not send an alert. Automatic alerts do not send you an email.

## Disconnect the panel

Open **Settings**. It shows **Connected as** with your name, and the date the
connection ends. Select **Sign out**. The panel shows **Signed out of
Boardwalk.** and removes your account data from the panel.

Sign out on a shared computer. If sign-out cannot reach Boardwalk, the panel
keeps the connection so that you can try again.

The connection also ends after 30 days, or when the connection is revoked. The
panel then shows **Your Boardwalk connection ended. Connect again.** Select
**Connect Boardwalk** to approve the computer again.

If your Boardwalk account is no longer active, panel actions show **An active
Boardwalk staff account is required**. Ask an administrator to check your
account.

## Fix common problems

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Errors show at the top of the panel.</strong> This example shows the message for disabled Premiere sign-in. </figcaption>
</figure>

| Message or symptom | What to do |
| --- | --- |
| **Premiere sign-in is not enabled** | Sign-in is disabled. Use the [shared video library](/guide/shared-video-library) in your browser. |
| **Open a project to import video.** or **Open a Premiere project, then try again.** | Open a project, then select **Settings → Refresh project**. |
| **Choose a cache folder to download media.** | Choose a cache folder in **Settings**. |
| **Your cache folder is unavailable. Choose it again in Settings.** | Connect the drive, or choose the folder again. |
| **Clip exports are not enabled**, **Original-range extraction is not enabled** or **Editor exports are not enabled** | That import type is not turned on. Choose **Original** with **Full video**. |
| **This video's tracks or codecs are not supported for original ranges.** or **The source timing could not be verified for an unchanged range.** | Choose the full original or ProRes. |
| **This range exceeds the extraction limit.** | Choose a shorter range or the full original. |
| **The export's outcome needs an administrator to check it before another original range can start.** | Report the problem. Use the full original until an administrator checks it. |
| **Wait for the current original-range extraction to finish** | Boardwalk makes one original range at a time. Try again later. |
| **The daily clip export limit has been reached** | Try again the next day, or use the full original. |
| **Select a clip downloaded by this Boardwalk account.** | Select the clip that this account downloaded on this computer. |
| **The selected clip belongs to a different Boardwalk asset.** | Open the matching video in the panel, or select its clip. |
| **Media source access denied** | Your role does not allow this action. Ask an administrator. |
| **Too many requests. Try again later.** | Wait, then try again. |
| **Download failed** or **Upload paused** | Try the action again. For an upload, select **Resume upload**. |
| An incomplete `.partial` file stays in the cache | Delete it from the cache folder after the panel stops. |
| Space or Enter does not select a panel button | When a sequence is active, Premiere can take these keys. Select the button with the pointer. |

For other problems, use **Report a problem** in **Settings**. You can also use
the [support steps](/guide/troubleshooting#collect-a-useful-support-report).
Do not send a downloaded file, a download link or a cloud credential in a
report.
