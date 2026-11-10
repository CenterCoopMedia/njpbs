# Component accessibility acceptance criteria

> Component-specific criteria extend the baseline in `accessibility-governance.md`.

## How to use this register

- The **baseline** in `accessibility-governance.md` (keyboard operability, visible
  focus, name/role/value, contrast, target size, labels and errors, motion, and
  structure) applies to every interactive component below by reference. Each
  section lists only what is specific to that component: the criteria it must
  actively hold rather than inherit for free.
- **Done** means the component-specific criteria here are written and met, the
  baseline holds, and the verification steps have run: the automated per-component
  gate (issue #182) plus the documented manual keyboard and screen-reader check.
- A component that renders no interactive controls still carries structure,
  contrast, and reduced-motion criteria. Static is not exempt.

These criteria are the standing bar for "done," not an audit of current
conformance. Most are met by the components today; where one is not yet met, this
register flags it as a known gap under that component, so the remediation is
tracked rather than assumed.

## Islands

### NJHero (`site/src/islands/NJHero.astro`)

Renders: a canvas-animated brand hero over a static SVG underlay. The animation
loop is decorative.

Status: meets the criteria as of this writing.

Criteria specific to it:

- The canvas is `aria-hidden` and carries no information that is not already in
  the page text or the static underlay, so a screen reader loses nothing by
  skipping it (WCAG 1.1.1).
- Under `prefers-reduced-motion: reduce` the hero renders a single static frame
  with no loop (WCAG 2.3.3).
- The page is usable with zero JavaScript: the static hero stays and no content
  depends on the script running.
- The animation never flashes more than three times in any one second (WCAG
  2.3.1).

Verify: load with JavaScript disabled, with reduced-motion set, and with a screen
reader. Confirm the hero reads once, holds still, and exposes no canvas noise.

### ReportProblem (`site/src/islands/ReportProblem.astro`)

Renders: the site's problem-report and accessibility-feedback path, a native
`<dialog>` with a validated form. This is the reporting mechanism the accessibility
statement commits to, so its own accessibility is load-bearing.

Status: meets the criteria below.

Criteria specific to it:

- Uses `createModalDialog` to open a modal `<dialog>`, trap focus, close on
  Escape, a dialog close control, or a backdrop click, focus the description
  field on open, and return focus to the exact footer trigger on close (WCAG
  2.1.2, 2.4.3).
- The dialog has an accessible name via `aria-labelledby` on its title (WCAG 4.1.2,
  2.4.6).
- Every field has a programmatic label; the description field's hint and character
  count are tied to it with `aria-describedby` (WCAG 1.3.1, 3.3.2).
- A short required description sets `aria-invalid="true"`, exposes a field-tied
  error, and retains its hint and character-count descriptions; valid text removes
  the error association (WCAG 3.3.1, 1.3.1, 1.4.1).
- The submit control starts disabled and enables once the required description is
  entered and the anti-automation dwell has passed (WCAG 3.3.1).
- Submission state is announced through a `role="status"`, `aria-live="polite"`
  region, so success and failure reach a screen reader without moving focus (WCAG
  4.1.3).
- An invalid optional email is tied to its field with `aria-invalid` and a
  programmatically associated message, not signaled by color or the generic status
  alone (WCAG 3.3.1, 1.3.1, 1.4.1).
- The honeypot field is `aria-hidden` and removed from the tab order
  (`tabindex="-1"`), so assistive technology never lands on it.

Verify: operate the whole dialog by keyboard alone (open, fill, submit, cancel,
Escape); confirm the focus trap and, on close, focus return to the trigger; run a
screen reader through a failed and a successful submit and confirm both are
announced.

## Page and layout components

### PublicSiteLayout (`site/src/layouts/PublicSiteLayout.astro`)

Renders: the public site shell every page wraps in: the masthead brand link, the
primary-navigation disclosure, the newsletter link, the utility links, and the
footer motion control.

Status: meets the criteria as of this writing.

Criteria specific to it:

- The primary-nav disclosure is a real `<button class="nav-toggle">` with
  `aria-expanded` reflecting the open state and `aria-controls` pointing at the
  `#primary-nav` it shows, and the nav it controls carries `aria-label="Primary"`
  (WCAG 4.1.2, 2.1.1, 1.3.1).
- The newsletter destination is a link in the desktop utility row and the mobile
  navigation panel, so it remains keyboard-operable at both widths. The Kids
  route omits this external signup link to preserve its zero-collection boundary
  (WCAG 2.1.1, 2.4.4).
- The footer Reduce motion control is a native button with a 44-pixel target. Its
  `aria-pressed` value follows `html[data-motion="off"]`, and keyboard activation
  changes and saves that preference (WCAG 2.1.1, 2.5.8, 4.1.2).
- The active nav link is marked with `aria-current="page"` (WCAG 1.3.1).
- The brand home link and the utility icons have discernible accessible names, from
  an `aria-label` or their visible text (WCAG 2.4.4).

Verify: open and close the menu by keyboard and confirm `aria-expanded` flips and
focus reaches the nav. Tab the header and footer and confirm each link and the
motion button announces. Activate the motion button and confirm `aria-pressed`
and the saved preference change at desktop and phone widths.

### Base (`site/src/layouts/Base.astro`)

Renders: the outer `<html>` document and `<head>` contract every page wraps in —
language, viewport, canonical and social meta, and the site-wide motion floor. It
renders no interactive controls of its own; it carries the accessibility floor
every page inherits, so its criteria are the ones the wiki and public shells alike
rely on rather than restate.

Status: meets the criteria as of this writing.

Criteria specific to it:

- The document declares its language with `<html lang="en">`, so assistive
  technology reads the page in the right language (WCAG 3.1.1).
- The viewport meta permits zoom (`width=device-width, initial-scale=1`, with no
  `maximum-scale` or `user-scalable=no`), so browser and pinch zoom to 200 and 400
  percent are never blocked (WCAG 1.4.4, 1.4.10).
- The reduced-motion floor is seeded before first paint: an inline script sets
  `html[data-motion="off"]` from the finite `njpbs-motion` choice written by
  PublicSiteLayout, or from the OS `prefers-reduced-motion` setting when no
  choice is saved. A no-JS `@media (prefers-reduced-motion: reduce)` block is the
  floor when the script does not run (WCAG 2.3.3, 2.2.2).
- Each page receives a unique, descriptive `<title>` passed per page rather than a
  hard-coded default, so pages are distinguishable in history and by assistive
  technology (WCAG 2.4.2).

Verify: check `html lang`; confirm the viewport permits zoom and the page reflows
at 400 percent; confirm the saved and OS reduced-motion states apply before paint,
and that the no-JS media-query floor holds; confirm each route sets its own title.

### WikiLayout (`site/src/layouts/WikiLayout.astro`)

Renders: the public OKF wiki shell at `/wiki/` — a skip link, the brand header, a
sidebar section nav, breadcrumbs, per-page meta, and the article slot, wrapped
around the Base head contract.

Status: meets the criteria as of this writing.

Criteria specific to it:

- A `<a class="skip" href="#main">Skip to content</a>` skip link is the first
  focusable element and targets the `<main id="main">` region, so keyboard and
  screen-reader users can bypass the header and section nav (WCAG 2.4.1).
- The shell is built from named landmarks: a `<header>`, the section
  `<aside aria-label="Wiki sections">`, the breadcrumb `<nav aria-label="Breadcrumb">`,
  and `<main id="main">`, so the structure is navigable by region (WCAG 1.3.1,
  2.4.1).
- The current page's nav link carries `aria-current="page"`, and the decorative
  breadcrumb separators are `aria-hidden` so they are not announced (WCAG 1.3.1,
  4.1.2).
- The brand, "Main site", section, and page links each have a discernible
  accessible name from their visible text (WCAG 2.4.4).
- It inherits the Base floor (language, zoom, reduced-motion) rather than restating
  it; the calm documentation theme is visual only and introduces no motion of its
  own.

Verify: tab from the top and confirm the skip link is first and lands in `<main>`;
move by landmark with a screen reader and confirm the header, section nav,
breadcrumb, and main each announce; confirm the current page reads as current.

### CinematicHomePage (`site/src/components/CinematicHomePage.astro`)

Renders: the homepage: a decorative hero, horizontal program rails with previous
and next controls, and labelled content sections.

Status: meets the criteria as of this writing.

Criteria specific to it:

- Each rail is keyboard-operable: the scroll controls are real `<button>`s with
  descriptive `aria-label`s (for example "Scroll featured programs left"), and the
  track is reachable and scrollable from the keyboard (WCAG 2.1.1).
- Decorative hero and card art is `aria-hidden`; nothing meaningful is conveyed by
  background art alone (WCAG 1.1.1).
- Every section is a landmark with a heading tied to it via `aria-labelledby`, so
  the page has a navigable structure (WCAG 1.3.1, 2.4.1).
- Rail and hero motion switch off under `prefers-reduced-motion` (WCAG 2.3.3).
- The rails do not trap keyboard focus, and their off-screen items stay reachable
  through sequential navigation or an equivalent full listing, such as the
  full-schedule and program links (WCAG 2.1.2).

Verify: tab through every rail and section; confirm the arrow buttons announce
their purpose, the rails scroll by keyboard, and reduced-motion stills the page.

### ContentTile (`site/src/components/ContentTile.astro`)

Renders: a single card that is one link to a program or article, wrapping
decorative art.

Status: meets the criteria as of this writing.

Criteria specific to it:

- The whole tile is one `<a>` with a discernible accessible name from its text
  content, not from the decorative art, which is `aria-hidden` (WCAG 2.4.4, 1.1.1).
- Visible focus is shown on the tile, and its focus transition honors
  reduced-motion (WCAG 2.4.7, 2.3.3).
- The tile's activation target meets the 24 by 24 CSS pixel target-size guidance
  (WCAG 2.5.8).
- No nested interactive element sits inside the link, so the accessible name and
  activation stay unambiguous (WCAG 4.1.2).

Verify: tab to the tile; confirm one stop with a clear name and visible focus, and
that no inner element is separately focusable.

### PublicArticle (`site/src/components/PublicArticle.astro`)

Renders: a prose article layout with no interactive controls of its own.

Status: meets the criteria as of this writing.

Criteria specific to it:

- Heading levels are sequential and describe the structure; the article's title
  takes its correct place in the page heading order (WCAG 1.3.1, 2.4.6).
- Body text meets 4.5:1 contrast and reflows without loss of content at 200 percent
  and 400 percent zoom (WCAG 1.4.3, 1.4.10, 1.4.4).
- In-body links have a discernible name, meet text and non-text contrast, and are
  identifiable without relying on color alone (WCAG 1.4.1, 2.4.4).

Verify: check the heading outline, run the contrast gate, and reflow at 400
percent.

### PublicSubpage (`site/src/components/PublicSubpage.astro`)

Renders: the rich subpage shell: labelled notices, an embedded video-player
section, the partner-controlled PBS schedule widget with a plain-language fallback,
and card grids.

Status: meets the criteria as of this writing.

Criteria specific to it:

- The embedded PBS schedule widget is a known limitation the statement discloses.
  Its section carries an `aria-label`, and when the widget does not load the
  plain-language fallback, with live and on-demand links, stays reachable and
  operable (WCAG 4.1.2, and the known-limitations rule in the governance doc).
- The video-player section is a landmark named by its visible "NJ PBS broadcast
  stream" heading. Each notice is a landmark with an `aria-label` or a tied
  heading (WCAG 1.3.1, 2.4.1, 2.4.6).
- The PBS iframe has a concise `title` and an `aria-describedby` relationship to
  the visible keyboard instructions and the player-hosting note, so its purpose
  and boundary do not depend on the vendor frame loading (WCAG 1.3.1, 4.1.2).
- The player frame is a named, described keyboard stop with an explicit
  `:focus-visible` indicator before focus enters the cross-origin player. The
  iframe keeps the same direct-focus rule. A visible link before the frame moves
  focus to the first alternate live option, and the two persistent live links
  after it give keyboard users a route around a failed or unwanted embed (WCAG
  2.1.1, 2.1.2, 2.4.3, 2.4.7).
- Partner-controlled surfaces (the player and the widget) are tested in place, not
  accepted on the vendor's word. A barrier found there is routed per the governance
  triage rule, and the fallback path is the site's own accessible commitment (the
  procurement and triage rules in `accessibility-governance.md`).
- Card grids and interactive cards meet the baseline; decorative card media is
  `aria-hidden` (WCAG 1.1.1).
- Reveal and hover motion switch off under `prefers-reduced-motion` (WCAG 2.3.3).

Verify: disable the widget script and confirm the fallback reads and its links
work; tab to the player, confirm its focus indicator, activate the skip link and
confirm focus moves to the first alternate live option, then continue through the
notices and cards; confirm the landmarks and reduced-motion.

### HomepageAnnouncement (`site/src/components/HomepageAnnouncement.astro`)

Renders: a compact complementary announcement, an `<aside>` with zero, one or two
links and a decorative arrow on each link.

Status: meets the criteria as of this writing.

Criteria specific to it:

- The `<aside>` is a complementary landmark with an `aria-label`, so a screen
  reader can find and skip it (WCAG 1.3.1, 2.4.1).
- Each link carries a discernible name and, when it opens a new tab, that context.
  Each decorative arrow is `aria-hidden` (WCAG 2.4.4, 1.1.1, 3.2.5).
- Each action target is at least 44 CSS pixels tall (WCAG 2.5.8).
- Two links sit together and wrap on phones; maximum-length labels stay within
  the banner at 390, 1280 and 1920 pixels.
- Text and link colors meet contrast requirements against the banner background
  (WCAG 1.4.3, 1.4.11).

Verify: confirm the landmark and label with a screen reader. Check each link
name, external-link cue, keyboard focus and target size. Test zero, one and two
links on desktop and mobile, including long messages and labels, and confirm
wrapping without horizontal overflow.

## Adding a component

A new or changed design-system component is not done until:

1. its section is added here, listing what it renders and the criteria specific to
   it on top of the baseline;
2. the baseline in `accessibility-governance.md` is met;
3. the per-component automated gate (issue #182) and the manual keyboard and
   screen-reader check have run and pass.

## Sources

- `accessibility-governance.md`: the baseline definition of done, the
  member-experience commandments, and the triage, procurement, and audit rules.
- `accessibility-plan.md`: the conformance standard, legal basis, and audit
  method.
