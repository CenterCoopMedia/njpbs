# Newsroom CMS admin UX research

Research into how newsroom and publisher CMS platforms handle admin and editing UX,
gathered to inform the NJ PBS admin redesign. Every finding cites a source. Where a
claim is inferred rather than documented, it says so.

The strongest evidence here is primary rather than editorial. The Guardian open-sources its
editorial tools, so its status model, filters, routing, and dashboard are read from
production source code rather than from a vendor's marketing copy. Arc XP's operator docs
are public, quotable verbatim, and include real screenshots. NYT has detailed engineering
writeups. For the two targets with almost no published prose — BBC and Vox Chorus — the
findings were recovered instead from **archived CSS bundles, Wayback URL indexes, and a
recorded product demo**, which is why those sections carry routing and layout detail their
public writeups never contained. Confidence is uneven and labelled throughout: read
"documented" as quotable, "inferred" as reasoned from structure, and "not found" as a real
negative after real search effort.

Three caveats worth reading before the sections themselves:

- **Nobody solved "my work."** Every platform derives it from a filter instead of giving it
  a place. The one exception is a 2010 Windows desktop app.
- **Shared team views and bulk actions are absent almost everywhere.** If NJ PBS wants
  either, there is little prior art to copy.
- **Two of the five targets have no publicly known workflow stage names at all**, and a
  third (Arc XP) turns out to have no platform-level enum — only customizable defaults. Only
  the Guardian's and BBC's are fully documented.

## Summary of what transfers

Five design questions organize the findings:

| Design question | What the research says |
|---|---|
| Routing, bookmarking, and resuming work | Put list view state in the query string and give every story its own URL. The Guardian, Arc XP, Vox Chorus, and BBC Optimo all do this — four of the five targets, plus LA Times SNAP as a bonus site. NYT's routing is not documented, so nothing counts against it. The strongest convergence in the research. |
| Navigation hierarchy | **No newsroom tool reviewed uses two vertical rails, and one of them uses none.** The pattern is one filter rail plus a horizontal scope bar. BBC Optimo is horizontal nav with no sidebar at all. |
| Home screen priorities | No newsroom tool opens on permissions. The models are a filtered work queue, an auto-built "stories you touched" list, or a search screen. |
| Content library | The library *is* the product. Faceted filters, sticky or saved views, and status-grouped lists. |
| Save, review, and publish workflow | Status change is the workflow event. It triggers tasks assigned to a group, not a person. |

Three findings recur across every platform that documents the relevant behavior, and are
the most transferable:

1. **Status is a first-class, colored, filterable field**, changeable from the list without
   opening the story.
2. **Review work is assigned to a group or desk, not an individual**, and whoever is on
   shift claims it. The Guardian, Arc XP, and NYT all land here independently.
3. **Preview is always reachable from the story, never a step after publish.** Two shapes:
   a separate addressable surface keyed to the story path (Guardian, Vox Chorus, Arc XP), or
   the editing surface itself rendering what readers will see (NYT Oak, LA Times SNAP). BBC
   holds the strongest version of the argument — CPS was **deliberately not WYSIWYG**
   because "in a world where you are publishing to many platforms… WYSIWYG becomes a
   pointless feature **but there are previews showing the output**." Structure in the editor,
   fidelity in the preview.

One more, on rollout rather than design, from the only team that documented replacing a
newsroom editor people already used: **Vox ran the new editor in parallel with the old one
and never forced a migration**, disabling the old one "only after it had been abandoned —
like turning off the lights in a bar only after the last customer had shuffled out." When
they finally switched it off mid-workday, "it took 24 hours for the first user to notice."
A parallel rollout can preserve uninterrupted editorial work.

## The Guardian

The best-documented target, because the tools are open source.

- **What's publicly known:** A lot, and it is primary source. `workflow-frontend` (the
  story tracker), `editorial-tools-pinboard` (collaboration), `editorial-viewer`
  (preview), `atom-workshop`, and `flexible-restorer` are public repos with READMEs,
  source, and a dashboard screenshot. Composer itself (`flexible-content`) is **no longer
  public** — that repo now 404s — so the editor internals are inferred from how other
  tools link into it.
- **Nav model:** No vertical nav rail at all. `dashboard.html` is literally two panes: one
  `.sidebar` (filters) and one `.content-list-column`. Scope selection lives in a
  horizontal toolbar of dropdowns: Office (UK/US/AU) | Desk | Sections | Show | Search,
  with a blue "Create new" button top right. The left rail is a *filter* surface, not
  navigation.
- **URL/routing:** One route only — `$stateProvider.state('dashboard', {url: '/dashboard'})`
  — and `public/app.js` still carries the comment `// TODO: remember user's state and
  redirect there on default '' route`. But this is the nuance that matters: **all filter
  state is synced to the query string**. `filters-service.js` reads `$location.search()` on
  load and writes back with `$location.search(key, value)` for `status`, `state`,
  `section`, `content-type`, `atom-type`, `flags`, `prodOffice`, `created`, `deadline`. So
  a filtered view is bookmarkable and shareable even though there is one route. Individual
  stories are not routes in this app at all — they live in Composer, at their own URL, in
  a new tab.
- **Dashboard/home:** The dashboard *is* the product. No home screen, no permissions
  summary. It opens on a filterable, real-time list of everything in production, with
  presence indicators showing who else is viewing the same content.
- **Content list / library:** A dense table grouped by status, with **section headers that
  carry counts and render even at zero**: `WRITERS 2`, `DESK 1`, `PRODUCTION EDITOR 0`,
  `SUBS 1`, `REVISE 0`, `FINAL 1`, `HOLD 1`. The whole pipeline is visible at once.
  Columns are user-reorderable (`column-defaults.js`, persisted per user) and include
  working title/headline, byline, notes, syndication, Pinboard, office, deadline, section,
  status, status in print, commissioned length. Sidebar filter groups: Status, Your
  Content, Content type, Atom type, Created, State, Flags, Deadline, InCopy, Print Info,
  Main Media, Syndication, Trashed.
- **List-to-editor relationship:** Separate apps, opened in a new tab. Each row carries
  three icon links — `links.composer`, `links.preview`, `links.live` — each
  `target="_blank"`. Notably, **status is a `<select>` inline in the row**, so an editor
  advances a story through the pipeline from the list without opening it.
- **Editorial workflow:** The real enum, from `common-lib/src/main/scala/models/Status.scala`:

  ```text
  Writers → Desk → ProductionEditor → Subs → Revise → Final     (+ Hold)
  ```

  `Subs` is the copy desk. This is the actual copy-edit/revise cycle, in production. A
  separate, orthogonal content state enum (`ContentState.scala`) covers
  `draft | published | takendown | scheduled | embargoed`. Two axes, not one: *where it is
  in the newsroom* and *what the public sees*. Legal and picture-desk sign-off are **flags**,
  not stages: `needsLegal`, `legalApproved`, `needsPictureDesk`, `pictureDeskChecked`.
- **My queue vs desk vs everything:** Not separate destinations. It is filter facets on one
  list. A "Your Content" sidebar group offers "Assigned to you" (`assigneeEmail`) and
  "Edited by you" (`touched`); Desk is a toolbar dropdown; everything is the cleared state.
- **Preview:** A separate service, `viewer.gutools.co.uk`, with its own per-story URL scheme
  mirroring the live path: `/preview/{articlepath}` and `/live/{articlepath}`.
- **Pinboard** is the connective tissue and the most interesting idea here. It is injected
  by script tag into Composer and Grid so it rides along inside other tools rather than
  being a destination. Its model:
  - **"My pinboards"** is auto-built from stories "which you have opened or sent messages
    in, or, have been @mentioned" — a resume-your-work list derived from activity, not from
    manual assignment. Separate from **"My teams' pinboards"**.
  - **Requests**: "To raise a request, you will need to mention a team. Individuals within
    the team will be able to claim a request… **You won't need to know who's on shift to
    make a request.**"
  - The schema is radically simple: a request is just a message row with
    `claimable BOOLEAN` and `claimedByEmail`. No separate task entity, no state machine.
- **Command palette:** None. A code search for keyboard/hotkey handling in
  `workflow-frontend` returns zero hits. The command palette is not an established newsroom
  CMS pattern.
- **Why it works / tradeoffs:** The Guardian's answer to fragmentation is many small
  single-purpose apps, each on its own subdomain with its own per-content URL, unified by
  pan-domain auth and by Pinboard riding inside all of them. That is a mature, expensive
  architecture NJ PBS should not copy wholesale. The transferable parts are the URL
  discipline, the claimable-request idea, and the two-axis status model as prior art.
- **Applicability to NJ PBS:** The lifecycle enum is `draft | in_review |
  scheduled | published | archived` in `site/src/lib/editorial-workflow.ts`.
  Read the Guardian's two axes as prior art that explains *why* one enum strains rather
  than as a schema proposal: "who is holding this?" and "is it out?" are different
  questions, and the Guardian answers both in the data model. NJ PBS can answer the
  first with assignment and saved views over the landed enum, which costs no migration
  and no workflow rewrite. What transfers directly: the status-grouped list with
  zero-count headers, and inline status change from the row. A single `/dashboard`
  route with filters in the query string provides bookmarking without requiring
  separate routes for every view.
- **Sources:**
  - <https://github.com/guardian/workflow-frontend>
  - <https://raw.githubusercontent.com/guardian/workflow-frontend/main/docs/assets/workflow-demo.png> (dashboard screenshot)
  - `Status.scala`, `ContentState.scala`, `filter-defaults.js`, `filters-service.js`, `column-defaults.js`, `app.js`, `dashboard.html`, `dashboard-toolbar.html`, `content-list-item/templates/{title,links}.html` in the above repo
  - <https://github.com/guardian/facia-tool> (Fronts, homepage curation)
  - <https://github.com/guardian/editorial-tools-pinboard> (and `client/src/tour/tourStepMap.tsx`, `shared/database/local/setup/012-AddClaimColumnsToItemTable.sql`)
  - <https://github.com/guardian/editorial-viewer>
  - <https://github.com/guardian/atom-workshop>
  - <https://github.com/guardian/flexible-restorer>
  - <https://theguardian.engineering/blog/info-2019-may-10-structured-content-benefits-for-creating-and-publishing-articles>

### Fronts (homepage curation)

Relevant if NJ PBS ever curates its own homepage shelves.

- Editors drag stories from the Content API feed into **collections/containers** on a
  front. Containers are shared between fronts — "an update to a container in one place
  updates it everywhere."
- Fronts are staged, then **launched**; a separate service (Facia-Press) presses them live
  via an SNS topic. Curation and publication are decoupled.
- Ophan page-view data is pulled into the UI so editors judge a story's performance in the
  context of the front it sits on.
- Source: <https://github.com/guardian/facia-tool>

## The New York Times

- **What's publicly known:** Good depth on the editor (Oak) and the CMS philosophy
  (Scoop), thin on the dashboard and list UI. The 2014 Scoop post is the primary source and
  is candid about its own failings.
- **Nav model:** Not documented for Scoop's list view. What *is* documented is the Times'
  verdict on its own legacy editor's navigation, and it is the single most relevant quote
  in this whole document: the old editor "heavily compartmentalizes that workflow,
  separating different parts of a story (e.g. text, photos, social media and copy-editing)
  into completely different parts of the app. Producing an article in this older editor
  therefore requires navigating through a lengthy series of unintuitive and visually
  unappealing tabs."
- **URL/routing:** Not documented.
- **Dashboard/home:** Story budgeting and planning is a separate tool that was integrated
  into Scoop and is "often the first step before an article or other type of content is
  created." Notably, the newsroom *refused* analytics in the CMS: "At the newsroom's
  request, we have never integrated that data back into Scoop" — a position they said in
  2014 was starting to shift.
- **Content list / library:** Not documented publicly.
- **List-to-editor relationship:** Not documented.
- **Editorial workflow:** Scoop is explicitly **role-based**: "Unlike many simpler systems
  where a journalist can single-handedly take an article all the way from inception to
  publication, Scoop is role-based to reflect the segmentation of duties and the checks and
  balances in our newsroom." The canonical flow: "a reporter writes text, a copy editor
  writes a headline and summary, a photo editor selects the images and a producer puts it
  all together."
  - **Multiple concurrent drafts per article, each with its own workflow position** — "a
    live version of an article, a version where minor edits are being made, a version where
    the story is going through major updates and a print-specific version… Each of those
    drafts can go through our editing workflow steps independently and then become the
    published version."
  - **Notifications on workflow state change**, customizable: "copy editors who want to know
    when a particular story is ready for review."
  - **Locking with a "knock"**: field groups are locked; another editor can knock, which
    notifies the lock holder and offers to release it.
  - **Private articles**: mark an article private and restrict by user or group.
- **Preview:** "Scoop has always supported a pixel-perfect preview of what unpublished
  content will look like on NYTimes.com," later joined by a mobile render panel in the same
  preview screen.
- **Oak (the editor):** Built on ProseMirror to replace the tabbed legacy editor, so that
  "reporters and editors alike could see exactly what a story would look like before it
  publishes" — preview collapsed into the editing surface itself. Collaborative editing was
  added in 2019 using **Firestore as the authority server** for ProseMirror steps, with
  Firebase for cursor presence. A designer's case study documents **"stashing"** — hiding
  text in the body during collaboration so it is not published, used to ask for evidence or
  park text for later.
- **Why it works / tradeoffs:** The Times' honest self-criticism is the useful part. They
  concluded that role-segmented compartmentalization was both their strength (checks and
  balances) and their UX problem (tab mazes), and that Scoop "does not do a good job of
  accommodating writers who want to do all of those things themselves."
- **Applicability to NJ PBS:** Two things. First, the Firestore-as-authority-server pattern
  is directly relevant, since the NJ PBS admin is already Firebase-backed. Second, the
  anti-pattern warning: Separate content-type regions can repeat the navigation pattern that produced
  the Times' tab maze. Compartmentalizing a story into separate app regions is the thing
  they rebuilt to escape.
- **Sources:**
  - <https://web.archive.org/web/20160831084710/http://open.blogs.nytimes.com/2014/06/17/scoop-a-glimpse-into-the-nytimes-cms/> (primary; the live URL redirects)
  - <https://www.niemanlab.org/2014/06/heres-the-scoop-looking-under-the-hood-of-the-new-york-times-content-management-system/>
  - <https://web.archive.org/web/20250122061430/https://open.nytimes.com/building-a-text-editor-for-a-digital-first-newsroom-f1cb8367fc21>
  - <https://web.archive.org/web/20240810042524/https://open.nytimes.com/we-built-collaborative-editing-for-our-newsrooms-cms-here-s-how-415618a3ec49>
  - <https://discuss.prosemirror.net/t/how-we-went-about-prosemirror-collab-at-the-new-york-times/2119>
  - <https://karinanguyen.com/projects/oak/> (design case study, stashing)
  - <https://digiday.com/media/standing-mobile-starts-cms-tweaks/>
  - <https://nytimes.github.io/oak-byo-react-prosemirror-redux/>

## Arc XP

- **What's publicly known:** A lot, and unusually useful — the operator docs are public and
  include annotated screenshots. This is the most directly comparable target, since it is a
  commercial product a station like NJ PBS could actually be sold.
- **Terminology correction:** **ANS is the *Arc Native Specification*, not the "Arc News
  Schema"** — that phrase appears zero times in 807 pages of docs. Arc is inconsistent with
  itself (dev.arcxp.com says "Arc Native Specification," docs.arcxp.com says "Arc XP Native
  Specification"), which is itself a lesson about naming discipline.
- **Nav model:** One horizontal top bar (Stories | Settings | Templates, with an
  environment chip reading "Production" and the user menu at right) plus one left filter
  rail. No second vertical rail. In **Composer 2.0** (default since Jan 2025; current
  version 2.9.11) the editing surface is "a new **story details pane**" housing the
  Planning, Metadata, Featured Media, Related items, Variants, and Clipboard tabs, next to
  an "**editor pane (formerly the Compose tab)**" that "allows for a side-by-side view."
  **WebSked actions were consolidated to the top bar** rather than the right sidebar, though
  collection, pitch, and task actions still appear in a right sidebar. Net shape: main
  editor pane + story details pane + a residual right sidebar.
  *Doc drift warning:* `navigating-composer.html` still describes the 1.0 "Compose tab" and
  a "Circulate tab" that no longer exist. The 2.0 page is authoritative.
  WebSked's own left rail is a **filter rail, not app nav**: funnel (filters), bookmark
  (saved searches), beaker (advanced). Its app nav is a top menu — Planning, Tasks,
  Publications, Collections, Statistics.
- **URL/routing:** Per-story URLs, confirmed from the browser extension's literal bookmarklet
  source: `arcAdminBaseUrl + '/composer/edit/' + gc._id + '/'`, i.e.
  `https://<org>.arcpublishing.com/composer/edit/<story-id>/`. Sandbox is a **host prefix**
  (`sandbox.<org>.arcpublishing.com`), which is a tidy way to keep environments from
  polluting routes. Two inconsistencies worth not copying: galleries use a query param
  (`/photo/gallery-edit/?id=<id>`), and video is **hash-routed off a different key entirely**
  (`/goldfish/video/v2/#/clip/<videoId>` — `additional_properties.videoId`, not `_id`).
  **WebSked has no bookmarkable UI routes at all** (`/websked/stories?id=` is an API path,
  not a UI one) — so Arc solved routing for stories and never solved it for planning.
- **Dashboard/home:** WebSked's landing page is a **statistics dashboard** — published
  content metrics, story counts, pitch counts, workflow analytics. Worth flagging as a
  cautionary example: it leads with measurement, not with resuming work. Composer, by
  contrast, opens directly on the story search page.
- **Content list / library:** Composer's Stories search page is left filter rail + story
  **cards** (not a table). Each card: headline, dek, then Workflow status | Last modified |
  Published or "Not published" | Authors | Source. Filters: website, section, created /
  published / last modified with Yesterday/Today/Now/Tomorrow quick chips, author,
  headline, source, subtype, workflow status, and a "Show only published" toggle. The
  **Author** filter autocompletes from the Author Service (including guest authors);
  **Source** distinguishes "Composer, an ingested wire feed or another CMS"; **Subtype**
  filters "by rendering template." Sort covers created / last updated / publish / display /
  **relevance** (which boosts `headlines.basic` over `subheadlines.basic` over `slug` over
  body). Search toggles **term vs. ID** and queries 13 named ANS fields including
  `planning.budget_line`, `corrections.text`, `taxonomy.tags.text`, and `credits.by.name`.
  **Filters are sticky, and more aggressively than I first recorded** — verbatim: "The
  Composer search sort and filters are **sticky**, meaning that we will remember your search
  parameters **even if you navigate away or log out of Arc**." That is the state-persistence
  answer without a routing change, though it trades away shareability.
  **Documented limits:** "Composer search **does not currently support Boolean operators or
  wildcard searches**"; multi-term queries are **OR**. **Saved views: not found. Bulk
  actions: not found. Personal queue: not found** — there is no "my stories," only the
  Author filter. Composer is "everything plus filters."
- **List-to-editor relationship:** Card headline links to the story's own route in the same
  app — **a full page, not a modal**: "choose **Save and exit** to save the story and return
  to the Composer search screen." Modals are used only *within* the editor.
- **Editorial workflow — and the correction that reframes the question.** There is **no Arc
  workflow enum at platform level.** Verbatim: "While your organization sees three default
  workflow statuses associated with your account — **Draft, Edit, Publish** — these statuses
  are **customizable per your organization's needs**. Some organizations might use four or
  five statuses… and others might need **over a dozen**." So `Draft/Edit/Publish` are seed
  defaults, not the answer to "what are Arc's statuses." Anyone stating Arc's statuses as a
  fixed list is describing one tenant.
  Each status has ID, Display order (recommended in increments of 10), Name, and **Color
  (hex)**. The screenshot shows DRAFT in blue, EDIT in orange, and a configured READY TO
  PUBLISH in green. Config lives in **WebSked**, not Composer (`profile > Company >
  Schemas`), and "For the Workflow states to appear, you must have the **WebSked integration
  enabled**." The docs' own worked example adds a fourth status — **"Backread," "for when the
  story is already live on the site but needs a backread"** — which is a good reminder that
  post-publish review is a real newsroom stage.
  **Status changes are manual, by design:** "these status changes are **manual. No events
  (like save and publish) automatically trigger a change in the workflow status.**" The
  control is "**Workflow Status and Note**" — the status carries a note that propagates onto
  the auto-created task.
- **Four unrelated status enums, plus circulation — the main modeling trap.** Conflating
  these is the mistake Arc's own surface area invites:
  - **Workflow status** — customer-defined, WebSked-owned, manual (above).
  - **Publish status** — system-owned, not editable: `Live/Published`, `Scheduled`,
    `Planned`. **Video Center uses a different enum entirely**: "create" (being edited),
    "ready" (encoded but not published), "published" — and "**These are not editable, like
    'workflow status'.**" Encoding is a *third* pipeline: Encoding → Submitted → Completed.
  - **Task status** — `Group Assigned`, `User Assigned`, `Claimed`, `Rejected`, `Completed`.
    (No documented action produces `Rejected` — treat as unverified.)
  - **Pitch status, twice, incompatibly** — platform pitches use `Pitched`, `Withdrawn`,
    `Not watching`, `Watching`, `Saving`, `Used`; publication pitches use `Pitched`,
    `Booked`, `Declined`. **Only `Pitched` is shared.** Platforms decline via `Not watching`,
    publications via `Declined`.
  - **Circulation** — an orthogonal axis and a **publish prerequisite**: "the system
    **requires you to circulate the story to one or more websites before publishing**,"
    because "the website and section will be part of that content's URL."

  **No unified "what is live" view exists across the five.** PageBuilder adds a fifth,
  unrelated model.
- **A leaky abstraction Arc documents and works around — do not inherit it.** Stories created
  via the Draft API can exist **uncirculated**, because there the circulation requirement is
  asynchronous. Verbatim: "In Composer, any uncirculated stories are findable under the
  default website. **Uncirculated stories are not actually associated with the default
  website. They just appear as if they are.**" Arc's recommended fix is a **decoy website**:
  "we recommend naming the website something that reflects its purpose, like
  **Uncirculated**." A CMS advising you to create a fake site to hold records its own model
  can't express is a design smell worth recognizing on sight.
  - Arc's own sizing advice is worth quoting for NJ PBS: "We recommend starting with fewer
    workflow statuses and expanding as needed rather than creating too many at once.
    Consider capturing *75%* of your common content workflow touchpoints and using separate
    tasks and templates for less frequent activities."
  - **Tasks** are the review mechanism: "formally request your team to perform a specific
    action to get your content ready for distribution… Tasks also provide a system of
    records to see who has worked on what." Assigned to an individual **or a group**.
    Created **automatically** by status-change triggers, or manually from Composer or
    WebSked. The documented scenario: when a story moves *Draft → Review*, WebSked auto-
    assigns the editors' group a review task. Named examples are copy editing, legal
    review, and comment moderation — the newsroom-specific stages.
  - **Pitching**: writers pitch content to platforms (homepage, social), publications
    (time-bound editions like a newsletter), or collections (feeds). Curation is a separate
    act from writing.
  - **Groups are deliberately memberless — and this is the sharpest detail in the section.**
    Verbatim: "**Groups do not have members and no user management is required.** Instead,
    users can join the appropriate Slack channel or email distribution list… Users can also
    **navigate directly to the Group's task queue**." And: "**WebSked groups are not linked
    to Arc XP's permission groups or Okta settings**." Groups are built around "**desks
    (Sports, Local), roles (Photo, Editors)**." The cost: "the **only person who can claim a
    task is the person who it is assigned to**," and *inferred* — Arc routes awareness
    through **notifications rather than views**. There is no in-app inbox and no
    assigned-to-me tile.
  - **Templates**: "Create story" offers starred templates, a blank story, a default
    template, or browse-all — pre-populating section, tags, author.
- **Preview: a separate tab, not inline.** "You click the **Preview Story** button, which
  takes you to the **preview URL**. The preview URL is a **PageBuilder URL** that contains
  the story's ID." External sharing uses a `/preview-arc` path and is **not cache-cleared**.
  Separately, **View Draft** is "the **eye icon**, in the top left toolbar."
- **Concurrency — lock / knock / takeover.** A load-bearing mechanic with unusually thin
  docs (glossary-only, no procedure page): "**lock** — only its creator has access to edit
  it"; "**knock** — request editorial permission to a locked story"; "**Takeover** — remove a
  user that has locked a story and take control." Related, and brutal: "**Draft API and
  Composer do not share a locking mechanism.** Because of this, changes made to a document
  through Draft API can cause subsequent saves in Composer to fail for the user. **At this
  time, there is no workaround.**"
- **Collaboration:** threaded comments in the right margin, inline notes, **Suggesting Mode**
  (green additions, strikethrough deletions), internal memo notes surfaced in WebSked, and a
  Clipboard. The mode menu is **Editing / Suggesting / Read Only**. Revisions retain "up to
  100 story versions," with **Story comparison** and **Story preview** views.
- **Publish gating:** Story Validation Rules — "**Errors must be resolved before continuing.
  Warnings can be acknowledged** by the author." API-configured only. That error/warning
  split is a good model for standards checks that should block versus merely prompt.
- **Publish as a revision alias — the most stealable Arc idea.** The Draft API "and its
  underlying database serve as **the system of record for all content**," and publish is not
  a boolean flag but a **named revision**:

  ```text
  PUT    /draft/v1/story/{id}/revision/draft            — save
  POST   /draft/v1/story/{id}/revision/published        — publish
  DELETE /draft/v1/story/{id}/revision/published        — unpublish
  PUT    /draft/v1/story/{id}/revision/revert/{rev_id}  — restore
  ```

  "Reverting… **creates a new published revision**"; "Unpublishing… **removes the published
  revision**." Modeling publish as an alias makes unpublish a first-class inverse and
  take-down an ordinary operation rather than a special case — which matters for a public
  broadcaster with correction obligations.
- **Keyboard shortcuts — documented, and text-editing only:** Bold `Ctrl+B`, Italic
  `Ctrl+I`, Underline `Ctrl+U`, special-character map `Ctrl+K`, inline comment
  `Ctrl+Alt+N` / `Ctrl+/`. Discoverable via a **keyboard icon, bottom right**. **Command
  palette: not found, zero hits corpus-wide.** WebSked has no documented shortcuts at all.
- **WebSked views and limits:** "List view · 1-Day view · 7-Day view · Stats" — no week
  grid, month, or swimlane, capped at 1000. **The calendar is read-only for content: "You
  cannot edit a content item from the calendar."** Saved views exist under two names for one
  feature ("Saved searches" in Planning, "Saved filters" in Tasks) and are
  "**personal — only available to you and not shared across your team**." **Shared or team
  views: not found. Bulk actions: not found** — every action is single-object via a card
  ellipsis. The Statistics landing page is also "**not integrated with any external
  analytics platform (such as Chartbeat or Google Analytics)**."
- **Bulk actions exist in exactly one place.** Photo Center: checkbox on hover → "A **blue
  menu bar**, featuring options to **delete, publish, edit, or add to a Gallery or
  Lightbox**, will appear at the bottom," plus a **`Copy to all`** that fans one value across
  a batch. Capped at 50 and disabled across mixed image types. The two busiest tools —
  Composer and WebSked — have none.
- **A cautionary tale worth reading before any redesign.** Arc rebuilt the Video Center
  editor to match Composer, shipped it in releases 1.123–1.126, then **stopped**: "we are
  **pausing development and focusing our resources on more consumer-focused experiences**."
  The stated goals read as an indictment of the legacy UI — users would "no longer need to
  **constantly refresh the page**, be **overwhelmed by system notification popups**, or
  **scroll endlessly**." The result is **two permanently bifurcated editors** ("Switch to
  legacy video editor" / "Return to VOD Edit Beta"). This is an abandoned migration, not a
  convergence signal, and it is the direct counterpoint to Vox's finish-the-job rollout.
- **Security note for any Arc-adjacent build:** "**Arc XP does not sanitize content at
  ingest, read or render time.**… If you render such content using `dangerouslySetInnerHTML`,
  you expose your site to persistent XSS vulnerabilities."
- **Why it works / tradeoffs:** Configurable statuses plus trigger-driven group tasks is a
  clean separation: the status enum stays small and legible, and the long tail of editorial
  chores lives in tasks. The tradeoff is that it needs an admin to configure task types and
  templates before anyone can use it.
- **Terminology collisions Arc inherited — a checklist of what not to repeat:** *Section*
  means three things; *Saved search* vs. *Saved filter* is one feature under two names;
  *Schemas* is where *Workflow statuses* live; *Group* is not an Okta group; *Status* spans
  four unrelated enums; *features/blocks/modules* overlap; *lightbox* means two things. The
  overflow button ships as **three icon assets under four names** ("ellipsis," "vertical
  ellipsis," "overflow menu," "kebab"). Naming drift is a real, compounding defect.
- **Applicability to NJ PBS:** The closest model to copy, with three amendments now that the
  full picture is in. Start with three statuses, color them, make status a filter facet and
  a card field, and drive review with tasks assigned to a group rather than adding statuses;
  the 75% rule is a good scoping constraint. But: (1) **keep the axes separate from day
  one** — Arc's four-enums-plus-circulation sprawl is what happens when they are not planned;
  (2) **model publish as a revision alias**, which is Arc's cleanest mechanic and costs
  nothing to adopt early; (3) **do not copy memberless groups without adding an
  assigned-to-me view** — Arc's groups are cheap to administer but leave staff with no home
  for their own work.
- **Sources:**
  - <https://docs.arcxp.com/en/products/composer/getting-started-with-composer/how-to-setup-workflow-statuses.html> (statuses are customizable; manual-only; the "Backread" example)
  - <https://docs.arcxp.com/en/products/websked/configuring-websked-settings/configuring-websked-workflow-statuses.html>
  - <https://docs.arcxp.com/en/products/composer/composer-overview/composer-2-0.html> (the 2.0 pane model — authoritative over `navigating-composer.html`)
  - <https://docs.arcxp.com/en/products/composer/getting-started-with-composer/how-to-use-composer-search.html> (filters, sort, sticky-across-logout, no Boolean/wildcard)
  - <https://docs.arcxp.com/en/products/composer/getting-started-with-composer/how-arc-xp-handles-uncirculated-stories.html> (the circulation requirement and the "Uncirculated" decoy site)
  - <https://docs.arcxp.com/en/products/composer/getting-started-with-composer/how-to-set-up-composer-preview-for-pagebuilder-or-headlessly.html> (preview URL model)
  - <https://docs.arcxp.com/en/products/publishing-platform/debugging-outdated-story-content.html> (Draft API as system of record; publish as revision alias; the Composer locking seam)
  - <https://docs.arcxp.com/en/products/websked/configuring-websked-settings/configuring-websked-groups.html> (memberless groups; not linked to Okta)
  - <https://docs.arcxp.com/en/products/websked/managing-websked-tasks.html>
  - <https://docs.arcxp.com/en/products/websked/configuring-websked-settings/configuring-websked-groups/configuring-group-task-triggers.html>
  - <https://docs.arcxp.com/en/products/websked/reviewing-websked-data.html> and <https://docs.arcxp.com/en/products/websked/managing-websked-publications.html> (the two incompatible pitch enums)
  - <https://docs.arcxp.com/en/products/websked/planning-your-content-tasks.html>
  - <https://docs.arcxp.com/en/products/websked/pitching-content-in-websked.html>
  - <https://docs.arcxp.com/en/products/websked.html>
  - <https://docs.arcxp.com/en/products/photo-center/getting-started-with-photo-center.html> (images are not a top-level type; bulk actions)
  - <https://docs.arcxp.com/en/products/video-center/getting-started-with-video-center.html> (the non-editable video enum)
  - <https://docs.arcxp.com/en/products/video-center/vod-edit-beta.html> (the paused editor migration)
  - <https://docs.arcxp.com/en/resources/knowledge-articles/composer/does-composer-have-any-keyboard-shortcuts-.html>
  - <https://docs.arcxp.com/en/products/composer/getting-started-with-composer.html>
  - <https://docs.arcxp.com/en/products/composer/navigating-composer.html> (annotated list-view screenshot; 1.0-era, superseded)
  - <https://docs.arcxp.com/en/products/general/arc-xp-browser-extension-user-guide.html> (composer edit URL pattern)
  - <https://dev.arcxp.com/concepts/content-model-ans/understanding-arc-native-specification-ans> (ANS = Arc Native Specification)
  - <https://docs.arcxp.com/en/resources/arc-xp-glossary.html> (lock / knock / takeover)
- **Evidence caveat:** `docs.arcxp.com` is server-rendered and fully mineable, so the
  findings above are quotable verbatim. `dev.arcxp.com`'s API reference tier is JS-injected
  and was never archived, so gaps there are a capture limitation, not evidence of absence.

## BBC

- **What's publicly known:** BBC's *prose* on its current editor, **Optimo**, is three
  sentences total — the BBC open-sources its render tier (Simorgh) but nothing upstream of
  publish, so authoring, workflow, and approval are all behind the curtain. But "not written
  about" turned out not to mean "not recoverable": Optimo's **routes and UI structure were
  reverse-engineered from archived CSS bundles and the Wayback URL index**, and the two
  *previous* BBC systems (CPS, CPS Vivo) have real annotated screenshots with documented
  stage names. Treat the CPS/Vivo material as well-documented and the Optimo layout as
  strong inference from CSS geometry — not a screenshot anyone has seen.
  The whole public Optimo corpus is: "**Optimo**, a tool for writers that moves beyond the
  classic 500-word story… starting in BBC World Service"; "Optimo, a new article editor for
  News journalists"; and, from a peer-reviewed paper, "A new content management system
  (**Optimo**) was designed and built, along with a complementary metadata system
  (**Passports**) and curation system (**Tipo**)," replacing "a **form-based content
  management system** that had evolved incrementally." As of Feb 2023, "about **5% of BBC
  journalists** have been migrated."
- **Two premise corrections:** **CPS = Content *Publishing* System**, not Production. And
  the internal names "**Bruce**" and "**GPS / Global Publishing System**" could **not be
  found** — zero evidence across BBC's 975-repo GitHub org and the open web (every "Bruce"
  hit is Fiona Bruce or Bruce Forsyth). If they exist, they are internal-only.
- **URL/routing — documented, and the ID model was verified first-hand.** The Wayback index
  for `optimo.tools.bbc.co.uk` holds 237 URLs in three shapes: `/assets/{ID}/editor` (144),
  `/assets/{ID}` (12), `/assets/{ID}/promos` (3). So: **bookmarkable per-story URLs at
  `optimo.tools.bbc.co.uk/assets/{assetId}/editor`.**
  The stronger finding is the ID model, proved rather than inferred: the archived editor URL
  `/assets/c1361511vvvo/editor` (captured 2024-05-21) resolves *today* as a live public
  article at `bbc.com/hindi/articles/c1361511vvvo` (HTTP 200, `datePublished: 2024-05-11`).
  **One asset ID spans the editor URL and the public URL — no separate CMS ID.** The hit
  being a World Service (Hindi) article also corroborates the documented rollout order, and
  the editor capture landing ten days after publication is consistent with post-publication
  editing.
  *Caveat, stated plainly:* all 158 `/assets/*` captures are 307 redirects to login. The
  routes are solid; **no archived editor screen exists**.
- **Nav model — inferred from the 2026-03-27 CSS bundle** (`main.6ca33ad4.css`, 136KB):
  `.nav-container` is `display:flex; height:100%; white-space:nowrap` → a **horizontal top
  nav with no app sidebar**, plus a `.context-bar-container` with two variants,
  `.context-bar--editor` and `.context-bar--workflow`. Design tokens new in 2026 include
  `--color-optimo-orange: #fb531f` (active block), `--content-bar-height: 56px`, and
  **`--context-button-min-size: 44px`** — which is WCAG 2.1 SC 2.5.5 Target Size, a
  Level **AAA** criterion, not AA. Do not read it as NJ PBS's floor: the AA target-size
  criterion is WCAG 2.2 SC 2.5.8 Target Size (Minimum) at 24×24 CSS px with exceptions,
  and NJ PBS's binding obligation is WCAG 2.1 AA, which sets no target-size minimum at
  all. 44px is a usability standard the BBC chose to hold itself to and a reasonable one
  to copy — but it is a choice, not a compliance debt.
- **Dashboard/home:** `.dashboard__grid-area` (centered, 1008px), `.dashboard__list-area`
  (grey `#ededed`), `.dashboard__count__text`, `.dashboard__updates`. A list with counts,
  not a permissions summary.
- **Content list — and a genuinely surprising negative.** Rows expand in place:
  `.dashboard-list-item--expanded` animates open a `__details` region revealing
  `__details__history`, `__details__image`, `__details__passport`, `__details__versions`.
  But the classes are **`.sort`, `.sort__dropdown`, `.sort__label` only — there are no
  filter classes at all**, no checkbox/selection/bulk classes, and no saved-view classes.
  This was hardened three ways: only `main.*.css` bundles are archived (no code-split chunks
  to hide in), the shared `igm-filterable-grid` component is **absent** from the bundle
  (only the `igm-grid`/`igm-col` primitives are present), and it still holds on the
  **March 2026** build. **Optimo's dashboard has sort but no filters, no saved views, and no
  bulk actions.** Not a model to copy; useful as evidence that even the BBC shipped without.
- **List-to-editor relationship:** **Neither modal nor split — rows expand in place**, then
  link out to `/assets/{id}/editor` via `.dashboard-list-item__history-link-section`. A
  third pattern beyond the two this research otherwise found.
- **Editorial workflow:** The label component exists — `.asset-info-bar__workflow-label`,
  `.asset-info-bar__status`, `.user-assignment`, `.withdraw-info`, `.publish-status__title`
  — but **the stage values live in JS, and no JS bundle was ever archived for this host**
  (only CSS and four SVGs). **Optimo's workflow stage names: not found.** There is a
  `.user-assignment` class but no evidence of a queue split.
- **Editor:** **`.slate-editor`** (Slate.js, confirmed independently via the
  `BBC-archive/old-optimo-slate` repo), with `.article__block--active`, `.block-ordering`,
  `.palette__toolbar--closed`, `.group-modal__*` (nested block groups), and
  `.block-wrapper--read-only`.
- **Power user:** **`.shortcuts-page`, `.shortcuts-sidebar`, `.shortcut__description`,
  `.shortcut__value`** → a dedicated keyboard-shortcuts *page*. **No command palette.**
- **The two BBC screenshots that do show workflow names.** These are the well-documented
  part of this section:
  - **CPS (2010)** — a .NET/WPF **Windows desktop app** with 1,200+ users. **Nav is tabbed
    MDI**: `My Recent Stories` | `Entertainment and Arts` | `Sherlock actor's 'joy and wor…'`
    — **my-queue, desk-queue, and the open story coexist as sibling tabs.** Two rails: left
    editor, right metadata accordions (`Extras`, `Puffs`, `See Alsos`, `News Tracker`). A
    **`Sign-Off` panel** carries `Status:` with four buttons: **`Draft` | `Written` |
    `Approved` | `Published`** — documented stage names. Note "Written," not "Review," and
    **no legal or copy-edit stage**. Deliberately not WYSIWYG: "the CPS is not primarily a
    WYSIWYG editor. The CPS focuses on content structure because in a world where you are
    publishing to many platforms… WYSIWYG becomes a pointless feature **but there are
    previews showing the output**." It died because the WPF client "requires that users run
    Windows within the BBC domain… very limiting for journalists who are out in the field."
  - **CPS Vivo (2015)** — a web successor sitting **on top of CPS** (route:
    `/CPS/{numericId}`). **Nav is four columns, no sidebar**: Composer | `Draft Content` |
    `Related Content` | `Live`. **List-to-editor is a persistent split** — composer and all
    three queues on screen at once. **Stage chips: `DRAFT` → `READY` → `PUBLISHED`.** Block
    palette, literally: `+ | Text | Image | Media | Quote | Email | Tweet | SMS`. **The
    `Live` column *is* the preview.** Vivo was the live-page tool — "planning its live use
    in BBC Local Live pages, and sport commentaries… fully rolled out in time for the
    general election" — and journalists still list "Vivo live" in their toolsets.
- **The shared design system — the most transferable BBC finding.** BBC built a **shared
  component library for internal editorial tools**, prefixed `igm-`, used across Optimo and
  Vivo: `.igm-app-header`, `.igm-drawer` (75%/950px), `.igm-dialog`, `.igm-notification-bar`,
  and **`.igm-btn--publish` standardized to green `#5db85d`** — one publish affordance across
  every BBC editorial tool. *Inferred:* Optimo took the primitives (`igm-grid`, `igm-col`)
  but rolled its own chrome; it does not use `igm-app-header`, `igm-drawer`, or `igm-btn`.
- **Passport** (metadata; unrelated to PBS Passport) is a **side-record, not embedded in the
  article** — joined by `locator`, carrying `predicate → thing-URI` taggings. It doubles as
  authorization: `passport.home` decides whether a service may render an asset. Optimo
  surfaces it in **two** places, the editor *and* the expanded list row. The
  `bbc/offline-completion` repo reports **passport completion** — metadata completeness is
  measured and chased rather than merely required.
- **Tipo** (curation) — routes only: `/landing`, `/curations/list/{UUID}`,
  `/topics/edit/{id}/details|/settings|/curations`, `/live/edit/{id}/details|/curations`.
  *Inferred:* `/live/edit/` suggests Tipo absorbed the live-page role Vivo held in 2015.
  Curators set **visual treatment and prominence**, not just membership:
  `VISUAL_STYLE = {NONE, BANNER, COLLECTION, LINKS, FEED, RANKED, INSITU}` and
  `VISUAL_PROMINENCE = {MINIMUM, LOW, NORMAL, HIGH, MAXIMUM}`. **Zero Tipo CSS or JS was
  archived — its UI is genuinely unknown.**
- **A BBC designer's nav finding, aimed straight at the two-rails problem.** Writing up the
  older iSite CMS, designer Leo Marti reports that in sketching exercises "almost everyone
  **forgot to sketch the navigation bar**… they said they **didn't really use it and didn't
  know what some of the pages did**." His response was to **hide the nav into a menu** and
  replace it with a project switcher, search-as-primary-action, and an always-available
  create button, because "many users complained not to be able to create new documents from
  everywhere." A nav rail nobody can describe is not navigation; it is decoration.
- **Applicability to NJ PBS:** More than expected. (1) **One ID for the editor URL and the
  public URL** is a clean, cheap convention. (2) **Expand-in-place rows** are a third option
  between modal and full page, and cost less than either. (3) **CPS's sibling tabs** are the
  only documented case of my-queue and desk-queue coexisting without a nav rail. (4) The
  **`igm-` shared library and its single standardized publish button** is the argument for
  one design system across surfaces. (5) The **44px target token** is a cheap usability
  win, and worth copying — but it is WCAG 2.1's AAA target size, not an AA requirement;
  see the note above before treating it as owed. Do not copy Optimo's dashboard:
  sort-only, no filters, no bulk actions.
- **Sources:**
  - <https://iptc.org/thirdparty/bbc-ontologies/cms.html> (CPS = Content Publishing System)
  - <https://onlinelibrary.wiley.com/doi/full/10.1002/aaai.12168> (Caswell, *AI Magazine* 2024 — peer-reviewed; Optimo, Passports, Tipo, the form-based predecessor)
  - <https://medium.com/bbc-design-engineering/bbc-online-2020-in-review-e47dada5df3f>
  - <https://medium.com/bbc-design-engineering/an-accessible-digital-bbc-2019-in-review-7cddd2816ac7>
  - <https://www.inma.org/blogs/smart-data-initiative/post.cfm/bbc-product-manager-shares-how-automation-ai-can-help-media-reach-fragmented-audiences> (5% migration figure, Feb 2023)
  - <https://www.bbc.co.uk/blogs/bbcinternet/2010/07/bbc_news_websites_content_mana.html> + <https://www.bbc.co.uk/blogs/bbcinternet/img/cps-crop.png> (CPS deep-dive and screenshot)
  - <https://www.bbc.co.uk/blogs/internet/entries/89de2d90-d020-47d0-857e-03ee4f7b2beb> + <https://ichef.bbci.co.uk/images/ic/1920xn/p02kvcxn.jpg> (CPS Vivo post and screenshot)
  - <https://github.com/BBC-archive/old-optimo-slate> (Slate.js confirmation)
  - <https://github.com/bbc/simorgh/blob/latest/src/app/models/types/curationData.ts> (Tipo curation enums)
  - <https://github.com/bbc/topics-passports-playground> and <https://github.com/bbc/offline-completion> (Passport model, completion reporting)
  - <https://medium.com/portfolio-leo-marti/isite-s-new-header-96bf236f3860> (the nav-nobody-uses finding)
  - <https://www.bbc.co.uk/rdnewslabs/news/editorial-innovation/>
- **Open thread:** the BBC Academy "Introduction to Optimo" course is cited in the
  peer-reviewed paper and is archived in Wayback, but only as a loading shell. If anything
  would answer the remaining Optimo UX questions, it is that.

## Vox Media Chorus

- **What's publicly known:** Less than its reputation suggests, and none of it is a
  screenshot of the admin. Chorus was famous as a recruiting tool — Ezra Klein cited it when
  he left the Washington Post — but Vox never published an engineering deep-dive on its admin
  UX, and the product itself sat entirely behind auth. Every archived
  `chorus.voxmedia.com` app URL returns a 301/302 to login; the only 200s in the whole
  Wayback crawl are `favicon.ico` and a gate page. Chorus is also end-of-life: Vox stopped
  licensing it in 2023 and moved its own network to headless WordPress VIP.
  The best sources are a **~40-minute recorded sales demo** in which a Vox VP screen-shares
  a live production environment, a 2019 post by a Vox product designer, and the 2017
  editor-rewrite postmortem. Beware two traps: `docs.chorus.ai` is **Chorus.ai**, an
  unrelated sales-call company; and the top search hits (`multidots.com`, `cmscritic.com`)
  are unsourced SEO marketing from a WordPress-migration vendor — excluded here.
- **Nav model:** Chorus was **an ecosystem of separate applications, not one admin with
  rails**. Vox designer Ramla Mahmood (2019) is explicit: Chorus is "an ecosystem of tools
  to support all facets of modern media, like story creation, asset management, analytics,
  and ads," and the design system existed to "prepare for a future where our tools merge and
  become part of the same application **instead of living in different areas**." As of 2019
  they had not merged. She names the resulting nav problem directly: because roles differ,
  "there would be **various points of entry** throughout Chorus Video, and **no single page
  should be designed without clear direction on how to navigate** the application." The
  design system was called **Resonance** (the reader-facing front-end system was separately
  called Unison). The **editor itself has no left rail** — frames extracted from Vox's own
  archived `Chorus-Collaboration.mp4` show a chromeless document with a single horizontal
  toolbar (bold, italic, link, styles, headings, lists, image, video, embed, insert) plus a
  fullscreen expand at right. Tabs exist *inside* the editor ("go to my finalize tab").
  The global nav — how you get from the story editor to Chorus Video to assets — is not
  documented anywhere, and no screenshot of it survives.
- **URL/routing:** **The strongest finding in this section, and it is hard evidence.** The
  Wayback CDX index for `chorus.voxmedia.com` holds 3,092 archived URLs, and the shape is
  unambiguous — Chorus was **URL-addressable per entry, one full page per surface, not
  modals**:

  | Route | Distinct archived URLs | What it is |
  |---|---|---|
  | `/preview/<uuid>` | 2,462 | Preview |
  | `/compose/<uuid>` | 452 | The editor |
  | `/editor/<uuid>` | 117 | An editor route |
  | `/preflight/<uuid>` | 35 | An undocumented pre-publish surface |
  | `/assets?q=…&page=1&order=date&community_id=761` | — | Asset library, with filter/sort/page state in the URL |

  Every story is a UUID-keyed full page: bookmarkable, shareable. The asset library carries
  its query, ordering, and pagination in the query string — the same pattern as the
  Guardian's filter sync. Public article URLs were
  `/<YYYY>/<M>/<D>/<entry_id>/<slug>` with the **numeric ID canonical and the slug
  decorative** — provable because "farewell-old-chorus" and "a-working-letter-about-chorus"
  resolve to the same entry, `16436340`, under two different slugs.
  *Inferred, flagged:* preview outnumbering compose 5:1 in the archive is most likely
  because preview links were shared publicly (posted to Twitter and Slack, then crawled),
  which implies preview was a shareable-link surface rather than only an in-app pane.
  `/preflight/` is undocumented; its purpose could not be determined.
- **Dashboard/home:** Genuinely unresolved, and the sources contradict each other across
  years — be skeptical of anyone who claims otherwise. The 2020 demo **opens in a
  search/archive view, not a dashboard**, with "ways to create new stories" in the top
  right. TechCrunch (2012) describes "a simplified dashboard that lets editorial staffers
  see how each story is doing" — an *analytics* dashboard. Brown (2017) says "we are already
  well underway with massive improvements to the editorial dashboard designed to make it
  easier for teams to plan and collaborate together" — a planning dashboard in flight, with
  **no follow-up post and no screenshot**; whether it shipped is unknown. Mahmood (2019)
  confirms Chorus *Video* has a dashboard. **No evidence exists for my-queue vs. desk-queue
  vs. everything separation, or for a command palette.**
- **Content list / library:** Documented filters are keyword, byline, "group searches," and
  drafts-only. Taxonomy is **"groups," nestable**: "we use the term groups and you can nest
  groups within groups… we don't necessarily distinguish like WordPress does between
  categories and tags, but you can create that same parent-child hierarchical structure."
  Multi-site is **"communities"** — you can copy or move a story to a related community, or
  pull a sister site's story so it renders in your list but links back to the original ("it
  says from eater.com… I'm not going to a copy of it"). **Saved views and bulk actions: no
  evidence.** The only list-design signal is Mahmood's note about building "a table that
  looks just as good with three elements as it does with 15."
- **List-to-editor relationship:** A full page at `/compose/<uuid>`, per the routing evidence
  above — not a modal. The 2012 pitch claimed **one interface end to end**: "Vox makes it
  possible to assign even a commenter a story, then write it, have it edited and then
  published to the site within a single interface. There are no issues with integrating
  between software programs." Read that against Mahmood's 2019 "ecosystem… living in
  different areas" and the reconciliation is that the *story pipeline* was integrated while
  the *wider toolset* stayed federated. So Chorus is a partial, not total, opposite of the
  Guardian — and both shipped, which makes the single-app model a legitimate choice rather
  than a compromise.
- **Editorial workflow:** **Chorus does not appear to have had a named multi-stage
  pipeline.** This is the load-bearing negative in this section. What the demo actually
  shows is **permission-gated publish, not a state machine**:
  - **"drafts"** — a search filter, not a pipeline stage.
  - **"submit for approval"** — permission-derived, not a status: "based on permissions here
    you might just see submit for approval if you don't have rights to publish directly. I
    am an admin here so I [have] rights to publish directly."
  - **"finalize"** — a tab or step, not a status: "if I feel good to publish I'm going to go
    into finalize."
  - **"publish now"** / **"publish changes"** for post-publish edits. Publish options cover
    future date, **embargo**, canonical URL, and block-indexing.
  - **"Behavioral nudges"** on the finalize screen — contextual warnings triggered by what
    you actually did, such as flagging a permalink change after publication.

  So the model is: draft → (submit for approval, if you lack rights) → finalize → publish.
  **No "review," "ready," or "copy-edit" state surfaced in any source.** Content types are
  named, though: "article, review, feature, or mapstack." The 2012 piece describes "a
  sophisticated tool for assigning and scheduling stories, that syncs with the user ID system
  and the publishing tool," built because SB Nation needed to plan coverage across sports
  seasons — but **no public source names Chorus's actual status/stage names.** Anyone who
  tells you otherwise is inferring. The stated motivation is still worth keeping: it existed
  because the alternative was "whiteboards, spreadsheets, general-purpose management software
  like Basecamp or Asana… or clunky legacy programs."
- **Preview (the best-documented surface):** Its own URL, `/preview/<uuid>`, with **device
  and format toggles** for desktop, tablet, mobile, and AMP, plus a **share view** rendering
  how the story appears in a Google search carousel. That is driven by **per-surface field
  variants** — a separate SEO/search headline, social headline, and homepage headline, each
  with its own image. This idea **survived the migration**: frames from the 2024 WordCamp
  talk show the WordPress replacement's sidebar carrying `SOCIAL HEADLINE`,
  `SOCIAL DESCRIPTION`, and `ONSITE PROMOTION IMAGE` with character counters.
- **Homepage curation** is a separate tool, **"story layout"**: drag-and-drop, **pink =
  pinned**, **white = reverse-chronological**, then "push changes live." No layout
  scheduling — only story-level publish times flowing into the layout. Same
  separate-tool shape as the Guardian's Fronts.
- **Other power-user details worth stealing:**
  - **Real-time collaborative editing with presence** — multiplayer cursors render as
    colored name flags, Google-Docs style, and user initials show everyone in the story.
  - **Version history at two levels** — whole-story *and* **object-level**, so you can write
    several headlines and revert between them independently, retained as long as the story
    exists.
  - **Autosave** with a "saved" indicator top right.
  - **Inline editor's notes** that never publish (they survive an accidental publish and are
    visible via the API, so removing them is documented best practice).
  - **No raw HTML editing, deliberately** — content is stored as structured rich text so it
    transforms to AMP and Apple News; only an explicit HTML block is an escape hatch. "We
    are generally pretty opinionated… we don't allow a ton of just freeform."
  - **Templates switch late and non-destructively**: "if I decide to change my mind about a
    template I can just go ahead and switch and all of my other changes will remain intact."
  - **Distraction-free mode** on the body editor.
  - **Accessibility specifics** (Mahmood): a color-blind PM failed on table backgrounds, so
    they **added a checkmark icon to toggle "on" states** rather than relying on color alone.
- **The origin story that explains the editor:** Chorus's editor DNA is **Editorially** —
  Vox acquired the collaborative-writing startup in 2014 and its founders (Mandy Brown,
  David Yee) led the rewrite, codenamed **"Anthem."** The rollout is the part most relevant
  to a redesign: they built the new editor **in parallel with the old one and refused to
  force migration** — disable the old editor "only after it had been abandoned — like
  turning off the lights in a bar only after the last customer had shuffled out." When they
  finally killed the legacy editor mid-workday in October 2017 they got "exactly zero
  feedback… It took 24 hours for the first user to notice."
- **What the 2024 WordCamp talk actually contains** (manage expectations): it is a
  migration-architecture talk — GraphQL schema, Fastly caching, data migration, launch
  verification — **not a UX talk**, and it contains no Chorus admin screenshots. Its one
  UX-relevant slide is titled "Challenges" and lists exactly two: "No real time
  collaboration built in Core" and "**Everything\* happens in the sidebar**." That is Vox's
  own team naming what they *lost* moving to WordPress, which is indirect confirmation that
  Chorus had real-time collaboration and did not cram everything into a sidebar.
- **On the "Hub":** **No evidence Chorus had a "Hub."** The word appears zero times in the
  8,422-word demo transcript; "queue," "workflow," "status," and "kanban" also appear zero
  times, and "dashboard" appears once. No Vox product-blog post, Nieman piece, or marketing
  page uses it. Treat "Chorus had a Hub" as unsupported and drop it before it hardens into a
  requirement. ("Hub" is Nieman Lab's own site-nav term — `niemanlab.org/hubs/…` — which is
  a plausible way the memory got crossed.)
- **Design philosophy (documented, and the useful part):** Chorus's stated enemy was admin
  busywork — "admin interfaces full of buttons that need to be clicked, as well as heavy
  metadata entry requirements." Concrete responses:
  - **Auto-tagging by semantic analysis** so writers do not hand-enter metadata: "If you
    mention 'Derek Jeter'… the software will analyze related text and tag the post with his
    name."
  - **A bookmarklet plus a side panel**: writers save links, photos, and videos from around
    the web, then drag them from a panel next to the story into the post.
  - **Licensed photo picker inside the text editor** (AP, Getty), plus inline cropping.
  - **A promotion section at publish time** for Twitter, Facebook, Google News.
  - Development method: "We don't throw things over the fence. We map our development plan
    around the tools that our editorial and advertising teams tell us they need, and then
    rapidly evolve the product based on data and feedback."
- **Command palette:** The 2012 piece mentions "a big set of hotkeys for power users," but
  in context that refers to the **comment moderation** system, not the story editor. Do not
  cite this as a CMS command palette.
- **Why it works / tradeoffs:** Chorus's bet was integration within the story pipeline —
  metadata inferred rather than typed, publish rights enforced by permission rather than by
  a workflow state machine. The cost of skipping the state machine is that a copy desk has
  nowhere to live: "submit for approval" tells you someone *can't* publish, not that a story
  is *waiting on legal*. That limits Chorus as a model for
  workflows that require separate review stages. Its end-of-life does not invalidate the
  design; Vox wound it down as a **business** decision (exiting the SaaS venture to refocus
  resources), not because the CMS failed editorially.
- **Applicability to NJ PBS:** Three things transfer. (1) **Per-entry routing** —
  `/compose/<uuid>`, `/preview/<uuid>`, and a query-string-driven asset library are a
  direct template for bookmarkable list and detail routes. (2) **The anti-data-entry stance** — infer
  metadata, don't demand it. (3) **The parallel rollout** — ship the new surface alongside
  the old and let the old one die of neglect rather than forcing a cutover; "zero feedback, 24 hours to notice" is the
  outcome to aim for. Do **not** build a stage model on Chorus: it did not have one.
- **Sources:**
  - <https://www.youtube.com/watch?v=fV3PyCmXKyk> (Chorus demo, Katrina Barlow, VP Chorus Business, ~Feb 2020 — a live screen-share of production Chorus; richest source by far, 8,422-word transcript)
  - <http://web.archive.org/cdx/search/cdx?url=chorus.voxmedia.com*&output=text&fl=original&collapse=urlkey> (Wayback CDX index, 3,092 URLs — the routing evidence)
  - <https://product.voxmedia.com/2019/4/30/18515468/designing-for-publishing-tools> (Ramla Mahmood, 2019 — design system, ecosystem, nav problem, accessibility)
  - <https://product.voxmedia.com/2017/10/6/16436340/farewell-old-chorus> (Mandy Brown and Trei Brundrett, 2017 — the editor rewrite, content types, parallel rollout)
  - <https://www.drewrios.com/project/vox> (designer portfolio — corroborates the Resonance design system)
  - <http://web.archive.org/web/20221008134747/https://getchorus.voxmedia.com/editorial.html> (marketing, but its embedded demo videos show the real editor toolbar)
  - <https://www.niemanlab.org/2018/10/a-chorus-of-publishers-vox-media-onboards-the-chicago-sun-times-as-its-first-licensee-since-launch/>
  - <https://techcrunch.com/2012/05/07/a-closer-look-at-chorus-the-next-generation-publishing-platform-that-runs-vox-media/>
  - <https://wordpress.tv/2024/10/10/reinventing-vox-medias-cms-a-wordpress-migration-journey/> (video; the "Challenges" slide) and <https://us.wordcamp.org/2024/session/reinventing-vox-medias-cms/> (abstract)
  - <https://www.voxmedia.com/about-vox-media/2018/7/17/17579876/vox-media-chorus-platform-open-premium-digital-publishers/>
  - <https://www.axios.com/2023/07/18/vox-media-chorus>
  - <https://www.adweek.com/media/vox-media-chorus-license/>
- **Honest gaps:** No public evidence exists for Chorus's global nav structure, its login/home
  screen, saved views, bulk actions, a command palette, my-queue/desk-queue separation, or
  any named review pipeline. The only realistic routes to those are a firsthand ex-Chorus
  user (Vox, Chicago Sun-Times, Deseret News, The Ringer) or the Society for News Design
  material at <https://product.voxmedia.com/2013/5/1/5426836/society-for-news-design-on-vox-process>.

## Bonus: LA Times SNAP

Not on the original target list, but the closest analog to NJ PBS by scale and constraint,
and it directly answers the routing problem.

- **What it is:** SNAP (Simple News Assembly Platform), built in-house after the newsroom
  found its inherited CMS left reporters "to wade through myriad unused form fields,
  copying and pasting stories between separate print and budgeting systems, and spending an
  inordinate amount of time writing and responding to a deluge of repetitive
  production-related emails."
- **URL/routing:** Explicit. SNAP "uses Backbone.js to model data from the servers on the
  client side and provide a framework for views and **History API URL routing**."
- **Architecture:** "SNAP does not have its own database, as it serves primarily as an
  interface between several APIs" — the CMS for auth and story read/write, Slack for status
  notifications, Desk-Net for budgets, CCI NewsGate for print design. A thin, routed
  front-end over existing services, which is close to what the NJ PBS admin already is over
  Firebase.
- **Workflow:** Copy desks are notified automatically when new cards are ready to be
  edited — first by email, then Slack. Same group-notification pattern as Arc XP and the
  Guardian.
- **Design discipline worth copying:** "form fields were limited to free users up to focus
  less on process and more on content, and a WYSIWYG preview was prominent to emphasize
  what readers would see." Also: "Emphasis was placed on previewing what readers would
  ultimately see in order to focus producers on the end-product instead of on just punching
  the right buttons and checking the right boxes."
- **Source:** <https://source.opennews.org/articles/how-los-angeles-times-transformed-its-publishing-t/>

## Bonus: Superdesk

An open-source newsroom CMS whose workflow vocabulary is public, useful as a naming
reference.

- **Desks and stages:** "content moves between **desks** (coverage areas and the reporters
  assigned to them) and **stages** (the steps of processing an article, from creation to…)."
  A clean two-level model that matches the Guardian's desk/status split.
- **Custom workspaces** are the best answer found to the my-queue vs desk-queue question:
  "anyone can create custom workspaces… and configure them to provide views into any stage
  on multiple desks at the same time. No need to switch views back and forth between desks."
- **Saved searches:** "Such custom searches can also be saved and retrieved again later, or
  may be shared with others in the newsroom." Shareable saved views, not just sticky ones.
- **A nice craft detail:** a proofreading toggle that "changes the font size, background
  colour and line breaks so that your tired eyes see something fresh" for a final read.
- **Sources:**
  - <https://www.superdesk.org/features>
  - <https://www.superdesk.org/uploads/superdesk-simple-demo-presentation.pdf>

## Cross-cutting answers to the original questions

**Story list to story editor.** **No newsroom tool with a documented transition uses a
modal.** Each gives the story its own addressable surface, in one of three shapes:

- **A separate app in a new tab** — Guardian (tracker → Composer).
- **A route in the same app** — Arc XP, Vox Chorus, LA Times SNAP.
- **Expand the row in place, then link out** — BBC Optimo, whose rows open a details region
  (history, image, passport, versions) before offering a link to `/assets/{id}/editor`.

BBC's CPS Vivo is a fourth variant worth noting: a **persistent split** with the composer
and three queues on screen at once. NYT's is not publicly documented. The Guardian
additionally puts three per-row links — edit, preview, live — so the list is a dispatch
surface rather than a dead end.

**Command palettes.** Confirmed absent across the board: zero keyboard-shortcut handling in
the Guardian's tracker source, **zero hits across 807 pages of Arc XP docs**, and Optimo
ships a dedicated shortcuts *page* (`.shortcuts-page`, `.shortcuts-sidebar`) rather than a
palette. Where shortcuts exist they are **text-editing only** — Arc's are bold, italic,
underline, special-character map, and inline comment, discoverable via a keyboard icon in
the bottom right. The industry invested in typing, not navigating. The power-user
affordances newsrooms actually build are different: inline status change from the list,
sticky and saved filter views, user-reorderable columns, quick date chips, and story
templates. **A palette is an open opportunity, not a table-stakes gap.**

**My queue vs the desk's queue vs everything.** This is the weakest-solved problem in the
entire industry, and worth saying plainly: **nobody nailed it except a 2010 Windows desktop
app.** Five approaches found:

- **Sibling tabs** — BBC CPS (2010): `My Recent Stories` | `Entertainment and Arts` | the
  open story, all as tabs in one bar. My-queue, desk-queue, and the work itself coexist
  with no nav rail at all. The only documented case of all three being first-class at once.
- **Facets on one list** — Guardian ("Assigned to you" / "Edited by you" + Desk dropdown).
- **Auto-derived activity list** — Guardian Pinboard ("My pinboards" from stories you
  opened, messaged in, or were @mentioned in, vs "My teams' pinboards").
- **Configurable saved workspaces** spanning stages across desks — Superdesk.
- **A single toggle over an org-wide default** — Arc XP's "View my tasks." The desk queue
  is not a first-class object; it is composed from a Group + `Assign to group` + a Group
  filter + Claim. Default is everything, org-wide.

Chorus and Optimo have none of them. The recurring failure is that "my work" ends up
**derived from a filter rather than being a place**. A first-class resume-work view
can make that destination easier to find.

**Saved and shared views.** Personal-only in Arc XP ("personal — only available to you and
not shared across your team"), absent entirely in Optimo, and configurable-but-shared only
in Superdesk. **Shared desk views are the clearest unmet need across every platform
reviewed** — the thing a small newsroom would most obviously want and that no vendor
shipped.

**Bulk actions.** Absent from the two busiest tools in Arc XP (Composer and WebSked) and
from Optimo entirely. Only Photo Center has them, with a blue action bar on selection and a
`Copy to all` fan-out, capped at 50. If NJ PBS wants bulk operations, there is no newsroom
prior art to copy — only asset-manager prior art.

**Where preview lives.** Two models: a separate addressable surface keyed to the story
(Guardian's `/preview/{path}` vs `/live/{path}`; Chorus's `/preview/<uuid>` with desktop,
tablet, mobile, and AMP toggles plus a search-carousel view; Arc's PageBuilder preview URL),
or collapsed into the editing surface so the editor *is* the preview (NYT Oak, LA Times
SNAP). Scoop did both — a pixel-perfect preview screen with a mobile panel. BBC does both
across eras: CPS had previews alongside a structure-first editor, and Vivo's `Live` column
*is* the preview, on screen beside the composer. **Nobody treats preview as a terminal step
after publish**, and **nobody does true inline preview inside a structured-block editor** —
the two are in tension, and every platform resolved it by putting fidelity somewhere else.
Chorus's archive suggests a property worth copying: preview URLs were shareable enough to
get crawled, which makes preview the natural handoff artifact for a reviewer who isn't in
the CMS.

**Draft → copy edit → legal → scheduled → published.** The consistent finding is that this
is not one enum. It is:

- a newsroom-position axis (Guardian: Writers/Desk/ProductionEditor/Subs/Revise/Final/Hold;
  Arc: Draft/Edit/Publish plus whatever you configure),
- a publication-state axis (Guardian: draft/published/takendown/scheduled/embargoed),
- and sign-offs as flags or tasks, not stages (Guardian: `needsLegal`, `legalApproved`,
  `needsPictureDesk`, `pictureDeskChecked`; Arc: group tasks triggered by status change).

Collapsing all three into a single status list is the modeling mistake this research most
consistently argues against. Arc XP is the proof of what happens when the axes are not
planned: it ended up with **four unrelated status enums plus a circulation axis, and no
unified view of what is live**.

The counter-tradition is real and should be weighed rather than dismissed. **Both BBC
systems use a single fixed enum** — CPS: `Draft → Written → Approved → Published`; Vivo:
`DRAFT → READY → PUBLISHED` — and both shipped at national-broadcaster scale. Note what CPS
called the second stage: "**Written**," not "Review." Neither has a legal or copy-edit
stage. So a single enum is viable; it just cannot express a sign-off that runs in parallel
with writing. For workflows that need copy-desk and standards review, a two-axis
model can express those independent checks.

**A note on where the stage names actually come from.** Only two platforms have publicly
documented, real stage names: the Guardian's (read from production source) and BBC CPS's and
Vivo's (read from screenshots). **Arc has no platform enum at all** — `Draft/Edit/Publish`
are customizable seed defaults. Optimo's and Chorus's are unknown. So the Guardian's enum is
not one option among five; it is one of only two fully documented newsroom stage models in
existence, which is why this research leans on it.

Chorus is the instructive counter-example: it had **no workflow state machine at all**, only
permission-gated publish (you see "submit for approval" if you lack publish rights). That
works for a network of blogs where the writer and the publisher are usually the same person.
Permission-gated publish cannot express "this story is cleared by legal but waiting on
the copy desk." Workflows that require independent copy-desk and standards checks need
more than a publication permission.
