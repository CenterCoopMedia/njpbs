import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { productionReaderBinding, preflightProductionReader, startProductionReader, completeProductionReader, readProductionReaderResult } from "../../scripts/production-reader-deployment.mjs";
import { readEnabledCmsReaderProviders } from "../../scripts/lib/cms-enabled-reader-provider.mjs";
import { createInstalledConsumerProvider } from "../../site/scripts/public-release-installed-consumer-provider";
const require = createRequire(import.meta.url);
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const env = { CANONICAL_GITHUB_REPOSITORY: "CenterCoopMedia/njpbs", CANONICAL_GITHUB_REPOSITORY_ID: "1442374012",  CMS_PRODUCTION_INSTALL_READER_BRIDGE: "true", CMS_PRODUCTION_READER_OPERATION_ID: "reader-production-first",
  CMS_PRODUCTION_READER_INSTALL_AUTHORIZATION: "INSTALL_PRODUCTION_READERS", CMS_DEPLOYMENT_ENVIRONMENT: "production",
  FIREBASE_PROJECT_ID: "njpbs-site", FORCE_FIREBASE: "true", DEPLOY_SHA: sha, GITHUB_SHA: sha, GITHUB_WORKFLOW_SHA: sha,
  GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_REF: "refs/heads/main", GITHUB_ACTOR: "fixture-user", CMS_PUBLISH_GITHUB_TRUSTED_ACTORS: JSON.stringify(["fixture-user"]), CMS_DEPLOY_OWNER: "fixture-user", GITHUB_TRIGGERING_ACTOR: "fixture-user",
  GITHUB_WORKFLOW_REF: "CenterCoopMedia/njpbs/.github/workflows/cms-staging-deploy.yml@refs/heads/main",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) };
let app: any, db: any, root: URL, directory: string, functions: any[], apiVersion: any;
const apiDeployment = { id: "original-api-deployment", versions: [{ version_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", percentage: 100 }] };
const publicRoot = { schemaVersion: 1, state: "idle", activeCommitSha: "a".repeat(40) };
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Local emulator only");
  app = initializeApp({ projectId: "njpbs-site" }, "production-reader-local-emulator"); db = getFirestore(app);
});
afterAll(async () => { await db?.terminate(); if (app) await deleteApp(app); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site/databases/(default)/documents`, { method: "DELETE" });
  await db.doc("system/publicDeployment").set(publicRoot);
  await db.doc("system/cmsPreviewRuntime").set({ schemaVersion: 1, phase: "ready" });
  directory = mkdtempSync(join(tmpdir(), "production-reader-test-")); root = pathToFileURL(`${directory}/`);
  writeFileSync(new URL(".git", root), `gitdir: ${execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim()}\n`);
  for (const path of ["functions", "cms-api"]) mkdirSync(new URL(`${path}/`, root));
  cpSync(new URL("../../cms-api/wrangler.jsonc", import.meta.url), new URL("cms-api/wrangler.jsonc", root));
  writeFileSync(new URL("functions/.env.njpbs-site", root), `CMS_ADMIN_BUILD_REVISION=${sha}\nCMS_DEPLOYMENT_ENVIRONMENT=production\nCMS_PREVIEW_SERIALIZER_READY=true\nCMS_PREVIEW_RENDERER_SHA=${"a".repeat(40)}\n`);
  functions = []; apiVersion = { id: apiDeployment.versions[0].version_id, resources: { bindings: [] } };
});
function providerFetch(url: any, init?: RequestInit) {
  const target = String(url);
  if (target === "https://cloudfunctions.googleapis.com/v2/projects/njpbs-site/locations/us-central1/functions?pageSize=100") return Promise.resolve(Response.json({ functions }));
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/njpbs-cms-api`;
  if (target === `${base}/deployments`) return Promise.resolve(Response.json({ success: true, result: { deployments: [apiDeployment] } }));
  if (target === `${base}/versions/${apiDeployment.versions[0].version_id}`) return Promise.resolve(Response.json({ success: true, result: apiVersion }));
  if (target === "https://secretmanager.googleapis.com/v1/projects/njpbs-site/secrets/CMS_EDGE_ORIGIN_SECRET/versions/7:access") {
    return Promise.resolve(Response.json({ payload: { data: Buffer.from("fixture-edge").toString("base64") } }));
  }
  if (target === "https://us-central1-njpbs-site.cloudfunctions.net/cmsGetPublicPage") {
    const { createCmsGetPublicPageHandler } = require("../../functions/public-content.js");
    const { withCmsEdge } = require("../../functions/lib/cms-edge.js");
    const run = withCmsEdge(createCmsGetPublicPageHandler({ firestore: db }), { readSecret: () => "fixture-edge", logger: { error() {}, warn() {} } });
    const res = { code: 200, body: null as any, set() { return res; }, status(code: number) { res.code = code; return res; },
      json(body: any) { res.body = body; return res; }, send(body: string) { res.body = JSON.parse(body); return res; } };
    return run({ method: init?.method, headers: Object.fromEntries(new Headers(init?.headers)), body: JSON.parse(String(init?.body)) }, res)
      .then(() => Response.json(res.body, { status: res.code }));
  }
  throw new Error("Unexpected provider fixture URL");
}
const readProviders = (options: any) => readEnabledCmsReaderProviders({ ...options, projectId: "njpbs-site", accountId: env.CLOUDFLARE_ACCOUNT_ID,
  sourceSha: sha, readGoogleToken: async () => "fixture-google", readCloudflareToken: async () => "fixture-cloudflare", fetchImpl: providerFetch });
function deployFunctionsBoundary() {
  const vars = Object.fromEntries(readFileSync(new URL("functions/.env.njpbs-site", root), "utf8").trim().split("\n").map(line => line.split("=")));
  functions = ["cmsReaderV1", "cmsReaderV2", "cmsReadPairCurrentCodeV2", "cmsGetPublicPage", "cmsSaveContent", "cmsTransitionContent", "onScheduledPublish"].map(name => ({
    name: `projects/njpbs-site/locations/us-central1/functions/${name}`, state: "ACTIVE", environment: "GEN_2", updateTime: new Date().toISOString(),
    buildConfig: { entryPoint: name, runtime: "nodejs22", source: { storageSource: { bucket: "fixture-sources", object: `${name}/archive.tar.gz`, generation: "7" } } },
    serviceConfig: { revision: `${name.toLowerCase()}-00001-abc`, allTrafficOnLatestRevision: true, environmentVariables: vars,
      secretEnvironmentVariables: [{ key: "CMS_EDGE_ORIGIN_SECRET", secret: "CMS_EDGE_ORIGIN_SECRET", version: "7", projectId: "njpbs-site" }] } }));
  vi.stubEnv("PUBLIC_RELEASE_READERS_ENABLED", "true"); vi.stubEnv("PUBLIC_RELEASE_COMPOSED_READERS_ENABLED", "true");
  vi.stubEnv("K_REVISION", "cmsgetpublicpage-00001-abc");
}
function deployApiBoundary() {
  const vars = JSON.parse(readFileSync(new URL("cms-api/wrangler.jsonc", root), "utf8")).vars;
  apiVersion = { id: apiDeployment.versions[0].version_id, resources: { bindings: Object.entries(vars).map(([name, text]) => ({ name, type: "plain_text", text })) } };
}
async function deploy() {
  await preflightProductionReader({ firestore: db, component: "functions", env });
  await startProductionReader({ firestore: db, component: "functions", env, root }); deployFunctionsBoundary();
  await completeProductionReader({ firestore: db, component: "functions", env, root, readProviders });
  await startProductionReader({ firestore: db, component: "cmsApi", env, root }); deployApiBoundary();
  await completeProductionReader({ firestore: db, component: "cmsApi", env, root, readProviders });
  return readProductionReaderResult({ firestore: db, env, root,
    consumerProvider: createInstalledConsumerProvider({ environment: "production", request: providerFetch, readGoogleToken: async () => "fixture-google" }) });
}
it("reconciles original production candidates, complete/provider/reader receipts and actual deployed consumer probe", async () => {
  const result = await deploy();
  expect(result.projectId).toBe("njpbs-site"); expect(result.operationId).toBe("reader-production-first");
  expect(result.publicConsumers.probe.flags).toEqual({ PUBLIC_RELEASE_READERS_ENABLED: true, PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: true });
  for (const component of ["functions", "cmsApi"]) {
    const candidate = (await db.doc(`cmsDeploymentCandidates/${component}-123-1`).get()).data();
    const complete = (await db.doc(`cmsDeploymentReceipts/${component}`).get()).data();
    const reader = (await db.doc(`cmsReaderCompatibilityReceipts/${component}`).get()).data();
    expect(candidate.state).toBe("verified"); expect(complete.state).toBe("complete");
    expect(candidate.mutation.configurationFingerprint).toBe(complete.mutation.configurationFingerprint);
    expect(reader.lastComplete.providerIdentities).toEqual(candidate.mutation.providerIdentities);
    expect(reader.lastComplete.inputFingerprint).toBe(complete.mutation.inputFingerprint);
  }
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(publicRoot);
  expect((await db.doc("system/cmsPreviewRuntime").get()).data()).toEqual({ schemaVersion: 1, phase: "ready" });
  expect((await db.collection("cmsReaderBridgeInstalledProofs").get()).empty).toBe(true);
});
it("retains an uncertain original attempt and refuses retry, changed run and unverified completion", async () => {
  await startProductionReader({ firestore: db, component: "functions", env, root });
  await expect(completeProductionReader({ firestore: db, component: "functions", env, root,
    readProviders: async () => { throw new Error("lost provider reply"); } })).rejects.toThrow("lost provider reply");
  await expect(startProductionReader({ firestore: db, component: "functions", env, root })).rejects.toThrow();
  await expect(startProductionReader({ firestore: db, component: "functions", env: { ...env, GITHUB_RUN_ID: "124" }, root })).rejects.toThrow();
  await expect(startProductionReader({ firestore: db, component: "cmsApi", env: { ...env, GITHUB_RUN_ID: "124" }, root })).rejects.toThrow();
  expect((await db.doc("cmsDeploymentCandidates/functions-123-1").get()).data().state).toBe("candidate");
  expect((await db.doc("cmsDeploymentReceipts/functions").get()).data().state).toBe("in_progress");
  expect((await db.collection("cmsReaderCompatibilityReceipts").get()).empty).toBe(true);
});
it("preserves unfinished native receipts and requires original completed Functions before API installation", async () => {
  await db.doc("cmsDeploymentReceipts/functions").set({ schemaVersion: 1, component: "functions", state: "in_progress", mutation: { runId: "old-original" } });
  await expect(preflightProductionReader({ firestore: db, component: "functions", env })).rejects.toThrow();
  await expect(startProductionReader({ firestore: db, component: "functions", env, root })).rejects.toThrow();
  expect((await db.doc("cmsDeploymentReceipts/functions").get()).data().mutation.runId).toBe("old-original");
  expect((await db.collection("cmsReaderDeploymentAttempts").get()).empty).toBe(true);
  await db.doc("cmsDeploymentReceipts/functions").delete();
  await db.doc("cmsReaderDeploymentAttempts/reader-production-first").set({ prior: "original" });
  await expect(preflightProductionReader({ firestore: db, component: "functions", env })).rejects.toThrow();
  expect((await db.doc("system/cmsPreviewRuntime").get()).data()).toEqual({ schemaVersion: 1, phase: "ready" });
  expect((await db.doc("cmsDeploymentReceipts/renderer").get()).exists).toBe(false);
  await db.doc("cmsReaderDeploymentAttempts/reader-production-first").delete();
  await preflightProductionReader({ firestore: db, component: "functions", env });
  expect((await db.collection("cmsReaderDeploymentAttempts").get()).empty).toBe(true);
  await startProductionReader({ firestore: db, component: "functions", env, root });
  await expect(startProductionReader({ firestore: db, component: "cmsApi", env, root })).rejects.toThrow();
  expect((await db.doc("cmsDeploymentCandidates/cmsApi-123-1").get()).exists).toBe(false);
});
it("refuses missing, disabled, wrong source and wrong candidate native provider readers", async () => {
  await deploy();
  const originalFunctions = structuredClone(functions), originalVersion = structuredClone(apiVersion);
  for (const mutate of [() => functions.pop(), () => { functions[0].state = "DEPLOYING"; },
    () => { functions[0].serviceConfig.environmentVariables.CMS_ADMIN_BUILD_REVISION = "b".repeat(40); },
    () => { functions[0].serviceConfig.environmentVariables.PUBLIC_RELEASE_READERS_ENABLED = "false"; },
    () => { functions[0].serviceConfig.environmentVariables.PUBLIC_RELEASE_COMPOSED_READERS_ENABLED = "false"; },
    () => { apiVersion.resources.bindings.find((row: any) => row.name === "CMS_READER_BRIDGE_CMS_API_CANDIDATE").text = "cmsApi-124-1"; },
    () => { apiVersion.id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; }]) {
    functions = structuredClone(originalFunctions); apiVersion = structuredClone(originalVersion); mutate();
    await expect(readProviders({ binding: productionReaderBinding(env), apiVars: JSON.parse(readFileSync(new URL("cms-api/wrangler.jsonc", root), "utf8")).vars })).rejects.toThrow();
  }
});
it("refuses configuration drift and provider drift before recording reader compatibility", async () => {
  await startProductionReader({ firestore: db, component: "functions", env, root }); deployFunctionsBoundary();
  const path = new URL("functions/.env.njpbs-site", root), original = readFileSync(path, "utf8");
  writeFileSync(path, `${original}UNREVIEWED_VALUE=changed\n`);
  await expect(completeProductionReader({ firestore: db, component: "functions", env, root, readProviders })).rejects.toThrow();
  writeFileSync(path, original);
  let observations = 0;
  await expect(completeProductionReader({ firestore: db, component: "functions", env, root, readProviders: async (options: any) => {
    const identities = await readProviders(options);
    if (++observations === 2) identities.functions.inventoryFingerprint = "0".repeat(64);
    return identities;
  } })).rejects.toThrow();
  expect((await db.collection("cmsReaderCompatibilityReceipts").get()).empty).toBe(true);
});
it("keeps authorization off by default and requires the distinct production workflow/source/actor/full-release tuple", () => {
  expect(productionReaderBinding({})).toBeNull(); expect(productionReaderBinding({ CMS_PRODUCTION_INSTALL_READER_BRIDGE: "false" })).toBeNull();
  for (const change of [{ CMS_PRODUCTION_INSTALL_READER_BRIDGE: "yes" }, { CMS_PRODUCTION_INSTALL_READER_BRIDGE: "false" },
    { FIREBASE_PROJECT_ID: "njpbs-site-dev" }, { CMS_DEPLOYMENT_ENVIRONMENT: "development" }, { FORCE_FIREBASE: "false" },
    { CMS_PRODUCTION_READER_INSTALL_AUTHORIZATION: "INSTALL_DEV_READERS" }, { DEPLOY_SHA: "b".repeat(40) },
    { GITHUB_WORKFLOW_SHA: "b".repeat(40) }, { GITHUB_TRIGGERING_ACTOR: "collaborator" }, { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_WORKFLOW_REF: "CenterCoopMedia/njpbs/.github/workflows/cms-dev-deploy.yml@refs/heads/main" }]) {
    expect(() => productionReaderBinding({ ...env, ...change })).toThrow();
  }
});
