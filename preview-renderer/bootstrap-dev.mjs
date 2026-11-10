import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { prepareDevPreviewRenderer } from "../scripts/prepare-preview-renderer.mjs";
import { readConsistentRendererApplication } from "../scripts/lib/cms-component-receipt.mjs";
import { assertDevRendererReleaseSource, devRendererReleaseMode } from "../scripts/lib/dev-renderer-release-source.mjs";
import { firebaseAdminRuntime } from "../site/scripts/firebase-admin-runtime.ts";
import { previewRuntimeDrained } from "../site/scripts/cms-preview-cloud-control.ts";
import { cloudflare as configuredCloudflare, collectDevRendererIdentity,
  parseDevPreviewReleaseInputs, waitFor, wrangler } from "./deploy-dev.mjs";

const cloudflare = (token, suffix, request) => configuredCloudflare(token, suffix, request, ACCOUNT);

const require = createRequire(import.meta.url);
const owner = require("../functions/lib/dev-preview-renderer-bootstrap.js");
const WORKER = "template-dev-cms-preview-renderer";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const repository = fileURLToPath(new URL("..", import.meta.url));
const refuse = () => { throw new Error("Development renderer bootstrap refused"); };

export function immutableDevRendererImage(configuration) {
  const image = configuration?.image;
  if (typeof image !== "string" ||
      !/^registry\.cloudflare\.com\/[A-Za-z0-9_./:@-]+$/.test(image)) refuse();
  const digest = image.includes("@sha256:") ? image.split("@")[1] : configuration.image_digest;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) refuse();
  if (configuration.image_digest != null && configuration.image_digest !== digest) refuse();
  const name = image.split("@")[0].replace(/:[^/:]+$/, "");
  if (name !== `registry.cloudflare.com/${ACCOUNT}/${WORKER}`) refuse();
  return `${name}@${digest}`;
}

async function workerVersion(token, request) {
  const deployments = await cloudflare(token, `workers/scripts/${WORKER}/deployments`, request);
  const current = (deployments.deployments ?? deployments)[0];
  if (!UUID.test(current?.id) || current.versions?.length !== 1 || current.versions[0].percentage !== 100 ||
      !UUID.test(current.versions[0].version_id)) refuse();
  const version = await cloudflare(token, `workers/scripts/${WORKER}/versions/${current.versions[0].version_id}`, request);
  if (version.id !== current.versions[0].version_id || !Array.isArray(version.resources?.bindings)) refuse();
  return { deploymentId: current.id, version };
}

function assertPausedWorker(version, rendererSha, operationId) {
  if (version.annotations?.["workers/tag"] !== rendererSha || version.annotations?.["workers/message"] !== operationId) refuse();
  for (const [name, text] of Object.entries({ PREVIEW_RENDERER_ENABLED: "false", PREVIEW_RENDERER_SHA: rendererSha,
    PREVIEW_SERIALIZER_ID: "cloudflare-preview", CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev" })) {
    const matches = version.resources.bindings.filter(binding => binding.name === name);
    if (matches.length !== 1 || matches[0].type !== "plain_text" || matches[0].text !== text) refuse();
  }
  const names = new Set(version.resources.bindings.filter(binding => binding.type === "secret_text").map(binding => binding.name));
  if (!["FIREBASE_SERVICE_ACCOUNT", "R2_PREVIEW_CREDENTIAL", "CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET"].every(name => names.has(name))) refuse();
}

function boundRollout(application, rollout) {
  if (!UUID.test(rollout?.id) || !["pending", "progressing", "completed"].includes(rollout.status) ||
      application.active_rollout_id !== rollout.id && !(application.active_rollout_id == null && rollout.status === "completed")) refuse();
  const bound = ["current", "target"].some(side => application.version === rollout[`${side}_version`] &&
    application.configuration?.image === rollout[`${side}_configuration`]?.image);
  if (!bound) refuse();
}

/** A disabled renderer seals configured image identity, never running-instance health. */
export async function collectPausedDevRenderer(token, attempt, { restoring = false, allowPriorImage = false, request = fetch } = {}) {
  const rendererSha = restoring ? attempt.prior.preview.rendererSha : attempt.rendererSha;
  const current = await workerVersion(token, request);
  assertPausedWorker(current.version, rendererSha, attempt.operationId);
  const app = await cloudflare(token, `containers/applications/${attempt.prior.provider.applicationId}`, request);
  if (app.id !== attempt.prior.provider.applicationId || app.name !== WORKER) refuse();
  const result = await cloudflare(token, `containers/applications/${app.id}/rollouts?per_page=100&page=1`, request);
  const rollouts = Array.isArray(result) ? result : result.rollouts;
  if (!Array.isArray(rollouts) || rollouts.length >= 100) refuse();
  const times = rollouts.map(row => ({ row, time: Date.parse(row.created_at) }));
  if (times.some(row => !Number.isFinite(row.time))) refuse();
  const latest = times.sort((left, right) => right.time - left.time)[0];
  let configuration = app.configuration, rolloutId = null;
  const fresh = latest && latest.time >= Date.parse(attempt.startedAt);
  if (latest) {
    boundRollout(app, latest.row);
    configuration = latest.row.target_configuration;
    rolloutId = latest.row.id;
  }
  const image = immutableDevRendererImage(configuration);
  if (!fresh && !restoring && image !== attempt.prior.image) refuse();
  if (!fresh && !restoring && rendererSha !== attempt.prior.preview.rendererSha &&
      !(allowPriorImage && image === attempt.prior.image)) refuse();
  return { worker: WORKER, workerDeploymentId: current.deploymentId, workerVersionId: current.version.id,
    applicationId: app.id, rendererSha, serializerId: "cloudflare-preview", enabled: false,
    image, imageFingerprint: createHash("sha256").update(JSON.stringify({ image, digest: null })).digest("hex"), imageState: "configured",
    rolloutId, operationId: attempt.operationId };
}

async function priorProvider(firestore, inputs, snapshot, request) {
  const rendererSha = snapshot.preview.rendererSha;
  const component = snapshot.component;
  if (component?.state !== "complete" || component.sourceSha !== rendererSha || component.projectId !== "njpbs-site-dev") refuse();
  const provider = await collectDevRendererIdentity(inputs.token, rendererSha, request, { releaseStartedAt: component.releaseStartedAt });
  if (!isDeepStrictEqual(provider, component.provider)) refuse();
  const app = await readConsistentRendererApplication(request, ACCOUNT, inputs.token, {
    rendererSha, applicationName: WORKER,
    rendererRelease: { mutation: { sourceSha: rendererSha, releaseStartedAt: component.releaseStartedAt } },
  });
  const fingerprint = createHash("sha256").update(JSON.stringify({ image: app.configuration?.image ?? app.image ?? null,
    digest: app.configuration?.image_digest ?? app.digest ?? null })).digest("hex");
  if (app.id !== provider.applicationId || fingerprint !== provider.imageFingerprint || !await previewRuntimeDrained(firestore)) refuse();
  return { provider, image: immutableDevRendererImage(app.configuration), component, preview: snapshot.preview };
}

async function oldPreparedSource(attempt, environment) {
  execFileSync("/usr/bin/git", ["merge-base", "--is-ancestor", attempt.prior.preview.rendererSha, environment.GITHUB_SHA], {
    cwd: repository, stdio: "ignore", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  const prepared = await prepareDevPreviewRenderer(attempt.prior.preview.rendererSha);
  const config = JSON.parse(await readFile(prepared.configPath, "utf8"));
  config.containers[0].image = attempt.prior.image;
  delete config.containers[0].image_build_context;
  await writeFile(prepared.configPath, `${JSON.stringify(config, null, 2)}\n`);
  return prepared;
}

async function requireOwnedProvider(inputs, saved, request, allowOriginal = true) {
  const current = await workerVersion(inputs.token, request);
  if (current.version.id === saved.attempt.prior.provider.workerVersionId) {
    if (!allowOriginal) refuse();
    const prior = await collectDevRendererIdentity(inputs.token, saved.attempt.prior.preview.rendererSha, request,
      { releaseStartedAt: saved.attempt.prior.component.releaseStartedAt });
    if (!isDeepStrictEqual(prior, saved.attempt.prior.provider)) refuse();
    return;
  }
  const source = current.version.annotations?.["workers/tag"];
  if (![saved.attempt.rendererSha, saved.attempt.prior.preview.rendererSha].includes(source)) refuse();
  assertPausedWorker(current.version, source, saved.attempt.operationId);
}

async function prepareRestore(firestore, inputs, original, request) {
  let saved = await owner.guardDevPreviewBootstrap({ firestore, attemptDigest: original.attemptDigest });
  if (!await previewRuntimeDrained(firestore)) refuse();
  const current = await workerVersion(inputs.token, request);
  if (current.version.id === saved.attempt.prior.provider.workerVersionId) {
    await requireOwnedProvider(inputs, saved, request);
    return { saved, complete: false };
  }
  const source = current.version.annotations?.["workers/tag"];
  if (![saved.attempt.rendererSha, saved.attempt.prior.preview.rendererSha].includes(source)) refuse();
  assertPausedWorker(current.version, source, saved.attempt.operationId);
  const restoring = source === saved.attempt.prior.preview.rendererSha;
  const provider = await collectPausedDevRenderer(inputs.token, saved.attempt, {
    restoring: source !== saved.attempt.rendererSha, allowPriorImage: true, request });
  if (restoring && provider.image === saved.attempt.prior.image) {
    return { saved: await owner.finishDevPreviewBootstrap({ firestore, attemptDigest: saved.attemptDigest, provider, restore: true }), complete: true };
  }
  let binding = saved.receipt?.provider ?? saved.recoveryProvider;
  if (!binding) {
    if (source !== saved.attempt.rendererSha) refuse();
    saved = await owner.bindDevPreviewBootstrapRecovery({ firestore, attemptDigest: saved.attemptDigest, provider });
    binding = saved.recoveryProvider;
  }
  // The replacement Worker must still match its sealed outcome. A partial
  // restore may change Worker UUIDs, but may not introduce a different image.
  if (restoring ? provider.image !== binding.image : !isDeepStrictEqual(provider, binding)) refuse();
  return { saved, complete: false };
}

async function restore(firestore, inputs, original, prepared, request, spawnProcess) {
  const { saved, complete } = await prepareRestore(firestore, inputs, original, request);
  if (complete) return saved;
  await wrangler(prepared, ["deploy", "--tag", saved.attempt.prior.preview.rendererSha, "--message", saved.attempt.operationId], inputs.token, ACCOUNT, undefined, spawnProcess);
  const provider = await collectPausedDevRenderer(inputs.token, saved.attempt, { restoring: true, request });
  return owner.finishDevPreviewBootstrap({ firestore, attemptDigest: saved.attemptDigest, provider, restore: true });
}

export async function restoreDevPreviewBootstrap({ firestore, inputs, environment, request = fetch, spawnProcess }) {
  const saved = await owner.guardDevPreviewBootstrap({ firestore });
  if (saved.attempt.rendererSha !== inputs.rendererSha) refuse();
  if (saved.status === "restored-paused") {
    const provider = await collectPausedDevRenderer(inputs.token, saved.attempt, { restoring: true, request });
    if (!isDeepStrictEqual(provider, saved.receipt.provider)) refuse();
    return saved;
  }
  const prepared = await oldPreparedSource(saved.attempt, environment);
  try { return await restore(firestore, inputs, saved, prepared, request, spawnProcess); }
  finally { await rm(prepared.directory, { recursive: true, force: true }); }
}

export async function bootstrapDevPreview({ firestore, inputs, provenance, environment, request = fetch, spawnProcess }) {
  if (firestore?.projectId !== "njpbs-site-dev" || !/^[1-9][0-9]*$/.test(environment.GITHUB_RUN_ID ?? "")) refuse();
  const snapshot = await owner.inspectDevPreviewBootstrap({ firestore, rendererSha: inputs.rendererSha });
  const prior = await priorProvider(firestore, inputs, snapshot, request);
  const attempt = { schemaVersion: 1, operationId: `dev-renderer-${environment.GITHUB_RUN_ID}`,
    rendererSha: inputs.rendererSha, operatorCommitSha: provenance.operatorCommitSha, provenance,
    bootstrapOperationId: snapshot.bootstrapOperationId, publicDigest: snapshot.publicDigest,
    startedAt: new Date().toISOString(), prior };
  let saved, prepared, oldPrepared, phase = "source-preparation";
  try {
    oldPrepared = await oldPreparedSource(attempt, environment);
    prepared = await prepareDevPreviewRenderer(inputs.rendererSha);
    phase = "provider-preflight";
    if (!await previewRuntimeDrained(firestore)) refuse();
    const before = await collectDevRendererIdentity(inputs.token, prior.preview.rendererSha, request,
      { releaseStartedAt: prior.component.releaseStartedAt });
    if (!isDeepStrictEqual(before, prior.provider)) refuse();
    phase = "claim";
    saved = await owner.claimDevPreviewBootstrap({ firestore, attempt });
    phase = "disable-worker";
    await wrangler(prepared, ["deploy", "--containers-rollout=none", "--tag", inputs.rendererSha, "--message", attempt.operationId], inputs.token, ACCOUNT, undefined, spawnProcess);
    phase = "stop-old-container";
    await waitFor(async () => {
      const result = await cloudflare(inputs.token, `containers/applications/${prior.provider.applicationId}/instances?per_page=100`, request);
      if (!Array.isArray(result.instances) || result.instances.length >= 100) refuse();
      return result.instances.every(instance => instance.status?.state === "inactive");
    }, 10);
    await owner.guardDevPreviewBootstrap({ firestore, attemptDigest: saved.attemptDigest });
    if (!await previewRuntimeDrained(firestore)) refuse();
    await requireOwnedProvider(inputs, saved, request, false);
    phase = "install-configured-image";
    await wrangler(prepared, ["deploy", "--tag", inputs.rendererSha, "--message", attempt.operationId], inputs.token, ACCOUNT, undefined, spawnProcess);
    phase = "provider-readback";
    const provider = await collectPausedDevRenderer(inputs.token, attempt, { request });
    phase = "paused-control-commit";
    return await owner.finishDevPreviewBootstrap({ firestore, attemptDigest: saved.attemptDigest, provider });
  } catch {
    // Preparation/read failures allocate no attempt. An unknown claim reply
    // stops here without a provider effect; preserve any original journal.
    if (!saved) throw Object.assign(new Error("Development renderer preflight refused"), { bootstrapPhase: phase, restoreStatus: "not-needed" });
    const original = await owner.guardDevPreviewBootstrap({ firestore, attemptDigest: saved.attemptDigest });
    if (original.status === "committed-paused") return original;
    let outcome = await owner.failDevPreviewBootstrap({ firestore, attemptDigest: saved.attemptDigest, phase });
    let restoreStatus;
    try { outcome = await restore(firestore, inputs, saved, oldPrepared, request, spawnProcess); restoreStatus = "restored-paused"; }
    catch { restoreStatus = "refused"; outcome = await owner.guardDevPreviewBootstrap({ firestore, attemptDigest: saved.attemptDigest }); }
    throw Object.assign(new Error("Development renderer bootstrap failed"), { bootstrapPhase: phase, restoreStatus, bootstrapReceipt: outcome });
  } finally {
    await Promise.all([prepared, oldPrepared].filter(Boolean).map(value => rm(value.directory, { recursive: true, force: true })));
  }
}

function projectDevPreviewBootstrapReceipt(result) {
  const receipt = result?.receipt;
  return { status: result?.status, state: receipt?.state,
    sourceSha: receipt?.sourceSha ?? result?.attempt?.rendererSha,
    verificationMode: receipt?.verificationMode, operationId: result?.attempt?.operationId,
    imageDigest: receipt?.provider?.image?.match(/@(sha256:[a-f0-9]{64})$/)?.[1],
    startedAt: result?.attempt?.startedAt, releaseStartedAt: receipt?.releaseStartedAt };
}

/** The artifact retains operator identity, never the full bootstrap journal. */
export async function retainDevPreviewBootstrapReceipt(receiptFile, operation) {
  let receipt;
  try { receipt = projectDevPreviewBootstrapReceipt(await operation()); }
  catch (error) {
    receipt = { status: "refused",
      ...(error.bootstrapReceipt ? { bootstrap: projectDevPreviewBootstrapReceipt(error.bootstrapReceipt) } : {}) };
    await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    throw error;
  }
  await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

async function main() {
  const [rendererSha, receiptFile, ...extra] = process.argv.slice(2);
  if (extra.length || !path.isAbsolute(receiptFile ?? "")) refuse();
  const provenance = assertDevRendererReleaseSource(rendererSha, process.env);
  const mode = devRendererReleaseMode(process.env);
  const inputs = parseDevPreviewReleaseInputs(process.env, rendererSha, "retained-release");
  // config-input: CLOUDFLARE_API_TOKEN, CMS_DEV_ACCESS_CLIENT_ID, CMS_DEV_ACCESS_CLIENT_SECRET
  // config-input: CMS_DEV_PREVIEW_FIREBASE_ACCOUNT, CMS_DEV_PREVIEW_R2_CREDENTIAL
  for (const name of ["CMS_DEV_PREVIEW_FIREBASE_ACCOUNT", "CMS_DEV_PREVIEW_R2_CREDENTIAL", "CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET", "CLOUDFLARE_API_TOKEN"]) delete process.env[name];
  const app = firebaseAdminRuntime.initializeApp({ credential: firebaseAdminRuntime.cert(inputs.account), projectId: "njpbs-site-dev" }, "dev-renderer-only");
  try {
    const firestore = firebaseAdminRuntime.getFirestore(app);
    await retainDevPreviewBootstrapReceipt(receiptFile, () => mode.restorePreviewBootstrap
      ? restoreDevPreviewBootstrap({ firestore, inputs, environment: process.env })
      : bootstrapDevPreview({ firestore, inputs, provenance, environment: process.env }));
    process.stdout.write("Development renderer-only release receipt retained\n");
  } finally { await firebaseAdminRuntime.deleteApp(app); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(JSON.stringify({ status: "refused", code: "dev-renderer-only-release-failed",
      ...(typeof error?.bootstrapPhase === "string" && /^[a-z-]{1,64}$/.test(error.bootstrapPhase) ? { phase: error.bootstrapPhase } : {}),
      ...(["not-needed", "restored-paused", "refused"].includes(error?.restoreStatus) ? { restoreStatus: error.restoreStatus } : {}) }) + "\n");
    process.exitCode = 1;
  });
}
