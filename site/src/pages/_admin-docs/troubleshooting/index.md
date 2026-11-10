---
title: Troubleshooting and support
description: "Resolve common sign-in, loading, saving, media, preview, and permission problems and report what remains."
---

## Start with the smallest safe check

Before changing data or repeating an action:

1. Read the exact message.
2. Confirm the account identity.
3. Confirm the page address and record.
4. Wait for any pending action to finish.
5. Preserve unsaved text.
6. Check whether the issue is local to one record or affects every workspace.
7. Reload only when the working copy is safe.
8. Retry once when the interface has returned to an idle state.

Repeated clicks can create duplicate requests or make the evidence harder to
interpret.

## Common problems

| Problem | First checks | Safe next action |
| --- | --- | --- |
| Boardwalk does not open | Confirm the address, internet connection, and organizational access prompt. | Retry in a current browser; report the browser message and time if the access screen does not appear. |
| Wrong account is shown | Check the account menu and active Google identity. | Sign out fully, then sign in with the approved work account. |
| Access is pending | Confirm email verification and the request identity. | Wait for administrator review or contact the established CMS support channel. |
| Expected destination is missing | Confirm role, area grant, collapsed or customized navigation, and recent role changes. | Sign out and back in after a known change; report the expected destination and role. |
| Preparing your workspace does not finish | Record the active checklist phase and slow message. | Keep waiting while Boardwalk reports the current phase. Refresh only after work in other Boardwalk tabs is safe. |
| Record is blank | Wait for loading to finish; confirm the record path and permission. | Do not recreate the record. Report the address, role, and exact empty or error state. |
| Save is disabled | Check whether anything changed, whether required fields pass validation, and whether the record is read-only. | Correct validation or confirm the lifecycle and role; do not make a meaningless edit. |
| Save appears stuck | Do not press the action repeatedly. | Preserve text, wait for a terminal message, then check revision history before retrying. |
| Unsaved-work warning appears | Identify the working change and intended destination. | Stay in the editor, save or remove the change, then navigate again. |
| Editor lock appears | Read the owner and time. | Coordinate with the current editor; take over only when authorized. |
| Version conflict appears | Preserve your intended change and review the newer draft. | Reload the newer version and reapply only the intended change. |
| Media cannot be selected | Check asset status, file kind, rights metadata, filters, and role. | Reopen the asset detail; report the asset identifier and record if selection still fails. |
| Preview remains pending | Confirm the draft was saved and note the request or revision. | Wait for a terminal status; do not create repeated previews without a reason. |
| Publication fails | Read the failure category and keep the queue open. | Verify the public page still shows the prior version; escalate with the record, revision, and run or request identifier. |
| Public page looks stale | Confirm that publication succeeded and that you opened the public, not preview, URL. | Reload without a preview session; report the public URL and expected revision. |

## Sign-in and verification problems

### Your session ended

Boardwalk signs you out when your sign-in is no longer valid, for example after
an administrator changes your account, and 60 days after you last signed in. The
sign-in screen says **Your session
ended. Sign in again.** Sign in with the same account.

Drafts that Boardwalk autosaved are still there. Changes made after the last
autosave may be lost. A problem report that you had not sent is not kept.

### No verification message

- Check the exact email address entered.
- Check spam or quarantine.
- Use the resend action once.
- Use only the newest verification link.
- Confirm that the message sender and destination match the Boardwalk instructions.
- Do not forward the link.

If delivery remains unclear, report the account email and approximate request
time. Do not include the verification URL.

### Verification link fails

A link can be expired, already used, incomplete, or opened under the wrong
account.

Return to Boardwalk, request a new link, and open the newest message in the same
browser session. Record the exact error without copying the credential-bearing
URL.

### Password reset does not arrive

Enter the account email before selecting **Forgot password?** The confirmation
may intentionally avoid revealing whether an account exists.

Check spam, use the newest message, and contact support if the account is known
to use email-and-password sign-in. Google-authenticated accounts must be
recovered through their identity provider.

## Loading and route problems

### Preparing your workspace does not finish

The entry checklist reports four real phases: **Restoring your sign-in**,
**Confirming staff access**, **Loading your profile and permissions**, and
**Opening your workspace**. Record the phase marked as current and its phase
detail. Do not convert the checks into a percentage; they show
completed phases only.

During an ordinary wait, decorative Boardwalk tips change every 4.5 seconds.
They add no phase or delay to the real checks and are not diagnostic evidence.

**Pause text** holds the current tip while the real checklist keeps updating.
**Resume text** stays available while paused. A reduced-motion setting or a
hidden browser tab also stops automatic tip changes; the real checks continue.

After eight seconds, tips stop rotating. Boardwalk reports **This is taking
longer than usual. The current check is still pending.** Include the active
phase and slow message in the support report.

Do not repeatedly reload the entry screen. Before one deliberate reload,
preserve unsaved work in any other Boardwalk tab and confirm that restarting
entry is safe. If the same phase remains active, report the address, phase,
phase detail, slow message, account identity, and time.

If one workspace fails while others work:

1. Record the failing route.
2. Return to Home.
3. Reopen the destination from the navigation rail.
4. Test a different record of the same type without editing it.
5. Determine whether the problem follows the record or the workspace.

If every authenticated workspace fails, preserve any work and report the
session-wide failure. Do not clear browser storage until support has reviewed
whether the session evidence is useful.

A “Page not found” response can mean the address is not part of the CMS, a
retired route was bookmarked, or the current account cannot use that
destination. Navigate from the rail instead of editing the URL by hand.

## Saving problems

### No confirmation

Stay on the page and inspect:

- Pending indicator.
- Inline field validation.
- Top-level error message.
- Revision history.
- Network state.

A save can succeed even when the browser misses a transient confirmation, or
fail after a long pending state. Reload only after preserving unsaved work, then
use revision history to establish the stored result.

### Validation failure

Read every identified field. Validation can apply to:

- Required metadata.
- URL or link safety.
- Block counts.
- Missing alternative text or credit.
- Invalid schedule date.
- Lifecycle prerequisites.
- Protected identity fields.

Correct the source field. Do not work around validation by putting content into
an unrelated field.

### Permission failure

Confirm the role, area grant, record assignment, and lifecycle. Report the
action you expected to perform and the permission message. Do not use another
person's session.

## Media problems

When an asset is missing from results:

- Clear filters.
- Search a shorter title or filename fragment.
- Check file kind and category.
- Confirm that upload or processing completed.
- Check whether the asset is active and authorized.

When the wrong crop appears, inspect the asset focal point and the destination's
responsive treatment. Do not replace a shared asset until its other uses have
been reviewed.

When a document fails, check the source file locally and confirm that it does
not contain private or inaccessible material before uploading a replacement.

For problems in the Boardwalk panel in Adobe Premiere Pro, see
[Fix common problems](/guide/premiere-panel#fix-common-problems) and use
**Settings → Report a problem** in the panel.

## Preview and publication problems

Record:

- Content title and Boardwalk address.
- Saved revision or version.
- Preview request or release identifier.
- Start time and time zone.
- Last terminal status.
- Exact error.
- Public or preview URL checked.

Do not include session tokens or protected preview credentials.

After a failed publication, open the public page and confirm whether the prior
version remains. Escalate operational failures rather than repeatedly changing
the draft when the error does not identify editorial validation.

## Collect a useful support report

Select **Report a problem** in Boardwalk. Describe the action, expected result
and actual result. The form attaches browser diagnostics and recent CMS request
IDs automatically. Keep the returned report ID for follow-up. Reporting does
not close the editor or discard unsaved work.

If you cannot use the form, use this format:

```text
Reporter:
Date, time, and time zone:
Boardwalk account email:
Role or expected role:
Device and approximate viewport:
Browser and version:
Boardwalk page address:
Record title and public path:
Action attempted:
Expected result:
Actual result:
Exact message:
Unsaved work preserved: Yes / No / Not applicable
Revision, preview, or release identifier:
Does the problem affect another record or workspace:
Screenshot or recording:
```

Redact unrelated names, open tabs, notifications, tokens, verification links,
member or donor information, and unpublished material.

## Report a security problem privately

Use the approved private security channel when the problem suggests:

- Unauthorized access.
- A role that exposes restricted actions.
- Private content visible to the wrong account.
- A leaked credential, token, or verification link.
- A public page exposing protected information.
- An audit record that appears altered or missing.

Do not open a public issue with exploit details or sensitive screenshots. Stop
the risky action, preserve evidence, and contact the responsible administrator
or security contact directly.

## Know when the issue is resolved

A fix is complete when:

- The original workflow succeeds or the correct restriction is explained.
- Unsaved work has been recovered or deliberately discarded.
- The expected draft remains after reload.
- Revision or activity evidence is consistent.
- A preview or public page has been checked when relevant.
- The support record states the cause and verified result.

“Works now” is not enough for a recurring or high-risk failure. Record what
changed.
