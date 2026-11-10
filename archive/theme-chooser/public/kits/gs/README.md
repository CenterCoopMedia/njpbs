# Garden State public (gs)

A civic-editorial design kit for newnjpbs.org. Ink on warm paper, one
heritage-blue anchor, one warm cranberry accent, set on a strict grid. It reads
like a trustworthy New Jersey newsroom: a newspaper's credibility plus a public
broadcaster's warmth. This is the safe, broadly-credible default among the three
chooser directions.

> Sample and placeholder copy only. Nothing here asserts an operator change,
> a launch date, or a live integration.

## Design language

The kit uses white, ink, one accent, hairline borders, shared-border grids,
sharp corners, and callouts differentiated by tint and title color. Section
heads pair a monospace number with metadata aligned to the right. The Garden
State palette and Source Serif 4 headlines provide the editorial voice.
Light is the default mode; dark is an optional user setting.

It is namespaced `gs-` / `--gs-` so it can sit on the same page as the sibling
chooser kits (`sig-`, `post-`) without collision.

## Load from the site

Load the kit assets from the website build:

```html
<link rel="stylesheet" href="https://newnjpbs.org/kits/gs/gs.css">
<script src="https://newnjpbs.org/kits/gs/gs.js" defer></script>
```

Opt in by putting `class="gs"` on `<body>` (or any wrapper). Base typography and
the page background apply under `.gs`; every component also works inside it.

## No-flash theme snippet

Put this in `<head>` before the stylesheet so a saved dark choice applies before
first paint (no flash of the light theme):

```html
<script>try{var t=localStorage.getItem('gs-theme');if(t)document.documentElement.setAttribute('data-gs-theme',t);}catch(e){}</script>
```

Light is the default with no attribute set; dark is `[data-gs-theme="dark"]`.

## Tokens

All tokens live on `:root` as `--gs-` custom properties. Override any of them to
retheme. Contrast is computed (see `tokens.json`), not eyeballed; every pairing
the kit renders clears WCAG 2.1 AA (4.5:1 normal text, 3:1 large text / UI).

| Token | Hex | Use |
|---|---|---|
| `--gs-navy` | `#0B2A6B` | Brand surface: masthead, footer, primary buttons, structure. White on it = 13.5:1. |
| `--gs-blue` | `#1746C4` | Links, interactive text, focus ring. On white = 7.75:1. |
| `--gs-sky` | `#E8EEFA` | Tinted callout / section fill, table zebra, active-nav fill. |
| `--gs-ink` | `#16181D` | Body text and headlines on light. On paper = 16.3:1. |
| `--gs-muted` | `#5A5F69` | Metadata: timestamps, captions, category labels. On paper = 5.9:1. |
| `--gs-paper` | `#F7F5F0` | Default page background — warm off-white. |
| `--gs-white` | `#FFFFFF` | Card surfaces and content wells on paper. |
| `--gs-hairline` | `#D9D6CE` | All borders, rules, dividers — uniform, never a colored sliver. |
| `--gs-hairline-strong` | `#A9A599` | Header underlines, input borders, strong rules. |
| `--gs-cranberry` | `#B11E3C` | The one warm accent: support / donate CTA and point-cloud edge. On white = 6.7:1. |
| `--gs-amber` | `#FFCF00` | Fill-only highlight (Passport badge). Never small text on light. |

Dark mode lightens links to `#9FBDFF`, cranberry to `#FF8DA3`, and muted to
`#A7ACB6` so each pairing still clears AA on the ink page. The amber stays
fill-only.

## Components

A civic-newsroom vocabulary, all namespaced `.gs-*`:

- `.gs-utility` — thin sky-tint status bar with a dismiss control
- `.gs-masthead` / `.gs-nav` / `.gs-brand` — navy header; active nav is weight plus
  a bottom underline, never a top or left sliver; collapses to a hamburger
- `.gs-hero` / `.gs-hero__stage` / `.gs-hero__canvas` — hero stage wrapping the
  transparent particle-NJ canvas, with a serif headline column
- `.gs-onair` — static sample-schedule strip (now/next tiles); no live status
  indicator, since the public preview implies no connected schedule
- `.gs-lead` — the single lead story card (the only place with a soft shadow)
- `.gs-card` / `.gs-card-grid` — program and story cards in a shared-border grid
- `.gs-badge` — amber Passport badge (dark ink on amber fill)
- `.gs-support` — tinted donate block, uniform border, where cranberry leads
- `.gs-newsletter` / `.gs-form` / `.gs-field` / `.gs-label` / `.gs-input` — inbox
  capture with real labels (not placeholder-as-label) and a visible focus ring
- `.gs-callout` (`--info`, `--support`, `--note`) — tint plus title color, no edge
  stripe
- `.gs-table` / `.gs-data` — ruled data table with a mono time column and sky zebra
- `.gs-sec-head` — numbered section head, mono number plus flush-right meta
- `.gs-foot` — navy footer with a compliance column slot
- `.gs-btn` (`--primary`, `--donate`, `--outline`, `--outline-light`) — buttons
- `.gs-rule`, `.gs-tag`, `.gs-mono`, `.gs-serif` — utilities and dividers

### JavaScript behaviors

`gs.js` is dependency-free and self-wires on matching markup, no-op otherwise:

- Theme toggle: `.gs-theme-toggle` or `[data-gs-toggle-theme]` flips light/dark,
  persists to `localStorage` key `gs-theme`, and fires a `gs:themechange` event
  (`detail: { dark }`) so the canvas hero can re-read its colors.
- Mobile nav: `.gs-masthead` with `[data-gs-nav-toggle]` toggles the hamburger and
  closes on link tap, Escape, and outside click via one shared document listener.
- Utility dismiss: `[data-gs-dismiss]` removes its `.gs-utility` bar.

Public API on `window.GardenState`: `isDark()`, `setTheme('dark'|'light')`,
`toggleTheme()`. There is no scroll-jacking of any kind.

## Hero config

The particle-NJ hero (`site/src/lib/nj-hero.ts`) is config-driven. The values that
fit this direction — ink/navy fill points and a cranberry edge, transparent over
paper, calm idle drift:

```js
{
  background: "transparent",
  fill: "#16181d",        // ink interior points — reads as ink on paper
  edge: "#b11e3c",        // cranberry outline (the one accent)
  pointSize: 2.0,
  drift: 0.010,           // calm idle drift
  repelRadius: 0.30,
  repelStrength: 0.40,
  dissolve: 1.5
}
```

To re-theme the canvas on a dark toggle, listen for `gs:themechange` and re-mount
with a navy/blue fill suited to the ink background.

## Accessibility

- Semantic landmarks, one `h1` per page, a `.gs-skip` skip link, and keyboard reach
  are the markup contract this kit expects.
- Visible focus ring: 2px outline, 2px offset, heritage blue (white on the navy bar
  and footer).
- 44px minimum touch targets on nav links, buttons, inputs, and toggles.
- No color-only signaling: required fields carry a symbol, active nav carries
  weight plus an underline, and links are underlined.
- `prefers-reduced-motion` zeroes animation and disables smooth scroll; the hero
  renders a static formed shape.
- Contrast is computed against AA for every documented pairing in `tokens.json`.

## Production: self-host a subset woff2

`gs.css` references Source Serif 4, Public Sans, and IBM Plex Mono via a font CDN
`@import` for convenience during the prototype. All three are SIL OFL and should be
self-hosted as subset `woff2` with `font-display: swap` and the system fallback
stack already declared in the tokens (`Georgia` for the serif, `system-ui` for the
sans, `ui-monospace` for the mono). Self-hosting drops the render-blocking import
and the third-party privacy and latency cost, which matters for the state-agency
performance and accessibility posture.
