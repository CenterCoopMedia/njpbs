# NJ PBS website and content tools

This repository contains the NJ PBS website, the Boardwalk content editor,
publishing services, and related development tools.

## Project layout

- `site/`: Astro public website.
- `admin/`: React content editor.
- `functions/`: Firebase backend and content validation.
- `cms-api/`: Cloudflare API gateway.
- `workers/`: Shared edge Worker sources, binding declarations and configs.
- `packages/`: Shared content contracts and rendering code.
- `publisher/` and `preview-renderer/`: Publication and preview services.
- `scripts/`: Development and deployment commands.
- `qa/` and `proof/`: Accessibility checks and local proof tools.
- `infrastructure/`: Parameterized infrastructure templates.
- `tests/`: Root test suites for Firebase rules, functions, preflight and Workers.
- `crawl-worker/`: Disabled-by-default Worker that extracts pages from the public site.
- `agents/`: Studio connector for vMix and its Windows packaging.
- `premiere-boardwalk-panel/`: Premiere Pro panel for the shared video library.
- `ops/`: WordPress packages and a read-only route probe.
- `config/`: Configuration input contracts and deployment settings.
- `deploy/`: systemd units for the preview serializer and schedule monitor.
- `branding/`: Brand images, such as the site favicon.
- `archive/`: Reference themes kept outside the active build.
- `wiki/`: Public notes on organizations and key dates.
- `docs/decisions/`: Architecture decisions.
- `docs/requirements/`: Accessibility requirements.

See the [CMS content operations contract](docs/cms/content-operations.md) for
request versions, supported edits, and publication receipts.

## Local setup

Use Node.js 22 and npm. Install dependencies from the root lockfile, then install
the website package:

```sh
npm ci --ignore-scripts
npm --prefix site ci --ignore-scripts
```

After installing dependencies, run `npm run functions:build` to compile the
TypeScript entries in `scripts/functions-contract-sources.json` into CommonJS
in `functions/lib/`. Edit the listed sources. Site CI type-checks the contracts
and Functions CI exercises the generated modules. The Functions test, emulator
and Firebase deploy commands also build the contracts automatically.

`.env.example` lists the settings that some commands need. Export the ones your
work needs in your shell; nothing loads a root `.env` file. Workspace packages
can have their own example files. Use emulators
and synthetic content for local work. Keep credentials out of Git and logs.

```sh
npm run admin:dev
npm run emulators:start
npm --prefix site run dev
```

## Checks

Run the checks for the package you change. Common commands include:

```sh
npm run test:preflight
npm run admin:test
npm --prefix site run check
npm --prefix site test
python3 -m unittest discover -s qa -p 'test_*.py'
node --test .github/scripts/*.test.mjs
```

CI selects Docs, Site, Admin and Firebase checks from the exact pull request diff.
Admin and Firebase run as reusable workflows. Merge queue entries check all four
areas on the combined tree and report the required `ci` check. The default branch
checks all four areas unless the same tree has valid full-CI proof. Independent
review uses a different model provider from the author, with verified findings
fixed before submission.

After changing a pull request's base branch, push an updated head or reopen
the pull request to run CI for the new base.

Required CI compares lint and Functions JavaScript types on pull requests and
merge groups, each against the first parent of the tested merge, and fails for
new errors. Function length (over 200 lines) and file size (over 1,000 lines)
appear in the report totals only; a long function or file runs the same as a
short one. Download the `code-health` artifact for the tested tree, its base,
the base's ESLint bulk suppressions and the new findings. The check compares
lint counts by file, rule and message, and type counts by file, rule, flagged
line text, column and flagged text, so shifted lines and type messages that
quote a changed signature keep their baseline. An error on a line the change
edits counts as new. It also tracks detected renames.
Test files are linted and excluded from size counts. Main pushes record the
current baseline in the **Code health** workflow.

| Report | Failure it identifies | Existing protection | Removal condition |
| --- | --- | --- | --- |
| Lint | New correctness findings such as invalid hooks or undefined JavaScript names | Required Functions lint and Astro accessibility lint, builds and review | Remove a rule when another check catches the same defect |
| Functions types | New JavaScript type mismatches such as invalid call arguments | Functions unit and emulator tests exercise runtime paths | Remove this pass when equivalent type coverage checks Functions |

Complexity warnings help identify functions for review.

The configuration input check scans current source reads against
`config/configuration-inputs.json`. Each input needs a named supplier, scope and
preparation step; remove its entry when its last reader leaves. Computed reads
require a `config-input: NAME` comment immediately before the access (comma-separated
names and consecutive annotation lines are supported). Run
`python3 tests/scripts/configuration-inputs.test.py`
to check the reader forms and current source inventory. Only names are stored or
reported; configuration values stay outside the contract.

`config/step-inputs.json` lists the named environment inputs that the
CMS staging and publisher image entry scripts require across their workflow
invocations. An empty list records an audited script with no common required
setting. Update the contract alongside an entry script's requirements.
Hosted Policy CI checks the script inventory, explicit required reads, step
wiring and secret or variable references using the declared supplier names.

The [release surface registry](docs/release/surface-registry.md) records tracked
workflows, Wrangler config variants, Functions exports and state-machine owner
paths. Hosted Policy CI rejects missing or stale surface entries. Update the
registry in the same PR as the source declaration.

The workflows use GitHub-hosted Ubuntu 24.04 runners. Deploy workflows require
explicit repository variables, environment protection, and deployment credentials.
No cloud account identifiers or deployment credentials are supplied by this source.
Deployment commands require explicit identity and Access-origin settings before a
cloud write. Set `CMS_DEV_ACCESS_ORIGIN` to the configured HTTPS issuer origin,
without a path or trailing slash. The schedule monitor reads its configured
`SCHEDULE_MONITOR_KUMA_ORIGIN` from the service environment.

The public site uses the [Cloudflare release workflow](docs/cms/public-worker-deploy.md).
The [production branch promotion workflow](docs/release/production-branch.md)
fast-forwards to the selected reviewed source after its required CI passes.

Read [the contributor rules](AGENTS.md) and [support guide](SUPPORT.md) before
opening a pull request. Site questions can go to <njpbs@montclair.edu>.

## License

The code is available under the [MIT license](LICENSE), copyright 2026 NJ PBS.
The code license gives no rights to logos, trademarks, photos, video, fonts or
editorial content. See [NOTICE](NOTICE) for exclusions by path and separate
third-party licenses. Keep supplied licenses and notices intact.
