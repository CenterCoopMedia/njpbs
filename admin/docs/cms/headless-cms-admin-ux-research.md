# Headless CMS admin UX research

Research into how five headless and API-first CMS products structure their admin
and editing experience, gathered to inform the NJ PBS newsroom admin redesign
(see the admin design).

Products covered: Sanity Studio, Contentful, Payload CMS, Strapi, Directus.

Every finding below is sourced to a live URL. Where a behavior could not be
confirmed from documentation it is marked "not documented" rather than guessed.

## Why this research exists

Five evaluation questions guide the comparison:

1. Can editors bookmark, navigate back to, and resume a specific item?
2. Does the navigation communicate one clear hierarchy?
3. Does home help editors resume work?
4. Can editors browse, search, filter, and reopen content?
5. Do save, review, preview, and publish form a coherent workflow?

The [cross-cutting notes](#cross-cutting-notes-mapped-to-the-evaluation-questions) at
the end map the findings back to these five.

---

## Sanity Studio

**Nav model.** One axis. v3 deliberately deleted the left sidebar: "we moved the
global navigation from the left sidebar and merged it together with search along
the top of the screen. This is a common pattern, and we wanted to simplify things
by only using one axis. It takes less screen real estate and is highly
responsive." Below that top bar, the structure tool is a horizontal set of
collapsible panes: document type list, document list, document editor. Child
panes open to the right of their parent. Depth reads left to right, not as a
second rail.

**URL/routing.** Panes are the URL. Each pane is an ID, and IDs are
semicolon-separated path segments under `/structure/`. `book;game-of-thrones` is
the `book` type list, then the document `game-of-thrones`. The root node's child
resolver receives `book` and returns the type list; that list's child resolver
receives `game-of-thrones` and returns the editor pane. The docs are explicit:
"Most states within the structure are represented in the URL bar." Navigation
between surfaces uses intents (`edit`, `create`) with `{id, type}` params via the
`IntentLink` router component. Custom `.child()` resolvers must declare
`canHandleIntent` or Studio cannot route a search result or an "Open in Studio"
deep link to the right pane.

**Dashboard/home.** Two separate things. In-Studio there is an optional Dashboard
tool plugin (widget grid). Separately, the org-level Sanity Dashboard is the hub:
left sidebar with org switcher, Home, Notifications, Favorites, Content Agent; an
application nav listing Studios, Canvas, Media Library, and custom apps
(pinnable); account area bottom-left. Home shows "links to your most likely
destinations, favorites, and insights about your content." The redesigned
homepage surfaces "widgets to help you jump back into relevant parts of your
workflow; such as new notifications, releases and the most recent studios and
apps that you have been working in."

**Content list / library.** The document list pane, with contents defined by the
developer in structure builder, not by the editor. `defaultOrdering()` adds sort
options to the pane menu. There is no editor-facing ad-hoc filter builder;
filters are baked in as GROQ in the structure config. This is a known complaint:
issue #4950 states "the three-panel view is very restrictive regarding the
search, filter, and sort functionality," and `menuItem()` actions have no way to
dynamically update the parent list's filter.

**List-to-editor relationship.** Neither modal nor full-page nav. The editor is
another pane opened to the right of the list, in the same view. The list stays
visible. You go back by clicking the parent pane or collapsing it. The URL grows
a segment.

**Editorial workflow.** No built-in draft to review to published state machine.
Draft and published are two separate documents (`drafts.<id>` vs `<id>`), and
saving is automatic and continuous. Everything else is the Document Actions API
(`config.document.actions`), which receives `DocumentActionProps` (document ID,
type, current draft, published state). Scheduled publishing was a plugin,
deprecated at v3.39.0 and moved into core: from a draft, open the "..." menu next
to the publish button, then Schedule Publish, then pick a date and time. Content
Releases (paid Enterprise) coordinates multi-document publishing: calendar icon
in the top toolbar; release types ASAP, At time, and Undecided (Undecided hides
publish and schedule behind "..." to prevent accidents; the toolbar tints orange,
purple, or gray by type); "Add to release" from the document top bar; "Publish
all documents" or "Schedule for publishing." Review stages and assignees require
`sanity-plugin-workflow`.

**Command palette.** Yes. Cmd+K / Ctrl+K opens global search (fuzzy, across every
document type), also reachable from the search icon in the top toolbar. It
supplements the panes rather than replacing them. Other shortcuts: delete
document `Ctrl+Option+D`, inspect `Ctrl+Option+I`, Escape closes search and
dialogs. There is no publish shortcut because documents autosave.

**Responsive behavior.** Genuinely designed for, and a stated reason for the
single-axis nav. The Publish button moved to the bottom of the screen and is the
only primary button on the screen. On small screens tools go into a side drawer
"except what we have identified as the top tasks: document creation and search."
Presentation collapses a side-by-side preview and editor into a tab bar at the
top (Presentation / Structure / Navigator) rather than a cramped split. Panel
state is driven by media queries, not focus.

**Why it works / tradeoffs.** URL-as-pane-stack gives real deep links, a real
back button, real bookmarking, and the structure config is the single source of
truth for both nav and routing. Tradeoffs: horizontal panes get confusing past
about three levels and force horizontal scrolling, and because editors cannot
filter, developers must anticipate every view an editor will ever want.

**Applicability to the NJ PBS admin.** The semicolon pane-stack is overkill, but
the single nav axis plus Cmd+K search is the argument for removing one of the two
rails. Sanity removed the sidebar on purpose and put search where it went. The
structure-defined list pattern maps cleanly onto newsroom views (all stories, my
drafts, needs review) if those are hard-coded rather than built as a filter UI.

**Sources.**

- <https://www.sanity.io/docs/studio/structure-introduction>
- <https://www.sanity.io/docs/studio/structure-builder-introduction>
- <https://www.sanity.io/blog/say-hi-to-the-new-delightful-sanity-studio>
- <https://www.sanity.io/docs/studio/sanity-studio-keyboard-shortcuts>
- <https://www.sanity.io/docs/user-guides/dashboard-introduction>
- <https://www.sanity.io/docs/studio/content-releases>
- <https://www.sanity.io/docs/studio/scheduled-publishing>
- <https://www.sanity.io/docs/studio/document-actions-api>
- <https://github.com/sanity-io/sanity/issues/4950>
- <https://www.sanity.io/docs/changelog/76c1a07c-8df1-4683-8a38-d1a145ff566f>
- <https://www.sanity.io/answers/generating-working-links-to-custom-document-views-in-sanity-studio-v->

---

## Contentful

**Nav model.** One top navbar, no left app rail. The Forma 36 `Navbar` is "the
main top navigation across all Contentful Products" and is composed of named
areas configured by props: `logo`, `mainNavigation`, `mobileNavigation`,
`secondaryNavigation` (search/help), `promotions`, `switcher` (space and
environment selector), and `account`. Tabs include Home, Content model, Content,
Media, Apps, AI & Automations, and Settings. Inside the Content tab there is a
second left sidebar, but it holds saved views and folders, not content types. The
second level is a work surface, not a duplicate of the first.

**URL/routing.** `app.contentful.com/spaces/{space-id}/environments/{environment-id}/...`.
The docs give the shape verbatim for app installs:
`https://app.contentful.com/spaces/{space-id}/app_installations/{app-id}/` and
`https://app.contentful.com/spaces/{space-id}/environments/{environment-id}/app_installations/{app-id}/`.
The `/entries/{entry-id}` segment follows the same shape and every entry is a
stable bookmarkable URL, though the entries pattern itself was not found stated
verbatim in the docs. Apps navigate via SDK `navigator` methods (openEntry,
openAsset by `sys.id`) rather than hand-built URLs.

**Dashboard/home.** A Home tab, and thin by default. Its main documented property
is that it is replaceable. The App Framework "Home location" "can replace the
entire page of the Home tab in the web app, on an environment level... can be
used for dashboards, custom onboarding or learning materials that need to be
highly visible." Set at Settings, then Home page, then select app, then Save. The
real resume-work surface is the Content tab plus saved views, not Home.

**Content list / library.** Table. Columns: Name, Status, Content Type, Created,
Updated, Published, Created by, Last updated by, Workflow, Tags. Name and Status
are permanently visible; the rest are customized via a gear icon dropdown that
drags columns between "Visible Columns" and "Hidden Columns." Saved views live in
the left sidebar: search or filter, then "Create new view" from the View menu.
Each view has visibility settings controlling which roles can access it, and
views group into folders (rename and delete supported). Default views: All
entries, My drafts, Recently updated, Scheduled, plus a separate Archived view
(archived content is hidden from the master list by default). Bulk actions, shown
conditionally on the selected entries' status: Publish/Unpublish, Delete,
Archive, Duplicate, Add to release, Add or remove tags, Export as CSV.

**List-to-editor relationship.** Full-page navigation to the entry editor. Back
is via the saved view in the sidebar, so the view is what you return to rather
than a generic "back to list." The entry editor has tabs: Editor, References,
Tags. The title bar shows the entry name plus the count of other entries that
reference it. A presence indicator sits in the top toolbar above the sidebar,
showing avatars of active users (solid color ring) and inactive ones (greyed,
with a last-worked-on timestamp tooltip).

**Editorial workflow.** Four statuses, color-coded in the Status column: Draft
(not published), Changed (published but has pending unpublished changes),
Published (published, unmodified since), and Archived (not published, cannot be
edited). The right sidebar of the entry editor is where workflow lives: set
content status, assign tasks, preview, view links, manage translations. Tasks are
load-bearing: "Tasks are your team's to-do list... the entry can't be published
until you've completed all of the tasks." Workflows (enterprise) adds steps with
per-step permissions governing who may advance an entry, up to five tasks per
step, and automatic versus manual start. With manual start you click "Start
workflow" in the sidebar. Launch groups content into releases and publishes them.
Timeline stages "multiple future versions of the same content entry side by
side."

**Command palette.** Not documented. Forma 36 publishes keyboard-shortcut
guidelines but no palette component, and no Cmd+K product feature surfaced.
Treat Contentful as a no-palette product.

**Responsive behavior.** The nav is breakpoint-driven and explicit:
`mainNavigation` appears at 867px and above (below that `mobileNavigation` takes
over), `secondaryNavigation` and `account` appear at 576px and above, and
`promotions` at 1200px and above. The mobile breakpoint is configurable via
`mobileNavigationProps` to `small` (867px) or `medium` (1024px). "All areas are
designed with responsiveness in mind." The entry editor itself remains
desktop-first.

**Why it works / tradeoffs.** Saved views are the whole design. Instead of a
dashboard guessing what you want, the left sidebar is your list of
work-in-progress queues, and each is a URL. Role-scoped view visibility means an
editor and a producer see different sidebars from the same space. Tradeoffs: it
is config-heavy because someone has to author the views, and Home being a blank
slot means most spaces have a useless Home.

**Applicability to the NJ PBS admin.** The default view set (All entries, My
drafts, Recently updated, Scheduled, Archived) is a directly liftable answer to
"clicking a content type always opens a blank form." Shipping those five as
named, URL-addressable views (all stories, my drafts, needs review, scheduled,
recently published) solves the library problem and the resume-work problem with
one mechanism. The tasks-block-publish rule is a cheap review gate that needs no
state machine.

**Sources.**

- <https://www.contentful.com/help/getting-started/contentful-web-app-overview/>
- <https://f36.contentful.com/components/navbar>
- <https://www.contentful.com/help/content-and-entries/create-content-views/>
- <https://www.contentful.com/help/content-and-entries/managing-multiple-entries/>
- <https://www.contentful.com/help/content-and-entries/entry-editor/>
- <https://www.contentful.com/help/content-and-entries/entry-editor-sidebar-overview/>
- <https://www.contentful.com/developers/docs/tutorials/general/determine-entry-asset-state/>
- <https://www.contentful.com/help/ai-automations/workflows/>
- <https://www.contentful.com/help/workflows/workflows-management/using-workflows-in-an-entry/>
- <https://www.contentful.com/developers/docs/extensibility/app-framework/locations/>
- <https://www.contentful.com/blog/introducing-timeline/>
- <https://www.contentful.com/blog/tasks-and-comments-supercharge-your-content-approval-workflow/>
- <https://f36.contentful.com/guidelines/keyboard-shortcuts>

---

## Payload CMS

**Nav model.** One collapsible left sidebar, open by default. The v3 redesign
describes it as "a collapsible sidebar that's open by default, providing greater
extensibility and enhanced horizontal real estate." No second rail. Depth inside
the single rail comes from `admin.group`: a string groups collections under a
labeled heading in the nav, and `group: false` hides a collection from nav while
keeping it API-accessible. Folders (beta, shipped v3.39.0) add a cross-collection
organizational layer, enabled per-collection with `admin.folders: true`,
implemented as a hidden `folders` relationship field, and nestable (folders have
their own `folder` field).

**URL/routing.** Base `/admin`, configurable via `routes.admin`.

| Surface | Route |
|---|---|
| List | `/admin/collections/:collectionSlug` |
| Document | `/admin/collections/:collectionSlug/:id` |
| Globals | `/admin/globals/:globalSlug` |
| Dashboard | `/admin` |
| Account | `/admin/account` |
| Auth | `/admin/login`, `/admin/forgot`, `/admin/logout`, `/admin/unauthorized`, `/admin/create-first-user` |

Document views are sub-routes of the document route: Edit (default), API,
Versions, Version, Live Preview, each rendered in its own tab and configurable
via `views.edit.[key].tab` (label, href, order). Internally, "RootPage handles
all admin URL segments. When a route matches /collections/:slug/:id or
/globals/:slug, it resolves to DocumentView." Crucially, list state syncs to the
URL: search term, sort, pagination, and filters are held by `ListQueryProvider`
with URL state synchronization.

**Dashboard/home.** `/admin`, the first page after login. The default is the
built-in collections widget, showing cards for each collection and global. v3
made it a real widget grid: `defaultLayout` sets the initial arrangement (and can
vary by role), users get an "Add +" button, drag-to-reorder, width dropdowns,
per-widget delete, and reset-to-default. Customizations save to user preferences.
Custom widgets declare `slug`, `Component`, optional `fields`, and
`minWidth`/`maxWidth`.

**Content list / library.** Table. `admin.defaultColumns` sets initial columns and
a column selector lets users change them. Filters are a real query builder:
`WhereBuilder` manages nested AND/OR conditions, and each `Condition` presents
field selection, then operator selection based on field type, then an appropriate
value input. Search bar, column sort, pagination (`limit`, `page`, `totalPages`).
A List controls menu holds "Columns and Filters" plus custom `listMenuItems`.
Query Presets save and share filters, columns, and sort orders across a team.
`enableListViewSelectAPI` makes the list query only the active columns via the
Select API instead of whole documents, a real performance lever on wide
documents. Bulk actions via row checkboxes: `EditMany`, `PublishMany`,
`UnpublishMany`, `DeleteMany`. Globals have no list view because they are single
documents.

**List-to-editor relationship.** Full-page navigation. A row click goes to
`/admin/collections/:slug/:id`. Drawers exist but are scoped to nested editing,
not the primary flow: a relationship field with `admin.appearance: 'drawer'`
opens a related document in an overlay, and `useDocumentDrawer` does the same
from custom components. The drawer renders the same Document node as the full
page minus the header, and when `drawerSlug` is set, `redirectAfterCreate` and
`redirectAfterDelete` default to `false` so you stay put. That split, full page
for the main object and drawer for the thing you are referencing, is the cleanest
version of this pattern in the five.

**Editorial workflow.** Versions plus drafts. Enabling drafts injects a `_status`
field (`draft` or `published`). Autosave requires versions and drafts, saves into
a single reused autosave version rather than a new version per keystroke, and
"adds an indicator describing when the document was last saved to the top right
of the sidebar." A published document shows an "unpublish" button at the top of
the sidebar, the documented way to "revert a document back to a draft state."
Scheduled publish and unpublish exist and are implemented as a background Job, so
they require the app to be set up to process Jobs. Controls are Save, Publish, or
Save draft depending on config. There is no built-in review stage or assignee,
which is the gap versus Strapi and Contentful. Known wart: autosave "creates
misleading 'draft' status in document list for already published entries"
(issue #11942).

**Command palette.** None built in. The community fills it:
`@jhb.software/payload-admin-search` adds a Cmd+K / Ctrl+K global search modal for
navigating documents and collections, and requires the official Payload search
plugin. There is also a community command-menu plugin and nav plugins
(`payload-nav-studio`: drag-and-drop sidebar, per-user preferences, pinning,
badges).

**Responsive behavior.** The sidebar is collapsible, and the root `Nav` component
"contains the sidebar / mobile menu in its entirety," so one component serves both
and it is swappable. `@payloadcms/ui` ships a `Collapsible` primitive. Not a
headline feature, but structurally accounted for.

**Why it works / tradeoffs.** Payload is the most conventional and the most
transferable: plain REST-shaped routes, list state in the query string, one
grouped sidebar, a full-page editor, and drawers only for nesting. Grouping
headings inside the single rail do the job the current second rail is failing at.
Tradeoffs: no palette out of the box, no review workflow, and scheduled
publishing quietly depends on a job runner that has to actually be stood up.

**Applicability to the NJ PBS admin.** The closest analog and the cheapest path.
Copying the route shape verbatim (`/admin/collections/:slug` for the library,
`/admin/collections/:slug/:id` for the item, list state in the query string)
removes every symptom of problem 1 in one change. Its single grouped sidebar is
the direct proof that the second rail is removable, not just shrinkable.

**Sources.**

- <https://payloadcms.com/docs/admin/overview>
- <https://payloadcms.com/docs/custom-components/list-view>
- <https://payloadcms.com/docs/custom-components/document-views>
- <https://payloadcms.com/docs/custom-components/custom-views>
- <https://payloadcms.com/docs/custom-components/dashboard>
- <https://payloadcms.com/docs/configuration/collections>
- <https://payloadcms.com/docs/query-presets/overview>
- <https://payloadcms.com/docs/versions/drafts>
- <https://payloadcms.com/docs/versions/autosave>
- <https://payloadcms.com/docs/versions/overview>
- <https://payloadcms.com/docs/folders/overview>
- <https://payloadcms.com/docs/fields/relationship>
- <https://deepwiki.com/payloadcms/payload/4.2-document-and-list-views>
- <https://www.npmjs.com/package/@jhb.software/payload-admin-search>
- <https://github.com/pOwn3d/payload-nav-studio>
- <https://github.com/payloadcms/payload/issues/11942>

---

## Strapi

**Nav model.** One left nav (Content Manager, Content-Type Builder, Media
Library, plugins section, Settings) with the account and profile at the bottom
left corner, accessed via "Account name or initials." Inside Content Manager
there is a second column listing Collection types and Single types, but it earns
its keep: it has its own search icon for finding content-types and entries, and
it is the only place that list exists. It is a content-type index, not a repeat
of the app nav.

**URL/routing.** Base `/admin`. `/admin/content-manager/collection-types/:model/:documentId`
for the edit view, `/admin/content-manager/single-types/:model` for single types.
Strapi 5 replaced v4's numeric `id` with `documentId` as the document identifier,
and `documentId` is undefined when creating an entry, which is how the edit view
distinguishes create from edit. Extension points: the `editView` injection zone
with sub-areas like `'right-links'`, plus typed Content Manager APIs
(`addDocumentAction`, `addEditViewSidePanel`) that the docs recommend over
injection zones.

**Dashboard/home.** The strongest resume-your-work home of the five, and the most
directly relevant. The Homepage is widget-based with 6 default widgets, including
"Last edited entries" (showing content type, status, and when it was updated) and
"Last published entries." Users resize widgets by dragging dividers, reorder via
drag controls, delete with delete buttons, and restore deleted ones via an "Add
widget" button. There is an optional guided tour for new admins. Nothing leads
with role, permissions, or billing; that lives in Settings.

**Content list / library.** Table. Columns are configurable two ways: a quick
configuration with checkbox toggles right from the list view, and a permanent or
advanced configuration with more options. `documentId` can be added as a column
for quick reference. Filters are condition-based and combinable. When Draft &
Publish is on, a Status filter offers four precise states: "Draft (never
published)," "Published (all)," "Published (modified)," and "Published
(unmodified)." That published-modified versus published-unmodified distinction is
the sharpest status vocabulary in this set. Text search can be disabled per
content-type. Sort by clicking column headers, though Status column sorting is
disabled while status filters are active. Pagination with configurable
entries-per-page. Bulk actions via multi-select checkboxes, also disableable.

**List-to-editor relationship.** Click a row for full-page navigation to the edit
view. The main content area shows configurable fields in a customizable layout
and sizes. The right sidebar holds a button (top right) showing published,
updated, and created dates, plus a "Copy document ID" option. Repeatable
components allow reorder and delete; dynamic zones use an "Add a component to
[zone name]" control.

**Editorial workflow.** The most complete out of the box. Draft & Publish is the
base. Review Workflows (enterprise) ships a default 4-stage workflow: To do, In
progress, Ready to review, Reviewed. All four are editable, reorderable, and
deletable, and stages can be added. Per-stage role permissions are split into two
distinct grants: roles that can change from a stage, and roles that can move
content to a stage. Entries can be assigned to any admin user via an Assignee
drop-down list in the review edit view, "giving review stages a clear owner, so
everyone knows who's responsible." Releases bundle entries, take a date and time,
and schedule them to go live together. Releases x Review Workflows closes the
loop: designate a stage content must reach to be eligible for publishing, and the
release verifies every entry meets that stage before publishing.

**Command palette.** None documented. The admin panel docs reference an "Ask AI"
affordance but no Cmd+K palette exists.

**Responsive behavior.** The weakest of the five, and Strapi says so publicly.
Their own feedback board states the entire interface will not be responsive.
They started with Responsive Fields & Components as a first step and adapted the
navigation bar for smaller screens, iterating toward the Content Manager. Two
stated blockers: the design system is shared with Strapi Cloud so changes ripple,
and "Strapi relies heavily on modals, which complicates delivering a smooth
mobile experience." A community plugin (`strapi-5-plugin-responsive-backend`)
patches CSS below 767px. Open issues go back to #463 and #13213.

**Why it works / tradeoffs.** Strapi is the reference implementation for problems
3 and 5. The homepage answers "where do I resume," the status vocabulary answers
"what state is this in," and Review Workflows plus Releases answer "how does
review connect to publish," with the stage-gates-release rule as the connective
tissue. Tradeoffs: the good workflow parts are enterprise-tier, and the modal
dependency has painted them into a corner on responsive.

**Applicability to the NJ PBS admin.** The "Last edited entries" and "Last
published entries" widget pair is the single most copyable thing in this report
for the dashboard problem. It is exactly the inversion needed: resume work first,
admin metadata in Settings. The 4-stage default (To do, In progress, Ready to
review, Reviewed) plus an assignee dropdown is a ready-made vocabulary for a TV
newsroom with no design work required. Also take the warning: do not build the
editor out of modals, which is precisely what has kept Strapi off small screens.

**Sources.**

- <https://docs.strapi.io/cms/features/content-manager>
- <https://docs.strapi.io/cms/features/admin-panel>
- <https://docs.strapi.io/cms/admin-panel-customization/homepage>
- <https://docs.strapi.io/cms/features/review-workflows>
- <https://docs.strapi.io/cms/plugins-development/content-manager-apis>
- <https://strapi.io/blog/introducing-new-cloud-regions-cli-enhancements-plugins-and-releases-x-review-workflows>
- <https://strapi.io/blog/introducing-strapi-v4-13-with-assignees-for-review-workflows-additional-type-script-support-and-cloud-regions-shared-projects>
- <https://feedback.strapi.io/customization/p/responsive-administration-panel>
- <https://github.com/strapi/design-system/issues/860>
- <https://market.strapi.io/plugins/strapi-5-plugin-responsive-backend>
- <https://strapi.io/blog/how-to-build-a-admin-panel-widget-plugin-for-strapi>

---

## Directus

**Nav model.** Two rails, done right, and the direct counter-example to problem 2.
The documented page structure is "the module bar, navigation, sidebar, header,
and the main content area." The module bar is a narrow icon rail on the far left:
"Modules are top-level areas of the Data Studio, navigated to from the left-hand
module bar." It holds five modules: Content, Files, Users, Insights, Settings.
The second rail is the navigation panel, contextual to the selected module (in
Content it lists collections, in Files it lists folders, in Users it lists roles).
A module is described as "an empty canvas in Directus with an empty navigation
panel on the left, page header at the top and the sidebar on the right." The two
rails never show the same information. The outer switches domain, the inner
navigates within it, and the outer is icon-only so it costs about 64px, not 16rem.
A right sidebar carries per-item context.

**URL/routing.** Clean and predictable.

| Surface | Route |
|---|---|
| Collection | `/:module/:collection` (e.g. `/content/articles`) |
| Item | `/:module/:collection/:primaryKey` (e.g. `/content/articles/5`) |
| New item | `/content/articles/+` |
| Folder | `/files/folders/:folder` |
| Role-filtered users | `/users/roles/:role` |

Layout state syncs to query params: `?bookmark=123` loads a saved view,
`?archive=archived` shows archived items, and filters are encoded in the URL for
sharing view configurations. Caveat worth flagging: arbitrary URL-driven
filtering (e.g. `/admin/collections/tasks/?filter[project.id]=1`) is an open
feature request (discussion #6493), not shipped, so URL filter support is real
but not fully general.

**Dashboard/home.** The Insights module, dashboards built from panels. It is an
analytics surface, not a resume-work home. Directus has no equivalent of Strapi's
"Last edited entries." This is Directus's weak spot relative to problem 3.

**Content list / library.** The richest of the five, because the list is swappable
by layout:

- **Table** (default, works with all data types): column width adjustment,
  add/remove fields, sorting, text alignment, manual selection.
- **Cards** (tiled): configurable image source, title and subtitle templates, and
  image fit. The default for the user directory and file library.
- **Calendar**: needs at least one datetime field, ideally two for start and end.
  Chevron month navigation, month/week/day toggle.
- **Map**: geospatial points, lines, and shapes. Zoom, location finder,
  click-and-drag multi-select.
- **Kanban**: groups items into status columns. Requires a status field configured
  under "Group By" in layout options. Drag between columns to change status.

Filters: a filter button at the top opens a builder with AND/OR groups and
dynamic variables `$CURRENT_USER` and `$NOW`, which is how you get "assigned to
me" and "published this week" without a saved view. Bookmarks are the saved-view
system: presets store collection, search query, filters, view type, and view
query. "Bookmarks have a name field, and if this is set, the preset will be
considered a bookmark," and elegantly, "Leaving the name field empty will make it
so this bookmark is what is viewed for this collection by default." One mechanism
gives both saved views and per-collection defaults. Batch editing: select multiple
items and apply the same value across records. With content versioning on, a
Published/Draft selector appears in the header; draft mode disables batch editing,
archiving, exporting, manual sorting, and flow execution, but allows bulk deletion
of draft versions.

**List-to-editor relationship.** Click an item for full-page navigation to
`/content/:collection/:primaryKey`, "a tailored form for managing individual items
and their field values." The save button has a "..." dropdown: "Save and Stay"
(Cmd+S / Ctrl+S), "Save and Add New" (saves then opens a blank Create Item page
for that collection), and "Save as Copy." The right sidebar holds Info, Revisions
(side-by-side comparison against current state, a "Revision Preview" button, and
revert), Comments (with @ mention tagging), and Shares (public links with
password, role restriction, and expiration). Archive is a header button with a
confirm popup. Note the documented behavior that "Archived items will not show up
in app, but will still be returned in API responses unless explicitly filtered
out."

**Editorial workflow.** No prescriptive state machine. Directus's position is that
status is just a field you model, and Kanban's "Group By" turns any status field
into a drag-to-change-state board for free. Revisions and comments give
review-in-place, and Flows handle transitions. Content versioning adds the
Published/Draft header selector. Tradeoff: no assignee, no stage permissions, and
no scheduling without building it.

**Command palette.** Not core. An official Directus Labs extension,
`@directus-labs/command-palette-module`, adds Cmd/Ctrl+K across Directus:
navigate the Data Studio, search within collections, create new items, and run
context-aware actions (copy API URLs, run flows). You configure which collections
are searchable and which fields are used for searching. Requested in core since
discussion #8408 and shipped as an extension in the September 2024 changelog. The
editor docs also reference Cmd+K for search.

**Responsive behavior.** The weakest answer of the five; they punted. There is no
documented responsive Data Studio behavior. Instead Directus ships a separate
native mobile app (iOS and Android: "access, manage, and control your content
with ease, right from your smartphone or tablet," with home screen widgets, push
notifications, a rich text editor, and a media library). Community extensions
patch it piecemeal, for example a responsive group interface that "shows tabs on
desktop and switches to a configurable mobile layout on smaller screens." If the
answer to narrow screens is "download our app," the web app is not responsive.

**Why it works / tradeoffs.** Directus proves two rails are fine when the outer
one is icon-only and switches domains rather than repeating them. Layouts-per-
collection is genuinely strong: the same data as table, calendar, or kanban with
no code. Bookmarks unify saved views and defaults in one field. Tradeoffs: no
resume-work home, no editorial workflow primitives (you model them), a palette
that is an install away, and no responsive story.

**Applicability to the NJ PBS admin.** This is the model for keeping two rails if
they are wanted. Collapse the outer one to an icon-only module bar and make the
inner one contextual, and the redundancy goes away without deleting a level.
Kanban with Group By on a status field is a nearly free editorial board for a
newsroom (drag a story from "needs review" to "ready"), and the Calendar layout
keyed to a publish datetime fits a broadcaster scheduling segments. The
unnamed-bookmark-as-collection-default trick is worth stealing outright.

**Sources.**

- <https://deepwiki.com/directus/directus/4.1-application-layout-and-views>
- <https://directus.com/docs/guides/content/layouts>
- <https://directus.com/docs/guides/content/explore>
- <https://directus.com/docs/guides/content/editor>
- <https://directus.io/docs/api/presets>
- <https://directus.com/features/bookmarks>
- <https://directus.io/docs/guides/extensions/app-extensions/modules>
- <https://docs.directus.io/guides/extensions/modules-native-layout-features>
- <https://www.npmjs.com/package/@directus-labs/command-palette-module>
- <https://github.com/directus-labs/extensions/tree/main/packages/command-palette-module>
- <https://github.com/directus/directus/discussions/8408>
- <https://github.com/directus/directus/discussions/6493>
- <https://apps.apple.com/us/app/directus-mobile/id6740696350>
- <https://directus.com/tv/the-changelog/2-september-2024>

---

## Cross-cutting notes, mapped to the evaluation questions

### 1. Routing and bookmarking

All five put content items at stable URLs, and four of five use the same shape,
`{base}/{collection}/{id}`:

| Product | List | Item |
|---|---|---|
| Payload | `/admin/collections/:slug` | `/admin/collections/:slug/:id` |
| Directus | `/content/articles` | `/content/articles/5` |
| Strapi | (content-type index) | `/admin/content-manager/collection-types/:model/:documentId` |
| Contentful | `/spaces/:s/environments/:e/entries` | `/spaces/:s/environments/:e/entries/:id` |
| Sanity | `/structure/book` | `/structure/book;game-of-thrones` |

Sanity is the outlier with its semicolon pane-stack. The convergent answer is the
boring one. Two details worth copying beyond the route itself: Payload and
Directus both put list state (search, sort, page, filters) in the query string,
which is what makes a filtered view shareable; and Directus uses `/+` as the
create route (`/content/articles/+`), which separates "new" from "edit" without a
magic ID.

### 2. Navigation hierarchy

Two products resolve this in opposite, equally valid directions. Sanity deleted
the second rail on purpose and said why: one axis, less real estate, more
responsive, with global nav and search moved to the top. Directus kept two rails
but made the outer one an icon-only module bar that switches domains while the
inner one navigates within the selected domain. Payload and Strapi just use one
rail with grouped headings.

A second rail can read as decoration when both rails carry the same kind of
information. Either collapse
to one (Payload's `admin.group`) or differentiate hard (Directus's icon rail).

### 3. Dashboard

Strapi is the clear winner and the direct fix: "Last edited entries" and "Last
published entries" widgets, user-rearrangeable, saved to preferences. Payload's is
weaker but shares the architecture (collections widget by default, `defaultLayout`,
drag-to-reorder, saved to user preferences). Contentful's Home is an empty slot
filled by an app. Directus has no work-resumption home at all. None of the five
leads with roles, permissions, or billing; that universally lives in Settings.

### 4. Content library

The recurring pattern is named, URL-addressable saved views, and it does double
duty: it is the library and the resume-work surface, which is why Contentful can
get away with a blank Home. Contentful ships All entries, My drafts, Recently
updated, Scheduled, and Archived as defaults. Payload has Query Presets. Directus
has Bookmarks (with the unnamed-bookmark-is-the-default trick). Strapi has saved
column configs plus status filters. Sanity is the cautionary tale: no
editor-facing filters means developers must pre-build every view, and editors
filed issues about it.

### 5. Draft, review, publish

Three distinct depths:

- **Strapi is deepest and most liftable**: 4 default stages, split role grants
  (move from versus move to), an assignee dropdown, and Releases that gate
  publishing on a required stage.
- **Contentful** models it as steps plus tasks with a hard rule: an entry cannot
  publish until its tasks are complete. That is a review gate with almost no
  machinery.
- **Payload, Sanity, and Directus** all decline to prescribe: `_status`, document
  actions, or "it's just a field," respectively.

For a station-sized newsroom, Strapi's vocabulary plus Contentful's
tasks-block-publish rule is the cheapest credible workflow.

### The list/editor relationship

Near-unanimous and worth stating plainly: full-page navigation for the primary
object, drawers and modals only for nested or referenced things. Payload's
`admin.appearance: 'drawer'` on relationship fields is the clean articulation.
Sanity's side-by-side panes are the only real alternative. Strapi's public
admission that "Strapi relies heavily on modals, which complicates delivering a
smooth mobile experience" is the argument for holding that boundary: modal-heavy
admins cannot get to small screens later.

### Command palettes

| Product | Palette |
|---|---|
| Sanity | Cmd+K, core |
| Directus | Cmd+K, official Directus Labs extension |
| Payload | Cmd+K, community plugin |
| Strapi | None |
| Contentful | None |

Where it exists it supplements nav. No product has tried to replace navigation
with a palette.
