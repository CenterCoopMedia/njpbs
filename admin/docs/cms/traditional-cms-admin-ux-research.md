# Traditional and site-builder CMS admin UX research

> This research briefing surveys how seven traditional and site-builder CMS
> products structure their admin: routing, navigation, home screen, content library,
> list-to-editor relationship, editorial workflow, command palette, and responsive
> behavior. Products covered: WordPress (wp-admin plus the Gutenberg site editor),
> Ghost, Craft CMS, Statamic, Prismic, Storyblok, and Kirby. It informs newsroom
> admin design.
> Companion briefings cover the same questions for headless CMSs
> ([headless-cms-admin-ux-research.md](headless-cms-admin-ux-research.md)), newsroom
> CMSs ([newsroom-cms-research.md](newsroom-cms-research.md)), and non-CMS
> productivity tools ([productivity-tool-ux-research.md](productivity-tool-ux-research.md)).
>
> These seven are the mature, self-hosted, and site-builder end of the market. They
> matter to this redesign for one reason the headless and newsroom sets cannot supply:
> they have spent fifteen-plus years solving admin navigation and URL routing for
> non-technical editors at scale, and wp-admin in particular is the reference
> implementation of URL-addressable everything.
>
> Method and sourcing: every claim was checked against a live source and carries its
> URL. Where vendor documentation was vague, absent, or contradicted by the product,
> the finding was verified against the product's own source: WordPress core PHP and
> admin CSS, Ghost's Ember router plus environment config plus its `shade` design
> system, Statamic's `routes/cp.php`, and Kirby's `Panel/Page.php`. Claims are tagged
> **[verified]** (confirmed against primary documentation or source code, URL inline)
> or **[source-verified]** (read directly out of the product's source, where the
> documentation was wrong, stale, or silent). Nothing here is tagged as inference:
> where a fact could not be established, it is recorded as **not documented** rather
> than guessed. Three documentation sources are actively wrong or stale and are called
> out in "Stale and incorrect sources" below.
>
> The technical design considerations at the end connect this prior art to the
> editorial behavior implemented in this repository.

## Evaluation questions

Five questions guide the comparison:

1. Can editors bookmark, navigate back to, and resume a specific item?
2. Does the navigation communicate one clear hierarchy?
3. Does home help editors resume work?
4. Can editors browse, search, filter, and reopen content?
5. Do save, review, preview, and publish form a coherent workflow?

Each product block below addresses those five questions.

---

## WordPress admin (wp-admin and the Gutenberg site editor)

- **Nav model:** One persistent vertical rail (`#adminmenu`) plus a horizontal
  Toolbar. Top level: Dashboard, Posts, Media, Pages, Comments, Appearance, Plugins,
  Users, Tools, Settings. The second level is a hover flyout that "expands when
  hovered over and remains open when an item is selected," so it costs no permanent
  width. A **Collapse menu** button at the rail's foot "shrinks the menu into a set
  of icons or expands it." There is no second sibling rail: depth is hover and
  expand, not a parallel column. [verified]
- **URL/routing:** Everything is URL-addressable. Status views are built with
  `add_query_arg` against `edit.php` in `class-wp-posts-list-table.php`:
  `edit.php?post_status=draft&post_type=post`, `?post_status=pending`,
  `?post_status=future`, plus `edit.php?post_type=post&all_posts=1` (All),
  `edit.php?post_type=post&author=<current_user_id>` (**Mine**), and `?show_sticky=1`.
  Item editor: `post.php?post=123&action=edit`. New: `post-new.php?post_type=X`.
  Media: `upload.php`. Taxonomies: `edit-tags.php?taxonomy=category`. Plugin screens:
  `admin.php?page={menu_slug}`, from `add_menu_page()`'s `$menu_slug`, built by
  `menu_page_url()`. Site editor: `site-editor.php?postType=page&postId=<id>&canvas=edit`.
  Every filter, status view, and sort is a bookmarkable GET URL. [source-verified]
- **Dashboard/home:** Widgets, all oriented to resuming work, none about roles or
  billing. **At a Glance** (counts of posts, pages, and comments, each linking into
  that content type; WordPress version and active theme at the foot). **Activity**
  (upcoming scheduled posts, recently published posts, and recent comments with
  inline hover actions: approve/unapprove, edit, reply, spam, delete). **Quick Draft**
  (title, media, content, tags, then **Publish** or **Save Draft**; it also lists your
  five most recent drafts). **WordPress Events and News**. **Welcome**. **Site Health
  Status**. **PHP Info**. Widgets drag-reorder, collapse, and toggle via **Screen
  Options**. [verified]
- **Content list / library:** A list table. Columns: checkbox, Title (with a bold
  **— Draft**, **— Pending**, **— Private**, **— Sticky**, or **— Password protected**
  suffix), Author, Categories, Tags, comment bubble, Date (Published date for
  published items, **Last Modified** for others, the scheduled date for future posts).
  Title, Author, and Date sort by clicking the header. Above the table: the status
  view links row with live counts (`All (12) | Mine (3) | Published (8) | Draft (3) |
  Pending (1) | Trash (2)`), a **Show all dates** dropdown, a **View all categories**
  dropdown, a **Filter** button, and a **Search Posts** box. **Bulk Actions** dropdown
  plus **Apply**; Bulk Edit opens an inline panel changing Author, Comments Allowed,
  Status, Pings, and Sticky, and adds but never removes categories and tags. **Screen
  Options** controls visible columns and posts per page. A **List View / Excerpt
  View** toggle. Row hover reveals **Edit | Quick Edit | Trash | View**. [verified]
- **List-to-editor relationship:** Full-page navigation (`edit.php` to
  `post.php?post=123&action=edit`). Browser back returns to the list with filters
  intact, because the filters are in the URL. **Quick Edit** is the escape hatch: an
  inline row-expanding form (Title, Slug, Date, Author, Password/Private, Categories,
  Tags, Allow Comments, Allow Pings, Status, Sticky) so light edits never leave the
  list. The newer **DataViews** (`@wordpress/dataviews`) powers the site editor's
  Pages, Templates, and Patterns screens, and its `list` layout is documented as a
  "side by side" sidebar view "for when there's a detailed view for each item," which
  is a real split view. [verified]
- **Editorial workflow:** Statuses are first-class: `draft`, `pending` ("Pending
  Review"), `publish`, `future` (scheduled), `private`, and `trash`. Status shows in
  three places at once: the view-links row with counts, the Title cell suffix, and the
  editor's Status and visibility panel. Scheduling is native (`future`, with the Date
  column showing the scheduled date). Revisions are built in. Assignee is modeled as
  Author, and `edit.php?author=<id>` filters by it. Pending Review is the built-in
  draft to review to publish hop. [verified]
- **Command palette:** Yes. **Ctrl+K / Cmd+K**, introduced in **6.3** for the post and
  site editors. As of **6.9** ("command palette everywhere") it "exists in any admin
  screen, the Site Editor, and the Post/Page editor," but not on the front end. It
  ships roughly 80 commands including `Go to: Posts > All posts`,
  `Go to: Media > Library`, and `Add new page`, plus searchable individual Pages,
  Posts, Templates, and Template Parts by title. Extensible via
  `wp.data.dispatch(wp.commands.store).registerCommand` or the `wp.commands.useCommand`
  hook; search-dependent results use **command loaders**; commands scope to a
  **context** (`site-editor`, `site-editor-edit`) so contextual commands rank first.
  [verified]
- **Responsive behavior:** Three-stage degradation, verified in
  `wp-admin/css/admin-menu.css`. At **≤960px**, `.auto-fold` collapses the rail to a
  36px icon strip and submenus become flyouts at `left: 36px`. At **≤782px** the rail
  is `display: none` and becomes a 190px absolute overlay toggled by
  `.wp-responsive-open` (a hamburger in the toolbar), and list tables collapse
  columns. Further adjustments at 600px and 480px. [source-verified]
- **Why it works / tradeoffs:** The URL is the application state, so bookmarking, the
  back button, deep links, and handing a view to a colleague all work for free. Status
  counts in the view row answer "what needs my attention" before a click. Quick Edit
  removes most round-trips. Against that: the list table is dated; the flyout submenus
  are fiddly on touch and a standing accessibility complaint; Screen Options and Help
  hide real functionality behind unlabeled hanging tabs; and wp-admin and the site
  editor are two design languages bolted together.
- **Applicability to the NJ PBS admin CMS:** The closest thing to a reference
  implementation for problem 1. The route shape (`edit.php?post_type=X&post_status=draft`
  plus `post.php?post=123&action=edit`) and the status-links-with-counts row
  (`All (12) | Mine (3) | Draft (3) | Pending (1)`) both transfer directly. At a
  Glance plus Activity plus Quick Draft is the model for problem 3.
- **Sources:**
  - <https://wordpress.org/documentation/article/dashboard-screen/>
  - <https://wordpress.org/documentation/article/posts-screen/>
  - <https://wordpress.org/documentation/article/administration-screens/>
  - <https://wordpress.org/documentation/article/site-editor-command-palette/>
  - <https://make.wordpress.org/core/2023/07/17/introducing-the-wordpress-command-palette-api/>
  - <https://developer.wordpress.org/plugins/administration-menus/top-level-menus/>
  - <https://developer.wordpress.org/block-editor/reference-guides/packages/packages-dataviews/>
  - <https://github.com/WordPress/WordPress/blob/master/wp-admin/includes/class-wp-posts-list-table.php>
  - <https://github.com/WordPress/WordPress/blob/master/wp-admin/css/admin-menu.css>

## Ghost admin

- **Nav model:** One left sidebar: Dashboard, Posts, Pages, Tags, Members, Analytics,
  Site, Settings. From `apps/shade/src/components/ui/sidebar.tsx`: expanded
  `SIDEBAR_WIDTH = '300px'`, collapsed `SIDEBAR_WIDTH_ICON = '4rem'`, and the
  collapsed state persists in a `sidebar:state` cookie with a seven-day max age.
  **Cmd/Ctrl+B** toggles it (`SIDEBAR_KEYBOARD_SHORTCUT = 'b'`). The second level is
  saved views nested under Posts, not a second rail. [source-verified]
- **URL/routing:** Hash-routed under `rootURL: /ghost/`: `/ghost/#/dashboard`,
  `/ghost/#/posts`, `/ghost/#/pages`, `/ghost/#/editor/post/:post_id`,
  `/ghost/#/editor/page/:post_id`, `/ghost/#/tags/:tag_slug`,
  `/ghost/#/members/:member_id`, and `/ghost/#/posts/analytics/:post_id/debug`.
  Filters are query params: `PostsController` declares
  `queryParams = ['type', 'visibility', 'author', 'tag', 'order']`, so
  `/ghost/#/posts?type=draft&author=jane&order=updated_at%20desc` is a shareable URL.
  [source-verified] See "Stale and incorrect sources" on the router comment.
- **Dashboard/home:** `/ghost/#/dashboard` plus an **Analytics** section with tabs:
  **Overview** (live "people visiting your site right now"), **Web traffic**
  (**Unique visitors**, **Total views**, **Top sources**), **Newsletters**
  (subscribers, open rate, click rate), **Growth** (total, free, and paid members,
  **MRR**, and a **Top content** table of what drives members and revenue), and
  **Locations**. Ghost's home is business metrics; it will not tell an editor what
  they left half-written. Ghost answers "resume work" with saved views on the Posts
  screen instead. [verified]
- **Content list / library:** A list with filter dropdowns whose exact options are in
  `controllers/posts.js`: **All posts / Draft posts / Published posts / Email only
  posts / Scheduled posts / Featured posts**; **All access / Public / Members-only /
  Paid members-only**; **All authors**; **All tags**; and order **Newest first /
  Oldest first / Recently updated**. Saved views are shipped:
  `services/custom-views.js` defines `DEFAULT_VIEWS` as **Drafts** (`{type: 'draft'}`,
  pen icon), **Scheduled** (`{type: 'scheduled'}`, clock icon), and **Published**
  (`{type: 'published'}`). Users create their own with a `name`, `route`, `color` (from
  nine: midgrey, blue, green, red, teal, purple, yellow, orange, and pink), and a
  `filter`. Saved views render as nested sidebar items under Posts. Bulk actions come
  from shift/cmd/ctrl multi-select plus a right-click context menu: add tags, change
  access, toggle featured, unpublish, and duplicate. [source-verified]
- **List-to-editor relationship:** Full-page route change to
  `/ghost/#/editor/post/:post_id`. Back preserves filters, because they are query
  params. Per-post analytics is reached from a graph icon at the far right of each
  published row, so a list row carries a secondary destination rather than only
  "edit." [verified]
- **Editorial workflow:** Statuses are draft, scheduled, published, and sent
  (email-only). The post settings sidebar holds URL slug, publish date (in the
  publication's timezone), tags, authors (multi-author), excerpt, feature image,
  access tier, template, meta and X card and Facebook card, and per-post code
  injection. Scheduling is native. There is no draft to pending review to published
  state machine: no review assignee, no approval gate. Ghost models a solo or small
  team publishing, not a newsroom desk. [verified]
- **Command palette:** None. Cmd/Ctrl+B toggles the sidebar; no Cmd+K palette is
  documented. [verified]
- **Responsive behavior:** `apps/shade/src/hooks/use-mobile.tsx` sets
  `MOBILE_BREAKPOINT = 801`, matching `(max-width: 800px)`. Below it the sidebar
  becomes an off-canvas sheet at `SIDEBAR_WIDTH_MOBILE = '28rem'`. Ghost concedes the
  admin "has always been fairly limited in what it can do on mobile" and shipped a
  native Android app rather than fix it. [source-verified]
- **Why it works / tradeoffs:** Saved views are the standout. They turn "the filter I
  use every day" into a permanent, named, colored sidebar item, which is the cheapest
  available fix for "I cannot resume my work," and keeping filter state in the URL
  makes those views ordinary links. Against that: the hash routing is a legacy wart;
  the dashboard optimizes for revenue rather than editors; and the workflow model is
  too thin for a desk with an editing step.
- **Applicability to the NJ PBS admin CMS:** The saved-views-as-nested-sidebar-items
  pattern answers problems 2 and 4 at once: the second level becomes "Drafts / Needs
  review / Mine / Scheduled" under each content type instead of a decorative duplicate
  rail. The cookie-persisted collapsible sidebar is also a better fit than a second
  fixed rail.
- **Sources:**
  - <https://github.com/TryGhost/Ghost/blob/main/ghost/admin/app/router.js>
  - <https://github.com/TryGhost/Ghost/blob/main/ghost/admin/config/environment.js>
  - <https://github.com/TryGhost/Ghost/blob/main/ghost/admin/app/controllers/posts.js>
  - <https://github.com/TryGhost/Ghost/blob/main/ghost/admin/app/services/custom-views.js>
  - <https://github.com/TryGhost/Ghost/blob/main/apps/shade/src/components/ui/sidebar.tsx>
  - <https://github.com/TryGhost/Ghost/blob/main/apps/shade/src/hooks/use-mobile.tsx>
  - <https://ghost.org/help/organizing-content/>
  - <https://ghost.org/help/post-settings/>
  - <https://ghost.org/help/native-analytics/>
  - <https://ghost.org/help/post-analytics/>

## Craft CMS

- **Nav model:** One collapsible sidebar holding "the system name and icon, followed
  by the primary navigation": Dashboard, Entries, Assets, Categories, Globals, Users,
  GraphQL, Utilities, Settings, and Plugin Store, subject to config and permissions.
  Nested items "are automatically expanded based on the current screen's URI, or when
  you pick the Open subnavigation toggle," so expansion is context-driven rather than
  a standing second rail. The global header carries breadcrumbs (only "when working
  with structures, nested elements, or settings"), current-screen actions, and the
  user menu. Element indexes then get a secondary nav called **Sources** inside the
  content area. That is the key move: the second level lives in the content pane, not
  as a sibling rail. [verified]
- **URL/routing:** The control panel lives under `/admin`. Entry edit:
  `/admin/entries/{sectionHandle}/{entryId}`, with documented examples
  `/admin/entries/blog/247` and `/admin/entries/exhibits/38`. Index: `/admin/entries`.
  Whether index filter and column state is URL-encoded is **not documented**; Craft
  appears to persist source customization server-side rather than in the query string.
  [verified]
- **Dashboard/home:** A customizable widget dashboard. Shipped widgets: **Support**,
  **Feed**, **Drafts**, **New Users**, **Quick Post**, **Recent Entries**, and
  **Updates**. Widgets "can be rearranged, resized, and customized." Drafts, Recent
  Entries, and Quick Post carry the same instinct as WordPress's Activity and Quick
  Draft: home is where unfinished work is re-entered. [verified]
- **Content list / library:** Element indexes. **Sources** sit in a left secondary nav,
  either permanent, config-derived, or **custom sources defined by admins using
  condition rules** and stored in project config. Each source "controls what columns
  are visible in the index, and its default sorting." A **View** menu lets each user
  customize visible columns and ordering. Table view and card view are both available;
  cards show thumbnails, titles, and statuses plus custom card attributes. A
  **condition builder** on every element index can "temporarily filter results,"
  alongside full search. Status renders as "color pips and labels": Draft, Archived,
  Disabled, and Enabled, plus an **Edited** chip for provisional drafts. Bulk actions:
  common ones such as **Status** sit in the toolbar and the rest collect under a gear
  icon, hiding or disabling based on selection. **Export…** supports CSV, JSON, XML,
  XLSX, and YAML. [verified]
- **List-to-editor relationship:** Both, deliberately. Double-clicking an element chip
  opens a **slideout**, a "simplified or contextualized" edit panel that keeps you on
  the index; slideouts open from other slideouts, and an icon pops one into a new
  window. Full edit screens are the other path and carry extra actions under an
  ellipsis menu. In modal and relational-field contexts a stripped index appears with
  sources and slideouts disabled. [verified]
- **Editorial workflow:** The strongest drafting model of the seven. Statuses are
  computed rather than flagged: **Live** (post date past, expiry future), **Pending**
  (post date future or unset), **Expired** (expiry date past), and **Disabled**
  (toggled off globally or per site). Scheduling is Post Date plus Expiry Date.
  **Provisional drafts**: "As soon as you arrive on an edit screen (for new entries) or
  make any kind of edit (to an existing entry), Craft creates a provisional draft and
  begins autosaving." They are user-specific and badged **Edited** across the whole
  control panel. **Create draft** turns edits into a named draft "so other users can
  review them," which is the review hop. **Edit draft settings** names drafts so
  collaborators can tell them apart. **Save** applies the draft to canonical and cuts a
  revision; revisions are reachable from the breadcrumb menu with **View** and **Revert
  content from this revision**, and reverting saves current state as a new revision
  rather than rewinding. **View** generates "a private, temporary (but sharable) URL"
  for unpublished content. [verified]
- **Command palette:** Core has none. A palette exists only as third-party plugins
  (`Command Palette`, `amcommand`, `Palette`) on **Ctrl/Cmd+Shift+P**. Core ships
  discrete shortcuts only: **Cmd+S** (save), **Cmd+Shift+S** (save and create
  another), and **Shift+Click** (range-select checkboxes). [verified] See "Stale and
  incorrect sources."
- **Responsive behavior:** The sidebar collapses and sources are reachable via skip
  links, but a narrow-screen breakpoint spec is **not documented**.
- **Why it works / tradeoffs:** Two things stand out. Sources are the second nav level
  and they live inside the content area, so there is exactly one rail, and admins can
  author new sources from condition rules, making a saved view a configurable object
  rather than a per-user bookmark. Provisional drafts plus the Edited chip mean
  unfinished work cannot be lost and is visible from the index, which is exactly the
  "resume a specific piece of work" problem. Against that: slideouts within slideouts
  get disorienting; the concept count (sections, entry types, sources, drafts,
  revisions, provisional drafts) is high; and there is no core palette.
- **Applicability to the NJ PBS admin CMS:** Sources are the cleanest answer to
  problem 2: one app sidebar, with content-type and saved-view choice rendered inside
  the library pane adjacent to the results they filter. Provisional drafts plus an
  "Edited" chip would let the library itself show which items have unsaved work
  waiting, which is problem 4 and problem 5 together.
- **Sources:**
  - <https://craftcms.com/docs/5.x/system/control-panel.html>
  - <https://craftcms.com/docs/5.x/system/elements.html>
  - <https://craftcms.com/docs/5.x/reference/element-types/entries.html>
  - <https://craftcms.com/docs/5.x/system/drafts-revisions.html>
  - <https://craftcms.com/docs/getting-started-tutorial/configure/editing.html>
  - <https://plugins.craftcms.com/command-palette>
  - <https://github.com/am-impact/amcommand>

## Statamic

- **Nav model:** One control-panel sidebar, customizable for editors: Dashboard,
  Collections, Navigation, Taxonomies, Assets, Globals, Users, Utilities, and
  Settings. There is a configurable start page (`StartPageController` on `/cp/`), so
  `/cp` can land a team on the screen that matters to them rather than a fixed
  dashboard. [source-verified]
- **URL/routing:** Clean REST paths under `/cp`, from `routes/cp.php`: `/cp/` (start
  page), `/cp/dashboard`, `/cp/collections`,
  `/cp/collections/{collection}/entries` (listing),
  `/cp/collections/{collection}/entries/create/{site}` (new),
  `/cp/collections/{collection}/entries/{entry}` (edit),
  `/cp/collections/{collection}/entries/{entry}/revisions`,
  `/cp/collections/{collection}/entries/{entry}/preview`,
  `/cp/collections/{collection}/tree` (structured or orderable collections), and
  `/cp/taxonomies/{taxonomy}/terms`. One detail worth copying:
  `/cp/collections/{collection}/entries/{entry}/{slug}` exists purely to redirect to
  the canonical `editUrl()`, so slug-bearing links stay valid and normalize
  themselves. [source-verified]
- **Dashboard/home:** "A customizable area where you can add widgets for things you
  care about: recent entries, scheduled content, form submissions, updates,
  shortcuts, and more." Work-resumption widgets, not account administration.
  [verified]
- **Content list / library:** Entry listings per collection. Columns are config rather
  than code: add a `columns` array to the collection's YAML (defaults are "sensible…
  like title, slug, and date"), with a nested array form for per-column control, and
  blueprint fields can be hidden from listings. Default sort via `sort_by` and
  `sort_dir`, defaulting to Title, though "Order will take precedence" for structured
  collections. Filters are a first-class extensible class: a `Filter` extends `Scope`
  with `fieldItems()` ("lets you define which filter fields will be displayed, just
  like a field inside a Blueprint"), `apply()`, `badge()` ("the badge text to be used
  when the filter is active on a listing"), `visibleTo()` (scope a filter to certain
  listings), `autoApply()` (defaults), and a `$pinned` property to "pin your filters to
  the filters bar." Saved filters ship: "you can save & reuse simple or advanced
  filters." Bulk actions run through `collections/actions` and
  `collections/actions/list`. Structured collections get a drag-and-drop tree UI when
  "Orderable" is on. [verified]
- **List-to-editor relationship:** Full-page navigation to the **Publish** form at
  `/cp/collections/{collection}/entries/{entry}`: "When creating or editing content
  (entries, pages, etc), you are presented with a form view. This is what we call the
  'Publish' form." Live Preview is available from it, including a `preview.popout` GET
  route for a standalone window. [verified]
- **Editorial workflow:** Entries carry a `published` boolean, but Statamic computes a
  derived `status` with four values: **published**, **scheduled**, **expired**, and
  **draft**. The docs explicitly recommend filtering "against your entry's `status`
  (instead of its `published` boolean)" so date logic is respected automatically.
  Publish and unpublish are dedicated routes. Dated collections get `date_behavior`
  controlling past and future visibility: **public** (visible in listings and at
  URLs), **unlisted** (hidden in listings, available at URLs), and **private** (hidden,
  404). Revisions ("see the history of any given entry over time") are opt-in site-wide
  and per collection, with index, store, and show routes plus a `restore-revision`
  action. Scheduling needs the Laravel scheduler wired up for cache invalidation.
  [verified]
- **Command palette:** Yes, in core, and the best-integrated of the seven.
  **Cmd+K / Ctrl+K**: "a quick way to navigate around the control panel, jump right
  into editing specific entries, and run actions without clicking through menus." It
  offers content search, control-panel navigation, **recently visited pages**,
  "intelligent page-specific and contextually relevant actions," documentation links,
  and user preferences and theme switching. Categories: Actions (top priority),
  Miscellaneous, and Recent. Extensible from PHP with
  `CommandPalette::add(text: 'Staff Calendar', url: '/route', icon: 'calendar')`, from
  JS via `Statamic.$commandPalette.add()` with `action` callbacks, `when()` visibility
  predicates, `category`, `prioritize`, and `trackRecent`, or declaratively with a
  `<ui-command-palette-item>` Vue component. [verified]
- **Responsive behavior:** Not documented.
- **Why it works / tradeoffs:** The closest match to the NJ PBS problem shape. The
  palette's recently-visited-pages plus contextual actions is a direct answer to "no
  way to resume a specific piece of work." The derived four-value `status` is a better
  primitive than a raw boolean and is what a status column needs. The slug-redirect
  route is a small craft detail worth copying. Against that: config-file-driven columns
  and filters mean editors cannot self-serve a new view without a developer, the
  inverse of Ghost's user-created saved views; and responsive behavior is undocumented.
- **Applicability to the NJ PBS admin CMS:** The Cmd+K palette with recents and
  contextual actions is the fastest path back into a specific in-progress item and
  substitutes for a lot of navigation. The derived-status approach supports the
  lifecycle enum (see "Technical design considerations" below).
- **Sources:**
  - <https://github.com/statamic/cms/blob/master/routes/cp.php>
  - <https://statamic.dev/control-panel/overview>
  - <https://statamic.dev/control-panel/command-palette>
  - <https://statamic.dev/collections>
  - <https://statamic.dev/extending/query-scopes-and-filters>
  - <https://statamic.dev/control-panel/publish-forms>
  - <https://github.com/statamic/cms/discussions/5563>

## Prismic

- **Nav model:** The Page Builder has three tabs at the top: **Work** (drafts and
  published pages), **Planned** (releases scheduled for publication), and **Archived**
  (unpublished pages, removed from the API but still stored). Organization is by
  **spaces** (grouping pages by type) and **tags**. Tabs rather than a rail: a flat,
  one-level model. [verified]
- **URL/routing:** Repository-scoped under `https://<your-repo-name>.prismic.io/`. The
  API Explorer is documented at `https://<your-repo-name>.prismic.io/builder/explorer`,
  confirming a `/builder/*` namespace for the authoring app. Documents carry both an
  `id` (for example `PSachREAACIArDB1`) and a **UID** (unique per type, which sets the
  page's public URL). The per-document Page Builder URL is **not documented**: the docs
  say "Entering a Prismic repository will show you a list of all the documents…
  Selecting a document brings you to the page editor screen" without publishing the
  route. [verified]
- **Dashboard/home:** There is no separate dashboard. The document list is the home
  screen: you land in the Main Space showing "a page view of all the pages existing in
  your master locale," with results "sorted by most recently modified on top." That
  default sort is the whole resume-work affordance, and it is a defensible minimal
  answer: no widgets, but the first thing you see is what you last touched. [verified]
- **Content list / library:** A page list plus a filter bar with "dropdown menus to
  filter by page type, language, status, or tags," combinable. Text search over page
  titles. Rows show display name, page type, and status. Three statuses: **Draft**
  ("Unpublished changes exist"), **Live** ("Published on your website"), and
  **Archived** ("Hidden from main view but not deleted"). Bulk operations on
  multi-select: publish, archive, delete, unarchive, and copy to locale. [verified]
- **List-to-editor relationship:** Full-page navigation into the Page Builder, laid out
  in three columns: a left sidebar of live preview thumbnails per slice, a middle
  column of editable fields and slice management, and a right sidebar for version
  control and localization. Custom display names are set in the top-left corner. Slices
  are added via **Add slice**, reordered by dragging, and manipulated with **Copy**,
  **Paste**, and **Delete**. [verified]
- **Editorial workflow:** **Save** keeps a draft ("visible only to you and other
  editors… won't appear on your live website"); **Publish** makes it live. **Preview
  the page** renders the site with draft content and generates shareable preview links
  via a Prismic toolbar. The distinctive part is **Releases**: bundles of multi-page
  changes published atomically, created from the **Planned** tab via **Add Release**,
  or from a page via the calendar icon next to **Publish** ("Create a new release" /
  "Add to existing release"). You can also **Create a new page** directly inside a
  release. Each release shows "Not scheduled yet" or its scheduled date and time. Hard
  cap: 200 pages per release. Publishing is permission-gated: "Only Publishers,
  Administrators, and Repository Owners can publish content." There is no draft to
  pending review to published state machine; the gate is a role check at publish time,
  not a review state. [verified]
- **Command palette:** None. Cmd+K in Prismic is the rich-text editor's "create a
  link" binding, not a palette. [verified]
- **Responsive behavior:** Not documented.
- **Why it works / tradeoffs:** Two ideas transfer. Most-recently-modified as the
  default sort on the landing screen is the cheapest possible resume-work feature and
  needs no widgets. Releases model coordinated multi-page publishing, which a station
  site genuinely needs (a schedule change, a rebrand, or a pledge drive touching six
  pages at once) and which per-item scheduling cannot express. Against that:
  Draft/Live/Archived is a thin status vocabulary with no review state; permission-gated
  publish is a blunt substitute for workflow; and the undocumented editor route is a
  real smell.
- **Applicability to the NJ PBS admin CMS:** Most-recently-modified default sort on the
  library is a zero-cost partial answer to problem 3 and problem 4. Releases are worth
  evaluating if NJ PBS needs to publish a coordinated set of pages (schedule changes,
  pledge drives) at one moment.
- **Sources:**
  - <https://prismic.io/docs/organize-pages>
  - <https://prismic.io/docs/create-pages>
  - <https://prismic.io/docs/guides/draft-plan-and-schedule-content>
  - <https://prismic.io/docs/guides/schedule-publishing>
  - <https://prismic.io/docs/fields/uid>
  - <https://prismic.io/docs/content-api>
  - <https://community.prismic.io/t/rich-text-keybinding-and-shortcuts/8558>

## Storyblok

- **Nav model:** A left sidebar per space: **Content**, Assets, Components, and
  Settings, with **Tags** as a sidebar option. Space-scoped: pick a space, then work
  inside it. [verified]
- **URL/routing:** A hashbang single-page app. Storyblok's own docs reference
  `app.storyblok.com/#!/me/account`, using `#!` rather than a plain `#`. The per-story
  deep-link route is **not documented**: a grep of Storyblok's entire public docs repo
  (`storyblok/storyblok-docs`) finds `#!/me/account` as the only app route documented
  anywhere in it. [source-verified]
- **Dashboard/home:** A **Space Dashboard** exists as a listed user-manual section, but
  its contents are **not documented** in the reachable pages.
- **Content list / library:** The **Content** section: "search, filter, and sort
  stories; organize them with folders and tags; and mark them as favorites." The
  **Search** field matches name, slug, or content type, with `"exact search"` (double
  quotes) for exact matches. The **Filter** dropdown does advanced searches with
  saveable filter combinations, including a **Contains Content Item** filter to find
  stories referencing another story (for example, all posts by an author), a
  relational filter the others lack. The **Sort** dropdown orders by dates, names, or
  slugs. A **Favorite** button sits at each row's end. **Folders** give hierarchy (move
  via **Settings → Parent folder**, or multi-select plus **Move**). **Tags** cut across
  folders, are applied from the toolbar, and are browsable via **Tag List**. Bulk
  actions: the topmost checkbox selects all visible; the toolbar exposes **Move**,
  **Tag**, and others. Four statuses with distinct indicators: **unpublished** (gray
  vertical semicircle inside a solid circle), **published** (green solid circle inside
  a solid circle), **changed** (horizontal green semicircle in a dashed circle), and
  **scheduled**. The **changed** state, meaning published with unpublished edits
  pending, is a distinction most of these tools lack. [verified]
- **List-to-editor relationship:** "Select any story from the Content section… and open
  it in the Visual Editor." The Visual Editor is a true split view: a **Form/Visual**
  toggle in the left toolbar hides and reveals a draft-rendered preview, and clicking
  any part of the preview "will open up the corresponding Content Block in a new panel
  on the right side of your screen." Preview at **Desktop**, **Mobile**, or
  **Full-width**; **Open preview** pops a standalone tab. [verified]
- **Editorial workflow:** The most explicit workflow engine of the seven. The default
  workflow ships three stages, **drafting**, **reviewing**, and **ready to publish**,
  applied to all content types and folders. Configured at **Settings → Workflows**:
  click the **Default** workflow to edit stages, add stages, or reorder them by
  drag-and-drop. Each stage requires "a name, a color, user rights (including the
  rights to advance or publish a story), and the available next stages," which is a
  permissioned state machine with an explicit transition graph rather than a status
  enum. Stages appear in a **Workflow** section within stories, supporting assignment
  of users or roles with optional due dates, and integrate into folder and story
  settings via **Workflow Settings**. Multiple custom workflows are a premium feature
  (**Settings → Workflows → Add Workflow**). **Releases** group content changes for
  scheduled publishing (**+ New release** in Content, then name plus release date and
  time, then **Save**). The Content list filters by **Scheduled Stories**. [verified]
- **Command palette:** None as of 2026-02-17. Storyblok had **Spotlight**
  (⌘+K / Ctrl+K, or **Quick Search** in the bottom sidebar) for universal search across
  stories, assets, and documentation. Their changelog states: "Effective **17-02-2026**,
  the Spotlight feature has been removed from the Storyblok app as part of ongoing
  product updates." No replacement is named. [verified] See "Stale and incorrect
  sources."
- **Responsive behavior:** Not documented.
- **Why it works / tradeoffs:** The workflow model is the reference design for problem
  5: named stages, per-stage user rights, an explicit allowed-next-stages graph,
  assignee, and due date, all configured in the UI rather than in code. The **changed**
  status and the **Contains Content Item** relational filter are both smart. Against
  that: custom workflows are paywalled; the hashbang routing and undocumented story
  routes make deep-linking a guess; and they removed their command palette, which is a
  useful data point that a palette is not automatically a win.
- **Applicability to the NJ PBS admin CMS:** The stage-as-data model (name, color, who
  may advance, who may publish, allowed next stages, assignee, due date) is the shape a
  newsroom desk needs. The **changed** status complements a lifecycle enum: see
  "Technical design considerations" below.
- **Sources:**
  - <https://www.storyblok.com/docs/manuals/workflows>
  - <https://www.storyblok.com/docs/guide/in-depth/content-authoring>
  - <https://www.storyblok.com/docs/manuals/content-authoring>
  - <https://www.storyblok.com/docs/manuals/spotlight> (the removal notice)
  - <https://www.storyblok.com/docs/guide/essentials/spotlight>
  - <https://www.storyblok.com/docs/manuals/visual-editor>
  - <https://www.storyblok.com/docs/manuals/spaces>
  - <https://www.storyblok.com/cl/introducing-workflow-stages>
  - <https://github.com/storyblok/storyblok-docs>

## Kirby

- **Nav model:** One Panel sidebar, declaratively configured in `config.php`. The
  `panel.menu` option takes an ordered array supporting labels, icons, arbitrary
  links, and `'-'` separators:

  ```php
  'panel' => ['menu' => [
      'site' => ['label' => 'Overview'],
      'notes' => ['icon' => 'pen', 'label' => 'Notes', 'link' => 'pages/notes'],
      '-',
      'users'
  ]]
  ```

  Defaults are Site, Users, Languages, and Account, plus a **Changes** item. Note
  `'link' => 'pages/notes'`: a deep link to a specific content branch can be pinned
  directly into the nav, which collapses "app rail plus content-type rail" into one
  authored list. [verified]
- **URL/routing:** The Panel base defaults to `/panel`, relocatable via
  `'panel' => ['slug' => 'super-secret-admin-area']`. `Panel\Model::url()` returns
  `kirby()->url('panel') . '/' . $this->path()`, and `Panel\Page::path()` returns
  `'pages/' . $this->id()`. `Panel\Page::id()` carries the docblock "Returns the
  escaped Id, which is used in the panel to make routing work properly" and its body is
  `str_replace('/', '+', $this->model->id())`. So a page at `notes/a-note` has the
  Panel URL `/panel/pages/notes+a-note`: slashes become `+` so a nested content path
  stays a single flat route segment. Every page, file, and user has a stable,
  addressable Panel URL. Separately, **UUIDs** (`page://Eesj89FnbMzMMvs0`) and
  **permalinks** (`https://example.com/@/page/hb38HvnQfm8HlQ6e`, always prefixed with
  `@`) give identifiers that survive renames and moves. [source-verified]
- **Dashboard/home:** The Panel dashboard is the **Site blueprint**
  (`/site/blueprints/site.yml`), so the home screen is authored from the same sections
  primitive as every other screen rather than a special widget system. Anything that
  can go on a page view (a pages list filtered to drafts, a recent-files list,
  arbitrary info) can go on the home screen. There is no fixed widget set. [verified]
- **Content list / library:** The **pages section**, with four layouts: `list` (default;
  "perfect for more text-heavy pages, like articles, link lists, simple pages"),
  `cards` ("great for media-heavy pages, like galleries, products, projects"),
  `cardlets` ("great for nice visual previews of files, while your text content is
  still represented decently"), and `table` ("the highest information density. Columns
  can be fully customized… perfect if you need to show multiple values at once for
  better overview and scannability"). Filter by `status`: `draft`, `listed`,
  `unlisted`, `published`, or `all`. `search: true` is **off by default**, a real
  papercut. `sortBy` (for example `date desc`), `flip: true` to reverse, and `sortable`
  for manual drag-and-drop. `limit` (default 20) with pagination at the section foot,
  plus `min` and `max` constraints. Table columns are keyed by field name with `label`,
  `align`, `width`, `value` templates, `type`, and a `mobile` visibility flag. `info`
  adds supplementary per-row data, `text` (default `'{{ model.title }}'`) sets the
  primary label, and `empty` customizes the no-results message. The **Add** button
  appears only with `status: draft` or `status: all`, because "new pages are always
  added as draft" and otherwise the new page would not appear in the section, which
  "would lead to a confusing interaction for editors." Suppressing an affordance whose
  result would be invisible is a nice bit of craft. [verified]
- **List-to-editor relationship:** Full-page navigation to `/panel/pages/{escaped-id}`.
  Multiple pages sections can coexist on one screen, arranged in tabs and columns via
  the blueprint, so a library screen can show Drafts, In review, and Published as three
  sections side by side with no routing at all. [verified]
- **Editorial workflow:** Statuses are **draft** (in the `_drafts` folder, visible only
  to logged-in users or via a secret draft link), **unlisted** (published, no sorting
  number, reachable by URL but excluded from sorted lists), and **listed** (published
  with a sort number). Publish via the **Draft** button with its red status icon, or
  **Settings → Change status**, and Kirby only allows publication when all required
  fields are complete and validations pass. Kirby 5 added a versioning model:
  `$page->version('changes')` alongside `latest`, with `->content()`, `->save([...])`,
  `->publish()`, and `->delete()`. An "unsaved changes" form-control bar sits at the top
  of the view with save and discard plus an info dropdown describing what changed. The
  **changes view** does side-by-side comparison or a full-width preview of changed
  versus published, and the preview URL is shareable: "share the URL for the preview of
  the unpublished changes with other editors and people in their team to get feedback."
  A **Changes dialog** (via the **Changes** sidebar item) lists all changes by everyone,
  grouped by type (page, user, file), letting you jump to and preview a teammate's
  unsaved work. Content locking prevents two editors overwriting each other, shows who
  is editing, auto-unlocks after inactivity, and warns if changes were overwritten.
  There is no formal pending-review state: the review mechanism is the shareable
  preview link. [verified]
- **Command palette:** None. An open feature request to bind Cmd+K to the Panel search
  (kirby.nolt.io/511) reportedly conflicted with the textarea field's shortcuts and was
  reverted. [verified]
- **Responsive behavior:** Weak, and partly acknowledged. The pages-section table
  layout has a per-column `mobile` flag to choose which columns survive on narrow
  screens, which is a good primitive. But getkirby/kirby#5380 reports that the v4 Panel
  sidebar "does scroll with page contents on mobile," and #284 is a long-running request
  to switch the Panel to a top nav bar. Treat Kirby's Panel as desktop-first.
  [verified]
- **Why it works / tradeoffs:** Kirby's insight is that the admin UI is authored
  content: sections, columns, and tabs compose every screen including the dashboard, so
  "library view" and "home screen" are the same primitive configured twice. That fits
  well if editors' screens should differ per content type. The shareable
  unsaved-changes preview URL is the best answer here to "review and preview connect to
  nothing," because it makes review a link rather than a state to model.
  Validation-gated publishing is a good guardrail. Against that: search is off by
  default; there is no palette; mobile is unfinished; and the `/` to `+` escaping is
  clever but ugly.
- **Applicability to the NJ PBS admin CMS:** The shareable preview-of-unsaved-changes
  URL is the highest-leverage item in this scan for problem 5. For a station where an
  editor needs sign-off from someone who will not log into the CMS, that link is the
  review workflow, and it costs far less than an approval state machine.
  Validation-gated publish is also the natural enforcement point for alt text given the
  WCAG 2.1 AA obligation: server-side validation can enforce required alt text
  consistently across editing clients.
- **Sources:**
  - <https://github.com/getkirby/kirby/blob/main/src/Panel/Page.php>
  - <https://github.com/getkirby/kirby/blob/main/src/Panel/Model.php>
  - <https://getkirby.com/docs/reference/panel/sections/pages>
  - <https://getkirby.com/docs/reference/system/options/panel>
  - <https://getkirby.com/docs/guide/content/publishing-workflow>
  - <https://getkirby.com/docs/guide/blueprints/introduction>
  - <https://getkirby.com/docs/guide/uuids>
  - <https://getkirby.com/releases/5>
  - <https://getkirby.com/releases/5/changes>
  - <https://kirby.nolt.io/511>
  - <https://github.com/getkirby/kirby/issues/5380>
  - <https://github.com/getkirby/kirby/issues/284>

---

## Cross-cutting patterns, mapped to the evaluation questions

### 1. URL-addressable everything

Six of seven make content items addressable. The split is in how much state lives in
the URL. WordPress is maximal: status, author, category, date, sort, and pagination are
all GET params, so every view is a link. Ghost puts filters in query params
(`queryParams = ['type', 'visibility', 'author', 'tag', 'order']`) but hides them behind
a hash. Statamic and Craft use clean REST paths but do not document filter state in the
URL. Prismic and Storyblok do not document their editor routes at all.

The floor to hit: item routes (`/content/{type}/{id}/edit`) plus list-filter state as
query params. That one decision returns bookmarking, the back button, and resume-work at
the same time.

### 2. Navigation hierarchy

No product in this set ships two sibling vertical rails. There are four escapes, all
useful options for a dense admin interface:

- **WordPress:** the second level is a hover flyout off the single rail, costing no
  permanent width.
- **Craft:** the second level is **Sources**, rendered inside the content pane next to
  the results it filters, and admins can author new sources from condition rules.
- **Ghost:** the second level is **saved views nested under Posts** in the one sidebar,
  each with a name, color, and filter.
- **Kirby:** the single nav is hand-authored in config and can pin deep links
  (`'link' => 'pages/notes'`) straight to a content branch.

The unifying principle: a second rail reads as decoration when it is adjacent to the
first rather than subordinate to it, or adjacent to its own results. Move it inside the
content pane (Craft) or nest it in the first (Ghost).

### 3. Home screens that resume work

The tools that get this right lead with unfinished work rather than account state.
WordPress: At a Glance plus Activity (scheduled, recently published, recent comments)
plus Quick Draft, which also lists your five most recent drafts. Craft ships **Drafts**,
**Recent Entries**, and **Quick Post** widgets. Statamic: "recent entries, scheduled
content, form submissions, updates, shortcuts." Prismic skips the dashboard entirely and
sorts the document list most-recently-modified first, the cheapest version of the same
idea and a viable first move. Ghost is the counterexample: its dashboard is revenue and
traffic, and it compensates with saved views elsewhere.

No tool in this set leads with roles, permissions, or billing.

### 4. Content library

Universal: a list with status columns, filters, search, and sort. Bulk actions are in six
of the seven; Kirby's pages section documents no bulk mechanism. The differentiators
worth copying:

- **Status counts inline in the view row** (WordPress: `All (12) | Mine (3) | Draft (3)
  | Pending (1)`), which answers "what needs me" before a click.
- **A "Mine" view** (WordPress `edit.php?post_type=post&author=<id>`): shipped, trivial,
  and directly relevant here.
- **Saved views as durable named objects.** Ghost (per-user, colored, in the sidebar)
  and Craft (admin-authored sources in project config) approach this from opposite ends.
  Ghost's is the one editors can create themselves.
- **Multiple layouts.** Kirby's four (`list`, `cardlets`, `cards`, `table`) and
  WordPress DataViews' six, with DataViews' `list` layout designed as a side-by-side
  sidebar for a detail view.
- **Craft's `Edited` chip** on rows with an unsaved provisional draft, so the library
  itself shows where you left off.
- **Storyblok's `changed` status**: published and has pending edits. Most tools cannot
  express this.

### 5. Editorial workflow, ranked

- **Storyblok** (most complete): stages as data, with name, color, user rights to
  advance versus publish, allowed next stages, assignee, and due date, configured in
  **Settings → Workflows** rather than in code.
- **Craft** (best drafting): provisional drafts plus autosave plus the **Edited** chip
  plus named drafts via **Create draft** "so other users can review them" plus revisions
  with **Revert content from this revision** plus shareable private preview URLs.
- **Kirby** (best review without a workflow engine): Kirby 5's `version('changes')` plus
  the unsaved-changes bar plus a shareable preview URL for unpublished changes plus a
  team-wide **Changes** dialog plus content locking plus validation-gated publish.
- **WordPress** (best baseline): `draft → pending → publish/future/private`, status
  surfaced in three places at once, native scheduling, revisions, and author-as-assignee.
- **Statamic**: a derived `status` enum (published, scheduled, expired, draft), with the
  docs explicitly directing you to filter on `status` rather than `published`.
- **Prismic** and **Ghost** (thinnest): no review state. Prismic gates publish by role;
  Ghost has draft, scheduled, published, and sent.

### 6. Command palettes

Two ship one in core, and one just removed theirs:

- **WordPress**: Cmd/Ctrl+K since 6.3, and as of **6.9** on every admin screen. Roughly
  80 commands, searchable posts and pages by title, extensible with contexts and loaders.
- **Statamic**: Cmd/Ctrl+K with recently visited pages and "intelligent page-specific and
  contextually relevant actions," the most directly relevant design for resuming a
  specific piece of work.
- **Storyblok**: had **Spotlight** (⌘+K); removed effective **2026-02-17**, with no
  replacement named.
- **Craft**: core has only Cmd+S, Cmd+Shift+S, and Shift+Click. A palette exists only as
  plugins (Ctrl/Cmd+Shift+P).
- **Ghost**, **Prismic**, **Kirby**: none.

Read: a palette accelerates an admin that already works, and does not substitute for
routing and a library. Storyblok removed theirs and Ghost never had one, and both remain
usable because their lists and saved views carry the load. Build the routes and the
library first.

### 7. Responsive

Weak across the board and mostly undocumented (Craft, Statamic, Prismic, and Storyblok
are all **not documented**). The two verified implementations:

- **WordPress**: three stages. At ≤960px `.auto-fold` gives a 36px icon rail with
  flyouts at `left: 36px`; at ≤782px the rail hides and becomes a 190px overlay via
  `.wp-responsive-open`; further tweaks at 600px and 480px.
- **Ghost**: `MOBILE_BREAKPOINT = 801`; the sidebar runs 300px, then a 4rem icon rail,
  then a 28rem off-canvas sheet below 801px, with collapsed state in a `sidebar:state`
  cookie (seven-day max age) and Cmd/Ctrl+B to toggle.

Kirby offers a per-column `mobile` flag in table layouts but has an open bug where the v4
sidebar scrolls with page content on mobile. Ghost concedes its admin "has always been
fairly limited… on mobile" and shipped a native Android app instead. If NJ PBS needs real
mobile admin, there is no strong prior art here to copy; WordPress's three-stage
degradation is the best available reference.

---

## Stale and incorrect sources

Three places where the obvious source is wrong or stale, all checked against code. Any
future scan should not re-derive these the hard way.

1. **Ghost's `router.js` comment is wrong.** It reads "use HTML5 History API instead of
   hash-tag based URLs," but `config/environment.js` sets `locationType: 'trailing-hash'`
   for everything except tests, which override it to `'none'`. Production Ghost admin is
   `/ghost/#/posts`, not `/ghost/posts`.
2. **Craft has no core command palette.** Several blog posts describe one at
   Ctrl/Cmd+Shift+P. That is the third-party `Command Palette` plugin, not core.
3. **Storyblok Spotlight is gone** as of 2026-02-17. Any writeup recommending it as prior
   art predates the removal.

## Not documented

Recorded as gaps rather than guesses:

- Prismic's per-document Page Builder route.
- Storyblok's per-story route. A grep of `storyblok/storyblok-docs` finds
  `#!/me/account` as the only app route documented anywhere in the repo.
- Storyblok's Space Dashboard contents.
- Responsive specs for Craft, Statamic, Prismic, and Storyblok.
- Whether Craft encodes element-index filter and column state in the URL.

## Technical design considerations

This scan provides prior art for the existing editorial behavior:

- **The lifecycle enum is** `draft | in_review | scheduled | published |
  archived` in `site/src/lib/editorial-workflow.ts`. The landscape corroborates it. Statamic's derived
  four-value `status` and WordPress's six-status model both support the choice of a
  computed enum over a `published` boolean, and Statamic's docs explicitly direct
  filtering on `status` rather than the boolean. `in_review` matches WordPress's
  `pending` and Storyblok's `reviewing`. Nothing here argues for a different enum.
- **Pending changes can be represented separately.** Storyblok's **changed** state
  means published content with unpublished edits. Craft expresses the same idea
  as an **Edited** chip driven by a provisional draft. A derived pending-changes
  indicator can complement the lifecycle enum, using the before/after diffs
  stored in `cmsVersionHistory`.
- **Preview.** Kirby's shareable unsaved-changes preview URL and Craft's "private,
  temporary (but sharable) URL" offer approaches for signed, temporary previews.
- **Publish gating.** Kirby's validation-gated publish (publication blocked until
  required fields validate) can enforce required alt text before publication.
- **The dashboard.** No product in this set leads its home screen with roles,
  permissions, or billing, and four of the seven lead with unfinished work instead. Ghost
  leads with revenue, Kirby ships no fixed widget set, and Storyblok's dashboard is not
  documented.
