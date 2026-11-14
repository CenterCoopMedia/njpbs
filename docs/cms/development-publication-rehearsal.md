# Development publication rehearsal

This procedure restores the cloud publication control after a development
bootstrap retirement. It applies only to `njpbs-site-dev`. Use a separately
authorized development window. Production, its credentials and the previous
repository stay unchanged.

The order is: Complete a public code refresh, initialize its matching runtime,
then publish one synthetic Post. New editorial jobs require the runtime. The
existing push code-refresh owner can publish without it. Do not initialize the
runtime at a commit that exists only in the previous repository.

Run the operator commands in a held **Bash session on officejawn**, with Node 22
and a clean reviewed public checkout. Hosted Actions runs all builds and CI.
Keep packets and evidence outside the checkout. Set `PUB` to the configured
canonical repository, `CANDIDATE` to a green public main commit and
`DEV_INSTALL_EVIDENCE` to a new absolute private evidence directory. Credential
entry variables contain vault pointers only. Never print credential values.

## Check the rehearsal window

1. D10: Read the previous repository's dev publication workflow state. It must
   already be `disabled_manually`, with no running, queued or waiting dev
   publication. The coordinator owns any change to that repository.
2. D11: Read the public workflow states. `cms-dev-deploy.yml`,
   `dev-staff-gateway-deploy.yml`, `dev-machine-receipt-proof.yml`,
   `dev-anonymous-refusal.yml` and `cms-dev-publish.yml` must be active.
3. Read `CMS_DEV_PUBLISH_ENABLED`; it must be `false`. Read the development
   environment's three source pins. Confirm that all source commits exist in
   the public repository and have successful CI. Keep production workflows off.
4. Read development Firestore without changing it. The runtime and its 08a
   initialization receipt must be absent. The deployment pointer must be idle,
   with equal active, last-reserved and newest-eligible generations. No
   publication queue may be unsettled. No pair enrollment, release change head,
   producer, bootstrap fence or release-writer fence may exist. Inspect retained
   initialization and retirement receipts before choosing the primary serializer.

Preserve the before-state and record each proposed provider or Firestore write
before execution. Stop on unexpected state. An absent control does not authorize
an inferred serializer identity or a direct document patch.

## Complete the public code refresh

D12 first deploys the public development candidate. Set the three development
source pins through the normal reviewed preparation to public source commits.
When the renderer pin changes, release it with the deployment:

```bash
gh workflow run cms-dev-deploy.yml --repo "$PUB" --ref main -f release_preview_renderer=true
```

Read the run conclusion and verify the deployed development Functions point to
the public repository and expected source. Then run the machine receipt proof:

```bash
gh workflow run dev-machine-receipt-proof.yml --repo "$PUB" --ref main
```

Choose one existing public `cms-dev-publish.yml` **push** run whose exact main
commit is the candidate. Its source CI must pass, its original sender and rerun
actor must pass the configured trusted-actor checks, and it must have skipped
because publishing was off. Record its ID and source. Do not rerun a failed or
partly uploaded publication as a fresh code release.

In the authorized development window, enable the public development publishing
flag and rerun that skipped push once:

```bash
gh variable set CMS_DEV_PUBLISH_ENABLED --repo "$PUB" --body true
gh run rerun "$CODE_REFRESH_RUN" --repo "$PUB"
```

The original workflow owns queue creation, frozen input, build, upload,
activation and terminal writeback. Wait for it to finish. Require its exact
queue to be `success`, its batch to be `deployed`, the pointer to be idle at the
candidate, and its schema-two Post capability to name the same renderer. Check
the live publication receipt through the configured development Access route.
The stored batch, Worker candidate, active deployment/version and exact public
receipt bytes must all agree. Keep these bytes, including whitespace.

Set the publishing flag back to `false` before preparing 08a. If the refresh is
uncertain, preserve its original run and artifacts and use the existing retained
publication reconciliation procedure. Do not initialize against uncertain state.

## Initialize the matching runtime (08a)

The existing initializer is create-only. It does not upload code, move the
pointer, start a publisher service or change the media lifecycle flag. Reuse the
explicitly approved primary serializer recorded by the retained development
initialization. Both runtime pins name the public commit just proved.

Prepare this packet outside Git, using inspected values:

```json
{
  "schemaVersion": 1,
  "kind": "dev-public-predecessor-operator",
  "step": "runtime",
  "operatorCommitSha": "<clean reviewed public operator commit>",
  "credentialIdentity": {
    "projectId": "njpbs-site-dev",
    "clientEmail": "<approved development SDK service account>",
    "privateKeyId": "<public key id>",
    "secretRef": "pass://<development SDK entry>"
  },
  "request": {
    "schemaVersion": 1,
    "operationId": "<approved initialization id>",
    "environment": "development",
    "projectId": "njpbs-site-dev",
    "oldRuntime": {
      "schemaVersion": 1,
      "phase": "ready",
      "commitSha": "<proved public candidate commit>",
      "serializerId": "<explicit approved primary serializer>",
      "cloud": {
        "phase": "ready",
        "commitSha": "<same proved public candidate commit>",
        "serializerId": "cloudflare-dev-publisher"
      }
    },
    "legacyPointerDigest": "<legacyBootstrapPointerDigest of the fresh idle pointer>",
    "publicReceiptBytes": "<exact UTF-8 live publication receipt>",
    "deploymentId": "<active deployment UUID>",
    "versionId": "<active immutable Worker version UUID>"
  }
}
```

Set `CMS_DEV_SDK_CLIENT_EMAIL` to the approved service-account identity.
`DEV_RUNTIME_INIT_PACKET` names the packet, `DEV_RUNTIME_INIT_PACKET_SHA256`
is its exact file SHA256, and `DEV_SDK_ENTRY` names the credential pointer.
The operator commit can differ from the published candidate; both must be
public, reviewed sources. Use the rendered development configuration required
by the operator's exact-source check.

Run the command file unchanged:

```bash
bash scripts/development-install/08a-runtime-initialize.sh
```

The file performs plan, apply and readback. Plan opens no credentials. Apply
reads the development SDK account on pipe fd3. Its transaction creates only
`system/cmsPublicationRuntime`,
`system/devPublicPredecessor/initializations/runtime` and one `admin_logs` entry.
Require `committed: true` and `currentReady: true` in the original readback.
Read the pointer and capability again; their identities must remain unchanged.
Keep an existing media initialization; do not run 08b when the media flag is
already true.

A second apply refuses. After uncertain apply, preserve the packet and use its
original `--readback`. There is no inline undo. Retain the ready control for
development publishing. To stop publishing after a failure, set the development
publishing flag to `false` and preserve the evidence. Removing the runtime needs
the separate development retirement owner and its authorization; never delete
or patch the control directly.

## Prove editorial publication and clean up

Enable the development flag for one synthetic Post. Use a unique rehearsal
slug, no staff content, no schedule and no media. Publish through the development
CMS. Capture the accepted queue ID and its public repository dispatch run.
Require terminal queue `success`, deployed batch and matching live receipt;
verify the Post route through development Access. A successful deploy or machine
proof alone does not prove publication.

Remove the synthetic Post through the CMS, finish its removal workflow and
verify its route is absent. Restore `CMS_DEV_PUBLISH_ENABLED=false`. Run the
machine receipt proof again. Record the public commit, hosted run URLs, runtime
packet digest, readback and cleanup result. Recheck that the previous dev writer
is disabled and production remains off. Report unresolved effects explicitly.

The hosted emulator proof in `tests/functions/dev-public-predecessor.test.ts`
uses the real reservation, manifest, candidate and activation owners without a
runtime, then proves editorial admission fails until 08a creates the matching
control. It also checks that initialization leaves the pointer unchanged.
