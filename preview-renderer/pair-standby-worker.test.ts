import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authority: vi.fn(), pending: vi.fn(), get: vi.fn(), fetch: vi.fn(), stop: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class { env: unknown; constructor(_ctx: unknown, env: unknown) { this.env = env; } } }));
vi.mock("@cloudflare/containers", () => ({ Container: class { env: unknown; constructor(_ctx: unknown, env: unknown) { this.env = env; } }, getContainer: mocks.get }));
vi.mock("./pending-work", () => ({ hasPendingPreviewWork: mocks.pending }));
vi.mock("./pair-authority", () => ({ readPrivatePreviewPairAuthority: mocks.authority }));
import Worker, { PreviewRenderer } from "./worker";
const identity = { pairId: "preview-new", rendererSha: "b".repeat(40), serializerId: "preview-new" };
const version = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const env = { PREVIEW_PAIR_MODE: "true", PREVIEW_RENDERER_ENABLED: "true", PREVIEW_RENDERER_SHA: identity.rendererSha,
  PREVIEW_SERIALIZER_ID: identity.pairId, PREVIEW_WORKER_VERSION: { id: version }, FIREBASE_SERVICE_ACCOUNT: "synthetic",
  R2_PREVIEW_CREDENTIAL: "synthetic", CMS_EDGE_ORIGIN_SECRET: "synthetic", RENDERER: {} } as Env;
const worker = (overrides = {}) => new Worker({} as ExecutionContext, { ...env, ...overrides });
beforeEach(() => {
  vi.clearAllMocks(); mocks.authority.mockResolvedValue({ mode: "candidate" }); mocks.pending.mockResolvedValue(true);
  mocks.get.mockReturnValue({ fetch: mocks.fetch, stop: mocks.stop });
  mocks.fetch.mockImplementation(async () => Response.json({ status: "ready", ...identity, workerVersion: version }));
});
it("private preflight checks candidate health only with actual Worker UUID and no work lookup", async () => {
  expect(await worker().preflight(identity)).toEqual({ ready: true, ...identity, workerVersion: version });
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith("http://container/health", undefined);
  expect(mocks.authority).toHaveBeenCalledTimes(2); expect(mocks.pending).not.toHaveBeenCalled();
});
it("candidate cron and wake do not start, stop or claim either renderer", async () => {
  await worker().scheduled(); await worker().wake(identity.rendererSha);
  expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.pending).not.toHaveBeenCalled();
});
it("missing or expired candidate authority makes work ticks quiet while health remains strict", async () => {
  mocks.authority.mockImplementation(async (_env, _request, options) => {
    if (options?.work) return { mode: "unretained" };
    throw new Error("Unavailable or expired candidate pointer");
  });
  await expect(worker().scheduled()).resolves.toBeUndefined();
  await expect(worker().wake(identity.rendererSha)).resolves.toBeUndefined();
  expect((await worker().preflight(identity)).ready).toBe(false);
  expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.pending).not.toHaveBeenCalled();
});
it("loss of retention after pending-work lookup cannot wake the old Container", async () => {
  mocks.authority.mockResolvedValueOnce({ mode: "retained" }).mockResolvedValueOnce({ mode: "unretained" });
  await expect(worker().scheduled()).resolves.toBeUndefined(); expect(mocks.pending).toHaveBeenCalledOnce(); expect(mocks.get).not.toHaveBeenCalled();
});
it("unexpected work-authority failures remain observable and cannot start a Container", async () => {
  mocks.authority.mockRejectedValue(new Error("Authority transport failed"));
  await expect(worker().scheduled()).rejects.toThrow("Authority transport failed");
  expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.pending).not.toHaveBeenCalled();
});
it("retained pending work starts this pair through POST wake only", async () => {
  mocks.authority.mockResolvedValue({ mode: "retained" });
  await worker().wake(identity.rendererSha, version);
  expect(mocks.pending).toHaveBeenCalledWith(expect.objectContaining({ serializerId: identity.pairId, workerVersion: version }));
  expect(mocks.get).toHaveBeenCalledWith(env.RENDERER, identity.pairId);
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith("http://container/wake", { method: "POST", headers: { "x-njpbs-preview-request-id": version } });
});
it("disabled immutable configuration does not start or stop a private candidate", async () => {
  const disabled = worker({ PREVIEW_RENDERER_ENABLED: "false" });
  await disabled.scheduled(); await disabled.wake(identity.rendererSha);
  expect((await disabled.preflight(identity)).ready).toBe(false); expect(mocks.get).not.toHaveBeenCalled();
});
it("billing/authority, identity and actual-version failures refuse private health", async () => {
  expect((await worker().preflight({ ...identity, serializerId: "preview-other" })).ready).toBe(false);
  expect(mocks.authority).not.toHaveBeenCalled();
  mocks.authority.mockRejectedValueOnce(new Error("private credential"));
  expect(await worker().preflight(identity)).toEqual({ ready: false, pairId: identity.pairId, reason: "not-ready" });
  expect(mocks.get).not.toHaveBeenCalled();
  mocks.fetch.mockResolvedValue(Response.json({ status: "ready", ...identity, workerVersion: "wrong" }));
  expect((await worker().preflight(identity)).ready).toBe(false);
});
it("public fetch and missing credentials cannot start the container", async () => {
  expect(worker().fetch().status).toBe(404);
  expect((await worker({ CMS_EDGE_ORIGIN_SECRET: undefined }).preflight(identity)).ready).toBe(false);
  expect(mocks.get).not.toHaveBeenCalled();
});
it("passes pair-only inputs to its Container, preserving legacy environment", () => {
  expect(new PreviewRenderer({} as DurableObjectState, env).envVars).toMatchObject({
    CMS_PREVIEW_PAIR_MODE: "true", CMS_PREVIEW_WORKER_VERSION: version, CMS_EDGE_ORIGIN_SECRET: "synthetic" });
});
