import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pending: vi.fn(), get: vi.fn(), fetch: vi.fn(), stop: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {
  env: unknown;
  constructor(_ctx: unknown, env: unknown) { this.env = env; }
} }));
vi.mock("@cloudflare/containers", () => ({ Container: class {
  env: unknown;
  constructor(_ctx: unknown, env: unknown) { this.env = env; }
}, getContainer: mocks.get }));
vi.mock("./pending-work", () => ({ hasPendingPreviewWork: mocks.pending }));
import Worker, { PreviewRenderer } from "./worker";
const sha = "a".repeat(40);
const env = { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), PREVIEW_RENDERER_ENABLED: "true", PREVIEW_RENDERER_SHA: sha,
  PREVIEW_SERIALIZER_ID: "cloud-preview", FIREBASE_SERVICE_ACCOUNT: "synthetic",
  R2_PREVIEW_CREDENTIAL: "synthetic", RENDERER: {} } as Env;
const worker = (overrides = {}) => new Worker({} as ExecutionContext, { ...env, ...overrides });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReturnValue({ fetch: mocks.fetch, stop: mocks.stop });
  mocks.pending.mockResolvedValue(true);
  mocks.fetch.mockImplementation(async () => Response.json({ status: "ready", rendererSha: sha, serializerId: "cloud-preview" }));
});
describe("private renderer wake", () => {
  it("passes the account to production and Access credentials only to development", () => {
    const production = new PreviewRenderer({} as DurableObjectState, env);
    expect(production.envVars).toEqual({ CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, CMS_PREVIEW_RENDERER_SHA: sha,
      CMS_PREVIEW_SERIALIZER_ID: "cloud-preview", CMS_PREVIEW_FIREBASE_ACCOUNT: "synthetic",
      CMS_PREVIEW_R2_CREDENTIAL: "synthetic" });
    const development = new PreviewRenderer({} as DurableObjectState, { ...env,
      CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev",
      CMS_DEV_ACCESS_CLIENT_ID: "fixture-id", CMS_DEV_ACCESS_CLIENT_SECRET: "fixture-secret" });
    expect(development.envVars).toMatchObject({ CMS_DEPLOYMENT_ENVIRONMENT: "development",
      CMS_DEV_ACCESS_CLIENT_ID: "fixture-id", CMS_DEV_ACCESS_CLIENT_SECRET: "fixture-secret" });
  });
  it.each(["production", "development"])("forwards the %s account into a real container process", environment => {
    const account = "b".repeat(32);
    const bindings = { ...env, CLOUDFLARE_ACCOUNT_ID: account, CMS_DEPLOYMENT_ENVIRONMENT: environment };
    const runtime = new PreviewRenderer({} as DurableObjectState, bindings);
    bindings.CLOUDFLARE_ACCOUNT_ID = "c".repeat(32);
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval",
      'import { cloudflareR2Endpoint } from "./site/scripts/cloudflare-account.mjs"; process.stdout.write(cloudflareR2Endpoint());',
    ], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 5_000,
      env: { PATH: process.env.PATH, ...runtime.envVars } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`https://${account}.r2.cloudflarestorage.com`);
  });
  it("starts the existing singleton for concurrent signals and cron", async () => {
    await Promise.all([worker().wake(sha), worker().wake(sha), worker().scheduled()]);
    expect(mocks.get.mock.calls).toEqual(Array(3).fill([env.RENDERER, "preview-serializer"]));
    expect(mocks.pending).toHaveBeenCalledTimes(3);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });
  it("does not start or stop on a disabled wake; cron retains shutdown", async () => {
    const disabled = worker({ PREVIEW_RENDERER_ENABLED: "false" });
    await disabled.wake(sha);
    expect(mocks.get).not.toHaveBeenCalled();
    await disabled.scheduled();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
  it("does not start without pending work", async () => {
    mocks.pending.mockResolvedValue(false);
    await worker().wake(sha);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("preserves runtime/journal rejection", async () => {
    mocks.pending.mockRejectedValue(new Error("Runtime invalid"));
    await expect(worker().wake(sha)).rejects.toThrow("Runtime invalid");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rejects mismatched health", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ status: "ready", rendererSha: "b".repeat(40), serializerId: "cloud-preview" }));
    await expect(worker().wake(sha)).rejects.toThrow("release differs");
  });
  it("passes the dev tuple to pending-work admission", async () => {
    await worker({ CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev",
      CMS_DEV_ACCESS_CLIENT_ID: "fixture-id", CMS_DEV_ACCESS_CLIENT_SECRET: "fixture-secret" }).wake(sha);
    expect(mocks.pending).toHaveBeenCalledWith(expect.objectContaining({
      deploymentEnvironment: "development", projectId: "njpbs-site-dev",
    }));
  });
  it("refuses mixed targets or missing dev Access before polling", async () => {
    await expect(worker({ CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site" }).wake(sha))
      .rejects.toThrow("target differs");
    await expect(worker({ CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev" }).wake(sha))
      .rejects.toThrow("Access credentials");
    expect(mocks.pending).not.toHaveBeenCalled();
  });
});

it("routes paired wake and recovery to its isolated container key and actual version", async () => {
  mocks.fetch.mockResolvedValue(Response.json({ status: "ready", rendererSha: sha, serializerId: "preview-old" }));
  const paired = worker({ PREVIEW_SERIALIZER_ID: "preview-old", PREVIEW_WORKER_VERSION: { id: "actual-provider-version" } });
  await paired.wake(sha);
  expect(mocks.get).toHaveBeenCalledWith(env.RENDERER, "preview-old");
  expect(mocks.pending).toHaveBeenCalledWith(expect.objectContaining({ serializerId: "preview-old", workerVersion: "actual-provider-version" }));
});
it("public requests cannot start either retained container", async () => {
  expect(worker({ PREVIEW_SERIALIZER_ID: "preview-old" }).fetch().status).toBe(404);
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.pending).not.toHaveBeenCalled();
});
