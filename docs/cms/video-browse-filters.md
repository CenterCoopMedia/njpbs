# Video browse filters

A video library shows active videos from the selected source. Choose one filter
property at a time. You can also search for the start of a video name with any
of these filters.

| Filter | Matches |
| --- | --- |
| Tag | One exact tag, including letter case |
| Uploader | Your uploads or, with staff-directory access, a selected staff uploader |
| Rights review | Needs review or rights recorded |
| Metadata review | Videos with an open metadata update request |

To find open requests, open **Filter**, choose **Metadata review**, then select
**Metadata update requested**. The filter works in each video source. An older
video with no recorded request is excluded. Image, audio, favorites, and
collection views have their own filters.

The server applies the filter before paging. Results use the selected sort and
break ties by asset ID in the same direction. A name search uses name order.
A cursor is valid only for its original source, search, filter, and sort.
Saved views keep the filters for that source and reopen on the first page.

For API clients, pass `metadataUpdateRequested: true` to `cmsListSourceMedia`.
Omit the field to browse without it. The API rejects other values, combinations
with another filter property, and its use on exact-asset or status lookups.
Filtered responses omit an exact total by returning `total: null`.
