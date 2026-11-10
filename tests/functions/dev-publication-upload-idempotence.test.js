import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../../functions/lib/firebase.js";
import dev from "../../scripts/lib/dev-publication.cjs";
import reconciliation from "../../functions/lib/publish-reconcile.js";
import { createPublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory.ts";
import { preparePublicWorkerArtifact } from "../../site/src/lib/public-worker-artifact.ts";
const db = isolatedFirestore("dev-publication-upload-idempotence.test.js");

const root = fileURLToPath(new URL("../..", import.meta.url));
const identity = { queueId: "A1b2C3d4E5f6G7h8I9j0", buildBatchId: "cms-A1b2C3d4E5f6G7h8I9j0", commitSha: "a".repeat(40) };
const runtime = { owner: "cloudflare", release: identity.commitSha };
const versionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const deploymentId = "11111111-2222-4333-8444-555555555555";
const versionCreatedOn = "2026-10-10T00:00:00.000Z";
const batchRef = () => db.doc(`system/publicDeployment/buildBatches/${identity.buildBatchId}`);
const queueRef = () => db.doc(`cmsPublishQueue/${identity.queueId}`);
let directory;

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || !/^demo-[a-z0-9-]+$/.test(db.projectId)) {
    throw new Error("Use a loopback demo Firestore emulator");
  }
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`,
    { method: "DELETE" }, db);
  directory = await mkdtemp(path.join(tmpdir(), "dev-upload-idempotence-"));
  await queueRef().set({ status: "pending", transport: "github", environment: "development",
    projectId: "njpbs-site-dev", runtime, triggeredAt: new Date("2026-10-10T00:00:00.000Z"), changes: [] });
});
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
}

async function retainedArtifact() {
  await dev.reserveDevPublication(db, identity);
  const reservation = (await batchRef().get()).data();
  const artifact = path.join(directory, "artifact");
  await mkdir(path.join(artifact, "dist/posts/_no-build-assets/_astro"), { recursive: true });
  await mkdir(path.join(artifact, "renderer/server/chunks"), { recursive: true });
  await mkdir(path.join(artifact, "renderer/client/_astro"), { recursive: true });
  const inventory = createPublicArtifactInventoryReceipt({ reservation, pages: [], posts: [], programs: [], authors: [], settings: [] });
  await writeJson(path.join(artifact, "inventory.json"), inventory);
  await writeJson(path.join(artifact, "public-context.json"), {
    schemaVersion: 3, pages: [], posts: [], programs: [], authors: [], settings: [], receipt: inventory,
  });
  await writeFile(path.join(artifact, "dist/index.html"), "<!doctype html><html><body>Retained dev fixture</body></html>");
  await writeJson(path.join(artifact, "dist/_content-status.json"), {
    schemaVersion: 1, buildBatchId: identity.buildBatchId, generation: reservation.generation,
    commitSha: identity.commitSha, collections: ["cmsPages", "cmsPosts"], routes: [],
  });
  const release = { schemaVersion: 1, rendererSha: identity.commitSha, liveBlogVersion: 1,
    electionResultsVersion: 2, environment: "development" };
  await writeJson(path.join(artifact, "renderer/renderer-release.json"), release);
  await writeJson(path.join(artifact, "dist/posts/_no-build-assets/renderer-release.json"), release);
  await writeFile(path.join(artifact, "renderer/server/entry.mjs"), "export { value } from './chunks/post.mjs';\n");
  await writeFile(path.join(artifact, "renderer/server/chunks/post.mjs"), "export const value = 'dev-renderer-fixture';\n");
  for (const folder of ["renderer/client/_astro", "dist/posts/_no-build-assets/_astro"]) {
    await writeFile(path.join(artifact, folder, "post.js"), "export const source = 'client-fixture';\n");
  }
  const inputFiles = ["bundle.json", "schedule.json", "launch.json", "spotlight.json", "post-routes.json"];
  for (const name of inputFiles) await writeJson(path.join(artifact, name), name === "post-routes.json" ? [] : {});
  const inputs = [];
  for (const name of inputFiles) inputs.push([name, dev.hash(await readFile(path.join(artifact, name)))]);
  const inputDigest = dev.hash(JSON.stringify(inputs));
  await writeJson(path.join(artifact, "frozen.json"), { target: dev.TARGET, identity, inputDigest });
  await dev.recordDevInputs(db, identity, inputDigest);
  const publication = await preparePublicWorkerArtifact({ artifactReceipt: inventory,
    distDirectory: path.join(artifact, "dist"), outputPath: path.join(artifact, "publication.json") });
  const candidate = await dev.recordDevCandidate(db, identity, { inventory, publication, inputDigest, wranglerVersion: "4.134.0",
    version: { workerVersionId: versionId, versionCreatedOn,
      noBuildPost: { schemaVersion: 2, rendererSha: identity.commitSha, families: ["posts"], enabled: true, authoritative: true } } });
  return { artifact, candidate };
}

async function disposableUploader() {
  const checkout = path.join(directory, "checkout");
  await mkdir(path.join(checkout, "site/scripts"), { recursive: true });
  await mkdir(path.join(checkout, "cms-api"), { recursive: true });
  await mkdir(path.join(checkout, "workers"), { recursive: true });
  await mkdir(path.join(checkout, "node_modules/.bin"), { recursive: true });
  for (const name of ["functions", "packages", "scripts", ".github"]) await symlink(path.join(root, name), path.join(checkout, name));
  for (const name of ["src", "node_modules"]) await symlink(path.join(root, "site", name), path.join(checkout, "site", name));
  for (const name of await readdir(path.join(root, "site/scripts"))) {
    const source = path.join(root, "site/scripts", name);
    const destination = path.join(checkout, "site/scripts", name);
    if (name === "cms-dev-publication.mjs") await copyFile(source, destination);
    else await symlink(source, destination);
  }
  await copyFile(path.join(root, "workers/wrangler.public.dev.jsonc"), path.join(checkout, "workers/wrangler.public.dev.jsonc"));
  await copyFile(path.join(root, "cms-api/wrangler.dev.jsonc"), path.join(checkout, "cms-api/wrangler.dev.jsonc"));
  await writeJson(path.join(checkout, "package.json"), { type: "module" });
  const commands = path.join(directory, "provider-commands.jsonl");
  // A real child process stands in for the external Wrangler executable. It
  // records only non-secret arguments, never inherited credential values.
  await writeFile(path.join(checkout, "node_modules/.bin/wrangler"), `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commands)}, JSON.stringify(args) + "\\n");
process.stdout.write(args[0] === "--version" ? "4.134.0\\n" : "Worker Version ID: ${versionId}\\n");
`, { mode: 0o700 });
  return { checkout, commands };
}

async function providerProcess(checkout, artifact, commands, scenario = "normal") {
  const entry = path.join(directory, "provider-boundary.mjs");
  await writeFile(entry, `
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { firebaseAdminRuntime } from ${JSON.stringify(path.join(root, "site/scripts/firebase-admin-runtime.ts"))};
import { upload } from ${JSON.stringify(path.join(checkout, "site/scripts/cms-dev-publication.mjs"))};
const require = createRequire(${JSON.stringify(path.join(root, "functions/package.json"))});
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const candidateModule = require(${JSON.stringify(path.join(root, "functions/lib/public-worker-candidate.js"))});
const devState = require(${JSON.stringify(path.join(root, "scripts/lib/dev-publication.cjs"))});
const identity = ${JSON.stringify(identity)};
const publication = JSON.parse(readFileSync(${JSON.stringify(path.join(artifact, "publication.json"))}, "utf8"));
const scenario = ${JSON.stringify(scenario)};
const objects = new Map();
let r2Calls = 0;
S3Client.prototype.send = async function(command) {
  r2Calls++;
  assert(["normal", "mid-run timeout"].includes(scenario), "Timeout recovery cannot create or read an R2 context");
  const input = command.input;
  assert.equal(input.Bucket, "template-dev-cms-previews");
  if (command instanceof PutObjectCommand) {
    assert.equal(input.IfNoneMatch, "*");
    assert(!objects.has(input.Key));
    objects.set(input.Key, Buffer.from(input.Body));
    return {};
  }
  assert(command instanceof GetObjectCommand);
  const bytes = objects.get(input.Key);
  if (!bytes) throw Object.assign(new Error("Fixture object missing"), { $metadata: { httpStatusCode: 404 } });
  return { ContentLength: bytes.length, Body: { transformToWebStream: () => new Blob([bytes]).stream() } };
};
const requests = [];
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const method = options.method ?? "GET";
  requests.push({ pathname: parsed.pathname, method });
  if (parsed.origin === "https://dev-public.example.org") {
    assert.equal(parsed.pathname, "/_publication.json");
    assert.equal(parsed.searchParams.get("candidate"), identity.buildBatchId);
    assert.equal(parsed.searchParams.get("version"), ${JSON.stringify(versionId)});
    return new Response(scenario === "wrong bytes" ? "{}" : readFileSync(${JSON.stringify(path.join(artifact, "dist/_publication.json"))}), {
      headers: { "x-njpbs-publication-origin": "template-dev-public", "content-type": "application/json" } });
  }
  assert.equal(parsed.origin, "https://api.cloudflare.com");
  let result;
  if (parsed.pathname === "/client/v4/zones") result = [{ id: "a".repeat(32), name: "njpbs.org",
    account: { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }];
  else if (parsed.pathname.endsWith("/workers/routes")) result = [{ script: "njpbs-dev-staff-sites" }];
  else if (parsed.pathname.endsWith("/subdomain")) result = { enabled: false, previews_enabled: false };
  else if (parsed.pathname.endsWith("/workers/domains")) result = [];
  else if (parsed.pathname.endsWith("/versions/${versionId}")) result = {
    id: ${JSON.stringify(versionId)}, metadata: { source: "wrangler", created_on: ${JSON.stringify(versionCreatedOn)} },
    annotations: { "workers/tag": candidateModule.publicWorkerCandidateTag(publication),
      "workers/message": candidateModule.publicWorkerCandidateMessage(publication), "workers/triggered_by": "version_upload" },
    resources: { script: {}, bindings: [{ name: "ASSETS", type: "assets" },
      { name: "CMS_API", type: "service", service: "template-dev-cms-api", entrypoint: "PublicContentEntrypoint", environment: "production" },
      { name: "NO_BUILD_POST_RENDERER_SHA", type: "plain_text", text: identity.commitSha }],
      script_runtime: { assets: { config: { run_worker_first: true, html_handling: "force-trailing-slash", not_found_handling: "404-page" } } } },
  };
  else if (parsed.pathname.endsWith("/deployments")) {
    if (method === "POST") assert.deepEqual(JSON.parse(options.body), {
      strategy: "percentage", versions: [{ version_id: ${JSON.stringify(versionId)}, percentage: 100 }] });
    const active = { id: ${JSON.stringify(deploymentId)}, source: "api", strategy: "percentage",
      annotations: { "workers/triggered_by": "deployment" }, created_on: "2026-10-10T00:01:00.000Z",
      versions: [{ version_id: scenario === "wrong provider" ? "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" : ${JSON.stringify(versionId)}, percentage: 100 }] };
    result = method === "POST" ? active : { deployments: [active] };
  } else throw new Error("Unexpected provider fixture request");
  return Response.json({ success: true, result });
};
const { initializeApp, getFirestore, deleteApp, cert } = firebaseAdminRuntime;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const app = initializeApp({ projectId: process.env.DEV_UPLOAD_TEST_PROJECT,
  credential: cert({ projectId: process.env.DEV_UPLOAD_TEST_PROJECT,
    clientEmail: "fixture@demo-njpbs.iam.gserviceaccount.com",
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString() }) }, "dev-upload-proof");
try {
  const actualDatabase = getFirestore(app);
  actualDatabase.settings({ host: process.env.FIRESTORE_EMULATOR_HOST, ssl: false });
  // Connect the network boundary to the demo emulator before exercising the
  // production-only CLI guard. Every real document and transaction stays on
  // that connection; only the target identity presented to the CLI is dev.
  await actualDatabase.doc("system/publicDeployment").get();
  delete process.env.FIRESTORE_EMULATOR_HOST;
  let injectedTimeout = false;
  const db = new Proxy(actualDatabase, { get(database, key) {
    if (key === "projectId") return "njpbs-site-dev";
    // At the database network boundary, delay the committed reply while an
    // independent stale-workflow owner fails the original queue. All reads,
    // transactions and the competing write use the real emulator SDK.
    if (key === "runTransaction" && scenario === "mid-run timeout") return async (...args) => {
      const value = await database.runTransaction(...args);
      const batch = await database.doc("system/publicDeployment/buildBatches/" + identity.buildBatchId).get();
      if (!injectedTimeout && batch.data()?.status === "deployed") {
        injectedTimeout = true;
        const reason = require(${JSON.stringify(path.join(root, "functions/lib/publish-reconcile.js"))}).STALE_PUBLISH_ERROR;
        await database.doc("cmsPublishQueue/" + identity.queueId).update({ status: "failed", error: reason });
      }
      return value;
    };
    const value = Reflect.get(database, key, database);
    return typeof value === "function" ? value.bind(database) : value;
  } });
  let first;
  try {
    first = scenario === "ordinary rerun" ? await upload(db, identity)
      : await upload(db, identity, true, { generation: publication.generation, workerVersionId: ${JSON.stringify(versionId)} });
  } catch {
    const cleanup = await devState.finishDevPublication(db, identity);
    console.log(JSON.stringify({ refused: true, cleanup, requests, r2Calls,
      commandsAfterFirst: existsSync(${JSON.stringify(commands)}) ? readFileSync(${JSON.stringify(commands)}, "utf8") : "" }));
    await deleteApp(app);
    process.exit(0);
  }
  const providerReadsAfterFirst = requests.length;
  const commandsAfterFirst = existsSync(${JSON.stringify(commands)}) ? readFileSync(${JSON.stringify(commands)}, "utf8") : "";
  const second = await upload(db, identity);
  console.log(JSON.stringify({ first, second, requests, r2Calls, providerReadsAfterFirst, commandsAfterFirst,
    commandsAfterSecond: existsSync(${JSON.stringify(commands)}) ? readFileSync(${JSON.stringify(commands)}, "utf8") : "" }));
} finally { await deleteApp(app); }
`);
  return spawnSync(process.execPath, ["--import", path.join(root, "site/node_modules/tsx/dist/loader.mjs"), entry], {
    cwd: checkout, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 20_000,
    env: { PATH: process.env.PATH, NODE_ENV: "test", FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
      GCLOUD_PROJECT: db.projectId, DEV_UPLOAD_TEST_PROJECT: db.projectId,
      CMS_DEV_ARTIFACT_DIRECTORY: artifact, CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev",
      CLOUDFLARE_ACCOUNT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", CMS_DEV_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_DEV_PUBLIC_WORKER: "template-dev-public", CMS_DEV_PUBLIC_ORIGIN: "https://dev-public.example.org", CMS_DEV_PREVIEW_BUCKET: "template-dev-cms-previews",
      CLOUDFLARE_API_TOKEN: "fixture-token", CMS_DEV_ACCESS_CLIENT_ID: "fixture-id", CMS_DEV_ACCESS_CLIENT_SECRET: "fixture-secret",
      CMS_DEV_CMS_SOURCE_SHA: "1".repeat(40), CMS_DEV_ADMIN_SOURCE_SHA: "2".repeat(40), CMS_DEV_RENDERER_SOURCE_SHA: "3".repeat(40),
      CMS_DEV_PREVIEW_R2_CREDENTIAL: JSON.stringify({ accessKeyId: "fixture-key", secretAccessKey: "fixture-secret" }),
    },
  });
}

describe("actual dev uploader with retained generic publication", () => {
  it.each(["ordinary upload", "already-deployed fast completion"])("reports an unconfirmed queue after a mid-run timeout during %s", async phase => {
    const { artifact } = await retainedArtifact();
    if (phase === "already-deployed fast completion") {
      const acquired = await dev.acquireDevDeploymentLease(db, identity);
      await dev.settleDevDeploymentOutcome(db, identity, acquired.lease,
        { action: "activate", buildBatchId: identity.buildBatchId, deploymentId, versionId, commitSha: identity.commitSha });
    }
    const { checkout, commands } = await disposableUploader();
    const result = await providerProcess(checkout, artifact, commands, "mid-run timeout");
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout.trim());
    expect(observed.refused).toBe(true);
    expect(observed.cleanup).toBe("unclaimed");
    const after = await dev.readDevPublication(db, identity);
    expect(after.batch.status).toBe("deployed");
    expect(after.queue).toMatchObject({ status: "failed", error: reconciliation.STALE_PUBLISH_ERROR });
    await expect(readFile(path.join(artifact, "deployment.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["reconciling", "deployed"])("settles only the original timed-out %s candidate without upload, provider POST or R2 work", async phase => {
    const { artifact, candidate } = await retainedArtifact();
    const acquisition = await dev.acquireDevDeploymentLease(db, identity);
    if (phase === "reconciling") await dev.finishDevPublication(db, identity);
    else await dev.settleDevDeploymentOutcome(db, identity, acquisition.lease,
      { action: "activate", buildBatchId: identity.buildBatchId, deploymentId, versionId, commitSha: identity.commitSha });
    await queueRef().update({ status: "failed", error: reconciliation.STALE_PUBLISH_ERROR });
    const retained = await dev.readDevPublication(db, identity);
    const { checkout, commands } = await disposableUploader();
    const result = await providerProcess(checkout, artifact, commands, "timeout");
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout.trim());
    expect(observed.first).toBe("success");
    expect(observed.second).toBe("success");
    expect(observed.requests.every(request => request.method === "GET")).toBe(true);
    expect(observed.r2Calls).toBe(0);
    expect(observed.commandsAfterFirst).toBe("");
    expect(observed.commandsAfterSecond).toBe("");
    const after = await dev.readDevPublication(db, identity);
    expect(after.queue).toMatchObject({ status: "success", deploymentReceipt: {
      queueId: identity.queueId, buildBatchId: identity.buildBatchId, generation: candidate.generation, versionId, deploymentId } });
    expect(after.batch.status).toBe("deployed");
    expect(after.candidate).toEqual(retained.candidate);
    expect(after.input).toEqual(retained.input);
    expect(after.batch.leaseToken).toBe(retained.batch.leaseToken);
  });

  it.each(["another failure", "wrong bytes", "wrong provider", "ordinary rerun"])("refuses %s before terminal settlement and preserves the original failed owner", async scenario => {
    const { artifact } = await retainedArtifact();
    await dev.acquireDevDeploymentLease(db, identity);
    if (scenario === "ordinary rerun") await dev.settleDevDeploymentOutcome(db, identity,
      (await dev.acquireDevDeploymentLease(db, identity)).lease,
      { action: "activate", buildBatchId: identity.buildBatchId, deploymentId, versionId, commitSha: identity.commitSha });
    else await dev.finishDevPublication(db, identity);
    await queueRef().update({ status: "failed", error: scenario === "another failure" ? "A different owner failure" : reconciliation.STALE_PUBLISH_ERROR });
    const before = await dev.readDevPublication(db, identity);
    const { checkout, commands } = await disposableUploader();
    const result = await providerProcess(checkout, artifact, commands, scenario);
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout.trim());
    expect(observed.refused).toBe(true);
    expect(observed.cleanup).toBe("unclaimed");
    expect(observed.r2Calls).toBe(0);
    expect(observed.requests.every(request => request.method === "GET")).toBe(true);
    expect(observed.commandsAfterFirst).toBe("");
    if (scenario === "another failure") expect(observed.requests).toHaveLength(0);
    if (scenario === "wrong bytes") expect(observed.requests.filter(request => request.pathname === "/_publication.json")).toHaveLength(1);
    expect(await dev.readDevPublication(db, identity)).toEqual(before);
  });

  it.each([["ready", 1], ["deploying", 0]])("reuses the uploaded candidate in %s and sends no second upload or activation", async (phase, expectedActivations) => {
    const { artifact, candidate } = await retainedArtifact();
    if (phase === "deploying") {
      const acquired = await dev.acquireDevDeploymentLease(db, identity);
      expect(acquired).toMatchObject({ outcome: "acquired", idempotent: false });
      expect(await dev.acquireDevDeploymentLease(db, identity)).toMatchObject({ outcome: "acquired", idempotent: true, lease: acquired.lease });
    }
    const retained = { candidate: (await db.doc(`system/publicDeployment/buildBatches/${identity.buildBatchId}/candidates/worker`).get()).data(),
      input: (await db.doc(`system/publicDeployment/buildBatches/${identity.buildBatchId}/inputs/devFrozen`).get()).data() };
    const { checkout, commands } = await disposableUploader();
    const result = await providerProcess(checkout, artifact, commands);
    expect(result.status, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    const observed = JSON.parse(result.stdout.trim());
    expect(observed.first).toBe("success");
    expect(observed.second).toBe("success");
    expect(observed.requests.filter(request => request.method === "POST")).toHaveLength(expectedActivations);
    expect(observed.requests).toHaveLength(observed.providerReadsAfterFirst);
    expect(observed.commandsAfterSecond).toBe(observed.commandsAfterFirst);
    expect(observed.commandsAfterSecond.trim().split("\n").map(line => JSON.parse(line))).toEqual([["--version"]]);
    expect((await queueRef().get()).data()).toMatchObject({ status: "success", runtime });
    expect((await batchRef().get()).data()).toMatchObject({ status: "deployed", commitSha: identity.commitSha });
    expect((await db.doc("system/publicDeployment").get()).data()).toMatchObject({ state: "idle", activeGeneration: candidate.generation,
      activeCommitSha: identity.commitSha, activeDeploymentId: deploymentId });
    expect((await db.doc(`system/publicDeployment/buildBatches/${identity.buildBatchId}/candidates/worker`).get()).data()).toEqual(retained.candidate);
    expect((await db.doc(`system/publicDeployment/buildBatches/${identity.buildBatchId}/inputs/devFrozen`).get()).data()).toEqual(retained.input);
    expect(await readFile(path.join(checkout, "site/.public-post-renderer/server/chunks/post.mjs"), "utf8"))
      .toBe("export const value = 'dev-renderer-fixture';\n");
  });
});
