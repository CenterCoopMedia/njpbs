// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertDevelopmentPublicWorkerConfig,
  developmentPublicWorkerConfig,
} from "../scripts/development-public-worker-config";
import { publicWorkerWranglerConfig } from "../scripts/upload-public-worker-candidate";
import { requestPublicPublicationReceipt, runPublicWorkerActivationOperator } from "../scripts/activate-public-worker-candidate";
import { reconcilePublicWorkerDeployment } from "../scripts/reconcile-public-worker-deployment";
import { publicPostRendererRelease, publicWorkerCandidateRendererContract, publicWorkerCandidateRendererSeal }
  from "../scripts/public-post-renderer-release";

const { publicationTarget } = createRequire(import.meta.url)("../../functions/lib/publication-target.js");
const development = publicationTarget("development");
const production = publicationTarget("production");
const root = fileURLToPath(new URL("../..", import.meta.url));
// Any of these in a development value means the dev container could reach production.
const PRODUCTION = /njpbs-production|"njpbs-site"|"njpbs-cms-api"|"njpbs-cms-publication"|"njpbs-cms-previews"|"njpbs-public-artifacts"|https:\/\/njpbs\.org/;
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TAG = "d".repeat(32);
const TOKEN = "t".repeat(40);
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "33333333-3333-4333-8333-333333333333";
const at = { toMillis: () => Date.parse("2026-08-27T20:00:00.000Z") };
const publication = { schemaVersion: 1 as const, digestAlgorithm: "sha256" as const, buildBatchId: "build-one", generation: 10,
  commitSha: "a".repeat(40), artifactDigest: "b".repeat(64), artifactReceiptDigest: "c".repeat(64), mediaManifestDigest: "d".repeat(64) };
const receipt = `${JSON.stringify(publication, null, 2)}\n`;
const prepared = { ...publication, publicationReceiptDigest: createHash("sha256").update(receipt).digest("hex"),
  artifactFileCount: 100, artifactBytes: 1_000_000 };
const lease = { schemaVersion: 1 as const, buildBatchId: prepared.buildBatchId, generation: prepared.generation, commitSha: prepared.commitSha,
  leaseToken: "lease-one", leaseAcquiredAt: at, predecessorGeneration: 9,
  predecessorDeploymentId: "44444444-4444-4444-8444-444444444444", predecessorCommitSha: "f".repeat(40) };
const candidate = { schemaVersion: 1, buildBatchId: prepared.buildBatchId, generation: prepared.generation, commitSha: prepared.commitSha,
  workerName: development.workerName, workerVersionId: VERSION_ID, workerVersionTag: `cms-g10-${prepared.artifactDigest.slice(0, 16)}`,
  versionCreatedOn: "2026-08-27T20:00:00.000Z", artifactDigest: prepared.artifactDigest, artifactReceiptDigest: prepared.artifactReceiptDigest,
  publicationReceiptDigest: prepared.publicationReceiptDigest, mediaManifestDigest: prepared.mediaManifestDigest,
  artifactFileCount: prepared.artifactFileCount, artifactBytes: prepared.artifactBytes, wranglerVersion: "4.123.0", recordedAt: at };
const deployments = { success: true, result: { deployments: [{ id: DEPLOYMENT_ID, source: "api", strategy: "percentage",
  annotations: { "workers/triggered_by": "deployment" }, versions: [{ version_id: VERSION_ID, percentage: 100 }],
  created_on: "2026-08-27T20:01:00.000Z" }] } };
const workers = { success: true, result: [{ id: production.workerName, tag: "e".repeat(32) }, { id: development.workerName, tag: TAG }] };
const noTriggers = { success: true, result: [] };

afterEach(() => { vi.doUnmock("jsonc-parser"); vi.resetModules(); vi.unstubAllGlobals(); });

describe("development Worker configuration", () => {
  it("derives only development names from the production Worker program", async () => {
    const config = await developmentPublicWorkerConfig({ root, target: development, assetsDirectory: "/state/releases/one/dist" });
    expect(config).toMatchObject({ name: development.workerName, routes: [], workers_dev: false, preview_urls: false,
      main: path.join(root, "workers/src/public-no-build-entry.ts"),
      assets: { directory: "/state/releases/one/dist", binding: "ASSETS", run_worker_first: true },
      r2_buckets: [{ binding: "DURABLE_POST_WITHDRAWALS", bucket_name: development.publicationBucket }],
      services: [{ binding: "CMS_API", service: "template-dev-cms-api", entrypoint: "PublicContentEntrypoint" }],
      version_metadata: { binding: "CF_VERSION_METADATA" }, vars: { PUBLICATION_ENVIRONMENT: "development" } });
    expect(JSON.stringify(config)).not.toMatch(PRODUCTION);
  });

  it("selects the reviewed production config and a written development config", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dev-worker-config-"));
    try {
      const dist = path.join(directory, "dist");
      expect(await publicWorkerWranglerConfig({ directory, distDirectory: dist })).toBe(path.join(root, "workers/wrangler.jsonc"));
      expect(await publicWorkerWranglerConfig({ target: production, directory, distDirectory: dist })).toBe(path.join(root, "workers/wrangler.jsonc"));
      const file = await publicWorkerWranglerConfig({ target: development, directory, distDirectory: dist });
      expect(file).toBe(path.join(directory, "wrangler.development.json"));
      const written = await readFile(file, "utf8");
      expect(JSON.parse(written)).toMatchObject({ name: development.workerName, routes: [], assets: { directory: dist } });
      expect(written).not.toMatch(PRODUCTION);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([
    ["the production Worker name", { name: production.workerName }],
    ["a production route", { routes: [{ pattern: "https://njpbs.org/*", zone_name: "njpbs.org" }] }],
    ["workers.dev", { workers_dev: true }],
    ["the production bucket", { r2_buckets: [{ binding: "DURABLE_POST_WITHDRAWALS", bucket_name: production.publicationBucket }] }],
    ["the production API", { services: [{ binding: "CMS_API", service: "njpbs-cms-api", entrypoint: "PublicContentEntrypoint" }] }],
    ["a copied production origin", { vars: { PUBLIC_ORIGIN: "https://njpbs.org/" } }],
    ["the production project", { vars: { FIREBASE_PROJECT_ID: production.projectId } }],
  ])("refuses a development config that names %s", (_label, change) => {
    const safe = { name: development.workerName, routes: [], workers_dev: false, preview_urls: false, vars: {} };
    expect(assertDevelopmentPublicWorkerConfig(safe, development)).toBe(safe);
    expect(() => assertDevelopmentPublicWorkerConfig({ ...safe, ...change }, development)).toThrow("names production");
  });

  it("refuses to derive a development config for the production target", async () => {
    await expect(developmentPublicWorkerConfig({ root, target: production, assetsDirectory: "/dist" })).rejects.toThrow("names production");
    expect(() => assertDevelopmentPublicWorkerConfig({ name: production.workerName, routes: [], workers_dev: false, preview_urls: false },
      production)).toThrow("names production");
  });

  it("refuses a derived development upload that would name production before any read or Wrangler call", async () => {
    vi.doMock("jsonc-parser", () => ({ parse: () => ({
      name: production.workerName, main: "./src/public-no-build-entry.ts", vars: { PUBLIC_ORIGIN: "https://njpbs.org/" },
      routes: [{ pattern: "https://njpbs.org/*", zone_name: "njpbs.org" }] }) }));
    const { uploadPublicWorkerCandidate } = await import("../scripts/upload-public-worker-candidate");
    const directory = await mkdtemp(path.join(tmpdir(), "dev-worker-upload-"));
    const runCommand = vi.fn();
    const firestore = new Proxy({}, { get: () => { throw new Error("Firestore was read"); } });
    try {
      await expect(uploadPublicWorkerCandidate({ target: development, runCommand, firestore: firestore as never,
        artifactReceiptPath: path.join(directory, "artifact.json"), preparedArtifactPath: path.join(directory, "prepared.json"),
        distDirectory: path.join(directory, "dist") })).rejects.toThrow("names production");
      expect(runCommand).not.toHaveBeenCalled();
      await expect(readFile(path.join(directory, "wrangler.development.json"))).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

});

describe("development activation and reconciliation", () => {
  const ZONE = "c".repeat(32);
  const access = { clientId: "fixture-access-id", clientSecret: "fixture-access-secret" };
  const postCandidate = { ...candidate, noBuildPost: { schemaVersion: 2, families: ["posts"], rendererSha: candidate.commitSha,
    enabled: true, authoritative: true } };
  // No owners: Post readback validates its Access headers, then has nothing else to read.
  const firestore = { projectId: development.projectId, collection: () => ({ get: async () => ({ docs: [] }) }),
    doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) };
  const log: string[] = [];
  function cloudflare({ routes = () => [] as unknown[], domains = () => [] as unknown[] } = {}) {
    return vi.fn(async ({ url, method }: { url: string; method: string }) => {
      const pathname = url.slice("https://api.cloudflare.com/client/v4".length);
      log.push(`${method} ${pathname}`);
      if (pathname === `/accounts/${ACCOUNT}/workers/scripts`) return workers;
      if (pathname.endsWith("/triggers")) return noTriggers;
      if (pathname === `/zones?name=njpbs.org&account.id=${ACCOUNT}`) {
        return { success: true, result: [{ id: ZONE, name: "njpbs.org", account: { id: ACCOUNT } }] };
      }
      if (pathname === `/zones/${ZONE}/workers/routes`) return { success: true, result: routes() };
      if (pathname.endsWith("/subdomain")) return { success: true, result: { enabled: false, previews_enabled: false } };
      if (pathname === `/accounts/${ACCOUNT}/workers/domains?service=${development.workerName}`) return { success: true, result: domains() };
      if (pathname.endsWith("/deployments")) return method === "POST" ? { success: true, result: {} } : deployments;
      throw new Error(`Unexpected Cloudflare request ${pathname}`);
    });
  }
  const operatorInput = (requestJson: ReturnType<typeof cloudflare>, overrides: Record<string, unknown> = {}) => {
    const acquireLeaseFn = vi.fn<(input: object) => Promise<object>>(async () => {
      log.push("lease");
      return { outcome: "acquired", idempotent: false, lease, candidate: postCandidate };
    });
    const settleOutcomeFn = vi.fn<(input: object) => Promise<object>>(async () => ({ outcome: "reconciling", idempotent: false }));
    const requestPublication = vi.fn<(url: string, access?: object) => Promise<string>>(async () => receipt);
    return { acquireLeaseFn, settleOutcomeFn, requestPublication, input: { firestore: firestore as never, cloudflareApiToken: TOKEN,
      preparedArtifact: prepared, target: development, publicationAccess: access, requestJson, requestPublication,
      acquireLeaseFn: acquireLeaseFn as never, settleOutcomeFn: settleOutcomeFn as never, ...overrides } };
  };
  afterEach(() => { log.length = 0; });

  it("checks the private origin, activates only the development Worker and reads back through Access", async () => {
    const requestJson = cloudflare();
    const fixture = operatorInput(requestJson);
    await runPublicWorkerActivationOperator(fixture.input);
    const privateCheck = [`GET /zones?name=njpbs.org&account.id=${ACCOUNT}`, `GET /zones/${ZONE}/workers/routes`,
      `GET /accounts/${ACCOUNT}/workers/scripts/${development.workerName}/subdomain`,
      `GET /accounts/${ACCOUNT}/workers/domains?service=${development.workerName}`];
    expect(log).toEqual([`GET /accounts/${ACCOUNT}/workers/scripts`, `GET /accounts/${ACCOUNT}/builds/workers/${TAG}/triggers`, ...privateCheck, "lease",
      `GET /accounts/${ACCOUNT}/builds/workers/${TAG}/triggers`, `POST /accounts/${ACCOUNT}/workers/scripts/${development.workerName}/subdomain`, ...privateCheck, "lease",
      `POST /accounts/${ACCOUNT}/workers/scripts/${development.workerName}/deployments`,
      `GET /accounts/${ACCOUNT}/workers/scripts/${development.workerName}/deployments`, `GET /accounts/${ACCOUNT}/builds/workers/${TAG}/triggers`, ...privateCheck]);
    expect(fixture.requestPublication).toHaveBeenCalledWith(
      `${development.origin}/_publication.json?candidate=${prepared.buildBatchId}&version=${VERSION_ID}`, access);
    expect(fixture.acquireLeaseFn.mock.calls[0][0]).toMatchObject({ target: development });
    // "activate" requires the Post readback to accept the development Access headers.
    expect(fixture.settleOutcomeFn.mock.calls[0][0]).toMatchObject({ target: development,
      evidence: { action: "activate", deploymentId: DEPLOYMENT_ID, versionId: VERSION_ID } });
    expect(JSON.stringify([requestJson.mock.calls, fixture.requestPublication.mock.calls])).not.toMatch(PRODUCTION);
  });

  it.each([
    ["a zone route", { routes: () => [{ id: "route", pattern: "dev.njpbs.org/*", script: development.workerName }] }],
    ["a custom domain", { domains: () => [{ id: "domain", hostname: "dev.njpbs.org", service: development.workerName }] }],
  ])("refuses a development Worker with %s before the lease or any deployment", async (_label, binding) => {
    const fixture = operatorInput(cloudflare(binding));
    await expect(runPublicWorkerActivationOperator(fixture.input)).rejects.toThrow("must have no public route, custom domain");
    expect(fixture.acquireLeaseFn).not.toHaveBeenCalled();
    expect(log.some(entry => entry.startsWith("POST"))).toBe(false);
  });

  it("reconciles instead of deploying when a custom domain appears after the lease", async () => {
    let reads = 0;
    const fixture = operatorInput(cloudflare({ domains: () => ++reads > 1 ? [{ id: "domain", service: development.workerName }] : [] }));
    await runPublicWorkerActivationOperator(fixture.input);
    expect(log).not.toContain(`POST /accounts/${ACCOUNT}/workers/scripts/${development.workerName}/deployments`);
    expect(fixture.settleOutcomeFn.mock.calls[0][0]).toMatchObject({ evidence: { action: "reconcile" } });
  });

  it("requires development Access credentials and refuses them for production before any request", async () => {
    for (const overrides of [{ publicationAccess: undefined }, { publicationAccess: { clientId: " ", clientSecret: "x" } },
      { target: production }]) {
      const fixture = operatorInput(cloudflare(), overrides);
      await expect(runPublicWorkerActivationOperator(fixture.input)).rejects.toThrow(/Access credentials/);
      expect(log).toEqual([]);
    }
  });

  it("sends the Access credentials with a development receipt request", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(receipt, {
      headers: { "content-type": "application/json", "x-njpbs-publication-origin": development.workerName } }));
    vi.stubGlobal("fetch", fetchMock);
    await requestPublicPublicationReceipt(`${development.origin}/_publication.json`, access);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ Accept: "application/json", "Cache-Control": "no-cache",
      "CF-Access-Client-Id": access.clientId, "CF-Access-Client-Secret": access.clientSecret });
  });

  it("accepts a development receipt only from the development Worker", async () => {
    const served = (origin: string) => vi.fn(async () => new Response(receipt, {
      headers: { "content-type": "application/json", "x-njpbs-publication-origin": origin } }));
    vi.stubGlobal("fetch", served(development.workerName));
    await expect(requestPublicPublicationReceipt(`${development.origin}/_publication.json`)).resolves.toBe(receipt);
    vi.stubGlobal("fetch", served(production.workerName));
    await expect(requestPublicPublicationReceipt(`${development.origin}/_publication.json`)).rejects.toThrow("receipt response is invalid");
    await expect(requestPublicPublicationReceipt(`${production.origin}/_publication.json`)).resolves.toBe(receipt);
  });

  it("refuses the production Worker identity and any development build trigger", async () => {
    for (const responses of [
      [{ success: true, result: [{ id: production.workerName, tag: TAG }] }],
      [workers, { success: true, result: [{ trigger_uuid: "11111111-1111-4111-8111-111111111111", external_script_id: TAG }] }],
    ]) {
      const requestJson = vi.fn();
      for (const response of responses) requestJson.mockResolvedValueOnce(response);
      const fixture = operatorInput(requestJson as never);
      await expect(runPublicWorkerActivationOperator(fixture.input))
        .rejects.toThrow(/Worker identity is invalid|development Worker has a build trigger/);
      expect(fixture.acquireLeaseFn).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["a private Worker", {}, "activate"],
    ["a Worker with a zone route", { routes: () => [{ id: "route", script: development.workerName }] }, "reconcile"],
  ])("reconciles %s only through the development Worker and Access readback", async (_label, binding, action) => {
    const requestJson = cloudflare(binding);
    const requestPublication = vi.fn<(url: string, access?: object) => Promise<string>>(async () => receipt);
    const readState = vi.fn(async () => ({ lease, candidate: postCandidate }));
    const settleOutcome = vi.fn<(input: object) => Promise<object>>(async () => ({ outcome: "reconciling", idempotent: false }));
    await reconcilePublicWorkerDeployment({ firestore: firestore as never, cloudflareApiToken: TOKEN, target: development,
      publicationAccess: access, readState: readState as never, requestJson, requestPublication, settleOutcome: settleOutcome as never });
    expect(readState).toHaveBeenCalledWith(firestore, undefined, development);
    expect(log.filter(entry => entry.includes("/deployments"))).toEqual(action === "activate"
      ? [`GET /accounts/${ACCOUNT}/workers/scripts/${development.workerName}/deployments`] : []);
    if (action === "activate") expect(requestPublication).toHaveBeenCalledWith(
      `${development.origin}/_publication.json?candidate=${prepared.buildBatchId}&version=${VERSION_ID}`, access);
    expect(settleOutcome.mock.calls[0][0]).toMatchObject({ target: development, evidence: { action } });
    expect(JSON.stringify([requestJson.mock.calls, requestPublication.mock.calls])).not.toMatch(PRODUCTION);
  });
});

describe("renderer seal", () => {
  const sha = "a".repeat(40);
  it("accepts a development seal only for development and keeps production exact", () => {
    const seal = publicPostRendererRelease(sha, "production", {});
    const devSeal = publicPostRendererRelease(sha, "development", {});
    expect(devSeal).toMatchObject({ environment: "development" });
    expect(publicWorkerCandidateRendererContract(publicWorkerCandidateRendererSeal(devSeal, "development"), sha))
      .toEqual(publicWorkerCandidateRendererContract(seal, sha));
    expect(publicWorkerCandidateRendererSeal(seal)).toBe(seal);
    expect(() => publicWorkerCandidateRendererContract(publicWorkerCandidateRendererSeal(devSeal), sha)).toThrow("production artifact");
    expect(() => publicWorkerCandidateRendererSeal(seal, "development")).toThrow("development artifact");
    expect(() => publicWorkerCandidateRendererSeal({ ...seal, environment: "production" }, "development")).toThrow("development artifact");
  });
});
