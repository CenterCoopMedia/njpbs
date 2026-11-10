# Signal kit (`sig`)

A drop-in CDN design system for newnjpbs.org — one of three sibling kits the
team can pick from. Signal is the confident-television direction: a crisp white
studio field, PBS blue at full strength as structure, a thin SMPTE seven-bar
signature rule, mono channel numerals, and a lower-third caption pattern.

It loads independently of the other kits and coexists with them on one page,
because everything is namespaced `sig-` / `--sig-`.

## Design language

Signal draws on the broadcast-graphics lens: the PBS "P-head"/Everyman heritage
and the verified PBS 2019 palette used at full conviction, SMPTE color bars as a
signature rule (never a hero), the chyron/lower-third grammar, and a title-safe
registration-mark grid as layout discipline. Sharp corners, hairline borders,
shared-border grids, tint-and-title callouts, and numbered section heads with
metadata aligned to the right complete the broadcast style.

It deliberately avoids the broadcast cliches: no glitch/VHS/scanline overlays, no
color bars as an animated background, no 80s 3D fly-ins, and no reproduction of
the PBS P-head lockup, the NJ PBS wordmark, or the Indian-head test-pattern
figure. The SMPTE bars appear only as a thin, fill-only decorative rule.

## How to load (from the site)

Load the kit assets from the website build:

```html
<link rel="stylesheet" href="https://newnjpbs.org/kits/sig/sig.css">
<script defer src="https://newnjpbs.org/kits/sig/sig.js"></script>
```

Opt the document in by putting `class="sig"` on `<body>`. Base typography and the
page background apply under `.sig`; each component carries its own look and works
inside `.sig`.

### No-flash theme snippet

Put this in `<head>` **before** the stylesheet so a saved dark choice applies
before first paint (no flash of the light theme):

```html
<script>try{var t=localStorage.getItem('sig-theme');if(t)document.documentElement.setAttribute('data-sig-theme',t);}catch(e){}</script>
```

Light is the default. Dark is opt-in: it follows the system setting when no theme
is chosen, or is forced via `[data-sig-theme="dark"]` (or a `.sig-dark` wrapper).

## Tokens

All tokens live on `:root` as `--sig-` custom properties. Override any one to
retheme. The machine-readable list and every documented contrast pairing live in
`tokens.json` (the contrast test reads that file).

| Token | Value | Role |
|---|---|---|
| `--sig-bg` | `#ffffff` | the studio field / page |
| `--sig-surface` | `#ffffff` | card / panel |
| `--sig-surface-2` | `#eef1f9` | cool tint: callout fill, zebra, insets |
| `--sig-ink` | `#0e1116` | body text + strong rules |
| `--sig-text` | `#0e1116` | body text |
| `--sig-text-dim` | `#5a6172` | metadata, captions (5.5:1+ on tint) |
| `--sig-border` | `#d5d9e4` | hairline |
| `--sig-border-bright` | `#a9b0c6` | heavier hairline for controls |
| `--sig-blue` | `#2638c4` | PBS blue — primary structure, links, focus ring |
| `--sig-navy` | `#0a145a` | deepest surface bands |
| `--sig-accent` | `#c42b16` | broadcast red — support / emphasis accent (deepened from PBS coral to pass AA on white) |
| `--sig-smpte-1…7` | gray, yellow, cyan, green, magenta, red, blue | SMPTE 75% bars — **fill only**, decorative, never text-bearing |

### Documented contrast pairings

Every text/UI pairing the kit uses is verified against WCAG 2.1 AA (normal text
4.5:1, large text and UI 3:1). All pass. Highlights:

| Pairing | Ratio |
|---|---|
| body ink `#0e1116` on white | 18.91 |
| muted `#5a6172` on cool tint `#eef1f9` | 5.49 |
| link / focus-ring blue `#2638c4` on white | 8.59 |
| white on PBS-blue band | 8.59 |
| white on navy band | 16.66 |
| support red `#c42b16` on white | 5.67 |
| white on support/live red fill | 5.67 |

## Components

| Class | What it is |
|---|---|
| `.sig-utility` / `.sig-utility__inner` | thin navy utility bar above the masthead |
| `.sig-clock` + `[data-sig-clock]` | mono "channel clock" station time (static under reduced motion) |
| `.sig-masthead` + `.sig-nav` + `.sig-nav-toggle` | sticky header; active nav = weight + bottom underline; hamburger under 1000px |
| `.sig-bars` | SMPTE seven-bar signature rule (fill only, `aria-hidden`) |
| `.sig-hero` / `.sig-hero__stage` | hero with a registration-mark frame; stage wraps the particle-NJ canvas |
| `.sig-btn--primary` / `--outline` / `--support` | buttons (blue, outline, broadcast-red) |
| `.sig-onair` | navy static sample-schedule strip, white text (no live status indicator) |
| `.sig-sec-head` | section head: mono number + flush-right meta, top rule |
| `.sig-lead-story` | lead/story card with media well + lower-third |
| `.sig-lowerthird` / `.sig-caption` | chyron caption: name + role, hairline rule, color tab |
| `.sig-program-grid` / `.sig-program` | program card grid (shared-border) |
| `.sig-support` | support/donate block (tinted, uniform border) |
| `.sig-newsletter` / `.sig-field` | newsletter capture form (labels, not placeholders; visible focus ring) |
| `.sig-callout` (`--info` / `--support` / `--note`) | tinted callout (tint + title color, no edge stripe) |
| `.sig-table` / `table.sig-data` | ruled data table, mono uppercase headers |
| `.sig-band` (`--navy`) | full-width blue/navy section band, white text |
| `.sig-stats` / `.sig-stat` | shared-border stat strip |
| `.sig-tag` (`--blue` / `--support`) | inline mono label |
| `.sig-foot` | navy footer |
| `.sig-theme-toggle` + `[data-sig-toggle-theme]` | light/dark toggle |
| utilities | `.sig-rule`, `.sig-mono`, `.sig-text-blue`, `.sig-text-dim`, `.sig-skip`, `.sig-visually-hidden` |

### JS hooks and API

Behavior is wired from data attributes; state is `.is-*`:

- `[data-sig-toggle-theme]` (or `.sig-theme-toggle`) — flip light/dark, persist to
  `localStorage['sig-theme']`, fire `sig:themechange`.
- `[data-sig-nav-toggle]` (inside `.sig-masthead`) — hamburger; closes on Escape,
  outside-click, and link-tap via one shared document listener.
- `[data-sig-clock]` (optionally `data-sig-clock-prefix="ch 23"`, optional inner
  `[data-sig-clock-face]`) — renders a mono station time; updates each minute,
  static under reduced motion.

`window.Signal` exposes `isDark()`, `setTheme('dark'|'light')`, and `toggleTheme()`.

## Accessibility notes

- WCAG 2.1 AA, designed toward 2.2. Every documented color pairing is computed,
  not eyeballed, and verified by the contrast test against `tokens.json`.
- Visible focus ring: 2px solid blue at 2px offset on every interactive element
  (`:focus-visible`).
- 44px minimum touch targets on nav links, buttons, form fields, and toggles.
- A `.sig-skip` skip link is provided; use one `<h1>` and semantic landmarks
  (`header`, `nav`, `main`, `footer`) in the host markup.
- Sentence case throughout; labels are uppercased via CSS `text-transform`, never
  typed in caps. State is signaled by weight + underline, not color alone.
- `prefers-reduced-motion: reduce` zeroes animations/transitions, disables
  smooth-scroll, and freezes the channel clock. Smooth-scroll is scoped to
  `html:has(body.sig)` so an embedded kit never changes a host document's scroll.
- The SMPTE bars are decorative and should be marked `aria-hidden="true"`.

## Particle-NJ hero

The hero stage (`.sig-hero__stage`) wraps the shared Babylon particle-NJ canvas.
Signal's `NJHeroConfig`:

```json
{
  "background": "transparent",
  "fill": "#2638C4",
  "edge": "#F2F5FF",
  "pointSize": 2.6,
  "drift": 0.014,
  "repelRadius": 0.30,
  "repelStrength": 0.5,
  "dissolve": 1.5
}
```

Electric PBS-blue fill points with a near-white edge on the white field — crisp,
slightly larger points than the editorial direction, the "one becomes many"
Everyman idea in motion. Motion reads native `scrollY` only and never intercepts
scrolling; under reduced motion the engine renders the formed shape statically.

## Production: self-host the fonts

For now the kit references Archivo, Public Sans, and IBM Plex Mono via a Google
Fonts `@import` at the top of `sig.css`. In production, self-host a **subset
woff2** of each face with `font-display: swap` and the system fallback stack
already declared in the tokens, then drop the `@import`. This removes the
render-blocking request and the third-party runtime dependency. All three faces
are open-licensed (Archivo and Public Sans under the SIL Open Font License; IBM
Plex Mono under the SIL Open Font License).
