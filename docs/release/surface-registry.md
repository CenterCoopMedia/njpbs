# Release surface registry

`config/release-surfaces.json` records source declarations for every tracked
workflow, Wrangler config variant and Functions export. It also retains all
370 state-machine IDs, public owner paths and state labels from the November 14
source-map seed at the public revision named in `seedPublicRevision`.

Each machine has a `kind`: `deploy`, `release`, `ui`, `media`, `app` or `other`.
These labels support later scoped checks. The current check inventories all
surfaces and checks every listed machine owner path. It does not narrow the
registry to deployment machines.

The registry contains source names and paths. It contains no provider values,
private evidence, deployment admission or live ownership claim. Source coverage
does not prove that a machine's transitions are semantically complete or that a
deployed service uses the recorded source. Serving code and ordinary publication
generations, provider bindings, retained operations and installed host consumers
still need their own readbacks before a release switch.

## Update a surface

When adding or removing a workflow, Wrangler config or Functions export, update
the corresponding registry entry in the same PR. Include disabled workflow
source and all Wrangler config variants. A Functions export records its
entrypoint, name and source module; conditionally enabled exports remain listed.
The development manifest includes its optional cloud wake exports.

Review the owning state-machine row when changing its source state fields or
transitions. Update its state labels and owner paths when those facts change.
The source inventory check does not infer new implicit application machines or
prove unchanged state semantics. Keep that review explicit.

The Functions reader parses JavaScript with the site's locked TypeScript
dependency. It reads literal `lazyExport` calls and static CommonJS and ESM
exports without importing application code. It discovers Firebase package
entrypoints, the development adapter and the recovered standalone billing
Function's module. All symbols exported by that module are inventoried;
helper exports are source declarations, not a deployed-function census.

The dev adapter reads the frozen `DEV_FUNCTIONS` object and
`CLOUD_WAKE_FUNCTIONS` list. Its registration program must match the recognized
syntax shape, with the literal registration object inventoried separately.
Comments, whitespace and quote style do not change that shape. Unknown producer
programs and wildcard re-exports require an explicit source-reader change and
a contract test; they must not disappear from the inventory silently.

## Hosted check

The existing hosted Policy job runs the registry check and its focused mutation
contracts after its existing site dependency install. It covers new workflows,
config variants and production/development export declarations, plus removed
surfaces, missing owner paths, duplicate exports and unsupported registrations.
It adds no job, dependency install, cloud request or credential requirement.
Expected added time is less than one minute per run within Policy's existing
ten-minute timeout. Identical-tree CI reuse retains its existing full-proof rule.

Commands for the hosted runner with the site dependencies installed:

```sh
node scripts/check-release-surfaces.mjs
node --test tests/scripts/release-surfaces.test.mjs
```

Public-repository checks run on GitHub-hosted CI. No local execution is needed.
