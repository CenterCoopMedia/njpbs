import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { createPublicArtifactInventoryReceipt } from "../site/src/lib/public-artifact-inventory.ts";
import { assertPinnedDevRendererReceipt, collectDevRendererIdentity, deployDevPreview, devPreviewFailureDetails, devRendererReleaseStart, formatDevPreviewReleaseFailure, parseDevPreviewReleaseInputs } from "../preview-renderer/deploy-dev.mjs";

// Provider responses follow the Cloudflare application/Worker version schemas
// already consumed by cms-component-receipt.mjs. They simulate network only;
// #2957 supplies the independent dev target and exact-release requirements.
const sha = "a".repeat(40);
const appId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const releaseStartedAt = "2026-10-11T16:00:00.000Z";
const options = { accountId: "a".repeat(32), releaseStartedAt, rolloutDeadlineMs: 0, log: () => undefined };
const worker = "template-dev-cms-preview-renderer";
const environment = () => ({ CANONICAL_GITHUB_REPOSITORY: "CenterCoopMedia/njpbs", CANONICAL_GITHUB_REPOSITORY_ID: "1442374012",
  GITHUB_REPOSITORY: "CenterCoopMedia/njpbs", GITHUB_REPOSITORY_ID: "1442374012", CMS_DEPLOY_OWNER: "release-admin",
  CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev",
  CLOUDFLARE_ACCOUNT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  DEPLOY_SHA: sha, GITHUB_WORKFLOW_SHA: sha, GITHUB_SHA: sha, GITHUB_REF: "refs/heads/main", GITHUB_ACTOR: "release-admin", GITHUB_TRIGGERING_ACTOR: "release-admin",
  CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: JSON.stringify(["release-admin"]),
  GITHUB_WORKFLOW_REF: "CenterCoopMedia/njpbs/.github/workflows/cms-dev-deploy.yml@refs/heads/main", RUNNER_ENVIRONMENT: "github-hosted",
  CMS_DEV_PUBLISH_ENABLED: "false",
  CMS_DEV_RELEASE_PREVIEW_RENDERER: "true",
  CMS_DEV_PREVIEW_FIREBASE_ACCOUNT: JSON.stringify({ type: "service_account", project_id: "njpbs-site-dev",
    client_email: "cms-dev-preview-renderer@njpbs-site-dev.iam.gserviceaccount.com", private_key: "fixture-not-a-real-key".repeat(4) }),
  CMS_DEV_PREVIEW_R2_CREDENTIAL: JSON.stringify({ accessKeyId: "A".repeat(32), secretAccessKey: "B".repeat(64) }),
  CMS_DEV_ACCESS_CLIENT_ID: "fixture-dev-publisher.access", CMS_DEV_ACCESS_CLIENT_SECRET: "fixture-dev-service-secret",
  CLOUDFLARE_API_TOKEN: "fixture_cloudflare_token_123456789",
});

describe("safe dev release failure details", () => {
  it("reports only a valid HTTP status and an allowed error class", () => {
    const secret = "fixture-secret-must-not-be-logged";
    const providerError = Object.assign(new Error(secret), { name: "AccessDenied", $metadata: { httpStatusCode: 403 }, body: secret });
    expect(devPreviewFailureDetails(providerError)).toBe("HTTP 403; error class AccessDenied");
    expect(devPreviewFailureDetails(Object.assign(new Error(secret), { httpStatus: 302, errorClass: "TypeError" })))
      .toBe("HTTP 302; error class TypeError");
    expect(devPreviewFailureDetails(Object.assign(new Error(secret), { name: secret, httpStatus: secret, body: secret })))
      .toBe("error class Error");
  });

  it.each([undefined, null, { name: "SyntaxError" }, { name: "PublicWorkerArtifactError" },
    { name: "Error", httpStatus: 99 }, { name: "Error", httpStatus: 600 }, { name: "Error", httpStatus: 403.5 }])
    ("withholds untrusted details for %j", error => {
      expect(devPreviewFailureDetails(error)).toBe(`error class ${error?.name ?? "Error"}`);
    });
});

describe("dev preflight failure output and admission hold", () => {
  it.each(["publication-probe", "provider-applications"])("names the failed %s HTTP boundary", async failedPhase => {
    const cutoffAt = { seconds: 1_780_000_000, nanoseconds: 0, toMillis: () => 1_780_000_000_000 };
    const context = { schemaVersion: 3, pages: [], posts: [], programs: [], authors: [], settings: [],
      receipt: createPublicArtifactInventoryReceipt({ reservation: { schemaVersion: 1, buildBatchId: "cms-11111111111111111111",
        generation: 1, status: "reserved", commitSha: sha, reservedAgainstGeneration: 0,
        reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null, cutoffAt, reservedAt: cutoffAt },
        pages: [], posts: [], programs: [], authors: [], settings: [] }) };
    const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    const bytes = Buffer.from(`${JSON.stringify(context)}\n`);
    const publication = { schemaVersion: 1, digestAlgorithm: "sha256", buildBatchId: context.receipt.buildBatchId,
      generation: 1, commitSha: sha, mediaManifestDigest: context.receipt.mediaManifestDigest,
      artifactDigest: "d".repeat(64), artifactReceiptDigest: digest(JSON.stringify(context.receipt)) };
    const manifest = { schemaVersion: 1, buildBatchId: publication.buildBatchId, artifactReceiptDigest: publication.artifactReceiptDigest,
      sha256: digest(bytes), byteLength: bytes.length, key: `public-context/${publication.buildBatchId}/${digest(bytes)}.json` };
    let control = { schemaVersion: 1, phase: "ready", rendererSha: "b".repeat(40), serializerId: "cloudflare-preview" };
    const firestore = {
      doc: () => ({}),
      collection: () => ({ doc: () => ({ get: async () => ({ data: () => manifest }) }) }),
      runTransaction: async fn => fn({ get: async () => ({ exists: true, data: () => control }), set: (_ref, value) => { control = value; } }),
    };
    const { S3Client } = createRequire(new URL("../functions/package.json", import.meta.url))("@aws-sdk/client-s3");
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({ ContentLength: bytes.length,
      Body: { transformToWebStream: () => Readable.toWeb(Readable.from([bytes])) } });
    vi.stubGlobal("fetch", async url => String(url).startsWith("https://dev-public.example.org/") && failedPhase !== "publication-probe"
      ? Response.json(publication) : new Response("fixture-private-provider-body", { status: 403 }));
    try {
      let failure;
      try { await deployDevPreview(firestore, parseDevPreviewReleaseInputs(environment(), sha)); }
      catch (error) { failure = error; }
      expect(formatDevPreviewReleaseFailure(failure)).toBe(`Dev preview release failed at dependency-preflight/${failedPhase}; HTTP 403; error class Error; raw details withheld\n`);
      expect(control).toEqual({ schemaVersion: 1, phase: "paused", rendererSha: "b".repeat(40), serializerId: "cloudflare-preview" });
    } finally { send.mockRestore(); vi.unstubAllGlobals(); }
  });
});

describe("dev renderer release admission", () => {
  it("accepts the transferred main workflow and refuses a fork copy", () => {
    const ref = "CenterCoopMedia/njpbs/.github/workflows/cms-dev-deploy.yml@refs/heads/main";
    expect(parseDevPreviewReleaseInputs({ ...environment(), GITHUB_WORKFLOW_REF: ref }, sha).rendererSha).toBe(sha);
    expect(() => parseDevPreviewReleaseInputs({ ...environment(),
      GITHUB_WORKFLOW_REF: ref.replace("CenterCoopMedia", "fork") }, sha)).toThrow();
  });
  it("admits only the dedicated dev identity on the exact hosted main workflow", () => {
    const inputs = parseDevPreviewReleaseInputs(environment(), sha);
    expect(inputs.rendererSha).toBe(sha);
    expect(inputs.account.projectId).toBe("njpbs-site-dev");
    expect(inputs.account.clientEmail).toBe("cms-dev-preview-renderer@njpbs-site-dev.iam.gserviceaccount.com");
  });
  it("admits a retained paused source without fetching unused storage or Access credentials", () => {
    const retained = "b".repeat(40);
    const env = { ...environment(), CMS_DEV_RENDERER_ONLY: "true", CMS_DEV_RENDERER_REQUESTED_SOURCE_SHA: retained,
      CMS_DEV_PRESERVE_PREVIEW_PAUSE: "true" };
    delete env.CMS_DEV_PREVIEW_R2_CREDENTIAL;
    delete env.CMS_DEV_ACCESS_CLIENT_ID;
    delete env.CMS_DEV_ACCESS_CLIENT_SECRET;
    const inputs = parseDevPreviewReleaseInputs(env, retained, "retained-release");
    expect(inputs.rendererSha).toBe(retained);
    expect(inputs.rawStorage).toBeUndefined();
    expect(inputs.publicationAccess).toBeUndefined();
    expect(() => parseDevPreviewReleaseInputs(env, retained)).toThrow();
    expect(() => parseDevPreviewReleaseInputs({ ...env, CMS_DEV_PUBLISH_ENABLED: "true" }, retained, "retained-release")).toThrow();
    expect(() => parseDevPreviewReleaseInputs({ ...env, FIREBASE_PROJECT_ID: "njpbs-site" }, retained, "retained-release")).toThrow();
  });
  it.each([
    { CMS_DEPLOYMENT_ENVIRONMENT: "production" }, { FIREBASE_PROJECT_ID: "njpbs-site" },
    { CLOUDFLARE_ACCOUNT_ID: "different-account" }, { FIRESTORE_EMULATOR_HOST: "localhost:8080" },
    { FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099" }, { GITHUB_SHA: "b".repeat(40) },
    { GITHUB_REF: "refs/heads/feature" }, { GITHUB_ACTOR: "unapproved" }, { GITHUB_TRIGGERING_ACTOR: "unapproved" },
    { GITHUB_WORKFLOW_REF: "CenterCoopMedia/njpbs/.github/workflows/cms-staging-deploy.yml@refs/heads/main" },
    { RUNNER_ENVIRONMENT: "self-hosted" }, { CMS_DEV_ACCESS_CLIENT_SECRET: "" },
    { CMS_DEV_PUBLISH_ENABLED: "true" },
    { CMS_DEV_RELEASE_PREVIEW_RENDERER: "false" },
    { CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: undefined }, { CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: "[]" },
    { CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: "bad-json" }, { CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: '[42]' },
  ])("refuses mismatched/unsafe input %j", replacement => {
    expect(() => parseDevPreviewReleaseInputs({ ...environment(), ...replacement }, sha)).toThrow();
  });
  it.each(["seed-writer@njpbs-site-dev.iam.gserviceaccount.com", "cms-dev-preview-renderer@njpbs-site.iam.gserviceaccount.com"])("refuses another service identity %s", email => {
    const env = environment();
    const account = JSON.parse(env.CMS_DEV_PREVIEW_FIREBASE_ACCOUNT);
    env.CMS_DEV_PREVIEW_FIREBASE_ACCOUNT = JSON.stringify({ ...account, client_email: email });
    expect(() => parseDevPreviewReleaseInputs(env, sha)).toThrow();
  });
});

it("releases the selected application pin after the trusted workflow has advanced", () => {
  const env = { ...environment(), GITHUB_SHA: "b".repeat(40), GITHUB_WORKFLOW_SHA: "b".repeat(40) };
  expect(parseDevPreviewReleaseInputs(env, sha).rendererSha).toBe(sha);
  expect(() => parseDevPreviewReleaseInputs(env, env.GITHUB_SHA)).toThrow();
});

describe("routine deployment retains a verified live renderer pin", () => {
  const pinned = "c".repeat(40);
  it("accepts another pinned SHA with publishing active and without release-only credentials", () => {
    const env = { ...environment(), CMS_DEV_RELEASE_PREVIEW_RENDERER: "false", CMS_DEV_PUBLISH_ENABLED: "true" };
    delete env.CMS_DEV_PREVIEW_R2_CREDENTIAL;
    delete env.CMS_DEV_ACCESS_CLIENT_ID;
    delete env.CMS_DEV_ACCESS_CLIENT_SECRET;
    expect(parseDevPreviewReleaseInputs(env, pinned, "verify-pinned").rendererSha).toBe(pinned);
  });
  it.each(["", "invalid", "g".repeat(40)])("refuses a missing or invalid renderer pin %s", value => {
    expect(() => parseDevPreviewReleaseInputs({ ...environment(), CMS_DEV_RELEASE_PREVIEW_RENDERER: "false" }, value, "verify-pinned")).toThrow();
  });
  it("requires ready runtime and exact stored/live provider agreement", async () => {
    const provider = await collectDevRendererIdentity("fixture-token", sha, network(responses()), options);
    const control = { schemaVersion: 1, phase: "ready", rendererSha: sha, serializerId: "cloudflare-preview" };
    const release = { schemaVersion: 1, environment: "development", projectId: "njpbs-site-dev", state: "complete",
      sourceSha: sha, releaseStartedAt, provider, verifiedAt: "2026-10-11T17:00:00.000Z" };
    expect(() => assertPinnedDevRendererReceipt(control, release, provider, sha)).not.toThrow();
    expect(() => assertPinnedDevRendererReceipt({ ...control, phase: "paused" }, release, provider, sha)).toThrow();
    expect(() => assertPinnedDevRendererReceipt(control, release, { ...provider, workerVersionId: appId }, sha)).toThrow();
    expect(() => assertPinnedDevRendererReceipt(control, { ...release, sourceSha: pinned }, provider, sha)).toThrow();
    expect(() => assertPinnedDevRendererReceipt(control, { ...release, projectId: "njpbs-site" }, provider, sha)).toThrow();
    expect(() => assertPinnedDevRendererReceipt({ ...control, rendererSha: pinned }, release, provider, sha)).toThrow();
  });
});

function responses() {
  return {
    "containers/applications": [{ name: worker, id: appId, version: 1, created_at: "2026-10-11T16:01:00.000Z", configuration: { image: "registry.cloudflare.com/fixture/dev-image", image_digest: "sha256:" + "b".repeat(64) } }],
    [`containers/applications/${appId}/rollouts`]: [] as any[],
    [`workers/scripts/${worker}/deployments`]: { deployments: [{ id: deploymentId, versions: [{ version_id: versionId, percentage: 100 }] }] },
    [`workers/scripts/${worker}/versions/${versionId}`]: { id: versionId, metadata: { source: "wrangler" },
      annotations: { "workers/tag": sha }, resources: { bindings: Object.entries({
      PREVIEW_RENDERER_SHA: sha, PREVIEW_RENDERER_ENABLED: "true", PREVIEW_SERIALIZER_ID: "cloudflare-preview",
      CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev",
    }).map(([name, text]) => ({ name, type: "plain_text", text })) } },
    [`workers/scripts/${worker}/schedules`]: { schedules: [{ cron: "* * * * *" }] },
  };
}
function network(data: ReturnType<typeof responses>) {
  return async (url: string, init: RequestInit) => {
    expect(init.redirect).toBe("error");
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://api.cloudflare.com");
    const suffix = parsed.pathname.split("/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/")[1];
    expect(Object.hasOwn(data, suffix)).toBe(true);
    return Response.json({ success: true, result: data[suffix as keyof typeof data] });
  };
}

describe("exact dev Worker/container identity receipt", () => {
  it("returns only safe identities for the single matched active version", async () => {
    const result = await collectDevRendererIdentity("fixture-token", sha, network(responses()), options);
    expect(result).toMatchObject({ worker, workerDeploymentId: deploymentId, workerVersionId: versionId,
      applicationId: appId, rendererSha: sha, serializerId: "cloudflare-preview" });
    expect(result.imageFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(result).sort()).toEqual(["applicationId", "imageFingerprint", "rendererSha", "serializerId", "worker", "workerDeploymentId", "workerVersionId"].sort());
  });
  it.each(["wrong-source", "wrong-project", "disabled", "split-traffic", "no-image", "no-cron", "duplicate-app"])("rejects provider drift %s", async kind => {
    const data = responses();
    const version = data[`workers/scripts/${worker}/versions/${versionId}`];
    if (kind === "wrong-source") version.annotations["workers/tag"] = "b".repeat(40);
    if (kind === "wrong-project") version.resources.bindings.find(binding => binding.name === "FIREBASE_PROJECT_ID")!.text = "njpbs-site";
    if (kind === "disabled") version.resources.bindings.find(binding => binding.name === "PREVIEW_RENDERER_ENABLED")!.text = "false";
    if (kind === "split-traffic") data[`workers/scripts/${worker}/deployments`].deployments[0].versions[0].percentage = 50;
    if (kind === "no-image") data["containers/applications"][0].configuration = { image: "", image_digest: "" };
    if (kind === "no-cron") data[`workers/scripts/${worker}/schedules`].schedules = [];
    if (kind === "duplicate-app") data["containers/applications"].push(data["containers/applications"][0]);
    await expect(collectDevRendererIdentity("fixture-token", sha, network(data), options)).rejects.toThrow();
  });
});


describe("dev image rollout convergence", () => {
  // Synthetic completed rollout: instances use the target version while the
  // application record still reports the previous version.
  const completed = {
    id: "44444444-4444-4444-4444-444444444444", created_at: "2026-10-11T16:01:00.000Z", status: "completed",
    current_version: 2, target_version: 3,
    current_configuration: { image: "registry.cloudflare.com/preview@sha256:1111111111111111111111111111111111111111111111111111111111111111" },
    target_configuration: { image: "registry.cloudflare.com/preview@sha256:2222222222222222222222222222222222222222222222222222222222222222" },
    steps: [{ id: 1, status: "completed", step_size: { percentage: 100 } }],
    progress: { total_steps: 1, current_step: 1, updated_instances: 1, total_instances: 1,
      version_distribution: { target_version_instances: 1, current_version_instances: 0, target_version_percentage: 100 } },
  };
  function rolloutResponses() {
    const data = responses();
    Object.assign(data["containers/applications"][0], { version: 2, active_rollout_id: completed.id,
      configuration: { image: completed.current_configuration.image, image_digest: "sha256:previous" }, digest: "sha256:previous" });
    data[`containers/applications/${appId}/rollouts`] = [structuredClone(completed)];
    return data;
  }
  it("has the same target fingerprint on both application sides after convergence", async () => {
    const data = rolloutResponses();
    const current = await collectDevRendererIdentity("fixture-token", sha, network(data), options);
    Object.assign(data["containers/applications"][0], { version: 3, active_rollout_id: null,
      configuration: { image: completed.target_configuration.image, image_digest: "sha256:target" } });
    const target = await collectDevRendererIdentity("fixture-token", sha, network(data), options);
    expect(target).toEqual(current);
    // Independent target image oracle from the synthetic provider rollout.
    const { createHash } = await import("node:crypto");
    expect(current.imageFingerprint).toBe(createHash("sha256").update(JSON.stringify({
      image: "registry.cloudflare.com/preview@sha256:2222222222222222222222222222222222222222222222222222222222222222", digest: null,
    })).digest("hex"));
  });
  it.each(["partial", "reverted", "replaced", "old-release"])("refuses %s rollout", async drift => {
    const data = rolloutResponses();
    const rollout = data[`containers/applications/${appId}/rollouts`][0];
    if (drift === "partial") rollout.progress.version_distribution.target_version_percentage = 50;
    if (drift === "reverted" || drift === "replaced") rollout.status = drift;
    if (drift === "old-release") rollout.created_at = "2026-10-10T16:00:00.000Z";
    await expect(collectDevRendererIdentity("fixture-token", sha, network(data), options)).rejects.toThrow();
  });
  it("waits with a bounded clock before recording the completed target", async () => {
    const data = rolloutResponses();
    const request = network(data);
    let clock = 0;
    let reads = 0;
    const result = await collectDevRendererIdentity("fixture-token", sha, async (url, init) => {
      if (url.endsWith("/rollouts") && ++reads === 1) {
        return Response.json({ success: true, result: [{ ...completed, status: "progressing" }] });
      }
      return request(url, init);
    }, { ...options, rolloutDeadlineMs: 6000, now: () => clock, sleep: async ms => { clock += ms; } });
    expect(result.applicationId).toBe(appId);
    expect(reads).toBe(2);
    expect(clock).toBe(5000);
  });
  it.each([undefined, "invalid", "2999-01-01T00:00:00.000Z"])("refuses invalid release start %s", async value => {
    await expect(collectDevRendererIdentity("fixture-token", sha, network(responses()), { ...options, releaseStartedAt: value })).rejects.toThrow();
  });
  it("retains the first durable start across unchanged-image retries", () => {
    const receipt = { schemaVersion: 1, environment: "development", projectId: "njpbs-site-dev",
      state: "releasing", sourceSha: sha, releaseStartedAt };
    const retryAt = "2026-10-11T17:00:00.000Z";
    expect(devRendererReleaseStart(receipt, sha, retryAt)).toBe(releaseStartedAt);
    expect(devRendererReleaseStart({ ...receipt, state: "complete" }, sha, retryAt)).toBe(releaseStartedAt);
    expect(devRendererReleaseStart(receipt, "b".repeat(40), retryAt)).toBe(retryAt);
    expect(() => devRendererReleaseStart({ ...receipt, releaseStartedAt: "invalid" }, sha, retryAt)).toThrow();
  });
});
