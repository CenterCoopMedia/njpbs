# Render deployment resource configuration

`config/development-inputs.json` is the value-free source of deployment input
names, types, neutral template pins and their source/config consumers. Supply
every named input through the build environment. The development deploy and
publication workflows use the same repository variables, with no literal
fallback. The production API origin is a separate input and cannot equal a
development origin. Resource labels must also be distinct.

Render a disposable checkout before builds or operator processes start. The
renderer accepts only resource labels and HTTPS origins, refuses missing or
template values, validates the whole plan before writing and prints only a file
count. It substitutes source pins, hostname allowlists, escaped regular
expressions, Wrangler names, routes, containers and service bindings together.
Generic binding identifiers and Firebase project IDs remain unchanged.

With the inputs already supplied in the shell environment, run this Bash block
from the repository root. It performs no deployment or provider operation.

```bash
set -euo pipefail
render_root="$(mktemp -d "${TMPDIR:-/tmp}/development-config.XXXXXX")"
git worktree add --detach "$render_root" HEAD
trap 'git worktree remove --force "$render_root"' EXIT
node scripts/render-development-config.mjs --root "$render_root"
node scripts/render-development-config.mjs --check-source --root "$render_root"
```

Build or run separately authorized tools inside that rendered checkout. Never
commit rendered source or copy it back into a source branch. Legacy fixtures
are template consumers too: run them in a disposable rendered test checkout
with the synthetic suppliers in `tests/helpers/development-inputs.mjs`.
Run the renderer contract tests against the original neutral checkout.

Exact target comparisons remain in the consumers. Source admission still checks
the original commit and refuses staged, untracked or unrelated modifications.
It accepts a modified template only when every byte equals its committed source
rendered with the independently supplied inputs. Retained-source selection
restores only verified render changes before checking out the accepted commit,
then renders that source again. Renderer image contexts verify the committed
source before rendering it with the same inputs.

The deployment workflows render each fresh checkout before target validation,
builds or publication work. Rendering is build preparation: compiled Workers,
browser assets, Functions and containers contain resolved pins. No secret-store
lookup, private-repository fetch or substitution runs on a request path.

Production build workflows and production renderer images use `--production`
to resolve only `CMS_PRODUCTION_API_ORIGIN`. They do not require development
resource settings. Development-only branches retain inert neutral pins in those
artifacts. The offline prepared-Worker bundle check uses synthetic suppliers.

The renderer also recalculates the inline editor script's CSP hash from its
resolved bytes. An ignored, commit-bound input receipt lets isolated container
builds verify the same source preparation without inheriting operator settings.
Component receipt fingerprints include the relevant input digest, and installed
source readback compares the resolved committed bytes.

Generated Worker type headers are rehashed with their rendered type body. Placeholder rejection sentinels remain unchanged. Trusted helper checkouts link the installed workspace dependencies from outside the selected source tree.
