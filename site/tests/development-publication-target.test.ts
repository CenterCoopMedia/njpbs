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
const api = (suffix: string) => `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${suffix}`;

afterEach(() => { vi.doUnmock("wrangler"); vi.resetModules(); vi.unstubAllGlobals(); });

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
    vi.doMock("wrangler", () => ({ experimental_readRawConfig: () => ({ rawConfig: {
      name: production.workerName, main: "./src/public-no-build-entry.ts", vars: { PUBLIC_ORIGIN: "https://njpbs.org/" },
      routes: [{ pattern: "https://njpbs.org/*", zone_name: "njpbs.org" }] } }) }));
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

  it("refuses a detached development upload before any Wrangler call", async () => {
    const { uploadPublicWorkerCandidate } = await import("../scripts/upload-public-worker-candidate");
    const runCommand = vi.fn();
    await expect(uploadPublicWorkerCandidate({ target: development, runCommand, firestore: {} as never, preparationId: "a".repeat(20),
      artifactReceiptPath: "/unused/artifact.json", preparedArtifactPath: "/unused/prepared.json" }))
      .rejects.toThrow("production-only");
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("development activation and reconciliation", () => {
  it("activates and probes only the development Worker", async () => {
    const requestJson = vi.fn()
      .mockResolvedValueOnce(workers).mockResolvedValueOnce(noTriggers).mockResolvedValueOnce(noTriggers)
      .mockResolvedValueOnce({ success: true, result: { enabled: false, previews_enabled: false } })
      .mockResolvedValueOnce({ success: true, result: {} }).mockResolvedValueOnce(deployments).mockResolvedValueOnce(noTriggers);
    const requestPublication = vi.fn(async () => receipt);
    const acquireLeaseFn = vi.fn<(input: object) => Promise<object>>(async () => ({ outcome: "acquired", idempotent: false, lease, candidate }));
    const settleOutcomeFn = vi.fn<(input: object) => Promise<object>>(async () => ({ outcome: "reconciling", idempotent: false }));
    const firestore = { projectId: development.projectId };
    await runPublicWorkerActivationOperator({ firestore: firestore as never, cloudflareApiToken: TOKEN, preparedArtifact: prepared,
      target: development, requestJson, requestPublication, acquireLeaseFn: acquireLeaseFn as never, settleOutcomeFn: settleOutcomeFn as never });
    expect(requestJson.mock.calls.map(([request]) => request.url)).toEqual([
      api("/workers/scripts"), api(`/builds/workers/${TAG}/triggers`), api(`/builds/workers/${TAG}/triggers`),
      api(`/workers/scripts/${development.workerName}/subdomain`), api(`/workers/scripts/${development.workerName}/deployments`),
      api(`/workers/scripts/${development.workerName}/deployments`), api(`/builds/workers/${TAG}/triggers`),
    ]);
    expect(requestPublication).toHaveBeenCalledWith(
      `${development.origin}/_publication.json?candidate=${prepared.buildBatchId}&version=${VERSION_ID}`);
    expect(acquireLeaseFn.mock.calls[0][0]).toMatchObject({ target: development });
    expect(settleOutcomeFn.mock.calls[0][0]).toMatchObject({ target: development,
      evidence: { action: "activate", deploymentId: DEPLOYMENT_ID, versionId: VERSION_ID } });
    expect(JSON.stringify([requestJson.mock.calls, requestPublication.mock.calls])).not.toMatch(PRODUCTION);
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
      const acquireLeaseFn = vi.fn();
      await expect(runPublicWorkerActivationOperator({ firestore: {} as never, cloudflareApiToken: TOKEN, preparedArtifact: prepared,
        target: development, requestJson, requestPublication: vi.fn(), acquireLeaseFn, settleOutcomeFn: vi.fn() }))
        .rejects.toThrow(/Worker identity is invalid|development Worker has a build trigger/);
      expect(acquireLeaseFn).not.toHaveBeenCalled();
    }
  });

  it("reconciles only the development Worker and development lease", async () => {
    const requestJson = vi.fn().mockResolvedValueOnce(workers).mockResolvedValueOnce(noTriggers)
      .mockResolvedValueOnce(deployments).mockResolvedValueOnce(noTriggers);
    const requestPublication = vi.fn(async () => receipt);
    const readState = vi.fn(async () => ({ lease, candidate }));
    const settleOutcome = vi.fn<(input: object) => Promise<object>>(async () => ({ outcome: "reconciling", idempotent: false }));
    const firestore = { projectId: development.projectId };
    await reconcilePublicWorkerDeployment({ firestore: firestore as never, cloudflareApiToken: TOKEN, target: development,
      readState: readState as never, requestJson, requestPublication, settleOutcome: settleOutcome as never });
    expect(readState).toHaveBeenCalledWith(firestore, undefined, development);
    expect(requestJson.mock.calls.map(([request]) => request.url)).toEqual([api("/workers/scripts"),
      api(`/builds/workers/${TAG}/triggers`), api(`/workers/scripts/${development.workerName}/deployments`),
      api(`/builds/workers/${TAG}/triggers`)]);
    expect(requestPublication).toHaveBeenCalledWith(
      `${development.origin}/_publication.json?candidate=${prepared.buildBatchId}&version=${VERSION_ID}`);
    expect(settleOutcome.mock.calls[0][0]).toMatchObject({ target: development, evidence: { action: "activate", versionId: VERSION_ID } });
    expect(JSON.stringify([requestJson.mock.calls, requestPublication.mock.calls])).not.toMatch(PRODUCTION);
  });
});
