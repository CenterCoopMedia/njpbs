// @vitest-environment node
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listener: vi.fn(), process: vi.fn(), editorial: vi.fn(), close: vi.fn(), removeApp: vi.fn(), standby: vi.fn() }));
vi.mock("../scripts/cms-preview-pair-state.ts", () => ({ preparePreviewPairStateDirectory: async () => "/private/pair" }));
vi.mock("../scripts/cms-preview-storage-credential.ts", () => ({ parsePreviewStorageCredential: () => ({ accessKeyId: "synthetic", secretAccessKey: "synthetic" }) }));
vi.mock("../scripts/firebase-admin-runtime.ts", () => ({ firebaseAdminRuntime: { initializeApp: () => ({}), cert: () => ({}),
  getFirestore: () => ({}), deleteApp: mocks.removeApp } }));
vi.mock("../scripts/cms-preview-pair-context.ts", () => ({ createPreviewPairContextReader: () => async () => ({}) }));
vi.mock("../scripts/cms-preview-cloud-storage.ts", () => ({ createCmsPreviewCloudStorage: () => ({ readEditorialPublicContext: mocks.editorial, close: mocks.close }) }));
vi.mock("../scripts/cms-preview-serializer-service.ts", () => ({ startCmsPreviewSerializerService: mocks.listener }));
vi.mock("../scripts/cms-preview-pair-standby.ts", () => ({ servePreviewPairStandby: mocks.standby }));
vi.mock("../scripts/process-cms-preview.ts", () => ({ processCmsPreview: mocks.process, removePrivatePreviewJob: vi.fn() }));
import { serveCmsPreviewPairCloud } from "../scripts/cms-preview-pair-cloud-runtime";
it("forwards the real processor refreshing callback through the paired runtime to storage", async () => {
  mocks.standby.mockResolvedValue({ closed: Promise.resolve() });
  await serveCmsPreviewPairCloud({ rawAccount: JSON.stringify({ type: "service_account", project_id: "njpbs-site",
    client_email: "preview@njpbs-site.iam.gserviceaccount.com", private_key: "x".repeat(64) }), rawStorage: "synthetic",
    rendererSha: "a".repeat(40), serializerId: "preview-next", workerVersion: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    deploymentEnvironment: "production", readSecret: () => "synthetic", createTransport: vi.fn() });
  expect(mocks.listener).not.toHaveBeenCalled();
  await mocks.standby.mock.calls[0][0].startListener();
  const refresh = vi.fn();
  mocks.process.mockImplementationOnce(async options => options.dependencies.readPublicContext(refresh));
  await mocks.listener.mock.calls[0][0].dependencies.process({});
  expect(mocks.editorial).toHaveBeenCalledExactlyOnceWith(expect.anything(), refresh);
  expect(mocks.close).toHaveBeenCalledOnce(); expect(mocks.removeApp).toHaveBeenCalledOnce();
});
