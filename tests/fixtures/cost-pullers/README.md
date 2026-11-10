# Cost puller fixtures

These synthetic, sanitized fixtures use public response schemas from the listed provider APIs. They do not contain real account billing data or credentials. Tests use these files and inline response fixtures, with every network call stubbed.

- `gcp-query-response.json` follows the BigQuery `jobs.query` response shape.
- Cloudflare billing history responses, including pagination cases, are inline in `tests/functions/cost-pullers.test.js`.
- `aws-cost-explorer.json` follows the Cost Explorer `GetCostAndUsage` response shape.
- `github-usage.json` follows the GitHub billing usage response shape.

Schema references: [BigQuery jobs.query](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query), [Cloudflare account billing history](https://developers.cloudflare.com/api/resources/billing/subresources/history/methods/list/), [AWS Cost Explorer GetCostAndUsage](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html), and [GitHub billing usage](https://docs.github.com/en/rest/billing/usage).

`fractional-usage.json` includes synthetic sub-cent charges and credits that must
be summed before rounding, plus a high-precision cancellation at half a cent.
