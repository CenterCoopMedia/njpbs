# Published Post and Page layout proposal

The [public reading audit](public-reading-audit.md) found long lines in text-heavy Posts and Pages, several-section references that benefit from jump links, and media-led Posts whose text needs to stand on its own. The [rendered studies](public-reading-studies.html) show the proposed reading order with sample content.

## Layout choices

| Layout | When to use it | Reader experience |
| --- | --- | --- |
| Standard | Existing content, short Posts and Pages, and content that needs the current presentation | Keep the rendering selected by the current route, Post layout, and media. Standard is the default for new and existing content. |
| Reading | A long story or an editorial reference Page with several sections | Limit prose to about 65 characters per line on wide screens. Keep authored blocks in order, and let tables, figures, and players use the available main content area when they need the width. |

Offer Reading for ordinary Posts and CMS Pages that use the article family. Preserve the existing layouts for live coverage, the home page, schedules, staff directories, and service Pages. Existing lead media can carry a video-first Post in either layout. The video study shows a jump to the summary before the player and the summary directly after it. An approved transcript can follow the summary when available. Map findings, sources, corrections, and other material needed to understand the story belong in the main content next to the material they explain.

## Optional content in Reading

- **On this page.** Editors can opt into a short index after the introduction when at least two authored top-level sections have headings. Use heading text as the link names and preserve authored order. Give each destination a unique, stable fragment and visible focus on arrival. Omit the index when fewer than two eligible sections remain. Generated card labels and headings inside embeds stay out of the index.
- **Related links.** Editors can supply a short list of descriptive links to supporting material. The list follows the body in document order and appears beside it on wide screens. The list is the only sidebar content in this proposal. Omit the whole region when no valid links remain.

## Phone, zoom and print

- Keep the title, introduction, section index when present, body, and related links in the same reading and keyboard order at every width. At 390 CSS pixels and at the 320 CSS pixel reflow check, use one column with related links below the body. Use one column whenever the body and sidebar cannot both fit at the reader’s text size. Allow link labels to wrap and keep any scrolling needed for a wide table inside its own region.
- In print, omit the section index and player controls, and keep authored text, captions, sources, summaries and available transcripts in reading order. Keep useful video destinations as text links in print. Print related links after the body with their destinations visible.
- Check visible focus and heading announcements on jump links, reading order with a screen reader, keyboard access to media and overflow regions, 200% text sizing, 400% browser zoom, and PDF text order before shipping. The studies provide sample browser evidence for the layout and links. Production checks also need real media and long content.

## Editor and publishing behavior

After design review, put the layout choice in the shared Post and Page editor and show its effect in the existing preview. Start with Standard and Reading on eligible content, then add the optional sections. Preview reads the draft selection. The public renderer reads the selection from the published revision, so saving a draft cannot change the live layout. Missing or unsupported published selections render as Standard. Staff can return to Standard from the editor and publish that change through the normal workflow.

Use `PostPage.astro` and the `CmsPage.astro` article route for the first implementation. `PublicSubpage.astro` continues to serve the service and fallback routes. Cover old published records, a draft and published revision with different choices, unsupported selections, and absent sections at the render boundary when those behaviors land.
