import { cloudflareAccount } from "./cloudflare-account.mjs";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Firestore } from "firebase-admin/firestore";
import { prepareDevPreviewRenderer, preparePreviewRenderer } from "../../scripts/prepare-preview-renderer.mjs";
import { cmsTarget } from "../../scripts/lib/cms-target.mjs";
import { providerCall } from "../../scripts/lib/provider-call.mjs";
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
// The dev bucket name is rendered into the workspace like every dev resource name.
const DEV_PREVIEW_BUCKET = "template-dev-cms-previews";
// A development release reads each credential from its own dev secret, never a production name.
const DEV_SECRETS = { CMS_PREVIEW_FIREBASE_ACCOUNT: "CMS_DEV_PREVIEW_FIREBASE_ACCOUNT",
  CMS_PREVIEW_R2_CREDENTIAL: "CMS_DEV_PREVIEW_R2_CREDENTIAL", CLOUDFLARE_API_TOKEN: "CLOUDFLARE_DEV_PREVIEW_RENDERER_TOKEN",
  CMS_DEV_ACCESS_CLIENT_ID: "CMS_DEV_ACCESS_CLIENT_ID", CMS_DEV_ACCESS_CLIENT_SECRET: "CMS_DEV_ACCESS_CLIENT_SECRET" } as const;
type PublicationAccess = { clientId: string; clientSecret: string };

/** Storage options for the target: production keeps its defaults; dev names its bucket and Access client. */
function previewStorageTarget(publicationAccess?: PublicationAccess) {
  return publicationAccess ? { deploymentEnvironment: "development", bucket: DEV_PREVIEW_BUCKET, publicationAccess } : {};
}

/** Reads and removes the release credentials; a development release refuses a missing dev secret by name. */
export function releaseCredentials(env: NodeJS.ProcessEnv = process.env) {
  const development = cmsTarget(env).environment === "development";
  const take = (name: keyof typeof DEV_SECRETS) => {
    // config-input: CMS_PREVIEW_FIREBASE_ACCOUNT, CMS_PREVIEW_R2_CREDENTIAL, CLOUDFLARE_API_TOKEN, CMS_DEV_ACCESS_CLIENT_ID, CMS_DEV_ACCESS_CLIENT_SECRET
    const value = env[name] ?? ""; delete env[name];
    if (development && !value) throw new Error(`${DEV_SECRETS[name]} is required for a development renderer release`);
    return value;
  };
  const rawAccount = take("CMS_PREVIEW_FIREBASE_ACCOUNT");
  const rawStorage = take("CMS_PREVIEW_R2_CREDENTIAL");
  const token = take("CLOUDFLARE_API_TOKEN");
  const publicationAccess = development
    ? { clientId: take("CMS_DEV_ACCESS_CLIENT_ID"), clientSecret: take("CMS_DEV_ACCESS_CLIENT_SECRET") } : undefined;
  return { rawAccount, rawStorage, token, publicationAccess };
}
const releaseSecretValues: string[] = [];
// Pacing between reads; it never ends a wait.
const READ_PAUSE_MS = 10_000;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const PLACEMENT_ERROR = /no container instance(?: that can be provided)?|(?:placement|scheduling) (?:failed|error)|unable to (?:place|schedule)|insufficient (?:placement )?capacity/i;
const STARTUP_RECOVERY = "Keep previews paused; inspect Cloudflare placement and rollout health, then start a new full CMS staging deploy for this commit.";

export class CloudPreviewPlacementError extends Error {
  constructor() {
    super(`Container placement failed. ${STARTUP_RECOVERY}`);
    this.name = "CloudPreviewPlacementError";
  }
}

export class CloudPreviewHealthError extends Error {
  constructor(name: string) {
    super(`Container health reported ${name}. ${STARTUP_RECOVERY}`);
    this.name = "CloudPreviewHealthError";
  }
}

export class CloudPreviewProviderReadError extends Error {
  constructor() {
    super("Container health could not be read.");
    this.name = "CloudPreviewProviderReadError";
  }
}

type PreviewRollout = {
  id: string;
  created_at: string;
  status: string;
  steps?: { status?: string }[];
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

/** Ends when the exact renderer reports its startup, or when the platform names a
 * failure. No clock ends it: rollout 147480fa completed after 305 s with no
 * errors, where the five before it took 106 to 169 s. */
export async function waitForCloudPreviewStartup(rendererSha: string, {
  readControl, readRollouts, readApplication, previousRolloutIds = [],
  now = Date.now, sleep = pause, log = line => process.stdout.write(`${line}\n`),
}: {
  readControl: () => Promise<unknown>; readRollouts: () => Promise<unknown>; readApplication: () => Promise<unknown>;
  previousRolloutIds?: readonly string[];
  now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void;
}) {
  const started = now();
  let lastHealthyAt: number | null = null;
  const report = (state: string) => log(`Preview startup, ${Math.round((now() - started) / 1_000)} s: ${state}`);
  for (;;) {
    const current = parsePreviewRuntimeControl(await readControl());
    if (current.rendererSha !== rendererSha || current.serializerId !== SERIALIZER || current.phase !== "starting") {
      throw new Error("Cloud preview release identity changed during startup");
    }
    if (current.checkedAt) return;
    let rawRollouts: unknown;
    let application: unknown;
    try {
      [rawRollouts, application] = await Promise.all([readRollouts(), readApplication()]);
    } catch (error) {
      if (!(error instanceof CloudPreviewProviderReadError)) throw error;
      report(`control ${current.phase}, container state not read`);
      await sleep(READ_PAUSE_MS);
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
    const count = app.health?.instances?.healthy;
    const distribution = target?.progress?.version_distribution;
    const targetCount = distribution?.target_version_instances;
    const shown = (value: unknown) => Number.isSafeInteger(value) ? value : "unknown";
    report(`control ${current.phase}, rollout ${target?.status ?? "none"}, ` +
      `step ${/^[a-z_]{1,30}$/.test(target?.steps?.at(-1)?.status ?? "") ? target?.steps?.at(-1)?.status : "unknown"}, target instances ${shown(targetCount)}, ` +
      `previous instances ${shown(distribution?.current_version_instances)}, healthy ${shown(count)}`);
    if (target && ["reverted", "replaced"].includes(target.status)) {
      throw new Error(`Cloud preview rollout did not finish: ${target.status}. ${STARTUP_RECOVERY}`);
    }
    // An unchanged image creates no new rollout; application health alone then
    // separates a recovery from a retained error.
    const healthy = typeof count === "number" && Number.isSafeInteger(count) && count > 0;
    const targetHealthy = healthy && (!target || (typeof targetCount === "number" && Number.isSafeInteger(targetCount)
      && targetCount > 0 && distribution?.current_version_instances === 0));
    const fault = targetHealthy ? undefined : target?.health?.errors?.find(({ event }) => {
      // Same-image retries reuse the old rollout and may retain its errors.
      // Fresh live health or event time must distinguish recovery from history.
      if (lastHealthyAt !== null && !(typeof event?.time === "string" && Date.parse(event.time) > lastHealthyAt)) return false;
      if (!latest && !(typeof event?.time === "string" && Date.parse(event.time) >= started)) return false;
      return true;
    });
    if (fault) {
      const { name = "", message = "" } = fault.event ?? {};
      if (PLACEMENT_ERROR.test(message)) throw new CloudPreviewPlacementError();
      throw new CloudPreviewHealthError(/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(name) ? name : "an unnamed error");
    }
    if (targetHealthy) lastHealthyAt = now();
    await sleep(READ_PAUSE_MS);
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

// Neither wait has a limit of its own: each ends on the state it reads. Both
// run while admission is paused, so a hang costs runner time and admits nothing.
async function waitFor(description: string, check: () => Promise<boolean>) {
  const started = Date.now();
  while (!await check()) {
    process.stdout.write(`Waiting for ${description}, ${Math.round((Date.now() - started) / 1_000)} s\n`);
    await pause(READ_PAUSE_MS);
  }
}

async function cloudflare(token: string, suffix: string): Promise<unknown> {
  const account = cloudflareAccount();
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications${suffix}`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error",
    });
  } catch { throw new CloudPreviewProviderReadError(); }
  if (!response.ok) {
    await response.body?.cancel();
    if ([408, 429].includes(response.status) || response.status >= 500) throw new CloudPreviewProviderReadError();
    throw new Error("Cloud preview container state could not be checked");
  }
  let text: string;
  // A body that stops arriving is a lost read; undici ends it after 300 s.
  try { text = await response.text(); } catch { throw new CloudPreviewProviderReadError(); }
  let body: { success?: boolean; result?: unknown };
  try { body = JSON.parse(text); }
  catch { throw new Error("Cloud preview container state is invalid"); }
  if (body.success !== true) throw new Error("Cloud preview container state is invalid");
  return body.result;
}

/** A read is repeated when the provider could not be read; a refused or invalid answer is final. */
export function retryCloudPreviewRead<T>(read: () => Promise<T>, options = {}): Promise<T> {
  return providerCall("Cloudflare Containers read", read, {
    permanent: (error: unknown) => error instanceof CloudPreviewProviderReadError ? null : "answer", ...options });
}

async function applicationId(token: string): Promise<string | null> {
  const applications = await cloudflare(token, "");
  if (!Array.isArray(applications)) throw new Error("Cloud preview application list is invalid");
  const name = cmsTarget().rendererWorker;
  const matches = applications.filter(application => application.name === name);
  if (matches.length === 0) return null;
  if (matches.length !== 1 || !/^[a-f0-9-]{36}$/.test(matches[0].id)) throw new Error("Cloud preview application identity is invalid");
  return matches[0].id;
}

async function verifyCloudPreviewDependencies(firestore: Firestore, rawStorage: string, token: string, publicationAccess?: PublicationAccess) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) throw new Error("Cloud preview deploy credential is invalid");
  const storage = createCmsPreviewCloudStorage({ ...parsePreviewStorageCredential(rawStorage), ...previewStorageTarget(publicationAccess) });
  try { await storage.readPublicContext(firestore); }
  finally { storage.close(); }
  return retryCloudPreviewRead(() => applicationId(token));
}

async function containersInactive(token: string, id: string): Promise<boolean> {
  const result = await retryCloudPreviewRead(() => cloudflare(token, `/${id}/instances?per_page=100`)) as {
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
    let stopped = false;
    const fail = (code: number | null, signal: string | null, failureClass: string) => {
      const elapsed = ((Date.now() - started) / 1_000).toFixed(1);
      const message = `Cloud preview Wrangler ${operation} failed (exit=${code ?? "none"}, signal=${signal ?? "none"}, elapsed=${elapsed}s, class=${failureClass})`;
      reject(Object.assign(new Error(message), { failureClass, providerLine: message }));
    };
    const observe = (chunk: Buffer, stream: "stdout" | "stderr") => {
      if (stopped) return;
      if (stream === "stdout") stdout = (stdout + chunk.toString()).slice(-65_536);
      else stderr = (stderr + chunk.toString()).slice(-65_536);
      if (!PLACEMENT_ERROR.test(`${stdout}\n${stderr}`)) return;
      stopped = true;
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
      if (stopped) return;
      fail(null, null, "unknown");
    });
    child.once("close", (code, signal) => {
      if (stopped) return;
      if (code === 0) resolve();
      else fail(code, signal, wranglerFailureClass(`${stdout}\n${stderr}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** A deploy sets the Worker, image and secrets to this exact release, so a repeat reaches the same state.
 * A refused credential is final. */
export function retryWrangler(prepared: Awaited<ReturnType<typeof preparePreviewRenderer>>, args: string[], token: string, input?: string, options = {}) {
  return providerCall(`preview renderer wrangler ${args[0]}`, () => wrangler(prepared, args, token, input), {
    permanent: (error: { failureClass?: string }) => error.failureClass === "authentication" ? "authentication" : null, ...options });
}

export async function deployPreviewRuntime({ firestore, rendererSha, token, rawAccount, rawStorage, publicationAccess }: {
  firestore: Firestore; rendererSha: string; token: string; rawAccount: string; rawStorage: string; publicationAccess?: PublicationAccess;
}) {
  const ref = firestore.doc(PREVIEW_RUNTIME_DOCUMENT);
  const control = parsePreviewRuntimeControl((await ref.get()).data());
  if (control.phase !== "paused") throw new Error("Pause preview admission before deploying the renderer");
  const existingId = await verifyCloudPreviewDependencies(firestore, rawStorage, token, publicationAccess);
  process.stdout.write("Waiting for admitted preview work to finish\n");
  await waitFor("preview work to drain", () => previewRuntimeDrained(firestore));
  const prepared = await (publicationAccess ? prepareDevPreviewRenderer : preparePreviewRenderer)(rendererSha);
  const config = JSON.parse(await readFile(prepared.configPath, "utf8"));
  const secrets = JSON.stringify({ FIREBASE_SERVICE_ACCOUNT: rawAccount, R2_PREVIEW_CREDENTIAL: rawStorage,
    ...(publicationAccess ? { CMS_DEV_ACCESS_CLIENT_ID: publicationAccess.clientId, CMS_DEV_ACCESS_CLIENT_SECRET: publicationAccess.clientSecret } : {}) });
  const previousRolloutIds = existingId
    ? (await readCloudPreviewRollouts(query => retryCloudPreviewRead(() => cloudflare(token, `/${existingId}/rollouts${query}`)))).map(row => row.id) : [];
  if (existingId) {
    // Also repairs a first deployment interrupted before secret provisioning.
    await retryWrangler(prepared, ["secret", "bulk"], token, secrets);
    process.stdout.write("Stopping the previous cloud preview container\n");
    // Worker-only deploy keeps the old image until the service has stopped.
    await retryWrangler(prepared, ["deploy", "--containers-rollout=none"], token);
    await waitFor("previous preview container to stop", () => containersInactive(token, existingId));
    if (!await previewRuntimeDrained(firestore)) throw new Error("Preview work changed during the container stop");
  }
  process.stdout.write("Deploying the exact cloud preview image\n");
  if (!existingId) {
    // The first disabled Worker must exist before stdin secret provisioning.
    await writeFile(prepared.configPath, `${JSON.stringify({ ...config, secrets: undefined }, null, 2)}\n`);
  }
  await retryWrangler(prepared, ["deploy"], token);
  if (!existingId) await retryWrangler(prepared, ["secret", "bulk"], token, secrets);
  await firestore.runTransaction(async transaction => {
    const current = parsePreviewRuntimeControl((await transaction.get(ref)).data());
    if (current.phase !== "paused" || current.rendererSha !== control.rendererSha || current.serializerId !== control.serializerId) {
      throw new Error("Preview release control changed during deployment");
    }
    transaction.set(ref, { schemaVersion: 1, phase: "starting", rendererSha, serializerId: SERIALIZER });
  });
  config.vars.PREVIEW_RENDERER_ENABLED = "true";
  await writeFile(prepared.configPath, `${JSON.stringify(config, null, 2)}\n`);
  await retryWrangler(prepared, ["deploy", "--containers-rollout=none"], token);
  process.stdout.write("Waiting for cloud preview startup verification\n");
  let startupId: Promise<string> | null = existingId ? Promise.resolve(existingId) : null;
  const resolveStartupId = () => startupId ??= applicationId(token).then(id => {
    if (!id) throw new Error("Cloud preview application is missing after deployment");
    return id;
  }).catch(error => { startupId = null; throw error; });
  await waitForCloudPreviewStartup(rendererSha, {
    readControl: async () => (await ref.get()).data(),
    readRollouts: async () => {
      const id = await resolveStartupId();
      return readCloudPreviewRollouts(query => cloudflare(token, `/${id}/rollouts${query}`));
    },
    readApplication: async () => cloudflare(token, `/${await resolveStartupId()}`),
    previousRolloutIds,
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
  const { rawAccount, rawStorage, token, publicationAccess } = releaseCredentials();
  if (publicationAccess && operation === "seed-context") throw new Error("Development has no retained public context seed");
  releaseSecretValues.splice(0, releaseSecretValues.length, ...releaseSecretsFor(rawAccount, rawStorage, token),
    ...(publicationAccess ? [publicationAccess.clientId, publicationAccess.clientSecret] : []));
  const account = parseCmsPublicationFirebaseServiceAccount(rawAccount, cmsTarget().projectId);
  const app = firebaseAdminRuntime.initializeApp({
    credential: firebaseAdminRuntime.cert(account), projectId: cmsTarget().projectId,
  }, "preview-cloud-release");
  const firestore = firebaseAdminRuntime.getFirestore(app);
  try {
    if (operation === "preflight") {
      await verifyCloudPreviewDependencies(firestore, rawStorage, token, publicationAccess);
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
      try { await deployPreviewRuntime({ firestore, rendererSha, token, rawAccount, rawStorage, publicationAccess }); }
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
