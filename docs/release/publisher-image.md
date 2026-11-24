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

## Development target

Dispatch with `target=development` to build the development publisher from the
same source. The image is named `njpbs-dev-cms-publisher`. The run checks the
development config against the source with only the Worker and container name
(`njpbs-dev-cms-publisher`), the `DURABLE_POST_WITHDRAWALS` bucket
(`njpbs-dev-cms-publication`) and the route (`dev-publisher-health.njpbs.org`)
replaced, all from `functions/lib/publication-target.js`. Every development
input is rendered, so the image fingerprint covers all of them. The run title
is `Publisher image development <SHA>` and the artifact is
`publisher-image-development-<SHA>-<attempt>`. Production titles, artifacts and
receipts are unchanged.

The development job reads `PUBLISHER_DEVELOPMENT_PUBLIC_VARS_JSON` from the same
`publisher-image` environment: the same key set, with `CMS_DEPLOYMENT_ENVIRONMENT`
`development` and `PUBLICATION_SERIALIZER_ID` `cloudflare-dev-publisher`. Both
targets refuse a variables map whose environment or serializer names the other
target.

A development run also adds the repository variable
`CMS_DEV_CLOUDFLARE_ACCOUNT_ID` to its variables map, and the development
source declares that key. The development config refuses unless the pin equals
`CLOUDFLARE_ACCOUNT_ID`. The Worker passes the pin to the publisher container,
which checks it before every upload. A production map never has the key.

A production run calls the source's preparation script with only the SHA, as
older source commits require; only a development run adds `development`, so a
source commit without development preparation refuses.

A development artifact contains only `receipt.json`: schema 1, `target`,
`source_sha`, the immutable `image`, `workflow_run_id` and
`deployment_input_sha256`. It has no `publisher.json`. The development Worker
bundles `functions/lib/publication-target.js`, whose development Worker name,
origin and preview bucket are templates until rendering, and the withdrawal
catalog keys derive from that Worker name; a config pointing at this unrendered
checkout would write catalogs the development public Worker never reads. The
artifact grants no deployment authority.

## Development install outside a release run

`scripts/install-dev-publisher.mjs --sha X --image-run <run> [--check]`
installs the development publisher at main commit X from that run's
development artifact. Run it from a clean checkout of main that contains X,
with the root and site dependencies installed, `CANONICAL_GITHUB_REPOSITORY`
and `CANONICAL_GITHUB_REPOSITORY_ID` set, and no Firebase emulator or ambient
credential settings. Supply three credentials on
descriptors, each read only when it is used: 3, the development Firestore
operator credential JSON; 4, the development publisher deploy token; 5, the
development Cloudflare read token. `--check` makes every read and stops
before the deploy, so it never opens descriptor 4.

The script installs nothing until all of these pass:

- The run is a successful main `publisher-image.yml` run of the configured
  repository (name and numeric ID), titled `Publisher image development X`.
- Its receipt names target `development`, source X and a
  `njpbs-dev-cms-publisher` image.
- The script renders X with the same GitHub variables the run read (the
  `publisher-image` environment first, then the repository), and the
  fingerprint must equal the receipt's `deployment_input_sha256`.
- The rendered config passes the image workflow's source/config comparison,
  and it names only the development Worker, container, route and bucket.
- `system/cmsPublicationRuntime` is ready, with `commitSha` and
  `cloud.commitSha` both X.
- `system/publicDeployment` is idle at X.
- The live Worker carries exactly the development secret names.

There is no target argument. The script fixes the Worker name
`njpbs-dev-cms-publisher` and requires exactly one container application
with that name. The deploy token can also write production Workers.

The deploy runs `wrangler deploy --name njpbs-dev-cms-publisher
--containers-rollout immediate --secrets-file <{}>`. Cloudflare's
[rollout documentation](https://developers.cloudflare.com/containers/platform-details/rollouts/)
says the first deploy creates the container application without a rollout,
and a later deploy with a changed image starts one. `immediate` makes that
one 100% step. The empty JSON secrets file sets `keep_secrets`, so every
existing secret, including a placeholder, stays unchanged. Per Cloudflare's
[secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/),
"Secrets not included in the file are preserved from the previous version".
The script handles no secret values.

The script skips the deploy and only reads back when the Worker is on one
version naming X and the app already runs the receipt image. The image a
completed rollout applied counts, and so does a first install's own image
with no rollout (jawn-ops records that state as `NoRollout`). Otherwise it
deploys, so Worker drift at an unchanged image is repaired. The readback
waits up to 15 minutes for all of the following:

- a single Worker version at 100% with `PUBLICATION_COMMIT_SHA` X (a new one
  after a deploy);
- the same secret names;
- the receipt image applied. With rollouts, the newest must be `completed`,
  bound to the application, and on every instance; the application record
  can keep the previous image after the rollout completes. `pending` and
  `progressing` keep the wait going, and `reverted` or `replaced` refuse.
  With none, the application record's image must be the receipt image;
- `/health` 200.

It prints one JSON receipt with the previous and current version IDs, the
rollout ID or `noRollout: true`, and whether it deployed. After a deploy,
jawn-ops' development first-install record (`release_target_settings.go`)
no longer describes the live publisher. Update or delete that record from
the printed version before the next development release run.
