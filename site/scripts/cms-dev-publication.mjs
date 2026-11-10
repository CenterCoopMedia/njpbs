import { devCloudflareAccount } from "./dev-cloudflare-account.mjs";
import { createRequire } from "node:module";
import { verifyDevPublicWorkerPrivate } from "../../scripts/lib/dev-private-worker.mjs";
import { assertDevPublicWorkerBindings } from "../../scripts/deploy-dev-staff-gateway.mjs";
import targetContract from "../../functions/lib/publication-target.js";
import { readFile, writeFile, appendFile, mkdir, lstat, rm, cp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasRetainedDevInput } from "../../.github/scripts/dev-publication-input-artifact.mjs";
import { firebaseAdminRuntime } from "./firebase-admin-runtime.ts";
import { preparePublicArtifactBundle } from "../src/lib/public-artifact-build.ts";
import { assertPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory.ts";
import { preparePublicWorkerArtifact } from "../src/lib/public-worker-artifact.ts";
import { retainCloudPreviewPublicContext } from "./cms-preview-cloud-storage.ts";

import { retryWorkerVersionReceipt, prepareStaticPostProof } from "./upload-public-worker-candidate.ts";
import { findExactRecentWorkerVersion } from "../src/lib/public-worker-version-recovery.ts";
import { publicRouteBaseForRecordKind } from "../../packages/content-core/src/public-record-kinds.ts";

const { initializeApp, applicationDefault, getFirestore, FieldValue } = firebaseAdminRuntime;
const require = createRequire(import.meta.url);
const state = require("../../scripts/lib/dev-publication.cjs");
const publicationTarget = targetContract.publicationTarget("development");
const { publicWorkerCandidateTag, publicWorkerCandidateMessage, workerVersionIdFromWranglerOutput, projectCloudflareWorkerVersion } =
  require("../../functions/lib/public-worker-candidate.js");
const { planPublicWorkerActivationEvidence } = require("../../functions/lib/public-worker-activation.js");
const { verifyNoBuildPostPublicRoute } = require("../../functions/lib/no-build-post-recovery.js");
const { listNoBuildPostOwners } = require("../../functions/lib/no-build-post-ownership.js");
const root = fileURLToPath(new URL("../..", import.meta.url));
const site = path.join(root, "site");
const cloudflareAccount = () => devCloudflareAccount(process.env);
const directory = path.resolve(process.env.CMS_DEV_ARTIFACT_DIRECTORY || path.join(root, "dev-publication"));
const json = async file => JSON.parse(await readFile(file, "utf8"));
const save = (file, data) => writeFile(file, `${JSON.stringify(data)}\n`, { mode: 0o600 });

function target() {
  cloudflareAccount();
  const selected = { environment: process.env.CMS_DEPLOYMENT_ENVIRONMENT,
    projectId: process.env.FIREBASE_PROJECT_ID, workerName: process.env.CLOUDFLARE_DEV_PUBLIC_WORKER,
    origin: process.env.CMS_DEV_PUBLIC_ORIGIN,
    previewBucket: process.env.CMS_DEV_PREVIEW_BUCKET };
  state.assertDevTarget(selected);
  targetContract.assertPublicationTarget({ ...publicationTarget, ...selected });
  if (process.env.FIRESTORE_EMULATOR_HOST ||
      process.env.GOOGLE_CLOUD_PROJECT && process.env.GOOGLE_CLOUD_PROJECT !== state.TARGET.projectId) {
    throw new Error("Development account or Firestore routing differs");
  }
  return selected;
}

async function database() {
  target();
  const credential = await json(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  // Accept only the dedicated publisher's service-account key or OIDC impersonation.
  const principal = "cms-dev-publisher@njpbs-site-dev.iam.gserviceaccount.com";
  if (credential.type === "service_account") {
    if (credential.project_id !== state.TARGET.projectId || credential.client_email !== principal) throw new Error("Invalid dev publisher credential");
  } else if (credential.type !== "external_account" || credential.service_account_impersonation_url !==
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${principal}:generateAccessToken`) {
    throw new Error("Invalid dev publisher OIDC identity");
  }
  const db = getFirestore(initializeApp({ projectId: publicationTarget.projectId, credential: applicationDefault() }, "dev-publisher"));
  targetContract.assertPublicationDatabase(db, publicationTarget);
  return db;
}

async function identity() {
  const queueId = process.env.QUEUE_ID || state.hash(`dev-code-refresh:${process.env.GITHUB_RUN_ID}`).slice(0, 20);
  const value = { queueId, buildBatchId: `cms-${queueId}`, commitSha: process.env.SOURCE_SHA };
  state.assertIdentity(value);
  return value;
}
export async function resolveDevPublicationSource(db, env = process.env) {
  const queueId = env.QUEUE_ID || state.hash(`dev-code-refresh:${env.GITHUB_RUN_ID}`).slice(0, 20);
  const frozenPath = path.join(directory, "frozen.json");
  const frozen = await lstat(frozenPath).then(() => json(frozenPath), () => null);
  return state.selectDevPublicationSource(db, { eventName: env.GITHUB_EVENT_NAME,
    eventSha: env.GITHUB_SHA, queueId, retainedIdentity: frozen?.identity });
}

async function writeDevPublicationSource() {
  if (!process.env.GITHUB_OUTPUT && !process.env.GITHUB_ENV) throw new Error("Dev source output destination is required");
  const sha = await resolveDevPublicationSource(await database());
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `source_sha=${sha}\n`, { mode: 0o600 });
  if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `SOURCE_SHA=${sha}\n`, { mode: 0o600 });
}

function assertFreshDevInputAttempt(env = process.env) {
  if ((env.GITHUB_RUN_ATTEMPT ?? "1") !== "1") {
    throw new Error("Development reruns require retained frozen input; start a new workflow run");
  }
}

export async function inspectDevPublicationRetry(db, env = process.env) {
  const retained = await hasRetainedDevInput({ env });
  if (!retained) {
    throw new Error("Development reruns require retained frozen input; start a new workflow run. Missing retained dev input after reservation requires an owner decision");
  }
  return retained;
}

// Hash every retained input, including committed launch/schedule data. The source
// SHA pins the renderer and all other repository assets for the offline job.
async function inputDigest() {
  const files = ["bundle.json", "schedule.json", "launch.json", "spotlight.json", "post-routes.json"];
  return state.hash(JSON.stringify(await Promise.all(files.map(async name => [name, state.hash(await readFile(path.join(directory, name)))]))));
}

export async function prepare(db) {
  db ??= await database();
  const id = await identity();
  const current = await state.readDevPublication(db, id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await lstat(path.join(directory, "frozen.json")).catch(() => null)) {
    const frozen = await json(path.join(directory, "frozen.json"));
    if (!isDeepStrictEqual(frozen.identity, id) || frozen.inputDigest !== await inputDigest() ||
        current.input?.inputDigest !== frozen.inputDigest) throw new Error("Retained dev input conflicts");
    // Frozen metadata belongs to this generic batch, never another activation journal.
    return;
  }
  if (Number(process.env.GITHUB_RUN_ATTEMPT ?? "1") > 1) state.assertDevPublicationUnreserved(current);
  assertFreshDevInputAttempt();
  if (process.env.GITHUB_EVENT_NAME === "push") {
    if (process.env.GITHUB_REF !== "refs/heads/main") throw new Error("Code refresh requires main");
    const ref = db.collection("cmsPublishQueue").doc(id.queueId);
    await db.runTransaction(async transaction => {
      const [legacy, queue] = await transaction.getAll(db.doc("system/devPublication"), ref);
      if (legacy.exists) throw new Error("The legacy dev publication journal requires its approved drained-state migration");
      if (!queue.exists) transaction.create(ref, {
        status: "pending", transport: "github", environment: "development", projectId: state.TARGET.projectId,
        triggeredBy: "dev-code-refresh", triggeredByEmail: null, triggeredAt: FieldValue.serverTimestamp(),
        completedAt: null, error: null, changes: [], runtime: { owner: "cloudflare", release: id.commitSha },
      });
    });
  }
  try {
    const artifact = await state.reserveDevPublication(db, id);
    if (!artifact) throw new Error("Development queue is already successful");
    const env = { ...process.env, CMS_LOADER_STRICT: "1", CMS_CONTENT_MODE: "published" };
    await preparePublicArtifactBundle({ ...id, batchMode: "reserved", bundlePath: path.join(directory, "bundle.json"),
      outputPath: path.join(directory, "inventory.json") }, new Date(), env);
    const bundle = await json(path.join(directory, "bundle.json"));
    if (!bundle.receipt.families.some(family => family.collection === "cmsPages" &&
        family.artifacts.some(item => item.canonicalPath === "/"))) {
      throw new Error("Published CMS homepage is required for development publication");
    }
    await cp(path.join(site, "src/data/schedule.json"), path.join(directory, "schedule.json"));
    await cp(path.join(site, "src/data/launch-media-manager.json"), path.join(directory, "launch.json"));
    await cp(path.join(site, "src/data/spotlight-news.json"), path.join(directory, "spotlight.json"));
    await save(path.join(directory, "post-routes.json"), await freezeDevPostRoutes(db, id, artifact, bundle.receipt));
    const frozen = { schemaVersion: 1, target: target(), identity: id, inputDigest: await inputDigest(),
      inputSources: { schedule: "reviewed source", launch: "reviewed source", rss: "reviewed source" } };
    await save(path.join(directory, "frozen.json"), frozen);
    await state.recordDevInputs(db, id, frozen.inputDigest);
  } catch (error) {
    await state.finishDevPublication(db, id);
    throw error;
  }
}

async function build() {
  target();
  const frozen = await json(path.join(directory, "frozen.json"));
  if (!isDeepStrictEqual(frozen.identity, await identity()) || frozen.inputDigest !== await inputDigest()) throw new Error("Frozen dev inputs changed");
  const env = { PATH: process.env.PATH, NODE_ENV: "production", TZ: "America/New_York", ASTRO_TELEMETRY_DISABLED: "1",
    CMS_DEPLOYMENT_ENVIRONMENT: "development", CMS_DEV_FROZEN_BUILD: "1", CMS_OFFLINE_BUILD: "1", CMS_CONTENT_MODE: "published", CMS_LOADER_STRICT: "1",
    FIREBASE_PROJECT_ID: publicationTarget.projectId,
    PUBLIC_GA4_REQUIRED: "0", PUBLIC_REPORT_REQUIRED: "0", PUBLIC_SHARE_REQUIRED: "0", INTERNAL_SURFACES: "0",
    PUBLIC_BUILD_BATCH_ID: frozen.identity.buildBatchId, PUBLIC_BUILD_COMMIT_SHA: frozen.identity.commitSha,
    PUBLIC_ARTIFACT_BUNDLE_PATH: path.join(directory, "bundle.json"), PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION: "3",
    PUBLIC_ARTIFACT_INVENTORY_PATH: path.join(directory, "inventory.json"),
    PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH: path.join(directory, "public-context.json"),
    PUBLIC_POST_RENDERER_COMPILE: "1", SCHEDULE_DATA_PATH: path.join(directory, "schedule.json"),
    LAUNCH_CONTENT_DATA_PATH: path.join(directory, "launch.json"), SPOTLIGHT_NEWS_DATA_PATH: path.join(directory, "spotlight.json") };
  // Runs only in the separate secretless Actions job. Network isolation is
  // mandatory; failure to create the namespace is a build failure.
  execFileSync("bwrap", ["--unshare-net", "--die-with-parent", "--ro-bind", "/", "/",
    "--bind", root, root, "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--",
    process.execPath, "--import", "tsx", "scripts/build-with-production-sync.mjs"], { cwd: site, env, stdio: "inherit" });
  if (frozen.inputDigest !== await inputDigest()) throw new Error("Frozen dev inputs changed during build");
  await rm(path.join(site, "dist/wiki"), { recursive: true, force: true });
  await cp(path.join(site, "dist"), path.join(directory, "dist"), { recursive: true });
  await rm(path.join(directory, "renderer"), { recursive: true, force: true });
  await cp(path.join(site, ".public-post-renderer"), path.join(directory, "renderer"), { recursive: true });
  const inventory = assertPublicArtifactInventoryReceipt(await json(path.join(directory, "inventory.json")));
  await preparePublicWorkerArtifact({ artifactReceipt: inventory, distDirectory: path.join(directory, "dist"),
    outputPath: path.join(directory, "publication.json") });
}

// The upload job restores the exact server graph from the secretless build.
// Reconciliation checks and reuses it; neither path can compile a new renderer.
export async function restoreDevPostRenderer(sourceSha, artifactDirectory = directory, siteDirectory = site) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? "")) throw new Error("Invalid dev renderer source");
  const retained = path.join(artifactDirectory, "renderer");
  const seal = await json(path.join(retained, "renderer-release.json"));
  const clientSeal = await json(path.join(artifactDirectory, "dist/posts/_no-build-assets/renderer-release.json"));
  if (![1, 2].includes(seal?.electionResultsVersion) ||
      !isDeepStrictEqual(seal, { schemaVersion: 1, rendererSha: sourceSha, liveBlogVersion: 1,
      ...(seal.pageReaderVersion === 1 ? { pageReaderVersion: 1 } : {}),
      electionResultsVersion: seal.electionResultsVersion, environment: "development" }) ||
      !isDeepStrictEqual(clientSeal, seal) ||
      !(await lstat(path.join(retained, "server/entry.mjs"))).isFile()) {
    throw new Error("Retained dev renderer source differs");
  }
  const destination = path.join(siteDirectory, ".public-post-renderer");
  await rm(destination, { recursive: true, force: true });
  await cp(retained, destination, { recursive: true });
}

async function retainContext(db, publication) {
  target();
  const credential = JSON.parse(process.env.CMS_DEV_PREVIEW_R2_CREDENTIAL || "null");
  if (!credential?.accessKeyId || !credential?.secretAccessKey) throw new Error("Dev preview storage credential is required");
  await retainCloudPreviewPublicContext({ firestore: db, publication,
    file: path.join(directory, "public-context.json"), bucket: state.TARGET.previewBucket,
    deploymentEnvironment: "development", accessKeyId: credential.accessKeyId, secretAccessKey: credential.secretAccessKey });
}

const workerPath = `/workers/scripts/${state.TARGET.workerName}`;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

async function cloudflareApi(pathname, method = "GET", data) {
  let response, body;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
      method, headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      ...(data ? { body: JSON.stringify(data) } : {}), redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    body = await response.json();
  } catch { throw new Error("Development Worker request failed; reconcile before retrying"); }
  if (!response.ok || body.success !== true) throw new Error("Development Worker request refused; reconcile before retrying");
  return body.result;
}

function cloudflare(pathname, method = "GET", data) {
  return cloudflareApi(`/accounts/${cloudflareAccount()}${workerPath}${pathname}`, method, data);
}

function verifyPrivateWorker() {
  return verifyDevPublicWorkerPrivate(cloudflareApi);
}

export async function verifyVersion(versionId, publication) {
  if (!UUID.test(versionId ?? "")) throw new Error("Development Worker candidate is missing; reconcile with retained evidence");
  const version = await cloudflare(`/versions/${versionId}`);
  const runtime = version?.resources?.script_runtime;
  const assets = runtime?.assets?.config ?? runtime?.assets;
  // Version receipts expose the uploaded setting as raw_run_worker_first.
  const workerFirst = assets?.run_worker_first ?? assets?.raw_run_worker_first;
  assertDevPublicWorkerBindings(version?.resources?.bindings, publication.commitSha);
  if (version?.id !== versionId || version.metadata?.source !== "wrangler" ||
      version.annotations?.["workers/tag"] !== publicWorkerCandidateTag(publication) ||
      version.annotations?.["workers/message"] !== publicWorkerCandidateMessage(publication) ||
      version.annotations?.["workers/triggered_by"] !== "version_upload" ||
      workerFirst !== true || assets?.html_handling !== "force-trailing-slash" ||
      assets?.not_found_handling !== "404-page") throw new Error("Development Worker candidate differs");
  const projected = projectCloudflareWorkerVersion(version, { target: publicationTarget,
    tag: publicWorkerCandidateTag(publication), message: publicWorkerCandidateMessage(publication) });
  if (projected.noBuildPost?.schemaVersion !== 2 || projected.noBuildPost.rendererSha !== publication.commitSha) {
    throw new Error("Development Worker lacks its Post family capability");
  }
  return projected;
}

async function activeDeployment(versionId) {
  const active = (await cloudflare("/deployments"))?.deployments?.[0];
  if (!UUID.test(active?.id ?? "") || active.strategy !== "percentage" || active.source !== "api" ||
      !isDeepStrictEqual(active.versions, [{ version_id: versionId, percentage: 100 }])) {
    throw new Error("Active development Worker identity differs");
  }
  return active;
}

async function assertDevWorkerConfig() {
  target();
  const config = await json(path.join(root, "workers/wrangler.public.dev.jsonc"));
  if (config.name !== state.TARGET.workerName || config.main !== "src/dev-public-worker.ts" ||
      config.workers_dev !== false || config.preview_urls !== false ||
      !isDeepStrictEqual(config.routes, []) ||
      !isDeepStrictEqual(config.services, [{ binding: "CMS_API", service: "template-dev-cms-api", entrypoint: "PublicContentEntrypoint" }]) ||
      !isDeepStrictEqual(config.vars, { NO_BUILD_POST_RENDERER_SHA: "", NO_BUILD_PAGE_RENDERER_SHA: "", DATA_FIGURE_VERSION: "", ELECTION_RESULTS_VERSION: "" }) ||
      !isDeepStrictEqual(config.assets, { directory: "../dev-publication/dist", binding: "ASSETS",
        run_worker_first: true, html_handling: "force-trailing-slash", not_found_handling: "404-page" })) {
    throw new Error("Development public Worker config differs");
  }
}

async function uploadCandidate(publication) {
  // Keep provider diagnostics private: child errors can contain environment details.
  let output;
  try {
    output = execFileSync(path.join(root, "node_modules/.bin/wrangler"), ["versions", "upload",
      "--config", path.join(root, "workers/wrangler.public.dev.jsonc"), "--assets", path.join(directory, "dist"),
      "--var", `NO_BUILD_POST_RENDERER_SHA:${publication.commitSha}`,
      "--var", `NO_BUILD_PAGE_RENDERER_SHA:${publication.commitSha}`,
      "--var", `NO_BUILD_RECORD_RENDERER_SHA:${publication.commitSha}`,
      "--var", "DATA_FIGURE_VERSION:1", "--var", "ELECTION_RESULTS_VERSION:2",
      "--tag", publicWorkerCandidateTag(publication), "--message", publicWorkerCandidateMessage(publication), "--strict"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CLOUDFLARE_ACCOUNT_ID: cloudflareAccount(),
        CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, WRANGLER_SEND_METRICS: "false" },
    });
  } catch { throw new Error("Development Worker upload failed; reconcile before retrying"); }
  return workerVersionIdFromWranglerOutput(output);
}

class DevReadbackError extends Error {
  constructor(pathname, status, reason, retryable = true, details = {}) {
    super(`Development readback ${pathname}: HTTP ${status}, ${reason}`);
    this.status = status;
    this.retryable = retryable;
    Object.assign(this, details);
  }
}

function devGatewayTimings(response) {
  const timings = {};
  for (const part of (response.headers.get("server-timing") ?? "").slice(0, 2048).split(",")) {
    const match = /^\s*(staff-access|staff-admission|staff-origin);dur=(\d+(?:\.\d+)?)\s*$/.exec(part);
    if (match && Number(match[2]) <= 60_000) timings[match[1]] = Number(match[2]);
  }
  return timings;
}

async function devRefusal(response) {
  const known = new Map([
    ["Post unavailable", "public-worker-unavailable"],
    ["Site configuration unavailable", "gateway-configuration-unavailable"],
    ["Site access unavailable", "gateway-access-unavailable"],
  ]);
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  try {
    if (response.status === 503 && reader) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          const body = Buffer.concat(chunks).toString("utf8");
          if (known.has(body)) return { refusalClass: known.get(body), responseBody: body };
          break;
        }
        size += value.length;
        if (size > 128) break;
        chunks.push(Buffer.from(value));
      }
    }
  } catch { /* Unknown or incomplete bodies must not enter logs. */ }
  finally { await reader?.cancel().catch(() => {}); }
  return { refusalClass: `http-${response.status}`, responseBody: null };
}

async function fetchDev(pathname) {
  if (!process.env.CMS_DEV_ACCESS_CLIENT_ID || !process.env.CMS_DEV_ACCESS_CLIENT_SECRET) throw new Error("Dev Access credentials are required");
  const url = new URL(pathname, state.TARGET.origin);
  if (url.origin !== publicationTarget.origin || url.username || url.password) throw new Error("Development readback target differs");
  let response;
  try {
    response = await fetch(url, { redirect: "manual", cache: "no-store",
      headers: { "CF-Access-Client-Id": process.env.CMS_DEV_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": process.env.CMS_DEV_ACCESS_CLIENT_SECRET }, signal: AbortSignal.timeout(30_000) });
  } catch { throw new DevReadbackError(pathname, "unavailable", "request failed"); }
  if (![200, 404, 410].includes(response.status)) {
    const refusal = await devRefusal(response);
    const reason = `response refused: ${refusal.refusalClass}${refusal.responseBody ? ` (${refusal.responseBody})` : ""}`;
    throw new DevReadbackError(pathname, response.status, reason,
      [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526].includes(response.status),
      { ...refusal, gatewayTimings: devGatewayTimings(response) });
  }
  return response;
}

async function readDev(pathname, asBytes = false) {
  const response = await fetchDev(pathname);
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new DevReadbackError(pathname, response.status, "expected published content");
  }
  try { return asBytes ? Buffer.from(await response.arrayBuffer()) : await response.json(); }
  catch { throw new DevReadbackError(pathname, response.status, "body could not be read"); }
}

// The same cutoff as the artifact prevents a later republish or deletion from
// changing withdrawal verification and leaving an otherwise valid lease stuck.
export async function freezeDevPostRoutes(db, id, reservation, inventory) {
  return db.runTransaction(async transaction => {
    const queue = state.assertDevQueue((await transaction.get(db.collection("cmsPublishQueue").doc(id.queueId))).data());
    const posts = inventory.families.find(family => family.collection === "cmsPosts").artifacts;
    const checks = [];
    for (const change of queue.changes.filter(item => item.collection === "cmsPosts")) {
      const artifact = posts.find(item => item.documentId === change.id);
      let routes;
      const removed = change.operation === "withdraw";
      if (removed) {
        const document = (await transaction.get(db.collection("cmsPosts").doc(change.id))).data();
        const published = document?.published;
        const metadata = published?.metadata;
        const base = publicRouteBaseForRecordKind(metadata?.type);
        if (artifact || document?.publiclyVisible !== false || published?.sourceVersion !== change.sourceVersion) {
          throw new Error("Development Post withdrawal input differs");
        }
        if (["sponsor", "newsletter"].includes(metadata?.type)) continue;
        if (!base || !Array.isArray(metadata.previousSlugs) ||
            [metadata.slug, ...metadata.previousSlugs].some(slug => typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))) {
          throw new Error("Development Post withdrawal input differs");
        }
        routes = [...new Set([metadata.slug, ...metadata.previousSlugs])].map(slug => `${base}${slug}/`);
      } else {
        if (artifact?.sourceVersion !== change.sourceVersion) throw new Error("Development Post publication input differs");
        routes = artifact.canonicalPath ? [artifact.canonicalPath, ...artifact.aliases] : [];
      }
      checks.push(...routes.map(route => ({ route, removed })));
    }
    return checks;
  }, { readOnly: true, readTime: reservation.cutoffAt });
}

export async function verifyDevPostRoutes(ownedPaths = new Set()) {
  const checks = await json(path.join(directory, "post-routes.json"));
  for (const { route, removed } of checks) {
    // Validate even retained paths before sending the publisher Access identity.
    if (typeof removed !== "boolean" || !/^\/(?:posts|programs|events)\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(route)) {
      throw new Error("Development Post route is invalid");
    }
    // Owned routes have their fresh authority proof, separate from frozen Assets.
    if (ownedPaths.has(route)) continue;
    if (removed) {
      const response = await fetchDev(route);
      await response.body?.cancel();
      if (![404, 410].includes(response.status)) throw new DevReadbackError(route, response.status, "Post withdrawal is unconfirmed");
    } else {
      const expected = await readFile(path.join(directory, "dist", route, "index.html"));
      if (!(await readDev(route, true)).equals(expected)) {
        throw new DevReadbackError(route, 200, "Post bytes differ");
      }
    }
  }
}

export async function verifyDevReadback(versionId, deploymentId, publication, { retry = true, timedOutRecovery = false } = {}) {
  const expected = await readFile(path.join(directory, "dist/_publication.json"));
  if (state.hash(expected) !== publication.publicationReceiptDigest) throw new Error("Development baseline receipt bytes changed");
  const probe = new URL("/_publication.json", publicationTarget.origin);
  probe.searchParams.set("candidate", publication.buildBatchId);
  probe.searchParams.set("version", versionId);
  // Retry only gateway readback. Upload and the single activation claim stay outside this loop.
  const delays = timedOutRecovery ? [1000, 1000] : [1000, 2000, 4000, 8000, 15000, 30000];
  for (let attempt = 0; ; attempt += 1) {
    if ((await activeDeployment(versionId)).id !== deploymentId) throw new Error("Development Worker changed during verification");
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let response;
    const record = (outcome, error) => {
      if (!timedOutRecovery) return;
      console.warn(JSON.stringify({ event: "Dev recovery readback", attempt: attempt + 1, startedAt,
        durationMs: Math.round(performance.now() - started), outcome, status: error?.status ?? response?.status ?? "unavailable",
        refusalClass: error?.refusalClass ?? null, responseBody: error?.responseBody ?? null,
        gatewayTimings: error?.gatewayTimings ?? (response ? devGatewayTimings(response) : {}),
        unavailableHops: ["gatewayEnvironment", "apiGetDecision", "function"],
      }));
    };
    try {
      response = await fetchDev(probe.toString());
      if (response.status !== 200 || response.headers.get("x-njpbs-publication-origin") !== publicationTarget.workerName) {
        await response.body?.cancel();
        throw new DevReadbackError("/_publication.json", response.status, "baseline origin differs");
      }
      if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
        await response.body?.cancel();
        throw new DevReadbackError("/_publication.json", 200, "baseline content type differs");
      }
      const chunks = [];
      let size = 0;
      const reader = response.body?.getReader();
      try {
        if (reader) {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > expected.length) throw new DevReadbackError("/_publication.json", 200, "publication receipt differs");
            chunks.push(Buffer.from(value));
          }
        }
      } catch (error) {
        if (error instanceof DevReadbackError) throw error;
        throw new DevReadbackError("/_publication.json", 200, "body could not be read");
      } finally { await reader?.cancel(); }
      const actual = Buffer.concat(chunks);
      if (!actual.equals(expected)) throw new DevReadbackError("/_publication.json", 200, "publication receipt differs");
      if ((await activeDeployment(versionId)).id !== deploymentId) throw new Error("Development Worker changed during verification");
      record("verified");
      return;
    } catch (error) {
      record("refused", error);
      if (timedOutRecovery && error.status !== 503) throw error;
      if (!retry || !(error instanceof DevReadbackError) || !error.retryable || attempt === delays.length) throw error;
      console.warn(`${error.message}; retrying in ${delays[attempt]} ms`);
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

function reconciliationInput(id, current, inventory, recovery) {
  return { identity: id, inventory, batch: current.batch, candidate: current.candidate, queue: current.queue, input: current.input,
    generation: recovery.generation, workerVersionId: recovery.workerVersionId };
}

// Ordinary development uploads retain their existing prepare/claim/activate
// path. Timeout recovery never calls this provider-writing boundary.
async function prepareDevCandidateAndLease({ db, id, current, inventory, publication, version, inputDigest }) {
  let wranglerVersion;
  try {
    wranglerVersion = execFileSync(path.join(root, "node_modules/.bin/wrangler"), ["--version"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, WRANGLER_SEND_METRICS: "false" },
    }).trim();
  } catch { throw new Error("Development Wrangler version could not be verified"); }
  const staticProof = current.batch.noBuildStaticInput === undefined ? undefined :
    await prepareStaticPostProof({ input: current.batch.noBuildStaticInput, artifact: inventory,
      prepared: publication, distDirectory: path.join(directory, "dist") });
  const candidate = await state.recordDevCandidate(db, id, { inventory, publication, version,
    wranglerVersion, inputDigest, staticProof });
  const rendererSeal = await json(path.join(directory, "dist/posts/_no-build-assets/renderer-release.json"));
  if (rendererSeal.rendererSha !== candidate.commitSha) throw new Error("Development Page reader source differs");
  await db.runTransaction(async transaction => {
    const write = await require("../../functions/lib/page-reader-compatibility.js").preparePageReaderMarker({
      firestore: db, transaction, role: "public", rendererSha: candidate.commitSha, version: rendererSeal.pageReaderVersion });
    write();
  });
  await verifyPrivateWorker();
  const acquisition = await state.acquireDevDeploymentLease(db, id);
  if (acquisition.outcome !== "acquired") throw new Error("The generic dev deployment lease is " + acquisition.outcome);
  if (!acquisition.idempotent) {
    try {
      await cloudflare("/deployments", "POST", { strategy: "percentage",
        versions: [{ version_id: candidate.workerVersionId, percentage: 100 }] });
    } catch { /* Exact active evidence decides the outcome of an uncertain response. */ }
  }
  return { candidate, lease: acquisition.lease };
}

async function finishConfirmedDevPublication(db, id, options) {
  const outcome = await state.finishDevPublication(db, id, options);
  if (outcome !== "success") throw new Error("Development queue remains unconfirmed; use the original timeout recovery");
  return outcome;
}

export async function upload(db, id, reconcileOnly = false, recovery = null) {
  target();
  state.assertDevDatabase(db);
  const current = await state.readDevPublication(db, id);
  if (!current.queue || !current.batch) throw new Error("The generic dev reservation is missing");
  const timedOutRecovery = current.queue.status === "failed";
  if (timedOutRecovery && (!reconcileOnly || !recovery)) throw new Error("Dev timeout recovery requires explicit retained inputs");
  if (!timedOutRecovery && current.batch.status === "deployed") return finishConfirmedDevPublication(db, id);
  try {
    const api = await json(path.join(root, "cms-api/wrangler.dev.jsonc"));
    const rendererSourceSha = process.env.CMS_DEV_RENDERER_SOURCE_SHA;
    const rendererNotDeployed = api.services === undefined && !rendererSourceSha;
    if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CMS_DEV_ACCESS_CLIENT_ID || !process.env.CMS_DEV_ACCESS_CLIENT_SECRET ||
        [process.env.CMS_DEV_CMS_SOURCE_SHA, process.env.CMS_DEV_ADMIN_SOURCE_SHA].some(value => !/^[a-f0-9]{40}$/.test(value ?? "")) ||
        !rendererNotDeployed && !/^[a-f0-9]{40}$/.test(rendererSourceSha ?? "")) {
      throw new Error("Dev upload credentials and component receipts are required");
    }
    const frozen = await json(path.join(directory, "frozen.json"));
    state.assertDevTarget(frozen.target);
    if (!isDeepStrictEqual(frozen.identity, id) || frozen.inputDigest !== await inputDigest() ||
        current.input?.inputDigest !== frozen.inputDigest) throw new Error("Dev input differs");
    const inventory = assertPublicArtifactInventoryReceipt(await json(path.join(directory, "inventory.json")));
    const publication = await json(path.join(directory, "publication.json"));
    const retainedLease = timedOutRecovery ? state.prepareTimedOutDevReconciliation({
      ...reconciliationInput(id, current, inventory, recovery), publication }) : null;
    await restoreDevPostRenderer(id.commitSha);
    const rebuilt = await preparePublicWorkerArtifact({ artifactReceipt: inventory, distDirectory: path.join(directory, "dist"),
      outputPath: path.join(directory, "checked-publication.json") });
    if (!isDeepStrictEqual(rebuilt, publication)) throw new Error("Development artifact bytes changed");
    await assertDevWorkerConfig();
    await verifyPrivateWorker();
    if (!timedOutRecovery) await retainContext(db, JSON.parse(await readFile(path.join(directory, "dist/_publication.json"), "utf8")));

    let versionId = current.candidate?.workerVersionId ?? process.env.DEV_RECONCILE_WORKER_VERSION_ID;
    const recovering = reconcileOnly || Number(process.env.GITHUB_RUN_ATTEMPT ?? 1) > 1 ||
      current.batch.status !== "reserved";
    if (!timedOutRecovery && !versionId) {
      const find = async () => {
        const versions = await cloudflare("/versions");
        return findExactRecentWorkerVersion(versions?.items, publicWorkerCandidateTag(publication),
          publicWorkerCandidateMessage(publication));
      };
      if (recovering) {
        versionId = await retryWorkerVersionReceipt(async () => {
          const found = await find();
          if (!found) throw new Error("Development candidate not found; retain the generic batch for reconciliation");
          return found;
        });
      } else {
        versionId = await find() ?? await uploadCandidate(publication);
      }
    }
    const version = timedOutRecovery ? await verifyVersion(versionId, publication)
      : await retryWorkerVersionReceipt(() => verifyVersion(versionId, publication));
    let candidate, lease;
    if (timedOutRecovery) {
      candidate = current.candidate;
      if (["workerVersionId", "versionCreatedOn", "noBuildPost", "noBuildPage", "noBuildRecord"]
          .some(key => !isDeepStrictEqual(candidate[key], version[key]))) throw new Error("Retained development provider identity differs");
      lease = retainedLease;
    } else {
      const prepared = await prepareDevCandidateAndLease({ db, id, current, inventory, publication, version, inputDigest: frozen.inputDigest });
      candidate = prepared.candidate;
      lease = prepared.lease;
    }
    const active = await activeDeployment(candidate.workerVersionId);
    const evidence = planPublicWorkerActivationEvidence({ lease, candidate, deploymentStatus: active, deploymentSource: "api", target: publicationTarget });
    if (evidence.action !== "activate") throw new Error("The generic dev candidate activation is unconfirmed");
    await verifyDevReadback(candidate.workerVersionId, active.id, publication, { timedOutRecovery });
    const owners = await listNoBuildPostOwners({ firestore: db });
    const ownedPaths = new Set(owners.flatMap(({ state: owner }) => owner.ownedSlugs.map(slug => "/posts/" + slug + "/")));
    await verifyDevPostRoutes(ownedPaths);
    await verifyNoBuildPostPublicRoute({ firestore: db, candidate, target: publicationTarget,
      headers: { "cf-access-client-id": process.env.CMS_DEV_ACCESS_CLIENT_ID,
        "cf-access-client-secret": process.env.CMS_DEV_ACCESS_CLIENT_SECRET } });
    await verifyPrivateWorker();
    if ((await activeDeployment(candidate.workerVersionId)).id !== active.id) {
      throw new Error("Development Worker changed during verification");
    }
    const outcome = await state.settleDevDeploymentOutcome(db, id, lease, evidence);
    if (outcome.outcome !== "deployed") throw new Error("The generic dev outcome is " + outcome.outcome);
    if (timedOutRecovery) state.assertDevReconcileInputs({
      ...reconciliationInput(id, await state.readDevPublication(db, id), inventory, recovery), outcome: outcome.receipt });
    await finishConfirmedDevPublication(db, id, timedOutRecovery ? { timeoutOutcome: outcome.receipt } : undefined);
    const deployment = { target: target(), workerDeploymentId: active.id, workerVersionId: candidate.workerVersionId,
      buildBatchId: id.buildBatchId, commitSha: id.commitSha, artifactDigest: publication.artifactDigest,
      verifiedAtMs: Date.now(), genericOutcome: outcome.receipt,
      cmsSourceSha: process.env.CMS_DEV_CMS_SOURCE_SHA, adminSourceSha: process.env.CMS_DEV_ADMIN_SOURCE_SHA,
      ...(rendererNotDeployed ? { renderer: "not deployed" } : { rendererSourceSha }) };
    await save(path.join(directory, "deployment.json"), deployment);
    return "success";
  } catch (error) {
    if (!timedOutRecovery) await state.finishDevPublication(db, id);
    throw error;
  }
}

async function main() {
  const command = process.argv[2];
  if (command === "source") return writeDevPublicationSource();
  if (command === "inspect-retry") {
    if (!process.env.GITHUB_OUTPUT) throw new Error("Dev retry output destination is required");
    const retained = await inspectDevPublicationRetry(await database());
    return appendFile(process.env.GITHUB_OUTPUT, `exists=${retained}\n`, { mode: 0o600 });
  }
  if (command === "prepare") return prepare();
  if (command === "build") return build();
  if (command === "upload") return upload(await database(), await identity());
  if (command === "reconcile") {
    if (process.env.CMS_DEV_PUBLISH_ENABLED !== "false") throw new Error("Hold dev writers before reconciliation");
    const db = await database();
    const id = await identity();
    const inventory = await json(path.join(directory, "inventory.json"));
    const current = await state.readDevPublication(db, id);
    const recovery = { generation: Number(process.env.DEV_RECONCILE_GENERATION), workerVersionId: process.env.DEV_RECONCILE_WORKER_VERSION_ID };
    if (current.queue?.status !== "failed") state.assertDevReconcileInputs(reconciliationInput(id, current, inventory, recovery));
    return upload(db, id, true, recovery);
  }
  if (command === "fail") return state.finishDevPublication(await database(), await identity());
  throw new Error("Expected source, inspect-retry, prepare, build, upload, reconcile or fail");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
