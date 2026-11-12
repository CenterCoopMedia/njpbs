# Admin visual baseline method

Run from the repository root in a credential-free Linux user session with root
lockfile dependencies installed. Use one Playwright worker and the repository-owned Public Sans
proof fixture. The suite serves the three committed open TTF faces at the media
font network boundary before navigation. Synthetic SVG covers embed the same
regular and bold files, so host fonts do not determine their text. Tests that
create an explicit browser context install the same proof-font handler before
navigation.
Runtime PBS Sans availability is separate from this deterministic UI proof.

Use the default headless Chromium shell installed by locked Playwright 1.65.0:
**Chromium 158.0.8127.18, revision 1254**, with the browser sandbox enabled.
Root, Admin and Site lockfiles pin the approved Playwright release; the MCP
package pins its matching alpha release. Do not install bundled Chromium below
156.0.8078.73. Full Chrome has different text metrics and cannot generate these
baselines. Keep screenshot tolerances unchanged.

Set these existing test options in the Linux shell, using an installed official
headless-shell binary and a root-owned setuid Chrome sandbox helper:

```sh
export PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome-headless-shell-linux64/chrome-headless-shell
export CHROME_DEVEL_SANDBOX=/path/to/chrome-sandbox
export NJPBS_FLEET_CI=1
"$PLAYWRIGHT_CHROMIUM_EXECUTABLE" --version
```

Confirm the exact 158.0.8127.18 version and record the binary SHA-256. Launch a
sandbox probe through the same Playwright package with `chromiumSandbox: true`;
record the actual browser process arguments and require no `--no-sandbox`.
The helper must be root-owned and setuid. Do not disable the sandbox to repair
an installation problem.

Regenerate only the baseline owners, then run their comparison plus the focused
font/preview behavior cases:

```sh
npm exec --workspace njpbs-admin -- playwright test --update-snapshots=all specimens.spec.ts post-inspector-responsive.spec.ts coverage-labels.spec.ts brand-forced-colors.spec.ts
npm run admin:test:visual -- specimens.spec.ts post-inspector-responsive.spec.ts coverage-labels.spec.ts brand-forced-colors.spec.ts font-style.spec.ts editor-composition.spec.ts component-phone-preview.spec.ts
```

Compare all 38 images with `origin/main`. Expected changes are Public Sans text
metrics and resulting wrapping. Preserve controls, hierarchy, icons, colors,
focus, spacing owners and phone bounds. Inspect before accepting the images;
a passing updated screenshot does not establish usability. Keep evidence images
outside the source repository; committed golden fixtures are the exception.

Real media fonts require separate byte, MIME, CORS, CSP and desktop/phone reader
verification. PDFs read the committed Public Sans files. Existing social-art
PNGs remain published assets; the unused source generator has been removed.

For a browser upgrade, inspect the actual PNGs from every failed hosted CI
visual shard against `origin/main`. Accept changed baselines once in the
dependency PR and list each changed file, run and browser-rendering difference.
Stop if a difference changes the layout. Do not generate upgrade baselines
locally or on a fleet node. Keep full-page capture and verify dark/light
forced-color images differ before accepting those baselines.
