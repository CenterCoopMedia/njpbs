import { repositoryFixture } from "../helpers/repository-identity.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { runInNewContext } from "node:vm";
import dispatch from "../../functions/lib/cms-publish-dispatch.js";
import candidate from "../../functions/lib/public-worker-candidate.js";
import dev from "../../scripts/lib/dev-publication.cjs";
import targetContract from "../../functions/lib/publication-target.js";
import { createPublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory.ts";
import { preparePublicWorkerArtifact } from "../../site/src/lib/public-worker-artifact.ts";

const versionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const processBoundary = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal(), execFileSync: processBoundary }));

const queueId = "A1b2C3d4E5f6G7h8I9j0";
const devActor = "njpbs-dev-publisher[bot]";
const payload = { queueId, triggeredBy: "editor" };
const devEnvironment = { CMS_DEPLOYMENT_ENVIRONMENT: "development", GCLOUD_PROJECT: "njpbs-site-dev", CMS_PUBLISH_TRANSPORT: "github" };
const request = { eventName: "repository_dispatch", action: "cms_dev_publish", ref: "refs/heads/main", sender: devActor, actor: devActor,
  payload: { ...payload, environment: "development", projectId: "njpbs-site-dev", transport: "github" } };

describe("development dispatch boundary", () => {
  it("selects the dev event only for the complete dev tuple", () => {
    expect(dispatch.buildDispatchPayload(payload, devEnvironment)).toEqual({ event_type: "cms_dev_publish", client_payload: request.payload });
    for (const change of [{ GCLOUD_PROJECT: "njpbs-site" }, { CMS_PUBLISH_TRANSPORT: "serializer" }, { GCLOUD_PROJECT: "" }]) {
      expect(() => dispatch.buildDispatchPayload(payload, { ...devEnvironment, ...change })).toThrow();
    }
    expect(() => dispatch.buildDispatchPayload(payload, { GCLOUD_PROJECT: "njpbs-site-dev" })).toThrow();
  });
  it("preserves the existing production payload", () => {
    expect(dispatch.buildDispatchPayload(payload, { GCLOUD_PROJECT: "njpbs-site" })).toEqual({ event_type: "cms_publish", client_payload: payload });
  });
  it("production rejects a dev event, sender or project even when the other fields look valid", () => {
    const production = { ...request, action: "cms_publish", sender: "fixture-user", actor: "fixture-user", payload };
    expect(() => dispatch.assertPublishDispatch(production, "production", devActor)).not.toThrow();
    for (const change of [{ action: "cms_dev_publish" }, { sender: devActor }, { actor: devActor },
      { payload: request.payload }, { ref: "refs/heads/feature" }]) {
      expect(() => dispatch.assertPublishDispatch({ ...production, ...change }, "production", devActor)).toThrow();
    }
  });
  it("refuses dev dispatches before checkout and again at the full guard", () => {
    const workflow = parse(readFileSync(".github/workflows/cms-publish.yml", "utf8"));
    const job = workflow.jobs.authorize;
    const guard = job.steps.findIndex(step => step.run?.includes("assertPublishDispatch"));
    expect(guard).toBe(1);
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.steps[0].uses).toMatch(/^actions\/checkout@/);
    expect(job.steps[0].with).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false,
      "sparse-checkout": "functions/lib/cms-publish-dispatch.js", "sparse-checkout-cone-mode": false });
    const script = job.steps[guard].run;
    const env = { ...repositoryFixture, PATH: process.env.PATH, EVENT_NAME: "repository_dispatch", EVENT_ACTION: "cms_publish",
      CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: JSON.stringify(["fixture-user"]), EVENT_ACTOR: "fixture-user",
      EVENT_REF: "refs/heads/main", TRIGGERING_ACTOR: "fixture-user", EVENT_SENDER: "fixture-user", QUEUE_ID: queueId,
      EVENT_PROJECT: "", EVENT_ENVIRONMENT: "", DEV_DISPATCH_ACTOR: devActor, GITHUB_OUTPUT: "/dev/null" };
    const admitted = values => runInNewContext(job.if, {
      contains: (list, value) => list.includes(value), fromJSON: JSON.parse,
      startsWith: (value, prefix) => String(value).startsWith(prefix), toJSON: JSON.stringify,
      vars: { CANONICAL_GITHUB_REPOSITORY: values.CANONICAL_GITHUB_REPOSITORY,
        CANONICAL_GITHUB_REPOSITORY_ID: values.CANONICAL_GITHUB_REPOSITORY_ID, CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: values.CMS_PUBLISH_GITHUB_TRUSTED_ACTORS,
        CMS_DEV_DISPATCH_ACTOR: values.DEV_DISPATCH_ACTOR },
      github: { repository: repositoryFixture.CANONICAL_GITHUB_REPOSITORY, repository_id: repositoryFixture.CANONICAL_GITHUB_REPOSITORY_ID, ref: values.EVENT_REF, event_name: values.EVENT_NAME,
        actor: values.EVENT_ACTOR, triggering_actor: values.TRIGGERING_ACTOR,
        event: { action: values.EVENT_ACTION, sender: { login: values.EVENT_SENDER },
          client_payload: { queueId: values.QUEUE_ID, projectId: values.EVENT_PROJECT, environment: values.EVENT_ENVIRONMENT } } },
    });
    expect(admitted(env)).toBe(true);
    expect(spawnSync("bash", ["-c", script], { env }).status).toBe(0);
    for (const change of [{ EVENT_ACTION: "cms_dev_publish" }, { EVENT_SENDER: devActor },
      { TRIGGERING_ACTOR: devActor }, { EVENT_PROJECT: "njpbs-site-dev" }, { EVENT_ENVIRONMENT: "development" },
      { EVENT_ACTOR: "other", EVENT_SENDER: "other" }, { QUEUE_ID: "" },
      { QUEUE_ID: 123 }, { QUEUE_ID: null },
      { CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: "[]" }]) {
      const refused = { ...env, ...change };
      expect(admitted(refused), JSON.stringify(change)).toBe(false);
      expect(spawnSync("bash", ["-c", script], { env: refused }).status).not.toBe(0);
    }
  });

  it("dev requires its own identity, main, project and transport", () => {
    expect(() => dispatch.assertPublishDispatch(request, "development", devActor)).not.toThrow();
    for (const change of [{ sender: "fixture-user" }, { actor: "fixture-user" }, { action: "cms_publish" },
      { payload: { ...request.payload, projectId: "njpbs-site" } }, { payload: { ...request.payload, transport: "serializer" } },
      { payload: { ...request.payload, queueId: "../invalid" } }]) {
      expect(() => dispatch.assertPublishDispatch({ ...request, ...change }, "development", devActor)).toThrow();
    }
    expect(() => dispatch.assertPublishDispatch(request, "development", "fixture-user")).toThrow();
  });
});

describe("development publication target and receipts", () => {
  it("isolates development cache tags and refuses mixed targets or malformed slugs", () => {
    const target = targetContract.publicationTarget("development");
    for (const slug of ["pilot-story", "background"]) {
      expect(targetContract.publicationPostCacheTag(target, slug)).toBe(`njpbs-dev-post-${slug}`);
      expect(targetContract.publicationPostCacheTag(targetContract.publicationTarget("production"), slug)).toBe(`njpbs-post-${slug}`);
    }
    expect(() => targetContract.publicationPostCacheTag({ ...target, origin: "https://njpbs.org" }, "background")).toThrow();
    for (const slug of ["", "/posts/pilot/", "bad,tag", "bad--tag", "x".repeat(1001)]) {
      expect(() => targetContract.publicationPostCacheTag(target, slug)).toThrow();
    }
  });
  it("refuses production and mixed targets before a write", () => {
    expect(dev.assertDevTarget({ ...dev.TARGET })).toEqual(dev.TARGET);
    for (const change of [{ projectId: "njpbs-site" }, { workerName: "njpbs-admin" }, { workerName: "njpbs-production" },
      { branch: "production" }, { origin: "https://njpbs.org" }, { previewBucket: "njpbs-cms-previews" }]) {
      expect(() => dev.assertDevTarget({ ...dev.TARGET, ...change })).toThrow();
    }
    expect(() => dev.assertDevDatabase({ projectId: "njpbs-site" })).toThrow();
    expect(() => dev.assertDevQueue({ transport: "serializer", changes: [] })).toThrow();
  });
  it("requires an exact dev worker, source and family capability in generic candidate evidence", () => {
    const sha = "a".repeat(40);
    const target = targetContract.publicationTarget("development");
    const receipt = { schemaVersion: 1, buildBatchId: "cms-" + queueId, generation: 1, commitSha: sha,
      workerName: "template-dev-public", workerVersionId: versionId, versionCreatedOn: "2026-10-10T00:00:00.000Z",
      artifactDigest: "b".repeat(64), artifactReceiptDigest: "c".repeat(64), publicationReceiptDigest: "d".repeat(64),
      mediaManifestDigest: "e".repeat(64), artifactFileCount: 3, artifactBytes: 300, wranglerVersion: "4.134.0",
      runtime: { owner: "cloudflare", release: sha },
      noBuildPost: { schemaVersion: 2, rendererSha: sha, families: ["posts"], enabled: true, authoritative: true } };
    receipt.workerVersionTag = candidate.publicWorkerCandidateTag(receipt);
    expect(candidate.projectPublicWorkerCandidateInput(receipt, { target })).toMatchObject(receipt);
    for (const change of [{ workerName: "njpbs-production" }, { workerVersionTag: "foreign" },
      { artifactReceiptDigest: "invalid" }, { mediaManifestDigest: "invalid" },
      { runtime: { owner: "cloudflare", release: "f".repeat(40) } },
      { noBuildPost: { ...receipt.noBuildPost, rendererSha: "f".repeat(40) } }]) {
      expect(() => candidate.projectPublicWorkerCandidateInput({ ...receipt, ...change }, { target })).toThrow();
    }
  });
  it("keeps CI credentials out of the offline job and excludes production secrets", () => {
    const source = readFileSync(".github/workflows/cms-dev-publish.yml", "utf8");
    const workflow = parse(source);
    expect(workflow.on.repository_dispatch.types).toEqual(["cms_dev_publish"]);
    for (const helper of [".github/scripts/dev-publication-source-checkout.mjs", ".github/scripts/dev-publication-input-artifact.mjs"]) {
      expect(workflow.on.push.paths).toContain(helper);
    }
    expect(workflow.concurrency).toEqual({ group: "cms-dev-publication", queue: "max", "cancel-in-progress": false });
    expect(workflow.jobs.build.environment).toBeUndefined();
    expect(JSON.stringify(workflow.jobs.build)).not.toMatch(/secrets\.|google-github-actions\/auth/);
    const sandbox = workflow.jobs.build.steps.find(step => step.name === "Require offline build sandbox");
    const setup = workflow.jobs.build.steps.find(step => step.name === "Prepare hosted offline build sandbox");
    const probe = workflow.jobs.build.steps.find(step => step.name === "Verify offline build sandbox");
    const build = workflow.jobs.build.steps.find(step => step.name === "Build from frozen input without network or credentials");
    const model = workflow.jobs.build.steps.find(step => step.name === "Prepare pinned search model for offline build");
    expect(model.run).toBe("node --import ./site/node_modules/tsx/dist/loader.mjs site/scripts/prepare-search-model.ts");
    expect(model.if).toBe(sandbox.if);
    expect(model["continue-on-error"]).toBeUndefined();
    expect(sandbox.run).toBe("command -v bwrap");
    expect(sandbox.if).toBe("steps.retained.outputs.exists != 'true'");
    expect(sandbox["continue-on-error"]).toBeUndefined();
    expect(setup.run).toContain('test "$RUNNER_ENVIRONMENT" = github-hosted');
    expect(setup.run).toContain("if ! command -v bwrap >/dev/null; then");
    expect(setup.run).toContain("sudo apt-get install -y --no-install-recommends bubblewrap");
    expect(setup.run).toContain("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0");
    expect(probe.run).toBe("bwrap --unshare-net --die-with-parent --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp -- /bin/true");
    for (const step of [setup, probe]) {
      expect(step.if).toBe(sandbox.if);
      expect(step["continue-on-error"]).toBeUndefined();
    }
    expect(build.if).toBe(sandbox.if);
    const steps = workflow.jobs.build.steps;
    expect(steps.indexOf(model)).toBeLessThan(steps.indexOf(probe));
    expect(steps.indexOf(setup)).toBeLessThan(steps.indexOf(sandbox));
    expect(steps.indexOf(sandbox)).toBeLessThan(steps.indexOf(probe));
    expect(steps.indexOf(probe)).toBeLessThan(steps.indexOf(build));
    expect(source).not.toMatch(/secrets\.(FIREBASE_SERVICE_ACCOUNT|CLOUDFLARE_API_TOKEN)\b/);
    const production = parse(readFileSync(".github/workflows/cms-publish.yml", "utf8"));
    expect(production.on.repository_dispatch.types).toEqual(["cms_publish"]);
  });
});

describe("development renderer, version and baseline boundaries", () => {
  let directory, restoreDevPostRenderer, verifyVersion, verifyDevReadback, verifyDevPostRoutes, freezeDevPostRoutes, publication;
  const identity = { queueId, buildBatchId: "cms-" + queueId, commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  const deploymentId = "11111111-2222-4333-8444-555555555555";
  // Synthetic development seal, including the serialized key order.
  const release = { schemaVersion: 1, rendererSha: identity.commitSha, liveBlogVersion: 1,
    electionResultsVersion: 2, environment: "development" };
  const active = { id: deploymentId, source: "api", strategy: "percentage",
    annotations: { "workers/triggered_by": "deployment" }, created_on: "2026-10-10T00:01:00.000Z",
    versions: [{ version_id: versionId, percentage: 100 }] };
  const version = () => ({
    id: versionId, metadata: { source: "wrangler", created_on: "2026-10-10T00:00:00.000Z" },
    annotations: { "workers/tag": candidate.publicWorkerCandidateTag(publication),
      "workers/message": candidate.publicWorkerCandidateMessage(publication), "workers/triggered_by": "version_upload" },
    resources: { script: {}, bindings: [{ name: "ASSETS", type: "assets" },
      { name: "CMS_API", type: "service", service: "template-dev-cms-api", entrypoint: "PublicContentEntrypoint", environment: "production" },
      { name: "NO_BUILD_POST_RENDERER_SHA", type: "plain_text", text: identity.commitSha }],
      script_runtime: { assets: { config: { run_worker_first: true, html_handling: "force-trailing-slash", not_found_handling: "404-page" } } } },
  });
  const recoveryRecords = () => console.warn.mock.calls.filter(([line]) => line.startsWith("{")).map(([line]) => JSON.parse(line));
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "dev-boundary-"));
    vi.stubEnv("CMS_DEV_ARTIFACT_DIRECTORY", directory);
    vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "fixture-token");
    vi.stubEnv("CMS_DEV_ACCESS_CLIENT_ID", "fixture-id");
    vi.stubEnv("CMS_DEV_ACCESS_CLIENT_SECRET", "fixture-secret");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(globalThis, "setTimeout").mockImplementation(callback => { queueMicrotask(callback); return 0; });
    mkdirSync(join(directory, "dist/posts/_no-build-assets/_astro"), { recursive: true });
    mkdirSync(join(directory, "renderer/server/chunks"), { recursive: true });
    mkdirSync(join(directory, "renderer/client/_astro"), { recursive: true });
    writeFileSync(join(directory, "renderer/renderer-release.json"), JSON.stringify(release));
    writeFileSync(join(directory, "dist/posts/_no-build-assets/renderer-release.json"), JSON.stringify(release));
    writeFileSync(join(directory, "renderer/server/entry.mjs"), "export { value } from './chunks/post.mjs';\n");
    writeFileSync(join(directory, "renderer/server/chunks/post.mjs"), "export const value = 'dev-renderer-fixture';\n");
    writeFileSync(join(directory, "renderer/client/_astro/post.js"), "export const source = 'client-fixture';\n");
    writeFileSync(join(directory, "dist/posts/_no-build-assets/_astro/post.js"), "export const source = 'client-fixture';\n");
    const cutoffAt = { seconds: 1_787_856_000, nanoseconds: 0, toMillis: () => 1_787_856_000_000 };
    const inventory = createPublicArtifactInventoryReceipt({ reservation: {
      schemaVersion: 1, ...identity, generation: 1, status: "reserved", reservedAgainstGeneration: 0,
      reservedAgainstDeploymentId: null, reservedAgainstCommitSha: null, cutoffAt, reservedAt: cutoffAt,
    }, pages: [], posts: [], programs: [], authors: [], settings: [] });
    publication = await preparePublicWorkerArtifact({ artifactReceipt: inventory, distDirectory: join(directory, "dist"),
      outputPath: join(directory, "publication.json") });
    writeFileSync(join(directory, "post-routes.json"), "[]");
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      const parsed = new URL(url);
      if (parsed.origin === "https://api.cloudflare.com") {
        if (parsed.pathname.endsWith("/deployments")) return Response.json({ success: true, result: active });
        if (parsed.pathname.endsWith("/versions/" + versionId)) return Response.json({ success: true, result: version() });
        throw new Error("Unexpected provider boundary");
      }
      expect(parsed.origin).toBe("https://dev-public.example.org");
      expect(options.redirect).toBe("manual");
      expect(options.cache).toBe("no-store");
      const headers = new Headers(options.headers);
      expect(headers.get("cf-access-client-id")).toBe("fixture-id");
      expect(headers.get("cf-access-client-secret")).toBe("fixture-secret");
      if (parsed.pathname === "/_publication.json") {
        expect(parsed.searchParams.get("candidate")).toBe(identity.buildBatchId);
        expect(parsed.searchParams.get("version")).toBe(versionId);
        return new Response(readFileSync(join(directory, "dist/_publication.json")), {
          headers: { "x-njpbs-publication-origin": "template-dev-public", "content-type": "application/json" },
        });
      }
      return new Response(readFileSync(join(directory, "dist", parsed.pathname, "index.html")));
    }));
    // The source uses provider deployment-list envelopes.
    const original = globalThis.fetch.getMockImplementation();
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      if (String(url).endsWith("/deployments")) return Response.json({ success: true, result: { deployments: [active] } });
      return original(url, options);
    }));
    vi.resetModules();
    ({ restoreDevPostRenderer, verifyVersion, verifyDevReadback, verifyDevPostRoutes, freezeDevPostRoutes } =
      await import("../../site/scripts/cms-dev-publication.mjs"));
  });
  afterEach(() => {
    vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([1, 2])("restores the exact sealed server/client graph with election version %s without a compiler", async electionResultsVersion => {
    const accepted = { ...release, electionResultsVersion };
    if (electionResultsVersion === 2) expect(createHash("sha256").update(JSON.stringify(accepted) + "\n").digest("hex"))
      .toBe("c40a06f6d29f6598b486833a6e0b7fc95eafaa9d5c6ac59068dbf5fcf5ab7a7c");
    for (const file of ["renderer/renderer-release.json", "dist/posts/_no-build-assets/renderer-release.json"]) {
      writeFileSync(join(directory, file), JSON.stringify(accepted) + "\n");
    }
    const site = join(directory, "restored-site");
    await restoreDevPostRenderer(identity.commitSha, directory, site);
    expect(readFileSync(join(site, ".public-post-renderer/server/entry.mjs"), "utf8")).toBe("export { value } from './chunks/post.mjs';\n");
    expect(readFileSync(join(site, ".public-post-renderer/server/chunks/post.mjs"), "utf8")).toBe("export const value = 'dev-renderer-fixture';\n");
    expect(readFileSync(join(site, ".public-post-renderer/client/_astro/post.js"), "utf8")).toBe("export const source = 'client-fixture';\n");
    expect(JSON.parse(readFileSync(join(site, ".public-post-renderer/renderer-release.json"), "utf8"))).toEqual(accepted);
    expect(processBoundary).not.toHaveBeenCalled();
  });
  it.each(["source seal", "client seal", "production seal", "missing entry"])("refuses a changed %s before replacing files", async problem => {
    const site = join(directory, "restored-site");
    mkdirSync(join(site, ".public-post-renderer"), { recursive: true });
    writeFileSync(join(site, ".public-post-renderer/existing.mjs"), "Existing renderer");
    if (problem === "missing entry") rmSync(join(directory, "renderer/server/entry.mjs"));
    else {
      const changed = problem === "production seal" ? { ...release, environment: "production" } : { ...release, rendererSha: "b".repeat(40) };
      writeFileSync(join(directory, problem === "client seal" ? "dist/posts/_no-build-assets/renderer-release.json" : "renderer/renderer-release.json"), JSON.stringify(changed));
    }
    await expect(restoreDevPostRenderer(identity.commitSha, directory, site)).rejects.toThrow();
    expect(readFileSync(join(site, ".public-post-renderer/existing.mjs"), "utf8")).toBe("Existing renderer");
    expect(processBoundary).not.toHaveBeenCalled();
  });

  it.each([
    ["production environment", { ...release, environment: "production" }],
    ["wrong source", { ...release, rendererSha: "b".repeat(40) }],
    ["unknown key", { ...release, unknownVersion: 1 }],
    ["wrong schema", { ...release, schemaVersion: 2 }],
    ...Object.keys(release).map(key => [`missing ${key}`, Object.fromEntries(Object.entries(release).filter(([name]) => name !== key))]),
    ...["liveBlogVersion", "electionResultsVersion"].flatMap(key =>
      [0, key === "electionResultsVersion" ? 3 : 2, "1", "2", null, true].map(value =>
        [`${key}=${JSON.stringify(value)}`, { ...release, [key]: value }])),
  ])("refuses matching server/client seals with %s before replacing files", async (_problem, changed) => {
    const site = join(directory, "restored-site");
    mkdirSync(join(site, ".public-post-renderer"), { recursive: true });
    writeFileSync(join(site, ".public-post-renderer/existing.mjs"), "Existing renderer");
    for (const file of ["renderer/renderer-release.json", "dist/posts/_no-build-assets/renderer-release.json"]) {
      writeFileSync(join(directory, file), JSON.stringify(changed));
    }
    await expect(restoreDevPostRenderer(identity.commitSha, directory, site)).rejects.toThrow("Retained dev renderer source differs");
    expect(readFileSync(join(site, ".public-post-renderer/existing.mjs"), "utf8")).toBe("Existing renderer");
    expect(processBoundary).not.toHaveBeenCalled();
  });

  it.each([
    ["observed receipt", {}, true], ["disabled worker-first", { raw_run_worker_first: false }, false],
    ["missing worker-first", { raw_run_worker_first: undefined }, false],
    ["non-boolean worker-first", { raw_run_worker_first: "true" }, false],
    ["explicit disabled setting", { run_worker_first: false }, false],
  ])("validates the provider assets receipt: %s", async (_name, change, accepted) => {
    const assets = JSON.parse(readFileSync("tests/fixtures/cloudflare/dev-worker-version-assets.json", "utf8"));
    const receipt = version();
    receipt.resources.script_runtime.assets = { ...assets, ...change };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, result: receipt })));
    if (accepted) {
      expect(await verifyVersion(versionId, publication)).toMatchObject({ workerVersionId: versionId,
        noBuildPost: { schemaVersion: 2, families: ["posts"], rendererSha: identity.commitSha, authoritative: true } });
    } else await expect(verifyVersion(versionId, publication)).rejects.toThrow();
  });
  it.each(["wrong version", "tag", "source", "created time", "production API", "entrypoint", "SHA", "extra secret", "duplicate binding"])(
    "refuses an incompatible provider version: %s", async problem => {
      const receipt = version();
      if (problem === "wrong version") receipt.id = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      if (problem === "tag") receipt.annotations["workers/tag"] = "foreign";
      if (problem === "source") receipt.metadata.source = "unknown";
      if (problem === "created time") receipt.metadata.created_on = "invalid";
      if (problem === "production API") receipt.resources.bindings[1].service = "njpbs-cms-api";
      if (problem === "entrypoint") receipt.resources.bindings[1].entrypoint = "StaffSiteEntrypoint";
      if (problem === "SHA") receipt.resources.bindings[2].text = "b".repeat(40);
      if (problem === "extra secret") receipt.resources.bindings.push({ type: "secret_text", name: "unexpected" });
      if (problem === "duplicate binding") receipt.resources.bindings.push(receipt.resources.bindings[1]);
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, result: receipt })));
      await expect(verifyVersion(versionId, publication)).rejects.toThrow();
      expect(processBoundary).not.toHaveBeenCalled();
    });

  it("proves exact artifact receipt bytes with the candidate probe, separately from ordinary catalog routes", async () => {
    await verifyDevReadback(versionId, deploymentId, publication);
    expect(globalThis.fetch.mock.calls.filter(([url]) => new URL(url).origin === "https://dev-public.example.org")).toHaveLength(1);
    expect(globalThis.fetch.mock.calls.every(([url]) => new URL(url).pathname !== "/_content-status.json")).toBe(true);
    expect(processBoundary).not.toHaveBeenCalled();
  });
  it("rejects a locally changed expected receipt before network", async () => {
    writeFileSync(join(directory, "dist/_publication.json"), '{"stale":true}');
    await expect(verifyDevReadback(versionId, deploymentId, publication)).rejects.toThrow("Development baseline receipt bytes changed");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each([
    [404, "missing"], [200, '{"stale":true}'], [200, "invalid JSON"], [503, "Gateway unavailable"],
    ...[520, 521, 522, 523, 524, 525, 526].map(status => [status, "Cloudflare gateway unavailable"]),
  ])("waits for exact baseline readback after HTTP %s", async (status, body) => {
    const original = globalThis.fetch.getMockImplementation();
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, options) => new URL(url).origin === "https://dev-public.example.org" && ++reads === 1
      ? new Response(body, { status, headers: { "x-njpbs-publication-origin": "template-dev-public", "content-type": "application/json" } }) : original(url, options)));
    await verifyDevReadback(versionId, deploymentId, publication);
    expect(reads).toBe(2);
    expect(globalThis.fetch.mock.calls.every(([, options]) => options.method !== "POST")).toBe(true);
  });
  it.each([302, 401, 403])("refuses Access HTTP %s immediately without logging response details", async status => {
    const original = globalThis.fetch.getMockImplementation();
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      if (new URL(url).origin === "https://dev-public.example.org") {
        reads++;
        return new Response("private-body", { status, headers: { location: "https://example.test/?token=private-header" } });
      }
      return original(url, options);
    }));
    await expect(verifyDevReadback(versionId, deploymentId, publication)).rejects.toThrow("response refused");
    expect(reads).toBe(1);
    expect(console.warn).not.toHaveBeenCalled();
  });
  it("bounds persistent stale baseline readback without provider writes", async () => {
    const original = globalThis.fetch.getMockImplementation();
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      if (new URL(url).origin === "https://dev-public.example.org") {
        reads++;
        return new Response("stale", { headers: { "x-njpbs-publication-origin": "template-dev-public", "content-type": "application/json" } });
      }
      return original(url, options);
    }));
    await expect(verifyDevReadback(versionId, deploymentId, publication)).rejects.toThrow("publication receipt differs");
    expect(reads).toBe(7);
    expect(setTimeout.mock.calls.reduce((sum, [, delay]) => sum + delay, 0)).toBe(60_000);
    expect(globalThis.fetch.mock.calls.every(([, options]) => options.method !== "POST")).toBe(true);
  });
  it("records a 3000 ms recovery refusal then verifies the same retained bytes", async () => {
    const original = globalThis.fetch.getMockImplementation();
    let reads = 0, elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      if (new URL(url).origin !== "https://dev-public.example.org") return original(url, options);
      reads++;
      elapsed += reads === 1 ? 3000 : 345;
      if (reads === 1) return new Response("Post unavailable", { status: 503, headers: {
        "server-timing": "staff-access;dur=500, staff-admission;dur=0, staff-origin;dur=3000, private;dur=999",
      } });
      return original(url, options);
    }));
    await verifyDevReadback(versionId, deploymentId, publication, { timedOutRecovery: true });
    const records = recoveryRecords();
    expect(records).toMatchObject([
      { attempt: 1, durationMs: 3000, status: 503, outcome: "refused", refusalClass: "public-worker-unavailable",
        responseBody: "Post unavailable", gatewayTimings: { "staff-access": 500, "staff-admission": 0, "staff-origin": 3000 },
        unavailableHops: ["gatewayEnvironment", "apiGetDecision", "function"] },
      { attempt: 2, durationMs: 345, status: 200, outcome: "verified" },
    ]);
    expect(Object.keys(records[0].gatewayTimings)).not.toContain("private");
    expect(setTimeout.mock.calls.map(([, delay]) => delay)).toEqual([1000]);
    expect(globalThis.fetch.mock.calls.every(([, options]) => !options.method || options.method === "GET")).toBe(true);
    expect(processBoundary).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
  });
  it("stops recovery after three 503 reads and two fixed backoffs", async () => {
    const original = globalThis.fetch.getMockImplementation();
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      if (new URL(url).origin !== "https://dev-public.example.org") return original(url, options);
      reads++;
      return new Response("Site configuration unavailable", { status: 503 });
    }));
    await expect(verifyDevReadback(versionId, deploymentId, publication, { timedOutRecovery: true }))
      .rejects.toMatchObject({ status: 503, refusalClass: "gateway-configuration-unavailable", responseBody: "Site configuration unavailable" });
    expect(reads).toBe(3);
    expect(setTimeout.mock.calls.map(([, delay]) => delay)).toEqual([1000, 1000]);
    expect(recoveryRecords()).toHaveLength(3);
    expect(globalThis.fetch.mock.calls.every(([, options]) => !options.method || options.method === "GET")).toBe(true);
    expect(processBoundary).not.toHaveBeenCalled();
  });
  it.each([401, 403, 502, 200])("does not retry another recovery refusal: HTTP %s", async status => {
    const original = globalThis.fetch.getMockImplementation();
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      if (new URL(url).origin !== "https://dev-public.example.org") return original(url, options);
      reads++;
      return new Response("private-body", { status, headers: {
        "x-njpbs-publication-origin": "template-dev-public", "content-type": "application/json",
      } });
    }));
    await expect(verifyDevReadback(versionId, deploymentId, publication, { timedOutRecovery: true })).rejects.toThrow();
    expect(reads).toBe(1);
    expect(setTimeout).not.toHaveBeenCalled();
    expect(JSON.stringify(console.warn.mock.calls)).not.toContain("private-body");
  });
  it.each(["private-body", "Post unavailable" + "private-body".repeat(100)])("omits an unknown 503 body from recovery errors and logs", async body => {
    const original = globalThis.fetch.getMockImplementation();
    vi.stubGlobal("fetch", vi.fn(async (url, options) => new URL(url).origin === "https://dev-public.example.org"
      ? new Response(body, { status: 503 }) : original(url, options)));
    const failure = await verifyDevReadback(versionId, deploymentId, publication, { timedOutRecovery: true }).catch(error => error);
    expect(failure).toMatchObject({ status: 503, refusalClass: "http-503", responseBody: null });
    expect(failure.message).not.toContain("private-body");
    expect(JSON.stringify(console.warn.mock.calls)).not.toContain("private-body");
  });
  it("stops recovery if the deployment changes before the next read", async () => {
    const original = globalThis.fetch.getMockImplementation();
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      if (new URL(url).origin === "https://dev-public.example.org") { reads++; return new Response("Post unavailable", { status: 503 }); }
      if (reads && String(url).endsWith("/deployments")) return Response.json({ success: true,
        result: { deployments: [{ ...active, id: "22222222-3333-4444-8555-666666666666" }] } });
      return original(url, options);
    }));
    await expect(verifyDevReadback(versionId, deploymentId, publication, { timedOutRecovery: true })).rejects.toThrow("changed during verification");
    expect(reads).toBe(1);
    expect(processBoundary).not.toHaveBeenCalled();
  });
  it("refuses another origin identity even when receipt bytes match", async () => {
    const original = globalThis.fetch.getMockImplementation();
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      const response = await original(url, options);
      if (new URL(url).origin === "https://dev-public.example.org") response.headers.set("x-njpbs-publication-origin", "njpbs-production");
      return response;
    }));
    await expect(verifyDevReadback(versionId, deploymentId, publication)).rejects.toThrow("baseline origin differs");
  });
  it("refuses another content type even when receipt bytes match", async () => {
    const original = globalThis.fetch.getMockImplementation();
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      const response = await original(url, options);
      if (new URL(url).origin === "https://dev-public.example.org") response.headers.set("content-type", "text/html");
      return response;
    }));
    await expect(verifyDevReadback(versionId, deploymentId, publication)).rejects.toThrow("baseline content type differs");
  });
  it("sanitizes transport failure before baseline retry", async () => {
    const original = globalThis.fetch.getMockImplementation();
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      if (new URL(url).origin === "https://dev-public.example.org" && ++reads === 1) throw new Error("private-network-detail");
      return original(url, options);
    }));
    await verifyDevReadback(versionId, deploymentId, publication);
    expect(JSON.stringify(console.warn.mock.calls)).not.toContain("private-network-detail");
  });
  it("stops baseline proof if the active deployment changes", async () => {
    const original = globalThis.fetch.getMockImplementation();
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      if (new URL(url).origin === "https://dev-public.example.org") { reads++; return new Response("old", { headers: { "x-njpbs-publication-origin": "template-dev-public" } }); }
      if (reads && String(url).endsWith("/deployments")) return Response.json({ success: true,
        result: { deployments: [{ ...active, id: "22222222-3333-4444-8555-666666666666" }] } });
      return original(url, options);
    }));
    await expect(verifyDevReadback(versionId, deploymentId, publication)).rejects.toThrow("changed during verification");
    expect(reads).toBe(1);
  });

  it.each([404, 410])("verifies frozen withdrawal routes after gateway HTTP %s", async status => {
    writeFileSync(join(directory, "post-routes.json"), JSON.stringify([
      { route: "/posts/removed-post/", removed: true }, { route: "/posts/former-post/", removed: true },
    ]));
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      expect(options.redirect).toBe("manual");
      return new Response(null, { status });
    }));
    await verifyDevPostRoutes();
    expect(globalThis.fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/posts/removed-post/", "/posts/former-post/"]);
  });
  it.each([200, 302, 403, 500])("refuses unconfirmed frozen withdrawal HTTP %s", async status => {
    writeFileSync(join(directory, "post-routes.json"), JSON.stringify([{ route: "/posts/removed-post/", removed: true }]));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("old or unavailable", { status })));
    await expect(verifyDevPostRoutes()).rejects.toThrow();
  });
  it.each([false, true])("compares unowned Post bytes with the retained artifact (stale: %s)", async stale => {
    mkdirSync(join(directory, "dist/posts/current-post"), { recursive: true });
    writeFileSync(join(directory, "dist/posts/current-post/index.html"), "<h1>Version 7</h1>");
    writeFileSync(join(directory, "post-routes.json"), JSON.stringify([{ route: "/posts/current-post/", removed: false }]));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stale ? "Old Post" : "<h1>Version 7</h1>")));
    if (stale) await expect(verifyDevPostRoutes()).rejects.toThrow("Post bytes differ");
    else await verifyDevPostRoutes();
  });
  it.each(["https://njpbs.org/posts/example/", "//njpbs.org/posts/example/", "/posts/example/?token=private"])(
    "refuses an unsafe retained route before sending Access credentials: %s", async route => {
      writeFileSync(join(directory, "post-routes.json"), JSON.stringify([{ route, removed: false }]));
      await expect(verifyDevPostRoutes()).rejects.toThrow("Development Post route is invalid");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

  it.each(["post", "sponsor", "newsletter"])("freezes exact %s withdrawal input at its artifact cutoff", async type => {
    const cutoffAt = { seconds: 100, nanoseconds: 0 };
    const queue = { transport: "github", environment: "development", projectId: "njpbs-site-dev",
      changes: [{ collection: "cmsPosts", id: "removed", sourceVersion: 7, operation: "withdraw" }] };
    const document = { publiclyVisible: false, published: { sourceVersion: 7,
      metadata: { type, slug: "removed-post", previousSlugs: ["former-post"] } } };
    const db = { collection: collection => ({ doc: () => ({ get: async () => ({ data: () => collection === "cmsPublishQueue" ? queue : document }) }) }),
      runTransaction: async (read, options) => { expect(options).toEqual({ readOnly: true, readTime: cutoffAt }); return read({ get: ref => ref.get() }); } };
    const result = await freezeDevPostRoutes(db, identity, { cutoffAt }, { families: [{ collection: "cmsPosts", artifacts: [] }] });
    expect(result).toEqual(type === "post" ? [{ route: "/posts/removed-post/", removed: true }, { route: "/posts/former-post/", removed: true }] : []);
    document.published.sourceVersion = 8;
    await expect(freezeDevPostRoutes(db, identity, { cutoffAt }, { families: [{ collection: "cmsPosts", artifacts: [] }] })).rejects.toThrow("withdrawal input differs");
  });
});

const devWorkflowContext = {
  vars: { CMS_DEV_PUBLISH_ENABLED: "true", CMS_DEV_DISPATCH_ACTOR: devActor, CMS_DEPLOY_OWNER: "fixture-user",
    CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: JSON.stringify(["fixture-user"]) },
  contains: (list, value) => list.includes(value), fromJSON: JSON.parse,
  github: { event_name: "repository_dispatch", ref: "refs/heads/main", actor: devActor,
    triggering_actor: devActor, run_attempt: 1,
    event: { action: "cms_dev_publish", sender: { login: devActor }, client_payload: request.payload } },
};

describe("development workflow failure cleanup", () => {
  const workflow = parse(readFileSync(".github/workflows/cms-dev-publish.yml", "utf8"));
  const finalize = workflow.jobs.finalize;
  const cleanup = finalize.steps.find(step => step.run?.endsWith("cms-dev-publication.mjs fail"));

  it.each(["success", "failure", "cancelled", "skipped"])("admits finalization only after a started prepare job: %s", result => {
    expect(runInNewContext(finalize.if, { ...devWorkflowContext, always: () => true, needs: { prepare: { result, outputs: { source_sha: "a".repeat(40) } } } })).toBe(result !== "skipped");
  });

  it.each(["failure", "cancelled", "skipped", "success"])("settles an unsuccessful upload step: %s", outcome => {
    const context = { always: () => true, steps: { auth: { outcome: "success" }, upload: { outcome } } };
    expect(runInNewContext(cleanup.if, context)).toBe(outcome !== "success");
    context.steps.auth.outcome = "failure";
    expect(runInNewContext(cleanup.if, context)).toBe(false);
  });
});


describe("development workflow rerun admission", () => {
  const workflow = parse(readFileSync(".github/workflows/cms-dev-publish.yml", "utf8"));
  const script = workflow.jobs.prepare.steps.find(step => step.name === "Validate exact dispatch and source").run;

  it.each([
    ["original bot dispatch", {}, true],
    ["administrator reruns bot dispatch", { triggering_actor: "fixture-user", run_attempt: 2 }, true],
    ["bot reruns its dispatch", { run_attempt: 2 }, true],
    ["untrusted rerunner", { triggering_actor: "collaborator", run_attempt: 2 }, false],
    ["administrator on first attempt", { triggering_actor: "fixture-user" }, false],
    ["changed original actor", { actor: "fixture-user", triggering_actor: "fixture-user", run_attempt: 2 }, false],
    ["changed original sender", { event: { action: "cms_dev_publish", sender: { login: "fixture-user" }, client_payload: request.payload } }, false],
    ["wrong ref", { ref: "refs/heads/feature", run_attempt: 2 }, false],
  ])("checks job and shell admission: %s", (_name, changes, admitted) => {
    const github = { event_name: "repository_dispatch", ref: "refs/heads/main", actor: devActor,
      triggering_actor: devActor, run_attempt: 1,
      event: { action: "cms_dev_publish", sender: { login: devActor }, client_payload: request.payload }, ...changes };
    const vars = { ...devWorkflowContext.vars };
    // A partial rerun can reuse prepare's earlier success, so each job must
    // independently refuse a different rerunner before using its permissions.
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(runInNewContext(job.if ?? "true", { ...devWorkflowContext, github, vars, always: () => true,
        needs: { prepare: { result: "success", outputs: { source_sha: "a".repeat(40) } } } })).toBe(name === "reconcile" ? false : admitted);
    }
    const directory = mkdtempSync(join(tmpdir(), "dev-dispatch-"));
    try {
      const eventPath = join(directory, "event.json");
      writeFileSync(eventPath, JSON.stringify(github.event));
      const result = spawnSync("bash", ["-e", "-c", script], { encoding: "utf8", env: {
        PATH: process.env.PATH, SOURCE_SHA: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
        GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: github.event_name, GITHUB_REF: github.ref,
        GITHUB_ACTOR: github.actor, GITHUB_TRIGGERING_ACTOR: github.triggering_actor,
        GITHUB_RUN_ATTEMPT: String(github.run_attempt), CMS_DEV_DISPATCH_ACTOR: devActor,
        CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: vars.CMS_PUBLISH_GITHUB_TRUSTED_ACTORS, CMS_DEPLOY_OWNER: vars.CMS_DEPLOY_OWNER,
      } });
      expect(result.status === 0, result.stderr).toBe(admitted);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("development artifact recovery across attempts", () => {
  const workflow = parse(readFileSync(".github/workflows/cms-dev-publish.yml", "utf8"));
  const retain = workflow.jobs.prepare.steps.find(step => step.name === "Retain exact input for retry");
  // Reruns must reuse the original artifact; they cannot replace it.
  it.each([
    [1, undefined, true], [2, "false", false], [2, "true", false], [2, undefined, false],
  ])("evaluates the retention predicate on attempt %i with retry output %s", (attempt, exists, expected) => {
    expect(runInNewContext(retain.if, { github: { run_attempt: attempt }, steps: { retry: { outputs: { exists } } } })).toBe(expected);
  });
  // download-artifact selects the run-scoped REST API only when github-token is
  // supplied. The default runtime-token lookup also scopes by job-run identity.
  // https://github.com/actions/download-artifact#download-artifacts-from-other-workflow-runs-or-repositories
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps.filter(step => step.uses?.startsWith("actions/download-artifact@"))) {
      it(`${jobName} restores ${step.with.name} from the original run through the API`, () => {
        expect(step.with["github-token"]).toBe("${{ github.token }}");
        expect(step.with["run-id"]).toBe(jobName === "reconcile" ? "${{ inputs.run_id }}" : "${{ github.run_id }}");
        expect(job.permissions.actions).toBe("read");
      });
    }
  }
});
