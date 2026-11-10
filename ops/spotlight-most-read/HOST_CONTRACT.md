# WordPress integration contract

This package expects these theme and WordPress interfaces. Verify them for your
installation before applying the patches; no deployed-host state is assumed.

| Consumer | Required interface |
| --- | --- |
| Popular REST route | GET `/wnet-spotlight/v1/popular/` calls the guarded `njs_endpoint_popular()` and permits public reads. Its response contains a `popular` list with `id`, `url` and `title`. |
| Homepage helper | `spotlight_hp_most_popular_shared()` has a guarded declaration and returns HTML to the homepage blocks caller. |
| Sidebar | `homepage-sidebar.patch` adds a guarded `spotlight_most_read_sidebar()` call after the latest list in `views/home/home-view.php`. Successful sidebar rendering suppresses the older full-width helper for that request. Without the view call, the full-width block remains available. |
| Homepage metadata | `homepage-metadata.patch` adds dates to `spotlight_hp_list_item()`, `spotlight_hp_lead_story()` and `spotlight_hp_single_feature()` in `helpers/spotlight-homepage-helpers.php`. |
| Legacy consumer | `legacy-popular.php` renders five items from the same saved snapshot. |
| Activation | A positive configured `NJSPOTLIGHT_BLOG_ID`, `NJSPOTLIGHT_CONTEXT=production` and nonempty `NJSPOTLIGHT_POSTING_ACCOUNT` are required at plugin bootstrap. Other contexts retain the theme's page view. |
| Styles | The theme registers `site-main`. Install the shared stylesheet at `libs/css/spotlight-most-read.css`; the plugin enqueues it at priority 100. STIX Two Text and Inter come from the theme. |
| Collector | Supply combined-format request logs with UTC timestamps, including the previous uncompressed `.1` file when needed. Confirm complete reporting-window coverage before import. |

The standalone page uses `[spotlight_most_read]`. Homepage, standalone and legacy
consumers recheck publication status and use only saved, current rankings.
Co-Authors Plus must provide assigned `author` terms before its display name is
used. The explicit RSS extension is `njspotlight:byline`; the namespace is
`https://www.njspotlightnews.org/ns/1.0/`.

Above 900 pixels, the sidebar contains whole compact cards in the available
column height. A 224-pixel floor preserves two cards. Hidden desktop cards become
inert after layout, resize and font loading; the phone layout keeps all four
stories. Recheck ordinary rendered pages and keyboard access when integrating
with a different theme or source revision.
