import { Container, getContainer } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";
import { readPrivateCurrentCode, readPrivateCurrentCodeReference } from "./record-code-source";
import { hasPendingPreviewWork } from "./pending-work";
import { previewOutputTarget } from "../site/scripts/preview-output-target.mjs";
import { readPrivatePreviewPairAuthority } from "./pair-authority";
import { wakeDiagnostics } from "./wake-diagnostics";

export class PreviewRenderer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "3m";
  envVars = {
    CLOUDFLARE_ACCOUNT_ID: this.env.CLOUDFLARE_ACCOUNT_ID,
    CMS_PREVIEW_RENDERER_SHA: this.env.PREVIEW_RENDERER_SHA,
    CMS_PREVIEW_SERIALIZER_ID: this.env.PREVIEW_SERIALIZER_ID,
    CMS_PREVIEW_FIREBASE_ACCOUNT: this.env.FIREBASE_SERVICE_ACCOUNT,
    CMS_PREVIEW_R2_CREDENTIAL: this.env.R2_PREVIEW_CREDENTIAL,
    ...(this.env.PREVIEW_PAIR_MODE === "true" ? {
      CMS_PREVIEW_PAIR_MODE: "true", CMS_PREVIEW_WORKER_VERSION: this.env.PREVIEW_WORKER_VERSION?.id ?? "",
      CMS_EDGE_ORIGIN_SECRET: this.env.CMS_EDGE_ORIGIN_SECRET ?? "",
    } : {}),
    ...(this.env.CMS_DEPLOYMENT_ENVIRONMENT === "development" ? {
      CMS_DEPLOYMENT_ENVIRONMENT: "development",
      CMS_DEV_ACCESS_CLIENT_ID: this.env.CMS_DEV_ACCESS_CLIENT_ID ?? "",
      CMS_DEV_ACCESS_CLIENT_SECRET: this.env.CMS_DEV_ACCESS_CLIENT_SECRET ?? "",
    } : {}),
  };
}

export default class extends WorkerEntrypoint<Env> {
  fetch() {
    // No incoming web request can start the renderer or read its health/data.
    return new Response(null, { status: 404 });
  }
  async readCurrentCode(rendererSha: string) {
    return readPrivateCurrentCode(this.env, rendererSha);
  }
  async readCurrentCodeReference(rendererSha: string) {
    return readPrivateCurrentCodeReference(this.env, rendererSha);
  }
  async preflight(identity: { pairId: string; rendererSha: string; serializerId: string }) {
    const refused = { ready: false, pairId: this.env.PREVIEW_SERIALIZER_ID, reason: "not-ready" };
    if (this.env.PREVIEW_PAIR_MODE !== "true" || this.env.PREVIEW_RENDERER_ENABLED !== "true") return refused;
    if (!identity || Object.keys(identity).length !== 3 || identity.pairId !== this.env.PREVIEW_SERIALIZER_ID ||
        identity.serializerId !== identity.pairId || identity.rendererSha !== this.env.PREVIEW_RENDERER_SHA) return refused;
    try {
      await readPrivatePreviewPairAuthority(this.env);
      const health = await pairContainerHealth(this.env, "/health");
      await readPrivatePreviewPairAuthority(this.env);
      return { ready: true, pairId: identity.pairId, rendererSha: identity.rendererSha,
        serializerId: identity.serializerId, workerVersion: health.workerVersion };
    } catch { return refused; }
  }
  async wake(rendererSha: string, requestId?: string): Promise<void> {
    if (this.env.PREVIEW_RENDERER_ENABLED !== "true") return;
    if (!/^[a-f0-9]{40}$/.test(rendererSha) || rendererSha !== this.env.PREVIEW_RENDERER_SHA) {
      throw new Error("Cloud preview wake release differs");
    }
    const measure = wakeDiagnostics(this.env, requestId);
    await measure("wake", () => startPendingRenderer(this.env, measure));
  }
  async scheduled(): Promise<void> {
    const measure = wakeDiagnostics(this.env);
    await measure("wake", () => startPendingRenderer(this.env, measure));
  }
}

async function startPendingRenderer(env: Env, measure: ReturnType<typeof wakeDiagnostics>): Promise<void> {
  if (env.PREVIEW_PAIR_MODE !== undefined) {
    if (env.PREVIEW_PAIR_MODE !== "true") throw new Error("Invalid private preview mode");
    if (env.PREVIEW_RENDERER_ENABLED !== "true") return;
    const retained = async () => (await measure("pair-authority", () => readPrivatePreviewPairAuthority(env, undefined, { work: true }))).mode === "retained";
    // Missing/expired candidate pointers are normal standby states. Health
    // still refuses strictly; work ticks simply gain no startup permission.
    if (!await retained()) return;
    const target = previewOutputTarget(env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production", env.FIREBASE_PROJECT_ID ?? "njpbs-site");
    if (!await measure("pending-work", () => hasPendingPreviewWork({ account: env.FIREBASE_SERVICE_ACCOUNT, rendererSha: env.PREVIEW_RENDERER_SHA,
      serializerId: env.PREVIEW_SERIALIZER_ID, workerVersion: env.PREVIEW_WORKER_VERSION?.id,
      deploymentEnvironment: target.environment, projectId: target.projectId }))) return;
    if (!await retained()) return;
    await measure("container-request", () => pairContainerHealth(env, "/wake", measure.requestId));
    return;
  }
  const target = previewOutputTarget(env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production", env.FIREBASE_PROJECT_ID ?? "njpbs-site");
  const paired = /^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(env.PREVIEW_SERIALIZER_ID);
  const renderer = getContainer(env.RENDERER, paired ? env.PREVIEW_SERIALIZER_ID : "preview-serializer");
  if (env.PREVIEW_RENDERER_ENABLED !== "true") {
    await renderer.stop();
    return;
  }
  if (!/^[a-f0-9]{40}$/.test(env.PREVIEW_RENDERER_SHA) || !env.FIREBASE_SERVICE_ACCOUNT || !env.R2_PREVIEW_CREDENTIAL) {
    throw new Error("Cloud preview renderer release is not configured");
  }
  if (target.environment === "development" && (!env.CMS_DEV_ACCESS_CLIENT_ID || !env.CMS_DEV_ACCESS_CLIENT_SECRET)) {
    throw new Error("Development preview Access credentials are required");
  }
  if (!await measure("pending-work", () => hasPendingPreviewWork({ account: env.FIREBASE_SERVICE_ACCOUNT,
    rendererSha: env.PREVIEW_RENDERER_SHA, serializerId: env.PREVIEW_SERIALIZER_ID,
    workerVersion: env.PREVIEW_WORKER_VERSION?.id,
    deploymentEnvironment: target.environment, projectId: target.projectId }))) return;
  await measure("container-request", async () => {
    const response = await renderer.fetch("http://container/health", { headers: { "x-njpbs-preview-request-id": measure.requestId } });
    if (!response.ok) throw new Error("Cloud preview renderer is not ready");
    const health = await response.json<{ status: string; rendererSha: string; serializerId: string }>();
    if (health.status !== "ready" || health.rendererSha !== env.PREVIEW_RENDERER_SHA || health.serializerId !== env.PREVIEW_SERIALIZER_ID) {
      throw new Error("Cloud preview renderer release differs");
    }
    console.log(JSON.stringify({ event: "preview-renderer-ready", rendererSha: health.rendererSha }));
    return health;
  });
}

async function pairContainerHealth(env: Env, path: "/health" | "/wake", requestId?: string) {
  if (!env.FIREBASE_SERVICE_ACCOUNT || !env.R2_PREVIEW_CREDENTIAL || !env.CMS_EDGE_ORIGIN_SECRET ||
      !env.PREVIEW_WORKER_VERSION?.id) throw new Error("Private preview inputs are unavailable");
  const renderer = getContainer(env.RENDERER, env.PREVIEW_SERIALIZER_ID);
  const response = await renderer.fetch(`http://container${path}`, path === "/wake"
    ? { method: "POST", headers: { "x-njpbs-preview-request-id": requestId! } } : undefined);
  if (!response.ok) { await response.body?.cancel(); throw new Error("Private preview runtime is unavailable"); }
  const health = await response.json<{ status: string; pairId: string; rendererSha: string; serializerId: string; workerVersion: string }>();
  if (health.status !== "ready" || health.pairId !== env.PREVIEW_SERIALIZER_ID || health.rendererSha !== env.PREVIEW_RENDERER_SHA ||
      health.serializerId !== env.PREVIEW_SERIALIZER_ID || health.workerVersion !== env.PREVIEW_WORKER_VERSION.id) throw new Error("Private preview runtime identity differs");
  return health;
}
