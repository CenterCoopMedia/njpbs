# Worker sources and configuration

The loose edge Workers share the repository's root dependency installation.
Their implementation and binding declarations live in `src/`. Deploy configs
and Worker typecheck configs live beside this file. The API, publisher, preview
renderer and crawler keep their own package directories.

Run commands from the repository root:

```sh
npm run check:preview-worker
npm run check:staff-sites
npx --no-install tsc --project workers/tsconfig.shadow-posts.json
npm run test:public-worker
npm run test:preview-worker
npm run test:staff-sites
npm run test:cloud-publisher
npm run test:preview-renderer
```

`wrangler.jsonc` serves the public entry and uses `site/dist` assets;
`wrangler.public.dev.jsonc` uses `dev-publication/dist`. The shadow config uses
`site/.shadow-renderer/client`. These paths resolve from the config directory.
The other configs select preview, staff, relay and routing measurement entries.
Pass the config path explicitly, for example
`--config workers/wrangler.preview.jsonc`, from the repository root.

Generated ingress, slot and private reader configurations use entry paths under
`workers/src/`. Render configuration inputs as described in
[Wrangler configuration rendering](../docs/config/wrangler-rendering.md) and
[development configuration rendering](../docs/config/development-rendering.md).
Deployment requires separate authorization and configured provider credentials.

Workers Builds keeps the repository root as its working directory and uses
`npx wrangler versions upload --config workers/wrangler.jsonc` as its upload-only
deploy command. The activation operator checks that exact command. Configure
the trigger during the separately authorized repository handoff; this layout
change does not update provider settings.
