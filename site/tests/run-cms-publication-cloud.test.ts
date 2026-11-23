// @vitest-environment node
import { createRequire } from "node:module";
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
    initializeApp: vi.fn(), createStorage: vi.fn(),
  };
});
vi.mock("node:http", () => ({ createServer: vi.fn(() => ({
  once: vi.fn(), listen: vi.fn((_port, _host, ready) => ready()), close: vi.fn(done => done()),
})) }));
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
  initializeApp: (...args: unknown[]) => { boundary.initializeApp(...args); return boundary.app; }, cert: vi.fn(), getFirestore: () => boundary.firestore, deleteApp: boundary.deleteApp,
} }));
vi.mock("../scripts/cms-publication-cloud-storage", () => ({ createCmsPublicationCloudStorage: (...args: unknown[]) => {
  boundary.createStorage(...args); return boundary.storage;
} }));
vi.mock("../scripts/cms-publication-cloud-control", () => ({
  assertPublicationRuntimeIdentity: vi.fn(async () => {}), confirmPublicationRuntimeReady: boundary.ready,
}));
vi.mock("../scripts/no-build-cloud-runtime", () => ({ startNoBuildCloudRuntime: (...args: unknown[]) => {
  boundary.start(...args); return boundary.runtime;
} }));

import {
  CloudPublicationStageError, describeCloudPublicationFailure, runCmsPublicationCloud,
} from "../scripts/run-cms-publication-cloud";
import { parseCmsPublicationFirebaseServiceAccount, parseCmsPublicationPublicBuildEnvironment } from "../scripts/cms-publication-inputs";

it("starts the scoped runtime for the container command and closes its resources", async () => {
  const environment = { CMS_DEPLOYMENT_ENVIRONMENT: "production", CLOUDFLARE_PUBLIC_WORKER_TAG: "d".repeat(32), CMS_PUBLICATION_ACTIVATION_TOKEN: "fixture".repeat(4), CMS_PUBLICATION_FIREBASE_ACCOUNT: "fixture-account",
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
  expect(environment).toEqual({ CMS_DEPLOYMENT_ENVIRONMENT: "production", CLOUDFLARE_PUBLIC_WORKER_TAG: "d".repeat(32) });
});

it("scrubs and refuses inherited Media Manager credentials before startup", async () => {
  const environment = { MEDIA_MANAGER_API_KEY: "fixture-inherited", CMS_PUBLICATION_MEDIA_MANAGER_CREDENTIAL: "fixture-key\nfixture-secret" };
  await expect(runCmsPublicationCloud("--serve", environment)).rejects.toThrow("refuses inherited Media Manager credentials");
  expect(environment).toEqual({});
});

it("keeps the optional image-storage binding out of the public build environment", async () => {
  const environment = { CMS_DEPLOYMENT_ENVIRONMENT: "production", CLOUDFLARE_PUBLIC_WORKER_TAG: "d".repeat(32), CMS_PUBLICATION_ACTIVATION_TOKEN: "fixture".repeat(4), CMS_PUBLICATION_FIREBASE_ACCOUNT: "fixture-account",
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
  const environment = { CMS_DEPLOYMENT_ENVIRONMENT: "production", CLOUDFLARE_PUBLIC_WORKER_TAG: "d".repeat(32), CMS_PUBLICATION_ACTIVATION_TOKEN: "fixture".repeat(4), CMS_PUBLICATION_FIREBASE_ACCOUNT: "fixture-account",
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
  await runCmsPublicationCloud("--preflight", { CMS_DEPLOYMENT_ENVIRONMENT: "production", CLOUDFLARE_PUBLIC_WORKER_TAG: "d".repeat(32) });
  expect(boundary.start).toHaveBeenCalledTimes(starts);
  expect(boundary.ready).toHaveBeenCalledTimes(ready);
});

const serving = (deployment: string | undefined) => ({ CMS_DEPLOYMENT_ENVIRONMENT: deployment, CLOUDFLARE_PUBLIC_WORKER_TAG: "d".repeat(32),
  CMS_PUBLICATION_ACTIVATION_TOKEN: "fixture".repeat(4), CMS_PUBLICATION_FIREBASE_ACCOUNT: "fixture-account",
  CMS_PUBLICATION_MEDIA_MANAGER_CREDENTIAL: "fixture-key\nfixture-secret",
  ...(deployment === "development" ? { CMS_DEV_ACCESS_CLIENT_ID: "fixture-access-id", CMS_DEV_ACCESS_CLIENT_SECRET: "fixture-access-secret",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CMS_DEV_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) } : {}) });

it.each(["production", "development"])("selects one %s target for Firebase, storage and the runtime", async deployment => {
  const target = createRequire(import.meta.url)("../../functions/lib/publication-target.js").publicationTarget(deployment);
  await runCmsPublicationCloud("--serve", serving(deployment));
  expect(vi.mocked(parseCmsPublicationFirebaseServiceAccount).mock.calls.at(-1)).toEqual(["fixture-account", target.projectId]);
  expect(boundary.initializeApp.mock.calls.at(-1)?.[0]).toMatchObject({ projectId: target.projectId });
  expect(boundary.createStorage.mock.calls.at(-1)?.[0]).toMatchObject({ includeRenderer: true, target });
  expect(boundary.start.mock.calls.at(-1)?.[0].target).toBe(target);
  if (deployment === "development") {
    expect(JSON.stringify([boundary.initializeApp.mock.calls.at(-1), boundary.createStorage.mock.calls.at(-1)?.[0].target,
      boundary.start.mock.calls.at(-1)?.[0].target])).not.toMatch(/"njpbs-site"|njpbs-production|"njpbs-cms-|njpbs-public-artifacts|https:\/\/njpbs\.org/);
  }
});

it.each([undefined, "", "staging", "Production"])("refuses a missing or unknown deployment environment %j before Firebase", async deployment => {
  const starts = boundary.start.mock.calls.length;
  const initialized = boundary.initializeApp.mock.calls.length;
  const failure = await runCmsPublicationCloud("--serve", serving(deployment)).catch(error => error);
  expect(failure).toMatchObject({ stage: "target", message: "Invalid publication environment" });
  expect(boundary.initializeApp).toHaveBeenCalledTimes(initialized);
  expect(boundary.start).toHaveBeenCalledTimes(starts);
});

it.each([
  ["a missing account pin", { CMS_DEV_CLOUDFLARE_ACCOUNT_ID: undefined }],
  ["a different active account", { CLOUDFLARE_ACCOUNT_ID: "c".repeat(32) }],
])("refuses a development container with %s before Firebase", async (_label, change) => {
  const initialized = boundary.initializeApp.mock.calls.length;
  const starts = boundary.start.mock.calls.length;
  const failure = await runCmsPublicationCloud("--serve", { ...serving("development"), ...change }).catch(error => error);
  expect(failure).toMatchObject({ stage: "target", message: "Development Cloudflare account configuration is missing or differs" });
  expect(boundary.initializeApp).toHaveBeenCalledTimes(initialized);
  expect(boundary.start).toHaveBeenCalledTimes(starts);
});

it("refuses production Spotlight media storage in a development container", async () => {
  const initialized = boundary.initializeApp.mock.calls.length;
  const environment = { ...serving("development"), CMS_PUBLICATION_MEDIA_R2_CREDENTIAL: "fixture-media-binding",
    CMS_MEDIA_R2_ENDPOINT: "https://example.r2.cloudflarestorage.com", CMS_MEDIA_R2_BUCKET: "njpbs" };
  const failure = await runCmsPublicationCloud("--serve", environment).catch(error => error);
  expect(failure).toMatchObject({ stage: "target", message: "Development cloud publication refuses Spotlight media storage" });
  expect(environment).not.toHaveProperty("CMS_PUBLICATION_MEDIA_R2_CREDENTIAL");
  expect(boundary.initializeApp).toHaveBeenCalledTimes(initialized);
});

it.each(["production", "development"])("gives %s background builds its own deployment environment", async deployment => {
  vi.mocked(parseCmsPublicationPublicBuildEnvironment).mockReturnValueOnce({ PUBLIC_REPORT_ENDPOINT: "https://report.example.test" });
  const environment = serving(deployment);
  await runCmsPublicationCloud("--serve", environment);
  const input = boundary.start.mock.calls.at(-1)?.[0];
  expect(input.buildEnvironment).toEqual({ PUBLIC_REPORT_ENDPOINT: "https://report.example.test", CMS_DEPLOYMENT_ENVIRONMENT: deployment });
  expect(vi.mocked(parseCmsPublicationPublicBuildEnvironment).mock.calls.at(-1)?.[1]).toBe(deployment);
  expect(input.publicationAccess).toEqual(deployment === "development"
    ? { clientId: "fixture-access-id", clientSecret: "fixture-access-secret" } : undefined);
  expect(environment).not.toHaveProperty("CMS_DEV_ACCESS_CLIENT_ID");
  expect(environment).not.toHaveProperty("CMS_DEV_ACCESS_CLIENT_SECRET");
});

it.each([
  ["development without Access credentials", { ...serving("development"), CMS_DEV_ACCESS_CLIENT_SECRET: undefined }],
  ["development with a blank Access identifier", { ...serving("development"), CMS_DEV_ACCESS_CLIENT_ID: " " }],
  ["production with Access credentials", { ...serving("production"), CMS_DEV_ACCESS_CLIENT_ID: "fixture-access-id" }],
])("refuses %s before Firebase", async (_label, environment) => {
  const initialized = boundary.initializeApp.mock.calls.length;
  const failure = await runCmsPublicationCloud("--serve", environment).catch(error => error);
  expect(failure).toMatchObject({ stage: "target", message: "Cloud publication Access credentials do not match its target" });
  expect(environment).not.toHaveProperty("CMS_DEV_ACCESS_CLIENT_ID");
  expect(boundary.initializeApp).toHaveBeenCalledTimes(initialized);
});
