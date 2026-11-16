# Publisher image artifact

`publisher-image.yml` builds the exact main commit after its `CI/ci` result
succeeds. It prepares the committed source with its locked dependencies, then
uses `wrangler containers build --push --tag njpbs-cms-publisher:<SHA>`.
The command follows Cloudflare's [image management documentation](https://developers.cloudflare.com/containers/guides/image-management/).
It performs no publisher deployment. Concurrent runs for a SHA serialize;
reruns read and reuse its registry digest before considering a build. A failed
registry lookup stops the run; only a missing manifest permits a push.
The generated build Dockerfile adds a label with the existing deployment-input
fingerprint. Reuse verifies that label through the digest-checked manifest and
image config blob. Changed or absent fingerprints refuse reuse without pushing;
corrected production inputs require a new source commit.
Image-config reads support the [registry protocol's storage redirects](https://distribution.github.io/distribution/spec/api/)
without forwarding registry credentials.

## Coordinator setup

Create the protected GitHub environment `publisher-image`, restricted to main.
Only the configured `CMS_DEPLOY_OWNER` can dispatch or rerun its credential job;
the workflow also checks the configured repository ID and main workflow ref.
Set its single secret `CLOUDFLARE_PUBLISHER_IMAGE_TOKEN` to a Cloudflare API token
limited to managed container registry access for the intended account. It needs
registry push and pull-credential generation, with no Workers script deployment
permission. Verify that scope with the provider before authorizing the first
run. Source changes neither provision nor read this secret.

Supply `PUBLISHER_PUBLIC_VARS_JSON` as an environment variable containing the
complete current production publisher's public `vars` object. Its key set must
equal `publisher/wrangler.json`; the workflow changes only
`PUBLICATION_COMMIT_SHA` to the selected source. In particular, configure
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PUBLIC_WORKER_TAG`, the media endpoint and
public integration values, and retain `PUBLICATION_ENABLED` as `"true"`.
Never include secret bindings in this JSON. The account selects the registry;
there is no source-code account default.

Also supply the existing `CMS_DEPLOY_OWNER`, `CANONICAL_GITHUB_REPOSITORY`,
`CANONICAL_GITHUB_REPOSITORY_ID`, `CMS_PRODUCTION_API_ORIGIN`,
`CMS_LOCAL_PUBLICATION_OWNER` and `CMS_GPU_WORKER_ID` Actions variables. The
three CMS inputs render the exact source's production templates before the
container build. The preparation command installs the publisher lockfile; the
Dockerfile installs the root and site lockfiles inside the image.

## Receipt

One artifact, `publisher-image-<SHA>-<attempt>`, contains `receipt.json` and
`publisher.json`. The receipt records schema 1, `source_sha`, the immutable
`image`, the config filename and byte `config_sha256`, `workflow_run_id`, and
`source_checkout`. A registry GET verifies the manifest bytes at the digest
before the artifact is written. `deployment_input_sha256` records the fingerprint
of the three production template inputs baked into the image. Authentication
failures never trigger a push.

The config retains the exact source's resources, replaces the container image
with that digest, removes `image_build_context`, and uses the absolute
`source_checkout/publisher/worker.ts` entry. These are the substitutions expected
by jawn-ops method 3372638c's source/config comparison. The consuming release
must use the exact clean source at the recorded checkout path. If the release
owner uses a different path, it must rebind only `main` to that checkout and
record the resulting config checksum before creating its immutable plan.
The method still compares the supplied config against its own exact source and
retained production variables; the artifact grants no deployment authority.

The coordinator owns the separately authorized first dispatch and read-only
digest proof. Estimate 15–25 hosted runner minutes for a new SHA and 2–5 for a
rerun, with zero scheduled minutes. Keep this producer while the release method
consumes registry images; it adds no alternate deployment path.
