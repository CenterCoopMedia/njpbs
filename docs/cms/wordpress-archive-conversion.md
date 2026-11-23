# WordPress archive body conversion

The archive importer can call `convertWordPressStory` in
`functions/wordpress-archive-content.js` with one story's raw body. The input
contains `html`, its original `permalink`, `sourceRef: { source, postId }`,
and an optional `mediaByUrl` map from resolved image URLs to Boardwalk asset
IDs. Use the same source key and decimal post ID as the archive interchange.
The caller resolves the media map and owns the story's headline, byline,
publication dates, lifecycle, and revisions. The function performs no I/O.

| WordPress input | Boardwalk output |
| --- | --- |
| Classic body text, paragraphs, headings, lists, quotes, inline credits and correction text | Editable prose with safe links, emphasis and code. Blank lines separate classic paragraphs and single newlines become line breaks. Headings outside levels 2 and 3 are adjusted and flagged. Headings containing block markup retain their child content and are flagged. Combined inline code and other marks retain the other marks and are flagged. |
| Group, column and gallery wrappers with static HTML | Children in reading order. Column geometry and gallery styling are flattened. |
| Inline or standalone image with a mapped URL | An image block with the source alt text, link and plain caption when present. Missing assets and alt text are flagged. Rich captions and linked credits remain in adjacent prose. |
| Rectangular table with column headers and plain cells | An editable data table. Captions become titles and cell text is CSV-escaped. Spans, irregular rows and missing headers need manual reconstruction. Formatting inside a representable cell is flagged. |
| Player iframe, Gutenberg embed URL or standalone classic player link recognized by the shared renderer | An embed block with the provider's rebuilt URL. X embed markup becomes a link and is flagged for review. Unapproved URLs, inline frame documents and raw audio or video files are flagged. |
| Shortcodes, dynamic blocks and interactive markup | A review entry at the source location. Static fallback prose may be retained. Scripts, forms, hidden markup and unapproved frames are discarded. |

The shortcode inventory recognizes core media and caption commands, paired
plugin commands and tokens with attributes or a self-closing marker. Ordinary
bracketed prose is preserved and escaped recognized shortcodes become literal
single-bracket text. Classic caption
shortcodes leave their image and readable caption in order for review. Query,
latest-posts, feeds, navigation, synced patterns and other dynamic or unknown
Gutenberg blocks get review entries. The converter never executes WordPress
plugins or reconstructs private interactive content.

Each result contains `blocks` and one `report` row. The caller can collect rows
for a batch report. `complete` means blocks were converted without flagged
regions. `skipped` means the body had no convertible content and no flagged
regions. `manual_review` means the output may be partial or empty and the
original must remain available for remediation. The row contains the source key,
decimal post ID and fixed issue codes with offsets into the original HTML
(UTF-16 code units). It carries no HTML, attributes, links, captions, or article
text. A `report_limit` entry signals additional diagnostics beyond the row
limit. Input beyond the body or editor block limits returns a review row and no
blocks. Block IDs are deterministic for repeated conversion of the same input.

See the WordPress references for [block serialization](https://developer.wordpress.org/block-editor/explanations/architecture/data-flow/)
and [shortcode syntax](https://developer.wordpress.org/apis/shortcode/).
