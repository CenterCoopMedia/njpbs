# CMS content operations contract

Send `POST /cmsContentOps` to the CMS gateway configured for your environment.
Use `Content-Type: application/json` and the assigned automation account's
Firebase ID token as `Authorization: Bearer <id-token>`. The gateway applies
its access and request limits. Send at most 256 KiB of uncompressed JSON. The
CMS checks the account's grants against the
target record and action. A client may edit only existing records and must
hold the editing lease for apply and publish. The gateway obtains the lease
on behalf of the caller using the caller's identity.

## Discover the request version

The current request schema is `1`. An authenticated client can send
`{"schema":0}` to discover the supported schemas. The gateway rejects it
before loading a record, claiming a lease, or saving anything. It returns HTTP
400 with this body.

```json
{
  "error": "Send a schema 1 content operations request.",
  "code": "unsupported_content_ops_schema",
  "supportedSchemas": [1]
}
```

Select a schema your client implements from `supportedSchemas`. If the list has
no common version, stop and update the client. The same response applies when
a request object sends an unsupported or missing `schema`.

## Request schema 1

| Field | JSON type and rules |
| --- | --- |
| `schema` | Integer `1`. |
| `mode` | `"dry-run"`, `"apply"`, `"publish-dry-run"`, or `"publish"`. |
| `collection` | `"cmsPages"` or `"cmsPosts"`. |
| `id` | Saved record ID. One to 128 letters, digits, underscores or hyphens. |
| `baseVersion` | Positive safe integer from the record's current working `version`. |
| `requestReference` | Staff request or ticket reference. One to 200 printable ASCII characters with no surrounding whitespace. |
| `ops` | One to 100 operations for an edit. An empty array for either publish mode. |
| `expectDigest` | Lowercase, 64-character hexadecimal digest from the corresponding dry run. Required for `apply` and `publish`. Omit for both dry runs. |

For an edit, read the record with `cmsGetContent` and use its current working
version. Send `dry-run` with the planned operations and review its changes,
warnings and draft. To save, repeat that request with `mode: "apply"` and set
`expectDigest` to the returned digest. For publication, read the saved version
and send `publish-dry-run` with `ops: []`. Review the target version, then send
`publish` with the returned digest. Publish the exact saved version the staff
request authorizes. A publish dry run checks how the request resolves to that
saved version. The publish attempt performs the required lease, save, video
and publication checks.

| Target | `op` | Fields besides `op` |
| --- | --- | --- |
| Page | `insert` | Required `type`. Optional `ref`, `data` object, and `destination`. |
| Page | `move` | Block `id` and a `destination` object. |
| Page | `remove` | Block `id`. |
| Page | `split` | Row `id` and array of integer `columns` widths. |
| Page | `setData` | Block `id`, `data` object, and optional `unset` array of up to 20 field names. |
| Page | `setVisible` | Block `id` and boolean `visible`. |
| Post | `setCredits` | Ordered `credits` array of `{ "kind": "registered", "authorId": "…" }` or `{ "kind": "custom", "name": "…" }`. The operation replaces the byline. |

Page operations follow the same block palette, layout and field rules as
Boardwalk. Use `split` for row widths. A `destination` may name `rowId` and
zero-based `column` together, and may include `beforeId`. The operations run
in array order. A later operation can use an earlier insert's `ref` to refer
to the new block. A `ref` starts with a lowercase letter and contains up to
40 lowercase letters, digits or hyphens. Fresh blocks get their saved IDs
from the CMS. Use Boardwalk for Home, the data hub, Pages with a named
composition, and editing outside the operations listed here. For an action
that your account lacks permission to perform, send the staff request to an
authorized editor.

## Responses and receipts

Successful responses have status 200 and include `success: true` and `mode`.

| Mode | Other fields |
| --- | --- |
| `dry-run` | `digest` string, `baseVersion` integer, `changes` array, `warnings` array, and the proposed `document` object when supplied by the CMS. |
| `apply` | `digest` string, saved `version` integer when supplied by the CMS, `changes` array, and `warnings` array. |
| `publish-dry-run` | `digest` string, `baseVersion` integer, and the saved `status` string or `null`. |
| `publish` | Saved `version` integer when supplied by the CMS, and `publication` object. `publication.queueId` and `publication.transport` are strings or `null`. The native receipt can also carry a `status` string, `dispatched` boolean, `message` string, and `affectedHomeSections` and `warnings` arrays. |

Each `changes` entry has a `path` string and a `change` value of `added`,
`removed`, `moved`, `widths`, `fields`, `visibility`, or `credits`. It may
include block `type` and an array of changed `fields`. Treat the digest as
opaque. It binds the schema, target, base version, action and operations.

The audit row for a committed save records the actor and target along with
`automation.requestReference` and `automation.planDigest`. Use both fields to
correlate the reviewed plan with that audit row. Dry runs neither save nor
write a save audit row. A returned `publication.queueId` is a queue receipt.
Use the saved record's publication status to confirm that the version is live.

## Errors and recovery

Errors return an `error` message. Check the HTTP status and the fields below
before deciding whether to repeat any action.

| Status | Meaning and fields |
| --- | --- |
| 400 | Invalid request or unsupported operation. Unsupported schema replies include `code` and `supportedSchemas`. Correct the request or use Boardwalk for an unsupported operation. |
| 401 or 403 | Authentication or permission refusal. Verify the assigned identity and send the task to an authorized editor if the grant is missing. |
| 404 | The record is unavailable. Check its ID and whether you can read it. |
| 405 | The gateway requires a POST. |
| 409 | `versionConflict: true` means the record changed. Read the current version and review a fresh dry run. `digestMismatch: true` means the request differs from the reviewed plan. Review a fresh dry run and use its digest. Other 409 responses describe the applicable content or publication conflict. |
| 413 or 415 | Reduce a request that exceeds the size limit. Send uncompressed JSON with the required content type. |
| 423 | An editor lock prevented or interrupted the request. The response can include `lockHeld: true`, `holder` with `ownerName` and `ageSeconds`, or `lockRequired: true` when the CMS refuses the lock. Read the record and check with the editor before retrying. |
| 429 | A request or publication rate limit was reached. Honor `Retry-After` when supplied. |
| 502 or 503 | A gateway, upstream or publication check failed. `publicationCommitted: true` means the CMS saved the record as published, but the public update was unconfirmed. It can include the saved `version`. Read back the record and its publication status before making another request. Do the same if the connection ended before a response arrived. |

The [gateway fixtures](../../cms-api/test/content-ops.test.ts) exercise schema
discovery, unavailable operations and the wire responses. The [CMS fixtures](../../tests/functions/content-ops-contract.test.ts)
check stale versions, plan digests, stored revisions and audit rows against
the editor's write path.
