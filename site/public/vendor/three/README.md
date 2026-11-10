# Three.js carousel runtime

This directory vendors the two browser modules used by the homepage content carousel from the official Three.js `r185` tag.

- `build/three.core.min.js` is the exact upstream file with Git blob `fcf90d35125fb8032944f3211a57fb5f29433bae`.
- `examples/jsm/renderers/CSS3DRenderer.js` starts from upstream Git blob `93262aab4fa40f6f2fab5a43a40b8c2d26e1cfc4`; only its bare `three` import is rewritten to the local core module above.
- `LICENSE` is the exact upstream MIT license with Git blob `8ada2a5f982916b0ba4b7a0aa7de347587e745d7`.

The runtime is self-hosted so the enhancement works with the site's `script-src 'self'` policy. Update the pinned tag and all three hashes together.

Three.js documents CSS3DRenderer as supporting 100% browser and display zoom. The carousel therefore keeps its complete native scroll-snap implementation as the progressive-enhancement fallback rather than making content access depend on CSS3D rendering.
