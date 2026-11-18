# Newsletter signup

In a Page's content editor, add a **Signup embed** plank and select **NJ PBS newsletter signup**. Move the plank among the Page's other content, place it in a row, hide it or remove it using the usual controls. Each approved signup can occur once on a Page, including hidden planks. The plank accepts an approved selection, with no HTML or script input.

The Page shows approved newsletter signup links until Wisepops renders its form. Those links also appear when consent is denied or withdrawn, Global Privacy Control is enabled, or the campaign is unavailable. When the approved catalog is empty or unavailable, the Page shows the station's standard signup link. The section reserves space for the form.

In Wisepops, set the embed's position inside `#njpbssignup` and target `/newsletters/`. The existing consent loader may run the campaign after the visitor allows newsletter tools. The form uses the campaign's phone and desktop layouts.

The initial newsletters draft can be prepared with `scripts/migrate-newsletters-signup.mts`. Its `--fixture <saved-page.json>` mode is read-only and is exercised in hosted CI. Its operator modes are `--read <project-id> <page-id> <saved-version>` and `--apply <project-id> <page-id> <saved-version>`, with the explicit project's service-account JSON streamed on fd 3 at use time. Production reads use `agent-cms-reader`; applying a draft needs separate production-write authority and credentials. Never save credentials to a file or pass them in arguments.

Install Boardwalk, API, public and preview reader support before applying. Read the current Page and review the dry-run against its saved version. Apply reuses the installed-reader check and refuses unsupported readers, a changed version, an active editor, an ambiguous introduction or a conflicting plank ID. It inserts the signup after the introduction or its entire row and preserves existing staff content and any saved signup placement or visibility. It saves a draft, revision, working media usage and audit entry; it does not publish. Its retained revision prevents a rerun from restoring a signup staff later removed. Staff review and publish the draft.

This one-time migration serves the live newsletters Page that currently lacks a signup plank. Delete the migration script and its operator tests once the coordinator verifies the first staff-approved publication with this plank. Keep the Page block, consent checks and staff editing support.
