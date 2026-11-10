---
title: Drafts, revisions, and recovery
description: "Save without publishing, inspect revision history, handle unsaved work, and resolve locks or version conflicts."
---

## Read the current state first

Before editing, identify three separate states:

1. **Stored draft:** the latest version saved in the CMS.
2. **Working copy:** the changes currently present in your browser.
3. **Published version:** the version currently available on the public site.

They can all be different. The editor's lifecycle, save status, revision
history, and preview controls help you identify which state you are looking at.

Do not use the public site to decide whether an unsaved browser change exists,
and do not use a recent revision time to assume that a draft has been
published.

## Save a draft

A normal save or update should:

- Validate required fields.
- Preserve fields and blocks outside the area you changed.
- Store the new draft version.
- Record revision evidence.
- Show an explicit success message.
- Return the primary action to its normal state.

Use this procedure for an important edit:

1. Confirm the record identity and current version.
2. Make the smallest complete change.
3. Read the surrounding content.
4. Select **Save draft**.
5. Do not select the action again while it is pending.
6. Wait for the success or failure message.
7. Reload the record when persistence must be proven.
8. Confirm that the saved value remains.

A progress state is not a success state. Do not leave, submit, or publish while
the save is still running.

## Understand revision history

Revision history should let an authorized reader answer:

- Who saved the version?
- When was it saved?
- What fields or blocks changed?
- Which version came before and after it?
- Is this the version currently stored as the draft?
- Can the record be restored safely?

Use revision history after:

- A consequential copy or metadata correction.
- An accidental removal or reorder.
- A dispute about which change was saved.
- A version conflict.
- A restore.
- A publication investigation.

Revision history is evidence, not a substitute for a clear assignment or review
note.

## Inspect a version

Select **Inspect version N** on the revision you want to read. N is that version number.

When change details are available:

1. Start with the latest known-good version.
2. Compare it with the version in question.
3. Read additions, removals, and changed values.
4. Check block order and visibility as well as text.
5. Check metadata and lifecycle fields.
6. Identify changes that came from another editor.
7. Decide whether to restore the full revision or reapply only the intended
   correction.

A full restore can undo valid work saved after the target revision. Prefer a
narrow manual correction when only one field is wrong and later revisions
contain work that must remain.

## Restore a revision

Use restore only when your role permits it and the recovery plan is clear.

Before restoring:

- Confirm the record title and public path.
- Identify the exact target revision.
- Review every change between that revision and the current draft.
- Coordinate with any active editor.
- Record why the restore is needed.
- Confirm whether the restored draft will require a new review or preview.

After restoring:

1. Wait for the restore confirmation.
2. Reload the record.
3. Inspect the restored fields, blocks, order, and metadata.
4. Confirm that a new revision records the restore.
5. Reapply any valid later change that the recovery plan retained.
6. Do not publish automatically unless the restored draft has completed the
   required review.

## Respond to an unsaved-work warning

<figure class="admin-docs-screenshot">
  <p class="admin-docs-image-note">Screenshot omitted from this source distribution.</p>
  <figcaption><strong>Choose what happens to your unsaved work.</strong> Keep editing returns to the draft. Save and leave waits for a successful save. Discard and leave loses the unsaved changes. </figcaption>
</figure>

The CMS protects an in-memory working copy when you try to navigate away, close
the editor, switch records, or sign out.

When the warning appears:

- Choose the option that keeps you in the editor when you still need the work.
- Save when the change is intentional and complete.
- Remove the change when it was only a test.
- Deliberately discard only when you understand exactly what will be lost.

After returning to the editor, confirm that the working change is still present.
When the editor again matches the stored draft, ordinary navigation should no
longer trigger the warning.

Do not rely on the browser's back button to bypass a CMS warning.

## Understand editor locks

An editor lock is a courtesy signal that another authorized person is actively
working with the record. It reduces accidental overlap; it is not permission to
override someone else's work.

When a lock appears:

1. Read who holds it and when it was last renewed.
2. Contact the editor when the work is current.
3. Open the record read-only when that supports the task.
4. Wait for the lock to release or coordinate a handoff.
5. Use takeover only when your role permits it and the operational need is
   confirmed.

Do not take over merely because the other editor's browser tab is not visible
to you.

## Resolve a version conflict

A version conflict means the stored draft changed after your browser loaded its
baseline. Saving blindly could overwrite newer work.

The safest response is usually:

1. Copy your intended change into an approved temporary work note.
2. Choose the option that reloads the newer stored draft.
3. Review the newer revision and identify the other changes.
4. Reapply only your intended change.
5. Save against the new baseline.
6. Check revision history.

Use **Save anyway** or an equivalent override only when the interface offers it
to your role, the newer work has been reviewed, and overwriting it is the
explicit decision. Record the reason.

## Avoid multi-tab conflicts

Opening the same record in several tabs creates multiple baselines.

Prefer one editable tab per record. A second tab can be useful for a read-only
public comparison, but do not make independent edits in both.

Before closing a stale tab:

- Check for unsaved changes.
- Confirm which tab has the newest stored version.
- Preserve any intended text outside the CMS if recovery is required.
- Reload rather than forcing a stale save.

## Recover from a network or browser interruption

If a save fails or the connection drops:

1. Stay on the page.
2. Copy the unsaved text into an approved local note when possible.
3. Record the exact error.
4. Check the connection and retry once after the interface returns to an idle
   state.
5. Do not repeatedly press the primary action.
6. Reload only after preserving the working copy.
7. Check revision history to determine whether the server accepted the save.
8. Reapply the change only when the saved version is absent.

A timeout can leave the result uncertain. Revision history and a full reload
provide stronger evidence than the original spinner or toast.

## Recover from the wrong change

Use the least disruptive recovery:

| Situation | Preferred recovery |
| --- | --- |
| Unsaved typo | Correct it before saving. |
| Unsaved unwanted block move | Move it back or discard the working copy. |
| Saved single-field mistake | Correct the field and save a new revision. |
| Saved complex unwanted change | Inspect that version and restore only after reviewing later work. |
| Published mistake | Coordinate the fastest authorized correction; do not erase audit evidence. |
| Wrong record edited | Restore the wrong record, then apply the intended change to the correct one. |

After recovery, check both the stored draft and any public version affected by
the original action.
