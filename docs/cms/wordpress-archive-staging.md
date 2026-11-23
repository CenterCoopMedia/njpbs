# Stage a WordPress archive in Boardwalk

Use the version 1 NDJSON file from the [WordPress archive extractor](https://github.com/CenterCoopMedia/njpbs/pull/435).
Keep the input and any saved reconciliation report in a private working directory.
Use Node.js 22, the root workspace dependency install, and
`npm run functions:build` to build the converter's shared contracts.

## Preview and apply

Run the preview in an authorized operator shell. Set `ARCHIVE_PROJECT` to the
explicit target. Supply the approved service account JSON for that project on
inherited file descriptor 3. The preview needs read access to the staging
collection and its receipts. Apply also needs create access to those documents.

```sh
node scripts/stage-wordpress-archive.mjs archive.ndjson --project "$ARCHIVE_PROJECT" 3<&0
```

Review the plan rows and the `plan-complete` counts. Rows report the source
identity or unmappable ordinal, the action, and any reason or conversion
status. A missing `plan-complete` row means the file did not finish validation.
The report omits source HTML, titles, links, and credential values.

When authorized to stage the reviewed file, use the same operator shell and
credential input. The command validates a private snapshot and prints a fresh
plan before it starts the item transactions.

```sh
node scripts/stage-wordpress-archive.mjs archive.ndjson --project "$ARCHIVE_PROJECT" --apply 3<&0
```

For a synthetic emulator run, start the local Firestore emulator and set
`FIRESTORE_EMULATOR_HOST` to its loopback address. Use an explicit `demo-`
project and omit descriptor 3.

## Reconcile a run

- `create` saves a staged record and its creation receipt in one transaction.
- `skip` means the same source revision already has a creation receipt. The
  importer preserves the current staged document and receipt.
- `review` identifies an unmappable input row, a source revision conflict, a
  changed or missing staged record, or a storage limit. A transaction records
  each distinct review outcome for rows that have a stable source identity.
  Unmappable rows here have no stable ID. Use their ordinals in the report.
- A story can stage with conversion status `manual_review`. Keep the raw body
  for remediation. The converter receives no media mapping during import, so
  unmapped images require review. Attachment rows retain their WordPress URLs.
  When derived blocks alone exceed Firestore's size or depth limit, the draft
  keeps the source row and a conversion report that identifies the limit.

If interrupted, repeat the command with the same file. Use the `apply` rows
for the transactional decisions and `apply-complete` for the final counts.
Existing documents keep their contents even when the source export changes.
Resolve a conflict through a separate, version-checked editorial action.

## Staging records

The server-only path is `wordpressArchiveItems/{id}`. `id` is the SHA-256 of
the compact JSON array `[source, "item", postId]` for stories and attachments,
or `[source, "author", authorId]` for authors. The top-level `sourceRef` retains
the original source and decimal identifier. `formatVersion` identifies the
record shape and `version` starts at 1. The original validated row is in
`record`. A staged story also stores the editable `conversion.blocks` and the
identifier-only `conversion.report`.

The item's `archiveImportReceipts/staged` document protects the initial
creation, including when the item is later deleted. Other receipt document IDs
derive from the incoming revision and review reason. The apply transaction
checks the planned version against the current staged version and records
conflicts without changing the item. Exact replays retain the original receipt.

The import writes only to this staging collection and its receipt subcollection.
Public and editorial publication services read their existing Posts, Pages, and
publication records. They cannot schedule, promote, or notify from staged data.
Archive browsing and any release of approved stories are tracked in [#360](https://github.com/CenterCoopMedia/njpbs/issues/360).

## Verify archive media originals

After staging the interchange, prepare a version 1 JSON manifest for one source.
List only attachments approved for this import. Use the source key, attachment
`postId`, and `revision.sha256` from the staged interchange. Supply the approved
title, caption, alt text, credit, and license as plain text. Use `null` for an
absent caption, alt text, credit, or license.

```json
{
  "version": 1,
  "source": "example-news",
  "items": [
    {
      "postId": "63",
      "revisionSha256": "a244820b3d10bfd82d98831c861a18cbc47c414b14d1523ae8102c0c5e303b7e",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "originalName": "train.jpg",
      "mimeType": "image/jpeg",
      "title": "Train",
      "caption": "A train at the station.",
      "altText": "A train alongside a platform",
      "credit": "Archive Photography",
      "license": null
    }
  ]
}
```

Replace the example hashes with the approved attachment revision and the SHA-256
of the original file. Keep the manifest and originals in a private working
directory. Name each original file with its lowercase SHA-256 and no extension.
The command accepts original JPEG, PNG, WebP, GIF, AVIF, and PDF files up to 25 MiB
each. The manifest limit is 4 MiB and each attachment ID may appear once.

Use the same operator shell and credential input as story staging. Run the
preview and review its plan before applying it.

```sh
node scripts/stage-wordpress-archive-media.mjs approved.json originals --project "$ARCHIVE_PROJECT" 3<&0
```

```sh
node scripts/stage-wordpress-archive-media.mjs approved.json originals --project "$ARCHIVE_PROJECT" --apply 3<&0
```

The report identifies missing originals, unsupported types, checksum or decode
failures, private source attachments, and staging conflicts by source and
attachment ID. An attachment that inherits its status needs a staged parent
story from the same source whose WordPress status is published. An absent or
unverified parent goes to review. Apply needs update permission on staged
attachments and read permission on the staging records and their creation
receipts. It saves the verified checksum, filename,
MIME type, byte size, image dimensions or PDF page count, and descriptive
metadata on each matched attachment. The transaction checks the staged revision
and version again before saving. Exact replays skip and changed metadata goes to
review. Attachments with identical original bytes retain separate source IDs.

The original files stay in the supplied directory. The command writes
server-only attachment metadata.

## Check an approved batch

Prepare a private version 1 JSON file for a single source after reviewing the
staged stories and verified originals. Include the approved `record.revision.sha256`
and current staged `version` for each item. For attachments, include the approved
`media.original.sha256`. Include any featured attachment in the same batch.
The command accepts up to 100 items in a file of at most 64 KiB.

```json
{
  "version": 1,
  "source": "example-news",
  "items": [
    {
      "kind": "story",
      "postId": "62",
      "revisionSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "stagedVersion": 1
    },
    {
      "kind": "attachment",
      "postId": "63",
      "revisionSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "stagedVersion": 2,
      "originalSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }
  ]
}
```

Use the same operator shell and credential input with read access to the staged
items and receipts.

```sh
node scripts/check-wordpress-archive-batch.mjs approved-batch.json --project "$ARCHIVE_PROJECT" 3<&0
```

The command checks one read-only Firestore snapshot. Stories need published
source status and a completed conversion. Attachments need a verified original
and either published source status or a verified published parent. Success
prints one `batch-inputs-checked` row with the item counts and an input digest.
The digest is stable across retries and manifest row reordering. If the check
is interrupted, run the same manifest again. If an approved revision or version
changes, review the new staged record before updating the manifest.

The check reads staging data only. Building and validating the public artifacts,
switching and returning generations, and measuring concurrent editorial
publication remain in [#379](https://github.com/CenterCoopMedia/njpbs/issues/379).

## Register approved assets in the media library

Use the same manifest and originals after verification. Include the attachments
whose original bytes and metadata are approved for public delivery. Registration
uploads those bytes to the standard public media store and makes the attachments
selectable in Boardwalk's image and PDF pickers in the General category. A story
or page still follows its own editorial publishing workflow.

Run the preview in the authorized operator shell with the same project and
Firestore credential input.

```sh
node scripts/register-wordpress-archive-media.mjs approved.json originals --project "$ARCHIVE_PROJECT" 3<&0
```

Review the `plan-complete` row and any `review` rows. Before applying, confirm
the media origin and R2 bucket belong to the selected project. Supply their
standard CMS settings (`CMS_MEDIA_PUBLIC_ORIGIN`, `CMS_MEDIA_R2_ENDPOINT`, and
`CMS_MEDIA_R2_BUCKET`) and the media store credentials through the operator
environment. Apply also requires the Firestore permissions used by media uploads.

```sh
node scripts/register-wordpress-archive-media.mjs approved.json originals --project "$ARCHIVE_PROJECT" --apply 3<&0
```

- `register` identifies the CMS asset. Each source attachment keeps a stable ID
  and its own metadata, including when two attachments contain the same bytes.
- `skip` identifies an existing registration. Subsequent editorial edits are
  preserved.
- `review` identifies a missing original, an unsupported format, an ineligible
  source, or a conflict with the verified staging record or media identity.

Use `apply-complete` for the final counts. A `failed` row names the attachment
and the reason that stopped apply. After correcting the cause, rerun the same
manifest against the same target to reconcile saved records and immutable
objects. The private media record keeps the source revision, original SHA-256,
and the PDF page count when applicable. Images use the admitted original as the
full-size asset and separate WebP thumbnails for smaller views. A `retryable`
thumbnail status can be picked up by the standard media thumbnail backfill.
