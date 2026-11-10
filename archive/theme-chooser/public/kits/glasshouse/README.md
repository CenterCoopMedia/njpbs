# Garden signal glasshouse kit

A fourth chooser direction: a flourishing New Jersey garden seen through retro public-television glass. It combines greenhouse grids, CRT screen cards, phosphor focus states, seed-packet labels, reactive signal meters, drifting vine layers, and a 3D signal-garden hero.

## Files

- `glasshouse.css` is the namespaced design system. Use the `.glasshouse` wrapper and `glasshouse-` classes.
- `glasshouse.js` adds optional behavior for the mobile nav, utility dismissal, theme toggles, passive parallax and pointer variables, and an optional Three.js decorative canvas.
- `tokens.json` declares the palette and every foreground/background contrast promise.

## Accessibility contract

- Body copy never sits directly over animated texture or the 3D canvas.
- Every text pairing in `tokens.json` must clear WCAG AA through the token test before the kit is considered usable.
- Focus states use a visible outline plus offset, not color alone.
- Motion is decorative. `prefers-reduced-motion: reduce` disables parallax, pointer drift, meter animation, scan sweeps, and hover lifts.
- The dynamic CSS layers and the Three.js layer are optional and decorative. They must be `aria-hidden` and must never intercept pointer, wheel, touch, or keyboard scroll.
- Forms use real labels. Sample forms do not submit.

## Three.js layer

The kit exposes an optional `window.Glasshouse.mountThree(canvas)` helper. It dynamically imports Three.js from a public CDN only when a host page supplies a `<canvas data-glasshouse-three aria-hidden="true"></canvas>`. If the import fails, the canvas stays hidden and the page remains complete.

The shared NJ particle hero remains the primary 3D moment in the chooser because it already has tested WebGL fallback and reduced-motion behavior. The Three.js layer is a progressive decorative garden-signal pane for pages that want it.

## Avoid

- Do not add custom scroll containers, scroll snapping, wheel interception, or smooth-scroll libraries.
- Do not use official PBS or NJ PBS logo artwork.
- Do not state a launch date, operator change, or connected donation, Passport, video, schedule, or account service.
