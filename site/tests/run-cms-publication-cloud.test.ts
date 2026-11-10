// @vitest-environment node
import { expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => {
  const unwatch = vi.fn();
  return {
    unwatch,
    firestore: { doc: vi.fn(() => ({ onSnapshot: vi.fn((observe) => { observe({ exists: true }); return unwatch; }) })) },
    app: {},
    storage: { assertReady: vi.fn(async () => {}), close: vi.fn() },
    runtime: { closed: Promise.resolve(), stop: vi.fn(), wake: vi.fn(), isRunning: () => false },
    start: vi.fn(), ready: vi.fn(async () => {}), deleteApp: vi.fn(async () => {}),
  };
});
vi.mock("node:http", () => ({ createServer: vi.fn(() => ({
  once: vi.fn(), listen: vi.fn((_port, _host, ready) => ready()), close: vi.fn(done => done()),
})) }));
vi.mock("../scripts/activate-public-worker-candidate", () => ({ assertProviderDeploymentPathsSerialized: vi.fn() }));
vi.mock("../scripts/cms-publication-runtime-guard", () => ({ assertCmsPreviewSourceCheckout: vi.fn(async () => {}) }));
vi.mock("../scripts/run-cms-preview-serializer", () => ({ assertPreviewSandboxAvailable: vi.fn(async () => {}) }));
vi.mock("../scripts/cms-publication-inputs", () => ({
  assertProductionFirestoreRouting: vi.fn(), parseCmsPublicationFirebaseServiceAccount: vi.fn(() => ({})),
  parseCmsPublicationSerializerArguments: vi.fn(() => ({ commitSha: "a".repeat(40), serializerId: "cloud-test" })),
  parseCmsPublicationPublicBuildEnvironment: vi.fn(() => ({})),
  parseCmsPublicationMediaManagerCredential: vi.fn(() => ({ key: "fixture-key", secret: "fixture-secret" })),
}));
vi.mock("../scripts/cms-preview-storage-credential", () => ({ parsePreviewStorageCredential: vi.fn(() => ({})) }));
vi.mock("../scripts/firebase-admin-runtime", () => ({ firebaseAdminRuntime: {
  initializeApp: () => boundary.app, cert: vi.fn(), getFirestore: () => boundary.firestore, deleteApp: boundary.deleteApp,
} }));
vi.mock("../scripts/cms-publication-cloud-storage", () => ({ createCmsPublicationCloudStorage: () => boundary.storage }));
vi.mock("../scripts/cms-publication-cloud-control", () => ({
  assertPublicationRuntimeIdentity: vi.fn(async () => {}), confirmPublicationRuntimeReady: boundary.ready,
}));
vi.mock("../scripts/no-build-cloud-runtime", () => ({ startNoBuildCloudRuntime: (...args: unknown[]) => {
  boundary.start(...args); return boundary.runtime;
} }));

import {
  CloudPublicationStageError, describeCloudPublicationFailure, runCmsPublicationCloud,
} from "../scripts/run-cms-publication-cloud";
import { parseCmsPublicationPublicBuildEnvironment } from "../scripts/cms-publication-inputs";

it("starts the scoped runtime for the container command and closes its resources", async () => {
  const environment = { CLOUDFLARE_PUBLIC_WORKER_TAG: "d".repeat(32), CMS_PUBLICATION_ACTIVATION_TOKEN: "fixture".repeat(4), CMS_PUBLICATION_FIREBASE_ACCOUNT: "fixture-account",
    CMS_PUBLICATION_MEDIA_MANAGER_CREDENTIAL: "fixture-key\nfixture-secret" };
  await runCmsPublicationCloud("--serve", environment);
  expect(boundary.start).toHaveBeenCalledWith(expect.objectContaining({
    firestore: boundary.firestore, firebaseApp: boundary.app, commitSha: "a".repeat(40), serializerId: "cloud-test",
    mediaManagerCredential: { key: "fixture-key", secret: "fixture-secret" },
  }));
  expect(boundary.ready).toHaveBeenCalledOnce();
  expect(boundary.runtime.stop).toHaveBeenCalledOnce();
  expect(boundary.unwatch).toHaveBeenCalledOnce();
  expect(boundary.storage.close).toHaveBeenCalledOnce();
  expect(boundary.deleteApp).toHaveBeenCalledWith(boundary.app);
  expect(environment).toEqual({ CLOUDFLARE_PUBLIC_WORKER_TAG: "d".repeat(32) });
});

it("scrubs and refuses inherited Media Manager credentials before startup", async () => {
  const environment = { MEDIA_MANAGER_API_KEY: "fixture-inherited", CMS_PUBLICATION_MEDIA_MANAGER_CREDENTIAL: "fixture-key\nfixture-secret" };
  await expect(runCmsPublicationCloud("--serve", environment)).rejects.toThrow("refuses inherited Media Manager credentials");
  expect(environment).toEqual({});
});

it("keeps the optional image-storage binding out of the public build environment", async () => {
  const environment = { CLOUDFLARE_PUBLIC_WORKER_TAG: "d".repeat(32), CMS_PUBLICATION_ACTIVATION_TOKEN: "fixture".repeat(4), CMS_PUBLICATION_FIREBASE_ACCOUNT: "fixture-account",
    CMS_PUBLICATION_MEDIA_MANAGER_CREDENTIAL: "fixture-key\nfixture-secret", CMS_PUBLICATION_MEDIA_R2_CREDENTIAL: "fixture-media-binding",
    CMS_MEDIA_R2_ENDPOINT: "https://example.r2.cloudflarestorage.com", CMS_MEDIA_R2_BUCKET: "njpbs" };
  await runCmsPublicationCloud("--serve", environment);
  expect(vi.mocked(parseCmsPublicationPublicBuildEnvironment).mock.calls.at(-1)?.[0]).not.toHaveProperty("CMS_PUBLICATION_MEDIA_R2_CREDENTIAL");
  expect(boundary.start.mock.calls.at(-1)?.[0].spotlightImageStorageFactory).toEqual(expect.any(Function));
});

it("scrubs and refuses inherited public-media storage credentials", async () => {
  const environment = { CMS_MEDIA_R2_ACCESS_KEY_ID: "fixture-access", CMS_MEDIA_R2_SECRET_ACCESS_KEY: "fixture-secret" };
  await expect(runCmsPublicationCloud("--serve", environment)).rejects.toThrow("refuses inherited media storage credentials");
  expect(environment).toEqual({});
});

it("names the failed startup stage without printing provider output", async () => {
  const providerFailure = Object.assign(new Error("provider said fixture-private-detail"), { code: "ECONNRESET" });
  boundary.storage.assertReady.mockRejectedValueOnce(providerFailure);
  const environment = { CLOUDFLARE_PUBLIC_WORKER_TAG: "d".repeat(32), CMS_PUBLICATION_ACTIVATION_TOKEN: "fixture".repeat(4), CMS_PUBLICATION_FIREBASE_ACCOUNT: "fixture-account",
    CMS_PUBLICATION_MEDIA_MANAGER_CREDENTIAL: "fixture-key\nfixture-secret" };
  const failure = await runCmsPublicationCloud("--serve", environment).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(CloudPublicationStageError);
  expect(failure).toMatchObject({ stage: "storage-ready", failure: providerFailure });
  const line = describeCloudPublicationFailure(failure);
  expect(line).toBe("Cloud publication runtime stopped without a verified result (stage storage-ready, error Error, code ECONNRESET)\n");
  expect(line).not.toContain("fixture-private-detail");
  expect(boundary.storage.close).toHaveBeenCalled();
});

it("drops an unsafe error code from the log line", () => {
  const failure = new CloudPublicationStageError("runtime", Object.assign(new TypeError("x"), { code: "token abc/def" }));
  expect(describeCloudPublicationFailure(failure)).toBe(
    "Cloud publication runtime stopped without a verified result (stage runtime, error TypeError, code none)\n");
});

it.each(["--serve", "--preflight"])("refuses %s startup without a valid resource pin before becoming ready", async mode => {
  for (const tag of [undefined, "", "invalid-tag", "d".repeat(31), `${"d".repeat(32)}\n`]) {
    const starts = boundary.start.mock.calls.length;
    const ready = boundary.ready.mock.calls.length;
    const environment = { CLOUDFLARE_PUBLIC_WORKER_TAG: tag, CMS_PUBLICATION_FIREBASE_ACCOUNT: "fixture-account" };
    const failure = await runCmsPublicationCloud(mode, environment).catch(error => error);
    expect(failure).toMatchObject({ stage: "cloudflare-configuration" });
    expect(failure.message).toContain("CLOUDFLARE_PUBLIC_WORKER_TAG must be configured");
    expect(environment).not.toHaveProperty("CMS_PUBLICATION_FIREBASE_ACCOUNT");
    expect(boundary.start).toHaveBeenCalledTimes(starts);
    expect(boundary.ready).toHaveBeenCalledTimes(ready);
  }
});

it("validates an explicit pin during preflight without starting the runtime", async () => {
  const starts = boundary.start.mock.calls.length;
  const ready = boundary.ready.mock.calls.length;
  await runCmsPublicationCloud("--preflight", { CLOUDFLARE_PUBLIC_WORKER_TAG: "d".repeat(32) });
  expect(boundary.start).toHaveBeenCalledTimes(starts);
  expect(boundary.ready).toHaveBeenCalledTimes(ready);
});
