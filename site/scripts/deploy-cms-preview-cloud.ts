import { cloudflareAccount } from "./cloudflare-account.mjs";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Firestore } from "firebase-admin/firestore";
import { preparePreviewRenderer } from "../../scripts/prepare-preview-renderer.mjs";
import { firebaseAdminRuntime } from "./firebase-admin-runtime";
import { assertProductionFirestoreRouting, parseCmsPublicationFirebaseServiceAccount } from "./cms-publication-inputs";
import { parsePreviewStorageCredential } from "./run-cms-preview-serializer";
import { createCmsPreviewCloudStorage, retainCloudPreviewPublicContext } from "./cms-preview-cloud-storage";
import { canonicalPublicationReceipt } from "../src/lib/public-publication-receipt";
import { PUBLICATION_PROBE_ORIGIN, PUBLICATION_PROBE_PATH, requestPublicPublicationReceipt } from "./activate-public-worker-candidate";
import { PREVIEW_RUNTIME_DOCUMENT, parsePreviewRuntimeControl, pausePreviewRuntime, previewRuntimeDrained } from "./cms-preview-cloud-control";
export { pausePreviewRuntime, previewRuntimeDrained } from "./cms-preview-cloud-control";
import { collectLiveIdentities } from "../../scripts/lib/cms-component-receipt.mjs";
import { identitiesMatch } from "../../scripts/lib/cms-release-plan.mjs";

const SERIALIZER = "cloudflare-preview";
const APPLICATION = "njpbs-cms-preview-renderer";
const releaseSecretValues: string[] = [];
const STARTUP_HEALTH_DEADLINE_MS = 180_000;
const PLACEMENT_ERROR = /no container instance(?: that can be provided)?|(?:placement|scheduling) (?:failed|error)|unable to (?:place|schedule)|insufficient (?:placement )?capacity/i;
const STARTUP_RECOVERY = "Keep previews paused; inspect Cloudflare placement and rollout health, then start a new full CMS staging deploy for this commit.";

export class CloudPreviewPlacementError extends Error {
  constructor() {
    super(`Container placement failed. ${STARTUP_RECOVERY}`);
    this.name = "CloudPreviewPlacementError";
  }
}

export class CloudPreviewZeroHealthyError extends Error {
  constructor() {
    super(`No verified healthy target instance after 180 seconds. ${STARTUP_RECOVERY}`);
    this.name = "CloudPreviewZeroHealthyError";
  }
}

export class CloudPreviewProviderReadError extends Error {
  constructor(startupRecovery = false) {
    super(`Container health could not be read.${startupRecovery ? ` ${STARTUP_RECOVERY}` : ""}`);
    this.name = "CloudPreviewProviderReadError";
  }
}

type PreviewRollout = {
  id: string;
  created_at: string;
  status: string;
  health?: { errors?: { event?: { name?: string; message?: string; time?: string } }[] };
  progress?: { version_distribution?: { target_version_instances?: number; current_version_instances?: number } };
};

function previewRollouts(value: unknown): PreviewRollout[] {
  const rows = Array.isArray(value) ? value : (value as { rollouts?: unknown })?.rollouts;
  if (!Array.isArray(rows) || rows.some(row =>
    typeof row?.id !== "string" || !row.id || !Number.isFinite(Date.parse(row.created_at)) ||
    !["pending", "progressing", "completed", "reverted", "replaced"].includes(row.status)) ||
    new Set(rows.map(row => row.id)).size !== rows.length) {
    throw new Error("Cloud preview rollout metadata is incomplete");
  }
  return rows;
}

/** Containers uses limit/last cursors, not the standard page/per_page API. */
export async function readCloudPreviewRollouts(readPage: (query: string) => Promise<unknown>) {
  const rows: PreviewRollout[] = [];
  const seen = new Set<string>();
  let last: string | undefined;
  for (;;) {
    const page = previewRollouts(await readPage(`?limit=100${last ? `&last=${encodeURIComponent(last)}` : ""}`));
    if (page.length > 100 || page.some(row => seen.has(row.id))) {
      throw new Error("Cloud preview rollout pagination is incomplete");
    }
    for (const row of page) { seen.add(row.id); rows.push(row); }
    if (page.length < 100) return rows;
    last = page[page.length - 1].id;
  }
}

/** Health is an early failure signal; only the exact renderer can attest ready. */
export async function waitForCloudPreviewStartup(rendererSha: string, {
  readControl, readRollouts, readApplication, previousRolloutIds = [], firstApplication = false,
  now = Date.now, sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
}: {
  readControl: () => Promise<unknown>; readRollouts: () => Promise<unknown>; readApplication: () => Promise<unknown>;
  previousRolloutIds?: readonly string[]; firstApplication?: boolean;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
}) {
  const started = now();
  let lastHealthyAt: number | null = null;
  let healthDeadlineRequired = !firstApplication;
  const ready = async () => {
    const current = parsePreviewRuntimeControl(await readControl());
    if (current.rendererSha !== rendererSha || current.serializerId !== SERIALIZER || current.phase === "paused") {
      throw new Error("Cloud preview release identity changed during startup");
    }
    return current.phase === "ready";
  };
  for (;;) {
    if (await ready()) return;
    let rawRollouts: unknown;
    let application: unknown;
    try {
      [rawRollouts, application] = await Promise.all([readRollouts(), readApplication()]);
    } catch (error) {
      if (!(error instanceof CloudPreviewProviderReadError)) throw error;
      const elapsed = now() - started;
      if ((healthDeadlineRequired && now() - (lastHealthyAt ?? started) >= STARTUP_HEALTH_DEADLINE_MS) || elapsed >= 20 * 60_000) {
        if (await ready()) return;
        throw new CloudPreviewProviderReadError(true);
      }
      await sleep(10_000);
      continue;
    }
    const rollouts = previewRollouts(rawRollouts);
    const app = application as { id?: string; active_rollout_id?: string | null;
      health?: { instances?: { healthy?: number } } } | null;
    if (!app || typeof app.id !== "string" || !app.id ||
      (app.active_rollout_id != null && typeof app.active_rollout_id !== "string")) {
      throw new Error("Cloud preview application health metadata is incomplete");
    }
    const active = rollouts.find(row => row.id === app.active_rollout_id);
    if (app.active_rollout_id && !active) throw new Error("Cloud preview active rollout metadata is incomplete");
    const latest = rollouts.filter(row => !previousRolloutIds.includes(row.id))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    const target = latest ?? active;
    if (target && ["reverted", "replaced"].includes(target.status)) {
      throw new Error(`Cloud preview rollout did not finish. ${STARTUP_RECOVERY}`);
    }
    // An unchanged image creates no new rollout. Fresh application health is
    // still required before extending that retry's exact-ready wait.
    const count = app.health?.instances?.healthy;
    const healthy = typeof count === "number" && Number.isSafeInteger(count) && count > 0;
    const distribution = target?.progress?.version_distribution;
    const targetCount = distribution?.target_version_instances;
    const targetHealthy = healthy && (!target || (typeof targetCount === "number" && Number.isSafeInteger(targetCount)
      && targetCount > 0 && distribution?.current_version_instances === 0));
    if (!targetHealthy && target?.health?.errors?.some(({ event }) => {
      // Same-image retries reuse the old rollout and may retain its errors.
      // Fresh live health or event time must distinguish recovery from history.
      if (lastHealthyAt !== null && !(typeof event?.time === "string" && Date.parse(event.time) > lastHealthyAt)) return false;
      if (!latest && !(typeof event?.time === "string" && Date.parse(event.time) >= started)) return false;
      return PLACEMENT_ERROR.test(event?.message ?? "") ||
        ["VMFailed", "VMFailedToStart", "RuntimeStartFailed", "NetworkingIPAssignmentFailed"].includes(event?.name ?? "");
    })) throw new CloudPreviewPlacementError();
    if (targetHealthy) lastHealthyAt = now();
    healthDeadlineRequired = Boolean(target) || !firstApplication;
    const elapsed = now() - started;
    // A first application has no rollout, and its new cron can take 15 minutes
    // to propagate. Existing applications must prove target health in 3 minutes.
    if (now() - (lastHealthyAt ?? started) >= STARTUP_HEALTH_DEADLINE_MS && !targetHealthy && healthDeadlineRequired) {
      if (await ready()) return;
      throw new CloudPreviewZeroHealthyError();
    }
    if (elapsed >= 20 * 60_000) {
      if (await ready()) return;
      throw new Error(`Cloud preview startup timed out. ${STARTUP_RECOVERY}`);
    }
    await sleep(10_000);
  }
}

export function describeCloudPreviewReleaseFailure(error: unknown, secrets: readonly string[] = []): string {
  const name = error instanceof Error && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(error.name)
    ? error.name
    : "Error";
  let message = error instanceof Error ? error.message : "Unknown cloud preview release failure";
  const values = [...secrets].filter(secret => secret.length >= 8).sort((left, right) => right.length - left.length);
  for (const secret of values) {
    if (message.includes(secret)) message = message.split(secret).join("[redacted]");
  }
  message = message.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 300);
  if (!message) message = "Unknown cloud preview release failure";
  return `${name}: ${message}`;
}

/** Raw credential inputs and the parsed parts an error message could quote. */
export function releaseSecretsFor(rawAccount: string, rawStorage: string, token: string): string[] {
  const secrets = [rawAccount, rawStorage, token];
  try {
    const account: unknown = JSON.parse(rawAccount);
    if (account && typeof account === "object" && !Array.isArray(account)) {
      const { private_key: privateKey, private_key_id: privateKeyId } = account as Record<string, unknown>;
      for (const value of [privateKey, privateKeyId]) if (typeof value === "string") secrets.push(value);
    }
  } catch { /* An invalid account fails later with a fixed message. */ }
  try {
    const storage = parsePreviewStorageCredential(rawStorage);
    secrets.push(storage.accessKeyId, storage.secretAccessKey);
  } catch { /* An invalid storage credential fails later with a fixed message. */ }
  return secrets;
}

async function waitFor(description: string, check: () => Promise<boolean>, minutes = 10) {
  const deadline = Date.now() + minutes * 60_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
}

async function cloudflare(token: string, suffix: string): Promise<unknown> {
  const account = cloudflareAccount();
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications${suffix}`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new CloudPreviewProviderReadError(); }
  if (!response.ok) {
    await response.body?.cancel();
    if ([408, 429].includes(response.status) || response.status >= 500) throw new CloudPreviewProviderReadError();
    throw new Error("Cloud preview container state could not be checked");
  }
  let body: { success?: boolean; result?: unknown };
  try { body = await response.json(); }
  catch { throw new Error("Cloud preview container state is invalid"); }
  if (body.success !== true) throw new Error("Cloud preview container state is invalid");
  return body.result;
}

/** Retry only transient provider reads; mutations never use this deferral. */
export async function retryCloudPreviewRead<T>(read: () => Promise<T>,
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await read(); }
    catch (error) {
      if (!(error instanceof CloudPreviewProviderReadError) || attempt >= 3) throw error;
      await sleep(10_000);
    }
  }
}

async function applicationId(token: string): Promise<string | null> {
  const applications = await cloudflare(token, "");
  if (!Array.isArray(applications)) throw new Error("Cloud preview application list is invalid");
  const matches = applications.filter(application => application.name === APPLICATION);
  if (matches.length === 0) return null;
  if (matches.length !== 1 || !/^[a-f0-9-]{36}$/.test(matches[0].id)) throw new Error("Cloud preview application identity is invalid");
  return matches[0].id;
}

async function verifyCloudPreviewDependencies(firestore: Firestore, rawStorage: string, token: string) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) throw new Error("Cloud preview deploy credential is invalid");
  const storage = createCmsPreviewCloudStorage(parsePreviewStorageCredential(rawStorage));
  try { await storage.readPublicContext(firestore); }
  finally { storage.close(); }
  return retryCloudPreviewRead(() => applicationId(token));
}

async function containersInactive(token: string, id: string): Promise<boolean> {
  const result = await cloudflare(token, `/${id}/instances?per_page=100`) as {
    instances?: { status?: { state?: string } }[];
  };
  if (!Array.isArray(result?.instances) || result.instances.length >= 100) {
    throw new Error("Cloud preview instance list is incomplete");
  }
  return result.instances.every(instance => instance.status?.state === "inactive");
}

function wranglerFailureClass(output: string): string {
  if (/authentication (?:error|failed)|unauthorized|invalid (?:api )?token|not authenticated/i.test(output)) return "authentication";
  if (/(?:failed to push|error pushing|push.*(?:denied|failed)|registry.*(?:error|failed))/i.test(output)) return "registry_push";
  if (/(?:failed to (?:build|solve)|build.*(?:error|failed)|dockerfile.*error)/i.test(output)) return "image_build";
  if (/rollout.*(?:error|failed|timed out)|deployment.*(?:unhealthy|failed)/i.test(output)) return "rollout";
  return "unknown";
}

export async function wrangler(prepared: Awaited<ReturnType<typeof preparePreviewRenderer>>, args: string[],
  token: string, input?: string) {
  const operation = args[0] === "secret" ? "secret bulk"
    : args.includes("--containers-rollout=none") ? "worker-only deploy" : "image deploy";
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [prepared.wrangler, ...args, "--config", prepared.configPath], {
      cwd: prepared.source,
      detached: process.platform !== "win32",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: "true", WRANGLER_SEND_METRICS: "false",
        CLOUDFLARE_API_TOKEN: token },
      // Provider output stays in bounded memory. Never include it in an error.
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const fail = (code: number | null, signal: string | null, failureClass: string) => {
      const elapsed = ((Date.now() - started) / 1_000).toFixed(1);
      reject(new Error(`Cloud preview Wrangler ${operation} failed (exit=${code ?? "none"}, signal=${signal ?? "none"}, elapsed=${elapsed}s, class=${failureClass})`));
    };
    // Bound image deployment separately from startup health verification.
    const timeout = operation === "image deploy" ? setTimeout(() => {
      timedOut = true;
      // Wrangler starts Docker children; stop the whole command group on Linux.
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      fail(null, "SIGKILL", "timeout");
    }, 15 * 60_000) : undefined;
    const observe = (chunk: Buffer, stream: "stdout" | "stderr") => {
      if (timedOut) return;
      if (stream === "stdout") stdout = (stdout + chunk.toString()).slice(-65_536);
      else stderr = (stderr + chunk.toString()).slice(-65_536);
      if (!PLACEMENT_ERROR.test(`${stdout}\n${stderr}`)) return;
      timedOut = true;
      clearTimeout(timeout);
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { child.kill("SIGKILL"); }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new CloudPreviewPlacementError());
    };
    child.stdout.on("data", chunk => observe(chunk, "stdout"));
    child.stderr.on("data", chunk => observe(chunk, "stderr"));
    child.once("error", () => {
      if (timedOut) return;
      clearTimeout(timeout);
      fail(null, null, "unknown");
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) return;
      if (code === 0) resolve();
      else fail(code, signal, wranglerFailureClass(`${stdout}\n${stderr}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

export async function deployPreviewRuntime({ firestore, rendererSha, token, rawAccount, rawStorage }: {
  firestore: Firestore; rendererSha: string; token: string; rawAccount: string; rawStorage: string;
}) {
  const ref = firestore.doc(PREVIEW_RUNTIME_DOCUMENT);
  const control = parsePreviewRuntimeControl((await ref.get()).data());
  if (control.phase !== "paused") throw new Error("Pause preview admission before deploying the renderer");
  const existingId = await verifyCloudPreviewDependencies(firestore, rawStorage, token);
  process.stdout.write("Waiting for admitted preview work to finish\n");
  await waitFor("preview work to drain", () => previewRuntimeDrained(firestore));
  const prepared = await preparePreviewRenderer(rendererSha);
  const config = JSON.parse(await readFile(prepared.configPath, "utf8"));
  const secrets = JSON.stringify({ FIREBASE_SERVICE_ACCOUNT: rawAccount, R2_PREVIEW_CREDENTIAL: rawStorage });
  const previousRolloutIds = existingId
    ? (await readCloudPreviewRollouts(query => retryCloudPreviewRead(() => cloudflare(token, `/${existingId}/rollouts${query}`)))).map(row => row.id) : [];
  if (existingId) {
    // Also repairs a first deployment interrupted before secret provisioning.
    await wrangler(prepared, ["secret", "bulk"], token, secrets);
    process.stdout.write("Stopping the previous cloud preview container\n");
    // Worker-only deploy keeps the old image until the service has stopped.
    await wrangler(prepared, ["deploy", "--containers-rollout=none"], token);
    await waitFor("previous preview container to stop", () => containersInactive(token, existingId));
    if (!await previewRuntimeDrained(firestore)) throw new Error("Preview work changed during the container stop");
  }
  process.stdout.write("Deploying the exact cloud preview image\n");
  if (!existingId) {
    // The first disabled Worker must exist before stdin secret provisioning.
    await writeFile(prepared.configPath, `${JSON.stringify({ ...config, secrets: undefined }, null, 2)}\n`);
  }
  await wrangler(prepared, ["deploy"], token);
  if (!existingId) await wrangler(prepared, ["secret", "bulk"], token, secrets);
  await firestore.runTransaction(async transaction => {
    const current = parsePreviewRuntimeControl((await transaction.get(ref)).data());
    if (current.phase !== "paused" || current.rendererSha !== control.rendererSha || current.serializerId !== control.serializerId) {
      throw new Error("Preview release control changed during deployment");
    }
    transaction.set(ref, { schemaVersion: 1, phase: "starting", rendererSha, serializerId: SERIALIZER });
  });
  config.vars.PREVIEW_RENDERER_ENABLED = "true";
  await writeFile(prepared.configPath, `${JSON.stringify(config, null, 2)}\n`);
  await wrangler(prepared, ["deploy", "--containers-rollout=none"], token);
  process.stdout.write("Waiting for cloud preview startup verification\n");
  let startupId: Promise<string> | null = existingId ? Promise.resolve(existingId) : null;
  const resolveStartupId = () => startupId ??= applicationId(token).then(id => {
    if (!id) throw new Error("Cloud preview application is missing after deployment");
    return id;
  }).catch(error => { startupId = null; throw error; });
  // Allow 180s for target health, independently of the image deployment's
  // 15-minute deadline.
  await waitForCloudPreviewStartup(rendererSha, {
    readControl: async () => (await ref.get()).data(),
    readRollouts: async () => {
      const id = await resolveStartupId();
      return readCloudPreviewRollouts(query => cloudflare(token, `/${id}/rollouts${query}`));
    },
    readApplication: async () => cloudflare(token, `/${await resolveStartupId()}`),
    previousRolloutIds, firstApplication: !existingId,
  });
  process.stdout.write(`Cloud preview renderer verified at ${rendererSha}\n`);
}

async function main() {
  const [operation, rendererSha, contextFile] = process.argv.slice(2);
  if (!["preflight", "pause", "deploy", "confirm", "seed-context"].includes(operation) || !/^[a-f0-9]{40}$/.test(rendererSha ?? "") ||
    process.argv.length !== (operation === "seed-context" ? 5 : 4)) {
    throw new Error("Usage: deploy-cms-preview-cloud <preflight|pause|deploy|confirm|seed-context> <reviewed commit> [retained context file]");
  }
  const cloudflareAccountId = cloudflareAccount();
  assertProductionFirestoreRouting(process.env);
  const rawAccount = process.env.CMS_PREVIEW_FIREBASE_ACCOUNT ?? "";
  const rawStorage = process.env.CMS_PREVIEW_R2_CREDENTIAL ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  delete process.env.CMS_PREVIEW_FIREBASE_ACCOUNT;
  delete process.env.CMS_PREVIEW_R2_CREDENTIAL;
  delete process.env.CLOUDFLARE_API_TOKEN;
  releaseSecretValues.splice(0, releaseSecretValues.length, ...releaseSecretsFor(rawAccount, rawStorage, token));
  const account = parseCmsPublicationFirebaseServiceAccount(rawAccount);
  const app = firebaseAdminRuntime.initializeApp({
    credential: firebaseAdminRuntime.cert(account), projectId: "njpbs-site",
  }, "preview-cloud-release");
  const firestore = firebaseAdminRuntime.getFirestore(app);
  try {
    if (operation === "preflight") {
      await verifyCloudPreviewDependencies(firestore, rawStorage, token);
      process.stdout.write("Cloud preview release dependencies verified\n");
    } else if (operation === "pause") await pausePreviewRuntime(firestore, rendererSha);
    else if (operation === "confirm") {
      const control = parsePreviewRuntimeControl((await firestore.doc(PREVIEW_RUNTIME_DOCUMENT).get()).data());
      if (control.phase !== "ready" || control.rendererSha !== rendererSha || control.serializerId !== SERIALIZER) {
        throw new Error("Live cloud preview renderer is not ready at the expected identity");
      }
      const live = await collectLiveIdentities("renderer", {
        firestore,
        cloudflareToken: token,
        cloudflareAccount: cloudflareAccountId,
      });
      const receipt = (await firestore.collection("cmsDeploymentReceipts").doc("renderer").get()).data();
      const recorded = receipt?.state === "complete"
        ? receipt.mutation?.providerIdentities
        : receipt?.lastComplete?.providerIdentities;
      if (!identitiesMatch(live, recorded)) {
        throw new Error("Live renderer provider identity does not match the receipt");
      }
      process.stdout.write(`Cloud preview renderer already ready at ${rendererSha}\n`);
    }
    else if (operation === "seed-context") {
      if (!path.isAbsolute(contextFile)) throw new Error("An absolute retained public context path is required");
      const url = new URL(`${PUBLICATION_PROBE_PATH}?cms-context=code`, PUBLICATION_PROBE_ORIGIN).toString();
      const publication = canonicalPublicationReceipt(JSON.parse(await requestPublicPublicationReceipt(url)));
      await retainCloudPreviewPublicContext({ firestore, file: contextFile, publication,
        ...parsePreviewStorageCredential(rawStorage) });
      process.stdout.write(`Retained published context verified for ${publication.buildBatchId}\n`);
    }
    else {
      if (!token) throw new Error("Cloud preview deploy credential is required");
      try { await deployPreviewRuntime({ firestore, rendererSha, token, rawAccount, rawStorage }); }
      catch (error) {
        await pausePreviewRuntime(firestore, rendererSha);
        throw error;
      }
    }
  } finally { await firebaseAdminRuntime.deleteApp(app); }
  releaseSecretValues.fill("");
  releaseSecretValues.length = 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const line = describeCloudPreviewReleaseFailure(error, releaseSecretValues);
    releaseSecretValues.fill("");
    releaseSecretValues.length = 0;
    process.stderr.write(`${line}\n`);
    process.stderr.write("Cloud preview release stopped without a verified result; check the private release control before retrying\n");
    process.exitCode = 1;
  });
}
