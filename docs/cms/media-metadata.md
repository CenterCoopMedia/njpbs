# Media metadata

Boardwalk has two media contracts. The upload library stores images, PDFs and
WAV audio, including imported voiceovers. The video library and the read-only
archive sources share a separate video contract. This inventory describes the
fields each contract accepts and how it handles older records.

| Field | Upload library | Video library and archive sources |
| --- | --- | --- |
| Name and original filename | Name is editable and defaults to the filename without its extension. It has a 180-character limit. The upload supplies the initial original filename, which an authorized edit can correct. | Name is editable in the video library and defaults to the original filename. Both have a 500-character limit. The upload or import supplies the original filename. |
| Description, credit and license | Optional free text, limited to 2,000, 300 and 120 characters. The image web-copy upload can use embedded caption and credit when those fields are empty. | Optional free text, limited to 2,000, 500 and 500 characters. The upload or edit supplies these fields. Archive imports retain previous values or leave them empty. |
| Tags | Optional free text. Up to 20 tags of at most 40 characters. Writes keep the first spelling of case-insensitive duplicates. | Optional free text. Up to 30 tags of at most 80 characters. Writes and browse filters match exact spelling and case after trimming request values. |
| Category | The registry supplies category IDs. The primary category controls access and stays in the list of up to eight assignments. An older record can have the primary category alone. | The configured source determines access. The video contract has no category field. |
| Alt text suggestion | Optional text up to 500 characters. A generated suggestion has a separate flag. | No asset-level alt text field in the video contract. |
| Metadata update requested | Boolean. Older records without it read as false. | Boolean. Older records without it read as false. The filter matches only explicit true values. |
| Rights review | License and credit are free text. This library has no separate rights review state. | The record stores `pending` or `complete`. New uploads and new archive imports default to `pending`. |
| Source, actor and timestamps | The source can identify an upload, site seed or imported voiceover. The service records the actor and timestamps when available. | The configured source identifies the library or archive. The service records the uploader or import identity and timestamps. Archive imports can use the object's last-modified time as the initial creation time. |
| Technical and derived fields | File type, size, and image dimensions come from the file and record. Imported voiceovers carry take and manifest metadata. | File type, size, object version and viewing-copy details come from storage and processing. A derived upload can record its parent video and time range. Video markers use whole milliseconds and the marker type and color lists in the video contract. |

Use the [upload library contract](../../functions/lib/media-contract.js) and the
[video read](../../functions/lib/source-media-contract.js) and
[video write](../../functions/lib/source-media-upload-contract.js) contracts
for API validation details. The [video browse filters](video-browse-filters.md)
document the supported query combinations. The upload library includes saved
descriptive fields in text search. A video browse tag filter matches a saved
tag in the selected source. A suggestion from saved tags is a freeform value.

## Controlled terms and aliases

The video upload and metadata APIs accept the same labels used in the editor.
Single and bulk edits send patches to the same metadata API. The video browse
filter accepts the same values.

| Stored value | Accepted label |
| --- | --- |
| `pending` | Needs review |
| `complete` | Recorded |

Requests can use either the stored value or the label, with any letter case.
The API trims surrounding spaces. Writes and queries use the stored value, so
existing records and cursors work with either spelling. Other values fail
validation. A recorded rights review describes review progress. Use the
applicable permissions and rights policy when publishing a video.

Keep credit, license, description and existing tags as free text. Add an alias
only after confirming that its meaning matches the controlled term exactly.
Document its source, map it to one stable ID, and check writes and filters
against records that already use that ID. An image category label is display
text. The category ID and its access rules determine assignments.

## Fields to define before expanding the schema

Neither contract has shared fields for capture date, creator distinct from the
credit line, or the evidence behind a rights statement. Source and creation
timestamps describe the record or imported object. They can differ from who
made the media or when it was captured. Before adding these fields, identify
the sources that supply them, the media types and editors that use them, and
whether saved values can be verified. Define any controlled descriptive terms
and their aliases with editorial review before using them in queries.
