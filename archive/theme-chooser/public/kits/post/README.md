# post — Garden State poster

A civic-poster design kit for newnjpbs.org. Type does the heavy lifting at poster
scale over a tight WPA four-color ceiling: warm ink on cream stock, one civic blue for
structure, one poster red for emphasis, and a warm ochre used only as a fill behind
ink. The look is bold in type and palette, never in interruption — no modals, no
autoplay, no carousel.

This is one of three sibling kits the chooser page presents side by side, so it is
namespaced `post-` / `--post-` and coexists with `gs-` and `sig-` on a single document.
Each kit is independently loadable and reusable on its own.

## Design language

The kit uses sharp corners (no `border-radius` on components), uniform hairline
borders, shared-border grids, and callouts differentiated by tint and title
color. Section heads pair a monospace number with metadata aligned to the right.
The poster voice draws on WPA Federal Art Project silkscreen restraint
(the four-color ceiling reads as "public good"), Sister Corita Kent (type as the image,
civic message set large), Push Pin Studios (the warm ochre as the corrective to Swiss
coldness), a single Constructivist diagonal in tiny doses, and a Ben-Day / halftone
treatment on the hero only — kept off body text. A Swiss modular 12-column grid is the
rational backbone that holds the poster energy coherent.

The figure-ground motif (the abstract New Jersey shape over a dot field) echoes the
broadcaster's own Everyman lineage — "one becomes many" — without reproducing the PBS
P-head or the NJ PBS wordmark.

## Load from the site

Load the kit assets from the website build:

```html
<link rel="stylesheet" href="https://newnjpbs.org/kits/post/post.css">
<script src="https://newnjpbs.org/kits/post/post.js" defer></script>
```

Opt in by putting `class="post"` on `<body>` (or any wrapper). The kit does nothing to a
host document until that class is present, and the JS is a no-op until it finds matching
markup.

## No-flash theme snippet

Put this in `<head>` before the stylesheet so a saved dark/light choice applies before
first paint and the page never flashes the wrong theme:

```html
<script>try{var t=localStorage.getItem('post-theme');if(t)document.documentElement.setAttribute('data-post-theme',t);}catch(e){}</script>
```

Light is the default. Dark follows the system setting when no explicit theme is set, or
you can force it with `data-post-theme="dark"` on `<html>` (or `.post-dark` on a
wrapper).

## Tokens

All tokens live on `:root` as `--post-` custom properties. Override any of them to
retheme. Every pairing below is computed against WCAG 2.1 AA in `tokens.json` (normal
text clears 4.5:1, large text and UI clear 3:1) and the contrast check is part of the
build.

| Token | Value | Role |
|---|---|---|
| `--post-ink` | `#1a1714` | Warm ink — body text and contour |
| `--post-text-bright` | `#0e0c0a` | Deepest ink for display type |
| `--post-muted` | `#57524b` | Metadata and captions |
| `--post-cream` / `--post-bg` | `#f3e9d6` | Poster stock — the page |
| `--post-surface` | `#ffffff` | White well where a card needs lift |
| `--post-surface-2` | `#ece0c8` | Inset / zebra over cream |
| `--post-blue` | `#1d4e89` | Civic blue — structure and links |
| `--post-blue-hover` | `#163c69` | Link / button hover |
| `--post-blue-tint` | `#e4eaf2` | Blue callout fill |
| `--post-red` | `#c8102e` | Poster red — the one emphasis / CTA |
| `--post-red-hover` | `#a50c24` | CTA hover |
| `--post-red-tint` | `#f6e0de` | Red callout fill |
| `--post-ochre` | `#e8a33d` | Push-Pin secondary — fill only, behind ink |
| `--post-hairline` | `#d8cdb6` | Cream-matched hairline |
| `--post-hairline-strong` | `#b6a887` | Stronger rule + badge fill |

Note on the ochre: it is a fill behind ink only. It never carries small or light text —
light text on ochre fails AA, so the kit holds ink-on-ochre and nothing else.

## Components

| Class | What it is |
|---|---|
| `.post-utility` | Top utility strip (ink band, mono links) |
| `.post-masthead` / `.post-brand` / `.post-nav` | Header with brand mark and primary nav |
| `.post-nav-toggle` | Hamburger toggle (mobile), wired by `post.js` |
| `.post-hero` / `.post-hero__stage` | Hero stage wrapper for the particle-NJ canvas |
| `.post-hero__halftone` | The one Ben-Day / duotone treatment (progressive enhancement) |
| `.post-onair` | Static sample-schedule strip (no live status indicator) |
| `.post-lead-story` | Lead / story card (media + body, shared borders) |
| `.post-card-grid` / `.post-card` | Program card grid (Warhol-repetition, shared-border) |
| `.post-support` | Support / donate block (tinted, uniform border) |
| `.post-newsletter` / `.post-form` / `.post-field` | Newsletter capture (labels, not placeholders) |
| `.post-sec-head` | Section head (mono number + flush-right meta) |
| `.post-prose` | Body copy |
| `.post-callout` | Tinted callout — `--info`, `--note`, `--plain` |
| `.post-badge` | Ochre / hairline-strong fill badge (large only) |
| `.post-table` / `.post-data` | Ruled data table |
| `.post-diagonal` | Single hairline diagonal rule (used once) |
| `.post-footer` | Footer |
| `.post-btn` | Buttons — `--primary` (red CTA), `--outline` |
| `.post-pill` | Support pill (white-on-red emphasis chip) |
| `.post-theme-toggle` | Fixed light/dark toggle |
| Utilities | `.post-rule`, `.post-mono`, `.post-text-red`, `.post-text-blue`, `.post-text-muted`, `.post-skip` |

JS hooks are data attributes: `[data-post-toggle-theme]` and `[data-post-nav-toggle]`
(pair the toggle to its nav with `aria-controls`). State is `.is-open` / `.is-active`.

## JavaScript API

`post.js` exposes `window.Poster`:

- `isDark()` — current theme is dark
- `setTheme('dark' | 'light')` — set, persist to `localStorage` key `post-theme`, notify
- `toggleTheme()` — flip, persist, notify

The theme change fires a `post:themechange` event on `document` (detail `{ dark }`), so
a host like the particle-NJ hero can re-read its CSS colors. The mobile nav closes on
link tap, Escape, and outside click through one shared document listener. Nothing in the
JS intercepts, delays, or snaps the page scroll.

## Hero config

The shared particle-NJ engine is configured through `NJHeroConfig`. This kit uses
two-color points — civic-blue fill, poster-red edge — at a chunkier point size for a
printed-dot / Ben-Day feel, with a transparent background so the cream stock shows
through:

```js
{
  background: "transparent",
  fill: "#1d4e89",
  edge: "#c8102e",
  pointSize: 3.0,
  drift: 0.014,
  repelRadius: 0.34,
  repelStrength: 0.5,
  dissolve: 1.8
}
```

## Accessibility

- WCAG 2.1 AA, designed toward 2.2. Every documented pairing is computed in
  `tokens.json` and asserted by the contrast check.
- Visible focus ring: 2px ring, 2px offset, on `:focus-visible`.
- 44px minimum touch targets on nav links, buttons, pills, and form controls.
- A `.post-skip` skip link, visible on focus.
- Form fields use real `<label>`s, not placeholder-as-label.
- Active nav state is weight plus a bottom underline — never color alone, never a top or
  left edge sliver.
- `prefers-reduced-motion: reduce` zeroes animation and transition durations and turns
  off smooth scroll; the hero renders a static formed shape.

## Production: self-host fonts

The CSS references Anton (display), Public Sans (body), and IBM Plex Mono (labels) via a
Google Fonts `@import` for now. All three are open-licensed (Anton and IBM Plex Mono are
OFL; Public Sans is OFL). For production, self-host a subsetted woff2 of each face with
`font-display: swap` and a system fallback stack, and drop the render-blocking `@import`.
This removes the runtime Google Fonts dependency.
