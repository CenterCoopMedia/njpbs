---
title: StoryDesk transfers
description: "Send selected Boardwalk items to StoryDesk and import stories as private drafts."
---

Open **StoryDesk** in the rail. The destination has three tabs: **Send**,
**Import**, and **Transfers**. If transfers are turned off, an administrator must
enable them. Use **Refresh StoryDesk availability** after that change.

## Send a selected item

1. In **Send**, choose video, clip, image, transcript, or Post.
2. Select the Boardwalk item. **More items** opens the next page. The reload
   control returns to the beginning.
3. For a clip or transcript, choose a ready output. Use **More outputs** to check
   later pages, including when the first page has no ready outputs. If none is
   available, prepare it in the media library, then return. Sending never starts processing.
4. Choose **Create or update a story**, or select **Existing story** and search
   for the destination. Posts use their own new or previously linked story.
5. Select **Review transfer**, check the item and destination, then select
   **Send to StoryDesk**.
6. Open **Transfers** to inspect the result.

Media uses a web or viewing version. If that version is unavailable, prepare it
in the media library first. Original archive files are not sent. A transcript
becomes an HTML dossier with one paragraph per line. A Post sends its title,
summary, credit, and any published link.

A repeat transfer updates the same story or dossier while its StoryDesk version
is unchanged. Media assets are added to the story. A remote edit produces a
conflict for staff review.

## Import into a private Post draft

1. Open **Import**, search StoryDesk, and choose **Preview import** for a story.
   If its description exceeds 10,000 characters, Boardwalk explains the limit
   and keeps preview unavailable until the description is shorter in StoryDesk.
2. Review the title, description, original source link, Brief, and dossiers.
   The Brief is separate from the supporting dossiers.
3. Review the omissions. StoryDesk's Brief read leaves out embedded media,
   feed items, story references, and mention identities. Unsupported active
   content and links are also removed when necessary.
4. Check **I reviewed these omissions**, then select
   **Confirm private draft import**.
5. In **Transfers**, select **Open private draft** to review the Post.

Import saves a private draft and preserves source attribution. It does not
publish. A later import updates the same draft only while it remains unchanged
and private. If staff edited it, the import records a conflict and keeps that
draft intact. The Import tab is disabled when your account cannot create a Post.
Searching existing stories also requires that permission. Sending a Post
requires edit access to that Post.

## Understand transfer states

| State | What to do |
| --- | --- |
| Queued | The selection is prepared and awaits confirmation. Return to Send or preview the story again to confirm. |
| Sending | Wait for the current request. The visible transfer list refreshes while a send is active. |
| Done | The transfer has a confirmed result. An imported story has an Open private draft link. |
| Conflict | Review both versions. Make a new selection or preview after deciding which content to transfer. |
| Needs review | Check the outcome in StoryDesk. Use Review outcome and I checked StoryDesk to acknowledge your review and check for a confirmed result. |
| Failed | Read the message and repair its cause before using Retry transfer, when offered. |

An uncertain media import stays in **Needs review**. Acknowledging it does not
authorize another asset import. Ask an administrator to review that transfer
before sending the same media again. Use **Refresh transfer status** to check
the latest result without starting another transfer. Use **More transfers** to
open older results. Continue until you find each item that needs review.

If Boardwalk has a confirmed story but a later step failed, **Mark as done with
what was sent** offers a separate review. **Keep what was sent** preserves
that story for later revised exports and closes retry on the old attempt. The
original failed or conflict status remains visible. This action is unavailable
while a write has an unknown outcome.
