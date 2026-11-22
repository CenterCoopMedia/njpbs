# WordPress archive interchange

Use the extractor with a WordPress eXtended RSS (WXR) 1.2 export. Give each
source site its own stable key and use the same key for subsequent exports.
Keep the export and interchange files in a private working directory.

```sh
python3 scripts/extract_wordpress_archive.py export.xml --source example-news
python3 scripts/extract_wordpress_archive.py export.xml --source example-news --output archive.ndjson
```

The first command prints counts by record kind and reason. The second prints
the same counts and creates a private file at the requested path. The tool
reads the input in 64 KiB chunks and keeps at most one channel record for
mapping. It reports records above 2 MiB or 4,096 XML elements as unmappable.
Malformed XML, a document type declaration, nesting beyond 64 levels, and XML
tokens above the size limit stop extraction. A failed run leaves the requested
path untouched. Use a new output path for each export.

## Format version 1

The interchange is UTF-8 newline-delimited JSON. It has one header, one row for each
recognized WordPress author or item, and one summary row after the parser
reaches the end of the export.

| `kind` | Fields |
| --- | --- |
| `header` | `format` is `wordpress-archive`. `version` is `1`. `source` is the stable source key. |
| `story` | `postId`, `revision`, `title`, `slug`, `permalink`, `sourceStatus`, `lifecycle`, `postDate`, `postDateUtc`, `authorLogin`, `taxonomy`, `parentPostId`, `featuredAttachmentId`, `html`, and `excerpt`. |
| `attachment` | Same fields as a story, with `attachmentUrl` in place of `featuredAttachmentId`. |
| `author` | `authorId`, `login`, `displayName`, and `revision`. A story's `authorLogin` can refer to an author row from the same source. |
| `unmappable` | `entity` is `item` or `author`. `ordinal` is the one-based position among all item and author rows. `reason` is a fixed code. |
| `summary` | `counts` by row kind for stories, attachments, authors, and unmappable records. `reasons` counts unmappable records by reason code. |

- Use `(source, postId)` as the identity of an item and `(source, authorId)`
  as the identity of an author. WordPress IDs are decimal strings. Parent and
  featured attachment IDs refer to items from the same source and can be
  `null`. Related records can be absent from a partial export.
- `revision.modifiedAt` is WordPress's modification time in UTC, or `null`
  when absent. `revision.sha256` is the digest of the mapped record before
  adding `revision`. The extractor hashes compact UTF-8 JSON with keys sorted
  and no trailing newline. A changed
  field changes the digest even when modification times match. Compare source
  identities and revisions during staging. The file preserves repeated IDs for
  reconciliation.
- `postDate` preserves the WordPress local date and time without a guessed
  time zone. `postDateUtc` preserves the corresponding UTC value when present.
  Missing dates and WordPress zero dates use `null`.
- The WordPress source lifecycle stays in `sourceStatus`. Story statuses
  `publish`, `private`, `future`, `draft`, and `pending` all map to
  archive lifecycle `staged`. Attachment statuses `inherit`, `private`,
  and `publish` also map to `staged`. A source date or status carries no
  publication or scheduling instruction.
- `permalink` comes from the item's RSS `link`. `taxonomy` lists the
  export's per-item terms in order. Each entry contains `taxonomy`, `slug`,
  and `label`.
- The file retains the source body and excerpt for block conversion. Treat both
  as untrusted text and keep them out of rendered pages. Attachment URLs are
  references. The extractor performs zero network requests and zero CMS writes.
- The extractor reports unsupported post types and statuses, password-protected
  items, malformed field values, and oversized records. It omits account email
  fields, comments, and unrelated WordPress metadata. Review unmappable rows
  against the source export before staging.

The extractor prepares input for the Boardwalk staging importer tracked in
[#357](https://github.com/CenterCoopMedia/njpbs/issues/357).
The [WordPress export reference](https://developer.wordpress.org/reference/functions/export_wp/)
documents the source fields.
