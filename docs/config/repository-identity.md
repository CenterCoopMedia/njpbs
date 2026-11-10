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
`CMS_BUG_REPORT_GITHUB_REPOSITORY` repository variable. It has no default and
is not derived from the deploying repository, so reports never reach a public
repository by default. When the variable is empty, the GitHub handoff is refused.
