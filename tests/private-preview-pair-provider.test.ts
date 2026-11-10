import { expect, it, vi } from "vitest";
import { privatePreviewPairConfiguration, createPrivatePreviewPairProvider } from "../scripts/lib/private-preview-pair-provider.mjs";
import { previewProviderFixture, versionId, namespaceId } from "./helpers/private-preview-provider-fixture.js";
const provider = (f: Awaited<ReturnType<typeof previewProviderFixture>>, overrides = {}) => createPrivatePreviewPairProvider({
  prepared: f.prepared, operationDigest: "a".repeat(64), readToken: () => "synthetic-api", readSecret: async () => "synthetic-binding", fetchImpl: f.request, ...overrides });
it("seals readiness before version assignment, defaults off and never embeds a fake UUID", async () => {
  const f = await previewProviderFixture(); expect(f.prepared).not.toHaveProperty("workerVersion");
  const off = privatePreviewPairConfiguration(f.descriptor, { main: f.config.main, image: f.image });
  expect(off.vars.PREVIEW_RENDERER_ENABLED).toBe("false"); expect(off.vars).not.toHaveProperty("PREVIEW_WORKER_VERSION");
  expect(off.version_metadata).toEqual({ binding: "PREVIEW_WORKER_VERSION" });
  expect(off.secrets.required).toHaveLength(3); expect(f.prepared.rendererReady).toBe(true);
});
it("identical sealed resources keep their configuration identity across clean checkout locations", async () => {
  const f = await previewProviderFixture(), relocated = await f.prepare(f.metadata, { ...f.config, main: "/another-clean-checkout/preview-renderer/worker.ts" });
  expect(relocated.bundleDigest).toBe(f.prepared.bundleDigest);
  expect(relocated.configurationDigest).toBe(f.prepared.configurationDigest);
});
it.each(["readiness", "image", "name", "secret", "binding", "export"])("refuses changed %s sealed input", async field => {
  const f = await previewProviderFixture(), metadata = structuredClone(f.metadata), config = structuredClone(f.config);
  if (field === "readiness") config.vars.PREVIEW_RENDERER_ENABLED = "yes";
  if (field === "image") config.containers[0].image += "changed";
  if (field === "name") config.name = "njpbs-cms-preview-renderer";
  if (field === "secret") metadata.bindings.find((b: any) => b.type === "inherit").text = "synthetic-secret";
  if (field === "binding") metadata.bindings.push({ name: "unexpected", type: "plain_text", text: "x" });
  if (field === "export") metadata.exports.PreviewRenderer.storage = "unsafe";
  await expect(f.prepare(metadata, config)).rejects.toThrow("provider refused");
});
it("uploads moment-of-use secret bindings and reads independent module/config/namespace/application endpoints", async () => {
  const f = await previewProviderFixture(), secret = vi.fn(async () => "synthetic-binding"), p = provider(f, { readSecret: secret });
  expect(secret).not.toHaveBeenCalled(); await p.createIdentity(); await p.upload(); expect(secret).toHaveBeenCalledTimes(3);
  await p.deploy(versionId); expect((await p.namespace(versionId)).namespaceId).toBe(namespaceId);
  await p.createContainer(namespaceId); await p.createSchedules();
  expect(await p.version(versionId)).toMatchObject({ versionId, bundleDigest: f.prepared.bundleDigest });
  expect(await p.container(namespaceId)).toMatchObject({ namespaceId, imageDigest: f.descriptor.imageDigest });
  expect((await p.privateInventory()).private).toBe(true); expect(await p.schedules()).toEqual({ crons: ["* * * * *"] });
  expect(f.state.requests.some(r => r.path.includes("/workers/workers/") && r.path.endsWith(versionId))).toBe(true);
});
it.each(["bytes", "image"])("rejects provider %s drift despite matching names and IDs", async field => {
  const f = await previewProviderFixture(), p = provider(f); f.state.deployed = true; f.state.version = true; f.state.container = true; f.state.corrupt = field;
  if (field === "bytes") await expect(p.version(versionId)).rejects.toThrow(); else await expect(p.container(namespaceId)).rejects.toThrow();
});
it("opaque handles cannot be forged and lost mutation replies never trigger a second send", async () => {
  const f = await previewProviderFixture(); expect(() => createPrivatePreviewPairProvider({ prepared: structuredClone(f.prepared), operationDigest: "a".repeat(64), readToken: () => "synthetic", readSecret: () => "synthetic" })).toThrow();
  f.state.lostAction = "version"; const p = provider(f);
  await expect(p.upload()).rejects.toMatchObject({ uncertain: true }); expect(f.state.writes).toEqual(["version"]);
  expect((await p.recoverVersion()).versionId).toBe(versionId); expect(f.state.writes).toEqual(["version"]);
});
it("pre-send cancellation and credential failures are definite; redirects and provider text remain private", async () => {
  const f = await previewProviderFixture(), fetchImpl = vi.fn(), abort = new AbortController(); abort.abort();
  await expect(provider(f, { signal: abort.signal, fetchImpl }).createIdentity()).rejects.toMatchObject({ name: "PrivateProviderNotSent" }); expect(fetchImpl).not.toHaveBeenCalled();
  await expect(provider(f, { readToken: () => { throw new Error("synthetic-private-value"); } }).worker()).rejects.toMatchObject({ message: "Private preview provider refused", uncertain: false });
  await expect(provider(f, { fetchImpl: async () => new Response("synthetic-private-value", { status: 302 }) }).createIdentity()).rejects.toMatchObject({ message: "Private preview provider refused", uncertain: true });
});
it("seals and uploads both Access bindings only for the development environment", async () => {
  const f = await previewProviderFixture({ environment: "development" }), secret = vi.fn(async (_name: string) => "synthetic-binding"), p = provider(f, { readSecret: secret });
  expect(f.config.secrets.required).toEqual(["FIREBASE_SERVICE_ACCOUNT", "R2_PREVIEW_CREDENTIAL", "CMS_EDGE_ORIGIN_SECRET", "CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET"]);
  await p.createIdentity(); await p.upload(); expect(secret.mock.calls.map(c => c[0])).toEqual(f.config.secrets.required);
  expect((await p.version(versionId)).configurationDigest).toBe(f.prepared.configurationDigest);
});
