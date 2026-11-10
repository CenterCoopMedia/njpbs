# content-core

The editorial model, validation, static block renderer, and capability logic the
public site and admin CMS share. Both apps import one copy of these framework-free
contracts. Their presentation layers are separate and still need parity tests.

The table lists four core modules. `src/` holds about 150 more TypeScript
modules, such as schedule, player, media and publication contracts.

| Module | What it owns |
|--------|--------------|
| `src/content-model.ts` | Typed editorial records, the ADR 0013 block envelope, `parseBlocks`, `renderRichText` and the href scheme allowlist |
| `src/content-render.ts` | A validated block to canonical static markup for the public build; the admin reuses direct renders and helpers where its interactive React surfaces allow |
| `src/editor-admin.ts` | The per-template block palette, the pure `applyEditorOp` reducer, and the plain-language field descriptors |
| `src/rbac.ts` | The capability core: roles, capabilities, deny-by-default `can()`, section scopes, grants as data |

The modules import no framework or client library: no React, no Astro, no
Firestore, no TipTap, and no npm package. A few modules use runtime features.
`src/public-release-storage-batch.ts` imports `node:buffer`, and
`src/media-origin.ts` and `src/share-upload-origin.ts` read `process.env` when
it exists. The shared schedule DOM renderer updates only the element supplied by
its caller; the application owns its timers and network access.
That is what lets one copy serve two apps, and it is the constraint to
preserve: an import of a framework or a client here would force the other app to
carry it.

Live player markup, player permissions, schedule source validation and the
now/next clock and presentation also live here. Existing Site entry points
re-export these implementations. Admin imports them directly so an Admin-only
install never needs the Site's Astro compiler configuration or dependencies.

## How it is consumed

Both apps import these files by relative path:

```ts
import { parseBlocks } from "../../../packages/content-core/src/content-model";
```

No path alias, no workspace entry, no `file:` dependency, no build step. The
consumers compile the TypeScript source directly, which is why this package has no
`package.json` and ships nothing.

Sharing this package does not mean every admin block executes `renderBlock`.
`InlineBlockSurface` is interactive React markup: it directly renders divider and
embed markup, derives headline levels through the renderer, and reuses shared helpers
and content-model policies elsewhere. Its Home-only content shelf edits the finite
source, item limit, heading, and link contract while leaving feed cards derived.
Focused tests cover those behaviors; real page
composition and exact-preview checks still need to prove cross-surface visual parity.
The static renderer alone cannot do so.

The alternatives were rejected on cost. A tsconfig path alias would need matching
config in five places, because Vite does not read tsconfig paths: `site/tsconfig.json`,
`site/vitest.config.ts`, `admin/tsconfig.json`, `admin/vite.config.ts`, and
`admin/vitest.config.ts`. A workspace or `file:` dependency would need `site/` to
join the root workspace, which it deliberately does not: it keeps its own lockfile
and its own `node_modules`.

Verified to resolve in site (Vitest, `astro build`, `astro dev`, `astro check`) and
in admin (Vitest, `tsc -b`, `vite build`). `admin/tsconfig.json` includes only
`src` and `tests`, but `include` sets where the program starts, not what it may
reach, so `tsc -b` still typechecks these files through the import graph.

`site/astro.config.mjs` declares `server.fs.allow` at the repo root, because this
package sits outside the site's Vite root and the dev server has to be allowed to
read it.

## What is not here

The Cloud Functions runtime is CommonJS and cannot import this TypeScript source,
so `functions/lib/content-blocks.js` hand-mirrors `parseBlocks` for the server
write path. That mirror is behavioural rather than textual, and
`site/tests/content-blocks-parity.test.ts` pins the two together by feeding one
shared case table through both and asserting identical accept and reject results.
Change the model and that mirror together.

## Tests

The suites live with the consumers that already run them:
`site/tests/{content-model,content-render,editor-admin,rbac}.test.ts`, in the site
Vitest gate. `packages/**` triggers both the site gate in `ci.yml` and `admin-ci.yml`,
so a change here builds and tests both apps.
