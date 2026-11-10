import { workflowMatches } from "../scripts/lib/repository-identity.mjs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import publishDispatch from "../functions/lib/cms-publish-dispatch.js";
import { readConsistentRendererApplication } from "../scripts/lib/cms-component-receipt.mjs";
import { prepareDevPreviewRenderer } from "../scripts/prepare-preview-renderer.mjs";
import { firebaseAdminRuntime } from "../site/scripts/firebase-admin-runtime.ts";
import { parseCmsPublicationFirebaseServiceAccount } from "../site/scripts/cms-publication-credentials.ts";
import { parsePreviewStorageCredential } from "../site/scripts/cms-preview-storage-credential.ts";
import { createCmsPreviewCloudStorage } from "../site/scripts/cms-preview-cloud-storage.ts";
import { parsePreviewRuntimeControl, PREVIEW_RUNTIME_DOCUMENT, pausePreviewRuntime, previewRuntimeDrained } from "../site/scripts/cms-preview-cloud-control.ts";
import { devRendererReleaseMode } from "../scripts/lib/dev-renderer-release-source.mjs";
import { devDeploySourceSha } from "../scripts/lib/dev-deploy-source.mjs";

function accountId(value) {
  if (!/^[a-f0-9]{32}$/.test(value ?? "")) throw new Error("Dev preview account configuration invalid");
  return value;
}
const WORKER = "template-dev-cms-preview-renderer";
const PROJECT = "njpbs-site-dev";
const SERIALIZER = "cloudflare-preview";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
let phase = "inputs";

export function devPreviewFailureDetails(error) {
  // Error messages, provider bodies and arbitrary names can contain secrets.
  const allowedClasses = new Set(["Error", "TypeError", "SyntaxError", "AbortError", "TimeoutError",
    "FirebaseError", "CmsPublicationSerializerOperatorError", "PublicWorkerArtifactError",
    "AccessDenied", "NoSuchKey", "NotFound", "S3ServiceException"]);
  const name = error?.errorClass ?? error?.name;
  const errorClass = allowedClasses.has(name) ? name : "Error";
  const status = error?.httpStatus ?? error?.$metadata?.httpStatusCode;
  const http = Number.isInteger(status) && status >= 100 && status <= 599 ? `HTTP ${status}; ` : "";
  return `${http}error class ${errorClass}`;
}

export function formatDevPreviewReleaseFailure(error) {
  return `Dev preview release failed at ${phase}; ${devPreviewFailureDetails(error)}; raw details withheld\n`;
}

export function parseDevPreviewReleaseInputs(environment, rendererSha, mode = "release") {
  const deploySha = devDeploySourceSha(environment);
  const retained = mode === "retained-release";
  const releasing = mode !== "verify-pinned";
  const deploymentAccountId = accountId(environment.CLOUDFLARE_ACCOUNT_ID);
  const actors = publishDispatch.trustedPublishActors(environment);
  if (!["release", "verify-pinned", "retained-release"].includes(mode)) throw new Error("Dev preview release mode refused");
  if (retained) {
    const requested = devRendererReleaseMode(environment);
    if (!requested.rendererOnly || requested.sourceSha !== rendererSha) throw new Error("Dev renderer-only source refused");
  } else if (environment.CMS_DEV_RENDERER_ONLY === "true" || environment.CMS_DEV_PRESERVE_PREVIEW_PAUSE === "true" ||
      environment.CMS_DEV_RESTORE_PREVIEW_BOOTSTRAP === "true") {
    throw new Error("Dev preview release mode refused");
  }
  if (environment.CMS_DEPLOYMENT_ENVIRONMENT !== "development" || environment.FIREBASE_PROJECT_ID !== PROJECT ||
      Object.hasOwn(environment, "FIRESTORE_EMULATOR_HOST") ||
      Object.hasOwn(environment, "FIREBASE_AUTH_EMULATOR_HOST") || !/^[a-f0-9]{40}$/.test(rendererSha ?? "") ||
      !/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? "") ||
      (releasing && !retained && deploySha !== rendererSha) || environment.GITHUB_REF !== "refs/heads/main" ||
      !workflowMatches(environment.GITHUB_WORKFLOW_REF, "cms-dev-deploy.yml", environment) ||
      !actors.includes(environment.GITHUB_ACTOR) || !actors.includes(environment.GITHUB_TRIGGERING_ACTOR) ||
      environment.RUNNER_ENVIRONMENT !== "github-hosted" ||
      environment.CMS_DEV_RELEASE_PREVIEW_RENDERER !== String(releasing) ||
      (releasing && environment.CMS_DEV_PUBLISH_ENABLED !== "false")) {
    throw new Error("Dev preview release tuple refused");
  }
  const rawAccount = environment.CMS_DEV_PREVIEW_FIREBASE_ACCOUNT ?? "";
  const account = parseCmsPublicationFirebaseServiceAccount(rawAccount, PROJECT);
  if (account.clientEmail !== "cms-dev-preview-renderer@njpbs-site-dev.iam.gserviceaccount.com") {
    throw new Error("Dev preview renderer service identity refused");
  }
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token ?? "")) throw new Error("Dev preview provider credential missing");
  if (!releasing || retained) return { rendererSha, account, token, accountId: deploymentAccountId };
  const rawStorage = environment.CMS_DEV_PREVIEW_R2_CREDENTIAL ?? "";
  parsePreviewStorageCredential(rawStorage);
  const clientId = environment.CMS_DEV_ACCESS_CLIENT_ID;
  const clientSecret = environment.CMS_DEV_ACCESS_CLIENT_SECRET;
  if (typeof clientId !== "string" || !clientId ||
      typeof clientSecret !== "string" || !clientSecret) throw new Error("Dev preview release credentials missing");
  return { rendererSha, account, rawAccount, rawStorage, token, accountId: deploymentAccountId, publicationAccess: { clientId, clientSecret } };
}

export function assertPinnedDevRendererReceipt(control, release, provider, rendererSha) {
  const runtime = parsePreviewRuntimeControl(control);
  if (runtime.phase !== "ready" || runtime.rendererSha !== rendererSha || runtime.serializerId !== SERIALIZER ||
      release?.schemaVersion !== 1 || release.environment !== "development" || release.projectId !== PROJECT ||
      release.state !== "complete" || release.sourceSha !== rendererSha ||
      !Number.isFinite(Date.parse(release.releaseStartedAt)) ||
      Date.parse(release.releaseStartedAt) > Date.parse(release.verifiedAt) ||
      !Number.isFinite(Date.parse(release.verifiedAt)) || !isDeepStrictEqual(release.provider, provider)) {
    throw new Error("Pinned dev preview renderer differs from its verified live release");
  }
}

export async function verifyPinnedDevPreviewRenderer(firestore, inputs, request = fetch) {
  const control = (await firestore.doc(PREVIEW_RUNTIME_DOCUMENT).get()).data();
  const release = (await firestore.doc("cmsDeploymentReceipts/renderer").get()).data();
  const provider = await collectDevRendererIdentity(inputs.token, inputs.rendererSha, request, { releaseStartedAt: release?.releaseStartedAt, accountId: inputs.accountId });
  assertPinnedDevRendererReceipt(control, release, provider, inputs.rendererSha);
  // Read-only: retain the existing pin and deployment receipt, never pause,
  // rebuild a container, change secrets or write runtime state on routine deploys.
  return { schemaVersion: 1, environment: "development", projectId: PROJECT, state: "complete",
    sourceSha: inputs.rendererSha, releaseStartedAt: release.releaseStartedAt, provider, verifiedAt: new Date().toISOString(), verificationMode: "pinned-live-readback" };
}

export async function cloudflare(token, suffix, request, deploymentAccountId) {
  const account = accountId(deploymentAccountId);
  const response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}/${suffix}`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error("Dev preview provider read refused"), { httpStatus: response.status });
  }
  const body = await response.json();
  if (body.success !== true) throw new Error("Dev preview provider result invalid");
  return body.result;
}

async function application(token, request, deploymentAccountId) {
  const applications = await cloudflare(token, "containers/applications", request, deploymentAccountId);
  if (!Array.isArray(applications)) throw new Error("Dev preview application list invalid");
  const matches = applications.filter(entry => entry?.name === WORKER);
  if (!matches.length) return null;
  if (matches.length !== 1 || !UUID.test(matches[0].id)) throw new Error("Dev preview application identity invalid");
  return matches[0];
}

export async function collectDevRendererIdentity(token, rendererSha, request = fetch, options = {}) {
  const { releaseStartedAt } = options;
  const deploymentAccountId = accountId(options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID);
  if (typeof releaseStartedAt !== "string" || !Number.isFinite(Date.parse(releaseStartedAt)) ||
      Date.parse(releaseStartedAt) > Date.now()) throw new Error("Dev preview release start invalid");
  // Normalize completed rollout targets before hashing: the application record
  // can remain on the previous image even after all instances reach the target.
  const app = await readConsistentRendererApplication(request, deploymentAccountId, token, {
    ...options, applicationName: WORKER, rendererSha,
    rendererRelease: { mutation: { sourceSha: rendererSha, releaseStartedAt } },
  });
  if (!UUID.test(app.id)) throw new Error("Dev preview application identity invalid");
  const deployments = await cloudflare(token, `workers/scripts/${WORKER}/deployments`, request, deploymentAccountId);
  const active = (deployments?.deployments ?? deployments)?.[0];
  if (!UUID.test(active?.id) || active.versions?.length !== 1 || active.versions[0].percentage !== 100 ||
      !UUID.test(active.versions[0].version_id)) throw new Error("Dev preview Worker active identity invalid");
  const versionId = active.versions[0].version_id;
  const version = await cloudflare(token, `workers/scripts/${WORKER}/versions/${versionId}`, request, deploymentAccountId);
  if (version?.id !== versionId || version.annotations?.["workers/tag"] !== rendererSha || !Array.isArray(version.resources?.bindings)) {
    throw new Error("Dev preview Worker source identity differs");
  }
  for (const [name, text] of Object.entries({ PREVIEW_RENDERER_SHA: rendererSha, PREVIEW_RENDERER_ENABLED: "true",
    PREVIEW_SERIALIZER_ID: SERIALIZER, CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: PROJECT })) {
    const matches = version.resources.bindings.filter(binding => binding.name === name);
    if (matches.length !== 1 || matches[0].type !== "plain_text" || matches[0].text !== text) {
      throw new Error("Dev preview Worker runtime binding differs");
    }
  }
  const schedules = await cloudflare(token, `workers/scripts/${WORKER}/schedules`, request, deploymentAccountId);
  const crons = schedules?.schedules ?? schedules;
  if (!Array.isArray(crons) || crons.length !== 1 || crons[0]?.cron !== "* * * * *") {
    throw new Error("Dev preview renderer schedule differs");
  }
  const image = app.configuration?.image ?? app.image;
  const digest = app.configuration?.image_digest ?? app.digest;
  if (!(typeof image === "string" && image) && !(typeof digest === "string" && digest)) {
    throw new Error("Dev preview container image identity missing");
  }
  return { worker: WORKER, workerDeploymentId: active.id, workerVersionId: versionId,
    applicationId: app.id, rendererSha, serializerId: SERIALIZER,
    imageFingerprint: createHash("sha256").update(JSON.stringify({ image: image ?? null, digest: digest ?? null })).digest("hex") };
}

export async function waitFor(check, minutes) {
  const deadline = Date.now() + minutes * 60_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Dev preview release wait expired");
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
}

export async function wrangler(prepared, args, token, deploymentAccountId, input, spawnProcess = spawn) {
  await new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, [prepared.wrangler, ...args, "--config", prepared.configPath], {
      cwd: prepared.source,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: "true", WRANGLER_SEND_METRICS: "false",
        WRANGLER_WRITE_LOGS: "false", CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId(deploymentAccountId) },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.once("error", () => reject(new Error("Dev preview deployment could not start")));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("Dev preview deployment refused")));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

export function devRendererReleaseStart(previous, rendererSha, nowIso) {
  if (previous?.sourceSha !== rendererSha) return nowIso;
  if (previous.schemaVersion !== 1 || previous.environment !== "development" || previous.projectId !== PROJECT ||
      !["complete", "releasing"].includes(previous.state) || !Number.isFinite(Date.parse(previous.releaseStartedAt)) ||
      Date.parse(previous.releaseStartedAt) > Date.parse(nowIso)) throw new Error("Dev preview previous release invalid");
  return previous.releaseStartedAt;
}

export async function deployDevPreview(firestore, inputs) {
  const { rendererSha, token, rawAccount, rawStorage, publicationAccess, accountId: deploymentAccountId } = inputs;
  accountId(deploymentAccountId);
  const ref = firestore.doc(PREVIEW_RUNTIME_DOCUMENT);
  const storage = createCmsPreviewCloudStorage({ ...parsePreviewStorageCredential(rawStorage),
    deploymentEnvironment: "development", bucket: "template-dev-cms-previews", publicationAccess });
  let prepared;
  try {
    phase = "dependency-preflight";
    await storage.readPublicContext(firestore, undefined, stage => { phase = `dependency-preflight/${stage}`; });
    phase = "dependency-preflight/provider-applications";
    const oldApp = await application(token, fetch, deploymentAccountId);
    phase = "pause-and-drain";
    await pausePreviewRuntime(firestore, rendererSha);
    const control = parsePreviewRuntimeControl((await ref.get()).data());
    await waitFor(() => previewRuntimeDrained(firestore), 10);
    phase = "prepare-reviewed-dev-source";
    prepared = await prepareDevPreviewRenderer(rendererSha);
    const config = JSON.parse(await readFile(prepared.configPath, "utf8"));
    config.vars.CLOUDFLARE_ACCOUNT_ID = deploymentAccountId;
    await writeFile(prepared.configPath, `${JSON.stringify(config, null, 2)}\n`);
    const secrets = JSON.stringify({ FIREBASE_SERVICE_ACCOUNT: rawAccount, R2_PREVIEW_CREDENTIAL: rawStorage,
      CMS_DEV_ACCESS_CLIENT_ID: publicationAccess.clientId, CMS_DEV_ACCESS_CLIENT_SECRET: publicationAccess.clientSecret });
    if (oldApp) {
      phase = "stop-old-dev-container";
      await wrangler(prepared, ["secret", "bulk"], token, deploymentAccountId, secrets);
      await wrangler(prepared, ["deploy", "--containers-rollout=none", "--tag", rendererSha], token, deploymentAccountId);
      await waitFor(async () => {
        const result = await cloudflare(token, `containers/applications/${oldApp.id}/instances?per_page=100`, fetch, deploymentAccountId);
        if (!Array.isArray(result?.instances) || result.instances.length >= 100) throw new Error("Dev container instance list invalid");
        return result.instances.every(instance => instance.status?.state === "inactive");
      }, 10);
      if (!await previewRuntimeDrained(firestore)) throw new Error("Dev preview work changed during container stop");
    } else {
      // A first disabled Worker must exist before secret provisioning on stdin.
      await writeFile(prepared.configPath, `${JSON.stringify({ ...config, secrets: undefined }, null, 2)}\n`);
    }
    phase = "deploy-dev-container-image";
    const previousRelease = (await firestore.doc("cmsDeploymentReceipts/renderer").get()).data();
    const imageReleaseStartedAt = new Date().toISOString();
    // An unchanged-image retry can retain the completed rollout of this commit.
    const releaseStartedAt = devRendererReleaseStart(previousRelease, rendererSha, imageReleaseStartedAt);
    await firestore.doc("cmsDeploymentReceipts/renderer").set({ schemaVersion: 1, environment: "development",
      projectId: PROJECT, state: "releasing", sourceSha: rendererSha, releaseStartedAt });
    await wrangler(prepared, ["deploy", "--tag", rendererSha], token, deploymentAccountId);
    if (!oldApp) await wrangler(prepared, ["secret", "bulk"], token, deploymentAccountId, secrets);
    phase = "start-exact-dev-runtime";
    await firestore.runTransaction(async transaction => {
      const current = parsePreviewRuntimeControl((await transaction.get(ref)).data());
      if (current.phase !== "paused" || current.rendererSha !== control.rendererSha || current.serializerId !== control.serializerId) {
        throw new Error("Dev preview release control drift");
      }
      transaction.set(ref, { schemaVersion: 1, phase: "starting", rendererSha, serializerId: SERIALIZER });
    });
    const startingAt = Date.now();
    config.vars.PREVIEW_RENDERER_ENABLED = "true";
    await writeFile(prepared.configPath, `${JSON.stringify(config, null, 2)}\n`);
    await wrangler(prepared, ["deploy", "--containers-rollout=none", "--tag", rendererSha], token, deploymentAccountId);
    phase = "verify-dev-runtime-ready";
    await waitFor(async () => {
      const data = (await ref.get()).data();
      const current = parsePreviewRuntimeControl(data);
      if (current.rendererSha !== rendererSha || current.serializerId !== SERIALIZER) throw new Error("Dev preview startup identity drift");
      return current.phase === "ready" && Number.isFinite(Date.parse(data.checkedAt)) && Date.parse(data.checkedAt) >= startingAt;
    }, 20);
    phase = "verify-provider-identities";
    const provider = await collectDevRendererIdentity(token, rendererSha, fetch, { releaseStartedAt, accountId: deploymentAccountId });
    const receipt = { schemaVersion: 1, environment: "development", projectId: PROJECT, state: "complete",
      sourceSha: rendererSha, releaseStartedAt, provider, verifiedAt: new Date().toISOString() };
    await firestore.doc("cmsDeploymentReceipts/renderer").set(receipt);
    return receipt;
  } catch (error) {
    // Preserve any original admitted renderer identity while closing admission.
    // No API/Admin enablement job runs after this failure.
    await pausePreviewRuntime(firestore, rendererSha);
    throw error;
  } finally {
    storage.close();
    if (prepared) await rm(prepared.directory, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] === "--verify-pinned" ? "verify-pinned" : "release";
  const [rendererSha, receiptFile] = mode === "verify-pinned" ? args.slice(1) : args;
  if (args.length !== (mode === "verify-pinned" ? 3 : 2) || !receiptFile || !path.isAbsolute(receiptFile)) throw new Error("Dev release arguments invalid");
  let inputs;
  try { inputs = parseDevPreviewReleaseInputs(process.env, rendererSha, mode); }
  finally {
    // config-input: CLOUDFLARE_API_TOKEN, CMS_DEV_ACCESS_CLIENT_ID, CMS_DEV_ACCESS_CLIENT_SECRET
    // config-input: CMS_DEV_PREVIEW_FIREBASE_ACCOUNT, CMS_DEV_PREVIEW_R2_CREDENTIAL
    for (const name of ["CMS_DEV_PREVIEW_FIREBASE_ACCOUNT", "CMS_DEV_PREVIEW_R2_CREDENTIAL", "CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET", "CLOUDFLARE_API_TOKEN"]) delete process.env[name];
  }
  const app = firebaseAdminRuntime.initializeApp({ credential: firebaseAdminRuntime.cert(inputs.account), projectId: PROJECT }, "dev-preview-release");
  try {
    phase = mode === "verify-pinned" ? "verify-pinned-live-renderer" : "release";
    const receipt = mode === "verify-pinned"
      ? await verifyPinnedDevPreviewRenderer(firebaseAdminRuntime.getFirestore(app), inputs)
      : await deployDevPreview(firebaseAdminRuntime.getFirestore(app), inputs);
    await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`Dev exact-preview renderer verified at ${rendererSha}\n`);
  } finally { await firebaseAdminRuntime.deleteApp(app); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Never emit raw SDK/provider/subprocess errors or credential values.
    process.stderr.write(formatDevPreviewReleaseFailure(error));
    process.exitCode = 1;
  });
}
