# Admin UX patterns — navigation, IA, and workflow in Linear, Notion, Airtable, Retool

> This research briefing covers navigation, information architecture,
> command palettes, list-to-detail relationships, and status-driven workflow UI in
> four non-CMS products, to inform newsroom admin design.
> Companion briefings cover the same questions for headless CMSs ([headless-cms-admin-ux-research.md](headless-cms-admin-ux-research.md))
> and newsroom CMSs ([newsroom-cms-research.md](newsroom-cms-research.md)).
> These four are not content management systems. They are here because they are
> widely regarded as having the best navigation, IA, and list-to-detail UX in
> modern software, and the brief is to steal patterns from them rather than from
> peer CMSs. Retool matters most as a genre analog: it is an admin-panel builder,
> the closest thing to "admin dashboard" as a documented product category.
>
> Method and sourcing: vendor documentation, engineering and design blog posts,
> product changelogs, and UX teardowns. Every load-bearing
> claim carries an inline source. Keyboard shortcuts, URL formats, and pixel specs
> are quoted from vendor docs where they exist.
>
> Two sourcing cautions, flagged rather than smoothed over:
>
> - **Linear does not publish a routing spec.** Its docs confirm that filters
>   serialize into the address bar and that views have copyable URLs, but the
>   `linear.app/workspace/issue/ENG-123/title` shape comes from a secondary source
>   and is marked as such below. Airtable and Retool document their URL formats
>   explicitly, so those are exact.
> - **The teardown sources are secondary.** The 925studios and dev.to pieces are
>   third-party analyses, not vendor statements. They are used for structural
>   observations and critique, not for factual specs.
>
> Five evaluation questions guide the comparison:
>
> 1. Can editors bookmark, navigate back to, and resume a specific item?
> 2. Does the navigation communicate one clear hierarchy?
> 3. Does home help editors resume work?
> 4. Can editors browse, search, filter, and reopen content?
> 5. Do save, review, preview, and publish form a coherent workflow?

## Summary (TL;DR)

- **All four ship exactly one nav rail.** Notion is the sharpest counter-model to
  problem 2: search, inbox, and home are tabs *inside* the same rail as the content
  tree, so nothing looks like a sibling nav. Airtable goes further and deletes the
  sidebar entirely when an interface has only one page. Retool's spec is one
  Sidebar frame at a fixed 240px, one Navigation component, one level of nesting.
  Nobody stacks two rails.
- **Retool and Airtable together document the URL target for problem 1**, and they
  split it. Retool covers the mechanics: filters in query params, the selection in
  query or hash params, `utils.setUrlParameters()` writing to the address bar with no
  reload, and a persist flag across navigation — its stated purpose is letting users
  "link to an app's current state, such as a selected table row." Retool's *path*
  names the page, not the record. Airtable is where the record rides in the path
  (`/{base}/{table}/{view}/{record}`), and it also proves the URL should carry the
  *view*, not just the record. Linear proves the payoff.
- **Two of four lead home with recents** (problem 3): Notion and Airtable, the latter of
  which rebuilt its home screen specifically because it was crowded with irrelevant
  content. Linear sorts by urgency rather than recency, and Retool prescribes no home at
  all. Role, permissions, and billing sit at a settings route in all four.
- **Linear and Notion independently converged on the same status model** (problem
  5): a small fixed spine of categories (7 and 3 respectively) with unlimited
  team-named statuses inside, where the *category* drives behavior and the *name*
  is just vocabulary. This is the model for Draft → Needs review → Scheduled →
  Published, and it is what turns save/preview/publish from three orphaned buttons
  into one workflow.
- **The list-to-detail decision rule is behavioral, not aesthetic.** Airtable
  states it best: sidesheet when users browse many records in one workflow,
  full-screen when they focus deeply on one. Linear adds a cheaper tier below both.
- **The caution:** the strongest Linear source says copying its aesthetics without
  its reasoning "is why most clones feel hollow," and that keyboard-first assumes
  an audience with editor and terminal muscle memory. NJ PBS's editors, producers,
  and contributors are not that audience. Take the URL model, the status
  categories, and peek. Make every keyboard path optional.

## Linear

**Nav model.** One sidebar, not two. Six vertical chunks: header (logo, workspace
switcher, ⌘K hint), personal nav rows (Inbox, My Issues), a `WORKSPACE` section
header, workspace-level items (Teams, Customers), team rows with avatars, status
footer ([dev.to teardown](https://dev.to/dev48v/i-cloned-linears-sidebar-in-50-lines-of-html-one-file-zero-npm-40ej),
[changelog](https://linear.app/changelog/2024-12-18-personalized-sidebar)).

Team sections deliberately show *few* links — Issues, Projects, plus Cycles and
Triage when enabled — and hovering Issues or Cycles reveals sub-menus for backlog
and upcoming cycle rather than stacking those as permanent rows. The sidebar is
user-editable: right-click an item to update it, "Customize sidebar" to see all
options, drag-and-drop to reorder, and a **More** menu to hide infrequent items.

The 2024 redesign describes the whole nav frame as an "inverted L-shape" (sidebar
plus horizontal chrome) and the work as reducing visual noise while *increasing*
"the hierarchy and density of navigation elements"
([Linear design blog](https://linear.app/now/how-we-redesigned-the-linear-ui)). A
teardown puts the payoff bluntly: "The sidebar stays fixed. The content area
transforms" — versus Jira's "page load that resets your mental model of where
things are" ([925studios](https://www.925studios.co/blog/linear-design-breakdown-saas-ui-2026)).

**URL and routing.** Workspaces get a unique URL in the style `linear.app/example`
([Workspaces docs](https://linear.app/docs/workspaces)). Issues are addressable as
`https://linear.app/workspace/issue/ENG-123/title`, issue ID plus title slug
(secondary source; not in Linear's own docs — flagged).

The load-bearing documented fact for problem 1: **filters are reflected in the
browser URL**. "Copy the browser address to share the filtered view; opening the
link applies the same filters." The caveat matters too: "Only the main filters are
included in the URL. View options, quick filters, and Insights filters aren't
included" ([Filters docs](https://linear.app/docs/filters)). Saved views have their
own shareable URL via the three-dot menu, though "sharing a link does not
automatically give anyone access to a view, it must be shared first"
([Custom views docs](https://linear.app/docs/custom-views)).

**Dashboard and home.** There is no role or settings dashboard. The two homes are
**Inbox** (`G` then `I`) and **My Issues** (`G` then `M`). My Issues has four tabs
— Assigned, Created, Subscribed, Activity — and Assigned is *not* sorted by date.
It is grouped in a "focus order": urgent work, SLA-bound work, blockers, cycle
work, other active work, triage, backlog, completed work; within each, started
issues first, sorted by priority ([My issues docs](https://linear.app/docs/my-issues)).
That is an editorially relevant idea: home is an opinionated answer to "what should
I do next," not a data dump.

**List view (the library pattern).** `F` opens filters. Advanced filters group
conditions with AND/OR including nested groups; AI filters accept natural language
("what issues are due next week"); quick filters let you type a property name
directly. Operators are typed to the field: *is / is not*, *is either of / is not*,
*includes any, all, neither, either, none*, *before / after*
([Filters docs](https://linear.app/docs/filters)).

Display options (`Shift+V`; `Cmd/Ctrl+B` toggles list and board) control grouping by
status, assignee, project, priority, cycle, label, team, or release; sub-grouping
into swim lanes with sticky headers; ordering; sub-issue show and hide; and which
display properties render. "When ordering by status, list views show issues from
closest to done → farthest from done." Changes persist on navigate-away, and "Set
as default" applies workspace-wide
([Display options docs](https://linear.app/docs/display-options)).

Saving a view: `Option/Alt + V`, or the Save view icon that appears "after you've
added at least one filter." Views are typed (Issue, Project, Initiative) and scoped
(Workspace views vs Team views); starring one puts it in the sidebar
([Custom views docs](https://linear.app/docs/custom-views)).

**List-to-detail.** Three tiers, and the most stealable part of the product.

1. **Peek.** Press `Space` to toggle, or *hold* `Space` for a temporary preview,
   macOS Quicklook-style. It shows description, assignee, status, priority, cycle,
   labels, estimate, and created/updated dates. Arrow keys move between adjacent
   items and the preview updates live; `Esc` closes. Explicitly **keyboard-only:
   "It cannot be triggered by hovering"** ([Peek docs](https://linear.app/docs/peek)).
2. **Split view.** List beside focused item, shipped for Triage and for Search, "so
   that you can jump through them without losing context."
3. **Full page.** The URL-addressable issue.

Density supports this: one row carries title, status, priority, assignee, labels,
project, and cycle, with progressive disclosure on hover.

**Status and workflow model.** Seven fixed **categories** — Triage, Backlog,
Unstarted, Started, Completed, Canceled, Duplicate — with teams free to define
multiple *named statuses inside* each. Default chain is Backlog > Todo > In
Progress > Done > Canceled. Linear's own product team runs Backlog and Icebox under
Backlog, and In Progress, In Review, and Ready to Merge under Started. "The
categories themselves stay in a fixed order," and at least one status must remain in
each.

Categories drive real behavior, not just color: the Backlog/Todo default status
applies to new issues, Duplicate auto-reassigns, and auto-close and auto-archive
hang off category
([Configuring workflows docs](https://linear.app/docs/configuring-workflows)).

**Triage** is a per-team inbox with four keyed actions: Accept (`1`), Decline
(`3`), Mark as duplicate (`2` or `MM`), Snooze (`H`)
([Triage docs](https://linear.app/docs/triage)).

**Command palette.** `Cmd/Ctrl+K`. It is **contextual, not a global search box**:
"if you are looking at cycles and open the command menu, the command menu will first
display commands that are related to cycles." It "lets you search and take any
actions applicable to your view or selection," so with issues selected it becomes a
bulk-action bar; right-click gives the same menu
([Select issues docs](https://linear.app/docs/select-issues)).

It **supplements** nav rather than replacing it. The sidebar stays, and there is a
parallel keyboard layer:

| Pattern | Shortcuts |
|---|---|
| Jump to a place | `G I` inbox, `G M` my issues, `G V` current cycle, `G B` backlog, `G T` triage |
| Open a picker | `O F` favorites, `O P` projects, `O C` cycles, `O T` teams |
| Act on selection | `C` create, `A` assign, `L` label, `P` priority, `F` filter, `X` select |
| Meta | `/` search, `?` list all shortcuts, `Cmd+Shift+.` copy git branch name |

Search is separate from the palette: it covers issues, projects, and documents by
title, description, and comments; accepts `LIN-123` or `lin123`; and `@`-mentions
auto-convert into filters ([Search docs](https://linear.app/docs/search)).

**Responsive behavior.** Mobile was rebuilt around a **bottom toolbar** (Oct 2025),
then made customizable (Jan 2026): rearrange main nav items, pin specific projects,
initiatives, and documents via the ••• menu. The tab bar expands to fit more entries
and becomes a sidebar on iPad. A "Create Issue" button sits at the top of every
screen. Rationale: Linear "needed a more customizable foundation that would allow
for more flexible, adaptable, and expandable navigation depending on a user's role"
([mobile changelog](https://linear.app/changelog/2026-01-22-customize-your-navigation-in-linear-mobile)).

**Why it works, and the tradeoffs.** The Linear Method's principles are
"Purpose-built," "Aim for clarity" ("Don't invent terms if possible, as these can
confuse and have different meanings in different teams"), and "Simple first, then
powerful" ([Linear Method](https://linear.app/method/introduction)).

The honest tradeoff, from the teardown: "Copying Linear's aesthetics without
understanding the reasoning behind each choice is why most clones feel hollow." The
keyboard-first model assumes an audience with editor and terminal muscle memory and
would fail for a point-and-click team. **This is the caution for NJ PBS: producers
and contributors are not developers.** Take the URL model and the status model; make
the keyboard layer an accelerant, never the only path.

**Applicability to the NJ PBS admin CMS.** Steal two things nearly whole:

1. The **status-category model**: a fixed spine of categories (Draft, Needs review,
   Scheduled, Published, Archived) with newsroom-editable named statuses inside
   each, where category — not label — drives what the UI does. That is exactly the
   missing connective tissue in problem 5.
2. **Filters-in-the-URL plus save-view**: every filtered content-library state is a
   copyable link, and an `Alt+V` equivalent turns a filter into a named saved view
   in the sidebar.

Also take My Issues' focus-ordering as the model for a resume-work home.

**Sources.**

- <https://linear.app/docs/filters>
- <https://linear.app/docs/custom-views>
- <https://linear.app/docs/display-options>
- <https://linear.app/docs/my-issues>
- <https://linear.app/docs/configuring-workflows>
- <https://linear.app/docs/triage>
- <https://linear.app/docs/inbox>
- <https://linear.app/docs/peek>
- <https://linear.app/docs/search>
- <https://linear.app/docs/select-issues>
- <https://linear.app/docs/conceptual-model>
- <https://linear.app/docs/workspaces>
- <https://linear.app/changelog/2024-12-18-personalized-sidebar>
- <https://linear.app/changelog/2026-01-22-customize-your-navigation-in-linear-mobile>
- <https://linear.app/now/how-we-redesigned-the-linear-ui>
- <https://linear.app/method/introduction>
- <https://www.925studios.co/blog/linear-design-breakdown-saas-ui-2026> (secondary)
- <https://dev.to/dev48v/i-cloned-linears-sidebar-in-50-lines-of-html-one-file-zero-npm-40ej> (secondary)

## Notion

**Nav model.** One sidebar, tabbed at the top rather than railed. Workspace switcher
sits at the very top: "switch between the workspaces you belong to, create a new
one, add another account, or log out." Below it, tabs: **Home**, **Chats** (AI),
**Meetings**, **Inbox**, **Search**. Below *those*, content sections: **Favorites**,
**Teamspaces**, **Shared**, **Private**, **Trash**, with Settings and Templates at
the bottom. Sections collapse by clicking their name and rearrange by drag
([Navigate with the sidebar](https://www.notion.com/help/navigate-with-the-sidebar),
[sidebar guide](https://www.notion.com/help/guides/navigating-with-the-sidebar)).

Note what this *is not*: search and inbox are peers of Home inside the same rail, not
a second rail. This is the direct answer to problem 2.

**URL and routing.** Page ID lives at the end of the URL before any query string: a
32-character string, hyphenated 8-4-4-4-12
([Retrieve a page](https://developers.notion.com/reference/retrieve-a-page)).
`?p=<pageid>` opens a page in **peek mode**, so the peek state is itself
URL-addressable. `Cmd/Ctrl + L` copies the current page's URL. Database views expose
"Copy link to view" for "a direct link to the particular database view"
([Views, filters, sorts & groups](https://www.notion.com/help/views-filters-and-sorts)).

**Dashboard and home.** Home is explicitly *not* a settings page, and Notion **moved
it out of full-page into the sidebar**. Sections: Upcoming events, Recents,
Favorites, Agents, Teamspaces, Shared pages, Private pages, Notion apps. My Tasks,
Library, Marketplace, Help, and Trash are pinned at the bottom. Each section is
tunable via ••• → **Show** (how many items), **Move up/down**, **Hide section**,
**Customize sidebar**. Calendar events surface on desktop Home "along with related
docs and a link to join your next meeting"
([2.40 release](https://www.notion.com/releases/2024-06-11)).

Recents-first is the whole thesis: a returning user sees what they touched, not who
they are.

**List view (the library pattern).** One database, many views: "click through your
views to see your data in different ways." Seven layouts: Table, Board, Timeline,
Calendar, List, Gallery, Chart. Views nest under the database in the sidebar, marked
with a bullet (•). Isolation is explicit: "Settings applied to one database view
won't be applied across all other database views automatically."

The sharp bit for a newsroom: **filters and sorts are personal by default**.
Checking **"Save for everyone"** promotes them to the shared view config. Grouping
supports a second sub-group layer; groups can be manually sorted, hidden, or
emptied-filtered
([Views, filters, sorts & groups](https://www.notion.com/help/views-filters-and-sorts)).

**List-to-detail.** Three modes, **configurable per database, by the builder**:
••• → Layout → "Open pages as" → **side peek**, **center peek**, or **full page**.
Defaults are layout-aware: Table, Board, List, and Timeline open in side peek;
Gallery and Calendar open in center peek. The setting "affects everyone who uses the
database view" ([Notion HQ](https://x.com/NotionHQ/status/1651271572911718406),
[side peek release](https://www.notion.com/releases/2022-07-20)).

Inside a peek, `Ctrl+Shift+K` / `Ctrl+Shift+J` (Mac) or `Ctrl+K` / `Ctrl+J`
(Windows) move to previous and next entry, so you can walk a queue without returning
to the list. `Cmd/Ctrl + click` opens in a new Notion tab; `Option+Shift+click` opens
a separate window ([keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)).

**Status and workflow model.** The **Status** property mirrors Linear's: three fixed
**groups** — **To-do**, **In progress**, **Complete** — with custom options assigned
into them. Defaults are options "Not started", "In progress", "Done" under groups
"To-do", "In progress", "Complete". Every custom option carries a `group`; on update,
"if `group` is omitted... existing options keep their current group, and new options
use To-do when present"
([property object reference](https://developers.notion.com/reference/property-object),
[status property guide](https://www.notion.com/help/guides/status-property-gives-clarity-on-tasks)).
Board views group by Status by default ([Board view](https://www.notion.com/help/boards)).

Same lesson as Linear: **a small fixed spine, unlimited names inside it.**

**Command palette.** `Cmd/Ctrl + P` or `Cmd/Ctrl + K` (when the cursor is not in a
block) opens search. `Cmd/Ctrl + F` is scoped to the current page. On open it shows
**"a list of pages from your workspace that you've visited lately and when"** —
resume-oriented before you type. Quoted terms force exact match. Sort by Best Matches
(default), Last Edited, or Created; filter by Title Only, Created By, Teamspace, In,
or Date range. AI can "Search all sources."

The important limit: Notion's palette is a **navigator, not an actor**. "You can type
shortcuts like 'home' or 'settings' to jump to those areas, but it doesn't perform
direct actions within pages" ([Search](https://www.notion.com/help/search)). That is
the Notion-vs-Linear fork: Notion navigates, Linear navigates *and* mutates.

**Responsive behavior.** Mobile drops the sidebar for a persistent **bottom nav
bar**: home (Shared, Private, Favorites), search, inbox, create. Layout degrades
honestly: "There are no columns on mobile, and any column structure that you created
on desktop will be collapsed to a single column," and the full layout builder is
desktop and web only ([Notion for mobile](https://www.notion.com/help/notion-for-mobile),
[Layouts](https://www.notion.com/help/layouts)).

**Why it works, and the tradeoffs.** One rail carrying tabs (Home, Inbox, Search)
*and* content trees (Teamspaces, Shared, Private) means users never ask "which nav is
this in." Recents-first Home means resuming costs zero clicks. Peek-vs-full-page
being a *builder* setting per database means the right disclosure depth is a design
decision, not a user chore.

The tradeoff: Notion's flexibility is also its failure mode. Nothing is opinionated,
everything is configurable, and workspaces rot into unnavigable trees. It has no
built-in review or approval gate; Status is a convention, not an enforced workflow.

**Applicability to the NJ PBS admin CMS.** Copy the **"Open pages as"** decision
explicitly: an article list should open records in side peek (skim and triage many),
while a block-composed page should open full-page (deep single-record work). Make
that a per-content-type choice, not one global modal. And copy **Recents-on-Home**:
the returning editor's first screen is what they last touched, with role,
permissions, and billing demoted to a settings route.

**Sources.**

- <https://www.notion.com/help/navigate-with-the-sidebar>
- <https://www.notion.com/help/guides/navigating-with-the-sidebar>
- <https://www.notion.com/help/views-filters-and-sorts>
- <https://www.notion.com/help/keyboard-shortcuts>
- <https://www.notion.com/help/search>
- <https://www.notion.com/help/boards>
- <https://www.notion.com/help/notion-for-mobile>
- <https://www.notion.com/help/layouts>
- <https://www.notion.com/help/guides/status-property-gives-clarity-on-tasks>
- <https://www.notion.com/releases/2024-06-11>
- <https://www.notion.com/releases/2022-07-20>
- <https://developers.notion.com/reference/property-object>
- <https://developers.notion.com/reference/retrieve-a-page>
- <https://x.com/NotionHQ/status/1651271572911718406>

## Airtable

**Nav model.** Two distinct surfaces, worth separating.

*The home screen.* Sidebar with **Home** (refreshes and shows recently opened apps)
and **Starred** (workspaces, apps, interfaces; expandable dropdown, drag-and-drop
ordering), plus workspaces. Airtable rebuilt this because the old homescreen
"included irrelevant content and got extremely crowded quickly once users started
building their workflows." The fix: promoting recently accessed apps to the top,
starring, prominent aggregate search across workspaces, bases, and interfaces,
filters (shared-with-you, interface-only, base-only), and a dedicated page per
workspace with pinning ([Home screen](https://support.airtable.com/docs/airtable-home-screen),
[announcement](https://community.airtable.com/announcements-6/improvements-to-the-new-home-screen-1480)).

*Interfaces.* An interface is "a collection of pages that share access permissions,"
up to 50 pages each. The end-user left sidebar holds exactly five things: interface
dropdown, navigation links to pages, user account menu, notifications, share menu.
Critically: **"if the published interface only contains a single interface/interface
page... the navigation sidebar will not appear since you cannot navigate to another
page"** ([Interface Designer](https://support.airtable.com/docs/airtable-interface-designer)).
Airtable deletes the rail when it has nothing to do. That is the direct rebuke to two
decorative rails.

**URL and routing.** Fully typed and legible. Prefixes: base `app`, table `tbl`, view
`viw`, record `rec` ([Finding Airtable IDs](https://support.airtable.com/docs/finding-airtable-ids)).
A full record URL carries every level of the hierarchy:

```text
https://airtable.com/appSHwtnmVD5TiqSy/tblEzvkZks1VI3uyS/viwE3o43HKcqz6hFE/recbtRHd9o7vKZAQr
                     base              table             view              record
```

The view ID being *in the path* is the notable part: the URL remembers which lens you
were looking through, not just which record. Interfaces address records as
`https://airtable.com/appxxxxxxxxxxxxx/pagxxxxxxxxxxxxx/{RECORD_ID}`, constructible
in a formula field with `RECORD_ID()`
([record detail docs](https://support.airtable.com/docs/airtable-interface-layout-record-detail)).

**Dashboard and home.** Recently-opened first, starred second. No role or billing on
the landing surface. Per-workspace pages let teams pin "the most critical apps for
quick and easy access."

**List view (the library pattern).** The gold standard for many-lenses-one-dataset.
View types: grid, form, calendar, gallery, kanban, timeline, list, gantt. The toolbar
hides and shows fields, and filters, groups, sorts, and colors records.

The governance model is the part worth stealing. **Three collaboration types:**

| Type | Behavior |
|---|---|
| **Collaborative** | All base collaborators can see and edit the view's sorting, grouping, filtering |
| **Personal** | Only you can configure and edit |
| **Locked** | Nobody can change filters, field order, or visibility "until it's unlocked by someone with Creator or Owner permissions" |

Views organize into sections: My personal views, More personal views, My favorites,
More collaborative views
([Getting started with views](https://support.airtable.com/docs/getting-started-with-airtable-views)).

In Interfaces, builders define **named tabs that act as predefined filters**.
Airtable's own examples are literally **"Needs review"** and **"My tasks"**. Builders
can also expose dropdown filters; tabs let end users switch "view angle" without
building anything
([interface filter element](https://support.airtable.com/v1/docs/interface-element-filter),
[layout guide](https://support.airtable.com/v1/docs/adding-layouts-to-interfaces)).

**List-to-detail.** The clearest documented decision rule of the four products.
Record detail opens from List, Gallery, Kanban, Calendar, Timeline, or Grid when the
builder toggles **"Click into record details"**, in one of two modes:

- **Sidesheet (default).** A drawer slides in, the list stays visible, with
  sequential nav buttons. Recommended "when you expect collaborators to browse
  multiple records in the same workflow."
- **Full-screen.** Recommended "when you expect collaborators to focus deeply on one
  record at a time and not browse multiple records at once as part of their
  workflow."

Detail pages carry `⌄` and `⌃` buttons to step through records. A **Title field**
anchors the top "to help collaborators identify the record in question." Fields
organize into groups and **tabs** for "detail-rich pages containing many fields of
data." Different detail pages can serve the same table depending on which page you
arrived from
([record detail docs](https://support.airtable.com/docs/airtable-interface-layout-record-detail)).

**Status and workflow model.** Airtable has **no built-in workflow engine**. This is
its weakest axis and worth naming. Status is a single-select field; the workflow
emerges from kanban grouping plus view filters plus interface filter tabs ("Needs
review"). Nothing enforces transitions. **Locked views** are the closest thing to a
governance primitive.

**Command palette.** Shallower than Linear's, and split by scope.

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + K` | Quick base switcher (navigation only) |
| `Cmd/Ctrl + Shift + K` | View switcher for the current base |
| `Space` | Expand the active record |
| `Shift + Space` | Expand the active cell (arrow keys then move between cells) |
| `Cmd/Ctrl + Shift + <` / `>` | Previous/next record while expanded |
| `Cmd/Ctrl + /` | List all shortcuts |
| `Cmd/Ctrl + Enter` | Send text to Omni AI from the search field |

Source: [keyboard shortcuts](https://support.airtable.com/docs/airtable-keyboard-shortcuts).

**Responsive behavior.** Documented as an honest capability matrix, not a promise.
Supported on mobile: List, Kanban, Calendar, Gallery elements; Record overview,
Overview, Dashboard, Form, Grid layouts. **Not** supported: Timeline, Swimlanes.
End-user sorting is missing on iOS but present on Android. On iPad, **"full screen
record detail pages will not load"** — the documented workaround is configuring
record details as a sidesheet instead. Apps "may become slow or fail to load properly
when handling tens of thousands of records." Mobile is end-user only; you cannot build
there ([mobile interfaces](https://support.airtable.com/docs/mobile-interfaces-in-airtable)).

**Why it works, and the tradeoffs.** Typed IDs in the path make every object
trivially linkable and debuggable. Personal, Collaborative, and Locked cleanly solve
"my filter broke everyone's view," the perennial shared-CMS bug. Sidesheet-vs-
fullscreen is decided by *predicted user behavior*, which is the right question.

Tradeoffs: no real workflow model; the home screen redesign drew genuine user
complaints about being confusing; and building has moved far enough from data that
"where do I change this?" is a live problem.

**Applicability to the NJ PBS admin CMS.** Take **view ID in the URL path**
(`/articles/viw.../rec...` shape) so a bookmark restores the lens *and* the record.
Take **Personal / Collaborative / Locked** as the answer to a newsroom where a
producer's ad-hoc filter must not mutate the desk's shared queue. Take the **named
filter tabs** ("Needs review", "My drafts") as the content library's top-level
chrome: it is the cheapest possible status-driven UI.

**Sources.**

- <https://support.airtable.com/docs/airtable-interface-layout-record-detail>
- <https://support.airtable.com/docs/airtable-interface-designer>
- <https://support.airtable.com/docs/getting-started-with-airtable-views>
- <https://support.airtable.com/docs/airtable-keyboard-shortcuts>
- <https://support.airtable.com/docs/finding-airtable-ids>
- <https://support.airtable.com/docs/mobile-interfaces-in-airtable>
- <https://support.airtable.com/docs/airtable-home-screen>
- <https://support.airtable.com/docs/airtable-interface-layout-overview>
- <https://support.airtable.com/v1/docs/interface-element-filter>
- <https://support.airtable.com/v1/docs/adding-layouts-to-interfaces>
- <https://community.airtable.com/announcements-6/improvements-to-the-new-home-screen-1480>

## Retool

The closest genre analog, and the one that answers "what does an admin panel's IA
*actually* look like" with specs rather than taste.

**Nav model.** Composed from **frames**, with an explicit global-vs-page scoping rule.

| Frame | Spec | Scope |
|---|---|---|
| **Main** | "Takes up the entire canvas area by default" | — |
| **Header** | Top-of-app; initially contains a Navigation component for horizontal nav | **Global**, persists across pages |
| **Sidebar** | **Fixed 240px width**, positioned left of Main; initially Image (logo), Navigation, Avatar | **Global**, persists across pages |
| **Modal** | Popup, for information or auth flows | Page-scoped |
| **Drawer** | Slides into view; **multiple independent instances** | Page-scoped |
| **Split Pane** | Resizable canvas adjacent to Main; **only one instance** | Page-scoped |

"Header and Sidebar are globally scoped across pages, while Modal, Drawer, and Split
Pane are page-scoped" ([frames guide](https://docs.retool.com/apps/guides/layout-structure/frames)).

The **Navigation** component defaults to horizontal, supports vertical "to display a
navigation menu alongside content, such as within the Sidebar frame," auto-populates
from `{{ retoolContext.pages }}` with Label defaulting to the page's title, and
permits **exactly one level of dropdown nesting**: "child menu items cannot also be
parent menu items"
([navigation guide](https://docs.retool.com/apps/guides/interaction-navigation/navigation)).

**Read that as a verdict on problem 2:** Retool ships one global nav frame, one
Navigation component, one level of nesting. There is no second rail in the pattern.

**URL and routing.** The most explicit spec of the four. Apps live at
`https://example.retool.com/app/users`.

- Search params: `?role=viewer&team=workplace&q=chic`
- Hash params: `#enabled=true`, and "hash parameters must be after query strings"
- Combined: `https://example.retool.com/app/customer-dashboard?q=chic&role=viewer&team=workplace#enabled=true`

Params are **page-scoped**: "only accessible from the page specified in the URL."
Read them off the `url` object: `{{ url.searchParams.q }}`,
`{{ url.hashParams.enabled }}`. Write them at runtime:

```javascript
utils.setUrlParameters({
  queryParams: [
    { key: 'role', value: 'viewer' },
    { key: 'team', value: 'workplace' },
  ],
  hashParams: [
    { key: 'enabled', value: 'true' },
  ],
});
```

Changes are "reflected immediately in the `url` object and in the browser's address
bar without triggering a page reload." A **Persist URL Parameters** setting in the
Inspector keeps params across page navigation and "Go to Page" event handlers.

The documented purpose is precisely NJ PBS's problem 1: configure page URL params to
reference values and update the URL whenever they change, which "allows users to link
to an app's current state, **such as a selected table row**"
([URL parameters](https://docs.retool.com/apps/guides/app-management/url-parameters)).

Multipage also buys performance: "Retool only evaluates code and components for the
current page," worth 30–40% ([multipage apps](https://docs.retool.com/apps/guides/multipage)).

**Dashboard and home.** Retool has no prescribed home. Its guidance for a first app is
anti-dashboard: **"Start simple with your first app: one table to display data, one
form to add or edit records."** Charts and filters come later
([build guide](https://retool.com/resources/how-to-build-an-app-in-retool)).

**List view (the library pattern).** The **Table** component is "the workhorse of
internal tools." It "enables users to sort, filter, paginate, and download rows of
information," plus row selection, adding new rows, editable columns, row grouping by
column, **expandable rows containing nested components**, a customizable toolbar with
row action buttons, server-side pagination, and automatic ID-column detection for
primary keys. Selected row is referenced as `{{ table1.selectedRow }}`
([Table guide](https://docs.retool.com/apps/guides/data/table)).

**List-to-detail.** Retool names the pattern outright: **"This master-detail pattern
is extremely common in internal tools — show a list in a table, let users select a
row, then display full details in a drawer or modal."** The wiring is documented
literally:

> Component: Table → Event: Row select → Action 1: Control query →
> `getCustomerDetails` → Trigger (pass `{{ customerData.selectedRow.id }}` as a
> parameter) → Action 2: Control component → `drawer1` → Open

The three container choices are differentiated by constraint, which is the useful
part:

- **Drawer.** "Slides into view when visible," **multiple independent instances
  allowed**, triggered by event handlers on Button, Table, or List View. "Within
  tables, the use of a Drawer Frame can be advantageous to expose details of a table
  row, where double-clicking a table row can cause the drawer to slide open."
- **Split Pane.** "A resizable canvas adjacent to the Main frame... to display a
  detail view relative to the main frame or split the app for multitasking."
  Positionable left or right, controlled via `show()` / `hide()` / `setHidden()`, and
  **"only one instance of Split Pane can be used."**
- **Modal.** A popup, for information or auth flows.

**Tabbed containers** organize a detail into "Overview," "Details," "History"
([frames](https://docs.retool.com/apps/guides/layout-structure/frames),
[Split Pane](https://docs.retool.com/apps/reference/split-pane),
[Drawer](https://docs.retool.com/apps/reference/drawer),
[build guide](https://retool.com/resources/how-to-build-an-app-in-retool)).

**Status and workflow model.** None. Retool is workflow-agnostic: status is whatever
column your database has, rendered as a tag and mutated by an action button. Nothing
to steal here; take the status spine from Linear and Notion instead.

**Command palette.** No user-facing Cmd+K in built apps. Retool's answer to fast
retrieval is the Table's own search, filter, and sort plus URL params, meaning **a
palette is not load-bearing for the admin-panel genre**. Treat it as an accelerant
for NJ PBS, not the entry point.

**Responsive behavior.** The most concrete numbers of the four. Classic apps **switch
to mobile layout when the viewport is under 600px wide**; the mobile layout uses a
narrower **12-column grid**. Desktop and mobile share the same component but position
it independently: "any changes you make to a component's settings, such as labels or
event handlers, apply to both views." Components opt in per-layout via Inspector →
Appearance → Advanced settings → **Show on mobile**.

The Sidebar handles narrow screens without a redesign: it "is hidden by default when
viewed on a mobile device and is accessible using a menu button that is automatically
included, and when pressed, the Sidebar frame slides into view"
([mobile layouts](https://docs.retool.com/apps/guides/layout-structure/mobile-layouts),
[frames](https://docs.retool.com/apps/guides/layout-structure/frames)).

**Why it works, and the tradeoffs.** Retool encodes the admin-panel genre as a small
vocabulary — one global nav frame, a table, a detail container, a form — and then
makes the *containment* decision explicit: drawer means many, split pane means one,
modal means interrupt. Its URL model is the strongest documented case that admin state
belongs in the address bar.

Tradeoffs: no opinion on IA beyond "here are components." "Every admin panel is
unique, but they share a bunch of core elements" is as far as they will commit. No
workflow model. The one-Split-Pane limit forces you to pick a primary detail surface
per app, which is arguably a feature.

**Applicability to the NJ PBS admin CMS.** This is the blueprint for the shell: **one
global Sidebar frame (~240px) plus a Main frame that swaps per route**, with the
current record in the URL — Retool's mechanics over Airtable's shape
(`?status=needs-review&q=trenton` for the filters, the record in the path as Airtable
puts it), so a bookmark restores the library filter *and* the open record. Note that
this is a deliberate hybrid: no single tool here documents both halves. Pair the article, program, and
event list with a **drawer** for quick triage-and-edit of many records, and reserve
**full-page** for block-composed pages — matching Airtable's sidesheet-vs-fullscreen
rule with Retool's containment mechanics.

**Sources.**

- <https://docs.retool.com/apps/guides/app-management/url-parameters>
- <https://docs.retool.com/apps/guides/layout-structure/frames>
- <https://docs.retool.com/apps/guides/layout-structure/mobile-layouts>
- <https://docs.retool.com/apps/guides/interaction-navigation/navigation>
- <https://docs.retool.com/apps/guides/data/table>
- <https://docs.retool.com/apps/guides/multipage>
- <https://docs.retool.com/apps/reference/split-pane>
- <https://docs.retool.com/apps/reference/drawer>
- <https://retool.com/resources/how-to-build-an-app-in-retool>
- <https://retool.com/use-case/admin-panels>

## Cross-cutting patterns

**On the two-rail problem (2).** All four ship exactly one nav rail. Notion is the
sharpest counter-model: search, inbox, and home are tabs inside the same rail as the
content tree, so nothing looks like a sibling nav. Airtable goes further and deletes
the sidebar entirely when an interface has one page. Retool's spec is one Sidebar
frame at 240px with one Navigation component and one level of nesting. The
content-type rail should become either sidebar rows under a section header (Linear's
team pattern, with hover sub-menus for sub-views) or named filter tabs on the library
itself (Airtable's "Needs review" pattern).

**On URLs (1).** Retool documents the mechanics: filters in query params, the selection
in query or hash params, `setUrlParameters()` writing to the address bar with no
reload, and a persist flag across navigation. Airtable documents the shape that puts
the record in the path, and proves the URL should carry the *view*, not just the
record. Linear proves the UX payoff (copy the address, share the filtered view). The
recommendation above combines Retool's mechanics with Airtable's shape; that
combination is this briefing's inference, not a pattern either tool documents whole.

**On home (3).** Two of four lead with recents: Notion and Airtable, the latter of which
rebuilt its home *specifically* because it was crowded with irrelevant content. Linear
sorts by urgency rather than recency, and Retool prescribes no home at all. Role,
permissions, and billing belong at a settings route in all four.

**On list-to-detail (feeds 4 and 5).** The decision rule is behavioral, and Airtable
states it best: sidesheet when users browse many records in one workflow, full-screen
when they focus deeply on one. Linear adds a cheaper tier below both (Space to peek,
arrows to walk the queue). For NJ PBS that maps cleanly: drawer or peek for article
triage, full page for block-composed pages.

**On status (5).** Linear and Notion independently converged on the same shape: a
small fixed spine of categories (7 and 3 respectively) with unlimited team-named
statuses inside, where the category drives behavior (defaults, auto-close, board
grouping) and the name is just vocabulary. That is the model for Draft → Needs review
→ Scheduled → Published, and it is what turns save, preview, and publish from three
orphaned buttons into one workflow.

**The caution.** The strongest source on Linear says copying its aesthetics without
its reasoning "is why most clones feel hollow," and that keyboard-first assumes an
audience with editor muscle memory. NJ PBS's editors and producers are not that
audience. Take Linear's URL model, status categories, and peek; make every keyboard
path optional.

## Design considerations

- Peek and full-page views can be selected per content type, such as articles,
  programs, events and pages.
- Personal and shared saved views serve different workflows. A
  Personal/Collaborative/Locked split adds complexity and is useful when users
  need ad-hoc filters.
- Status categories such as Draft, Needs review, Scheduled, Published and Archived
  can group more specific desk terminology.
- A command palette is optional for an admin panel. Routing, the library and the
  status model provide its underlying destinations and actions.
