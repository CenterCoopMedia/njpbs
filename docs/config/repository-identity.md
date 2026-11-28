# Repository identity

Set `CANONICAL_GITHUB_REPOSITORY` to the approved `owner/repository` name and
`CANONICAL_GITHUB_REPOSITORY_ID` to its immutable numeric GitHub ID. Both are
required. Local deployment commands and the schedule monitor read these from
their process environment. Workflows receive them from GitHub repository
variables with the same names. Missing, malformed, or mismatched identity refuses
authorization. Never derive the expected identity from `GITHUB_REPOSITORY` or a
remote URL being checked.

Admin builds also receive `VITE_CANONICAL_GITHUB_REPOSITORY` from that repository
variable to validate milestone links. Firebase publish dispatch receives the
required `CMS_PUBLISH_GITHUB_REPOSITORY` Functions parameter at deployment; it has
no default destination. Configuration is supplied before deployment, with no
additional network lookup on the request path.

Staff problem reports go to the repository named by the
`CMS_BUG_REPORT_GITHUB_REPOSITORY` repository variable, with its immutable numeric
ID in `CMS_BUG_REPORT_GITHUB_REPOSITORY_ID`. Proposed fixes use the separate
`CMS_BUG_REPORT_FIX_GITHUB_REPOSITORY` and
`CMS_BUG_REPORT_FIX_GITHUB_REPOSITORY_ID` pair. All four are Functions parameters
supplied by repository variables during deployment. They have no default target.
Each API client verifies the remote repository's name and ID before operating.
Signed webhooks require a configured name/ID pair and select reports in that
namespace. A public issue event cannot update the separate report tracker.

The root report fields `fixPullRequestRepository` (owner/name) and
`fixPullRequestRepositoryId` (number) identify `links.pullRequestNumbers`.
Reports missing both fields use the issue-tracker identity. Partial, malformed
or unconfigured pairs refuse. An attachment writes its repository identity and
number in one transaction. Changing the namespace clears prior PR evidence and
retains the previous links and identity in the audit record. A sync begun before
that change cannot restore old PR evidence; the existing sync job refreshes the
current namespace. Cached rows from another namespace are omitted from staff
progress while that refresh is pending.

A sync reads the report issue's timeline once for both repositories. A report
with no manually attached pull request follows a fix-repository pull request
that references its issue (`owner/name#number` in the pull request body or a
comment): the sync writes the fix-repository identity with the discovered
numbers, which clears the earlier namespace's evidence as an attachment does.
A manual attachment keeps its namespace.

A merged fix-repository pull request is live when its merge commit is the
deployed revision or an ancestor of it. Production reads the revision from the
live Admin status (`build.revision`); other environments use
`CMS_ADMIN_BUILD_REVISION`. The sync compares the two commits through the fix
repository and records `live` and `liveRevision` on the pull request row. It
compares again when the deployed revision changes, so a rollback to an older
build clears `live`; a failed read keeps the stored evidence. Staff progress
shows "Fix live" on the Live verification step. A fix not yet verified stays at
"Merged; live verification pending" while the revision or comparison cannot be
read. Marking the report resolved stays an administrator action.

Before enabling the CMS autofix host service, deploy this reader, supply and
read back the four production settings in the switch packet's F09 table, and
verify the host writer stores the same root identity fields atomically with the
PR number. Source review does not authorize those deployment or activation steps.
