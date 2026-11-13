import { repositoryFixture } from "../helpers/repository-identity.mjs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { nativeReaderHttp } from "../helpers/cms-reader-native-http";
import { retainedSourceFixture } from "../helpers/cms-reader-retained-sources";
import { DEV_TARGETS, assertDevConfigs } from "../../scripts/assert-dev-cms-targets.mjs";
import { deployDevReaders, readDevReaderDeploymentProviders } from "../../scripts/deploy-dev-reader-mounts.mjs";
import { createReaderInstallAdapter } from "../../scripts/lib/cms-reader-first-install-adapter.mjs";
import { proveCmsReaderBridge, installCmsReaderBridge, prepareInstalledCmsReaderConsumers, FIRST_INSTALL_STAGE } from "../../scripts/lib/cms-reader-bridge-install.mjs";
import { createInstalledConsumerProvider } from "../../site/scripts/public-release-installed-consumer-provider";
import { prepareInstalledPublicReleaseConsumers, assertInstalledPublicReleaseConsumersInTransaction } from "../../site/scripts/public-release-installed-consumer-owner";
import { commitLiveReaderReceipt, fingerprintInputs, fingerprintPaths, RECEIPT_INPUT_PATHS } from "../../scripts/lib/cms-component-receipt.mjs";
import { installedConsumerFixture } from "../helpers/public-release-installed-consumers";
import { dispatchCmsReaderMount } from "../../cms-api/src/cms-reader-mount";
const require = createRequire(import.meta.url);
const source = require("../../functions/lib/cms-reader-retained-replies.js");
const cms = require("../../functions/lib/cms-preview-pair.js");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const rendererSha = "a".repeat(40);
const env = { ...repositoryFixture, ...DEV_TARGETS, CMS_DEV_INSTALL_READER_BRIDGE: "true", CMS_DEV_PUBLISH_ENABLED: "false",
  CMS_PUBLISH_GITHUB_APP_ID: "1000001", CMS_PUBLISH_GITHUB_INSTALLATION_ID: "2000002",
  GITHUB_REPOSITORY: repositoryFixture.CANONICAL_GITHUB_REPOSITORY, GITHUB_REPOSITORY_ID: repositoryFixture.CANONICAL_GITHUB_REPOSITORY_ID,
  CMS_DEV_READER_OPERATION_ID: "reader-dev-deploy", CMS_DEV_READER_INSTALL_AUTHORIZATION: "INSTALL_DEV_READERS",
  CMS_DEV_RENDERER_SOURCE_SHA: rendererSha, DEPLOY_SHA: sha, GITHUB_SHA: sha, GITHUB_WORKFLOW_SHA: sha,
  RUNNER_ENVIRONMENT: "github-hosted", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
  GITHUB_REF: "refs/heads/main", GITHUB_ACTOR: "fixture-user", CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: JSON.stringify(["fixture-user"]), CMS_DEPLOY_OWNER: "fixture-user", GITHUB_TRIGGERING_ACTOR: "fixture-user",
  GITHUB_WORKFLOW_REF: "CenterCoopMedia/njpbs/.github/workflows/cms-dev-deploy.yml@refs/heads/main" };
let app: any, db: any, fixture: any, root: URL, directory: string, binding: any, apiVars: any, http: any;
let functions: any[], apiVersion: any, deployed: string[];
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Local emulator only");
  app = initializeApp({ projectId: "njpbs-site-dev" }, "dev-reader-deployment-emulator"); db = getFirestore(app);
});
afterAll(async () => { await db?.terminate(); if (app) await deleteApp(app); });
afterEach(async () => { await http?.close(); http = undefined; rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" });
  fixture = await retainedSourceFixture(db);
  // Remove fixture reader evidence. Only the real deployment owners recreate it.
  for (const component of ["functions", "cmsApi"]) {
    await db.doc(`cmsDeploymentCandidates/${fixture.candidates[component]}`).delete();
    await db.doc(`cmsDeploymentReceipts/${component}`).delete();
  }
  directory = mkdtempSync(join(tmpdir(), "dev-reader-deploy-")); root = pathToFileURL(`${directory}/`);
  // Immutable Git plumbing only: works for linked worktrees and full CI clones
  // without copying repository configuration, credentials or the Git index.
  const gitDirectory = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
  writeFileSync(new URL(".git", root), `gitdir: ${gitDirectory}\n`);
  for (const path of ["firebase.dev.json", "cms-api/wrangler.dev.jsonc", "preview-renderer/wrangler.dev.jsonc",
    "workers/wrangler.staff-preview.dev.jsonc", "workers/wrangler.preview.dev.jsonc", "functions/.env.njpbs-site-dev"]) {
    mkdirSync(join(directory, path, ".."), { recursive: true });
    const fixtureSource = path === "functions/.env.njpbs-site-dev" ? "functions/.env.example" : path;
    cpSync(new URL(`../../${fixtureSource}`, import.meta.url), join(directory, path));
  }
  const path = new URL("functions/.env.njpbs-site-dev", root);
  const vars = Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/)
    .filter(line => line && !line.startsWith("#"))
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  Object.assign(vars, { CMS_PUBLISH_GITHUB_REPOSITORY: repositoryFixture.CANONICAL_GITHUB_REPOSITORY,
    CMS_PUBLISH_GITHUB_APP_ID: env.CMS_PUBLISH_GITHUB_APP_ID, CMS_PUBLISH_GITHUB_INSTALLATION_ID: env.CMS_PUBLISH_GITHUB_INSTALLATION_ID, CMS_ADMIN_BUILD_REVISION: sha, CMS_PUBLISH_TRANSPORT: "github",
    CMS_PREVIEW_SERIALIZER_READY: "true", CMS_PREVIEW_RENDERER_SHA: rendererSha,
    CMS_DEV_REPORT_INTAKE_MODE: "stored-only", CMS_WRITEBACK_CONFIGURED: "true",
    CMS_MEDIA_R2_BUCKET: "template-dev-media", CMS_MEDIA_PUBLIC_ORIGIN: "https://dev-media.example.org",
    CMS_READER_BRIDGE_ENABLED: "false", PUBLIC_RELEASE_READERS_ENABLED: "false",
    PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: "false" });
  writeFileSync(path, `${Object.entries(vars).map(([name, value]) => `${name}=${value}`).join("\n")}\n`);
  deployed = []; functions = []; apiVersion = null;
});
function providerFetch(url: any, init?: RequestInit) {
  const target = String(url);
  if (target === "https://cloudfunctions.googleapis.com/v2/projects/njpbs-site-dev/locations/us-central1/functions?pageSize=100") {
    return Promise.resolve(Response.json({ functions }));
  }
  if (target === "https://secretmanager.googleapis.com/v1/projects/njpbs-site-dev/secrets/CMS_EDGE_ORIGIN_SECRET/versions/7:access") {
    return Promise.resolve(Response.json({ payload: { data: Buffer.from("fixture-edge").toString("base64") } }));
  }
  if (target === "https://us-central1-njpbs-site-dev.cloudfunctions.net/cmsGetPublicPage") {
    const { createCmsGetPublicPageHandler } = require("../../functions/public-content.js");
    const { withCmsEdge } = require("../../functions/lib/cms-edge.js");
    const run = withCmsEdge(createCmsGetPublicPageHandler({ firestore: db }), { readSecret: () => "fixture-edge", logger: { error() {}, warn() {} } });
    const res = { code: 200, body: null as any, set() { return res; }, status(code: number) { res.code = code; return res; },
      json(body: any) { res.body = body; return res; }, send(body: string) { res.body = JSON.parse(body); return res; } };
    const headers = Object.fromEntries(new Headers(init?.headers));
    return run({ method: init?.method, headers, body: JSON.parse(String(init?.body)) }, res).then(() => Response.json(res.body, { status: res.code }));
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/template-dev-cms-api`;
  if (target === `${base}/deployments`) return Promise.resolve(Response.json({ success: true, result: { deployments: [fixture.apiDeployment] } }));
  if (target === `${base}/versions/${fixture.apiDeployment.versions[0].version_id}`) return Promise.resolve(Response.json({ success: true, result: apiVersion }));
  throw new Error("Unexpected provider fixture URL");
}
const providers = () => readDevReaderDeploymentProviders({ env, binding, apiVars,
  readGoogleToken: async () => "fixture-google", readCloudflareToken: async () => "fixture-cloudflare", fetchImpl: providerFetch });
const consumerProvider = () => createInstalledConsumerProvider({ environment: "development", request: providerFetch, readGoogleToken: async () => "fixture-google" });
async function deploy(deploymentEnv = env) {
  return deployDevReaders({ env: deploymentEnv, root, firestore: db,
    deployFunctions: async ({ env: preparedEnv }: any) => {
      assertDevConfigs(root, preparedEnv); deployed.push("functions");
      binding = Object.fromEntries(readFileSync(new URL("functions/.env.njpbs-site-dev", root), "utf8").trim().split("\n")
        .map(line => line.split("=")).filter(([key]) => key.startsWith("CMS_READER_") || key.startsWith("PUBLIC_RELEASE_")));
      functions = ["cmsReaderV1", "cmsReaderV2", "cmsReadPairCurrentCodeV2", "cmsGetPublicPage", "cmsSaveContent", "cmsTransitionContent", "onScheduledPublish"].map(name => ({
        name: `projects/njpbs-site-dev/locations/us-central1/functions/${name}`, state: "ACTIVE", environment: "GEN_2", updateTime: new Date().toISOString(),
        buildConfig: { entryPoint: name, runtime: "nodejs22", source: { storageSource: { bucket: "fixture-sources", object: `${name}/archive.tar.gz`, generation: "7" } } },
        serviceConfig: { revision: `${name.toLowerCase()}-00001-abc`, allTrafficOnLatestRevision: true, environmentVariables: { ...binding, CMS_ADMIN_BUILD_REVISION: sha },
          secretEnvironmentVariables: [{ key: "CMS_EDGE_ORIGIN_SECRET", secret: "CMS_EDGE_ORIGIN_SECRET", version: "7", projectId: "njpbs-site-dev" }] } }));
      vi.stubEnv("PUBLIC_RELEASE_READERS_ENABLED", binding.PUBLIC_RELEASE_READERS_ENABLED);
      vi.stubEnv("PUBLIC_RELEASE_COMPOSED_READERS_ENABLED", binding.PUBLIC_RELEASE_COMPOSED_READERS_ENABLED);
      vi.stubEnv("K_REVISION", "cmsgetpublicpage-00001-abc");
    },
    deployApi: async () => {
      deployed.push("cmsApi"); apiVars = JSON.parse(readFileSync(new URL("cms-api/wrangler.dev.jsonc", root), "utf8")).vars;
      apiVersion = { id: fixture.apiDeployment.versions[0].version_id, resources: { bindings:
        Object.entries(apiVars).map(([name, text]) => ({ name, type: "plain_text", text })) } };
    }, readProviders: providers, consumerProvider: consumerProvider() });
}
it("deploys native evidence accepted by the original public controls guard", async () => {
  expect((await db.collection("cmsReaderBridgeInstalledProofs").get()).empty).toBe(true);
  const result = await deploy(); expect(deployed).toEqual(["functions", "cmsApi"]);
  const apiFingerprint = await fingerprintInputs(sha, "cmsApi", { cwd: fileURLToPath(root) });
  expect(apiFingerprint).not.toBe(await fingerprintPaths(sha, RECEIPT_INPUT_PATHS.cmsApi, { cwd: fileURLToPath(root) }));
  expect(result.readers.cmsApi.inputFingerprint).toBe(apiFingerprint);
  for (const path of ["cmsDeploymentCandidates/cmsApi-123-1", "cmsDeploymentReceipts/cmsApi"]) {
    expect((await db.doc(path).get()).data().mutation.inputFingerprint).toBe(apiFingerprint);
  }
  expect(result.publicConsumers.probe.flags).toEqual({ PUBLIC_RELEASE_READERS_ENABLED: true, PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: true });
  expect(result.publicConsumers.sourceSha).toBe(sha);
  expect(result.deploymentInputs.functions).not.toBe(result.readers.functions.inputFingerprint);
  // The controls owner repeats fresh native evidence; no serialized report is a proof.
  const f = installedConsumerFixture();
  const contractPath = [...f.data.keys()].find(key => key.endsWith(f.contractDigest))!;
  await db.doc(contractPath).set(f.data.get(contractPath));
  const installed = await prepareInstalledPublicReleaseConsumers({ firestore: db, environment: "development", sourceSha: sha,
    contractDigest: f.contractDigest, provider: consumerProvider(), cwd: fileURLToPath(root) });
  await db.runTransaction(async (transaction: any) => {
    const before = (await transaction.get(db.doc("system/publicDeployment"))).data();
    await assertInstalledPublicReleaseConsumersInTransaction({ firestore: db, transaction, before, proof: installed, environment: "development", contractDigest: f.contractDigest });
    await expect(assertInstalledPublicReleaseConsumersInTransaction({ firestore: db, transaction, before,
      proof: result.publicConsumers as any, environment: "development", contractDigest: f.contractDigest })).rejects.toThrow();
  });
  expect(result.candidates).toEqual({ functions: "functions-123-1", cmsApi: "cmsApi-123-1" });
  for (const component of ["functions", "cmsApi"]) {
    const candidate = (await db.doc(`cmsDeploymentCandidates/${result.candidates[component]}`).get()).data();
    const legacy = (await db.doc(`cmsDeploymentReceipts/${component}`).get()).data();
    const reader = (await db.doc(`${cms.READER_RECEIPTS}/${component}`).get()).data();
    expect(candidate.schemaVersion).toBe(2); expect(candidate.state).toBe("verified"); expect(legacy.state).toBe("complete");
    expect(candidate.mutation.providerIdentities).toEqual(legacy.mutation.providerIdentities);
    expect({ ...reader.lastComplete, verifiedAt: null }).toEqual({ ...result.readers[component], verifiedAt: null });
  }
  expect((await db.collection("cmsReaderBridgeInstalledProofs").get()).empty).toBe(true);
  expect(readFileSync(new URL("functions/.env.njpbs-site-dev", root), "utf8")).toContain("CMS_READER_BRIDGE_ENABLED=false");

});
it("stops an uncertain original deployment and restores inert local configuration without completing candidates", async () => {
  const phases: string[] = [];
  await expect(deployDevReaders({ env, root, firestore: db, fingerprint: async () => "d".repeat(64), readProviders: providers, onPhase: phase => phases.push(phase),
    deployFunctions: async () => { throw new Error("fixture lost deploy reply"); }, deployApi: async () => { throw new Error("Must not deploy API"); } })).rejects.toThrow("fixture lost deploy reply");
  expect(phases.at(-1)).toBe("functions-deploy");
  expect(phases).not.toContain("api-deploy");
  expect((await db.doc("cmsDeploymentCandidates/functions-123-1").get()).data().state).toBe("candidate");
  expect((await db.doc("cmsDeploymentReceipts/functions").get()).data().state).toBe("in_progress");
  expect((await db.collection(cms.READER_RECEIPTS).get()).empty).toBe(true);
  await expect(deploy()).rejects.toThrow("reconciliation"); expect(deployed).toEqual([]);
  expect(readFileSync(new URL("functions/.env.njpbs-site-dev", root), "utf8")).toContain("CMS_READER_BRIDGE_ENABLED=false");
});
it("refuses an ordinary update without prior completed readers before deploying or writing receipts", async () => {
  const ordinary = { ...env, CMS_DEV_INSTALL_READER_BRIDGE: "false", CMS_DEV_READER_OPERATION_ID: "", CMS_DEV_READER_INSTALL_AUTHORIZATION: "" };
  const before = await db.collection("cmsDeploymentCandidates").get();
  await expect(deploy(ordinary)).rejects.toThrow();
  expect(deployed).toEqual([]);
  expect((await db.collection("cmsDeploymentCandidates").get()).docs.map((doc: any) => doc.id)).toEqual(before.docs.map((doc: any) => doc.id));
});
it("refuses missing/off/wrong-source readers and executing API binding drift at the native provider boundary", async () => {
  await deploy();
  const originalFunctions = structuredClone(functions), originalVersion = structuredClone(apiVersion);
  for (const mutate of [() => { functions.pop(); }, () => { functions[0].state = "DEPLOYING"; },
    () => { functions[0].serviceConfig.environmentVariables.CMS_READER_BRIDGE_ENABLED = "false"; },
    () => { functions[3].serviceConfig.environmentVariables.PUBLIC_RELEASE_COMPOSED_READERS_ENABLED = "false"; },
    () => { functions[0].serviceConfig.environmentVariables.CMS_ADMIN_BUILD_REVISION = "b".repeat(40); },
    () => { apiVersion.resources.bindings.find((row: any) => row.name === "FIREBASE_PROJECT_ID").text = "njpbs-site"; },
    () => { apiVersion.resources.bindings.find((row: any) => row.name === "CMS_READER_BRIDGE_OPERATION_ID").text = "reader-wrong"; },
    () => { apiVersion.id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; }]) {
    functions = structuredClone(originalFunctions); apiVersion = structuredClone(originalVersion); mutate();
    await expect(providers()).rejects.toThrow();
  }
});

it("refuses a disabled composed probe after native receipts without inventing installed evidence", async () => {
  await deploy();
  vi.stubEnv("PUBLIC_RELEASE_COMPOSED_READERS_ENABLED", "false");
  const { readInstalledPublicReleaseConsumerDeployment } = await import("../../site/scripts/public-release-installed-consumer-owner");
  await expect(readInstalledPublicReleaseConsumerDeployment({ firestore: db, environment: "development", sourceSha: sha,
    provider: consumerProvider(), cwd: fileURLToPath(root) })).rejects.toThrow("not proven");
});

it("updates installed readers with fresh native evidence while preserving the original Stage A proof", async () => {
  const result = await deploy(); fixture.readers = result.readers;
  const captured = await source.captureRetainedReaderReplySources({ firestore: db, ...fixture, now: () => fixture.now });
  const config = { schemaVersion: 1, projectId: db.projectId, ...captured, readerOperationId: result.operationId,
    bridgeOperationId: result.operationId, candidates: result.candidates, accountId: env.CLOUDFLARE_ACCOUNT_ID, consumerStage: FIRST_INSTALL_STAGE };
  const adapter = await createReaderInstallAdapter({ firestore: db, config, readProviders: providers,
    readStaffToken: async () => "fixture-staff", readEdgeSecret: async () => "fixture-edge" });
  const request = await adapter.prepareRequest({ operationId: result.operationId, stage: FIRST_INSTALL_STAGE });
  expect(request.cases).toHaveLength(28); expect(request.refusals).toHaveLength(2);
  expect((await db.collection("cmsReaderBridgeInstalledProofs").get()).empty).toBe(true);
  http = await nativeReaderHttp(db, fixture, config);
  const common = { ...adapter, firestore: db, request };
  const proof = await proveCmsReaderBridge({ ...common, transport: http.transport(adapter.targets) });
  expect(proof.results).toHaveLength(56); expect(proof.refusals).toHaveLength(4);
  await installCmsReaderBridge({ ...common, commitReader: commitLiveReaderReceipt });
  await expect(prepareInstalledCmsReaderConsumers({ firestore: db, operationId: result.operationId, readProviders: providers,
    assertStateInTransaction: adapter.assertStateInTransaction })).rejects.toThrow();
  const originalProofs = (await db.collection("cmsReaderBridgeInstalledProofs").get()).docs.map((doc: any) => doc.data());
  const originalCandidates = await Promise.all(Object.values(result.candidates).map(async id => (await db.doc(`cmsDeploymentCandidates/${id}`).get()).data()));
  const selectors = await db.getAll(db.doc("system/publicDeployment"), db.doc("system/cmsPreviewRuntime"));
  const completed = await db.getAll(db.doc("cmsDeploymentReceipts/functions"), db.doc("cmsDeploymentReceipts/cmsApi"));
  const interrupted = { ...env, CMS_DEV_INSTALL_READER_BRIDGE: "false", CMS_DEV_READER_OPERATION_ID: "", CMS_DEV_READER_INSTALL_AUTHORIZATION: "", GITHUB_RUN_ID: "124" };
  await expect(deployDevReaders({ env: interrupted, root, firestore: db, readProviders: providers,
    deployFunctions: async () => { throw new Error("fixture inventory read failed before deployment"); },
    deployApi: async () => { throw new Error("Must not deploy API"); } })).rejects.toThrow("fixture inventory read failed");
  const interruptedCandidates = await Promise.all(["functions", "cmsApi"].map(async (component, index) => {
    const receipt = (await db.doc(`cmsDeploymentReceipts/${component}`).get()).data();
    expect(receipt.state).toBe("in_progress");
    expect(receipt.lastComplete).toEqual(completed[index].data().mutation);
    const candidate = (await db.doc(`cmsDeploymentCandidates/${component}-124-1`).get()).data();
    expect(candidate.state).toBe("candidate");
    return candidate;
  }));
  await expect(deploy(interrupted)).rejects.toThrow("reconciliation");
  const ordinary = { ...interrupted, GITHUB_RUN_ID: "125" };
  // A new API deployment must be described by its executing version, not the
  // immutable first-install proof's original API version.
  fixture.apiDeployment.versions[0].version_id = "22222222-2222-4222-8222-222222222222";
  const updated = await deploy(ordinary);
  expect(updated.operationId).toBe("reader-dev-125-1");
  expect(updated.candidates).toEqual({ functions: "functions-125-1", cmsApi: "cmsApi-125-1" });
  expect(updated.readers.cmsApi.providerIdentities.versionId).toBe(fixture.apiDeployment.versions[0].version_id);
  expect(updated.publicConsumers.probe.flags).toEqual({ PUBLIC_RELEASE_READERS_ENABLED: true, PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: true });
  for (const component of ["functions", "cmsApi"]) {
    expect((await db.doc(`cmsDeploymentCandidates/${updated.candidates[component]}`).get()).data().state).toBe("verified");
    expect((await db.doc(`cmsDeploymentReceipts/${component}`).get()).data().state).toBe("complete");
    const current = (await db.doc(`${cms.READER_RECEIPTS}/${component}`).get()).data().lastComplete;
    expect({ ...current, verifiedAt: null }).toEqual({ ...updated.readers[component], verifiedAt: null });
  }
  expect((await db.collection("cmsReaderBridgeInstalledProofs").get()).docs.map((doc: any) => doc.data())).toEqual(originalProofs);
  expect(await Promise.all(Object.values(result.candidates).map(async id => (await db.doc(`cmsDeploymentCandidates/${id}`).get()).data()))).toEqual(originalCandidates);
  expect(await Promise.all(["functions", "cmsApi"].map(async component => (await db.doc(`cmsDeploymentCandidates/${component}-124-1`).get()).data()))).toEqual(interruptedCandidates);
  expect((await db.getAll(db.doc("system/publicDeployment"), db.doc("system/cmsPreviewRuntime"))).map((doc: any) => doc.data())).toEqual(selectors.map((doc: any) => doc.data()));
  await http.close(); fixture.readers = updated.readers;
  http = await nativeReaderHttp(db, fixture, { ...config, readerOperationId: updated.operationId, bridgeOperationId: updated.operationId, candidates: updated.candidates });
  const body = { version: 2, action: "open", sessionIds: { functions: "33333333-3333-4333-8333-333333333333", cmsApi: "44444444-4444-4444-8444-444444444444" }, ttlMs: 1000 };
  const gatewayRequest = new Request("https://dev-cms-api.njpbs.org/api/cms/v2/reader", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-staff" }, body: JSON.stringify(body) });
  const response = await dispatchCmsReaderMount({ request: gatewayRequest, body: await gatewayRequest.arrayBuffer(), version: 2,
    env: { ...apiVars, CMS_EDGE_ORIGIN_SECRET: "fixture-edge", CMS_API_WORKER_VERSION: { id: apiVersion.id } },
    context: { requestId: "33333333-3333-4333-8333-333333333333", clientIp: "203.0.113.9" },
    fetchOrigin: http.request, verifyToken: async () => ({ uid: fixture.actor.uid }) as any, checkRate: async () => null });
  expect(response.status).toBe(200);
  expect((await response.json()).identities).toEqual(updated.identities);
  await expect(deploy(ordinary)).rejects.toThrow("reconciliation");
});
