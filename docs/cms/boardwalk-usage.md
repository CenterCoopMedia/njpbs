# Usage analytics release checks

Before releasing enabled collection, an authorized server operator must set
`usageAnalyticsExcluded: true` on each agent, test and non-staff vendor
`users/{uid}` document. Verify that every nonhuman account is excluded. Keep
accounts used by staff counted.

The server-only profile field is the sole exclusion authority for new usage
events and historical totals. Browser clients, including administrators, cannot
add, change or remove it. Existing aggregate counts are not rewritten.

Deploy and verify the two usage TTL policies and Functions before releasing an
enabled Admin artifact. Verify account exclusions before enabling collection.
The shared `analyticsEnabled` setting remains the collection stop control.
Account changes and deployment require separate authority.
