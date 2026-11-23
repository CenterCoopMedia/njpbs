# Media browse filters

Open **Filter** in Images, Audio, or a video library. Each saved view keeps the
filters for its tab or video source and reopens on the first page.

| Filter | Where it applies | What matches |
| --- | --- | --- |
| Last updated | Images, documents, audio, and each video source | The asset's `updatedAt` date in UTC. The start and end dates are both inclusive, and either can be left blank. Items without a valid update date are excluded. |
| Duration | Audio and each video source | The measured duration of an imported voiceover or a ready video viewing copy. Enter inclusive bounds in whole seconds. Either bound can be left blank. Audio uploads and videos without a measured duration are excluded. |
| Aspect | Images and each video source | Landscape means wider than tall, portrait means taller than wide, and square means equal dimensions. Images use stored dimensions and videos use the ready viewing copy. Files without both dimensions are excluded. |
| Metadata review | Images, documents, audio, and each video source | An open metadata update request. Older items without a recorded request are excluded. |
| Rights review | Each video source | Needs review or rights recorded. This is independent of the metadata update request. |
| Tag | Each video source | One exact tag, including letter case. |
| Uploader | Each video source | Your uploads or, with staff-directory access, those of a selected uploader. |

In Videos, choose one filter property at a time. Either range counts as one
property. A name-prefix search can be combined with any one property. In Images
and Audio, metadata filters can be combined with one another and with the
existing search and browse filters. Favorites and collections have their own
membership filters. Related image and video search uses the active metadata
filters when showing or opening a result.

Browse APIs apply filters on the server before returning each page. A bounded
page can have no matches and still offer **Next**. Video name search uses name
order. Other video lists use the selected sort. Ties break by asset ID in the
same direction. Images and Audio use the selected sort, then normalized name,
then asset ID, all in the same direction. An exact ID match in a keyword search
can appear first when it meets the filters. Cursors apply to their original
query and filters.

Both `cmsListSourceMedia` and `cmsListMedia` accept `updatedFrom` and
`updatedTo` as `YYYY-MM-DD`, `minDuration` and `maxDuration` as nonnegative whole
seconds, `aspect` as `landscape`, `portrait`, or `square`, and
`metadataUpdateRequested: true`. Omit unused fields. Both APIs reject invalid
values, reversed bounds and metadata filters on exact-asset lookups. Video
status lookups also reject them. `cmsListMedia` rejects duration without the
audio kind, aspect when the requested kinds exclude images, and aspect together
with duration. Video filtered responses return `total: null`.

For video `rightsStatus`, use `pending` or `complete`. The API also accepts the
corresponding labels and uses the same cursor for either spelling. See the
[media metadata contract](media-metadata.md#controlled-terms-and-aliases).
