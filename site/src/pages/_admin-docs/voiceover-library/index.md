---
title: Audio
description: "Find, upload, organize, and review station audio in one Media library tab."
---

Open **Media library**, then **Audio**. The page lists staff-uploaded WAV files
and station voiceover takes together. An existing `/voiceovers` bookmark opens
the same Audio tab.

Approved staff can browse audio and keep personal reviews within their category
access. Uploading and changing shared metadata require the separate media
permissions. Browsing Audio does not grant access to Images or video sources.

## Find audio

Use the same library controls available for other media:

1. Search by name, filename, tag, description, category, rights information, or
   voiceover text.
2. Open **Filter** to choose a Category or a Tag. Applied choices appear as
   removable chips. **Clear all** clears the search and filters.
3. Use **Display** to switch between cards and rows, change their size or
   density, choose visible fields, and set the sort order.
4. Use **First**, **Previous**, and **Next** to move through the indexed result
   pages.

Audio cards and list rows show recorded voice, style, take, duration and creation
facts. Missing take details are omitted. Select the separate **Listen** button on
a card to start playback; it becomes **Pause** while the audio plays.

Select an audio card or row to open **Asset details**. The inspector contains
Preview, Voiceover facts when recorded, Details, Rights, Tags, Categories, and
File information. Staff with
management access can edit the allowed fields. Select **Save details** to save
them, or **Cancel changes** to restore the loaded values.

## Listen to audio

An uploaded WAV uses the public media file. Its audio controls can play it
without another CMS request.

A voiceover stays private. Select **Listen** to request that WAV through your
signed-in Boardwalk session. The audio loads only when you ask for it. Starting
another recording pauses the current one. Select **Download WAV** only when you
need a local review copy.

Access still follows the asset's primary category. A favorite or collection
reference does not grant access to the recording.

## Upload station audio

Staff with upload access can select **Upload**, choose one or more WAV files,
enter the known file details, and start the upload. For two or more selected
files, select **Upload all files** to start the batch with the current details.
You can still upload one file at a time. Staff with media management access can
add or change optional details later. The Audio upload sheet accepts WAV files.
Use Images for images and PDFs.
Favorites and Collections also provide a general **Upload media** control. It
sends files to their library and keeps your current tab open.

Choose an uncompressed PCM WAV file with these limits:

- mono or stereo
- 44.1 or 48 kHz
- 16 or 24 bit
- no more than 10 MiB per file

Convert MP3, AAC, FLAC, compressed WAV, and other formats before upload. The
batch can contain up to 20 files.

Add a clear name, description, credit, license, tags, and categories when known.
The primary category controls access and must be one your account can upload
to. Additional categories improve search and filtering. They do not grant
access.

A matching file reuses the existing asset and reports that the new details were
not saved. Uploaded WAV files use the public media origin. Uploading does not
publish a page, but anyone with the file URL can open it. Do not use this upload
path for confidential recordings.

## Review a voiceover

A migrated voiceover has a read-only **Voiceover** section directly below Preview
in Asset details. It
shows the performer, style, line family, take number, text, flags, and duration.
Brackets in the text show where a program or broadcast title will be inserted.

The **Your review** area contains:

- **More like this** for a take that future reads should follow
- **Notes** for a personal comment of up to 2,000 characters

Only your CMS account can read these choices. They do not save automatically.
Select **Save details** after you change them. **Cancel changes** restores the
saved review. If another session saved a newer review first, reload the saved
review before you try again.

If you change both your review and shared media details, your review can save
while the media details fail. The message confirms **Your review was saved**
and explains why the media details were not saved. Retry the media details
after a temporary error. If the asset changed, select **Reload asset** before
you enter and save the shared changes again. Your saved review remains.

## Share feedback with staff

Audio has the same **Staff comments** section as other media. Staff with access
to the item can read these comments in Boardwalk. Each comment shows its author
and time. You can edit or delete your own comments. These comments never appear
on the public site. Keep personal thoughts in **Your review → Notes**; only
your account can read that note.

See
[Metadata and media](/guide/metadata-and-media/#review-media-and-give-staff-feedback)
for the shared flow.

## Favorite or collect audio

Select the heart on a card, row, or in Asset details to add the audio asset to
your shared Boardwalk favorites. Open **Media library → Favorites** and choose
the Audio Type filter to see audio favorites on the loaded page.

The heart is separate from **More like this** and **Notes**. It uses the shared
media favorite and does not change the retained favorite value from the earlier
voiceover review screen.

Use **Add to collection** on one audio item, or select several available items
and add them together. Audio can join the same private or all-staff collections
as images, documents, and private videos. A collection saves references. It
does not copy a file, publish it, or change its access.

## Earlier interface screenshot

The synthetic example below shows the
earlier Voiceovers tab, compact review rows, waveform player, and automatic
review saves. Use the shared Audio cards, Asset details, heart, collections,
and explicit **Save details** action described above.

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>This is the earlier voiceover screen.</strong> The current source uses the shared Audio media grid and Asset details. Select the image for a larger view.</figcaption>
</figure>

## Return to Audio

Open **Media library → Audio**, or use an existing `/voiceovers` bookmark. If
Boardwalk asks you to sign in, use your approved staff account. Your shared
favorite and personal review choices belong to that account.
