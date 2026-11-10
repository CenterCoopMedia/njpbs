# Admin UI redesign

## Direction

The newsroom CMS uses an editorial desk direction: deep NJ PBS navy frames a calm, light editing canvas. The navigation feels anchored and distinct from the working area, while the canvas gives forms, tables, and story content enough room to scan. PBS Sans, PBS blue, and the public site's semantic approach keep the product connected to njpbs.org. The denser layout, persistent controls, and restrained surfaces are specific to a tool that staff use throughout the day.

The visual design stays within the admin application. Bearer-authenticated
functions enforce the capability model, while Firestore rules deny direct browser
access to the content collections. Server authorization decisions remain
authoritative.

## Navigation and information architecture

One persistent desktop hierarchy is organized around the task most editors arrive to do:

- Home is the canonical `/` route and shows recent stored records, lifecycle counts, and real quick actions. Account capability and billing summaries are not part of this work surface.
- Pages is the canonical `/content` route. It starts from the names and addresses of the live public pages, rather than exposing the storage model. Every canonical row opens its own editor document; the registry separately identifies the block template that constrains that page.
- Posts is the canonical `/content/post` record list. `/content/post/+` creates a post and `/content/post/:id/edit` reopens its grouped metadata editor, giving the familiar Pages/Posts split without hiding posts inside a generic record filter.
- All content is the secondary `/content/library` route for reusable structured content. All seven record kinds remain available as filters and direct routes, but only Posts is repeated as a primary authoring destination.
- Publish queue presents queue entries as a status table for staff with `settings.manage`.
- Admin settings is the separate `/admin/settings` route for global product configuration. It is present only for principals with `settings.manage`; it is not part of personal Account settings. Its first control edits the plain-language main-work heading on newsroom home. The Build and milestone eyebrow, build revision and time, milestone link, and progress stay automatic and read-only.
- Staff access presents the staff roster and keeps role changes in a collapsed disclosure until they are needed. A confirmed role change stays in its row while it runs: the row is marked busy, competing controls are locked, success or failure is reported beside the account, and a failed confirmation remains staged for retry.

At 900 pixels and below, the rail becomes a compact header with one menu disclosure. The hierarchy opens vertically, has no horizontal navigation scroller, and closes after a destination is selected. The active destination uses color, fill, and type weight with `aria-current="page"`. Navigation items are created from the existing capability checks, so inaccessible surfaces are absent rather than merely disabled.

The official white NJ PBS horizontal lockup anchors the dark shell and auth surfaces. The admin build owns an exact copy of the repository favicon. Five PBS Sans faces load from content-addressed media URLs; the system stack remains readable when those fonts are unavailable. Visual checks block media font requests and use the system stack.

## Token layer

The token layer in `src/styles.css` defines:

- Brand, surface, text, border, status, sidebar, focus, and elevation color roles.
- Five media-hosted PBS Sans faces at weights 300, 400, 500, 700, and 900 with `font-display: swap`, followed by platform fallbacks.
- A four-pixel-based spacing scale plus content, reading, sidebar, and auth layout widths.
- Control, surface, large, and pill radii.
- Focus outlines for light and dark surfaces and a comfortable control target.
- Fast and standard motion durations with one easing curve and a reduced-motion override.

Components consume semantic variables instead of local color or spacing values. Status colors communicate queue state with text labels, and navigation never relies on color alone.

### Density scale

The signed-in shell maps the four-pixel spacing scale to one shared density contract. Comfortable mode is the default. Compact and Loose remain saved user choices. The View options panel closes after a direct choice, outside pointer activation, Escape, or route change. Arrow-key movement stays open so keyboard users can compare the choices. Density changes work-area spacing and never reduces an interactive control below 44 pixels.

| Mode | Control | Local gap | Section gap | Gutter | Panel | Table row |
| --- | --- | --- | --- | --- | --- | --- |
| Compact | 44px | 8px | 16px | 12px | 12px | 8px by 12px |
| Comfortable | 44px | 12px | 20px | 16px | 16px | 12px by 16px |
| Loose | 48px | 20px | 24px | 24px | 24px | 16px by 20px |

The same aliases control the page directory, content lists and All content, editor cards, publish queue, staff access, activity, tables, messages, panels, and empty states. A surface-specific rule can change layout, but it must not invent another density scale.

## Primitives

`src/components/ui/Primitives.tsx` supplies the shared composition layer:

- `Button` with primary, secondary, ghost, and danger variants.
- `AsyncActionButton` and `ActivityIndicator` for stable, duplicate-safe pending actions.
- `TextInput`, `Select`, and `Textarea` form controls.
- `Panel` with default, soft, and warning tones.
- `StatusBadge` for queue, access, and capability states.
- `InlineMessage` for information, success, warning, and error feedback.
- The signed-in shell uses one fixed success-notice region for routine saves and settings changes. Contextual recovery, publication, destructive, media, and revision receipts stay inline.
- `EmptyState`, `TableFrame`, and `Toolbar` for repeated screen structures.

`src/components/ui/Icon.tsx` adds a small inline SVG icon set with decorative icons hidden from assistive technology by default. The shell, auth states, newsroom home, content studio, queue, staff access table, record form, block editor, and rich-text editor compose these shared pieces.

## Async action feedback

An action that waits for a network, storage, or clipboard result gives immediate
feedback in the control that started it. `AsyncActionButton` keeps space for its
idle and pending labels, adds a compact current-color activity indicator, marks
the native button busy, and blocks a second submission until the first request
settles. A polite live region announces pending work when the surface does not
already show a more detailed status. Reduced-motion mode stops the indicator's
rotation without removing it.

Completion and failure stay near the affected work. `InlineMessage` supplies the
shared success and error treatment. Existing specialized surfaces can keep an
equivalent visible status when it gives more useful context than a generic
message. Failure remains visible until the user changes the input, retries, or
starts another action. The interface does not show false percentages for work
whose progress cannot be measured.

| Surface | Async actions | Feedback boundary |
| --- | --- | --- |
| Page and record editors | Save, Update, block save | Shared pending control, completion message, persistent error, and conflict recovery |
| Assignment and lifecycle | Update assignment, review, approval, scheduling, publishing, archive, and restore | Confirmation where required, shared pending control, result message, and workflow error |
| All content | Save view and bulk archive | Shared pending control; archive keeps each record result and requires a fresh read after an uncertain response |
| Preview | Request build and copy reviewer link | Shared pending control for the request and copy; build polling keeps its detailed visible status; copy completion is announced |
| Media library | Upload and update details | Shared pending control; upload keeps its detailed progress text; success and failure stay with the media form |
| Account settings | Save display preference | Shared pending control, confirmed preference message, and rollback error |
| Admin settings | Save newsroom banner | Shared pending control, confirmed saved message, and version-conflict error |
| Activity | Load older activity | Shared pending control and persistent load error |
| Staff access | Grant, revoke, provision, and deactivate | Existing row-level busy state, locked competing controls, visible progress, and persistent result |
| Revision history | Load, inspect, and restore | Existing loading and restoring labels, live status, confirmation, and error recovery |
| Automatic reads | Session restore, route load, content lists, editor hydration, preview polling, and media lookup | Skeleton, loading panel, or visible status instead of an action button |

## Long-page composition

The home-page editor now treats a long block document as a navigable workspace rather than one undifferentiated scroll. A sticky page outline shows each block's position, type, first useful line of content, visibility, and focus state. Its controls jump keyboard focus to the real card and reorder through the same validated core operation as the card toolbar.

Every gap exposes a quiet, labelled insert control, so a block can be placed at its intended position instead of appended and moved back. The global block palette now follows the same principle: it opens for an empty page, starts closed for a populated page, and expands from one Add block control when it is useful. Opening or closing it changes only the workspace view and never marks content dirty. Each card can collapse its editing body or enter focus mode. Focus mode keeps the outline available to switch blocks while hiding the rest of the canvas without unmounting those editors, so local rich-text state survives. Outline navigation, collapse, and focus remain view state and never mark content dirty. Below desktop width, the outline becomes one horizontally scrollable strip above the canvas instead of stacking all eleven outline cards before the first editable block.

The separate Page preview section supplies the rendered frame without turning the composition canvas into a second
renderer. It refuses to build while the active page has unsaved work, captures
one exact saved version together with its referenced public media and reviewed
renderer commit, and reports queued, building, ready, failed, and expired states
in place. A ready result frames the actual public route produced by the site
build and offers exact 1280-pixel desktop, 390-pixel mobile, and available
full-width views. The desktop frame remains 1280 pixels even when its admin
panel is narrower, so the panel scrolls instead of silently shrinking across
the breakpoint being reviewed. Reviewers can copy the protected link or open it
in a new tab.

The preview control is disabled when the service is unconfigured. The request
and status-poll handlers use the same stored-record read decision as the editor.
Writers can preview their own Pages and Posts, including after submission for
review. Editors stay within their granted content areas. The Preview action stays
available when a submitted record is read-only. Draft artifacts require
authenticated access. The iframe accepts the preview artifact's frame policy,
which admits configured admin origins; public pages retain their `SAMEORIGIN`
protection.

## Placeholder standard

Placeholder surfaces reserve real geometry and real interaction states, and clearly identify unavailable interactions. An accurate footprint lets the surrounding layout support the finished control.

- Reserve the real geometry. The asset field reserves a media picker's footprint, a thumbnail preview beside the id input. The `recordList` field reserves a selected-record summary beside its immutable-id control. Inline image blocks reserve a framed media preview with their alt-text and caption fields. Forms therefore lock around each picker's intended shape rather than a bare text field (`src/components/FieldRenderer.tsx` and `src/components/InlineBlockSurface.tsx`).
- Reserve the real interaction states in the control's real editor location. A future assignee or workflow control sits where it will live, with believable states, before its backend exists.
- Never fake fidelity. Unconnected asset and record fields identify that limit and point at records by immutable id. Placeholder images are labelled. Gallery fixtures use representative copy so the layout is judged against realistic text.

Asset, record-list, and inline-image fields follow this placeholder standard.

## Delivery and bundle boundaries

The signed-in shell stays in the application entry so navigation and account controls remain mounted. Destination components, including Newsroom home, Admin settings, content studio, publish queue, staff access, and not-found, are React Router lazy routes with an in-shell loading status. Each known initial route has a matching preloader. Content studio's editor and rich-text dependencies therefore load only when that workspace is opened. Firebase remains part of initial session restoration, but Vite's Rolldown output keeps it in a named vendor chunk so it can be cached independently of application changes.

`tests/redirects-build.test.ts` runs a production build and requires named vendor and route outputs while rejecting any JavaScript asset at or above Vite's 500 kB warning threshold.

## Live-page directory, Posts, and All content

`/content` is the page-first CMS entry for principals with site-wide `content.edit.any` authority. A shared public-page registry is consumed by the Astro route data, route parser and admin directory, so the list cannot silently drift into a CMS-only taxonomy. Contributors retain their authorized Posts, All content, and record-create paths without being shown the page directory or Edit homepage shortcut, because those static links usually address pages owned by another editor. The registry identifies 18 canonical pages and folds `/donate/` into the Give row as an alias. Every row has its own draft-editor URL and `cmsPages` document, and the directory explicitly says publishing to the public site is separate. The registry maps that real page id to a separate block-editor template, so Watch, Live and About can share the service-page palette without sharing drafts or overwriting one another. The legacy `programLanding` and `genericPage` singleton URLs are rejected; when a page-specific document does not exist yet, their old stored content remains available as a one-way seed whose first save creates the page-specific copy. If the canonical page is absent and the optional shared singleton returns `403`, the editor continues with the canonical page's current composition and a create-only save without a legacy seed. When a readable seed carries a published, scheduled, or archived lifecycle, the editor mirrors the server's publish or archive-management requirement before enabling that create. The server copies non-block metadata and the protected publish snapshot from a readable, trusted legacy source without making either client-writable, and checks its version when one exists. That first save is create-only, so an intervening create conflicts instead of being overwritten; because the editor has never loaded the new page, reload is the only offered resolution. The server also validates every page-id/template pair against its tested deployment mirror. Directory identity, editing, preview, and public rendering use distinct contracts.

`/content/post` makes Posts a first-class newsroom workflow. Its list, create, and edit routes use the same immutable record identity and conflict-safe save boundary as All content, while the form groups Basics, Organization, Search, and Social sharing metadata. Metadata saves preserve an existing body and the interface identifies the scope of those edits.

All content at `/content/library` combines active records from all seven structured content kinds and keeps search, multi-select type and status filters, the updated-by filter, sorting, and paging in the URL. Refresh, Back and Forward, bookmarks, and shared links therefore reproduce the visible result. Legacy filtered links at `/content?...` replace themselves with the explicit All content path without losing the query or fragment.

The All content status choices wrap so every named state remains visible. Search, sort, direction, Filters, and Save current view share one toolbar; Post templates is in the New content menu. The table header holds select-all, and bulk actions appear after a record is selected. At narrower workspace widths, each record name shows its last update so the date remains visible before horizontal table scrolling. These are presentation changes; URL filters, saved views, selection eligibility, and archive confirmation keep their existing behavior.

The quick-view row exposes counts for every lifecycle status plus “My recent edits.” That wording is intentional: the current record contract has a server-owned `updatedBy` value, not a durable owner field, so the interface does not claim ownership it cannot prove. Every result link is built from the authenticated function response id and record kind. Loading, empty, no-match, failed, and retry states are explicit, and moving between All content and an editor keeps the persistent workspace mounted so an in-memory draft survives the browse step. The render path and dirty-navigation blocker resolve destination access through the same surface decision. Inaccessible or malformed destinations require leave confirmation before any editor holding a draft can unmount.

The newsroom home turns those same states into resume queues rather than inert totals. Draft, review, and scheduled cards open their exact URL-backed All content views; scheduled work sorts by publish time, and My recent edits keeps its deliberately narrower updated-by wording. A separate publish-activity read counts failed queue requests and links to the existing recovery surface without making a queue outage hide recent editorial work. The home does not relabel an update as an assignment.

The compact dark Newsroom banner is a global published setting. Its ordered subset contains only Announcement, Build status, Milestone, and Quick actions. Administrators can show, hide, and move those modules with native controls on the separate Admin settings route. Announcement copy and its optional paired link are editable. Preview uses the unsaved local draft; Save draft uses create-only or exact-version guards; Publish accepts only a clean saved version. A conflict keeps the local values visible and requires an explicit reload before another write. All staff read the published snapshot. While that read is unresolved, the banner shows an accessible loading state without default-module content or a status request. A missing, unpublished, invalid, or unavailable snapshot resolves to the useful safe default: Build status, Milestone, then role-aware Quick actions. Build and Milestone stay separate ordered regions but share one status request, and they keep explicit loading, current, stale, unavailable, and failed text. The banner wraps its modules and grows with content instead of gaining an internal horizontal scroller.

All content, the per-kind record lists, and the newsroom home send their queries to the bearer-authenticated `cmsListContent` function. That boundary resolves the verified caller, filters each record through the same read-capability decision as `cmsGetContent`, and only then computes status/global counts and the result. All content and the per-kind record lists each receive their addressed 25-row page, requested on the same query contract with the record type as a server-side filter and the page position carried in the list's own URL (#1066). The newsroom home receives one internally consistent server snapshot, capped at 500 authorized summaries so a future volume increase fails honestly rather than stitching independently sorted pages that can omit moving work; it keeps that snapshot because its recent-work list and its aggregate counts describe every authorized record. Site-wide editors see all authorized active records; contributors see their own; section-scoped grants are refused before the collection scan until records carry a section. A contributor can save only content they own while it remains a draft. After submission, that page or record remains readable under the same read grant, but both page editors and the record editor expose it as read-only. Workflow-assignment controls and the assignable-staff loader mount only for administrators, so editor and contributor sessions do not request the administrator-only staff list. Search scans the authorized server snapshot. The browser downloads neither unauthorized summaries nor seven complete typed result sets. Direct browser reads and writes of `cmsPages` and `cmsPosts` are denied for every role. Durable user-named views are stored in the signed-in profile. An administrator-only bulk bar, matching the separate destructive-action boundary, selects versioned, non-archived records on that visible page. After explicit confirmation, `cmsBulkArchiveContent` checks each loaded version in an independent transaction and reports archived, already archived, conflict, missing, or failed for every selected record. Successful rows receive their own version-history and audit entries; partial success and delivery-uncertain responses stay visible and force a fresh read before another attempt.

## Courtesy editor leases

Persisted page and record editors observe a small `cmsEditorLocks` document before mounting an editable form. Its canonical `cmsPages:<id>` or `cmsPosts:<id>` surface key is also its slash-free document ID. Every new claim repeats `contentCollection` and `contentId`, which lets Firestore rules bind the lease to that exact content document before they check ownership. During a rolling client and rules deployment, only site-wide editors and top-level administrators can read, heartbeat, or release an exact addressless row from the former schema. A new client accepts that former full lease only when both address fields are absent, derives the canonical address from the surface key, and migrates its owned lease to an addressed release marker. A new addressed claim can replace a valid legacy release marker immediately, or replace a legacy active lease under the same force, same-owner, and server-time expiry checks. Site-wide editors and top-level administrators can use any lease. A site-wide contributor can use an addressed lease only for an existing page or post whose `createdBy` value is their uid, or for an absent canonical page whose first save can create it. They cannot read a legacy row, use an absent post, or use another contributor's record. Section-scoped, inactive, and ungranted accounts cannot reach this direct-client path. Opening a document does not claim it. The first local draft claims a two-minute Firestore lease; an explicit unchanged save claims synchronously too, which keeps a meaningful create-only save available for an empty or legacy-seeded page. The lease refreshes every 15 seconds while that surface remains dirty and releases after save, an in-place reversion to the clean baseline, surface navigation, or unmount. Reversion checks run after a short input idle instead of walking a long rich-text page on every keystroke. Each mounted surface visit gets a fresh session identifier, so a delayed release from an earlier visit cannot match a newer reservation after the editor returns. Clients wait a full lease window without an observed heartbeat, then Firestore rules confirm expiry against server request time before replacement, so a skewed workstation clock cannot evict an active editor and a crashed tab still ages out. Optimistic `baseVersion` checks remain the correctness boundary.

Another active session produces a named warning with its start time instead of silently disabling controls. A site-wide editor or top-level administrator with `content.edit.any` may take over another user's lease explicitly. Any eligible writer may take over the same account's other tab so the presence layer cannot become a self-lockout. A deliberate takeover holds and refreshes its lease before the first edit, then joins the ordinary dirty/save lifecycle once the person starts typing. Losing a lease keeps an in-flight or dirty form mounted so its save can settle and its local work stays visible, but disables further saves until the person takes over again. This is only a courtesy layer: `baseVersion` and create-only conflicts remain the correctness boundary and still refuse an uninformed overwrite (#592).

If a stale replacement reaches Firestore just before the server's authoritative expiry boundary, a denied write preserves the browser's elapsed observation time only when the transaction read the exact unchanged lease. The client then retries at a controlled one-second cadence; a newer heartbeat starts a fresh observation window normally.

## Accessibility and testing

The shell uses labelled header, navigation, and main landmarks with a single page heading for each destination. A persistent editor heading keeps its complete accessible text in the document while its visual title stays on one shrinkable, ellipsized line, so a long spaced or unbroken title cannot displace the adjacent controls. Form labels remain explicitly associated with controls. Every native and rich-text control has a visible `:focus-visible` outline, controls follow document order, and motion is removed when `prefers-reduced-motion` is set. Desktop tables convert to labelled stacked rows on narrow screens without removing their semantic table structure.

The primary text, muted text, dark navigation text, control borders, and semantic status pairings were checked against their intended surfaces. The implementation targets WCAG 2.1 AA contrast and keeps control sizes above the WCAG 2.2 minimum target size.

Tests cover primitive variants and status semantics, every auth-state route, capability-built navigation, the Pages/Posts/All content active-state hierarchy, the page registry and live-page directory, the mobile disclosure contract, capability-filtered stored-record queues, queue table states, and the staff access disclosure. Staff-access tests hold a role request open to verify row locking and progress, then exercise both success and retryable failure; opening the confirmation also inserts a live status announcement for assistive technology. The design gallery exposes the same real component with successful, pending, and failed handlers for visual review. Brand tests compare the lockup and favicon with their canonical repository assets. Font source tests check content-addressed URL shape. Public font bytes, MIME, CORS and reader display require the separate release proof in docs/runbooks/editorial-media.md. Existing editor behavior, role actions, validation, capability gates, and mirror tests remain covered.

The Admin settings tests prove route and navigation capability gates, missing-document default creation, fail-closed invalid successful responses, explicit module order, keyboard-operable move buttons, paired safe-link validation, preview, create-only and versioned draft saves, clean-version publishing, locked pending controls, conflict recovery, and read retry. Newsroom tests prove unresolved-read loading without a default-module flash, published DOM order, safe missing, invalid, and failed-read fallback, role-aware actions, one shared status request, and honest status states. Stylesheet contract tests cover the 320-pixel and zoom-equivalent wrapping rules for the banner and settings form.

The page-preview tests additionally prove the save-before-preview gate, honest
unconfigured state, authenticated request/poll progression, real route URL,
breakpoint selection, copy/open actions, sandbox boundary, and terminal failure
recovery. The Firestore emulator proves that a later page save cannot alter the
queued revision, and the site loader proves that it builds the captured snapshot
rather than rereading the mutable page.

## Research notes

- The public NJ PBS token file established PBS Sans, PBS blue, semantic naming, focus, spacing, and motion as the brand bridge. The admin extends those ideas for a denser working application.
- The [W3C page structure tutorial](https://www.w3.org/WAI/tutorials/page-structure/) informed the landmark and heading model.
- The [W3C menu structure guidance](https://www.w3.org/WAI/tutorials/menus/structure/) reinforced using native navigation links and buttons with an indicated current item.
- The [WCAG 2.1 additions](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-21/) informed the non-text contrast check for controls and focus indicators.
- The [WCAG 2.2 additions](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/) informed comfortable pointer target sizing while WCAG 2.1 AA remains the required baseline.

## Contract changes

The admin information architecture and URL contract changed: `/content` is the canonical page directory, `/content/post` is the first-class Posts list, `/content/library` is the All content destination, `/media` is the Media library destination, and `/admin/settings` is the global settings destination. Existing record edit/list URLs retain their behavior. Content reads now cross `cmsGetContent` or `cmsListContent` with a Firebase bearer token and capability filtering; direct browser access to `cmsPages` and `cmsPosts` is denied. The Newsroom banner uses the closed `cmsGetNewsroomBanner`, `cmsGetSettings`, and `cmsSaveSettings` functions with document id `newsroom-home`; heading writes remain gated by `settings.manage`, while the authenticated heading projection is available to admitted staff. The shared public-page registry describes route identity and renderer family only; it does not claim the unconnected public pages are CMS-backed, and the Posts destination does not claim that body composition or public `/updates/` rendering is complete.
