// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ initialize: vi.fn(), removeApp: vi.fn(), context: vi.fn(), editorialContext: vi.fn(), storageClose: vi.fn(),
  prepareState: vi.fn(), identity: vi.fn(), ready: vi.fn(), index: vi.fn(), listener: vi.fn(), serverClose: vi.fn() }));
vi.mock("../scripts/cms-preview-pair-state.ts", () => ({ preparePreviewPairStateDirectory: mocks.prepareState }));
vi.mock("node:http", () => ({ createServer: () => ({ once: vi.fn(), listen: (_port: number, _host: string, done: () => void) => done(),
  close: (done: () => void) => { mocks.serverClose(); done(); } }) }));
vi.mock("../scripts/cms-preview-storage-credential.ts", () => ({ parsePreviewStorageCredential: () => ({}) }));
vi.mock("../scripts/firebase-admin-runtime.ts", () => ({ firebaseAdminRuntime: {
  initializeApp: mocks.initialize, cert: () => ({}), deleteApp: mocks.removeApp,
  getFirestore: () => ({ collection: () => {
    const query = { where: () => query, select: () => query, limit: () => query, get: mocks.index };
    return query;
  } }),
} }));
vi.mock("../scripts/cms-preview-cloud-storage.ts", () => ({ createCmsPreviewCloudStorage: () => ({
  readPublicContext: mocks.context, readEditorialPublicContext: mocks.editorialContext, close: mocks.storageClose,
}) }));
vi.mock("../scripts/cms-preview-serializer-service.ts", () => ({ startCmsPreviewSerializerService: mocks.listener }));
vi.mock("../scripts/cms-preview-cloud-control.ts", () => ({ assertPreviewRuntimeIdentity: mocks.identity,
  confirmPreviewRuntimeReady: mocks.ready }));
vi.mock("../scripts/cms-preview-cloud-token-journal.ts", () => ({ openCmsPreviewCloudTokenJournal: vi.fn() }));
vi.mock("../scripts/process-cms-preview.ts", () => ({ processCmsPreview: vi.fn(), removePrivatePreviewJob: vi.fn() }));
import { serveCmsPreviewCloud } from "../scripts/cms-preview-cloud-runtime.ts";
import { previewDiagnostics } from "../scripts/preview-diagnostics.ts";
function start(deploymentEnvironment = "production", project = "njpbs-site", serializerId = "cloudflare-preview") {
  return serveCmsPreviewCloud({ rawAccount: JSON.stringify({ type: "service_account", project_id: project, client_email: `preview@${project}.iam.gserviceaccount.com`, private_key: "x".repeat(64) }),
    deploymentEnvironment, rawStorage: "fixture", rendererSha: "a".repeat(40),
    serializerId, nodeStartupMs: 1, measure: previewDiagnostics({ rendererSha: "a".repeat(40) }, () => {}) });
}
beforeEach(() => { vi.clearAllMocks(); for (const mock of Object.values(mocks)) mock.mockResolvedValue(undefined); });
afterEach(() => vi.restoreAllMocks());
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function pendingProbes() {
  const probes = [deferred(), deferred(), deferred()];
  [mocks.identity, mocks.context, mocks.index].forEach((mock, index) => mock.mockReturnValue(probes[index].promise));
  return probes;
}
it("starts with code context even when new editorial input is unavailable", async () => {
  mocks.editorialContext.mockRejectedValue(new Error("editorial publication pending"));
  const probes = pendingProbes();
  mocks.listener.mockResolvedValue({ stop: vi.fn(), closed: Promise.resolve() });
  const result = start();
  await vi.waitFor(() => expect(mocks.index).toHaveBeenCalledOnce());
  expect(mocks.identity).toHaveBeenCalledOnce(); expect(mocks.context).toHaveBeenCalledOnce();
  expect(mocks.listener).not.toHaveBeenCalled(); expect(mocks.ready).not.toHaveBeenCalled();
  probes[2].resolve(); probes[0].resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(mocks.listener).not.toHaveBeenCalled(); expect(mocks.storageClose).not.toHaveBeenCalled();
  probes[1].resolve(); await result;
  expect(mocks.listener).toHaveBeenCalledOnce(); expect(mocks.ready).toHaveBeenCalledOnce();
  expect(mocks.storageClose).toHaveBeenCalledOnce(); expect(mocks.removeApp).toHaveBeenCalledOnce();
  expect(mocks.editorialContext).not.toHaveBeenCalled();
});
it.each([0, 1, 2])("drains every read after probe %s fails before cleanup or listener startup", async failed => {
  const probes = pendingProbes();
  const result = start();
  const rejected = expect(result).rejects.toThrow(`probe ${failed} failed`);
  await vi.waitFor(() => expect(mocks.index).toHaveBeenCalledOnce());
  probes[failed].reject(new Error(`probe ${failed} failed`));
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(mocks.listener).not.toHaveBeenCalled(); expect(mocks.ready).not.toHaveBeenCalled();
  expect(mocks.storageClose).not.toHaveBeenCalled(); expect(mocks.removeApp).not.toHaveBeenCalled();
  probes.forEach((probe, index) => { if (index !== failed) probe.resolve(); });
  await rejected;
  expect(mocks.listener).not.toHaveBeenCalled(); expect(mocks.ready).not.toHaveBeenCalled();
  expect(mocks.storageClose).toHaveBeenCalledOnce(); expect(mocks.removeApp).toHaveBeenCalledOnce();
  expect(mocks.serverClose).toHaveBeenCalledOnce();
});
it("reports identity failure first even when context and index reject earlier", async () => {
  const probes = pendingProbes();
  const result = start(); const rejected = expect(result).rejects.toThrow("release mismatch");
  await vi.waitFor(() => expect(mocks.index).toHaveBeenCalledOnce());
  probes[2].reject(new Error("index unavailable")); probes[1].reject(new Error("context unavailable"));
  await new Promise<void>(resolve => setImmediate(resolve)); expect(mocks.storageClose).not.toHaveBeenCalled();
  probes[0].reject(new Error("release mismatch")); await rejected;
  expect(mocks.listener).not.toHaveBeenCalled(); expect(mocks.removeApp).toHaveBeenCalledOnce();
});
it("keeps the listener alive until stop and closes every owned resource", async () => {
  let closeListener!: () => void;
  const stop = vi.fn(() => closeListener());
  mocks.listener.mockResolvedValue({ stop, closed: new Promise<void>(resolve => { closeListener = resolve; }) });
  const handlers = new Map<string, () => void>();
  vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
    handlers.set(event, handler); return process;
  }) as typeof process.on);
  const result = start();
  await vi.waitFor(() => expect(mocks.ready).toHaveBeenCalledOnce());
  expect(mocks.storageClose).not.toHaveBeenCalled();
  handlers.get("SIGTERM")!();
  await result;
  expect(stop).toHaveBeenCalled();
  expect(mocks.storageClose).toHaveBeenCalledOnce();
  expect(mocks.removeApp).toHaveBeenCalledOnce();
  expect(mocks.serverClose).toHaveBeenCalledOnce();
});


it("accepts the dev service account only in the explicit development runtime", async () => {
  mocks.listener.mockResolvedValue({ stop: vi.fn(), closed: Promise.resolve() });
  await expect(start("development", "njpbs-site-dev")).resolves.toBeUndefined();
  expect(mocks.listener).toHaveBeenCalledWith(expect.objectContaining({
    deploymentEnvironment: "development", projectId: "njpbs-site-dev",
  }));
  expect(mocks.initialize.mock.calls[0][0].projectId).toBe("njpbs-site-dev");
  await expect(start("development", "njpbs-site")).rejects.toThrow(/Firebase credential input is invalid/);
  await expect(start("production", "njpbs-site-dev")).rejects.toThrow(/Firebase credential input is invalid/);
  await expect(start("unknown", "njpbs-site")).rejects.toThrow(/Invalid preview environment/);
});

it("creates paired state before starting the listener and refuses unsafe state before SDK startup", async () => {
  mocks.prepareState.mockResolvedValue("/var/lib/njpbs-cms-preview/preview-old");
  mocks.listener.mockResolvedValue({ stop: vi.fn(), closed: Promise.resolve() });
  await start("production", "njpbs-site", "preview-old");
  expect(mocks.prepareState).toHaveBeenCalledExactlyOnceWith("/var/lib/njpbs-cms-preview", "preview-old");
  expect(mocks.listener).toHaveBeenCalledWith(expect.objectContaining({ stateDirectory: "/var/lib/njpbs-cms-preview/preview-old" }));
  expect(mocks.prepareState.mock.invocationCallOrder[0]).toBeLessThan(mocks.listener.mock.invocationCallOrder[0]);
  vi.clearAllMocks();
  mocks.prepareState.mockRejectedValue(new Error("unsafe state"));
  await expect(start("production", "njpbs-site", "preview-old")).rejects.toThrow("unsafe state");
  expect(mocks.initialize).not.toHaveBeenCalled();
  expect(mocks.listener).not.toHaveBeenCalled();
});
